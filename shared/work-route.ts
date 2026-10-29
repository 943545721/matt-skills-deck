/**
 * Agent ↔ 工作票台账。
 *
 * 台账只回答一件事：这个（或这组）会话手上挂着哪些票、各自到哪一步了。
 * 它不复制票面正文，也不代替 GitHub / GitLab / 本地后端的状态；
 * 票的真相在远端，台账记录的是「谁接过手、做到哪、什么时候放的」。
 *
 * 纯函数：解析、状态转换、汇总、修剪都在这里，服务端只负责加锁落盘。
 */

export const WORK_ROUTE_VERSION = 1 as const;
/** 与 DSH 一致：30 天没动过的收尾记录可以清掉。 */
export const WORK_ROUTE_MAX_AGE_DAYS = 30;
/** 单个作用域的条目上限，防止长期运行时文件无限增长。 */
export const WORK_ROUTE_MAX_ENTRIES = 500;

export type WorkRouteStatus = "attached" | "in-progress" | "done" | "released";

const STATUSES: readonly WorkRouteStatus[] = ["attached", "in-progress", "done", "released"];

export interface WorkRouteTicket {
  repoKey: string | null;
  number: number;
  title: string;
  url?: string | null;
}

export interface WorkRouteEntry {
  /** `owner/name#12`；本地仓库用后端给的 key，缺省 `local#12`。 */
  ticketKey: string;
  repoKey: string | null;
  number: number;
  title: string;
  url: string | null;
  status: WorkRouteStatus;
  /** 最近一次接手这张票的 agent；释放后保留，便于查历史。 */
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  note: string | null;
}

export interface WorkRouteLedger {
  version: typeof WORK_ROUTE_VERSION;
  updatedAt: string;
  entries: WorkRouteEntry[];
}

export function ticketKeyOf(repoKey: string | null | undefined, number: number): string {
  const repo = repoKey?.trim() || "local";
  return `${repo}#${number}`;
}

/** 从 `owner/name#12` 反解；格式不对时返回 null，调用方按未知票处理。 */
export function parseTicketKey(key: string): { repoKey: string; number: number } | null {
  const match = /^(.*)#(\d+)$/.exec(key.trim());
  if (!match) return null;
  const repoKey = match[1] ?? "";
  const number = Number(match[2]);
  if (!repoKey || !Number.isInteger(number) || number <= 0) return null;
  return { repoKey, number };
}

export function emptyWorkRouteLedger(now = new Date(0).toISOString()): WorkRouteLedger {
  return { version: WORK_ROUTE_VERSION, updatedAt: now, entries: [] };
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEntry(value: unknown, fallbackAt: string): WorkRouteEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const status = typeof record.status === "string" && (STATUSES as readonly string[]).includes(record.status)
    ? (record.status as WorkRouteStatus)
    : null;
  if (!status) return null;
  const number = typeof record.number === "number" && Number.isInteger(record.number) && record.number > 0
    ? record.number
    : null;
  if (number === null) return null;
  const repoKey = typeof record.repoKey === "string" && record.repoKey.trim() ? record.repoKey.trim() : null;
  const ticketKey = typeof record.ticketKey === "string" && record.ticketKey.trim()
    ? record.ticketKey.trim()
    : ticketKeyOf(repoKey, number);
  const createdAt = isIso(record.createdAt) ? record.createdAt : fallbackAt;
  const updatedAt = isIso(record.updatedAt) ? record.updatedAt : createdAt;
  return {
    ticketKey,
    repoKey,
    number,
    title: typeof record.title === "string" ? record.title.trim() : "",
    url: typeof record.url === "string" && record.url.trim() ? record.url.trim() : null,
    status,
    agentId: typeof record.agentId === "string" && record.agentId.trim() ? record.agentId.trim() : null,
    createdAt,
    updatedAt,
    note: typeof record.note === "string" && record.note.trim() ? record.note.trim() : null,
  };
}

export type WorkRouteParseResult =
  | { ok: true; ledger: WorkRouteLedger; dropped: number }
  | { ok: false; reason: "not-json" | "not-ledger"; detail: string };

/**
 * 容错解析：整体结构不对才判损坏；单条记录缺字段只丢弃该条并计数，
 * 不因为一条坏记录把整个作用域的台账清空。
 */
