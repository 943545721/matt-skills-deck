import type { GhClient } from "./client.ts";
import type { GitExec } from "./preflight.ts";
import { defaultGitExec } from "./preflight.ts";

/**
 * 开仓发布（DSH init-project.ts）。
 *
 * 顺序：git 可用性 → gh 可用性 → 登录态 → git init（已是仓库则跳过）→ add →
 * commit（identity 缺失时补本地 user.*）→ `gh repo create` → push。
 *
 * 每一步失败都带自己的档位与原文；已经开始改动工作区之后的失败，绝不退回「什么都没发生」。
 */
export interface InitProjectInput {
  cwd: string;
  name: string;
  visibility?: "private" | "public";
}

export interface InitProjectData {
  owner: string;
  name: string;
  url: string;
  /** 这一趟走了哪条路：新建远端（created）还是推到已有 origin（existing）。 */
  route: "created" | "existing";
  healedOwnership: boolean;
}

export interface InitProjectError {
  kind: "bad-name" | "no-git" | "no-gh" | "not-logged-in" | "already-exists" | "network" | "permission" | "git-ownership" | "unknown";
  message: string;
  raw: string;
  repoUrl?: string;
}

export type InitProjectResult = { ok: true; data: InitProjectData } | { ok: false; error: InitProjectError };

interface ProcResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const NAME = /^[A-Za-z0-9._-]+$/;
const OWNERSHIP_PATH = /detected dubious ownership in repository at '([^']+)'/i;
const NOT_A_REPO = /not a git repository/i;

function gitFailure(kind: string, text: string, cwd: string): InitProjectError {
  if (kind === "git-ownership" || OWNERSHIP_PATH.test(text)) {
    const dir = OWNERSHIP_PATH.exec(text)?.[1] ?? cwd;
    return {
      kind: "git-ownership",
      message: `这个工作区的属主不是当前运行用户，git 拒绝操作。修法：git config --global --add safe.directory ${dir}`,
      raw: text,
    };
  }
  return { kind: "unknown", message: `创建失败，未识别的原因。git 原话：${text.slice(0, 160)}`, raw: text };
}

function classifyCreateError(text: string): InitProjectError["kind"] {
  const lower = text.toLowerCase();
  if (/already exists|already been taken|name already exists/i.test(lower)) return "already-exists";
  if (/permission|forbidden|403|not authorized/i.test(lower)) return "permission";
  if (/network|timeout|timed out|econn|enotfound|getaddrinfo/i.test(lower)) return "network";
  if (/auth|login|401/i.test(lower)) return "not-logged-in";
  return "unknown";
}

async function ghStep(client: GhClient, args: readonly string[], cwd: string): Promise<ProcResult> {
  const result = await client.exec(args, { cwd });
  return result.ok
    ? { ok: true, stdout: result.stdout, stderr: result.stderr }
    : { ok: false, stdout: result.stdout, stderr: result.error.raw };
}

async function gitStep(execGit: GitExec, args: readonly string[], cwd: string): Promise<ProcResult> {
  return execGit(args, cwd);
}

async function probeUsable(execGit: GitExec, cwd: string): Promise<{ ok: true; notRepoYet: boolean; healed: boolean } | { ok: false; text: string; kind: string }> {
  const first = await gitStep(execGit, ["-C", cwd, "rev-parse", "--is-inside-work-tree"], cwd);
  if (first.ok) return { ok: true, notRepoYet: false, healed: false };
  if (NOT_A_REPO.test(first.stderr)) return { ok: true, notRepoYet: true, healed: false };
  if (!OWNERSHIP_PATH.test(first.stderr)) return { ok: false, text: first.stderr, kind: "unknown" };
  const dir = OWNERSHIP_PATH.exec(first.stderr)?.[1] ?? cwd;
  await gitStep(execGit, ["config", "--global", "--add", "safe.directory", dir], cwd);
  const second = await gitStep(execGit, ["-C", cwd, "rev-parse", "--is-inside-work-tree"], cwd);
  if (second.ok) return { ok: true, notRepoYet: false, healed: true };
  return { ok: false, text: second.stderr, kind: "git-ownership" };
}

async function currentLogin(client: GhClient, cwd: string): Promise<string> {
  const result = await ghStep(client, ["api", "user", "-q", ".login"], cwd);
  return result.ok ? result.stdout.trim() : "";
}

async function ownerFromRepo(client: GhClient, cwd: string, fallback: string): Promise<string> {
  const view = await ghStep(client, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd);
  if (view.ok) {
    const [owner] = view.stdout.trim().split("/");
    if (owner) return owner;
  }
  return fallback;
}

