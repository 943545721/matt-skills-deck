import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SyncLabel } from "../../shared/labels.ts";
import { classifyGhError, type GhFailureReason } from "./gh-error.ts";
import { classifyGlabError, listGitLabLabels } from "./gitlab.ts";

const execFileAsync = promisify(execFile);

export interface LabelInfo {
  name: string;
  /** 6 位小写十六进制、不带井号；空串表示这个标签还没有颜色。 */
  color: string;
  description: string;
}

export interface LabelColorChange {
  name: string;
  color: string;
}

type LabelFailure = { ok: false; reason: GhFailureReason | "invalid"; detail: string };

async function runGh(args: string[], timeoutMs = 20_000): Promise<{ ok: true; stdout: string } | LabelFailure> {
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: timeoutMs, maxBuffer: 16 << 20 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, ...classifyGhError(error, "试") };
  }
}

export const normalizeColor = (value: string): string => {
  const raw = value.trim().replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{6}$/.test(raw) ? raw : "";
};

/** 仓库标签清单。读不全时也把读到的交出去，另一个标签名的错不该让整页空白。 */
export async function listLabels(owner: string, repo: string): Promise<{ ok: true; labels: LabelInfo[] } | LabelFailure> {
  const result = await runGh(["api", `repos/${owner}/${repo}/labels?per_page=100`, "--paginate", "--jq", "."]);
  if (!result.ok) return result;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const list = Array.isArray(parsed) ? parsed : [];
    return {
      ok: true,
      labels: list.flatMap((item) => {
        const record = item as { name?: unknown; color?: unknown; description?: unknown } | null;
        const name = typeof record?.name === "string" ? record.name : "";
        if (!name) return [];
        return [
          {
            name,
            color: normalizeColor(typeof record?.color === "string" ? record.color : ""),
            description: typeof record?.description === "string" ? record.description : "",
          },
        ];
      }),
    };
  } catch {
    return { ok: false, reason: "gh-failed", detail: "标签列表回包不是合法 JSON" };
  }
}

/**
 * 批量改标签颜色。
 *
 * 逐条 PATCH 且不并发：一个仓库的标签最多几十个，串行慢不了多少，
 * 而并发遇到限流时会把「哪几条没改成」搅成一团。失败逐条记账，成功的照常落地。
 */
export async function setLabelColors(
  owner: string,
  repo: string,
  changes: readonly LabelColorChange[],
): Promise<
  | {
      ok: true;
      applied: LabelColorChange[];
      failed: { name: string; detail: string }[];
      /** 写后读回核对一致的标签。 */
      verified: LabelColorChange[];
      /** PATCH 回了成功、但读回的颜色不是期望值。 */
      mismatched: { name: string; expected: string; actual: string }[];
      /** 读回失败：此时 applied 只是「请求成功」，不能当成已确认。 */
      readbackFailed: boolean;
    }
  | LabelFailure
