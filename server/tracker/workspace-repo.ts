import { readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RepoCandidate } from "../../shared/repo.ts";
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

const SELECTION_FILE = ".paseo-deck.json";
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
  if (!isSafeSegment(dir)) return null;

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

/** 读 `.paseo-deck.json`；不存在、坏了、指向的目录已经没了都当作「没选」，不报致命错误。 */
export async function readSelection(workspaceDir: string): Promise<string | null> {
  const rootReal = await realDir(workspaceDir);
  if (!rootReal) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(workspaceDir, SELECTION_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const dir = (parsed as { repoDir?: unknown }).repoDir;
  if (typeof dir !== "string" || !isSafeSegment(dir)) return null;
  return (await childRepoAt(rootReal, dir)) ? dir : null;
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
  const file = path.join(workspaceDir, SELECTION_FILE);

  if (repoDir === null) {
    try {
      await rm(file, { force: true });
      return { ok: true, selected: null };
    } catch (error) {
      return {
        ok: false,
        reason: "write-failed",
        detail: `删除 ${SELECTION_FILE} 失败：${error instanceof Error ? error.message : String(error)}`,
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
      detail: `写入 ${SELECTION_FILE} 失败：${error instanceof Error ? error.message : String(error)}`,
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
