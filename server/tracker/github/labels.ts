import type { GhClient } from "./client.ts";
import type { GhErrorKind } from "./errors.ts";
import type { ReadResult, RepoRef } from "./reads.ts";
import { repoSlug, validateRepoRef } from "./reads.ts";
import { LABEL_LIST_LIMIT } from "./queries.ts";
import { readRepoPermissions, readonlyMessage, type PermissionCache } from "./permissions.ts";

/**
 * 标签色（DSH label-colors-ops.ts）。
 *
 * 两个约束来自真实事故：
 * 1. `gh label list` 最多 1000 条；结果条数正好等于上限时**不能当成完整清单**——
 *    接下来如果按「这份清单」去批量改色，会漏掉第 1001 个之后的标签。宁可报「可能没拿全」。
 * 2. 改色前先在本地校验全部颜色；有一个非法就一条命令都不发，避免「改了一半」。
 */
export interface LabelInfo {
  name: string;
  color: string;
  description: string;
}

export interface LabelListData {
  labels: LabelInfo[];
  /** 条数触到上限：清单可能不全。 */
  possiblyTruncated: boolean;
}

const HEX = /^[0-9a-f]{3}([0-9a-f]{3})?$/i;

/** 颜色归一：接受带不带 `#` 的 3/6 位十六进制；3 位展开成 6 位；其它返回 null。 */
export function normalizeColor(value: string): string | null {
  const raw = value.trim().replace(/^#/, "");
  if (!HEX.test(raw)) return null;
  if (raw.length === 3) return raw.split("").map((char) => char + char).join("").toLowerCase();
  return raw.toLowerCase();
}

function labelOf(raw: unknown): LabelInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const node = raw as { name?: unknown; color?: unknown; description?: unknown };
  const name = typeof node.name === "string" ? node.name.trim() : "";
  if (!name) return null;
  const color = typeof node.color === "string" ? node.color.trim() : "";
  return {
    name,
    color: color ? normalizeColor(color) ?? color.toLowerCase() : "",
    description: typeof node.description === "string" ? node.description : "",
  };
}

function parseLabelArray(stdout: string): LabelInfo[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((item) => {
      const label = labelOf(item);
      return label ? [label] : [];
    });
  } catch {
    return null;
  }
}

/** 列标签：形状错误按 env 报（这不是 GitHub 拒绝，而是我们看不懂输出）。 */
export async function listLabels(client: GhClient, repo: RepoRef): Promise<ReadResult<LabelListData>> {
  const bad = validateRepoRef(repo);
  if (bad) return bad;
  const result = await client.exec(
    ["label", "list", "--repo", repoSlug(repo), "--json", "name,color,description", "--limit", String(LABEL_LIST_LIMIT)],
    { cwd: repo.cwd },
  );
  if (!result.ok) {
    if (result.error.kind === "auth") {
      const permissions = await readRepoPermissions(client, repoSlug(repo));
      if (permissions && !permissions.push && !permissions.triage) {
        return { ok: false, kind: "auth", message: readonlyMessage(repoSlug(repo), ["标签"]), raw: result.error.raw };
      }
    }
    return { ok: false, kind: result.error.kind, message: result.error.message, raw: result.error.raw };
  }
  const labels = parseLabelArray(result.stdout);
  if (!labels) return { ok: false, kind: "env", message: "gh label list 的回包不是合法 JSON 数组", raw: result.stdout.slice(0, 800) };
  if (labels.length >= LABEL_LIST_LIMIT) {
    return {
      ok: false,
      kind: "env",
      message: `标签清单触到 ${LABEL_LIST_LIMIT} 条上限，可能没拿全；为避免漏改，本次不继续。`,
      raw: "",
    };
  }
  return { ok: true, data: { labels, possiblyTruncated: false } };
}

export interface LabelColorChange {
  name: string;
  color: string;
}

export interface LabelColorFailure {
  name: string;
  kind: GhErrorKind | "invalid";
  message: string;
}

