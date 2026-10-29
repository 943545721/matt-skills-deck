import type { BoardIssue, FailureReason, ItemKind, ListView } from "../../shared/issues.ts";
import type { Issue, IssueDetailResult, ListIssuesResult, ListOptions, RateLimit } from "./github.ts";
import { getIssue, listIssues } from "./github.ts";
import { getGitLabIssue, listGitLabIssues } from "./gitlab.ts";
import { getLocalIssue, listLocalIssues } from "./local.ts";
import type { RepoTarget } from "./targets.ts";
import { repoOf, resolveTarget, resolveWorkspaceTargets } from "./targets.ts";
import type { RepoOut } from "./workspace-repo.ts";

/**
 * 读路径的统一入口。
 *
 * 面板、地图、MCP 各自处理「远端是什么后端」就会分叉；这里只回答一个问题：
 * 给定工作区，按当前设置应该读到哪一份数据。
 *
 * 容器工作区会同时读多个仓库：票面合并，每张票带 `repoKey`。
 * 单个仓库失败不拖垮整块板子——记进 `failures`，其余照常显示。
 */

/** 板子上的一个仓库。`dir` 是本地代码目录，Agent 修复时要用。 */
export interface RepoSummary {
  key: string;
  host: "github" | "gitlab" | "local";
  owner: string;
  name: string;
  webUrl: string | null;
  dir: string;
  readOnly: boolean;
}

export interface RepoFailure {
  repoKey: string;
  reason: FailureReason;
  detail: string;
}

export type BoardSource = "graphql" | "rest" | "local" | "gitlab" | "mixed";

export interface BoardRead {
  ok: true;
  /** 工作区里的全部仓库（含失败、含被 repoKey 筛掉的那些）。 */
  repos: RepoSummary[];
  issues: BoardIssue[];
  failures: RepoFailure[];
  totalCount: number;
  fetchedAt: string;
  hasMore: boolean;
  source: BoardSource;
  /** 剩余额度最小的一份；取最小值是为了让界面提示最保守的那个数。 */
  rateLimit: RateLimit | null;
  /** 只有一个仓库时给（顶栏与旧调用方靠它显示名字）。 */
  repo?: RepoOut;
}

export interface ReadFailure {
  ok: false;
  reason: FailureReason;
  detail: string;
  repo?: RepoOut;
}

export interface IssueRead {
  ok: true;
  repo: RepoOut;
  repoKey: string;
  result: IssueDetailResult;
}

export interface BoardOptions {
  limit?: number;
  view?: ListView;
  includeClosed?: boolean;
  /** 只读一个仓库；省略表示全部。 */
  repoKey?: string;
  /** 列表行带正文：只给需要按正文判类型的工具用，界面刷新不要打开。 */
  withBody?: boolean;
  /**
   * 只要求服务端判出 `containerKind`，不把正文带回给调用方。
   *
   * 任务板要在地图/规格行上显示身份，但一块板子最多几百张票，正文全量传给
   * 客户端既没有必要，也会让列表 RPC 的响应变大；查询时取正文、返回前丢掉，
   * 客户端只拿到一个枚举。
   */
  identifyContainers?: boolean;
}

/** 一次最多起 4 个 gh / glab 进程：仓库多时首屏不至于排成长队，也不至于把额度打满。 */
const READ_CONCURRENCY = 4;

function repoSummaryOf(target: RepoTarget): RepoSummary {
  return {
    key: target.key,
    host: target.host,
    owner: target.owner,
    name: target.name,
    webUrl: target.webUrl,
    dir: target.dir,
    // 远端都可写（GitLab 每次写之前另有权限闸门）；列表只反映目标声明。
    readOnly: target.readOnly,
  };
}

/**
 * 列表行落板：补上 repoKey；除显式要正文的调用方外，把正文剥掉。
 *
 * `containerKind` 在查询映射时已经算好，剥正文不会丢地图/规格身份。
 */
function asBoardIssue(issue: Issue, repoKey: string, keepBody: boolean): BoardIssue {
  if (keepBody || issue.body === undefined) return { ...issue, repoKey };
  const { body: _body, ...rest } = issue;
  return { ...rest, repoKey };
}

