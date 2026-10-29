import type { GhClient } from "./client.ts";

/**
 * GitHub 额度读法（DSH budget.ts）。
 *
 * GitHub 有两套独立预算：REST 按「请求数」，GraphQL 按「点数」。只报其中一个数会误导：
 * 面板可能在 REST 还剩 4000 次时已经因为 GraphQL 点数耗尽而读不出列表。
 * 所以这里要求四个数字都在，缺一个就报「不可测」，不拿 0 冒充。
 */
export interface BudgetBucket {
  limit: number;
  remaining: number;
  resetAt?: string;
}

export interface BudgetBuckets {
  rest: BudgetBucket;
  graphql: BudgetBucket;
}

export type BudgetRead =
  | { ok: true; known: true; kind: "two-buckets"; buckets: BudgetBuckets }
  | { ok: true; known: false; reason: "not-measured" | "unavailable"; detail?: string };

interface RawBucket {
  limit?: unknown;
  remaining?: unknown;
  reset?: unknown;
}

function bucketOf(value: unknown): BudgetBucket | null {
  if (!value || typeof value !== "object") return null;
  const cell = value as RawBucket;
  if (typeof cell.limit !== "number" || !Number.isFinite(cell.limit)) return null;
  if (typeof cell.remaining !== "number" || !Number.isFinite(cell.remaining)) return null;
  const reset = typeof cell.reset === "number" && Number.isFinite(cell.reset) ? new Date(cell.reset * 1000).toISOString() : undefined;
  return { limit: cell.limit, remaining: cell.remaining, ...(reset ? { resetAt: reset } : {}) };
}

/** 解析 `gh api rate_limit` 的 JSON；四个数字缺任意一个都返回 null。 */
export function parseRateLimit(text: string): BudgetBuckets | null {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    const resources = (parsed && typeof parsed === "object" ? (parsed as { resources?: unknown }).resources : null) as
      | { core?: unknown; graphql?: unknown }
      | null
      | undefined;
    const rest = bucketOf(resources?.core);
    const graphql = bucketOf(resources?.graphql);
    if (!rest || !graphql) return null;
    return { rest, graphql };
  } catch {
    return null;
  }
}

/**
 * 读当前额度。
 *
 * 永远返回 ok 信封：额度读不到不是「操作失败」，而是「这次不知道剩多少」。
 * 没装/没登录 → not-measured（根本没测到）；回包形状不对 → unavailable（测了但看不懂）。
 */
export async function readGithubBudget(client: GhClient): Promise<BudgetRead> {
  const result = await client.rest("rate_limit", { jq: "." });
  if (!result.ok) {
    if (result.error.kind === "env" || result.error.kind === "auth") {
      return { ok: true, known: false, reason: "not-measured", detail: result.error.message };
    }
    return { ok: true, known: false, reason: "unavailable", detail: result.error.message };
  }
  const buckets = parseRateLimit(result.stdout);
  if (!buckets) return { ok: true, known: false, reason: "unavailable", detail: "rate_limit 回包缺少 core/graphql 的 limit 或 remaining" };
  return { ok: true, known: true, kind: "two-buckets", buckets };
}