export interface LabelColorData {
  applied: LabelColorChange[];
  failed: LabelColorFailure[];
}

export const LABEL_WRITE_CONCURRENCY = 4;

interface ValidChange {
  name: string;
  color: string;
}

/** 全部变更先本地校验：数组/对象两种入参、名字去重（不区分大小写）、颜色合法。 */
export function validateChanges(input: unknown): { ok: true; changes: ValidChange[] } | { ok: false; message: string } {
  let entries: Array<{ name: unknown; color: unknown }> = [];
  if (Array.isArray(input)) {
    entries = input.map((item) => {
      const record = (item && typeof item === "object" ? item : {}) as { name?: unknown; color?: unknown };
      return { name: record.name, color: record.color };
    });
  } else if (input && typeof input === "object") {
    entries = Object.entries(input).map(([name, color]) => ({ name, color }));
  } else {
    return { ok: false, message: "changes 必须是数组或 {标签名: 颜色} 对象" };
  }
  const seen = new Set<string>();
  const changes: ValidChange[] = [];
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) return { ok: false, message: "变更里有空的标签名" };
    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, message: `变更里有重复标签名：${name}` };
    if (typeof entry.color !== "string") return { ok: false, message: `标签 ${name} 的颜色缺失` };
    const color = normalizeColor(entry.color);
    if (!color) return { ok: false, message: `标签 ${name} 的颜色不合法：${entry.color}` };
    seen.add(key);
    changes.push({ name, color });
  }
  return { ok: true, changes };
}

async function applyOne(client: GhClient, repo: RepoRef, change: ValidChange, cache?: PermissionCache): Promise<LabelColorFailure | null> {
  const result = await client.exec(["label", "edit", change.name, "--repo", repoSlug(repo), "--color", change.color], { cwd: repo.cwd });
  if (result.ok) return null;
  if (result.error.exitCode === 4) return { name: change.name, kind: "auth", message: result.error.message };
  if (result.error.kind === "notfound") {
    const permissions = await readRepoPermissions(client, repoSlug(repo), cache);
    if (permissions && !permissions.push) {
      return { name: change.name, kind: "auth", message: readonlyMessage(repoSlug(repo), [`标签 ${change.name}`]) };
    }
    return { name: change.name, kind: "notfound", message: `标签 ${change.name} 不存在，或当前账号看不到它。` };
  }
  return { name: change.name, kind: result.error.kind, message: result.error.message };
}

/** 批量改色：4 路并发；每条独立成败，任何一条失败不拖垮其余。 */
export async function setLabelColors(
  client: GhClient,
  repo: RepoRef,
  input: unknown,
  cache?: PermissionCache,
): Promise<ReadResult<LabelColorData>> {
  const bad = validateRepoRef(repo);
  if (bad) return bad;
  const validated = validateChanges(input);
  if (!validated.ok) return { ok: false, kind: "invalid", message: validated.message, raw: "" };
  if (validated.changes.length === 0) return { ok: true, data: { applied: [], failed: [] } };
  // 收窄后的数组先取出来：worker 是独立函数，在它里面再读 `validated.changes` 会丢掉上面的 ok 收窄。
  const changes = validated.changes;

  const applied: LabelColorChange[] = [];
  const failed: LabelColorFailure[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < changes.length) {
      const change = changes[index];
      index += 1;
      if (!change) continue;
      const failure = await applyOne(client, repo, change, cache);
      if (failure) failed.push(failure);
      else applied.push(change);
    }
  }
  const workers = Math.min(LABEL_WRITE_CONCURRENCY, changes.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { ok: true, data: { applied, failed } };
}

/** 单条失败的固定说明；与 permission 模块的只读话术分开，因为这里不是权限问题的概率更高。 */
export function describeLabelFailure(failure: LabelColorFailure): string {
  return failure.kind === "auth" ? failure.message : `标签 ${failure.name} 改色失败：${failure.message}`;
}
