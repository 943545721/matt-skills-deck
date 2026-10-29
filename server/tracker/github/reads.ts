import type { BlockerRef, ItemKind } from "../../../shared/issues.ts";
import type { GhClient, GhResult } from "./client.ts";
import type { GhErrorKind } from "./errors.ts";
import {
  asPositiveInt,
  asString,
  edgeNodesOf,
  mapBlockerNodes,
  normalizeDependencyEdges,
  normalizeIssue,
  normalizeIssueList,
  normalizeReviews,
  type NormalizedIssue,
} from "./normalize.ts";
import { pickFallbackReason, type FallbackReason } from "./fallback.ts";
import {
  COMMENTS_DEFAULT,
  COMMENTS_MAX,
  DEPS_MAX,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  REMOTE_PAGE_LIMIT,
  SUB_ISSUES_MAX,
  SUB_ISSUES_PAGE_SIZE,
  countsQuery,
  getIssueQuery,
  listQuery,
  type IssueStateFilter,
} from "./queries.ts";

/** 仓库坐标：owner/name 都只允许 GitHub 的合法字符（边界校验，不把外部输入拼进路径）。 */
export interface RepoRef {
  owner: string;
  name: string;
  cwd?: string;
}

export interface ReadFailure {
  ok: false;
  kind: GhErrorKind | "invalid";
  message: string;
  raw: string;
}

export type ReadResult<T> = { ok: true; data: T } | ReadFailure;

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

export function validateRepoRef(repo: RepoRef): ReadFailure | null {
  if (!repo || !REPO_PART.test(repo.owner) || !REPO_PART.test(repo.name)) {
    return { ok: false, kind: "invalid", message: `仓库坐标不合法：${String(repo?.owner)}/${String(repo?.name)}`, raw: "" };
  }
  return null;
}

export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

function failureOf(result: Extract<GhResult, { ok: false }>): ReadFailure {
  return { ok: false, kind: result.error.kind, message: result.error.message, raw: result.error.raw };
}

export function invalid<T>(message: string): ReadResult<T> {
  return { ok: false, kind: "invalid", message, raw: "" };
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

export function parseRateCell(raw: unknown): RateLimit | null {
  if (!raw || typeof raw !== "object") return null;
  const cell = raw as { limit?: unknown; remaining?: unknown; resetAt?: unknown };
  if (typeof cell.limit !== "number" || typeof cell.remaining !== "number") return null;
  return { limit: cell.limit, remaining: cell.remaining, resetAt: asString(cell.resetAt) };
}

interface GraphqlPayload {
  data?: Record<string, unknown>;
  errors?: Array<{ message?: unknown }>;
}

export function parseGraphql(stdout: string): GraphqlPayload | null {
  try {
    const parsed: unknown = JSON.parse(stdout || "{}");
    return parsed && typeof parsed === "object" ? (parsed as GraphqlPayload) : null;
  } catch {
    return null;
  }
}

export function graphqlMessage(payload: GraphqlPayload | null): string {
  return (payload?.errors ?? []).map((error) => asString(error.message)).filter(Boolean).join("；");
}

const RATE_HINT = /rate limit|ratelimit|quota|exceeded|RATE_LIMITED/i;

export interface ListPageInput {
  repo: RepoRef;
  kind?: ItemKind | "all";
  state?: IssueStateFilter;
  limit?: number;
  cursor?: string | null;
  since?: string;
  /** 只取标签（AND）：服务端没有过滤时由调用方本地筛。 */
  labels?: readonly string[];
}

export interface ListPageData {
  items: NormalizedIssue[];
  totalCount: number;
  hasMore: boolean;
  nextCursor: string | null;
  fetchedAt: string;
  source: "graphql" | "rest";
  rateLimit: RateLimit | null;
  /** REST 回落原因，与 DSH 同口径：timeout / rate-limit / ghe-host / graphql-error。 */
  fallbackReason?: FallbackReason;
  truncated?: boolean;
}

function limitOf(limit: number | undefined): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : LIST_LIMIT_DEFAULT;
  return Math.min(Math.max(value, 1), LIST_LIMIT_MAX);
}

