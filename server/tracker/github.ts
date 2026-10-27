import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BlockerRef, ItemKind, ListView, Readiness } from "../../shared/issues.ts";
import { classifyGhError, type GhFailureReason } from "./gh-error.ts";
import { readinessOf } from "./readiness.ts";

const execFileAsync = promisify(execFile);

export interface IssueLabel {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  url: string;
  updatedAt: string;
  createdAt: string;
  labels: IssueLabel[];
  assignees: string[];
  /** 地图票：源仓库用 `wayfinder:map` 标签标记一张地图，列表要把它排在最前面。 */
  isMap: boolean;
  kind: ItemKind;
  /** PR 专用：合并后 GraphQL 的 state 是 CLOSED（或 MERGED），靠这一位区分。 */
  merged: boolean;
  blockedBy: BlockerRef[];
  readiness: Readiness;
}

const MAP_LABEL = "wayfinder:map";

/**
 * 列表查询一次取两个连接。
 *
 * issues 与 pullRequests 在 GitHub 上是两个连接，但共用编号空间，界面上又必须能
 * 「PR 和票放同一个池里排」；分两次请求会得到两个时刻的快照，计数与排序就可能自相矛盾。
 */
function listQuery(view: ListView, includeClosed: boolean): string {
  const all = view === "all" || (view !== "closed" && view !== "merged" && includeClosed);
  const issueStates =
    view === "closed" ? "[CLOSED]" : all ? "[OPEN,CLOSED]" : "[OPEN]";
  const prStates =
    view === "merged"
      ? "[MERGED]"
      : view === "closed"
        ? "[CLOSED,MERGED]"
        : all
          ? "[OPEN,CLOSED,MERGED]"
          : "[OPEN]";
  return `query($owner:String!,$name:String!,$first:Int!){
  repository(owner:$owner,name:$name){
    issues(first:$first, states:${issueStates}, orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo { hasNextPage }
      nodes{
        number title state url updatedAt createdAt
        labels(first:20){nodes{name color}}
        assignees(first:20){nodes{login}}
        blockedBy(first:50){nodes{number title state}}
      }
    }
    pullRequests(first:$first, states:${prStates}, orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo { hasNextPage }
      nodes{
        number title state url updatedAt createdAt mergedAt isDraft
        labels(first:20){nodes{name color}}
        assignees(first:20){nodes{login}}
      }
    }
    rateLimit { limit remaining resetAt }
  }
}`;
}

interface RawBlockerNode {
  number?: unknown;
  title?: unknown;
  state?: unknown;
}

interface RawIssueNode {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  mergedAt?: unknown;
  labels?: { totalCount?: unknown; nodes?: Array<{ name?: unknown; color?: unknown }> };
  assignees?: { nodes?: Array<{ login?: unknown }> };
  blockedBy?: { nodes?: RawBlockerNode[] };
}

interface PageInfo {
  hasNextPage?: unknown;
}

interface RawIssueConnection {
  totalCount?: unknown;
  pageInfo?: PageInfo;
  nodes?: RawIssueNode[];
}

const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

/** `x ?? []` 在联合数组类型上会让回调参数退化成 any，所以统一走这个窄化函数。 */
function asArray<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function mapBlockers(nodes: readonly RawBlockerNode[] | undefined): BlockerRef[] {
  return asArray(nodes).flatMap((node) => {
    const number = asNumber(node.number);
    if (number === null) return [];
    return [
      {
        number,
        title: asString(node.title, `#${number}`),
        state: node.state === "CLOSED" ? ("CLOSED" as const) : ("OPEN" as const),
        // 阻塞边在 GitHub 上只连 issue（PR 不参与依赖关系），所以这里固定 issue。
        kind: "issue" as const,
      },
    ];
  });
}