> {
  if (!changes.length) {
    return { ok: true, applied: [], failed: [], verified: [], mismatched: [], readbackFailed: false };
  }

  const applied: LabelColorChange[] = [];
  const failed: { name: string; detail: string }[] = [];

  for (const change of changes) {
    const name = change.name.trim();
    const color = normalizeColor(change.color);
    if (!name) {
      failed.push({ name: change.name, detail: "标签名为空" });
      continue;
    }
    if (!color) {
      failed.push({ name, detail: `颜色必须是 6 位十六进制：${change.color}` });
      continue;
    }
    const result = await runGh([
      "api",
      `repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
      "--method",
      "PATCH",
      "-f",
      `color=${color}`,
    ]);
    if (!result.ok) {
      // 没装 / 没登录是整条链路的问题，不必逐个标签重试。
      if (result.reason === "gh-missing" || result.reason === "gh-unauth") return result;
      failed.push({ name, detail: result.detail });
      continue;
    }
    applied.push({ name, color });
  }

  // 写后读回：GitHub 的 PATCH 回 200 不等于颜色真的改了（企业代理、缓存层都可能吞掉）。
  // 读不回来就如实标 readbackFailed，不把「请求发成功了」说成「已经改好了」。
  if (!applied.length) return { ok: true, applied, failed, verified: [], mismatched: [], readbackFailed: false };
  const reread = await listLabels(owner, repo);
  if (!reread.ok) {
    return { ok: true, applied, failed, verified: [], mismatched: [], readbackFailed: true };
  }
  const actual = new Map(reread.labels.map((label) => [label.name, label.color]));
  const verified: LabelColorChange[] = [];
  const mismatched: { name: string; expected: string; actual: string }[] = [];
  for (const change of applied) {
    const seen = actual.get(change.name) ?? "";
    if (seen === change.color) verified.push(change);
    else mismatched.push({ name: change.name, expected: change.color, actual: seen });
  }
  return { ok: true, applied, failed, verified, mismatched, readbackFailed: false };
}

// ---------------------------------------------------------------------------
// 同步标签：缺的建、已有的跳过
// ---------------------------------------------------------------------------

/**
 * 同步一个仓库时需要的两个动作。注入是为了让幂等与部分失败能离线测。
 *
 * 失败只保留 `reason`（用于判断「是不是整条链路不可用」）与 `detail`（原样给人看），
 * 不跟某个后端的错误码表绑定：GitHub 与 GitLab 的码不一样，而这张表只在上层做展示。
 */
export interface SyncFailure {
  ok: false;
  reason: string;
  detail: string;
}

export interface SyncLabelDeps {
  list(owner: string, name: string): Promise<{ ok: true; labels: readonly { name: string }[] } | SyncFailure>;
  create(owner: string, name: string, label: SyncLabel): Promise<{ ok: true } | SyncFailure>;
}

export interface SyncLabelOutcome {
  ok: true;
  created: string[];
  existing: string[];
  failed: { name: string; detail: string }[];
}

/** 整条链路不可用（没装 / 没登录）：继续建下去只会把同一条错误抄上几十遍。 */
const FATAL_SYNC_REASONS = new Set(["gh-missing", "gh-unauth", "glab-missing", "glab-unauth"]);

/** GitHub：`gh api` 建标签。走 api 而不是 `gh label create`，是为了能和读列表共用同一套错误分类。 */
async function createGitHubLabel(owner: string, name: string, label: SyncLabel): Promise<{ ok: true } | SyncFailure> {
  const result = await runGh([
    "api",
    `repos/${owner}/${name}/labels`,
    "--method",
    "POST",
    "-f",
    `name=${label.name}`,
    "-f",
    `color=${label.color}`,
    "-f",
    `description=${label.description}`,
  ]);
  return result.ok ? { ok: true } : result;
}

/** GitLab：`glab api` 建标签。颜色要带井号，与 PUT 改色的口径一致。 */
async function createGitLabLabel(owner: string, name: string, label: SyncLabel): Promise<{ ok: true } | SyncFailure> {
  try {
    await execFileAsync(
      "glab",
      [
        "api",
        `projects/${encodeURIComponent(`${owner}/${name}`)}/labels`,
        "--method",
        "POST",
        "-f",
        `name=${label.name}`,
        "-f",
        `color=#${label.color}`,
        "-f",
        `description=${label.description}`,
      ],
      { timeout: 20_000, maxBuffer: 4 << 20 },
    );
    return { ok: true };
  } catch (error) {
    const classified = classifyGlabError(error);
    return { ok: false, reason: classified.reason, detail: classified.detail };
  }
}

export const githubSyncDeps: SyncLabelDeps = {
  async list(owner, name) {
    const result = await listLabels(owner, name);
    return result.ok ? { ok: true, labels: result.labels } : result;
  },
  create: createGitHubLabel,
};

export const gitlabSyncDeps: SyncLabelDeps = {
  async list(owner, name) {
    const result = await listGitLabLabels(owner, name);
    return result.ok ? { ok: true, labels: result.labels } : result;
  },
  create: createGitLabLabel,
};

/**
 * 把一个仓库的标签清单补齐。
 *
 * 先读一遍现有标签，只对它没有的名字发创建请求：重复执行是安全的，已有标签的颜色一个字都不动
 * （改色是另一条路径，有它的读回核对）。单个标签失败只记一条，继续建后面的——
 * 因为一次同步里最可能失败的恰恰是别人手工建过、名字拼写不同的那一个。
 */
export async function syncLabels(
  owner: string,
  name: string,
  labels: readonly SyncLabel[],
  deps: SyncLabelDeps = githubSyncDeps,
): Promise<SyncLabelOutcome | SyncFailure> {
  const listed = await deps.list(owner, name);
  if (!listed.ok) return listed;

  const have = new Set(listed.labels.map((label) => label.name));
  const created: string[] = [];
  const existing: string[] = [];
  const failed: { name: string; detail: string }[] = [];

  for (const label of labels) {
    if (have.has(label.name)) {
      existing.push(label.name);
      continue;
    }
    const result = await deps.create(owner, name, label);
    if (!result.ok) {
      if (FATAL_SYNC_REASONS.has(result.reason)) return result;
      failed.push({ name: label.name, detail: result.detail });
      continue;
    }
    created.push(label.name);
  }

  return { ok: true, created, existing, failed };
}


