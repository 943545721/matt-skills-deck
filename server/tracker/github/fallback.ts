/**
 * GitHub 降级原因分类（按 DSH fallback-reason.ts 的判定顺序移植）。
 *
 * GraphQL 读失败退 REST 时，调用方需要知道「为什么退」：超时、限流、企业版主机、
 * 还是其余查询错误。分类只看失败文本与 GH_HOST，不记录主机地址原文、不碰 token。
 */

/** 降级原因四种取值，与 DSH 的 reason 字段同口径。 */
export type FallbackReason = "timeout" | "rate-limit" | "ghe-host" | "graphql-error";

function processEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

/** 全部可读错误文本：raw/stderr/stdout/message 都看，嵌套 error.message 也看。 */
function textOf(failure: unknown): string {
  if (typeof failure === "string") return failure;
  if (!failure || typeof failure !== "object") return "";
  const bag = failure as Record<string, unknown>;
  const inner = bag.error && typeof bag.error === "object" ? (bag.error as Record<string, unknown>) : null;
  return [bag.raw, bag.stderr, bag.stdout, bag.message, inner?.message, inner?.raw]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

/** 读 GH_HOST；企业版主机名不写进日志，这里只取名字本身。 */
export function readGhHost(env?: Record<string, string | undefined>): string {
  const host = (env ?? processEnv()).GH_HOST;
  return typeof host === "string" ? host.trim() : "";
}

/** github.com（含 api.github.com 与子域）不算企业版主机。 */
export function isGheHostName(host: unknown): boolean {
  const value = String(host ?? "").trim().toLowerCase();
  if (!value) return false;
  if (value === "github.com" || value === "api.github.com" || value.endsWith(".github.com")) return false;
  return true;
}

export interface FallbackReasonOptions {
  /** 显式主机名（测试用）；不传则读 GH_HOST。 */
  host?: string;
}

/**
 * 判定降级原因。
 *
 * 顺序与 DSH 一致：超时 → 限流 → 企业版主机（GH_HOST 优先）→ 企业版文案 → 企业版主机名
 * → 其余 graphql-error。顺序有原因：限流文案可能同时提到网络，超时/限流应先归因。
 */
export function pickFallbackReason(failure: unknown, options: FallbackReasonOptions = {}): FallbackReason {
  const text = textOf(failure);
  const lower = text.toLowerCase();
  const kind = failure && typeof failure === "object" ? (failure as { kind?: unknown }).kind : undefined;
  if (/timeout|timed out|timedout|etimedout/i.test(text)) return "timeout";
  if (kind === "ratelimit" || /rate limit|429|secondary rate limit/i.test(lower)) return "rate-limit";
  const host = options.host !== undefined ? options.host : readGhHost();
  if (isGheHostName(host)) return "ghe-host";
  if (/github enterprise|ghes|enterprise server/i.test(lower)) return "ghe-host";
  if (/([A-Za-z0-9-]+\.)+(example\.com|local|internal|corp|enterprise)(:\d+)?/i.test(text)) return "ghe-host";
  return "graphql-error";
}