async function listFor(target: RepoTarget, options: ListOptions): Promise<ListIssuesResult> {
  try {
    return target.host === "github"
      ? await listIssues(target.owner, target.name, options)
      : await listGitLabIssues(target.owner, target.name, options);
  } catch (error) {
    // 单个仓库的意外异常不该让整个板子变成「读取失败」：归类成该宿主的一般失败，交给 failures。
    return {
      ok: false,
      reason: target.host === "github" ? "gh-failed" : "glab-failed",
      detail: `读取 ${target.key} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readBoard(workspaceDir: string, options: BoardOptions = {}): Promise<BoardRead | ReadFailure> {
  const resolved = await resolveWorkspaceTargets(workspaceDir);
  if (!resolved.ok) return resolved;

  const listOptions: ListOptions = {
    limit: options.limit ?? 100,
    view: options.view,
    includeClosed: options.includeClosed,
    // identifyContainers 只是「允许服务端读正文」，返回时是否保留正文由 withBody 决定。
    withBody: options.withBody === true || options.identifyContainers === true,
  };
  const keepBody = options.withBody === true;

  if (resolved.kind === "local") {
    if (options.repoKey && options.repoKey !== "local") {
      return { ok: false, reason: "invalid", detail: `本地 .deck 后端只有仓库键 local，收到：${options.repoKey}` };
    }
    const result = await listLocalIssues(workspaceDir, listOptions);
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail, repo: resolved.repo };
    return {
      ok: true,
      repos: [
        {
          key: "local",
          host: "local",
          owner: "",
          name: resolved.repo.name,
          webUrl: null,
          dir: resolved.workspaceDir,
          readOnly: false,
        },
      ],
      issues: result.issues.map((issue) => asBoardIssue(issue, "local", keepBody)),
      failures: [],
      totalCount: result.totalCount,
      fetchedAt: result.fetchedAt,
      hasMore: result.hasMore,
      source: result.source,
      rateLimit: result.rateLimit,
      repo: resolved.repo,
    };
  }

  const all = resolved.targets;
  let wanted = all;
  if (options.repoKey) {
    const found = wanted.filter((target) => target.key === options.repoKey);
    if (found.length === 0) {
      return {
        ok: false,
        reason: "invalid",
        detail: `没有名为 ${options.repoKey} 的仓库；这个工作区有：${all.map((target) => target.key).join("、")}`,
      };
    }
    wanted = found;
  }

  const reads: { target: RepoTarget; result: ListIssuesResult }[] = [];
  for (let index = 0; index < wanted.length; index += READ_CONCURRENCY) {
    const batch = await Promise.all(
      wanted
        .slice(index, index + READ_CONCURRENCY)
        .map(async (target) => ({ target, result: await listFor(target, listOptions) })),
    );
    reads.push(...batch);
  }

  const issues: BoardIssue[] = [];
  const failures: RepoFailure[] = [];
  const sources = new Set<BoardSource>();
  let totalCount = 0;
  let hasMore = false;
  let fetchedAt = 0;
  let rateLimit: RateLimit | null = null;

  for (const { target, result } of reads) {
    if (!result.ok) {
      // 只有一个仓库时保持旧行为：整次读取按失败返回，界面给出原因。
      if (wanted.length === 1) return { ok: false, reason: result.reason, detail: result.detail, repo: repoOf(target) };
      failures.push({ repoKey: target.key, reason: result.reason, detail: result.detail });
      continue;
    }
    totalCount += result.totalCount;
    hasMore = hasMore || result.hasMore;
    const stamp = Date.parse(result.fetchedAt);
    if (!Number.isNaN(stamp) && stamp > fetchedAt) fetchedAt = stamp;
    sources.add(result.source);
    if (result.rateLimit && (!rateLimit || result.rateLimit.remaining < rateLimit.remaining)) {
      rateLimit = result.rateLimit;
    }
    for (const issue of result.issues) issues.push(asBoardIssue(issue, target.key, keepBody));
  }

  return {
    ok: true,
    // 全集而不是本次筛选后的子集：界面拿它画筛选条，筛过的结果反推不出「还有哪些仓库」。
    repos: all.map(repoSummaryOf),
    issues,
    failures,
    totalCount,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : new Date().toISOString(),
    hasMore,
    source: sources.size === 1 ? [...sources][0] ?? "mixed" : "mixed",
    rateLimit,
    repo: wanted.length === 1 && wanted[0] ? repoOf(wanted[0]) : undefined,
  };
}

export async function readIssue(
  workspaceDir: string,
  number: number,
  options: { kind?: ItemKind; repoKey?: string } = {},
): Promise<IssueRead | ReadFailure> {
  const picked = await resolveTarget(workspaceDir, options.repoKey, "票面详情");
  if (!picked.ok) return picked;

  const kind = options.kind ?? "issue";
  if (picked.kind === "local") {
    const result =
      kind === "pull-request"
        ? { ok: false as const, reason: "not-found" as const, detail: "本地 Markdown 后端只存票，没有拉取请求" }
        : await getLocalIssue(picked.workspaceDir, number);
    return { ok: true, repo: picked.repo, repoKey: "local", result };
  }

  const target = picked.target;
  const result =
    target.host === "github"
      ? await getIssue(target.owner, target.name, number, kind)
      : await getGitLabIssue(target.owner, target.name, number);
  return { ok: true, repo: repoOf(target), repoKey: target.key, result };
}
