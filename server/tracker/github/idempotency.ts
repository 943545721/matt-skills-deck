import type { GhClient } from "./client.ts";
import { edgeNodesOf, normalizeIssue, asString, type NormalizedIssue } from "./normalize.ts";
import { repoSlug, type ReadFailure, type ReadResult, type RepoRef } from "./reads.ts";

/**
 * 建票幂等（DSH idempotency.ts + refresh/contract/idempotency-keys.ts）。
 *
 * 锚点是正文第一行的 HTML 注释，GitHub 渲染时不可见：
 *
 *     <!-- DSH-IDEMPOTENCY-KEY: <key> -->
 *
 * 查重先走 `gh search issues`（快），失败再走 `gh issue list` 的创建时间窗（慢）。
 * **任何一步不确定都必须报失败，不能回「没找到」**——把「查不到」说成「没写过」，
 * 重试就会造出第二张票。
 */
export const ANCHOR_PREFIX = "<!-- DSH-IDEMPOTENCY-KEY:";
export const IDEMPOTENCY_LOOKBACK_MS = 1_800_000;
export const ANCHOR_BODY_FETCH_LIMIT = 40;
export const ANCHOR_SEARCH_LIMIT = 20;
export const ANCHOR_LIST_LIMIT = 100;

// 与 DSH 契约一致：字母、数字、点、下划线、连字符、冒号、斜杠，最长 200；先 trim 再校验。
const KEY = /^[A-Za-z0-9._:/-]{1,200}$/;

function normalizedKey(raw: string): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function anchorLineFor(key: string): string {
  return `${ANCHOR_PREFIX} ${normalizedKey(key)} -->\n`;
}

export function withAnchor(body: string, key: string): string {
  const trimmed = normalizedKey(key);
  if (!KEY.test(trimmed)) throw new Error(`幂等键不合法：${key}`);
  return `${anchorLineFor(trimmed)}${body}`;
}

/** 正文里第一行锚点的键；没有或格式不对返回 null。 */
export function idempotencyKeyOf(body: string): string | null {
  const first = body.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith(ANCHOR_PREFIX)) return null;
  const match = /^<!-- DSH-IDEMPOTENCY-KEY: ([^>\s]+) -->$/.exec(first.trim());
  return match?.[1] ?? null;
}

export interface AnchorCandidate {
  number: number;
  body: string;
  state: string;
  createdAt: string;
}

/** 命中规则：正文锚点等于 key、仓库一致（调用方已按仓库查）、票未关闭。 */
export function isAnchorHit(candidate: AnchorCandidate, key: string): boolean {
  return candidate.state.toUpperCase() !== "CLOSED" && idempotencyKeyOf(candidate.body) === key;
}

function candidateOf(raw: unknown): AnchorCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const node = raw as Record<string, unknown>;
  const number = typeof node.number === "number" ? node.number : Number(node.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    number,
    body: asString(node.body),
    state: asString(node.state, "OPEN"),
    createdAt: asString(node.createdAt) || asString(node.created_at),
  };
}

export interface AnchorHit {
  hit: true;
  issue: NormalizedIssue;
  /** 命中来自哪条路径：search / list；用于报告与日志，不参与业务判断。 */
  via: "search" | "list";
}

export type AnchorLookup =
  | { ok: true; hit: false }
  | { ok: true } & AnchorHit
  | ReadFailure;

export interface LookupOptions {
  cwd?: string;
  /** 测试与对账时可注入「现在」：慢路径只扫创建时间窗内的票。 */
  now?: number;
}

async function readBody(client: GhClient, repo: RepoRef, number: number): Promise<AnchorCandidate | null> {
  const result = await client.exec(
    ["issue", "view", String(number), "--repo", repoSlug(repo), "--json", "number,body,state,createdAt"],
    { cwd: repo.cwd },
  );
  if (!result.ok) return null;
  try {
    return candidateOf(JSON.parse(result.stdout || "null"));
  } catch {
    return null;
  }
}