/** 开仓发布。`execGit` 可注入（测试不跑真实 git）；默认 execFile("git", args)。 */
export async function initProject(
  client: GhClient,
  input: InitProjectInput,
  execGit: GitExec = defaultGitExec,
): Promise<InitProjectResult> {
  const cwd = input.cwd;
  const name = input.name.trim();
  const visibility = input.visibility === "public" ? "public" : "private";
  if (!name) return { ok: false, error: { kind: "bad-name", message: "仓库名为空", raw: "" } };
  if (!NAME.test(name) || name.length > 100) {
    return { ok: false, error: { kind: "bad-name", message: `仓库名仅支持字母/数字/._- 且 ≤100：${name}`, raw: name } };
  }

  const gitVersion = await gitStep(execGit, ["--version"], cwd);
  if (!gitVersion.ok) return { ok: false, error: { kind: "no-git", message: "未找到 git（请安装 https://git-scm.com/）", raw: "" } };
  const ghVersion = await ghStep(client, ["--version"], cwd);
  if (!ghVersion.ok) return { ok: false, error: { kind: "no-gh", message: "未找到 gh（请安装 https://cli.github.com/）", raw: "" } };

  const auth = await ghStep(client, ["auth", "status"], cwd);
  if (!auth.ok) {
    const text = auth.stderr.toLowerCase();
    if (/network|timeout|econn|enotfound|getaddrinfo|connect/.test(text)) {
      return { ok: false, error: { kind: "network", message: auth.stderr.slice(0, 400), raw: auth.stderr } };
    }
    return { ok: false, error: { kind: "not-logged-in", message: auth.stderr.slice(0, 400), raw: auth.stderr } };
  }

  const usable = await probeUsable(execGit, cwd);
  if (!usable.ok) {
    const error = gitFailure(usable.kind, usable.text, cwd);
    return { ok: false, error };
  }

  if (usable.notRepoYet) {
    const init = await gitStep(execGit, ["init"], cwd);
    if (!init.ok) return { ok: false, error: gitFailure("unknown", init.stderr, cwd) };
  }

  const add = await gitStep(execGit, ["add", "."], cwd);
  if (!add.ok) return { ok: false, error: gitFailure("unknown", add.stderr, cwd) };

  let commit = await gitStep(execGit, ["commit", "-m", "initial commit", "--allow-empty"], cwd);
  if (!commit.ok && /please tell me who you are|user\.name|user\.email|author identity unknown|unable to auto-detect email/i.test(commit.stderr.toLowerCase())) {
    await gitStep(execGit, ["config", "user.email", "deck@local"], cwd);
    await gitStep(execGit, ["config", "user.name", "Deck User"], cwd);
    commit = await gitStep(execGit, ["commit", "-m", "initial commit", "--allow-empty"], cwd);
  }
  if (!commit.ok) return { ok: false, error: gitFailure("unknown", commit.stderr, cwd) };

  const login = await currentLogin(client, cwd);
  const hasOrigin = (await gitStep(execGit, ["remote", "get-url", "origin"], cwd)).ok;
  const visFlag = visibility === "public" ? "--public" : "--private";

  if (!hasOrigin) {
    const created = await ghStep(client, ["repo", "create", name, visFlag, "--source=.", "--push"], cwd);
    if (!created.ok) {
      const kind = classifyCreateError(created.stderr);
      const error: InitProjectError = { kind, message: created.stderr.slice(0, 400), raw: created.stderr };
      if (kind === "already-exists" && login) error.repoUrl = `https://github.com/${login}/${name}`;
      return { ok: false, error };
    }
    const owner = await ownerFromRepo(client, cwd, login);
    return { ok: true, data: { owner, name, url: `https://github.com/${owner}/${name}`, route: "created", healedOwnership: usable.healed } };
  }

  const created = await ghStep(client, ["repo", "create", name, visFlag], cwd);
  if (!created.ok) {
    const kind = classifyCreateError(created.stderr);
    const error: InitProjectError = { kind, message: created.stderr.slice(0, 400), raw: created.stderr };
    if (kind === "already-exists" && login) error.repoUrl = `https://github.com/${login}/${name}`;
    return { ok: false, error };
  }
  const remoteUrl = login ? `https://github.com/${login}/${name}.git` : parseCreatedUrl(created.stdout);
  if (remoteUrl) await gitStep(execGit, ["remote", "set-url", "origin", remoteUrl], cwd);
  const push = await gitStep(execGit, ["push", "-u", "origin", "HEAD"], cwd);
  if (!push.ok) return { ok: false, error: gitFailure("unknown", push.stderr, cwd) };
  const owner = await ownerFromRepo(client, cwd, login);
  return { ok: true, data: { owner, name, url: `https://github.com/${owner}/${name}`, route: "existing", healedOwnership: usable.healed } };
}

function parseCreatedUrl(stdout: string): string {
  const match = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+/.exec(stdout);
  return match ? `${match[0]}.git` : "";
}
