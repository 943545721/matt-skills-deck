import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BlockerRef, ItemKind, ListView, Readiness } from "../../shared/issues.ts";
import { parseDerivedFrom } from "../../shared/derived.ts";
import { classifyGhError, type GhFailureReason } from "./gh-error.ts";
import { readinessOf } from "./readiness.ts";
import { containerKindOf } from "../../shared/container-kind.ts";

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
  /** DSH 容器身份：spec 头标记优先于 map 标签；普通票为 null。 */
  containerKind?: "map" | "spec" | null;
  kind: ItemKind;
  /** PR 专用：合并后 GraphQL 的 state 是 CLOSED（或 MERGED），靠这一位区分。 */
  merged: boolean;
  blockedBy: BlockerRef[];
  readiness: Readiness;
  /** 父子边：读得到时给票号，明确没有父票给 null（GitHub 列表没有这一列，缺省）。 */
  parentKey?: string | null;
  /** 仅当列表显式要求正文时才有：`deck_issue_list` 要按票面标记判 spec、按正文匹配 query。 */
  body?: string;
  /** 正文第一行的 `Derived from: #19`；同样只在读过正文时才有。 */
  derivedFrom?: number | null;
}

const MAP_LABEL = "wayfinder:map";

/**
 * GitHub 单次 connections 请求的 `first` 硬上限。
 *
 * 超过 100 不是「截断」，是整条查询被拒绝：`Requesting 200 records on the issues
 * connection exceeds the first limit of 100 records.` 所以想取更多必须顺着
 * `endCursor` 翻页，不能把上限直接塞进 `first`。
 */
const GRAPHQL_FIRST_MAX = 100;

type ListConnectionKind = "issue" | "pull-request";

/**
 * 一个连接的列表查询。
 *
 * issues 与 pullRequests 在 GitHub 上是两个连接，共用编号空间，但各自有独立的游标，
 * 无法用同一个 `after` 一起翻页；因此按连接分别取，取完再合并成一个池子。
 * 代价是两次请求不是同一瞬间的快照，翻页时本就有这个代价，这里明说，不假装没有。
 */