function sinceOf(since: string | undefined): string | null {
  if (!since) return null;
  const stamp = Date.parse(since);
  if (Number.isNaN(stamp)) return null;
  return new Date(stamp).toISOString();
}

function connectionOf(value: unknown, kindHint: ItemKind): { nodes: NormalizedIssue[]; totalCount: number; hasMore: boolean; cursor: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const cell = value as { totalCount?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown };
  if (typeof cell.totalCount !== "number") return null;
  const hasMore = cell.pageInfo?.hasNextPage === true;
  const cursor = asString(cell.pageInfo?.endCursor);
  // hasNextPage 为真却没有游标：返回半份数据会让界面以为「就这些」，按格式错误处理。
  if (hasMore && !cursor) return null;
  return {
    nodes: normalizeIssueList({ nodes: cell.nodes }, kindHint),
    totalCount: cell.totalCount,
    hasMore,
    cursor: cursor || null,
  };
}

/** 列表一页：GraphQL 优先；点数耗尽或网络错误时退 REST，并在数据里如实标注来源。 */
export async function listIssuesPage(client: GhClient, input: ListPageInput): Promise<ReadResult<ListPageData>> {
  const bad = validateRepoRef(input.repo);
  if (bad) return bad;
  const kind = input.kind ?? "issue";
  const state = input.state ?? "all";
  const limit = limitOf(input.limit);
  const since = sinceOf(input.since);

  if (kind === "all") return listAll(client, input, state, since, limit);
  const graph = await graphqlPage(client, input.repo, kind, state, since, limit, input.cursor ?? null);
  if (graph.ok) {
    const filtered = filterLabels(graph.data.items, input.labels);
    return { ok: true, data: { ...graph.data, items: filtered } };
  }
  if (graph.kind !== "ratelimit" && graph.kind !== "network" && graph.kind !== "notfound") return graph;
  if (graph.kind === "notfound") return graph;
  return restList(client, input.repo, kind, since, limit, input.labels, pickFallbackReason(graph));
}

async function listAll(
  client: GhClient,
  input: ListPageInput,
  state: IssueStateFilter,
  since: string | null,
  limit: number,
): Promise<ReadResult<ListPageData>> {
  // issue 与 PR 各查一次：编号空间共用，但两个连接无法用同一个游标可靠地翻页。
  const issues = await graphqlPage(client, input.repo, "issue", state, since, Math.min(limit, REMOTE_PAGE_LIMIT), null);
  if (!issues.ok) {
    if (issues.kind === "ratelimit" || issues.kind === "network") {
      return restList(client, input.repo, "all", since, limit, input.labels, pickFallbackReason(issues));
    }
    return issues;
  }
  const pulls = await graphqlPage(client, input.repo, "pull-request", state, since, Math.min(limit, REMOTE_PAGE_LIMIT), null);
  if (!pulls.ok) {
    if (pulls.kind === "ratelimit" || pulls.kind === "network") {
      return restList(client, input.repo, "all", since, limit, input.labels, pickFallbackReason(pulls));
    }
    return pulls;
  }
  const items = filterLabels([...issues.data.items, ...pulls.data.items], input.labels);
  return {
    ok: true,
    data: {
      items,
      totalCount: issues.data.totalCount + pulls.data.totalCount,
      hasMore: issues.data.hasMore || pulls.data.hasMore,
      nextCursor: issues.data.nextCursor ?? pulls.data.nextCursor,
      fetchedAt: new Date().toISOString(),
      source: "graphql",
      rateLimit: issues.data.rateLimit ?? pulls.data.rateLimit,
    },
  };
}