function asNumber(value: unknown): number | null {
  // 只认 number 或非空字符串：GraphQL 返回 null 时 Number(null) 会得到 0，
  // 那样会凭空造出一张「#0」的票，比丢掉这条更糟。
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * GraphQL 结果 → 领域对象。
 *
 * 单独抽出来是为了能用固定样本测：真实接口的形状比文档写的更容易变（缺字段、null、颜色为空），
 * 映射层必须能扛住这些而不是让界面在某个字段上崩掉。
 */
export function mapIssueNodes(nodes: readonly RawIssueNode[] | undefined, kind: ItemKind = "issue"): Issue[] {
  const list: readonly RawIssueNode[] = Array.isArray(nodes) ? nodes : [];
  return list.flatMap((node) => {
    const number = asNumber(node.number);
    if (number === null) return [];
    const labels = asArray(node.labels?.nodes).flatMap((label) => {
      const name = asString(label.name);
      if (!name) return [];
      return [{ name, color: asString(label.color, "cccccc") }];
    });
    const merged = typeof node.mergedAt === "string" && node.mergedAt.length > 0;
    const state = node.state === "CLOSED" || node.state === "MERGED" ? ("CLOSED" as const) : ("OPEN" as const);
    const assignees = asArray(node.assignees?.nodes)
      .map((item) => asString(item.login))
      .filter(Boolean);
    const blockedBy = mapBlockers(node.blockedBy?.nodes);
    const base = {
      number,
      title: asString(node.title, `#${number}`),
      state,
      url: asString(node.url),
      updatedAt: asString(node.updatedAt),
      createdAt: asString(node.createdAt) || asString(node.updatedAt),
      labels,
      assignees,
      isMap: labels.some((label) => label.name === MAP_LABEL),
      kind,
      merged,
      blockedBy,
    };
    return [{ ...base, readiness: readinessOf(base) }];
  });
}

/** 直接依赖的 label 形状，供 REST 映射复用。 */
function mapRestLabels(value: unknown): IssueLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = item as { name?: unknown; color?: unknown } | null;
    const name = asString(record?.name);
    if (!name) return [];
    return [{ name, color: asString(record?.color, "cccccc") || "cccccc" }];
  });
}

/**
 * REST 回退的映射。
 *
 * REST 的 `/issues` 会把 PR 一起返回（带 `pull_request` 字段），正好满足「同池」；
 * 代价是拿不到 blockedBy，所以这些票在本次视图里只能按「无阻塞」处理，
 * 响应里的 `source: "rest"` 就是在提醒界面别把 ready 当成完整结论。
 */
export function mapRestIssues(raw: unknown): Issue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const record = item as
      | {
          number?: unknown;
          title?: unknown;
          state?: unknown;
          html_url?: unknown;
          updated_at?: unknown;
          created_at?: unknown;
          labels?: unknown;
          assignees?: Array<{ login?: unknown }> | null;
          pull_request?: { merged_at?: unknown } | null;
        }
      | null;
    const number = asNumber(record?.number);
    if (number === null) return [];
    const labels = mapRestLabels(record?.labels);
    const kind: ItemKind = record?.pull_request ? "pull-request" : "issue";
    const merged = typeof record?.pull_request?.merged_at === "string";
    const base = {
      number,
      title: asString(record?.title, `#${number}`),
      state: record?.state === "closed" ? ("CLOSED" as const) : ("OPEN" as const),
      url: asString(record?.html_url),
      updatedAt: asString(record?.updated_at),
      createdAt: asString(record?.created_at) || asString(record?.updated_at),
      labels,
      assignees: asArray(record?.assignees)
        .map((entry) => asString(entry.login))
        .filter(Boolean),
      isMap: labels.some((label) => label.name === MAP_LABEL),
      kind,
      merged,
      blockedBy: [] as BlockerRef[],
    };
    return [{ ...base, readiness: readinessOf(base) }];
  });
}

const ISSUE_DETAIL_FIELDS = `number title state url updatedAt createdAt body
      labels(first:20){totalCount nodes{name color}}
      assignees(first:20){nodes{login}}
      comments(first:100){totalCount nodes{author{login} createdAt body}}
      blockedBy(first:50){pageInfo{hasNextPage} nodes{number title state}}`;

const PR_DETAIL_FIELDS = `number title state url updatedAt createdAt body mergedAt isDraft
      labels(first:20){totalCount nodes{name color}}
      assignees(first:20){nodes{login}}
      comments(first:100){totalCount nodes{author{login} createdAt body}}`;

function detailQuery(kind: ItemKind): string {
  // 编号空间共用，issue 与 pullRequest 是两个不同的顶层字段：拿错字段会得到 null，
  // 界面就会把「这张其实是 PR」说成「找不到这张票」。
  const field = kind === "pull-request" ? `pullRequest(number:$number){${PR_DETAIL_FIELDS}}` : `issue(number:$number){${ISSUE_DETAIL_FIELDS}}`;
  return `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    ${field}
  }
}`;
}

interface RawCommentNode {
  author?: { login?: unknown } | null;
  createdAt?: unknown;
  body?: unknown;
}

export interface IssueDetailMeta {
  labelCount: number;
  labelsTruncated: boolean;
  commentCount: number;
  commentsTruncated: boolean;
  /** 阻塞边是否可能被截断（只对 issue 有意义）。 */
  blockersTruncated: boolean;
}

