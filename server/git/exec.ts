import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitFailure = { ok: false; reason: "no-workspace" | "git-missing" | "git-failed" | "invalid"; detail: string };

export interface GitOutput {
  stdout: string;
  truncated: boolean;
  exitCode: number;
}

/**
 * 所有 git 调用的唯一出口。
 *
 * 三条固定约束：
 * 1. `-C <workspaceDir>` 指死工作区，不接受相对/不存在目录；
 * 2. `GIT_TERMINAL_PROMPT=0`：没有凭据时立刻失败，而不是在后台等一个永远等不到的输入；
 * 3. 输出按上限截断并标记 truncated，避免一个巨型 diff 把面板拖死。
 */
export async function runGit(
  workspaceDir: string,
  args: readonly string[],
  options: { timeoutMs?: number; limit?: number } = {},
): Promise<{ ok: true; data: GitOutput } | GitFailure> {
  const dirProblem = workspaceProblem(workspaceDir);
  if (dirProblem) return dirProblem;

  const limit = options.limit ?? 1 << 20;
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspaceDir, "--no-optional-locks", ...args], {
      timeout: options.timeoutMs ?? 20_000,
      maxBuffer: Math.max(limit * 4, 1 << 20),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    });
    const truncated = stdout.length > limit;
    return { ok: true, data: { stdout: truncated ? stdout.slice(0, limit) : stdout, truncated, exitCode: 0 } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "git-missing", detail: "没有找到 git 命令" };
    }
    const stdout = (error as { stdout?: unknown }).stdout;
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = [
      typeof stderr === "string" ? stderr.trim() : "",
      typeof stdout === "string" ? stdout.trim() : "",
    ].filter(Boolean).join("\n");
    const exitCode = (error as { code?: unknown }).code;
    // 非零退出不等于「没跑起来」：status/diff 在有些场景下会带着结果退出。
    if (typeof exitCode === "number" && text) {
      return { ok: true, data: { stdout: text.slice(0, limit), truncated: text.length > limit, exitCode } };
    }
    return {
      ok: false,
      reason: "git-failed",
      detail: text.slice(0, 800) || (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** 工作区路径必须存在且是目录；不存在时不要假装跑了 git。 */
export function workspaceProblem(workspaceDir: string): { ok: false; reason: "no-workspace"; detail: string } | null {
  if (!workspaceDir || !workspaceDir.startsWith("/")) {
    return { ok: false, reason: "no-workspace", detail: `工作区目录不是绝对路径：${workspaceDir || "（空）"}` };
  }
  try {
    if (!statSync(workspaceDir).isDirectory()) {
      return { ok: false, reason: "no-workspace", detail: `工作区不是目录：${workspaceDir}` };
    }
    return null;
  } catch {
    return { ok: false, reason: "no-workspace", detail: `工作区目录不存在：${workspaceDir}` };
  }
}

/**
 * 路径校验：只放相对路径，且不许以 `-` 开头。
 *
 * 为什么这么严：这些字符串会直接出现在 `git add --` 之后，以 `-` 开头的值会被 git 当成选项。
 * `--` 已经挡住大部分情况，但没必要让一个叫 `--force` 的文件名走进来试运气。
 */
export function pathsProblem(paths: readonly string[]): { ok: false; reason: "invalid"; detail: string } | null {
  if (!paths.length) return { ok: false, reason: "invalid", detail: "没有选中任何文件" };
  for (const path of paths) {
    if (!path.trim()) return { ok: false, reason: "invalid", detail: "文件路径为空" };
    if (path.startsWith("-")) return { ok: false, reason: "invalid", detail: `文件路径不能用选项形式：${path}` };
    if (path.startsWith("/")) return { ok: false, reason: "invalid", detail: `文件路径要用工作区内的相对路径：${path}` };
    if (path.includes("\0")) return { ok: false, reason: "invalid", detail: "文件路径里有非法字符" };
  }
  return null;
}
