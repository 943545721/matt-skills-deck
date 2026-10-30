import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { BlockerRef, ItemKind, ListView } from "../../shared/issues.ts";
import { parseDerivedFrom } from "../../shared/derived.ts";
import type { Issue, IssueComment, IssueDetailResult, ListIssuesResult, ListOptions } from "./github.ts";
import { readinessOf } from "./readiness.ts";
import { containerKindOf } from "../../shared/container-kind.ts";
import { splitCrossRepoBlock, stripCrossRepoBlock } from "../../shared/edge-rules.ts";
const execFileAsync = promisify(execFile);
/**
 * GitLab 后端：25 项读/写，全部走 `glab api` 参数数组（无 shell）。
 * token 归 glab 自己管：本模块不接收、不拼进 argv、不进日志，错误原文先脱敏。
 * 与 DSH 一致：issue/MR 编号独立；父子关系是正文 `Part of #n` 行；
 * 阻塞优先原生 `is_blocked_by`，免费版不可用时回退正文 `Blocked by:` 行。
 */
const TIMEOUT = 20_000;
const SLOW = 60_000;
const WRITE = 30_000;
const PER_PAGE = 100;
const CAP = 1_000;
const ANCHOR = "<!-- DSH-IDEMPOTENCY-KEY:";
const TRIAGE = 15; const PUSH = 30;
export type GlabFailureReason = "glab-missing" | "glab-unauth" | "glab-failed" | "not-found" | "invalid";
export type GlabErrorKind = "glab-missing" | "glab-unauth" | "glab-forbidden" | "read-only-project" | "not-found" | "glab-failed";
export interface GlabFailure { ok: false; reason: GlabFailureReason; kind: GlabErrorKind; detail: string; }
export interface GlabWriteFailure extends GlabFailure { outcome: "not-written" | "maybe-written"; maybeWritten: boolean; maybeCreated?: boolean; }
type Ok = { ok: true; stdout: string; stderr: string };
type Err = GlabFailure & { ok: false; exitCode: number | null; sent: boolean };
/** 日志/界面可见之前抹掉 token 与带凭据的地址。 */
export function redactGlabText(text: string): string {
  return text
    .replace(/glpat-[A-Za-z0-9_-]{6,}/g, "glpat-***")
    .replace(/(authorization:\s*(?:bearer|token)\s+)[^\s]+/gi, "$1***")
    .replace(/(private-token:\s*)[^\s]+/gi, "$1***")
    .replace(/((?:private_token|access_token|oauth_token|token)=)[^&#\s]+/gi, "$1***")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1***@");
}
function textOf(error: unknown): string {
  const bag = (error ?? {}) as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return redactGlabText([bag.stderr, bag.stdout, bag.message].filter((v): v is string => typeof v === "string" && v.trim() !== "").join("\n").trim());
}
function classifyText(text: string): GlabErrorKind {
  const v = text.toLowerCase();
  if (/glab auth login|no token|not logged in|authentication required|invalid token|\b401\b|host not found|no such host/.test(v)) return "glab-unauth";
  if (/archived|read-only|read only|issues? (?:are )?disabled|issues_access_level[^\n]*disabled/.test(v)) return "read-only-project";
  if (/\b403\b|forbidden|insufficient permission|permission denied|not allowed to|no permission/.test(v)) return "glab-forbidden";
  if (/\b404\b|not found|project not found/.test(v)) return "not-found";
  return "glab-failed";
}
function publicReason(kind: GlabErrorKind): GlabFailureReason {
  if (kind === "glab-missing" || kind === "glab-unauth" || kind === "not-found") return kind;
  return "glab-failed";
}
function detailOf(kind: GlabErrorKind, text: string): string {
  const tail = text ? `：${text.slice(0, 800)}` : "";
  if (kind === "glab-missing") return "没有找到 glab 命令：装好 GitLab CLI 后执行 glab auth login";
  if (kind === "glab-unauth") return `glab 没有登录态，先执行 glab auth login${tail}`;
  if (kind === "glab-forbidden") return `GitLab 拒绝了这次请求（权限不足或项目只读）${tail}`;
  if (kind === "read-only-project") return `GitLab 项目是只读或已归档${tail}`;
  if (kind === "not-found") return `GitLab 上找不到对象（仓库不存在、编号不对，或当前账号没有权限）${tail}`;
  return text ? `glab 请求失败${tail}` : "glab 请求失败，没有输出错误信息";
}
/** 未安装 / 未登录 / 权限不足 / 只读 / 找不到 / 一般失败。 */
export function classifyGlabError(error: unknown): { kind: GlabErrorKind; reason: GlabFailureReason; detail: string } {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return { kind: "glab-missing", reason: "glab-missing", detail: detailOf("glab-missing", "") };
  const text = textOf(error);
  const kind = classifyText(text);
  const exit = typeof code === "number" ? `（退出码 ${code}）` : "";
  return { kind, reason: publicReason(kind), detail: `${detailOf(kind, text)}${exit}` };
}
/** 只有明确的 4xx（408 除外）才算「肯定没送达」；超时/断连/5xx 都可能是「已写入」。 */
function mayHaveSent(kind: GlabErrorKind, text: string, error: unknown): boolean {
  if (kind !== "glab-failed") return false;
  const killed = (error as { killed?: unknown } | null)?.killed === true;
  const signal = (error as { signal?: unknown } | null)?.signal;
  if (killed || signal === "SIGTERM" || /timed?\s*out|timeout|ETIMEDOUT/i.test(text)) return true;
  if (/\b4(?!08)\d{2}\b/.test(text) && !/\b408\b/.test(text)) return false;
  return true;
}
async function runGlab(args: string[], opts: { timeout?: number; cwd?: string } = {}): Promise<Ok | Err> {
  try {
    const { stdout, stderr } = await execFileAsync("glab", args, { timeout: opts.timeout ?? TIMEOUT, maxBuffer: 8 << 20, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const base = classifyGlabError(error);
    const code = (error as { code?: unknown } | null)?.code;
    return { ...base, ok: false, exitCode: typeof code === "number" ? code : null, sent: mayHaveSent(base.kind, textOf(error), error) };
  }
}
async function runGit(args: string[]): Promise<Ok | Err> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { timeout: 120_000, maxBuffer: 8 << 20 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, reason: "glab-failed", kind: "glab-failed", detail: code === "ENOENT" ? "没有找到 git 命令" : `git 执行失败：${textOf(error).slice(0, 500)}`, exitCode: typeof code === "number" ? code : null, sent: false };
  }
}
const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const rec = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
/** iid / link id 在 GitLab 回包里是数字；能安全转成十进制文本的才接受。 */
const idText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
const positive = (value: number): boolean => Number.isInteger(value) && value > 0;
const projectPath = (owner: string, name: string): string => `projects/${encodeURIComponent(`${owner}/${name}`)}`;
const issuesPath = (owner: string, name: string, query = ""): string => `${projectPath(owner, name)}/issues${query ? `?${query}` : ""}`;
const issuePath = (owner: string, name: string, issue: number): string => `${projectPath(owner, name)}/issues/${encodeURIComponent(String(issue))}`;
const notesPath = (owner: string, name: string, issue: number): string => `${issuePath(owner, name, issue)}/notes`;
const linksPath = (owner: string, name: string, issue: number): string => `${issuePath(owner, name, issue)}/links`;
const fail = (kind: GlabErrorKind, detail: string, reason: GlabFailureReason = publicReason(kind)): GlabFailure => ({ ok: false, reason, kind, detail });
const invalid = (detail: string): GlabFailure => ({ ok: false, reason: "invalid", kind: "glab-failed", detail });
export function normalizeGitLabColor(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().replace(/^#/, "").toLowerCase() : "";
  return /^[0-9a-f]{6}$/.test(value) ? value : "cccccc";
}
function mapLabels(raw: unknown): { name: string; color: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const name = typeof item === "string" ? item : str(rec(item)?.name);
    if (!name) return [];
    return [{ name, color: typeof item === "string" ? "cccccc" : normalizeGitLabColor(rec(item)?.color) }];
  });
}
/**
 * 正文里的 `Blocked by: #1, #2` 行。
 *
 * 只看可见部分：跨仓库引用的隐藏区段里也有一行 `Blocked by:`，
 * 把它当成原生边会让「对方仓库的票」永远读成 OPEN，关掉也解除不了。
 */
export function parseBlockedByLine(body: string): string[] {
  const match = /^Blocked by:\s*(.+)$/m.exec(stripCrossRepoBlock(body));
  if (!match) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (match[1] ?? "").split(",")) {
    const key = /#(\d+)\s*$/.exec(part.trim())?.[1] ?? part.trim().replace(/^#/, "");
    if (!/^\d+$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
function rewriteBlockedByLine(body: string, keys: readonly string[]): string {
  // 隐藏区段原样接回末尾：重写可见行时把它抹掉，等于悄悄删掉用户的跨仓库引用。
  const { visible, block } = splitCrossRepoBlock(body);
  const line = keys.length ? `Blocked by: ${keys.map((key) => `#${key}`).join(", ")}` : "";
  const next = /^Blocked by:\s*.+$/m.test(visible)
    ? line
      ? visible.replace(/^Blocked by:\s*.+$/m, line)
      : visible.replace(/^Blocked by:\s*.+$/m, "").replace(/^\n+/, "")
    : line
      ? visible
        ? `${line}\n\n${visible}`
        : line
      : visible;
  if (!block) return next;
  const head = next.replace(/\s+$/, "");
  const tail = /\n$/.test(body) ? "\n" : "";
  return `${head ? `${head}\n\n` : ""}${block}${tail}`;
}
/** 父子归属的唯一真相。 */
export function parsePartOfLine(body: string): string | null {
  return /^Part of #(\d+)\s*$/m.exec(body)?.[1] ?? null;
}
function rewritePartOfLine(body: string, parent: number | null): string {
  const pattern = /^Part of #\d+\s*$/m;
  if (parent === null) return pattern.test(body) ? body.replace(pattern, "").replace(/^\n+/, "") : body;
  const line = `Part of #${parent}`;
  return pattern.test(body) ? body.replace(pattern, line) : body ? `${line}\n${body}` : line;
}
function blockersFromLine(body: string): BlockerRef[] {
  return parseBlockedByLine(body).map((key) => ({ number: Number(key), title: `#${key}`, state: "OPEN" as const, kind: "issue" as const }));
}
/** GitLab issue → 统一票面。列表没有原生阻塞边，按正文行保守计算。 */
export function mapGitLabIssues(raw: unknown): Issue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const record = rec(item);
    const number = Number(record?.iid);
    if (!positive(number)) return [];
    const labels = mapLabels(Array.isArray(record?.labels_details) ? record.labels_details : record?.labels);
    const body = str(record?.description);
    // 判票面身份、父子行只看可见部分；正文原样带出去，读路径要靠隐藏区段解析跨仓库引用。
    const visible = stripCrossRepoBlock(body);
    const base = {
      number, title: str(record?.title, `#${number}`) || `#${number}`,
      state: str(record?.state) === "closed" ? ("CLOSED" as const) : ("OPEN" as const),
      url: str(record?.web_url), updatedAt: str(record?.updated_at), createdAt: str(record?.created_at) || str(record?.updated_at),
      // GitLab 给的是 closed_at（没关就是空）：缺它时间线就少一行「关票」，不拿 updatedAt 顶替。
      closedAt: str(record?.closed_at) || null,
      labels, assignees: (Array.isArray(record?.assignees) ? record.assignees : []).map((entry) => str(rec(entry)?.username)).filter(Boolean),
      isMap: labels.some((label) => label.name === "wayfinder:map"), containerKind: containerKindOf({ labels, body: visible, isMap: labels.some((label) => label.name === "wayfinder:map") }), kind: "issue" as const, merged: false, blockedBy: blockersFromLine(body),
      parentKey: parsePartOfLine(visible),
      derivedFrom: parseDerivedFrom(body),
      body,
    };
    return [{ ...base, readiness: readinessOf(base) }];
  });
}
const issueOf = (record: Record<string, unknown>): Issue | undefined => mapGitLabIssues([record])[0];
export interface GitLabListOptions extends ListOptions {}
export async function listGitLabIssues(owner: string, name: string, options: GitLabListOptions = {}): Promise<ListIssuesResult> {
  const view = options.view ?? (options.includeClosed ? "all" : "open");
  if (view === "merged") return { ok: true, issues: [], totalCount: 0, hasMore: false, fetchedAt: new Date().toISOString(), source: "gitlab", rateLimit: null };
  const state = view === "all" ? "all" : view === "closed" ? "closed" : "opened";
  const limit = Math.min(Math.max(options.limit ?? PER_PAGE, 1), PER_PAGE);
  const result = await runGlab(["api", issuesPath(owner, name, `state=${state}&per_page=${limit}&order_by=updated_at&sort=desc&with_labels_details=true`)]);
  if (!result.ok) return result;
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) return fail("glab-failed", "GitLab 列票回包不是合法 JSON 数组");
  const issues = mapGitLabIssues(parsed);
  return { ok: true, issues, totalCount: issues.length, hasMore: issues.length >= limit, fetchedAt: new Date().toISOString(), source: "gitlab", rateLimit: null };
}
async function fetchIssueRaw(owner: string, name: string, issue: number): Promise<{ ok: true; record: Record<string, unknown> } | Err> {
  const result = await runGlab(["api", `${issuePath(owner, name, issue)}?with_labels_details=true`]);
  if (!result.ok) return result;
  const record = rec(parseJson(result.stdout));
  if (!record) return { ok: false, reason: "not-found", kind: "not-found", detail: `GitLab 上找不到 #${issue}（回包不是一张票）`, exitCode: 0, sent: false };
  return { ok: true, record };
}
interface NativeLinks { keys: string[]; rows: Record<string, unknown>[]; }
function linkKey(row: Record<string, unknown>): string {
  return idText(row.iid) || idText(row.target_issue_iid) || idText(row.key);
}
async function readNativeLinks(owner: string, name: string, issue: number): Promise<{ ok: true; links: NativeLinks } | Err> {
  const result = await runGlab(["api", linksPath(owner, name, issue)]);
  if (!result.ok) return result;
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) return { ok: false, reason: "glab-failed", kind: "glab-failed", detail: "GitLab 关联回包不是数组", exitCode: 0, sent: false };
  const rows = parsed.map(rec).filter((row): row is Record<string, unknown> => row !== null);
  const blocked = rows.filter((row) => str(row.link_type).toLowerCase() === "is_blocked_by");
  return { ok: true, links: { keys: blocked.map(linkKey).filter(Boolean), rows: blocked } };
}
/** 逐张落实阻塞者；取不到时按「开着」保守计算。 */
async function resolveBlockers(owner: string, name: string, keys: readonly string[], known: readonly Record<string, unknown>[] = []): Promise<BlockerRef[]> {
  const out: BlockerRef[] = [];
  for (const key of keys.slice(0, 50)) {
    const number = Number(key);
    if (!positive(number)) continue;
    const row = known.find((item) => linkKey(item) === key);
    const fetched = await fetchIssueRaw(owner, name, number);
    const record = fetched.ok ? fetched.record : null;
    out.push({ number, title: str(record?.title, str(row?.title, `#${key}`)) || `#${key}`, state: str(record?.state) === "closed" || str(row?.state) === "closed" ? "CLOSED" : "OPEN", kind: "issue" });
  }
  return out;
}
/** 原生边优先，免费版探针失败或为空时回退正文行。 */
export async function getGitLabDependencies(owner: string, name: string, issue: number): Promise<{ ok: true; blockers: BlockerRef[]; source: "native" | "description" } | GlabFailure> {
  if (!positive(issue)) return invalid("票号必须是正整数");
  const raw = await fetchIssueRaw(owner, name, issue);
  if (!raw.ok) return raw;
  const native = await readNativeLinks(owner, name, issue);
  const nativeKeys = native.ok ? native.links.keys : [];
  const keys = nativeKeys.length ? nativeKeys : parseBlockedByLine(str(raw.record.description));
  return { ok: true, blockers: await resolveBlockers(owner, name, keys, native.ok ? native.links.rows : []), source: nativeKeys.length ? "native" : "description" };
}
/** 详情：正文 + 人类评论（system 便签不是评论）+ 阻塞者。 */
export async function getGitLabIssue(owner: string, name: string, issue: number): Promise<IssueDetailResult> {
  if (!positive(issue)) return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  const [raw, notes] = await Promise.all([
    fetchIssueRaw(owner, name, issue),
    runGlab(["api", `${notesPath(owner, name, issue)}?sort=asc&order_by=created_at&per_page=100`]),
  ]);
  if (!raw.ok) return raw.kind === "not-found" ? { ok: false, reason: "not-found", detail: `GitLab 上找不到 #${issue}` } : { ok: false, reason: raw.reason, detail: raw.detail };
  const mapped = issueOf(raw.record);
  if (!mapped) return { ok: false, reason: "not-found", detail: `GitLab 上找不到 #${issue}` };
  let comments: IssueComment[] = [];
  if (notes.ok) {
    const parsed = parseJson(notes.stdout);
    comments = Array.isArray(parsed)
      ? parsed.flatMap((item) => {
          const record = rec(item);
          const body = str(record?.body);
          return !body || record?.system === true ? [] : [{ author: str(rec(record?.author)?.username, "gitlab"), createdAt: str(record?.created_at), body }];
        })
      : [];
  }
  const deps = await getGitLabDependencies(owner, name, issue);
  const full: Issue = deps.ok ? { ...mapped, blockedBy: deps.blockers } : mapped;

  // 父子边是详情页的附加信息，读不到时不让整张详情失败；但只在确实有父/是容器时才多打一次 API。
  const parentNumber = /^\d+$/.test(full.parentKey ?? "") && Number(full.parentKey) > 0 ? Number(full.parentKey) : null;
  const isContainer = full.containerKind === "map" || full.containerKind === "spec";
  const [parentRaw, subIssues] = await Promise.all([
    parentNumber === null ? Promise.resolve(null) : fetchIssueRaw(owner, name, parentNumber),
    isContainer ? listGitLabSubIssues(owner, name, issue) : Promise.resolve(null),
  ]);
  const parent = parentNumber === null
    ? null
    : {
        number: parentNumber,
        title: parentRaw?.ok ? str(parentRaw.record.title, `#${parentNumber}`) : `#${parentNumber}`,
        ...(parentRaw?.ok ? { containerKind: issueOf(parentRaw.record)?.containerKind ?? null } : {}),
      };
  const childRows = subIssues?.ok ? subIssues.result.items : [];
  const children = childRows.map((child) => ({
    number: child.number,
    title: child.title,
    state: child.state,
    kind: child.kind,
    containerKind: child.containerKind ?? null,
  }));

  return {
    ok: true,
    issue: { ...full, body: str(raw.record.description) },
    comments,
    parent,
    ...(children.length ? { children, childrenTotal: subIssues?.ok ? subIssues.result.total : children.length } : {}),
    meta: { labelCount: full.labels.length, labelsTruncated: false, commentCount: comments.length, commentsTruncated: comments.length >= 100, blockersTruncated: false },
  };
}
export async function listGitLabLabels(owner: string, name: string): Promise<{ ok: true; labels: { name: string; color: string; description: string }[] } | GlabFailure> {
  const labels: { name: string; color: string; description: string }[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await runGlab(["api", `${projectPath(owner, name)}/labels?per_page=${PER_PAGE}&page=${page}&include_ancestor_groups=false`]);
    if (!result.ok) return result;
    const parsed = parseJson(result.stdout);
    if (!Array.isArray(parsed)) return fail("glab-failed", "GitLab 标签回包不是合法 JSON 数组");
    for (const item of parsed) {
      const record = rec(item);
      const label = str(record?.name);
      if (label) labels.push({ name: label, color: normalizeGitLabColor(record?.color), description: str(record?.description) });
    }
    if (parsed.length < PER_PAGE) break;
  }
  return { ok: true, labels };
}
export interface GitLabPageResult { items: Issue[]; nextCursor: string | null; total: number; }
/** 一页票：游标就是页码；总数走同一口径的 counts。 */
export async function listGitLabPage(owner: string, name: string, filter: { state?: "opened" | "closed" | "all"; labels?: readonly string[] } = {},
  options: { cursor?: string | null; limit?: number } = {}): Promise<{ ok: true; page: GitLabPageResult } | GlabFailure> {
  const cursor = options.cursor ?? "";
  const page = cursor === "" ? 1 : Number(cursor);
  if (!Number.isInteger(page) || page < 1) return invalid(`游标已失效，请重新加载：${cursor.slice(0, 100)}`);
  const perPage = Math.min(Math.max(options.limit ?? 50, 1), PER_PAGE);
  const params = new URLSearchParams({ scope: "all", order_by: "created_at", sort: "desc", page: String(page), per_page: String(perPage), with_labels_details: "true" });
  if (filter.state && filter.state !== "all") params.set("state", filter.state);
  const labels = (filter.labels ?? []).map((label) => label.trim()).filter(Boolean);
  if (labels.length) params.set("labels", labels.join(","));
  const result = await runGlab(["api", issuesPath(owner, name, params.toString())], { timeout: SLOW });
  if (!result.ok) return result;
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) return fail("glab-failed", "GitLab 分页回包不是合法 JSON 数组");
  const items = mapGitLabIssues(parsed);
  if (items.length !== parsed.length) return fail("glab-failed", "GitLab 分页回包里有一行归一不成票，整页失败而不是返回残缺清单");
  const counted = await gitLabCounts(owner, name, { state: filter.state, labels });
  if (!counted.ok) return counted;
  return { ok: true, page: { items, nextCursor: parsed.length >= perPage ? String(page + 1) : null, total: counted.total } };
}
export interface GitLabCounts { open: number; closed: number; total: number; }
const countOf = (raw: unknown): number | null => typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
/** 全仓计数；state 收窄在本地做（issues_statistics 不按 state 过滤）。 */
export async function gitLabCounts(owner: string, name: string, filter: { state?: "opened" | "closed" | "all"; labels?: readonly string[] } = {}): Promise<({ ok: true } & GitLabCounts) | GlabFailure> {
  const params = new URLSearchParams({ scope: "all" });
  const labels = (filter.labels ?? []).map((label) => label.trim()).filter(Boolean);
  if (labels.length) params.set("labels", labels.join(","));
  const result = await runGlab(["api", `${projectPath(owner, name)}/issues_statistics?${params.toString()}`], { timeout: SLOW });
  if (!result.ok) return result;
  const counts = rec(rec(rec(parseJson(result.stdout))?.statistics)?.counts);
  const opened = countOf(counts?.opened);
  const closed = countOf(counts?.closed);
  const all = countOf(counts?.all);
  if (opened === null || closed === null || all === null) return fail("glab-failed", "GitLab 计数回包缺少 opened / closed / all（不接受用 0 顶替）");
  if (filter.state === "opened") return { ok: true, open: opened, closed: 0, total: opened };
  if (filter.state === "closed") return { ok: true, open: 0, closed, total: closed };
  return { ok: true, open: opened, closed, total: all };
}
export interface GitLabSubIssues { items: Issue[]; total: number; fetched: number; capped: boolean; missing: number; dropped: number; }
/** 子票只认正文 `Part of #n`；到上限如实标 capped。 */
export async function listGitLabSubIssues(owner: string, name: string, parent: number): Promise<{ ok: true; result: GitLabSubIssues } | GlabFailure> {
  if (!positive(parent)) return invalid("父票号必须是正整数");
  const items: Issue[] = [];
  let fetched = 0;
  let dropped = 0;
  let capped = false;
  for (let page = 1; page <= 20; page += 1) {
    const result = await runGlab(["api", issuesPath(owner, name, `state=all&per_page=${PER_PAGE}&page=${page}&order_by=created_at&sort=desc&with_labels_details=true`)]);
    if (!result.ok) return result;
    const parsed = parseJson(result.stdout);
    if (!Array.isArray(parsed)) return fail("glab-failed", "GitLab 子票列表回包不是合法 JSON 数组");
    if (parsed.length === 0) break;
    for (const row of parsed) {
      fetched += 1;
      if (items.length >= CAP) { capped = true; break; }
      const mapped = mapGitLabIssues([row])[0];
      if (!mapped) { dropped += 1; continue; }
      if (parsePartOfLine(str(rec(row)?.description)) === String(parent)) items.push(mapped);
    }
    if (capped || parsed.length < PER_PAGE) break;
  }
  if (dropped > 0 && items.length === 0) return fail("glab-failed", `地图 #${parent} 的候选行一行都没能算进去（${dropped} 行形状不对）`);
  return { ok: true, result: { items, total: items.length, fetched, capped, missing: 0, dropped } };
}
export async function getGitLabCurrentUser(): Promise<{ ok: true; login: string; name?: string; avatarUrl?: string; bot?: true } | GlabFailure> {
  const result = await runGlab(["api", "user"]);
  if (!result.ok) return result;
  const record = rec(parseJson(result.stdout));
  const login = str(record?.username).trim();
  if (!login) return fail("glab-failed", "glab api user 的回包里没有 username");
  return { ok: true, login, ...(str(record?.name) ? { name: str(record?.name) } : {}), ...(str(record?.avatar_url) ? { avatarUrl: str(record?.avatar_url) } : {}), ...(record?.bot === true ? { bot: true as const } : {}) };
}
export interface GitLabRepoPermissions { push: boolean; triage: boolean; accessLevel: number; archived: boolean; issuesEnabled: boolean; }
function accessLevelOf(entry: unknown): number | null {
  const level = rec(entry)?.access_level;
  return typeof level === "number" && Number.isFinite(level) ? level : null;
}
function maxAccessLevel(permissions: unknown): number | null {
  const bag = rec(permissions);
  let best: number | null = null;
  for (const key of ["project_access", "group_access"]) {
    const level = accessLevelOf(bag?.[key]);
    if (level !== null && (best === null || level > best)) best = level;
  }
  return best;
}
/** 权限问不出来就失败，不拿 false 顶替。 */
export async function getGitLabRepoPermissions(owner: string, name: string): Promise<{ ok: true; permissions: GitLabRepoPermissions } | GlabFailure> {
  const result = await runGlab(["api", `${projectPath(owner, name)}?simple=true`]);
  if (!result.ok) return result;
  const record = rec(parseJson(result.stdout));
  if (!record) return fail("glab-failed", "GitLab 项目回包不是 JSON 对象，权限问不出来");
  const level = maxAccessLevel(record.permissions);
  if (level === null) return fail("glab-failed", "GitLab 项目回包里 permissions.project_access 与 group_access 都没有可用的 access_level");
  return { ok: true, permissions: { push: level >= PUSH, triage: level >= TRIAGE, accessLevel: level, archived: record.archived === true, issuesEnabled: record.issues_enabled !== false && str(record.issues_access_level) !== "disabled" } };
}
/** 写闸门：只读、归档、issue 关闭、权限不足都拒绝；权限未知也拒绝。 */
export async function checkGitLabWritable(owner: string, name: string, action: string): Promise<{ ok: true; permissions: GitLabRepoPermissions } | GlabFailure> {
  const found = await getGitLabRepoPermissions(owner, name);
  if (!found.ok) return { ...found, detail: `${action}前无法确认 GitLab 权限：${found.detail}` };
  const permissions = found.permissions;
  if (permissions.archived || !permissions.issuesEnabled) {
    return fail("read-only-project", `GitLab 项目 ${owner}/${name} ${permissions.archived ? "已归档" : "关闭了 issue"}，${action}被拒绝`);
  }
  if (!permissions.triage) {
    return fail("glab-forbidden", `当前 GitLab 账号在 ${owner}/${name} 上的 access_level=${permissions.accessLevel}，写 issue 至少需要 Reporter/15，${action}被拒绝`);
  }
  return found;
}
/** 远端地址 → GitLab 坐标（含自建实例与多段分组；认不出回 null，不猜）。 */
export function parseGitLabRemote(raw: string): { owner: string; name: string } | null {
  const text = raw.trim();
  if (!text) return null;
  let host = "";
  let rest = "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/([^/\s]+)\/(.+)$/i.exec(text);
  const scp = /^[^\s/@]+@([^/\s:]+):(.+)$/.exec(text);
  if (withScheme) { host = (withScheme[1] ?? "").split(":")[0] ?? ""; rest = withScheme[2] ?? ""; }
  else if (scp) { host = scp[1] ?? ""; rest = scp[2] ?? ""; }
  else return null;
  if (!host || (!host.includes(".") && host !== "localhost")) return null;
  const segments = (rest.split(/[?#]/)[0] ?? "").replace(/\.git$/i, "").trim().split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const name = segments[segments.length - 1] ?? "";
  const owner = segments.slice(0, -1).join("/");
  return owner && name ? { owner, name } : null;
}
/** 三层定位：git remote → .git/config → `glab repo view`。 */
export async function getGitLabRepoKey(workspaceDir: string): Promise<{ owner: string; name: string } | null> {
  const remote = await runGit(["-C", workspaceDir, "remote", "get-url", "origin"]);
  if (remote.ok) {
    const parsed = parseGitLabRemote(remote.stdout.trim());
    if (parsed) return parsed;
  }
  try {
    const config = await readFile(path.join(workspaceDir, ".git", "config"), "utf8");
    const url = /\[remote "origin"\][^\[]*?\burl\s*=\s*(.+)/.exec(config)?.[1]?.trim();
    const parsed = url ? parseGitLabRemote(url) : null;
    if (parsed) return parsed;
  } catch {
    // 没有 .git/config 就落到下一层。
  }
  const view = await runGlab(["repo", "view", "--output", "json"], { cwd: workspaceDir, timeout: SLOW });
  if (!view.ok) return null;
  const segments = str(rec(parseJson(view.stdout))?.path_with_namespace).split("/").filter(Boolean);
  return segments.length >= 2 ? { owner: segments.slice(0, -1).join("/"), name: segments[segments.length - 1] ?? "" } : null;
}
export interface GitLabRepoDescription { provider: "gitlab"; key: string; url: string; }
export function describeGitLabRepo(owner: string, name: string, baseUrl = "https://gitlab.com"): GitLabRepoDescription {
  return { provider: "gitlab", key: `${owner}/${name}`, url: `${baseUrl.replace(/\/+$/, "")}/${owner}/${name}` };
}
export function gitLabIssueAddress(owner: string, name: string, issue: number, baseUrl = "https://gitlab.com"): { provider: "gitlab"; repoKey: string; number: number; kind: ItemKind; url: string } {
  return { provider: "gitlab", repoKey: `${owner}/${name}`, number: issue, kind: "issue", url: `${baseUrl.replace(/\/+$/, "")}/${owner}/${name}/-/issues/${issue}` };
}
export type GitLabBudget = { ok: true; known: false; reason: "not-measured" | "unavailable" } | { ok: true; known: true; limit: number; remaining: number };
function headerNumber(text: string, name: string): number | null {
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0 || line.slice(0, at).trim().toLowerCase() !== name) continue;
    const value = Number(line.slice(at + 1).trim());
    return Number.isFinite(value) ? value : null;
  }
  return null;
}
/** 额度量不到就回「未知 + 原因」，不编 0。 */
export async function readGitLabBudget(cwd?: string): Promise<GitLabBudget> {
  const result = await runGlab(["api", "version", "--include"], { cwd, timeout: SLOW });
  if (!result.ok) return { ok: true, known: false, reason: result.kind === "glab-missing" ? "not-measured" : "unavailable" };
  const text = `${result.stdout}\n${result.stderr}`;
  const limit = headerNumber(text, "ratelimit-limit");
  const remaining = headerNumber(text, "ratelimit-remaining");
  return limit !== null && remaining !== null ? { ok: true, known: true, limit, remaining } : { ok: true, known: false, reason: "unavailable" };
}
export interface GitLabPreflightFailure extends GlabFailure { stage: "env" | "auth" | "project"; }
/** 三步预检：glab 在不在、登录了没有、项目可达不可达。 */
export async function gitLabPreflight(owner?: string, name?: string): Promise<{ ok: true } | GitLabPreflightFailure> {
  const status = await runGlab(["auth", "status"], { timeout: SLOW });
  if (!status.ok) return { ...status, stage: status.kind === "glab-missing" ? "env" : "auth" };
  if (/not logged in|no token|unauthenticated/i.test(`${status.stdout}\n${status.stderr}`)) return { ...fail("glab-unauth", "glab auth status 显示没有登录态，先执行 glab auth login"), stage: "auth" };
  if (owner && name) {
    const project = await runGlab(["api", `${projectPath(owner, name)}?simple=true`], { timeout: SLOW });
    if (!project.ok) return { ...project, stage: "project" };
  }
  return { ok: true };
}
function writeFailure(error: Err, action: string): GlabWriteFailure {
  const suffix = error.sent ? "；请求可能已经写入，先刷新确认，不要直接重试" : "；这次写请求没有生效";
  return { ok: false, reason: error.reason, kind: error.kind, detail: `${action}失败（${error.detail}）${suffix}`, outcome: error.sent ? "maybe-written" : "not-written", maybeWritten: error.sent };
}
function notWritten(error: GlabFailure): GlabWriteFailure {
  return { ...error, outcome: "not-written", maybeWritten: false };
}
function uncertain(detail: string): GlabWriteFailure {
  return { ok: false, reason: "glab-failed", kind: "glab-failed", detail, outcome: "maybe-written", maybeWritten: true };
}
function invalidWrite(detail: string): GlabWriteFailure {
  return { ok: false, reason: "invalid", kind: "glab-failed", detail, outcome: "not-written", maybeWritten: false };
}
export async function postGitLabComment(owner: string, name: string, issue: number, body: string): Promise<{ ok: true; comment: IssueComment } | GlabWriteFailure> {
  if (!positive(issue)) return invalidWrite("票号必须是正整数");
  if (!body.trim()) return invalidWrite("评论内容不能为空");
  const result = await runGlab(["api", notesPath(owner, name, issue), "--method", "POST", "-f", `body=${body}`], { timeout: WRITE });
  if (!result.ok) return writeFailure(result, "发评论");
  const record = rec(parseJson(result.stdout));
  return { ok: true, comment: { author: str(rec(record?.author)?.username), createdAt: str(record?.created_at, new Date().toISOString()), body: str(record?.body, body) } };
}
const anchorLine = (key: string): string => `${ANCHOR} ${key} -->\n`;
function validAnchorKey(raw: string): string | null {
  const key = raw.trim();
  return key && key.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(key) ? key : null;
}
function anchorKeyOf(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(ANCHOR) || !trimmed.endsWith("-->")) continue;
    const key = trimmed.slice(ANCHOR.length, trimmed.length - 3).trim();
    if (key) return key;
  }
  return "";
}
type AnchorLookup = { ok: true; hit: false } | { ok: true; hit: true; issue: Issue } | GlabFailure;
/** 先搜索、再扫最近 100 张；两条路都失败或扫满仍没找到时，不能断定「没建过」。 */
async function lookupByAnchor(owner: string, name: string, key: string): Promise<AnchorLookup> {
  const search = await runGlab(["api", issuesPath(owner, name, `search=${encodeURIComponent(key)}&in=description&state=opened&per_page=${PER_PAGE}&with_labels_details=true`)]);
  if (search.ok) {
    const rows = parseJson(search.stdout);
    if (!Array.isArray(rows)) return fail("glab-failed", "建票回查的搜索结果不是数组，拿不准是否已经建过");
    const hit = rows.find((row) => anchorKeyOf(str(rec(row)?.description)) === key);
    const mapped = hit ? mapGitLabIssues([hit])[0] : undefined;
    if (mapped) return { ok: true, hit: true, issue: mapped };
  }
  const scan = await runGlab(["api", issuesPath(owner, name, `state=opened&order_by=created_at&sort=desc&per_page=${PER_PAGE}&with_labels_details=true`)], { timeout: SLOW });
  if (!scan.ok) {
    if (!search.ok) return fail("glab-failed", `建票回查的两条路都没跑通（搜索：${search.detail}；列表：${scan.detail}），拿不准是否已经建过`);
    return fail("glab-failed", `建票回查的列表路没跑通（${scan.detail}），搜索没搜到不能算数`);
  }
  const rows = parseJson(scan.stdout);
  if (!Array.isArray(rows)) return fail("glab-failed", "建票回查的列表回包不是数组，拿不准是否已经建过");
  for (const row of rows) {
    if (anchorKeyOf(str(rec(row)?.description)) !== key) continue;
    const mapped = mapGitLabIssues([row])[0];
    if (mapped) return { ok: true, hit: true, issue: mapped };
  }
  if (rows.length >= PER_PAGE) return fail("glab-failed", `按创建时间倒序看完前 ${PER_PAGE} 张还没找到锚 ${key}，仓库更大时不敢断定「还没建过」`);
  return { ok: true, hit: false };
}
export interface CreateGitLabIssueInput { title: string; body: string; labels?: readonly string[]; idempotencyKey?: string; parentKey?: number | null; }
/** 建票只有一条写路径；回查不确定时失败，绝不「先建了再说」。 */
export async function createGitLabIssue(owner: string, name: string, input: CreateGitLabIssueInput): Promise<{ ok: true; number: number; url: string; labels: string[]; labelsFailed: boolean; reused: boolean } | GlabWriteFailure> {
  const title = input.title.trim();
  if (!title) return invalidWrite("标题不能为空");
  if (title.length > 256) return invalidWrite("标题过长（上限 256 字）");
  const wanted = [...new Set((input.labels ?? []).map((label) => label.trim()).filter(Boolean))];
  const rawKey = input.idempotencyKey ?? "";
  const key = rawKey ? validAnchorKey(rawKey) : "";
  if (rawKey && !key) return invalidWrite("幂等键只能包含字母、数字、点、下划线、连字符、冒号和斜杠，长度 1–200");
  if (key) {
    const found = await lookupByAnchor(owner, name, key);
    if (!found.ok) return notWritten(found);
    if (found.hit) return { ok: true, number: found.issue.number, url: found.issue.url, labels: found.issue.labels.map((label) => label.name), labelsFailed: false, reused: true };
  }
  let description = key ? `${anchorLine(key)}${input.body ?? ""}` : input.body ?? "";
  if (input.parentKey != null) description = rewritePartOfLine(description, input.parentKey);
  const args = ["api", issuesPath(owner, name), "--method", "POST", "-f", `title=${title}`];
  if (description) args.push("-f", `description=${description}`);
  if (wanted.length) args.push("-f", `labels=${wanted.join(",")}`);
  const result = await runGlab(args, { timeout: WRITE });
  if (!result.ok) {
    if (result.kind === "glab-missing" || result.kind === "glab-unauth" || result.kind === "glab-forbidden" || result.kind === "read-only-project") return notWritten(result);
    const base = writeFailure(result, "建票");
    return result.sent
      ? { ...base, maybeCreated: true, detail: `${base.detail}${key ? `；重试时带同一个幂等键 ${key}，会先按锚回查` : "；重试前先刷新任务板，确认没有多出一张票"}` }
      : { ...base, maybeCreated: false };
  }
  const record = rec(parseJson(result.stdout));
  const number = Number(record?.iid);
  if (!positive(number)) return { ...uncertain(`建票回包缺少票号，票可能已经建好${key ? `（幂等键 ${key}）` : ""}，先刷新任务板确认`), maybeCreated: true };
  const returned = mapLabels(record?.labels).map((label) => label.name);
  return { ok: true, number, url: str(record?.web_url), labels: returned.length ? returned : wanted, labelsFailed: false, reused: false };
}
async function writeState(owner: string, name: string, issue: number, state: "open" | "closed"): Promise<{ ok: true; state: "OPEN" | "CLOSED" } | GlabWriteFailure> {
  if (!positive(issue)) return invalidWrite("票号必须是正整数");
  const result = await runGlab(["api", issuePath(owner, name, issue), "--method", "PUT", "-f", `state_event=${state === "closed" ? "close" : "reopen"}`], { timeout: WRITE });
  if (!result.ok) return writeFailure(result, state === "closed" ? "关闭这张票" : "重开这张票");
  return { ok: true, state: state === "closed" ? "CLOSED" : "OPEN" };
}
export const closeGitLabIssue = (owner: string, name: string, issue: number) => writeState(owner, name, issue, "closed");
export const reopenGitLabIssue = (owner: string, name: string, issue: number) => writeState(owner, name, issue, "open");
export interface GitLabIssuePatch { title?: string; body?: string; state?: "open" | "closed"; milestoneId?: number; }
/** 只发用户明确给出的字段；回包读不回来时按发出去的值回填。 */
export async function updateGitLabIssue(owner: string, name: string, issue: number, patch: GitLabIssuePatch): Promise<{ ok: true; title: string; body: string; state: "OPEN" | "CLOSED" } | GlabWriteFailure> {
  if (!positive(issue)) return invalidWrite("票号必须是正整数");
  const title = patch.title?.trim();
  if (title !== undefined && !title) return invalidWrite("标题不能为空");
  if (title !== undefined && title.length > 256) return invalidWrite("标题过长（上限 256 字）");
  if (title === undefined && patch.body === undefined && patch.state === undefined && patch.milestoneId === undefined) return invalidWrite("至少给一个要改的字段（title / body / state / milestoneId）");
  const args = ["api", issuePath(owner, name, issue), "--method", "PUT"];
  if (title !== undefined) args.push("-f", `title=${title}`);
  if (patch.body !== undefined) args.push("-f", `description=${patch.body}`);
  if (patch.state !== undefined) args.push("-f", `state_event=${patch.state === "closed" ? "close" : "reopen"}`);
  if (patch.milestoneId !== undefined) args.push("-f", `milestone_id=${patch.milestoneId}`);
  const result = await runGlab(args, { timeout: WRITE });
  if (!result.ok) return writeFailure(result, "修改这张票");
  const record = rec(parseJson(result.stdout));
  return { ok: true, title: str(record?.title, title ?? ""), body: str(record?.description, patch.body ?? ""), state: str(record?.state) === "closed" || patch.state === "closed" ? "CLOSED" : "OPEN" };
}
/** 整体替换标签；空数组就是清空。 */
export async function setGitLabLabels(owner: string, name: string, issue: number, labels: readonly string[]): Promise<{ ok: true; labels: { name: string; color: string }[] } | GlabWriteFailure> {
  if (!positive(issue)) return invalidWrite("票号必须是正整数");
  const wanted = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  const result = await runGlab(["api", issuePath(owner, name, issue), "--method", "PUT", "-f", `labels=${wanted.join(",")}`], { timeout: WRITE });
  if (!result.ok) return writeFailure(result, "替换标签");
  const mapped = mapLabels(rec(parseJson(result.stdout))?.labels);
  return { ok: true, labels: mapped.length ? mapped : wanted.map((name) => ({ name, color: "cccccc" })) };
}
async function resolveUserIds(usernames: readonly string[]): Promise<{ ok: true; ids: number[] } | GlabFailure> {
  const ids: number[] = [];
  for (const username of usernames) {
    const result = await runGlab(["api", `users?username=${encodeURIComponent(username)}`]);
    if (!result.ok) return { ...result, detail: `查找 GitLab 用户 ${username} 失败：${result.detail}` };
    const rows = parseJson(result.stdout);
    const id = Array.isArray(rows) ? Number(rec(rows[0])?.id) : NaN;
    if (!positive(id)) return invalid(`GitLab 上找不到用户 ${username}，这次指派没有写入`);
    ids.push(id);
  }
  return { ok: true, ids };
}
export async function setGitLabAssignees(owner: string, name: string, issue: number, usernames: readonly string[]): Promise<{ ok: true; assignees: string[] } | GlabWriteFailure> {
  if (!positive(issue)) return invalidWrite("票号必须是正整数");
  const wanted = [...new Set(usernames.map((entry) => entry.trim()).filter(Boolean))];
  const resolved = await resolveUserIds(wanted);
  if (!resolved.ok) return notWritten(resolved);
  const result = await runGlab(["api", issuePath(owner, name, issue), "--method", "PUT", "-f", `assignee_ids=${resolved.ids.join(",")}`], { timeout: WRITE });
  if (!result.ok) return writeFailure(result, "替换指派人");
  const record = rec(parseJson(result.stdout));
  const assignees = (Array.isArray(record?.assignees) ? record.assignees : []).map((entry) => str(rec(entry)?.username)).filter(Boolean);
  return { ok: true, assignees: assignees.length ? assignees : wanted };
}
/** 先读现有指派人再增删，避免把别人的指派覆盖掉。 */
export async function takeGitLabIssue(owner: string, name: string, issue: number, take: boolean): Promise<{ ok: true; login: string; assignees: string[] } | GlabWriteFailure> {
  if (!positive(issue)) return invalidWrite("票号必须是正整数");
  const me = await getGitLabCurrentUser();
  if (!me.ok) return notWritten(me);
  const raw = await fetchIssueRaw(owner, name, issue);
  if (!raw.ok) return notWritten(raw);
  const current = (Array.isArray(raw.record.assignees) ? raw.record.assignees : []).map((entry) => str(rec(entry)?.username)).filter(Boolean);
  const written = await setGitLabAssignees(owner, name, issue, take ? [...new Set([...current, me.login])] : current.filter((login) => login !== me.login));
  return written.ok ? { ok: true, login: me.login, assignees: written.assignees } : written;
}
export async function setGitLabParent(owner: string, name: string, issue: number, parent: number | null): Promise<{ ok: true; parentKey: string | null } | GlabWriteFailure> {
  if (!positive(issue)) return invalidWrite("票号必须是正整数");
  if (parent !== null && (!positive(parent) || parent === issue)) return invalidWrite("父票号必须是另一个正整数");
  const raw = await fetchIssueRaw(owner, name, issue);
  if (!raw.ok) return notWritten(raw);
  const oldBody = str(raw.record.description);
  const newBody = rewritePartOfLine(oldBody, parent);
  if (newBody === oldBody) return { ok: true, parentKey: parent === null ? null : String(parent) };
  const written = await runGlab(["api", issuePath(owner, name, issue), "--method", "PUT", "-f", `description=${newBody}`], { timeout: WRITE });
  if (!written.ok) return writeFailure(written, "写归属行");
  const back = await fetchIssueRaw(owner, name, issue);
  if (!back.ok || parsePartOfLine(str(back.record.description)) !== (parent === null ? null : String(parent))) return uncertain("归属行写入后读回不一致，远端可能已被改动，先刷新确认");
  return { ok: true, parentKey: parent === null ? null : String(parent) };
}
function capabilityError(error: Err): boolean {
  return error.kind === "glab-forbidden" || error.kind === "not-found" || error.kind === "read-only-project" || /\b400\b|premium|licen[cs]e|not support|unsupported/i.test(error.detail);
}
type CycleCheck = { ok: true; cycle: boolean } | { ok: false; detail: string };
async function hasBlockingCycle(owner: string, name: string, start: number, wanted: readonly number[]): Promise<CycleCheck> {
  const seen = new Set<string>();
  const stack = wanted.map(String);
  while (stack.length > 0) {
    // 没走完的链不能当成「没有环」：上限只用来防失控，触顶要如实报未知。
    if (seen.size >= 200) return { ok: false, detail: "阻塞链超过 200 张票还没走完，无法确认不成环" };
    const key = stack.pop() ?? "";
    if (key === String(start)) return { ok: true, cycle: true };
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const raw = await fetchIssueRaw(owner, name, Number(key));
    // 读不到节点就不能说「没有环」：把结论标成未知，调用方宁可不写。
    if (!raw.ok) return { ok: false, detail: `读不到阻塞链上的 #${key}（${raw.detail}）` };
    const native = await readNativeLinks(owner, name, Number(key));
    // 只有「这个版本不支持原生边」才退回正文行；超时 / 5xx 这类读失败不能退，
    // 否则原生边会全部隐身，成环预检会把有环的链看成一条空链。
    if (!native.ok && !capabilityError(native)) {
      return { ok: false, detail: `读不到 #${key} 的原生阻塞边（${native.detail}）` };
    }
    const keys = native.ok && native.links.keys.length ? native.links.keys : parseBlockedByLine(str(raw.record.description));
    for (const next of keys) if (!seen.has(next)) stack.push(next);
  }
  return { ok: true, cycle: false };
}
interface NativeState { keys: string[]; linkId: (key: string) => string; }
async function nativeState(owner: string, name: string, issue: number): Promise<NativeState | null> {
  const links = await readNativeLinks(owner, name, issue);
  if (!links.ok) return null;
  return { keys: links.links.keys, linkId: (key) => { const row = links.links.rows.find((item) => linkKey(item) === key); return row ? idText(row.issue_link_id) || idText(row.link_id) || idText(row.id) : ""; } };
}
/** 原生边真写；能力错误且滚回干净时交给正文行回退。 */
async function applyNative(owner: string, name: string, issue: number, projectId: number, wanted: readonly number[], state: NativeState): Promise<{ ok: true } | { ok: false; fallback: true } | { ok: false; fallback: false; failure: GlabWriteFailure }> {
  const wantedKeys = wanted.map(String);
  const added: string[] = [];
  for (const target of wanted) {
    if (state.keys.includes(String(target))) continue;
    const result = await runGlab(["api", linksPath(owner, name, issue), "--method", "POST", "-f", `target_project_id=${projectId}`, "-f", `target_issue_iid=${target}`, "-f", "link_type=is_blocked_by"], { timeout: WRITE });
    if (result.ok) {
      const id = idText(rec(parseJson(result.stdout))?.issue_link_id);
      if (id) added.push(id);
      continue;
    }
    if (!capabilityError(result)) return { ok: false, fallback: false, failure: { ...writeFailure(result, `加原生阻塞边 #${target}`), outcome: "maybe-written", maybeWritten: true } };
    for (const id of added) await runGlab(["api", `${linksPath(owner, name, issue)}/${id}`, "--method", "DELETE"], { timeout: WRITE });
    const verify = await nativeState(owner, name, issue);
    const leftovers = verify ? verify.keys.filter((key) => wantedKeys.includes(key) && !state.keys.includes(key)) : ["读回失败"];
    return leftovers.length > 0 ? { ok: false, fallback: false, failure: uncertain(`原生阻塞边加上后滚不干净（残留 ${leftovers.join(", ")}），不敢再写正文行`) } : { ok: false, fallback: true };
  }
  for (const key of state.keys) {
    if (wantedKeys.includes(key)) continue;
    const id = state.linkId(key);
    if (!id) return { ok: false, fallback: false, failure: { ok: false, reason: "glab-failed", kind: "glab-failed", detail: `原生阻塞边 #${key} 没有 link id，删不掉；加边可能已经成功`, outcome: "maybe-written", maybeWritten: true } };
    const result = await runGlab(["api", `${linksPath(owner, name, issue)}/${id}`, "--method", "DELETE"], { timeout: WRITE });
    if (!result.ok) return { ok: false, fallback: false, failure: writeFailure(result, `删原生阻塞边 #${key}`) };
  }
  const back = await nativeState(owner, name, issue);
  const keys = back?.keys ?? null;
  const missing = keys ? wantedKeys.filter((key) => !keys.includes(key)) : wantedKeys;
  const extra = keys ? keys.filter((key) => !wantedKeys.includes(key)) : [];
  if (!keys || missing.length > 0 || extra.length > 0) {
    return { ok: false, fallback: false, failure: { ok: false, reason: "glab-failed", kind: "glab-failed", detail: `原生阻塞边写后读回不一致（缺 ${missing.join(", ") || "无"}，多 ${extra.join(", ") || "无"}）`, outcome: "maybe-written", maybeWritten: true } };
  }
  return { ok: true };
}
async function applyDescription(owner: string, name: string, issue: number, wanted: readonly number[], oldBody: string): Promise<{ ok: true; source: "description" } | GlabWriteFailure> {
  const newBody = rewriteBlockedByLine(oldBody, wanted.map(String));
  if (newBody === oldBody) return { ok: true, source: "description" };
  const written = await runGlab(["api", issuePath(owner, name, issue), "--method", "PUT", "-f", `description=${newBody}`], { timeout: WRITE });
  if (!written.ok) return writeFailure(written, "写阻塞行");
  const back = await fetchIssueRaw(owner, name, issue);
  const got = back.ok ? parseBlockedByLine(str(back.record.description)).sort() : [];
  const want = wanted.map(String).sort();
  if (!back.ok || got.join(",") !== want.join(",")) return uncertain("阻塞行写入后读回不一致，远端可能已被改动，先刷新确认");
  return { ok: true, source: "description" };
}
/** 原生边优先，能力不足回退正文行；两条路都做写后读回。 */
export async function setGitLabBlockedBy(owner: string, name: string, issue: number, blockers: readonly number[]): Promise<{ ok: true; blockers: number[]; source: "native" | "description" } | GlabWriteFailure> {
  if (!positive(issue)) return invalidWrite("票号必须是正整数");
  const wanted = [...new Set(blockers)];
  if (wanted.some((blocker) => !positive(blocker))) return invalidWrite("阻塞者票号必须是正整数");
  if (wanted.includes(issue)) return invalidWrite("一张票不能阻塞自己");
  const raw = await fetchIssueRaw(owner, name, issue);
  if (!raw.ok) return notWritten(raw);
  const cycle = await hasBlockingCycle(owner, name, issue, wanted);
  if (!cycle.ok) {
    // 预检本身没跑完：不能当成「确认无环」。这次没有发出任何写请求。
    return {
      ok: false,
      reason: "glab-failed",
      kind: "glab-failed",
      detail: `成环预检没跑完：${cycle.detail}；无法确认是否成环，这次没有写入`,
      outcome: "not-written",
      maybeWritten: false,
    };
  }
  if (cycle.cycle) return invalidWrite("这次阻塞会形成环（沿着阻塞关系最终绕回这张票），没有写入");
  const oldBody = str(raw.record.description);
  const native = await nativeState(owner, name, issue);
  const projectId = Number(raw.record.project_id);
  if (native && positive(projectId)) {
    const applied = await applyNative(owner, name, issue, projectId, wanted, native);
    if (applied.ok) return { ok: true, blockers: wanted, source: "native" };
    if (!applied.fallback) return applied.failure;
  }
  const fallback = await applyDescription(owner, name, issue, wanted, oldBody);
  return fallback.ok ? { ok: true, blockers: wanted, source: "description" } : fallback;
}
export interface GitLabLabelColorChange { name: string; color: string; }
/** 批量改色：逐条记账、不回滚；一条不合格整批拒绝。 */
export async function setGitLabLabelColors(owner: string, name: string, changes: readonly GitLabLabelColorChange[]): Promise<{ ok: true; applied: { name: string; color: string }[]; failed: { name: string; color: string; detail: string }[] } | GlabFailure> {
  const wanted = changes.map((change) => ({ name: change.name.trim(), color: change.color.trim().replace(/^#/, "").toLowerCase() }));
  const bad = wanted.find((change) => !change.name || !/^[0-9a-f]{6}$/.test(change.color));
  if (bad) return invalid(`标签「${bad.name || "未命名"}」的颜色不是六位十六进制（例如 #9d7cd8），整批没有写入`);
  const applied: { name: string; color: string }[] = [];
  const failed: { name: string; color: string; detail: string }[] = [];
  for (const change of wanted) {
    const result = await runGlab(["api", `${projectPath(owner, name)}/labels/${encodeURIComponent(change.name)}`, "--method", "PUT", "-f", `color=#${change.color}`], { timeout: WRITE });
    if (result.ok) applied.push({ name: change.name, color: change.color });
    else failed.push({ name: change.name, color: change.color, detail: result.detail });
  }
  return { ok: true, applied, failed };
}
function createdProject(stdout: string): { refId: string; url: string } | null {
  for (const raw of stdout.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const cleaned = raw.replace(/[)\]},.;:'"]+$/, "");
    const parsed = parseGitLabRemote(cleaned);
    if (parsed) return { refId: `${parsed.owner}/${parsed.name}`, url: cleaned.replace(/\.git$/i, "").replace(/\/+$/, "") };
  }
  return null;
}
async function readCreatedProject(login: string, name: string): Promise<{ refId: string; url: string } | null> {
  const result = await runGlab(["api", projectPath(login, name)], { timeout: SLOW });
  if (!result.ok) return null;
  const record = rec(parseJson(result.stdout));
  const web = str(record?.web_url).trim() || str(record?.http_url_to_repo).trim();
  if (!web) return null;
  const parsed = parseGitLabRemote(web);
  const refId = str(record?.path_with_namespace).trim() || (parsed ? `${parsed.owner}/${parsed.name}` : "");
  return refId.split("/").filter(Boolean).length >= 2 ? { refId, url: web.replace(/\.git$/i, "").replace(/\/+$/, "") } : null;
}
async function ensureCommit(workspaceDir: string): Promise<GlabWriteFailure | null> {
  const inside = await runGit(["-C", workspaceDir, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    const init = await runGit(["-C", workspaceDir, "init"]);
    if (!init.ok) return notWritten(init);
  }
  const added = await runGit(["-C", workspaceDir, "add", "."]);
  if (!added.ok) return notWritten(added);
  let commit = await runGit(["-C", workspaceDir, "commit", "-m", "initial commit", "--allow-empty"]);
  if (!commit.ok && /please tell me who you are|user\.name|user\.email|author identity unknown|unable to auto-detect email/i.test(commit.detail)) {
    await runGit(["-C", workspaceDir, "config", "user.email", "deck@local"]);
    await runGit(["-C", workspaceDir, "config", "user.name", "Deck"]);
    commit = await runGit(["-C", workspaceDir, "commit", "-m", "initial commit", "--allow-empty"]);
  }
  return commit.ok ? null : notWritten(commit);
}
/** 建远端后任何一步失败都要说清「远端已经存在」。 */
export async function initGitLabProject(workspaceDir: string, input: { name: string; visibility?: "private" | "public" | "internal" }): Promise<{ ok: true; refId: string; url: string } | GlabWriteFailure> {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return invalidWrite("仓库名只支持字母、数字、点、下划线、连字符，最长 100 个字符");
  const visibility = input.visibility ?? "private";
  const user = await getGitLabCurrentUser();
  if (!user.ok) return notWritten(user);
  const version = await runGit(["--version"]);
  if (!version.ok) return notWritten(version);
  const commitError = await ensureCommit(workspaceDir);
  if (commitError) return commitError;
  const created = await runGlab(["repo", "create", name, visibility === "public" ? "--public" : visibility === "internal" ? "--internal" : "--private", "--skipGitInit"], { cwd: workspaceDir, timeout: 120_000 });
  if (!created.ok) return writeFailure(created, "创建 GitLab 项目（远端可能还没有建出来，先刷新确认）");
  const remote = createdProject(created.stdout) ?? (await readCreatedProject(user.login, name));
  if (!remote) return { ok: false, reason: "glab-failed", kind: "glab-failed", detail: "远端仓库已经建好，但认不出它的地址；已停下，没有配置 origin", outcome: "maybe-written", maybeWritten: true };
  const remoteUrl = `${remote.url.replace(/\.git$/i, "")}.git`;
  const existing = await runGit(["-C", workspaceDir, "remote", "get-url", "origin"]);
  const wired = existing.ok ? await runGit(["-C", workspaceDir, "remote", "set-url", "origin", remoteUrl]) : await runGit(["-C", workspaceDir, "remote", "add", "origin", remoteUrl]);
  if (!wired.ok) return { ok: false, reason: "glab-failed", kind: "glab-failed", detail: "远端仓库已经建好了，但 origin 没配上，本地提交还在", outcome: "maybe-written", maybeWritten: true };
  const pushed = await runGit(["-C", workspaceDir, "push", "-u", "origin", "HEAD"]);
  if (!pushed.ok) return { ok: false, reason: "glab-failed", kind: "glab-failed", detail: "远端仓库已经建好了，但 git push 没推上去；本地提交还在，修好后重推即可", outcome: "maybe-written", maybeWritten: true };
  return { ok: true, refId: remote.refId, url: remote.url };
}