async function graphqlPage(
  client: GhClient,
  repo: RepoRef,
  kind: "issue" | "pull-request",
  state: IssueStateFilter,
  since: string | null,
  limit: number,
  cursor: string | null,
): Promise<ReadResult<ListPageData>> {
  const query = listQuery({ kind, state, since: since ?? undefined, withLabels: true });
  const variables: Record<string, string | number> = {
    owner: repo.owner,
    name: repo.name,
    first: Math.min(limit, REMOTE_PAGE_LIMIT),
  };
  if (cursor !== null && cursor !== "") variables.after = cursor;
  if (since) variables.since = since;
  const result = await client.graphql(query, variables, { cwd: repo.cwd });
  if (!result.ok) return failureOf(result);
  const payload = parseGraphql(result.stdout);
  if (!payload) return { ok: false, kind: "parse", message: "列表回包不是合法 JSON", raw: result.stdout.slice(0, 800) };
  const repository = payload.data?.repository;
  const message = graphqlMessage(payload);
  if (!repository) {
    if (/invalid cursor|cursor.*invalid/i.test(message)) {
      return { ok: false, kind: "notfound", message: "游标已失效，请重新加载", raw: message };
    }
    if (RATE_HINT.test(message)) return { ok: false, kind: "ratelimit", message, raw: message };
    if (message) return { ok: false, kind: "network", message, raw: message };
    return { ok: false, kind: "notfound", message: "仓库没有返回票面数据，检查登录账号是否有该仓库的读权限", raw: "" };
  }
  const connection = connectionOf((repository as Record<string, unknown>)[kind === "pull-request" ? "pullRequests" : "issues"], kind);
  if (!connection) return { ok: false, kind: "parse", message: "列表回包缺少 totalCount 或 pageInfo", raw: result.stdout.slice(0, 800) };
  return {
    ok: true,
    data: {
      items: connection.nodes,
      totalCount: connection.totalCount,
      hasMore: connection.hasMore,
      nextCursor: connection.cursor,
      fetchedAt: new Date().toISOString(),
      source: "graphql",
      rateLimit: parseRateCell((payload.data?.rateLimit as unknown)),
    },
  };
}

function filterLabels(items: NormalizedIssue[], labels: readonly string[] | undefined): NormalizedIssue[] {
  if (!labels || labels.length === 0) return items;
  return items.filter((item) => labels.every((label) => item.labels.some((entry) => entry.name === label)));
}

function restIssuesPath(repo: RepoRef, page: number, since: string | null): string {
  const sinceArg = since ? `&since=${encodeURIComponent(since)}` : "";
  return `repos/${repoSlug(repo)}/issues?state=all&sort=updated&direction=desc&per_page=${REMOTE_PAGE_LIMIT}&page=${page}${sinceArg}`;
}

/** REST 列表：最多 10 页 × 100。第一页失败即失败；后续页失败按已有数据截断，不丢已读到的票。 */
async function restList(
  client: GhClient,
  repo: RepoRef,
  kind: ItemKind | "all",
  since: string | null,
  limit: number,
  labels: readonly string[] | undefined,
  fallbackReason: FallbackReason,
): Promise<ReadResult<ListPageData>> {
  const items: NormalizedIssue[] = [];
  let truncated = false;
  for (let page = 1; page <= 10; page += 1) {
    const result = await client.rest(restIssuesPath(repo, page, since), { jq: "." });
    if (!result.ok) {
      if (page === 1) return failureOf(result);
      truncated = true;
      break;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout || "[]");
    } catch {
      if (page === 1) return { ok: false, kind: "parse", message: "REST 列表回包不是合法 JSON", raw: result.stdout.slice(0, 800) };
      truncated = true;
      break;
    }
    const batch = normalizeIssueList(raw);
    for (const item of batch) {
      if (kind === "issue" && item.kind !== "issue") continue;
      if (kind === "pull-request" && item.kind !== "pull-request") continue;
      items.push(item);
    }
    if (batch.length < REMOTE_PAGE_LIMIT || items.length >= limit) break;
  }
  const enriched = await enrichRestPRs(client, repo, items);
  const sliced = filterLabels(enriched, labels).slice(0, limit);
  return {
    ok: true,
    data: {
      items: sliced,
      totalCount: sliced.length,
      hasMore: items.length >= limit,
      nextCursor: null,
      fetchedAt: new Date().toISOString(),
      source: "rest",
      rateLimit: null,
      fallbackReason,
      truncated,
    },
  };
}

