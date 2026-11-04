import { parseDerivedFrom } from "../../../shared/derived.ts";
import type { BlockerRef, ItemKind, Readiness } from "../../../shared/issues.ts";
import { readinessOf } from "../readiness.ts";

/**
 * GraphQL / REST 回包 → 领域对象（按 DSH normalize.ts 的不变量移植）。
 *
 * 不变量：
 * - 票号只认正整数；null / 0 / 空串不许变成「#0」。
 * - 缺标题时给 `#<号>`，不编造正文。
 * - MERGED 与 CLOSED 都映射成 CLOSED，靠 `merged` 区分。
 * - 依赖边接受 GraphQL 连接与 REST 数组两种形状。
 * - PR 判定看四个信号：显式布尔、`pull_request` 标记、`__typename`、`mergedAt`/`reviews` 键。
 */

export interface Label {
  name: string;
  color: string;
}

/** 评审快照：只装结论与评审人；REST 的 submitted_at 也收。 */
export interface Review {
  state: string;
  reviewer?: { login: string };
  submittedAt?: string;
}

export interface NormalizedIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: Label[];
  assignees: string[];
  isMap: boolean;
  kind: ItemKind;
  merged: boolean;
  blockedBy: BlockerRef[];
  readiness: Readiness;
  author?: string;
  milestone?: string;
  body?: string;
  /** 远端这张票的标签总数：大于 labels.length 时禁止「整体替换」。 */
  labelCount?: number;
  isPullRequest?: boolean;
  /** PR 专用：合并时间；未合并且来源没给时为 null。 */
  mergedAt?: string | null;
  /** PR 专用：评审快照；来源没有内容时给空数组。 */
  reviews?: Review[];
}

export const MAP_LABEL = "wayfinder:map";

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asPositiveInt(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function asArray<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/** 连接与数组两种形状都接受：GraphQL 回 `{nodes}`，REST 回 `[]`（如 `blocked_by`）。 */
export function edgeNodesOf(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const nodes = (value as { nodes?: unknown }).nodes;
    if (Array.isArray(nodes)) return nodes as Record<string, unknown>[];
  }
  return [];
}

export function mapLabelNodes(value: unknown): Label[] {
  return edgeNodesOf(value).flatMap((node) => {
    const name = asString(node.name);
    if (!name) return [];
    return [{ name, color: asString(node.color, "cccccc") || "cccccc" }];
  });
}

export function mapAssigneeNodes(value: unknown): string[] {
  return edgeNodesOf(value)
    .map((node) => asString((node as { login?: unknown }).login))
    .filter(Boolean);
}

/** 阻塞引用：边只连 issue，PR 不参与依赖关系，所以 kind 固定 issue。 */
export function mapBlockerNodes(value: unknown): BlockerRef[] {
  return edgeNodesOf(value).flatMap((node) => {
    const number = asPositiveInt(node.number);
    if (number === null) return [];
    return [
      {
        number,
        title: asString(node.title, `#${number}`),
        state: node.state === "CLOSED" ? ("CLOSED" as const) : ("OPEN" as const),
        kind: "issue" as const,
      },
    ];
  });
}

export function pullStateOf(state: unknown): "OPEN" | "CLOSED" {
  // REST 给小写 closed/merged，GraphQL 给大写；两路都收，否则 REST 回落的已关闭票会被说成打开。
  const value = typeof state === "string" ? state.toLowerCase() : "";
  return value === "closed" || value === "merged" ? "CLOSED" : "OPEN";
}

function reviewNodesOf(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const reviews = (value as { reviews?: unknown }).reviews;
    if (Array.isArray(reviews)) return reviews as Record<string, unknown>[];
    if (reviews && typeof reviews === "object" && Array.isArray((reviews as { nodes?: unknown }).nodes)) {
      return (reviews as { nodes: Record<string, unknown>[] }).nodes;
    }
  }
  return [];
}

/** 评审归一：GraphQL `reviews.nodes` 与 REST `reviews[]` 都认；缺评审人/时间就省略，不编造。 */
export function normalizeReviews(value: unknown): Review[] {
  return reviewNodesOf(value).flatMap((node) => {
    const state = asString(node.state);
    if (!state) return [];
    const actor = [node.reviewer, node.author, node.user]
      .map((entry) => (entry && typeof entry === "object" ? asString((entry as { login?: unknown }).login) : ""))
      .find(Boolean);
    const submittedAt = asString(node.submittedAt) || asString(node.submitted_at);
    return [
      {
        state,
        ...(actor ? { reviewer: { login: actor } } : {}),
        ...(submittedAt ? { submittedAt } : {}),
      },
    ];
  });
}