export function parseWorkRouteLedger(text: string): WorkRouteParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: "not-json", detail: error instanceof Error ? error.message : String(error) };
  }
  const record = asRecord(raw);
  if (!record) return { ok: false, reason: "not-ledger", detail: "顶层不是对象" };
  if (!Array.isArray(record.entries)) return { ok: false, reason: "not-ledger", detail: "缺少 entries 数组" };
  if (record.version !== undefined && record.version !== WORK_ROUTE_VERSION) {
    return { ok: false, reason: "not-ledger", detail: `不认识的版本 ${String(record.version)}` };
  }
  const rawEntries = record.entries;
  const fallbackAt = isIso(record.updatedAt) ? record.updatedAt : new Date(0).toISOString();
  const entries: WorkRouteEntry[] = [];
  let dropped = 0;
  for (const item of rawEntries) {
    const entry = parseEntry(item, fallbackAt);
    if (entry) entries.push(entry);
    else dropped += 1;
  }
  const updatedAt = isIso(record.updatedAt)
    ? record.updatedAt
    : entries.reduce((latest, entry) => (Date.parse(entry.updatedAt) > Date.parse(latest) ? entry.updatedAt : latest), fallbackAt);
  return {
    ok: true,
    ledger: { version: WORK_ROUTE_VERSION, updatedAt, entries: sortEntries(entries) },
    dropped,
  };
}

function sortEntries(entries: WorkRouteEntry[]): WorkRouteEntry[] {
  return [...entries].sort((left, right) => {
    const delta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return delta !== 0 ? delta : left.ticketKey.localeCompare(right.ticketKey);
  });
}