/** REST 的 issue 列表把 PR 一起返回，但不带 merged_at；按编号补 /pulls，失败按未合并处理。 */
export async function enrichRestPRs(client: GhClient, repo: RepoRef, items: NormalizedIssue[]): Promise<NormalizedIssue[]> {
  if (!items.some((item) => item.kind === "pull-request")) return items;
  const merged = new Map<number, boolean>();
  // 与 DSH fetchAllPullsREST 同口径：最多 10 页 × 100；中途失败保留已读到的页，不丢工单。
  for (let page = 1; page <= 10; page += 1) {
    const path = `repos/${repoSlug(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`;
    const result = await client.rest(path, { jq: "." });
    if (!result.ok) break;
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout || "[]");
    } catch {
      break;
    }
    if (!Array.isArray(raw)) break;
    for (const entry of edgeNodesOf(raw)) {
      const number = asPositiveInt(entry.number);
      if (number !== null) merged.set(number, typeof entry.merged_at === "string" && entry.merged_at.length > 0);
    }
    if (raw.length < 100) break;
  }
  return items.map((item) => {
    if (item.kind !== "pull-request" || !merged.has(item.number)) return item;
    const isMerged = merged.get(item.number) === true;
    return { ...item, merged: isMerged, state: isMerged ? "CLOSED" : item.state };
  });
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * REST 单票的 PR 富化：/issues 只给 pull_request 标记，合并时间要去 /pulls 补，
 * 评审明细要单独去 /reviews 拉（列表页不拉，单票页才拉真值）。
 * 全部尽力而为：失败保持原值，不把一张能读到的 PR 说成读失败。
 */
async function enrichRestPRDetail(client: GhClient, repo: RepoRef, item: NormalizedIssue): Promise<NormalizedIssue> {
  if (item.kind !== "pull-request") return item;
  const base = `repos/${repoSlug(repo)}/pulls/${item.number}`;
  let next = item;
  const pr = await client.rest(base, { jq: "." });
  if (pr.ok) {
    const entry = parseObject(pr.stdout);
    const mergedAt = asString(entry?.merged_at) || null;
    if (entry) {
      next = {
        ...next,
        merged: mergedAt !== null || next.merged,
        state: mergedAt !== null ? "CLOSED" : next.state,
        mergedAt,
      };
    }
  }
  const reviews = await client.rest(`${base}/reviews?per_page=100`, { jq: "." });
  if (reviews.ok) {
    try {
      const list: unknown = JSON.parse(reviews.stdout || "[]");
      if (Array.isArray(list)) next = { ...next, reviews: normalizeReviews(list) };
    } catch {
      // 评审明细是附加信息：回包坏了就保留 GraphQL/空数组，不让整个详情失败。
    }
  }
  return next;
}

export interface DetailOptions {
  kind?: ItemKind;
  comments?: number;
}

export interface Comment {
  author: string;
  createdAt: string;
  body: string;
}

export interface DetailData {
  issue: NormalizedIssue & { body: string };
  comments: Comment[];
  commentCount: number;
  labelsTruncated: boolean;
  commentsTruncated: boolean;
  blockersTruncated: boolean;
  source: "graphql" | "rest";
}

export function commentsWantOf(value: number | undefined): number {
  const wanted = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : COMMENTS_DEFAULT;
  return Math.min(Math.max(wanted, 0), COMMENTS_MAX);
}

export function firstPageSizeOf(want: number): number {
  return Math.min(Math.max(want, 1), 100);
}

