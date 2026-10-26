import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

type LabelFailure = { ok: false; reason: "gh-missing" | "gh-failed" | "invalid"; detail: string };

async function runGh(args: string[], timeoutMs = 20_000): Promise<{ ok: true; stdout: string } | LabelFailure> {
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: timeoutMs, maxBuffer: 16 << 20 });
    return { ok: true, stdout };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "gh-missing", detail: "没有找到 gh 命令：装好后执行 gh auth login 再试" };
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    return {
      ok: false,
      reason: "gh-failed",
      detail: typeof stderr === "string" && stderr.trim()
        ? stderr.trim().slice(0, 800)
        : error instanceof Error
          ? error.message
          : String(error),
    };
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
): Promise<{ ok: true; applied: LabelColorChange[]; failed: { name: string; detail: string }[] } | LabelFailure> {
  if (!changes.length) return { ok: true, applied: [], failed: [] };

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
      if (result.reason === "gh-missing") return result;
      failed.push({ name, detail: result.detail });
      continue;
    }
    applied.push({ name, color });
  }

  return { ok: true, applied, failed };
}