export interface IssueDetail {
  issue: Issue & { body: string };
  comments: IssueComment[];
  meta: IssueDetailMeta;
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

/** 详情页的评论映射，同样单独抽出来测：评论作者可能被删号（author 为 null）。 */
export function mapCommentNodes(nodes: readonly RawCommentNode[] | undefined): IssueComment[] {
  return asArray(nodes).map((node) => ({
    author: asString(node.author?.login, "ghost"),
    createdAt: asString(node.createdAt),
    body: asString(node.body),
  }));
}

/** 读路径的失败原因：GitHub 之外的后端各自有更准确的分类，不要一律压成 gh-failed。 */
export type ReadFailureReason =
  | GhFailureReason
  | "glab-missing"
  | "glab-unauth"
  | "glab-failed"
  | "local-failed"
  | "invalid"
  | "not-found";

export type IssueDetailResult =
  | { ok: true; issue: Issue & { body: string }; comments: IssueComment[]; meta: IssueDetailMeta }
  | { ok: false; reason: "not-found" | ReadFailureReason; detail: string };

/**
 * 读单张票的正文与评论。
 *
 * 正文直出 Markdown 原文，不在服务端渲染：客户端已经有 <Markdown> 组件，
 * 在服务端转 HTML 只会多一层没人维护的转换器。
 * PR 的评论在这里同样是只读的——写路径会显式拒绝 PR。
 */
export async function getIssue(
  owner: string,
  name: string,
  number: number,
  kind: ItemKind = "issue",
): Promise<IssueDetailResult> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${detailQuery(kind)}`,
    // 字符串变量走 `-f`（原样字符串）：`-F` 会按类型推断并把 `@` 当成读文件，
    // 仓库名恰好是 true / 123 或 owner 以 @ 开头时会变成看不懂的 GraphQL 类型错误。
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ];
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: 20_000, maxBuffer: 8 << 20 });
    const payload = JSON.parse(stdout) as {
      data?: {
        repository?: {
          issue?: RawIssueNode & {
            body?: unknown;
            labels?: { totalCount?: unknown; nodes?: Array<{ name?: unknown; color?: unknown }> };
            comments?: { totalCount?: unknown; nodes?: RawCommentNode[] };
            blockedBy?: { pageInfo?: PageInfo; nodes?: RawBlockerNode[] };
          };
          pullRequest?: RawIssueNode & {
            body?: unknown;
            labels?: { totalCount?: unknown; nodes?: Array<{ name?: unknown; color?: unknown }> };
            comments?: { totalCount?: unknown; nodes?: RawCommentNode[] };
            /** PR 不查这条边，但两个分支共用下面的读取逻辑，类型上留一个空位。 */
            blockedBy?: { pageInfo?: PageInfo; nodes?: RawBlockerNode[] };
          };
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };
    const node = kind === "pull-request" ? payload.data?.repository?.pullRequest : payload.data?.repository?.issue;
    if (!node) {
      const message = payload.errors?.map((error) => asString(error.message)).filter(Boolean).join("；");
      return {
        ok: false,
        reason: "not-found",
        detail: message || `仓库里找不到${kind === "pull-request" ? "这个拉取请求" : "这张票"} #${number}`,
      };
    }
    const [mapped] = mapIssueNodes([node], kind);
    if (!mapped) {
      return { ok: false, reason: "gh-failed", detail: `#${number} 的数据缺少编号` };
    }
    const comments = mapCommentNodes(node.comments?.nodes);
    const labelCount = typeof node.labels?.totalCount === "number" ? node.labels.totalCount : mapped.labels.length;
    const commentCount = typeof node.comments?.totalCount === "number" ? node.comments.totalCount : comments.length;
    const blockersTruncated =
      kind === "issue" &&
      typeof node.blockedBy?.pageInfo?.hasNextPage === "boolean" &&
      node.blockedBy.pageInfo.hasNextPage;
    return {
      ok: true,
      issue: { ...mapped, body: asString(node.body) },
      comments,
      meta: {
        labelCount,
        labelsTruncated: labelCount > mapped.labels.length,
        commentCount,
        commentsTruncated: commentCount > comments.length,
        blockersTruncated,
      },
    };
  } catch (error) {
    return { ok: false, ...classifyGhError(error, "刷新") };
  }
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

