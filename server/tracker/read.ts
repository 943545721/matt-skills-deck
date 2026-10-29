import type { BlockerRef, BoardIssue, FailureReason, ItemKind, ListView, Readiness } from "../../shared/issues.ts";
import type { IssueDetailResult, ListIssuesResult, ListOptions, RateLimit } from "./github.ts";
import { getIssue, listIssues } from "./github.ts";
import { getGitLabIssue, listGitLabIssues } from "./gitlab.ts";
import { getLocalIssue, listLocalIssues } from "./local.ts";
import type { RepoTarget } from "./targets.ts";
import { repoOf, resolveTarget, resolveWorkspaceTargets } from "./targets.ts";
import type { RepoOut } from "./workspace-repo.ts";
import { readWorkspaceConfig } from "./workspace-repo.ts";
import { readinessOf } from "./readiness.ts";
import { bodyDependencyRef, parseCrossRepoBlockRefs } from "../../shared/edge-rules.ts";

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

/* ------------------------------------------------------------------ 跨仓库依赖 */

/**
 * 跨仓库引用读取结果的短缓存。
 *
 * 一块板子里可能十几张票都指向同一张上游票；每次刷新都按引用去查，会把同一个请求打十几次。
 * 2 秒只够合并同一轮刷新（与 `workspace-repo.ts` 的扫描缓存同一个思路），
 * 又不会让「对方刚关票」在界面上迟迟不变。
 */
const DEPENDENCY_TTL_MS = 2_000;
/** 一次最多起 4 个读进程：与列表读取同一个并发上限，别把远端额度一次打满。 */
const DEPENDENCY_CONCURRENCY = 4;

interface DependencySnapshot {
  /** false 表示这张票读不到（仓库不可达 / 票号不存在），调用方要标成「引用失效」。 */
  ok: boolean;
  state: "OPEN" | "CLOSED";
  title: string;
}

const dependencyCache = new Map<string, { at: number; value: DependencySnapshot }>();

/** 仅供测试：清掉短缓存，让下一次读真的去问远端。 */
export function resetDependencyCacheForTest(): void {
  dependencyCache.clear();
}

async function readDependency(
  target: RepoTarget | undefined,
  repoKey: string,
  number: number,
): Promise<DependencySnapshot> {
  const cacheKey = `${repoKey}#${number}`;
  const cached = dependencyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DEPENDENCY_TTL_MS) return cached.value;
  const label = `${repoKey}#${number}`;
  let value: DependencySnapshot = { ok: false, state: "OPEN", title: label };
  if (target) {
    try {
      const result =
        target.host === "github"
          ? await getIssue(target.owner, target.name, number, "issue")
          : await getGitLabIssue(target.owner, target.name, number);
      if (result.ok) value = { ok: true, state: result.issue.state, title: result.issue.title };
    } catch {
      // 读一张上游票失败不该让整块板子消失：按「引用失效」处理，并在界面上说清楚。
      value = { ok: false, state: "OPEN", title: label };
    }
  }
  dependencyCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** 合并阻塞边需要的最小票面形状：列表行与详情票都满足。 */
export interface CrossRepoIssueFields {
  repoKey: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  merged?: boolean;
  assignees: readonly string[];
  blockedBy: BlockerRef[];
  readiness: Readiness;
  body?: string;
}

const blockerKey = (blocker: BlockerRef, fallbackRepo: string): string =>
  `${blocker.repo ?? fallbackRepo}#${blocker.number}`;

/**
 * 把正文隐藏区段里的跨仓库引用并进 `blockedBy`，并按合并结果重算 readiness。
 *
 * 三遍：先解析每张票的引用；再按引用去查（同一次请求内去重、带短缓存、限并发）；
 * 最后合并。读不到的一律标 `stale` + `UNKNOWN`，**不当作已解除**。
 * 原生边保持原样，只补一个 `source: "native"`，让人分得清这条边从哪来。
 */