function listQuery(kind: ListConnectionKind, view: ListView, includeClosed: boolean, withBody = false): string {
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
  const part =
    kind === "issue"
      ? `    issues(first:$first, after:$after, states:${issueStates}, orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes{
        number title state url updatedAt createdAt closedAt parent{number}${withBody ? " body" : ""}
        labels(first:20){nodes{name color}}
        assignees(first:20){nodes{login}}
        blockedBy(first:50){nodes{number title state}}
      }
    }`
      : `    pullRequests(first:$first, after:$after, states:${prStates}, orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes{
        number title state url updatedAt createdAt closedAt mergedAt isDraft
        labels(first:20){nodes{name color}}
        assignees(first:20){nodes{login}}
      }
    }`;
  // rateLimit 是 Query 根字段，不是 Repository 的字段；放进 repository 里会被 GitHub
  // 直接以「Field 'rateLimit' doesn't exist on type 'Repository'」拒绝整条查询。
  return `query($owner:String!,$name:String!,$first:Int!,$after:String){
  rateLimit { limit remaining resetAt }
  repository(owner:$owner,name:$name){
${part}
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
  /** 关闭时刻：时间线要靠它写出「哪一刻关的」，缺了这一列就没有这一行。 */
  closedAt?: unknown;
  mergedAt?: unknown;
  labels?: { totalCount?: unknown; nodes?: Array<{ name?: unknown; color?: unknown }> };
  assignees?: { nodes?: Array<{ login?: unknown }> };
  blockedBy?: { pageInfo?: PageInfo; nodes?: RawBlockerNode[] };
  /** 反向依赖边：这张票正在阻塞谁。 */
  blocking?: { pageInfo?: PageInfo; nodes?: RawBlockerNode[] };
  /** 父子边：查询没取时是 undefined（表示「没读这一列」），取到空是 null。 */
  parent?: { number?: unknown; title?: unknown; body?: unknown; labels?: { nodes?: { name?: unknown; color?: unknown }[] } } | null;
  /** 详情页的原生子票连接；列表查询不取这一列。 */
  subIssues?: { totalCount?: unknown; nodes?: RawIssueNode[]; pageInfo?: PageInfo } | null;
  body?: unknown;
}

interface PageInfo {
  hasNextPage?: unknown;
  endCursor?: unknown;
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
    // parent 是 null 表示「明确没有父票」；字段缺席表示这条查询没取父子列（REST 回退）。
    const parentNumber = asNumber(node.parent?.number);
    const base = {
      number,
      title: asString(node.title, `#${number}`),
      state,
      url: asString(node.url),
      updatedAt: asString(node.updatedAt),
      createdAt: asString(node.createdAt) || asString(node.updatedAt),
      closedAt: asString(node.closedAt) || null,
      labels,
      assignees,
      isMap: labels.some((label) => label.name === MAP_LABEL),
      containerKind: typeof node.body === "string" ? containerKindOf({ labels, body: node.body, isMap: labels.some((label) => label.name === MAP_LABEL) }) : (labels.some((label) => label.name === MAP_LABEL) ? "map" as const : null),
      kind,
      merged,
      blockedBy,
      ...(node.parent !== undefined ? { parentKey: parentNumber === null ? null : String(parentNumber) } : {}),
      ...(typeof node.body === "string" ? { body: node.body, derivedFrom: parseDerivedFrom(node.body) } : {}),
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
          closed_at?: unknown;
          labels?: unknown;
          assignees?: Array<{ login?: unknown }> | null;
          pull_request?: { merged_at?: unknown } | null;
          body?: unknown;
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
      closedAt: asString(record?.closed_at) || null,
      labels,
      assignees: asArray(record?.assignees)
        .map((entry) => asString(entry.login))
        .filter(Boolean),
      isMap: labels.some((label) => label.name === MAP_LABEL),
      containerKind: typeof record?.body === "string" ? containerKindOf({ labels, body: record.body, isMap: labels.some((label) => label.name === MAP_LABEL) }) : (labels.some((label) => label.name === MAP_LABEL) ? "map" as const : null),
      kind,
      merged,
      blockedBy: [] as BlockerRef[],
      ...(typeof record?.body === "string" ? { body: record.body, derivedFrom: parseDerivedFrom(record.body) } : {}),
    };
    return [{ ...base, readiness: readinessOf(base) }];
  });
}

const ISSUE_DETAIL_FIELDS = `number title state url updatedAt createdAt closedAt body
      parent{number title body labels(first:20){nodes{name color}}}
      subIssues(first:100){totalCount nodes{number title state labels(first:20){nodes{name}}}}
      labels(first:20){totalCount nodes{name color}}
      assignees(first:20){nodes{login}}
      comments(first:100){totalCount nodes{author{login} createdAt body}}
      blockedBy(first:50){pageInfo{hasNextPage} nodes{number title state}}
      blocking(first:50){pageInfo{hasNextPage} nodes{number title state}}`;

