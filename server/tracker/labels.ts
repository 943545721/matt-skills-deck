import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyGhError, type GhFailureReason } from "./gh-error.ts";

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