export function serializeWorkRouteLedger(ledger: WorkRouteLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export type WorkRouteEvent =
  | { kind: "attach"; ticket: WorkRouteTicket; agentId?: string | null; at: string; note?: string }
  | { kind: "progress"; ticketKey: string; at: string; note?: string }
  | { kind: "done"; ticketKey: string; at: string; note?: string }
  | { kind: "release"; ticketKey: string; at: string; note?: string };

function findEntry(entries: readonly WorkRouteEntry[], ticketKey: string): WorkRouteEntry | undefined {
  return entries.find((entry) => entry.ticketKey === ticketKey);
}

function replaceEntry(ledger: WorkRouteLedger, next: WorkRouteEntry, at: string): WorkRouteLedger {
  return {
    version: WORK_ROUTE_VERSION,
    updatedAt: at,
    entries: sortEntries(ledger.entries.map((entry) => (entry.ticketKey === next.ticketKey ? next : entry))),
  };
}

/**
 * 状态转换。
 *
 * `attached → in-progress → done`，`released` 是「这个 agent 不再持有」的终态；
 * 之后再 attach 会重新打开（票被重新捡起），历史时间由 createdAt 保留。
 * 未知票的 progress / done / release 直接忽略，不凭空造一条没有标题的记录。
 */
export function applyWorkRouteEvent(ledger: WorkRouteLedger, event: WorkRouteEvent): WorkRouteLedger {
  if (event.kind === "attach") {
    const repoKey = event.ticket.repoKey?.trim() || null;
    const ticketKey = ticketKeyOf(repoKey, event.ticket.number);
    const existing = findEntry(ledger.entries, ticketKey);
    const entry: WorkRouteEntry = {
      ticketKey,
      repoKey,
      number: event.ticket.number,
      title: event.ticket.title.trim(),
      url: event.ticket.url?.trim() || null,
      status: "attached",
      agentId: event.agentId?.trim() || existing?.agentId || null,
      createdAt: existing?.createdAt ?? event.at,
      updatedAt: event.at,
      note: event.note?.trim() || existing?.note || null,
    };
    const entries = existing
      ? ledger.entries.map((item) => (item.ticketKey === ticketKey ? entry : item))
      : [...ledger.entries, entry];
    return { version: WORK_ROUTE_VERSION, updatedAt: event.at, entries: sortEntries(entries) };
  }

  const existing = findEntry(ledger.entries, event.ticketKey);
  if (!existing) return ledger;
  const status: WorkRouteStatus =
    event.kind === "progress" ? "in-progress" : event.kind === "done" ? "done" : "released";
  return replaceEntry(
    ledger,
    {
      ...existing,
      status,
      updatedAt: event.at,
      note: event.note?.trim() || existing.note,
    },
    event.at,
  );
}

export interface AgentTicketSyncInput {
  agentId: string;
  tickets: readonly WorkRouteTicket[];
  at: string;
  /** true 时把本 agent 名下、不在清单里的票标为 released。 */
  replace?: boolean;
}

/** 把一次会话快照里看到的票同步进台账；批量操作只改自己的记录。 */
export function syncAgentTickets(ledger: WorkRouteLedger, input: AgentTicketSyncInput): WorkRouteLedger {
  const seen = new Set(input.tickets.map((ticket) => ticketKeyOf(ticket.repoKey, ticket.number)));
  const attached = input.tickets.reduce(
    (current, ticket) =>
      applyWorkRouteEvent(current, { kind: "attach", ticket, agentId: input.agentId, at: input.at }),
    ledger,
  );
  if (!input.replace) return attached;
  return attached.entries.reduce((current, entry) => {
    if (entry.agentId !== input.agentId || seen.has(entry.ticketKey) || entry.status === "released") {
      return current;
    }
    return applyWorkRouteEvent(current, { kind: "release", ticketKey: entry.ticketKey, at: input.at });
  }, attached);
}

export function entriesForAgent(ledger: WorkRouteLedger, agentId: string): WorkRouteEntry[] {
  return ledger.entries.filter((entry) => entry.agentId === agentId);
}

export function entryForTicket(ledger: WorkRouteLedger, ticketKey: string): WorkRouteEntry | null {
  return ledger.entries.find((entry) => entry.ticketKey === ticketKey) ?? null;
}

export interface WorkRouteSummary {
  total: number;
  attached: number;
  inProgress: number;
  done: number;
  released: number;
  /** 还在手上的票（attached + in-progress）。 */
  active: number;
  /** 有正在做的票；释放前应先看这个值，避免把进行中的工作当闲置放掉。 */
  hasWork: boolean;
  /** 最近更新的活跃票；没有活跃票时为 null。 */
  currentTicketKey: string | null;
  lastUpdatedAt: string | null;
}

export function summarizeWorkRoute(ledger: WorkRouteLedger): WorkRouteSummary {
  const summary: WorkRouteSummary = {
    total: ledger.entries.length,
    attached: 0,
    inProgress: 0,
    done: 0,
    released: 0,
    active: 0,
    hasWork: false,
    currentTicketKey: null,
    lastUpdatedAt: ledger.entries.reduce<string | null>(
      (latest, entry) => (latest === null || Date.parse(entry.updatedAt) > Date.parse(latest) ? entry.updatedAt : latest),
      null,
    ),
  };
  for (const entry of ledger.entries) {
    if (entry.status === "attached") summary.attached += 1;
    if (entry.status === "in-progress") summary.inProgress += 1;
    if (entry.status === "done") summary.done += 1;
    if (entry.status === "released") summary.released += 1;
  }
  summary.active = summary.attached + summary.inProgress;
  summary.hasWork = summary.inProgress > 0;
  summary.currentTicketKey =
    ledger.entries.find((entry) => entry.status === "attached" || entry.status === "in-progress")?.ticketKey ?? null;
  return summary;
}

export interface PruneWorkRouteOptions {
  /** 毫秒时间戳或 ISO 字符串；缺省当前时间。 */
  now?: number | string;
  maxAgeDays?: number;
  maxEntries?: number;
}

/**
 * 保留策略：
 * - 已收尾（done / released）且超过保留期的记录清掉；还在手上的票不按时间清，
 *   避免长任务在第 31 天突然从工作路线上消失。
 * - 仍超过条目上限时，从最旧的收尾记录开始删；只有收尾记录删完还不够，才动最旧的活跃记录。
 */
export function pruneWorkRouteLedger(
  ledger: WorkRouteLedger,
  options: PruneWorkRouteOptions = {},
): WorkRouteLedger {
  const nowMs =
    typeof options.now === "number"
      ? options.now
      : options.now
        ? Date.parse(options.now)
        : Date.now();
  const maxAgeDays = options.maxAgeDays ?? WORK_ROUTE_MAX_AGE_DAYS;
  const maxEntries = options.maxEntries ?? WORK_ROUTE_MAX_ENTRIES;
  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;

  const kept = ledger.entries.filter((entry) => {
    if (Date.parse(entry.updatedAt) >= cutoff) return true;
    return entry.status === "attached" || entry.status === "in-progress";
  });
  if (kept.length <= maxEntries) {
    return { ...ledger, entries: sortEntries(kept) };
  }
  const finished = kept.filter((entry) => entry.status === "done" || entry.status === "released");
  const active = kept.filter((entry) => entry.status === "attached" || entry.status === "in-progress");
  const finishedBudget = Math.max(0, maxEntries - Math.min(active.length, maxEntries));
  const keptFinished = sortEntries(finished).slice(0, finishedBudget);
  const keptActive = sortEntries(active).slice(0, maxEntries - keptFinished.length);
  return { ...ledger, entries: sortEntries([...keptActive, ...keptFinished]) };
}