const PR_DETAIL_FIELDS = `number title state url updatedAt createdAt closedAt body mergedAt isDraft
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

export interface RelatedIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  kind: ItemKind;
  containerKind?: "map" | "spec" | null;
}

export interface ParentIssue {
  number: number;
  title: string;
  containerKind?: "map" | "spec" | null;
}

export type IssueDetailResult =
  | {
      ok: true;
      issue: Issue & { body: string };
      comments: IssueComment[];
      meta: IssueDetailMeta;
      /** 父容器（地图/规格）。没有父票时给 null；没查这一列时省略。 */
      parent?: ParentIssue | null;
      /** 原生/正文子票。只给能点过去的最小字段。 */
      children?: RelatedIssue[];
      childrenTotal?: number;
      /** 子票清单被后端截断（读到的少于总数）：此时不能把清单当成全集。 */
      childrenTruncated?: boolean;
      /** 子票清单读不回来的原因：闸门要把它原样报给调用方，不能只说「没给父子信息」。 */
      childrenProblem?: string;
      /** 反向依赖：这张票正在阻塞谁，以及这一列是否可能被截断。 */
      blocking?: BlockerRef[];
      blockingTruncated?: boolean;
    }
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
    const blocking = kind === "issue" ? mapBlockers(node.blocking?.nodes) : [];
    const blockingTruncated =
      kind === "issue" &&
      typeof node.blocking?.pageInfo?.hasNextPage === "boolean" &&
      node.blocking.pageInfo.hasNextPage;
    const parent = node.parent === undefined
      ? undefined
      : node.parent === null
        ? null
        : (() => {
            const parentNumber = asNumber(node.parent?.number);
            if (parentNumber === null) return null;
            const parentLabels = (node.parent?.labels?.nodes ?? []).flatMap((label) => {
              const name = asString(label.name);
              return name ? [{ name, color: asString(label.color) }] : [];
            });
            const parentBody = asString(node.parent?.body);
            const containerKind = parentBody || parentLabels.length
              ? containerKindOf({
                  labels: parentLabels.map((label) => label.name),
                  body: parentBody,
                  isMap: parentLabels.some((label) => label.name === MAP_LABEL),
                })
              : null;
            return {
              number: parentNumber,
              title: asString(node.parent?.title, `#${parentNumber}`),
              ...(containerKind ? { containerKind } : {}),
            };
          })();
    const children = kind === "issue" && node.subIssues?.nodes !== undefined
      ? node.subIssues.nodes.flatMap((child) => {
          const childNumber = asNumber(child.number);
          if (childNumber === null) return [];
          const state = asString(child.state) === "CLOSED" ? ("CLOSED" as const) : ("OPEN" as const);
          return [{
            number: childNumber,
            title: asString(child.title, `#${childNumber}`),
            state,
            kind: "issue" as const,
            containerKind: child.labels?.nodes?.some((label) => asString(label.name) === MAP_LABEL) ? ("map" as const) : null,
          }];
        })
      : undefined;
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
      ...(parent === undefined ? {} : { parent }),
      ...(children === undefined
        ? {}
        : (() => {
            const total = typeof node.subIssues?.totalCount === "number" ? node.subIssues.totalCount : children.length;
            return { children, childrenTotal: total, childrenTruncated: total > children.length };
          })()),
      ...(kind === "issue" ? { blocking, blockingTruncated } : {}),
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
  /** 列表行要不要带正文：任务板界面不需要，`deck_issue_list` 判 spec / 匹配 query 需要。 */
  withBody?: boolean;
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
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const view = options.view ?? (options.includeClosed ? "all" : "open");
  const includeClosed = options.includeClosed === true;
  const withBody = options.withBody === true;

  const issues = await listConnection(owner, name, "issue", view, includeClosed, withBody, limit);
  if (!issues.ok) {
    if (issues.rateLimited) return listIssuesRest(owner, name, limit);
    return { ok: false, reason: issues.reason, detail: issues.detail };
  }
  const pulls = await listConnection(owner, name, "pull-request", view, includeClosed, withBody, limit);
  if (!pulls.ok) {
    if (pulls.rateLimited) return listIssuesRest(owner, name, limit);
    return { ok: false, reason: pulls.reason, detail: pulls.detail };
  }
  return {
    ok: true,
    issues: [...issues.items, ...pulls.items],
    totalCount: issues.totalCount + pulls.totalCount,
    hasMore: issues.hasMore || pulls.hasMore,
    fetchedAt: new Date().toISOString(),
    source: "graphql",
    rateLimit: issues.rateLimit ?? pulls.rateLimit,
  };
}