async function searchCandidates(client: GhClient, repo: RepoRef, key: string): Promise<readonly AnchorCandidate[] | null> {
  const result = await client.exec(
    [
      "search",
      "issues",
      "--repo",
      repoSlug(repo),
      "--match",
      "body",
      "--json",
      "number,body,state,createdAt,updatedAt",
      "--limit",
      String(ANCHOR_SEARCH_LIMIT),
      key,
    ],
    { cwd: repo.cwd },
  );
  if (!result.ok) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout || "[]");
    return edgeNodesOf(parsed).flatMap((node) => {
      const candidate = candidateOf(node);
      return candidate ? [candidate] : [];
    });
  } catch {
    return null;
  }
}

async function listCandidates(client: GhClient, repo: RepoRef): Promise<readonly AnchorCandidate[] | null> {
  const result = await client.exec(
    ["issue", "list", "--state", "open", "--limit", String(ANCHOR_LIST_LIMIT), "--json", "number,body,state,createdAt,updatedAt", "--repo", repoSlug(repo)],
    { cwd: repo.cwd },
  );
  if (!result.ok) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout || "[]");
    return edgeNodesOf(parsed).flatMap((node) => {
      const candidate = candidateOf(node);
      return candidate ? [candidate] : [];
    });
  } catch {
    return null;
  }
}

function issueFromCandidate(candidate: AnchorCandidate, repo: RepoRef): NormalizedIssue | null {
  const mapped = normalizeIssue(
    {
      number: candidate.number,
      state: candidate.state,
      createdAt: candidate.createdAt,
      updatedAt: candidate.createdAt,
      body: candidate.body,
    },
    { kindHint: "issue", withBody: true },
  );
  if (!mapped) return null;
  return { ...mapped, url: `https://github.com/${repoSlug(repo)}/issues/${candidate.number}` };
}

/**
 * 按锚点找「这张票是不是已经建过」。
 *
 * 快路径 search 失败 → 慢路径 list；两条都失败 → `{ok:false}`，绝不返回 `{hit:false}`。
 * 候选超过 40 条时只回读前 40 条正文；读不出正文的候选算「不确定」，整次查询按失败处理。
 */
export async function lookupByAnchor(client: GhClient, repo: RepoRef, key: string, options: LookupOptions = {}): Promise<AnchorLookup> {
  const wantedKey = normalizedKey(key);
  if (!KEY.test(wantedKey)) return { ok: false, kind: "invalid", message: `幂等键不合法：${key}`, raw: "" };
  const now = options.now ?? Date.now();
  const searched = await searchCandidates(client, repo, wantedKey);
  if (searched) {
    return confirmCandidates(client, repo, searched, wantedKey, "search");
  }
  const listed = await listCandidates(client, repo);
  if (!listed) {
    return { ok: false, kind: "network", message: "幂等查重失败：search 与 issue list 都没有成功，无法确认这张票是否已经建过", raw: "" };
  }
  const windowed = listed.filter((candidate) => {
    const created = Date.parse(candidate.createdAt);
    return Number.isNaN(created) || now - created <= IDEMPOTENCY_LOOKBACK_MS;
  });
  return confirmCandidates(client, repo, windowed, wantedKey, "list");
}

async function confirmCandidates(
  client: GhClient,
  repo: RepoRef,
  candidates: readonly AnchorCandidate[],
  key: string,
  via: "search" | "list",
): Promise<AnchorLookup> {
  const limited = candidates.slice(0, ANCHOR_BODY_FETCH_LIMIT);
  for (const candidate of limited) {
    const fresh = candidate.body ? candidate : await readBody(client, repo, candidate.number);
    if (!fresh) {
      return {
        ok: false,
        kind: "network",
        message: `幂等查重失败：候选 #${candidate.number} 的正文读不回来，无法确认是否已经建过`,
        raw: "",
      };
    }
    if (!isAnchorHit(fresh, key)) continue;
    const issue = issueFromCandidate(fresh, repo);
    if (!issue) return { ok: false, kind: "parse", message: `幂等命中的 #${fresh.number} 数据形状不对`, raw: "" };
    return { ok: true, hit: true, issue, via };
  }
  return { ok: true, hit: false };
}

/** 给调用方的诊断句：锚点命中与「不支持锚点」要分开说。 */
export function describeAnchorFailure(kind: ReadFailure): string {
  return kind.kind === "network" ? `幂等状态未知：${kind.message}` : kind.message;
}