export function mapComments(nodes: unknown): Comment[] {
  return edgeNodesOf(nodes).map((node) => ({
    author: asString((node.author as { login?: unknown } | undefined)?.login, "ghost"),
    createdAt: asString(node.createdAt),
    body: asString(node.body),
  }));
}

interface IssueQueryPage {
  issue: NormalizedIssue & { body: string };
  comments: Comment[];
  commentCount: number;
  labelsTruncated: boolean;
  blockersTruncated: boolean;
  hasNextComments: boolean;
  endCursor: string | null;
}

function readIssueQueryPage(client: GhClient, repo: RepoRef, number: number, kind: ItemKind, want: number, after: string | null): Promise<ReadResult<IssueQueryPage>> {
  const query = getIssueQuery({ kind, commentsFirst: firstPageSizeOf(want), withAfter: after !== null });
  const variables: Record<string, string | number> = { owner: repo.owner, name: repo.name, number, commentsFirst: firstPageSizeOf(want) };
  if (after !== null) variables.commentsAfter = after;
  return client.graphql(query, variables, { cwd: repo.cwd }).then((result) => {
    if (!result.ok) return failureOf(result);
    const payload = parseGraphql(result.stdout);
    if (!payload) return { ok: false as const, kind: "parse" as const, message: "详情回包不是合法 JSON", raw: result.stdout.slice(0, 800) };
    const repository = payload.data?.repository as Record<string, unknown> | null | undefined;
    const field = kind === "pull-request" ? "pullRequest" : "issue";
    const node = repository?.[field] as Record<string, unknown> | null | undefined;
    if (!node) {
      const message = graphqlMessage(payload);
      if (RATE_HINT.test(message)) return { ok: false as const, kind: "ratelimit" as const, message, raw: message };
      return { ok: false as const, kind: "notfound" as const, message: message || `找不到 #${number}`, raw: message };
    }
    const mapped = normalizeIssue(node, { kindHint: kind, withBody: true });
    if (!mapped) return { ok: false as const, kind: "parse" as const, message: `#${number} 的数据缺少编号`, raw: "" };
    const commentsCell = node.comments as { totalCount?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown } | undefined;
    const labelTotal = typeof (node.labels as { totalCount?: unknown } | undefined)?.totalCount === "number"
      ? (node.labels as { totalCount: number }).totalCount
      : mapped.labels.length;
    return {
      ok: true as const,
      data: {
        issue: { ...mapped, body: asString(node.body) },
        comments: mapComments(commentsCell?.nodes),
        commentCount: typeof commentsCell?.totalCount === "number" ? commentsCell.totalCount : 0,
        labelsTruncated: labelTotal > mapped.labels.length,
        blockersTruncated: (node.blockedBy as { pageInfo?: { hasNextPage?: unknown } } | undefined)?.pageInfo?.hasNextPage === true,
        hasNextComments: commentsCell?.pageInfo?.hasNextPage === true,
        endCursor: asString(commentsCell?.pageInfo?.endCursor) || null,
      },
    };
  });
}

/** 评论分页：只补到 wanted 条；后续页失败保留已收下的评论，整体仍按成功返回并标记截断。 */
async function readComments(client: GhClient, repo: RepoRef, number: number, kind: ItemKind, first: IssueQueryPage, want: number): Promise<{ comments: Comment[]; truncated: boolean; failed: boolean }> {
  const comments = [...first.comments];
  let cursor = first.endCursor;
  let hasNext = first.hasNextComments;
  let failed = false;
  for (let page = 0; page < 5 && comments.length < want && hasNext && cursor; page += 1) {
    const next = await readIssueQueryPage(client, repo, number, kind, want - comments.length, cursor);
    if (!next.ok) {
      failed = true;
      break;
    }
    comments.push(...next.data.comments);
    cursor = next.data.endCursor;
    hasNext = next.data.hasNextComments;
  }
  const trimmed = comments.slice(0, want);
  return { comments: trimmed, truncated: failed || hasNext || first.commentCount > trimmed.length || first.commentCount > comments.length, failed };
}