type ConnectionOutcome =
  | { ok: true; items: Issue[]; totalCount: number; hasMore: boolean; rateLimit: RateLimit | null }
  | { ok: false; rateLimited: boolean; reason: ReadFailureReason; detail: string };

/**
 * 取一个连接，最多 `limit` 条。
 *
 * 每页最多要 100 条（GitHub 硬上限），不够就顺着 `endCursor` 继续，直到够数、
 * 没有下一页或游标不再前进。限流单独标出来，交给调用方决定是否换 REST。
 */
async function listConnection(
  owner: string,
  name: string,
  kind: ListConnectionKind,
  view: ListView,
  includeClosed: boolean,
  withBody: boolean,
  limit: number,
): Promise<ConnectionOutcome> {
  const items: Issue[] = [];
  let totalCount = 0;
  let hasMore = false;
  let rateLimit: RateLimit | null = null;
  let after: string | null = null;
  const seenCursors = new Set<string>();

  while (items.length < limit) {
    const want = Math.min(limit - items.length, GRAPHQL_FIRST_MAX);
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${listQuery(kind, view, includeClosed, withBody)}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `first=${want}`,
    ];
    if (after !== null) args.push("-f", `after=${after}`);

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("gh", args, { timeout: 20_000, maxBuffer: 8 << 20 }));
    } catch (error) {
      const failure = classifyGhError(error, "刷新");
      const stderr = (error as { stderr?: unknown }).stderr;
      // 只有明确是限流才换路；网络/权限失败换 REST 只会得到同一个错误。
      return { ok: false, rateLimited: typeof stderr === "string" && RATE_LIMIT_HINT.test(stderr), ...failure };
    }

    const payload = parseListPayload(stdout);
    if (!payload) return { ok: false, rateLimited: false, reason: "gh-failed", detail: "列表回包不是合法 JSON" };
    const repository = payload.data?.repository;
    if (!repository) {
      const message = payload.errors?.map((error) => asString(error.message)).filter(Boolean).join("；") ?? "";
      // 限流不是「仓库拒绝」：GraphQL 额度用完时 REST 还有一套独立额度，先换路。
      if (RATE_LIMIT_HINT.test(message)) return { ok: false, rateLimited: true, reason: "gh-failed", detail: message };
      return {
        ok: false,
        rateLimited: false,
        reason: "gh-failed",
        detail: message || "仓库没有返回票面数据，检查登录账号是否有该仓库的读权限",
      };
    }

    const cell = kind === "issue" ? repository.issues : repository.pullRequests;
    items.push(...mapIssueNodes(cell?.nodes, kind));
    totalCount = typeof cell?.totalCount === "number" ? cell.totalCount : items.length;
    rateLimit = parseRateLimit(payload.data?.rateLimit) ?? rateLimit;
    hasMore = cell?.pageInfo?.hasNextPage === true;
    const next: string | null = typeof cell?.pageInfo?.endCursor === "string" ? cell.pageInfo.endCursor : null;
    // 没有下一页，或游标原地踏步（回包异常）：停下并把 hasMore 如实留在数据里。
    if (!hasMore || next === null || seenCursors.has(next)) break;
    seenCursors.add(next);
    after = next;
  }

  return { ok: true, items, totalCount, hasMore, rateLimit };
}

interface ListPayload {
  data?: { rateLimit?: unknown; repository?: { issues?: RawIssueConnection; pullRequests?: RawIssueConnection } };
  errors?: Array<{ message?: unknown }>;
}