/** PR 判定：四个信号命中任意一个。`reviews` 与 `mergedAt` 键存在即算（值可以为 null）。 */
export function deriveIsPullRequest(raw: Record<string, unknown>, kindHint?: ItemKind): boolean {
  if (kindHint === "pull-request") return true;
  if (kindHint === "issue") return false;
  if (raw.isPullRequest === true) return true;
  if (raw.pull_request !== undefined && raw.pull_request !== null) return true;
  if (raw.__typename === "PullRequest") return true;
  if (Object.prototype.hasOwnProperty.call(raw, "mergedAt")) return true;
  if (Object.prototype.hasOwnProperty.call(raw, "reviews")) return true;
  return false;
}

export interface NormalizeOptions {
  kindHint?: ItemKind;
  /** 是否需要把正文带上（详情 / 建票读回）。 */
  withBody?: boolean;
}

/** 归一化一张票；缺票号返回 null（调用方按「这一行不可用」处理，不补假数据）。 */
export function normalizeIssue(raw: unknown, options: NormalizeOptions = {}): NormalizedIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const node = raw as Record<string, unknown>;
  const number = asPositiveInt(node.number);
  if (number === null) return null;
  const kind: ItemKind = deriveIsPullRequest(node, options.kindHint) ? "pull-request" : "issue";
  const labels = mapLabelNodes(node.labels);
  const assignees = mapAssigneeNodes(node.assignees);
  const blockedBy = mapBlockerNodes(node.blockedBy ?? node.blocked_by);
  const mergedAtText = asString(node.mergedAt) || asString(node.merged_at);
  const mergedAt = mergedAtText || null;
  const merged = mergedAt !== null || node.state === "MERGED" || node.merged === true;
  const state = pullStateOf(node.state) === "CLOSED" || merged ? ("CLOSED" as const) : ("OPEN" as const);
  const base = {
    number,
    title: asString(node.title, `#${number}`),
    state,
    // `html_url` 优先：REST 回包里的 `url` 是 `api.github.com/...` 的接口地址，
    // 拿它当「打开远端」的链接会把人带到一段 JSON。GraphQL 只有 `url`，那边本身就是网页地址。
    url: asString(node.html_url) || asString(node.url),
    createdAt: asString(node.createdAt) || asString(node.created_at) || asString(node.updatedAt),
    updatedAt: asString(node.updatedAt) || asString(node.updated_at),
    labels,
    assignees,
    isMap: labels.some((label) => label.name === MAP_LABEL),
    kind,
    merged,
    blockedBy,
    readiness: "ready" as Readiness,
  };
  const withReadiness = { ...base, readiness: readinessOf(base) };
  const author = asString((node.author as { login?: unknown } | undefined)?.login) || asString((node.user as { login?: unknown } | undefined)?.login);
  const milestone = asString((node.milestone as { title?: unknown } | undefined)?.title);
  const labelCount = typeof (node.labels as { totalCount?: unknown } | undefined)?.totalCount === "number"
    ? (node.labels as { totalCount: number }).totalCount
    : undefined;
  return {
    ...withReadiness,
    ...(author ? { author } : {}),
    ...(milestone ? { milestone } : {}),
    ...(labelCount !== undefined ? { labelCount } : {}),
    isPullRequest: kind === "pull-request",
    // PR 三字段与 DSH 同口径：来源没有内容时也给空值，不省略（界面不必区分「没有」与「没查」）。
    ...(kind === "pull-request" ? { mergedAt, reviews: normalizeReviews(node) } : {}),
    ...(options.withBody ? { body: asString(node.body) } : {}),
    // 引用边只从正文里读：没读正文就不给这一位，别把「没读」写成「没有」。
    ...(options.withBody ? { derivedFrom: parseDerivedFrom(asString(node.body)) } : {}),
  };
}

export function normalizeIssueList(value: unknown, kindHint?: ItemKind): NormalizedIssue[] {
  return edgeNodesOf(value).flatMap((node) => {
    const mapped = normalizeIssue(node, { kindHint });
    return mapped ? [mapped] : [];
  });
}

export interface DependencyEdges {
  blockedBy: NormalizedIssue[];
  blocking: NormalizedIssue[];
  blockedByTruncated: boolean;
  blockingTruncated: boolean;
}

export function normalizeDependencyEdges(raw: unknown): DependencyEdges {
  const node = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const blockedByCell = node.blockedBy as { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | undefined;
  const blockingCell = node.blocking as { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | undefined;
  const blockedBy = normalizeIssueList(blockedByCell, "issue");
  const blocking = normalizeIssueList(blockingCell, "issue");
  return {
    blockedBy,
    blocking,
    blockedByTruncated: blockedByCell?.pageInfo?.hasNextPage === true || blockedBy.length >= DEPS_LIMIT,
    blockingTruncated: blockingCell?.pageInfo?.hasNextPage === true || blocking.length >= DEPS_LIMIT,
  };
}

const DEPS_LIMIT = 50;