async function restDetail(client: GhClient, repo: RepoRef, number: number, want: number): Promise<ReadResult<DetailData>> {
  const result = await client.rest(`repos/${repoSlug(repo)}/issues/${number}`, { jq: "." });
  if (!result.ok) {
    if (result.error.kind === "notfound") return { ok: false, kind: "notfound", message: `仓库里找不到 #${number}`, raw: result.error.raw };
    return failureOf(result);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout || "null");
  } catch {
    return { ok: false, kind: "parse", message: "REST 详情回包不是合法 JSON", raw: result.stdout.slice(0, 800) };
  }
  const node = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base = normalizeIssue(node);
  const issue = base ? await enrichRestPRDetail(client, repo, base) : null;
  if (!issue) return { ok: false, kind: "notfound", message: `仓库里找不到 #${number}`, raw: "" };
  const commentsResult = await client.rest(`repos/${repoSlug(repo)}/issues/${number}/comments?per_page=${Math.max(1, Math.min(want, 100))}`, { jq: "." });
  let comments: Comment[] = [];
  if (commentsResult.ok) {
    try {
      comments = mapComments(JSON.parse(commentsResult.stdout || "[]"));
    } catch {
      comments = [];
    }
  }
  return {
    ok: true,
    data: {
      issue: { ...issue, body: asString(node.body) },
      comments: comments.slice(0, want),
      commentCount: comments.length,
      labelsTruncated: false,
      commentsTruncated: comments.length > want,
      blockersTruncated: false,
      source: "rest",
    },
  };
}

/** 详情：issue → PR → REST 的回落链；编号共用空间，不能把 PR 说成「找不到」。 */
export async function getIssueDetail(client: GhClient, repo: RepoRef, number: number, options: DetailOptions = {}): Promise<ReadResult<DetailData>> {
  const bad = validateRepoRef(repo);
  if (bad) return bad;
  if (!Number.isInteger(number) || number <= 0) return invalid(`票号必须是正整数：${String(number)}`);
  const want = commentsWantOf(options.comments);
  const kind = options.kind ?? "issue";
  const first = await readIssueQueryPage(client, repo, number, kind, want, null);
  if (first.ok) {
    const paged = await readComments(client, repo, number, kind, first.data, want);
    return {
      ok: true,
      data: {
        issue: first.data.issue,
        comments: paged.comments,
        commentCount: first.data.commentCount,
        labelsTruncated: first.data.labelsTruncated,
        commentsTruncated: paged.truncated,
        blockersTruncated: first.data.blockersTruncated,
        source: "graphql",
      },
    };
  }
  if (first.kind !== "notfound" && first.kind !== "ratelimit" && first.kind !== "network") return first;
  // issue 查不到时先试 PR：两张票共用编号空间。
  if (kind === "issue") {
    const alt = await readIssueQueryPage(client, repo, number, "pull-request", want, null);
    if (alt.ok) {
      const paged = await readComments(client, repo, number, "pull-request", alt.data, want);
      return {
        ok: true,
        data: {
          issue: alt.data.issue,
          comments: paged.comments,
          commentCount: alt.data.commentCount,
          labelsTruncated: alt.data.labelsTruncated,
          commentsTruncated: paged.truncated,
          blockersTruncated: alt.data.blockersTruncated,
          source: "graphql",
        },
      };
    }
    if (alt.kind !== "notfound" && alt.kind !== "ratelimit" && alt.kind !== "network") return alt;
  }
  return restDetail(client, repo, number, want);
}

export interface DependencyData {
  /** 与 DSH 的 IssueRef 同口径：只带编号、标题、状态、票种，够界面说清一条边，不背整份票面。 */
  blockedBy: BlockerRef[];
  blocking: BlockerRef[];
  blockingSource: "native" | "scan";
  blockingComplete: boolean;
  blockedByComplete: boolean;
  blockingNote?: string;
}

