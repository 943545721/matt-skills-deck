import type { GhClient } from "./client.ts";
import type { GhErrorKind } from "./errors.ts";
import { normalizeIssueList, type NormalizedIssue } from "./normalize.ts";
import { repoSlug, type ReadFailure, type ReadResult, type RepoRef } from "./reads.ts";

/**
 * REST 条件请求与增量刷新（DSH 没有这一段，属于按 Phase 4 要求补的设计）。
 *
 * 两件事分开：
 * - **增量**：`since` 让服务端只回更新时间晚于该时刻的票（GraphQL 与 REST 都支持）。
 * - **304**：把上一次的 `ETag` 带回去；内容没变时 GitHub 回 304 且没有正文，
 *   界面保留旧快照，不重画整块板子。
 *
 * 条件请求只对 REST 有意义：GraphQL 没有 ETag，也不回 304。调用方必须按来源分支。
 */
export interface HttpEnvelope {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 解析 `gh api --include` 的输出：状态行 + 头 + 空行 + 正文。多个响应块时取最后一块。 */
export function parseHttpResponse(stdout: string): HttpEnvelope | null {
  const text = stdout.replace(/\r\n/g, "\n");
  const blocks = text.split(/\n\n/);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] ?? "";
    const lines = block.split("\n");
    const statusLine = lines[0] ?? "";
    const match = /^HTTP\/[\d.]+ (\d{3})/.exec(statusLine);
    if (!match) continue;
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const body = blocks.slice(index + 1).join("\n\n").trim();
    return { status: Number(match[1]), headers, body };
  }
  return null;
}

export interface ConditionalOptions {
  etag?: string | null;
  cwd?: string;
}

export type ConditionalResult =
  | { ok: true; notModified: true; etag: string | null }
  | { ok: true; notModified: false; status: number; etag: string | null; data: unknown }
  | ReadFailure;

function failure(kind: GhErrorKind, message: string, raw: string): ReadFailure {
  return { ok: false, kind, message, raw };
}

/** 带 `If-None-Match` 的 REST GET：200 回数据 + 新 ETag，304 只回「没变」。 */
export async function conditionalGet(client: GhClient, path: string, options: ConditionalOptions = {}): Promise<ConditionalResult> {
  const headers = options.etag ? [`If-None-Match: ${options.etag}`] : [];
  const result = await client.rest(path, { include: true, headers, cwd: options.cwd });
  if (!result.ok) {
    // 某些 gh/curl 组合会把 304 当非零退出；原文里仍然有状态行，按「没变」处理。
    if (/HTTP\/[\d.]+ 304/.test(result.error.raw) || /HTTP\/[\d.]+ 304/.test(result.stderr)) {
      return { ok: true, notModified: true, etag: options.etag ?? null };
    }
    return { ok: false, kind: result.error.kind, message: result.error.message, raw: result.error.raw };
  }
  const envelope = parseHttpResponse(result.stdout);
  if (!envelope) return failure("parse", "条件请求回包里没有 HTTP 状态行", result.stdout.slice(0, 800));
  const etag = envelope.headers.etag ?? null;
  if (envelope.status === 304) return { ok: true, notModified: true, etag: etag ?? options.etag ?? null };
  if (envelope.status < 200 || envelope.status >= 300) {
    return failure(envelope.status === 404 ? "notfound" : envelope.status === 401 || envelope.status === 403 ? "auth" : "network", `条件请求返回 HTTP ${envelope.status}`, envelope.body.slice(0, 800));
  }
  let data: unknown = null;
  if (envelope.body) {
    try {
      data = JSON.parse(envelope.body);
    } catch {
      return failure("parse", "条件请求正文不是合法 JSON", envelope.body.slice(0, 800));
    }
  }
  return { ok: true, notModified: false, status: envelope.status, etag, data };
}

export interface ConditionalListData {
  notModified: boolean;
  items: NormalizedIssue[];
  etag: string | null;
  since: string | null;
}

function listPath(repo: RepoRef, since: string | null): string {
  const sinceArg = since ? `&since=${encodeURIComponent(since)}` : "";
  return `repos/${repoSlug(repo)}/issues?state=all&sort=updated&direction=desc&per_page=100${sinceArg}`;
}

/**
 * 增量 + ETag 的列表读取（REST 路径）。
 *
 * `since` 先做服务端增量；`etag` 再做一次「完全没变」的短路。
 * 304 时 items 为空数组——调用方必须用 `notModified` 判断是否复用旧快照，
 * 不能把空数组当成「仓库里一张票都没有」。
 */
export async function listIssuesConditional(
  client: GhClient,
  repo: RepoRef,
  options: { since?: string | null; etag?: string | null } = {},
): Promise<ReadResult<ConditionalListData>> {
  let since: string | null = null;
  if (options.since) {
    const stamp = Date.parse(options.since);
    if (Number.isNaN(stamp)) return failure("parse", `since 不是合法时间：${options.since}`, "");
    since = new Date(stamp).toISOString();
  }
  const result = await conditionalGet(client, listPath(repo, since), { etag: options.etag, cwd: repo.cwd });
  if (!result.ok) return result;
  if (result.notModified) {
    return { ok: true, data: { notModified: true, items: [], etag: result.etag, since } };
  }
  return {
    ok: true,
    data: {
      notModified: false,
      items: normalizeIssueList(result.data),
      etag: result.etag,
      since,
    },
  };
}

/** ETag 缓存：只存字符串，不做失效策略；调用方按仓库键自己决定何时丢。 */
export interface EtagStore {
  get(key: string): string | null;
  set(key: string, etag: string | null): void;
  clear(): void;
}

export function createEtagStore(): EtagStore {
  const store = new Map<string, string>();
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, etag) => {
      if (etag) store.set(key, etag);
      else store.delete(key);
    },
    clear: () => store.clear(),
  };
}
