import { readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RepoCandidate } from "../../shared/repo.ts";
import type { ConfigFailureReason, WorkspaceConfig } from "../../shared/workspace-projects.ts";
import {
  PROJECT_CONFIG_FILE,
  isSafeProjectDir,
  parseWorkspaceConfigText,
} from "../../shared/workspace-projects.ts";
import type { RemoteFailure, RemoteRef } from "./remote.ts";
import { parseRemoteUrl, readRemoteUrl, webUrlFor } from "./remote.ts";

/**
 * 工作区 → 仓库的解析，含「容器目录」场景。
 *
 * 一个工作区目录可能是仓库本身，也可能只是放项目的父目录（例如
 * `/www/wwwroot/game.kxhyapp.com` 下面有四五个仓库）。后者以前一律回落成本地 `.deck`，
 * 用户看到的是「0 张票」，很难意识到点错了层级。
 *
 * 这里的顺序是刻意的：
 * 1. `.paseo-deck.json` 里显式选的子目录仓库（用户选过就不要再猜）；
 * 2. 工作区根目录自己的远端（普通仓库，行为不变）；
 * 3. 子目录里恰好一个仓库 → 自动用；
 * 4. 多个 → 不猜，回落本地，由界面给选择条。
 *
 * 只认 GitHub / GitLab：别的宿主选了也读不到票，列出来只会制造一次失败。
 */

export interface RepoOut {
  /** local 表示没有远端（或设置强制本地）：数据在 `.deck/` 里。 */
  host: RemoteRef["host"] | "local";
  owner: string;
  name: string;
  webUrl: string | null;
}

export type GateFailure = { ok: false; reason: "no-repo" | "unsupported-host"; detail: string };

export type Gate =
  | { ok: true; ref: RemoteRef; repo: RepoOut; repoRoot: string; fromSubdir: boolean }
  | GateFailure;

const REMOTE_PROBLEMS: Record<RemoteFailure["reason"], string> = {
  "no-remote": "这个工作区没有可用的 git 远端（origin / upstream），先关联一个 GitHub 仓库再试",
  "not-a-repo": "这个工作区不是可读的 git 仓库，先确认目录里有 .git 且 git 能正常打开它",
  "git-missing": "没有找到 git 命令：装好 git 并确认它在 PATH 里，插件靠它认仓库",
};

const MAX_CHILDREN = 30;
const SCAN_BATCH = 6;

/** 选择只允许单段目录名：`..`、绝对路径、带分隔符的值一律拒绝，不给路径穿越留口子。 */
export function isSafeSegment(dir: string): boolean {
  return (
    dir.length > 0 &&
    dir.length <= 100 &&
    dir !== "." &&
    dir !== ".." &&
    !dir.includes("/") &&
    !dir.includes("\\") &&
    !dir.includes("\0")
  );
}

async function realDir(dir: string): Promise<string | null> {
  try {
    return await realpath(dir);
  } catch {
    return null;
  }
}

/**
 * 校验一个子目录确实是工作区内的 git 仓库，并读它的远端。
 *
 * `realpath` 之后必须仍落在工作区内：子目录是符号链接指向别处时，
 * 宁可当作没识别到，也不去读工作区外的仓库。
 */