export type ListIssuesResult =
  | {
      ok: true;
      issues: Issue[];
      totalCount: number;
      hasMore: boolean;
      fetchedAt: string;
      /** 数据来自哪里：GraphQL / REST 回退 / 本地 `.deck/` / GitLab。 */
      source: "graphql" | "rest" | "local" | "gitlab";
      rateLimit: RateLimit | null;
    }
  | { ok: false; reason: ReadFailureReason; detail: string };

export interface ListOptions {
  limit?: number;
  includeClosed?: boolean;
  view?: ListView;
}

const RATE_LIMIT_HINT = /rate limit|RATE_LIMITED|secondary rate/i;

function parseRateLimit(raw: unknown): RateLimit | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { limit?: unknown; remaining?: unknown; resetAt?: unknown };
  if (typeof value.limit !== "number" || typeof value.remaining !== "number") return null;
  return {
    limit: value.limit,
    remaining: value.remaining,
    resetAt: typeof value.resetAt === "string" ? value.resetAt : "",
  };
}

/**
 * 用 gh 命令读仓库的 issue 与 PR。
 *
 * 走 `gh api graphql` 而不是直接打 HTTP：凭据由用户已经登录的 gh 管，插件不接触 token，
 * 这是源仓库同样的取舍——插件不该成为第二个存放凭据的地方。
 *
 * GraphQL 被限流时回退 REST：REST 的额度是另一套计数，而且 `/issues` 天然带 PR。
 * 代价是 REST 没有 blockedBy，响应里用 `source: "rest"` 如实说明。
 */
export async function listIssues(owner: string, name: string, options: ListOptions = {}): Promise<ListIssuesResult> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const view = options.view ?? (options.includeClosed ? "all" : "open");
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${listQuery(view, options.includeClosed === true)}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `first=${limit}`,
  ];
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: 20_000, maxBuffer: 8 << 20 });
    const payload = JSON.parse(stdout) as {
      data?: {
        repository?: {
          issues?: RawIssueConnection;
          pullRequests?: RawIssueConnection;
          rateLimit?: unknown;
        };
      };
      errors?: Array<{ message?: unknown }>;
    };
    const repository = payload.data?.repository;
    if (!repository) {
      const message = payload.errors?.map((error) => asString(error.message)).filter(Boolean).join("；") ?? "";
      // 限流不是「仓库拒绝」：GraphQL 额度用完时 REST 还有一套独立额度，先换路。
      if (RATE_LIMIT_HINT.test(message)) return listIssuesRest(owner, name, limit);
      return {
        ok: false,
        reason: "gh-failed",
        detail: message || "仓库没有返回票面数据，检查登录账号是否有该仓库的读权限",
      };
    } else {
      const issues = mapIssueNodes(repository.issues?.nodes, "issue");
      const prs = mapIssueNodes(repository.pullRequests?.nodes, "pull-request");
      const issuesTotal = typeof repository.issues?.totalCount === "number" ? repository.issues.totalCount : issues.length;
      const prsTotal = typeof repository.pullRequests?.totalCount === "number" ? repository.pullRequests.totalCount : prs.length;
      return {
        ok: true,
        issues: [...issues, ...prs],
        totalCount: issuesTotal + prsTotal,
        hasMore: repository.issues?.pageInfo?.hasNextPage === true || repository.pullRequests?.pageInfo?.hasNextPage === true,
        fetchedAt: new Date().toISOString(),
        source: "graphql",
        rateLimit: parseRateLimit(repository.rateLimit),
      };
    }
  } catch (error) {
    const failure = classifyGhError(error, "刷新");
    const stderr = (error as { stderr?: unknown }).stderr;
    // 只有明确是限流才换路；网络/权限失败换 REST 只会得到同一个错误。
    if (!(typeof stderr === "string" && RATE_LIMIT_HINT.test(stderr))) return { ok: false, ...failure };
    return listIssuesRest(owner, name, limit);
  }
}

async function listIssuesRest(owner: string, name: string, limit: number): Promise<ListIssuesResult> {
  const path = `repos/${owner}/${name}/issues?state=all&sort=updated&direction=desc&per_page=${limit}`;
  try {
    const { stdout } = await execFileAsync("gh", ["api", path], { timeout: 20_000, maxBuffer: 8 << 20 });
    const parsed: unknown = JSON.parse(stdout);
    const issues = mapRestIssues(parsed);
    return {
      ok: true,
      issues,
      totalCount: issues.length,
      hasMore: issues.length >= limit,
      fetchedAt: new Date().toISOString(),
      source: "rest",
      rateLimit: null,
    };
  } catch (error) {
    return { ok: false, ...classifyGhError(error, "刷新") };
  }
}