/** 依赖边读：先读原生真值；任一位缺失时用「全列表扫描」补 blocking，并如实标注不完整。 */
export async function getDependencies(client: GhClient, repo: RepoRef, number: number): Promise<ReadResult<DependencyData>> {
  const bad = validateRepoRef(repo);
  if (bad) return bad;
  const result = await client.graphql(DEPS_QUERY_TEXT, { owner: repo.owner, name: repo.name, number }, { cwd: repo.cwd });
  if (result.ok) {
    const payload = parseGraphql(result.stdout);
    const repository = payload?.data?.repository as Record<string, unknown> | null | undefined;
    const node = repository?.issue as Record<string, unknown> | null | undefined;
    const hasBoth = node && typeof node === "object" && node.blockedBy !== undefined && node.blocking !== undefined;
    if (hasBoth) {
      const edges = normalizeDependencyEdges(node);
      return {
        ok: true,
        data: {
          blockedBy: edges.blockedBy,
          blocking: edges.blocking,
          blockingSource: "native",
          blockingComplete: !edges.blockingTruncated,
          blockedByComplete: !edges.blockedByTruncated,
        },
      };
    }
  }
  return scanDependencies(client, repo, number);
}

async function scanDependencies(client: GhClient, repo: RepoRef, number: number): Promise<ReadResult<DependencyData>> {
  const detail = await getIssueDetail(client, repo, number, { kind: "issue", comments: 0 });
  if (!detail.ok) return detail;
  const list = await listIssuesPage(client, { repo, kind: "issue", state: "all", limit: LIST_LIMIT_MAX });
  if (!list.ok) {
    return {
      ok: true,
      data: {
        blockedBy: detail.data.issue.blockedBy,
        blocking: [],
        blockingSource: "scan",
        blockingComplete: false,
        blockedByComplete: !detail.data.blockersTruncated,
        blockingNote: `扫描阻塞者失败：${list.message}`,
      },
    };
  }
  const blocking = list.data.items.filter((item) => item.blockedBy.some((blocker) => blocker.number === number));
  const incomplete = list.data.hasMore || list.data.truncated === true || list.data.source === "rest";
  return {
    ok: true,
    data: {
      blockedBy: detail.data.issue.blockedBy,
      blocking,
      blockingSource: "scan",
      blockingComplete: !incomplete,
      blockedByComplete: !detail.data.blockersTruncated,
      ...(incomplete ? { blockingNote: "阻塞者列表来自扫描，窗口内可能不全" } : {}),
    },
  };
}

