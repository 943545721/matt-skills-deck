import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyGhError, type GhFailureReason } from "./gh-error.ts";

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
  labels: IssueLabel[];
  assignees: string[];
  /** 地图票：源仓库用 `wayfinder:map` 标签标记一张地图，列表要把它排在最前面。 */
  isMap: boolean;
}

const MAP_LABEL = "wayfinder:map";

function listQuery(state?: "OPEN" | "CLOSED"): string {
  const states = state ? `, states: [${state}]` : "";
  return `query($owner:String!,$name:String!,$first:Int!){
  repository(owner:$owner,name:$name){
    issues(first:$first${states}, orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo { hasNextPage }
      nodes{
        number title state url updatedAt
        labels(first:20){nodes{name color}}
        assignees(first:5){nodes{login}}
      }
    }
  }
}`;
}

interface RawIssueNode {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  labels?: { totalCount?: unknown; nodes?: Array<{ name?: unknown; color?: unknown }> };
  assignees?: { nodes?: Array<{ login?: unknown }> };
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

/**
 * GraphQL 结果 → 领域对象。
 *
 * 单独抽出来是为了能用固定样本测：真实接口的形状比文档写的更容易变（缺字段、null、颜色为空），
 * 映射层必须能扛住这些而不是让界面在某个字段上崩掉。
 */
export function mapIssueNodes(nodes: readonly RawIssueNode[] | undefined): Issue[] {
  const list: readonly RawIssueNode[] = Array.isArray(nodes) ? nodes : [];
  return list.flatMap((node) => {
    // 只认 number 或非空字符串：GraphQL 返回 null 时 Number(null) 会得到 0，
    // 那样会凭空造出一张「#0」的票，比丢掉这条更糟。
    const raw = node.number;
    const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
    if (!Number.isFinite(number)) return [];
    const labels = asArray(node.labels?.nodes).flatMap((label) => {
      const name = asString(label.name);
      if (!name) return [];
      return [{ name, color: asString(label.color, "cccccc") }];
    });
    return [
      {
        number,
        title: asString(node.title, `#${number}`),
        state: node.state === "CLOSED" ? "CLOSED" : "OPEN",
        url: asString(node.url),
        updatedAt: asString(node.updatedAt),
        labels,
        assignees: asArray(node.assignees?.nodes)
          .map((item) => asString(item.login))
          .filter(Boolean),
        isMap: labels.some((label) => label.name === MAP_LABEL),
      },
    ];
  });
}

const DETAIL_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      number title state url updatedAt body
      labels(first:20){totalCount nodes{name color}}
      assignees(first:5){nodes{login}}
      comments(first:100){totalCount nodes{author{login} createdAt body}}
    }
  }
}`;

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

export type IssueDetailResult =
  | { ok: true; issue: Issue & { body: string }; comments: IssueComment[]; meta: IssueDetailMeta }
  | { ok: false; reason: "not-found" | GhFailureReason; detail: string };

/**
 * 读单张票的正文与评论。
 *
 * 正文直出 Markdown 原文，不在服务端渲染：客户端已经有 <Markdown> 组件，
 * 在服务端转 HTML 只会多一层没人维护的转换器。
 */
export async function getIssue(owner: string, name: string, number: number): Promise<IssueDetailResult> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${DETAIL_QUERY}`,
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
          };
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };
    const node = payload.data?.repository?.issue;
    if (!node) {
      const message = payload.errors?.map((error) => asString(error.message)).filter(Boolean).join("；");
      return {
        ok: false,
        reason: "not-found",
        detail: message || `仓库里找不到 #${number}`,
      };
    }
    const [mapped] = mapIssueNodes([node]);
    if (!mapped) {
      return { ok: false, reason: "gh-failed", detail: `#${number} 的数据缺少编号` };
    }
    const comments = mapCommentNodes(node.comments?.nodes);
    const labelCount = typeof node.labels?.totalCount === "number" ? node.labels.totalCount : mapped.labels.length;
    const commentCount = typeof node.comments?.totalCount === "number" ? node.comments.totalCount : comments.length;
    return {
      ok: true,
      issue: { ...mapped, body: asString(node.body) },
      comments,
      meta: {
        labelCount,
        labelsTruncated: labelCount > mapped.labels.length,
        commentCount,
        commentsTruncated: commentCount > comments.length,
      },
    };
  } catch (error) {
    return { ok: false, ...classifyGhError(error, "刷新") };
  }
}

export type ListIssuesResult =
  | { ok: true; issues: Issue[]; totalCount: number; hasMore: boolean; fetchedAt: string }
  | { ok: false; reason: GhFailureReason; detail: string };

/**
 * 用 gh 命令读仓库的 issue 列表。
 *
 * 走 `gh api graphql` 而不是直接打 HTTP：凭据由用户已经登录的 gh 管，插件不接触 token，
 * 这是源仓库同样的取舍——插件不该成为第二个存放凭据的地方。
 */
export async function listIssues(
  owner: string,
  name: string,
  limit = 100,
  state?: "OPEN" | "CLOSED",
): Promise<ListIssuesResult> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${listQuery(state)}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `first=${Math.min(Math.max(limit, 1), 100)}`,
  ];
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: 20_000, maxBuffer: 8 << 20 });
    const payload = JSON.parse(stdout) as {
      data?: { repository?: { issues?: RawIssueConnection } };
      errors?: Array<{ message?: string }>;
    };
    const issuesNode = payload.data?.repository?.issues;
    if (!issuesNode) {
      const message = payload.errors?.map((error) => asString(error.message)).filter(Boolean).join("；");
      return { ok: false, reason: "gh-failed", detail: message || "仓库没有返回 issue 数据，检查登录账号是否有该仓库的读权限" };
    }
    return {
      ok: true,
      issues: mapIssueNodes(issuesNode.nodes),
      totalCount: typeof issuesNode.totalCount === "number" ? issuesNode.totalCount : 0,
      hasMore: issuesNode.pageInfo?.hasNextPage === true,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { ok: false, ...classifyGhError(error, "刷新") };
  }
}