function parseListPayload(stdout: string): ListPayload | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? (parsed as ListPayload) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DSH 全量移植面（server/tracker/github/*）。
//
// 上面保留的是 Paseo 现有读路径的兼容实现（read.ts / tools.ts / 现有测试都依赖它的
// `listIssues` / `getIssue` 形状）；下面是新增的 25+ 项操作与底层能力。两者共用同一个
// gh 凭据来源（用户自己的 gh），都走 execFile 参数数组，不接触 token。
// 命名冲突的旧名字（RateLimit / Issue / getIssue / listIssues）保持原样不动；
// 新面通过显式别名或 `github` 命名空间导出，避免破坏调用方。
// ---------------------------------------------------------------------------
export * as github from "./github/index.ts";

export {
  createGhClient,
  defaultGhExec,
  timeoutForGhArgs,
  isWriteGhArgs,
  isProbeGhArgs,
  isGraphqlGhArgs,
  normalizeGhStringFields,
  type GhClient,
  type GhExec,
  type GhResult,
  type GhError,
  type GhErrorKind,
  type GhBudgetStats,
  type GhRateSnapshot,
} from "./github/index.ts";

export {
  createGithubOperations,
  GITHUB_OPERATION_NAMES,
  type GithubOperations,
} from "./github/index.ts";

export {
  pickFallbackReason,
  isGheHostName,
  readGhHost,
  type FallbackReason,
} from "./github/index.ts";

export {
  listIssuesPage,
  getIssueDetail,
  listSubIssues,
  getDependencies,
  countIssues,
  readBlockedBy,
  listIssuesConditional,
  createEtagStore,
  parseHttpResponse,
  type RepoRef,
  type ListPageInput,
  type ListPageData,
  type DetailData,
  type DetailOptions,
  type SubIssuesData,
  type DependencyData,
  type CountsData,
  type ConditionalListData,
} from "./github/index.ts";

export {
  ghPreflight,
  resolveRepoKey,
  parseGithubRepo,
  readGithubBudget,
  parseRateLimit as parseGithubRateLimit,
  readRepoPermissions,
  readViewerPermission,
  createPermissionCache,
  readonlyMessage,
  listLabels,
  setLabelColors,
  validateChanges,
  normalizeColor,
  withAnchor,
  anchorLineFor,
  idempotencyKeyOf,
  lookupByAnchor,
  initProject,
  type PreflightOptions,
  type PreflightResult,
  type RepoIdentity,
  type RepoPermissions,
  type BudgetBuckets,
  type BudgetRead,
  type LabelInfo,
  type LabelColorChange,
  type InitProjectInput,
  type InitProjectData,
} from "./github/index.ts";

export {
  createIssue as createGithubIssue,
  updateIssue as updateGithubIssue,
  setIssueState as setGithubIssueState,
  addComment as addGithubComment,
  setLabels as setGithubLabels,
  addLabel as addGithubLabel,
  setAssignees as setGithubAssignees,
  setParent as setGithubParent,
  setBlockedBy as setGithubBlockedBy,
  reportIssue as reportGithubIssue,
  type CreateIssueInput,
  type CreateIssueData,
  type LabelInput,
  type AssigneeInput,
  type UpdateIssueInput,
  type IssueSnapshot,
  type CommentData,
  type LabelData,
  type ReportInput,
  type WriteFailure,
  type WriteResult,
  type GraphWriteData,
  type ParentData,
} from "./github/index.ts";

async function listIssuesRest(owner: string, name: string, limit: number): Promise<ListIssuesResult> {
  // REST 的 per_page 上限同样是 100：传 200 不会报错，只会静默返回 100 条。
  const perPage = Math.min(limit, GRAPHQL_FIRST_MAX);
  const path = `repos/${owner}/${name}/issues?state=all&sort=updated&direction=desc&per_page=${perPage}`;
  try {
    const { stdout } = await execFileAsync("gh", ["api", path], { timeout: 20_000, maxBuffer: 8 << 20 });
    const parsed: unknown = JSON.parse(stdout);
    const issues = mapRestIssues(parsed);
    return {
      ok: true,
      issues,
      totalCount: issues.length,
      hasMore: issues.length >= perPage,
      fetchedAt: new Date().toISOString(),
      source: "rest",
      rateLimit: null,
    };
  } catch (error) {
    return { ok: false, ...classifyGhError(error, "刷新") };
  }
}