async function childRepoAt(rootReal: string, dir: string): Promise<{ ref: RemoteRef; repoRoot: string } | null> {
  // v2 的项目目录允许 `apps/admin-web` 这种多段路径；越界由下面的 realpath 相对检查兜住。
  if (!isSafeProjectDir(dir)) return null;

  let real: string;
  try {
    real = await realpath(path.join(rootReal, dir));
  } catch {
    return null;
  }
  const rel = path.relative(rootReal, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  try {
    if (!(await stat(real)).isDirectory()) return null;
    // `.git` 可能是目录（普通仓库），也可能是文件（worktree / submodule），两者都算。
    await stat(path.join(real, ".git"));
  } catch {
    return null;
  }

  const remote = await readRemoteUrl(real);
  if (!remote.ok) return null;
  const ref = parseRemoteUrl(remote.url);
  return ref ? { ref, repoRoot: real } : null;
}

/** 配置读不出来的三种来源：没有文件、文件读不动、内容不认。 */
export type ProjectConfigRead =
  | { ok: true; config: WorkspaceConfig }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" | ConfigFailureReason; detail: string };

/**
 * 读 `.paseo-deck.json` 并分辨「没有」与「坏了」。
 *
 * 早先这里把任何问题都吞成 null，用户看到的是「0 张票」，说不清是没配还是配错了。
 * 现在调用方拿得到具体原因，可以在界面上原样显示。
 */
export async function readWorkspaceConfig(workspaceDir: string): Promise<ProjectConfigRead> {
  return (await readWorkspaceConfigSnapshot(workspaceDir)).read;
}

/**
 * 同一次读里既拿解析结果、又拿文件正文与指纹。
 *
 * 界面要「清单 + 指纹」两样：分两次读文件，中间被人改过就会出现「A 的行配 B 的指纹」，
 * 保存时指纹反而吻合，把对方的改动悄悄盖掉。所以正文只读一次，解析与哈希都用它。
 */
export async function readWorkspaceConfigSnapshot(workspaceDir: string): Promise<{
  read: ProjectConfigRead;
  text: string | null;
}> {
  let text: string;
  try {
    text = await readFile(path.join(workspaceDir, PROJECT_CONFIG_FILE), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { read: { ok: false, reason: "missing" }, text: null };
    return {
      read: {
        ok: false,
        reason: "unreadable",
        detail: `读 ${PROJECT_CONFIG_FILE} 失败：${error instanceof Error ? error.message : String(error)}`,
      },
      text: null,
    };
  }
  return { read: parseWorkspaceConfigText(text), text };
}

/**
 * v1 的「选了哪个仓库」。
 *
 * v2 没有这个语义（项目清单里每个项目都是自己），所以一律返回 null；
 * 坏配置也只当作「没选」——选择只是默认项，读不出来不该让整块板子变成错误，
 * 具体原因由 `readWorkspaceConfig` 的调用方展示。
 */
export async function readSelection(workspaceDir: string): Promise<string | null> {
  const read = await readWorkspaceConfig(workspaceDir);
  if (!read.ok || read.config.version !== 1) return null;
  const dir = read.config.projects[0]?.dir ?? "";
  if (!isSafeSegment(dir)) return null;
  const rootReal = await realDir(workspaceDir);
  if (!rootReal) return null;
  return (await childRepoAt(rootReal, dir)) ? dir : null;
}

/** 配置里某个项目目录的实探结果：目录在不在、是不是工作区内、能不能认出远端。 */
export interface ProjectDirProbe {
  /** 真实路径（已 `realpath`，一定落在工作区内）；读不到时 null。 */
  realDir: string | null;
  /** 目录是 git 仓库且远端可识别时的坐标；否则 null。 */
  ref: RemoteRef | null;
  /** 非 null 表示这个项目当不了任务板目标，原因就是它。 */
  problem: string | null;
}

/** 以工作区为根探一个项目目录；上游（目标解析 / 诊断界面）都从这里拿结论。 */
export async function probeProjectDir(workspaceDir: string, dir: string): Promise<ProjectDirProbe> {
  const rootReal = await realDir(workspaceDir);
  if (!rootReal) return { realDir: null, ref: null, problem: `工作区目录不可读：${workspaceDir}` };
  return probeProjectDirAt(rootReal, dir);
}

async function probeProjectDirAt(rootReal: string, dir: string): Promise<ProjectDirProbe> {
  if (!isSafeProjectDir(dir)) {
    return { realDir: null, ref: null, problem: `目录「${dir}」不是工作区内的相对路径` };
  }
  let real: string;
  try {
    real = await realpath(path.join(rootReal, dir));
  } catch {
    return { realDir: null, ref: null, problem: `目录「${dir}」不存在` };
  }
  const rel = path.relative(rootReal, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { realDir: null, ref: null, problem: `目录「${dir}」指向工作区外（符号链接？）` };
  }
  try {
    if (!(await stat(real)).isDirectory()) {
      return { realDir: null, ref: null, problem: `「${dir}」不是目录` };
    }
  } catch {
    return { realDir: null, ref: null, problem: `目录「${dir}」读不到` };
  }
  const remote = await readRemoteUrl(real);
  if (!remote.ok) {
    const reason = remote.reason === "git-missing" ? "没有找到 git 命令" : "不是可读的 git 仓库";
    return { realDir: real, ref: null, problem: `${reason}（${dir}）` };
  }
  const ref = parseRemoteUrl(remote.url);
  if (!ref || ref.host === "other") {
    return { realDir: real, ref: null, problem: `远端不是 GitHub / GitLab（${dir}）` };
  }
  return { realDir: real, ref, problem: null };
}

export type SelectionWrite =
  | { ok: true; selected: string | null }
  | { ok: false; reason: "invalid-selection" | "write-failed"; detail: string };

/** `null` = 清除选择（删掉文件），回到工作区根目录 / 自动识别。 */
export async function writeSelection(workspaceDir: string, repoDir: string | null): Promise<SelectionWrite> {
  const rootReal = await realDir(workspaceDir);
  if (!rootReal) {
    return { ok: false, reason: "invalid-selection", detail: `工作区目录不可读：${workspaceDir}` };
  }
  const file = path.join(workspaceDir, PROJECT_CONFIG_FILE);

  // v2 文件里是一整份项目清单：这里只会写 v1 的形状，落笔就等于把清单删了。
  // 选择条在 v2 工作区里应该改用项目清单，而不是覆盖它。
  const existing = await readWorkspaceConfig(workspaceDir);
  if (existing.ok && existing.config.version === 2) {
    return {
      ok: false,
      reason: "invalid-selection",
      detail: `${PROJECT_CONFIG_FILE} 是 v2 项目清单，不能用一个「默认仓库」覆盖它；请在项目清单里调整`,
    };
  }

  if (repoDir === null) {
    try {
      await rm(file, { force: true });
      return { ok: true, selected: null };
    } catch (error) {
      return {
        ok: false,
        reason: "write-failed",
        detail: `删除 ${PROJECT_CONFIG_FILE} 失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!isSafeSegment(repoDir)) {
    return { ok: false, reason: "invalid-selection", detail: `只接受工作区下的单层目录名，收到：${repoDir}` };
  }
  if (!(await childRepoAt(rootReal, repoDir))) {
    return {
      ok: false,
      reason: "invalid-selection",
      detail: `${repoDir} 不是工作区下的 git 仓库（或缺远端），不能作为任务板仓库`,
    };
  }

  try {
    await writeFile(file, `${JSON.stringify({ repoDir }, null, 2)}\n`, "utf8");
    return { ok: true, selected: repoDir };
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      detail: `写入 ${PROJECT_CONFIG_FILE} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ChildScan {
  repos: RepoCandidate[];
  /** 子目录数超过上限：只扫了前 MAX_CHILDREN 个。 */
  truncated: boolean;
}

/**
 * 扫描结果短缓存。
 *
 * 一次界面刷新会同时问「全部目标」「票列表」「标签页」——各自跑一遍 `git` 扫子目录，
 * 一个容器工作区就是几十个进程。仓库目录不会在 2 秒内变化，缓这么短足够合并同一轮请求，
 * 又不会让新建的仓库长时间看不见。
 */
const SCAN_TTL_MS = 2_000;
const scanCache = new Map<string, { at: number; value: ChildScan }>();

/** 列出直接子目录里的 GitHub / GitLab 仓库；点目录与无远端的目录直接跳过。 */
export async function listChildReposDetailed(workspaceDir: string): Promise<ChildScan> {
  const rootReal = await realDir(workspaceDir);
  if (!rootReal) return { repos: [], truncated: false };

  const cached = scanCache.get(rootReal);
  if (cached && Date.now() - cached.at < SCAN_TTL_MS) return cached.value;

  let names: string[];
  try {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { repos: [], truncated: false };
  }
  const truncated = names.length > MAX_CHILDREN;
  names = names.slice(0, MAX_CHILDREN);

  const found: RepoCandidate[] = [];
  // 分批并发：最多 30 个子目录，每批 6 个，避免一次起几十个 git 进程。
  for (let index = 0; index < names.length; index += SCAN_BATCH) {
    const batch = await Promise.all(
      names.slice(index, index + SCAN_BATCH).map(async (dir) => ({ dir, repo: await childRepoAt(rootReal, dir) })),
    );
    for (const item of batch) {
      const repo = item.repo;
      if (!repo) continue;
      if (repo.ref.host !== "github" && repo.ref.host !== "gitlab") continue;
      const webUrl = webUrlFor(repo.ref);
      if (!webUrl) continue;
      found.push({
        dir: item.dir,
        host: repo.ref.host,
        owner: repo.ref.owner,
        name: repo.ref.name,
        webUrl,
      });
    }
  }
  const value: ChildScan = { repos: found, truncated };
  scanCache.set(rootReal, { at: Date.now(), value });
  return value;
}

export async function listChildRepos(workspaceDir: string): Promise<RepoCandidate[]> {
  return (await listChildReposDetailed(workspaceDir)).repos;
}

function toGate(count: { ref: RemoteRef; repoRoot: string }, fromSubdir: boolean): Gate {
  const { ref } = count;
  return {
    ok: true,
    ref,
    repo: { host: ref.host, owner: ref.owner, name: ref.name, webUrl: webUrlFor(ref) },
    repoRoot: count.repoRoot,
    fromSubdir,
  };
}

export async function resolveWorkspaceRepo(workspaceDir: string): Promise<Gate> {
  const selected = await readSelection(workspaceDir);
  if (selected) {
    const rootReal = await realDir(workspaceDir);
    const child = rootReal ? await childRepoAt(rootReal, selected) : null;
    if (child) return toGate(child, true);
    // 选择失效（目录改名 / 删了）：当作没选，继续走下面的自动识别。
  }

  const rootRemote = await readRemoteUrl(workspaceDir);
  if (rootRemote.ok) {
    const ref = parseRemoteUrl(rootRemote.url);
    if (ref) return toGate({ ref, repoRoot: workspaceDir }, false);
    return { ok: false, reason: "no-repo", detail: `无法识别远端地址：${rootRemote.url}` };
  }
  if (rootRemote.reason === "git-missing") {
    return { ok: false, reason: "no-repo", detail: REMOTE_PROBLEMS["git-missing"] };
  }

  const children = await listChildRepos(workspaceDir);
  const only = children.length === 1 ? children[0] : null;
  if (only) {
    return toGate(
      {
        ref: { host: only.host, owner: only.owner, name: only.name },
        repoRoot: path.join(workspaceDir, only.dir),
      },
      true,
    );
  }
  if (children.length > 1) {
    return {
      ok: false,
      reason: "no-repo",
      detail: `这个工作区下有 ${children.length} 个仓库，还没有选定任务板用哪一个；在任务板上选一个，或在设置里改用具体仓库目录作为工作区`,
    };
  }
  return { ok: false, reason: "no-repo", detail: REMOTE_PROBLEMS[rootRemote.reason] };
}

export type RepoCandidatesResult =
  | { ok: true; rootIsRepo: boolean; selected: string | null; candidates: RepoCandidate[] }
  | { ok: false; reason: "workspace-missing" | "scan-failed"; detail: string };

export async function readRepoCandidates(workspaceDir: string): Promise<RepoCandidatesResult> {
  const rootReal = await realDir(workspaceDir);
  if (!rootReal) {
    return { ok: false, reason: "workspace-missing", detail: `工作区目录不可读：${workspaceDir}` };
  }
  const rootRemote = await readRemoteUrl(workspaceDir);
  const rootIsRepo = rootRemote.ok && parseRemoteUrl(rootRemote.url) !== null;
  const [selected, candidates] = await Promise.all([readSelection(workspaceDir), listChildRepos(workspaceDir)]);
  return { ok: true, rootIsRepo, selected, candidates };
}
