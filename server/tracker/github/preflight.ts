import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GhClient } from "./client.ts";
import type { GhErrorKind } from "./errors.ts";
import type { RepoRef } from "./reads.ts";

const execFileAsync = promisify(execFile);

export interface PreflightFailure {
  ok: false;
  kind: GhErrorKind | "invalid";
  message: string;
  raw: string;
}

export type PreflightResult =
  | { ok: true; data: { repo: string; account: string; crosschecked: boolean } }
  | PreflightFailure;

export interface PreflightOptions {
  cwd?: string;
  /** 已知仓库坐标时直接校验；省略时用 `gh repo view` 解析当前工作区。 */
  repo?: RepoRef | string;
}

function specOf(repo: RepoRef | string): string {
  return typeof repo === "string" ? repo : `${repo.owner}/${repo.name}`;
}

const SPEC = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * 三关 preflight：本机有 gh → 有登录态 → 当前目录能解析到仓库且账号能读。
 *
 * `gh auth status` 失败时用 `gh api user` 复核一次：有些 gh 版本在 token 属于
 * GHES/GH_HOST 时会把状态写成「未登录」，但 API 实际可用。复核成功就放行，
 * 不让用户被一句误报挡在门外；复核失败则如实按原档返回。
 */
export async function ghPreflight(client: GhClient, options: PreflightOptions = {}): Promise<PreflightResult> {
  const version = await client.exec(["--version"], { cwd: options.cwd, timeoutMs: 15_000 });
  if (!version.ok) {
    return { ok: false, kind: version.error.kind === "auth" ? "auth" : "env", message: "没有找到可用的 gh 命令：装好后执行 gh auth login。", raw: version.error.raw };
  }

  let account = "";
  let crosschecked = false;
  const auth = await client.exec(["auth", "status"], { cwd: options.cwd });
  if (!auth.ok) {
    if (auth.error.kind === "auth") {
      const user = await client.rest("user", { jq: ".login" });
      if (user.ok) {
        account = user.stdout.trim();
        crosschecked = true;
      } else {
        return { ok: false, kind: "auth", message: auth.error.message, raw: auth.error.raw };
      }
    } else {
      return { ok: false, kind: auth.error.kind, message: auth.error.message, raw: auth.error.raw };
    }
  } else if (!account) {
    const user = await client.rest("user", { jq: ".login" });
    if (user.ok) account = user.stdout.trim();
  }

  let spec = "";
  if (options.repo) {
    spec = specOf(options.repo);
  } else {
    const view = await client.exec(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: options.cwd });
    if (!view.ok) {
      return { ok: false, kind: view.error.kind, message: `当前目录没有解析到 GitHub 仓库：${view.error.message}`, raw: view.error.raw };
    }
    spec = view.stdout.trim();
  }
  if (!SPEC.test(spec)) {
    return { ok: false, kind: "invalid", message: `仓库坐标不合法：${spec || "(空)"}`, raw: "" };
  }

  const access = await client.rest(`repos/${spec}`);
  if (!access.ok) {
    if (access.error.kind === "notfound") {
      return { ok: false, kind: "notfound", message: `找不到仓库 ${spec}，或当前账号没有访问权限。`, raw: access.error.raw };
    }
    return { ok: false, kind: access.error.kind, message: access.error.message, raw: access.error.raw };
  }
  return { ok: true, data: { repo: spec, account, crosschecked } };
}

export interface RepoIdentity {
  owner: string;
  name: string;
  /** 解析来源：remote（git 远端）/ config（.git/config）/ gh（gh repo view）。 */
  source: "remote" | "config" | "gh";
}

/** 从 GitHub URL 里取 owner/name；不是 GitHub 远端就返回 null。 */
export function parseGithubRepo(url: string): { owner: string; name: string } | null {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(url.trim());
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], name: match[2].replace(/\.git$/, "") };
}

export type GitExec = (args: readonly string[], cwd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export const defaultGitExec: GitExec = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], { cwd, timeout: 10_000, maxBuffer: 1 << 20 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string" ? record.stderr : typeof record.message === "string" ? record.message : "",
    };
  }
};

function originFromConfig(cwd: string): string | null {
  const file = path.join(cwd, ".git", "config");
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, "utf8");
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text);
    if (!section) return null;
    const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1] ?? "");
    return url?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 解析工作区对应的 GitHub 仓库（DSH repo.ts getRepoKey 三层）：
 * 先问 git 远端，再读 `.git/config`（git 命令不可用时仍能解析），最后问 `gh repo view`。
 * 三层都失败返回 null，不猜仓库名。
 */
export async function resolveRepoKey(
  client: GhClient,
  cwd: string,
  execGit: GitExec = defaultGitExec,
): Promise<RepoIdentity | null> {
  const remote = await execGit(["remote", "get-url", "origin"], cwd);
  if (remote.ok) {
    const parsed = parseGithubRepo(remote.stdout);
    if (parsed) return { ...parsed, source: "remote" };
  }
  const configured = originFromConfig(cwd);
  if (configured) {
    const parsed = parseGithubRepo(configured);
    if (parsed) return { ...parsed, source: "config" };
  }
  const view = await client.exec(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd });
  if (view.ok) {
    const parsed = parseGithubRepo(view.stdout.trim());
    if (parsed) return { ...parsed, source: "gh" };
  }
  return null;
}