const DEPS_QUERY_TEXT = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      blockedBy(first:50){pageInfo{hasNextPage endCursor} nodes{number title state}}
      blocking(first:50){pageInfo{hasNextPage endCursor} nodes{number title state}}
    }
  }
}`;

export interface SubIssuesData {
  items: NormalizedIssue[];
  total: number;
  fetched: number;
  capped: boolean;
  missing: number;
  dropped: number;
}

/** 子票：GraphQL 原生连接，每页 100、最多 1000；任一页失败整次失败，不返回半份「看起来完整」的列表。 */
export async function listSubIssues(client: GhClient, repo: RepoRef, number: number): Promise<ReadResult<SubIssuesData>> {
  const bad = validateRepoRef(repo);
  if (bad) return bad;
  const items: NormalizedIssue[] = [];
  let cursor = "";
  let total = 0;
  let capped = false;
  for (let page = 0; page < SUB_ISSUES_MAX / SUB_ISSUES_PAGE_SIZE; page += 1) {
    const result = await querySubIssuePage(client, repo, number, cursor);
    if (!result.ok) return result;
    const cell = result.data;
    total = cell.total;
    items.push(...cell.items);
    if (!cell.hasNext) break;
    cursor = cell.cursor;
    if (!cursor) return { ok: false, kind: "parse", message: "子票分页缺少游标", raw: "" };
    if ((page + 1) * SUB_ISSUES_PAGE_SIZE >= SUB_ISSUES_MAX) capped = true;
  }
  const fetched = items.length;
  return {
    ok: true,
    data: {
      items: items.slice(0, SUB_ISSUES_MAX),
      total,
      fetched: Math.min(fetched, SUB_ISSUES_MAX),
      capped,
      missing: capped ? 0 : Math.max(0, total - fetched),
      dropped: Math.max(0, fetched - SUB_ISSUES_MAX),
    },
  };
}

interface SubIssuePage {
  items: NormalizedIssue[];
  total: number;
  hasNext: boolean;
  cursor: string;
}

async function querySubIssuePage(client: GhClient, repo: RepoRef, number: number, cursor: string): Promise<ReadResult<SubIssuePage>> {
  const args: Record<string, string | number> = { owner: repo.owner, name: repo.name, number, first: SUB_ISSUES_PAGE_SIZE, after: cursor };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await client.graphql(SUB_ISSUES_QUERY_TEXT, args, { cwd: repo.cwd });
    if (!result.ok) {
      if (attempt === 0) continue;
      return failureOf(result);
    }
    const payload = parseGraphql(result.stdout);
    const repository = payload?.data?.repository as Record<string, unknown> | null | undefined;
    const node = repository?.issue as Record<string, unknown> | null | undefined;
    const cell = node?.subIssues as { totalCount?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown } | undefined;
    if (!cell || typeof cell.totalCount !== "number") {
      if (attempt === 0) continue;
      return { ok: false, kind: "parse", message: "子票回包缺少 totalCount", raw: result.stdout.slice(0, 800) };
    }
    return {
      ok: true,
      data: {
        items: normalizeIssueList({ nodes: cell.nodes }, "issue"),
        total: cell.totalCount,
        hasNext: cell.pageInfo?.hasNextPage === true,
        cursor: asString(cell.pageInfo?.endCursor),
      },
    };
  }
  return { ok: false, kind: "network", message: "子票分页读取失败", raw: "" };
}

const SUB_ISSUES_QUERY_TEXT = `query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      subIssues(first:$first, after:$after){
        totalCount pageInfo{hasNextPage endCursor}
        nodes{number title state url createdAt updatedAt labels(first:20){nodes{name color}} assignees(first:20){nodes{login}} blockedBy(first:50){nodes{number title state}}}
      }
    }
  }
}`;

export interface CountsData {
  open: number;
  closed: number;
  total: number;
}

/** 计数：只认 GraphQL 的 totalCount；state 收窄时另一格按 0 记，没有 REST 回落。 */
export async function countIssues(client: GhClient, repo: RepoRef, options: { state?: IssueStateFilter; labels?: readonly string[] } = {}): Promise<ReadResult<CountsData>> {
  const bad = validateRepoRef(repo);
  if (bad) return bad;
  const labels = (options.labels ?? []).map((label) => label.trim()).filter(Boolean);
  const query = countsQuery({ withLabels: labels.length > 0 });
  const variables: Record<string, string | number | readonly string[]> = { owner: repo.owner, name: repo.name };
  // labels 是 [String!]：必须用 `-f labels[]=x` 形式，client.graphql 负责展开。
  if (labels.length) variables.labels = labels;
  const result = await client.graphql(query, variables, { cwd: repo.cwd });
  if (!result.ok) return failureOf(result);
  const payload = parseGraphql(result.stdout);
  const repository = payload?.data?.repository as Record<string, unknown> | null | undefined;
  const openCell = repository?.openIssues as { totalCount?: unknown } | undefined;
  const closedCell = repository?.closedIssues as { totalCount?: unknown } | undefined;
  if (typeof openCell?.totalCount !== "number" || typeof closedCell?.totalCount !== "number") {
    return { ok: false, kind: "parse", message: "计数回包缺少 totalCount", raw: result.stdout.slice(0, 800) };
  }
  const open = options.state === "closed" ? 0 : openCell.totalCount;
  const closed = options.state === "open" ? 0 : closedCell.totalCount;
  return { ok: true, data: { open, closed, total: open + closed } };
}

export { DEPS_MAX };