export async function attachCrossRepoBlockers<T extends CrossRepoIssueFields>(
  issues: readonly T[],
  targets: readonly RepoTarget[],
  projects: readonly { key: string; repo: string | null }[],
): Promise<T[]> {
  const targetByKey = new Map<string, RepoTarget>(targets.map((target) => [target.key, target]));
  const repoKeys = [...targetByKey.keys()];
  const boardByKey = new Map<string, T>(issues.map((issue) => [`${issue.repoKey}#${issue.number}`, issue]));

  const refsByIndex = new Map<number, { repo: string; number: number }[]>();
  const wanted = new Map<string, { repo: string; number: number }>();
  issues.forEach((issue, index) => {
    const scope = {
      projects,
      // 本地后端没有远端坐标：正文里裸写的 `#12` 就是同一份 `.deck` 里的票。
      currentRepo: issue.repoKey === "local" ? null : issue.repoKey,
      repos: repoKeys,
    };
    const refs = parseCrossRepoBlockRefs(issue.body).flatMap((raw) => {
      const parsed = bodyDependencyRef(raw, scope);
      return parsed ? [parsed] : [];
    });
    const unique = refs.filter((ref, at) => refs.findIndex((other) => other.repo === ref.repo && other.number === ref.number) === at);
    if (unique.length === 0) return;
    refsByIndex.set(index, unique);
    for (const ref of unique) {
      const key = `${ref.repo}#${ref.number}`;
      if (!boardByKey.has(key) && !wanted.has(key)) wanted.set(key, ref);
    }
  });

  const snapshots = new Map<string, DependencySnapshot>();
  const keys = [...wanted.keys()];
  for (let index = 0; index < keys.length; index += DEPENDENCY_CONCURRENCY) {
    const batch = await Promise.all(
      keys.slice(index, index + DEPENDENCY_CONCURRENCY).map(async (key) => {
        const ref = wanted.get(key);
        if (!ref) return { key, value: { ok: false, state: "OPEN" as const, title: key } };
        return { key, value: await readDependency(targetByKey.get(ref.repo), ref.repo, ref.number) };
      }),
    );
    for (const item of batch) snapshots.set(item.key, item.value);
  }

  return issues.map((issue, index) => {
    const refs = refsByIndex.get(index) ?? [];
    const merged: BlockerRef[] = issue.blockedBy.map((blocker) => ({ ...blocker, source: "native" as const }));
    const seen = new Set(issue.blockedBy.map((blocker) => blockerKey(blocker, issue.repoKey)));
    for (const ref of refs) {
      const key = `${ref.repo}#${ref.number}`;
      // 同一条边已经写在原生关系里时以原生为准：不重复列两遍，也不改它的来源。
      if (seen.has(key)) continue;
      seen.add(key);
      const local = boardByKey.get(key);
      const snapshot = local
        ? { ok: true, state: local.state, title: local.title }
        : snapshots.get(key) ?? { ok: false, state: "OPEN" as const, title: key };
      merged.push({
        number: ref.number,
        title: snapshot.title,
        state: snapshot.ok ? snapshot.state : "UNKNOWN",
        kind: "issue",
        repo: ref.repo,
        source: "body",
        ...(snapshot.ok ? {} : { stale: true }),
      });
    }
    if (refs.length === 0) return { ...issue, blockedBy: merged };
    return {
      ...issue,
      blockedBy: merged,
      readiness: readinessOf({ state: issue.state, merged: issue.merged, assignees: issue.assignees, blockedBy: merged }),
    };
  });
}

/** `.paseo-deck.json` 的项目清单视图；读不出来就当没有（写侧会因此拒绝跨仓库引用）。 */
async function crossRepoProjects(workspaceDir: string): Promise<{ key: string; repo: string | null }[]> {
  const read = await readWorkspaceConfig(workspaceDir);
  return read.ok ? read.config.projects.map((project) => ({ key: project.key, repo: project.repo })) : [];
}

const hasCrossRepoRefs = (issues: readonly { body?: string }[]): boolean =>
  issues.some((issue) => parseCrossRepoBlockRefs(issue.body).length > 0);

/** 合并完再按调用方的要求剥正文：解析跨仓库行必须先拿到正文。 */
function withoutBody<T extends { body?: string }>(issues: readonly T[]): T[] {
  return issues.map((issue) => {
    const { body: _body, ...rest } = issue;
    return rest as T;
  });
}

export async function readBoard(workspaceDir: string, options: BoardOptions = {}): Promise<BoardRead | ReadFailure> {
  const resolved = await resolveWorkspaceTargets(workspaceDir);
  if (!resolved.ok) return resolved;

  const listOptions: ListOptions = {
    limit: options.limit ?? 100,
    view: options.view,
    includeClosed: options.includeClosed,
    // 一律取正文：跨仓库依赖写在正文的隐藏区段里，不读正文就根本看不出这张票还等着谁。
    // 这是多出的一点负载，但「板子上少了一条阻塞」比多传几 KB 更糟；
    // 返回前仍按 withBody 剥掉（见 withoutBody），界面不会背正文。
    withBody: true,
  };
  const keepBody = options.withBody === true;

  if (resolved.kind === "local") {
    if (options.repoKey && options.repoKey !== "local") {
      return { ok: false, reason: "invalid", detail: `本地 .deck 后端只有仓库键 local，收到：${options.repoKey}` };
    }
    const result = await listLocalIssues(workspaceDir, listOptions);
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail, repo: resolved.repo };
    const tagged = result.issues.map((issue) => ({ ...issue, repoKey: "local" }));
    // 本地后端没有可连的远端仓库：跨仓库引用一律读不到，会落成「引用失效」，这是如实的结果。
    const merged = await attachCrossRepoBlockers(tagged, [], await crossRepoProjects(workspaceDir));
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
      issues: keepBody ? merged : withoutBody(merged),
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
    for (const issue of result.issues) issues.push({ ...issue, repoKey: target.key });
  }

  // 用全集（`all`）解析跨仓库引用：按 repoKey 筛过一次，不该让别的仓库的阻塞者变成「读不到」。
  const merged = await attachCrossRepoBlockers(issues, all, await crossRepoProjects(workspaceDir));

  return {
    ok: true,
    // 全集而不是本次筛选后的子集：界面拿它画筛选条，筛过的结果反推不出「还有哪些仓库」。
    repos: all.map(repoSummaryOf),
    issues: keepBody ? merged : withoutBody(merged),
    failures,
    totalCount,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : new Date().toISOString(),
    hasMore,
    source: sources.size === 1 ? [...sources][0] ?? "mixed" : "mixed",
    rateLimit,
    repo: wanted.length === 1 && wanted[0] ? repoOf(wanted[0]) : undefined,
  };
}

/**
 * 详情页的跨仓库边：只在这张票正文确实写了引用时才多解析一次工作区仓库，
 * 免得每打开一张普通票都跑一遍目录扫描。
 */
async function mergeDetailBlockers(
  workspaceDir: string,
  repoKey: string,
  result: IssueDetailResult,
): Promise<IssueDetailResult> {
  if (!result.ok || !hasCrossRepoRefs([result.issue])) return result;
  const resolved = await resolveWorkspaceTargets(workspaceDir);
  const targets = resolved.ok && resolved.kind === "repos" ? resolved.targets : [];
  const [merged] = await attachCrossRepoBlockers(
    [{ ...result.issue, repoKey }],
    targets,
    await crossRepoProjects(workspaceDir),
  );
  if (!merged) return result;
  return { ...result, issue: { ...result.issue, blockedBy: merged.blockedBy, readiness: merged.readiness } };
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
    return {
      ok: true,
      repo: picked.repo,
      repoKey: "local",
      result: await mergeDetailBlockers(workspaceDir, "local", result),
    };
  }

  const target = picked.target;
  const result =
    target.host === "github"
      ? await getIssue(target.owner, target.name, number, kind)
      : await getGitLabIssue(target.owner, target.name, number);
  return { ok: true, repo: repoOf(target), repoKey: target.key, result: await mergeDetailBlockers(workspaceDir, target.key, result) };
}
