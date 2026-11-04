/**
 * 岗位履历（检索，不存储）。
 *
 * 岗位卡不常驻：会话干完就归档，下一轮派单是一个全新的会话。
 * 所以「这个岗位在本项目此前做过什么」只能每次现拼——反查挂了 `deck.staff`
 * 标签的历史会话，读它们留下的回传件与 `deck.ticket` 指向的未关闭票，
 * 拼成一段话交给调用方放进 systemPrompt。
 *
 * 两条硬口径：
 * 1. **只检索，不落摘要文件**。回传件已经是结构化产物，再写一份摘要会变成第二个真相源；
 * 2. **失败方向是放行**。履历只是锦上添花，读不到、读坏了、宿主列表报错都不该挡住派单，
 *    所以这个模块的公开函数**不抛异常**，问题一律进 `warnings`。
 */

import { DECK_STAFF_LABEL } from "../shared/staff.ts";
import { DECK_TICKET_LABEL } from "../shared/orchestration.ts";
import { readChildHandoff, type ChildHandoffRecord } from "./handoff-store.ts";
import { resolveBackend } from "./tracker/backend.ts";
import { getIssue } from "./tracker/github.ts";
import { getGitLabIssue } from "./tracker/gitlab.ts";
import { getLocalIssue } from "./tracker/local.ts";

/** 缺省只取最近 5 次：更早的做完了，对「这次怎么干」参考价值已经很低。 */
export const DEFAULT_HISTORY_LIMIT = 5;

/**
 * 为了凑够 N 条履历，最多往前翻几倍的会话。
 *
 * 「最近 5 条履历」不能只在最近 5 个会话里找：会话可能没写回传件（失败、被取消），
 * 只翻 5 个就会安静地漏掉更早的真实履历。4 倍是个折中——既给缺失留出余量，
 * 又不会为了一次派单把整个归档都读一遍。
 */
export const HISTORY_SCAN_FACTOR = 4;

/** 翻会话的硬上限：再往前的履历对「这次怎么干」也帮不上忙了。 */
export const MAX_HISTORY_SCAN = 50;

/** 整段履历的字数上限。systemPrompt 是每轮都要付钱的，不能让它随会话数无限长。 */
export const DEFAULT_HISTORY_CHARS = 2000;

/** 单条履历的字数上限：一次会话的 done/files 列表可能很长，单条也不能无限长。 */
export const MAX_HISTORY_ENTRY_CHARS = 2000;

/** 截断时保留的那句话：用户要能从提示词里看出「这里不是全部」。 */
export const TRUNCATED_NOTICE = "（更早的没列）";

/**
 * 履历里最多列几张未关闭的票。
 *
 * 票比回传件更「吵」：一个干了很久的岗位可能挂着几十张票，全列进去会把
 * 真正有用的「上次怎么干」挤到后面。只留最近的 10 张（按票号倒序）。
 */
export const MAX_OPEN_TICKETS = 10;

/** warning 里最多点名几个对象：再多就只报总数，避免一次派单的 warnings 刷屏。 */
const MAX_WARNING_ITEMS = 5;

const HISTORY_HEADER = "## 你在本项目此前做过什么";

/** 一条渲染好的履历。`createdAt` 用会话的时间：它是「最近」的排序依据。 */
export interface StaffHistoryEntry {
  /** 会话 id：只用于追溯这条履历来自哪次会话，不写进提示词。 */
  agentId: string;
  createdAt: string;
  status: ChildHandoffRecord["status"];
  summary: string;
  done: string[];
  files: string[];
}

/**
 * 只声明本模块真正用到的那一小块宿主能力。
 *
 * 不 import `PaseoApi` 的具体实现：履历只调 `agents.list`，测试里传一个假对象就够，
 * 绑死客户端的完整类型只会让这个纯检索模块跟着宿主升级一起变。
 */
export interface StaffHistoryPaseo {
  agents: {
    list(options: {
      filter: { labels: Record<string, string>; includeArchived: boolean };
    }): Promise<{ entries?: unknown }>;
  };
}

export interface StaffHistoryOptions {
  workspaceId: string;
  staffId: string;
  workspaceDir: string;
  /** 最多读几次会话，缺省 5。 */
  limit?: number;
  /**
   * 调用方注入的时钟基准，便于测试钉死时间。
   * 只用来把「未来时间」压回 `now`（宿主时钟漂移时别让脏记录霸占最近 5 条），不做过滤。
   */
  now?: Date | number | string;
  /** 整段字数上限，缺省 2000；主要给纯函数测试用。 */
  maxChars?: number;
  /**
   * 读一份回传件的窄接口，缺省用 `readChildHandoff`。
   *
   * 抽出来是为了两件事：测试可以注入坏读取器验证「读坏了不挡派单」，
   * 将来回传件换位置时也只改默认值，不动检索逻辑。
   */
  readHandoff?: StaffHistoryReader;
  /**
   * 读一张票的窄接口，缺省按工作区后端走 GitHub / GitLab / 本地 Markdown。
   *
   * 与 `readHandoff` 同理：测试注入假函数就不碰网络；读取失败只跳过，
   * 不影响回传件那部分履历。
   */
  readTicket?: StaffHistoryTicketReader;
}

/** 读一份回传件：给目录 + 会话 id，返回 null 表示不存在或读不懂。 */
export type StaffHistoryReader = (
  workspaceDir: string,
  agentId: string,
) => Promise<ChildHandoffRecord | null> | ChildHandoffRecord | null;

/** 履历里列出的一张未关闭票：只要票号与标题，够写进提示词。 */
export interface StaffHistoryOpenTicket {
  number: number;
  title: string;
  /** 多仓库工作区里票所属的仓库键（`owner/name`）；本地后端没有。 */
  repoKey?: string;
}

/** 读一张票的结果：缺省实现只认 OPEN / CLOSED 两种状态。 */
export interface StaffHistoryTicketRead {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
}

/** 读一张票：给工作区目录、可选的仓库键、票号；null 表示读不到。 */
export type StaffHistoryTicketReader = (
  workspaceDir: string,
  repoKey: string | undefined,
  number: number,
) => Promise<StaffHistoryTicketRead | null> | StaffHistoryTicketRead | null;

export interface StaffHistoryResult {
  /** 可直接拼到 systemPrompt 末尾的段落；没有历史时是空串（调用方据此不写空段）。 */
  text: string;
  /** 不挡派单的问题清单：列表失败、回传件缺失 / 坏掉、时间读不出来、票读不到或已关闭。 */
  warnings: string[];
  /** 实际读到并交给渲染的履历条数；`renderHistory` 因字数上限丢掉的不再扣减。 */
  count: number;
  /** 履历里列出的未关闭票（已去重、按票号倒序、最多 10 张）。 */
  openTickets?: StaffHistoryOpenTicket[];
}

/** 宿主条目里本模块要读的字段；其余一律忽略。 */
interface HistoryAgent {
  id: string;
  workspaceId: string | null;
  createdAt: string;
  /** 会话标签：`deck.ticket` 指向这次会话干的那张票，是「未关闭的票」的索引。 */
  labels?: Record<string, string>;
}

/** 一张票的引用：`#12`（当区）或 `owner/repo#12`（跨仓库）。 */
interface TicketRef {
  number: number;
  repoKey?: string;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberFrom(now: Date | number | string | undefined): number | null {
  if (now === undefined) return null;
  const value = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  return Number.isFinite(value) ? value : null;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** 从 `agents.list` 的返回值里挑出可用条目；形状不对的留一条 warning，别安静丢掉。 */
function agentsOf(listed: unknown, warnings: string[]): HistoryAgent[] {
  if (typeof listed !== "object" || listed === null) {
    warnings.push("岗位履历的会话清单形状不对，这次跳过");
    return [];
  }
  const entries = (listed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    warnings.push("岗位履历的会话清单没有 entries，这次跳过");
    return [];
  }

  const out: HistoryAgent[] = [];
  let malformed = 0;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      malformed += 1;
      continue;
    }
    const agent = (entry as { agent?: unknown }).agent;
    if (typeof agent !== "object" || agent === null) {
      malformed += 1;
      continue;
    }
    const record = agent as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      malformed += 1;
      continue;
    }
    out.push({
      id,
      workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
      labels: stringsRecordOf(record.labels),
    });
  }
  if (malformed > 0) warnings.push(`岗位履历跳过 ${malformed} 条形状不对的会话记录`);
  return out;
}

/** 只收「键和值都是字符串」的标签；其它形状直接忽略，别让脏数据变成票号。 */
function stringsRecordOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 解析 `#12` / `owner/repo#12`；读不懂（含 0、非数字）返回 null。 */
function ticketRefOf(value: string | undefined): TicketRef | null {
  if (typeof value !== "string") return null;
  const matched = /^(?:([^#\s]+))?#(\d+)$/.exec(value.trim());
  if (!matched) return null;
  const number = Number(matched[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  const prefix = matched[1]?.trim();
  return prefix ? { number, repoKey: prefix } : { number };
}

function ticketKeyOf(ticket: { number: number; repoKey?: string }): string {
  return `${ticket.repoKey ?? ""}#${ticket.number}`;
}

/** 从最近这批会话的 `deck.ticket` 标签里收集票引用，先按「仓库 + 票号」去重。 */
function ticketRefsOf(agents: readonly HistoryAgent[]): TicketRef[] {
  const seen = new Set<string>();
  const out: TicketRef[] = [];
  for (const agent of agents) {
    const ref = ticketRefOf(agent.labels?.[DECK_TICKET_LABEL]);
    if (!ref) continue;
    const key = ticketKeyOf(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

interface HistoryCandidate {
  agent: HistoryAgent;
  sortAt: number;
}

/** 工作区过滤 + 时间排序 + 取前 N：`list` 的 filter 没有 workspace 这一维，只能在这里做。 */
function recentAgentsOf(
  listed: unknown,
  workspaceId: string,
  scanLimit: number,
  bound: number | null,
  warnings: string[],
): HistoryAgent[] {
  const scored: HistoryCandidate[] = [];
  for (const agent of agentsOf(listed, warnings)) {
    if (agent.workspaceId !== workspaceId) continue;
    const createdAt = Date.parse(agent.createdAt);
    // 时间读不出来就排不进「最近」：宁可少一条，也不能让它随机插到前面。
    if (!Number.isFinite(createdAt)) {
      warnings.push(`岗位履历跳过会话 ${agent.id}：创建时间读不出来`);
      continue;
    }
    // 给了 now 时把未来时间压回去：宿主时钟漂移的会话不该霸占「最近 5 条」。
    scored.push({ agent, sortAt: bound === null ? createdAt : Math.min(createdAt, bound) });
  }
  return scored
    .sort((left, right) => right.sortAt - left.sortAt)
    .slice(0, scanLimit)
    .map((candidate) => candidate.agent);
}

/** 逐个读回传件；一份坏了只记 warning，不影响同批其它会话。 */
async function entriesOf(
  agents: readonly HistoryAgent[],
  workspaceDir: string,
  readHandoff: StaffHistoryReader,
  warnings: string[],
): Promise<StaffHistoryEntry[]> {
  const entries: StaffHistoryEntry[] = [];
  // 缺失/坏掉是常态（会话失败、被取消就没回传件）。逐条 warning 会让一次派单
  // 的 warnings 长到没人看，所以聚合成一行；真正的读取异常仍然逐条报。
  const missing: string[] = [];
  for (const agent of agents) {
    let record;
    try {
      record = await readHandoff(workspaceDir, agent.id);
    } catch (error) {
      // `readChildHandoff` 自己会吞读盘错误，这里防的是注入的读取器漏出异常。
      warnings.push(`岗位履历跳过会话 ${agent.id} 的回传件：${detailOf(error)}`);
      continue;
    }
    if (!record) {
      // 文件不存在与 JSON 坏掉在读取层是同一个结果：都按「这次没有可用证据」跳过。
      missing.push(agent.id);
      continue;
    }
    // 「最近」按**回传件**的时间算：长会话可能开工很早、收尾很晚，
    // 按会话 createdAt 排会把它当成旧的。回传件时间坏了才退回会话时间。
    const handoffAt = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : Number.NaN;
    entries.push({
      agentId: agent.id,
      createdAt: Number.isFinite(handoffAt) ? record.createdAt : agent.createdAt,
      status: record.status,
      summary: typeof record.summary === "string" ? record.summary : "",
      done: stringsOf(record.done),
      files: stringsOf(record.files),
    });
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, MAX_WARNING_ITEMS).join("、");
    warnings.push(
      `岗位履历跳过 ${missing.length} 个没有可用回传件的会话：${shown}${missing.length > MAX_WARNING_ITEMS ? " 等" : ""}（不存在或读不懂）`,
    );
  }
  return entries;
}

/**
 * 缺省读票实现：按工作区的后端解析方式读一张票。
 *
 * 三个后端的返回类型相同（`IssueDetailResult`），但为了不把「后端怎么选」
 * 硬编码进履历，这里按 `resolveBackend` 的 `kind` 分派；`repoKey` 来自票引用
 * 的前缀（`owner/repo#12`），没有前缀就不传，让后端按单仓库工作区自己选。
 */
async function readTicketFromTracker(
  workspaceDir: string,
  repoKey: string | undefined,
  number: number,
): Promise<StaffHistoryTicketRead | null> {
  const backend = await resolveBackend(workspaceDir, "岗位履历", repoKey);
  if (!backend.ok) return null;

  let result;
  if (backend.kind === "github") {
    result = await getIssue(backend.ref.owner, backend.ref.name, number);
  } else if (backend.kind === "gitlab") {
    result = await getGitLabIssue(backend.ref.owner, backend.ref.name, number);
  } else {
    result = await getLocalIssue(backend.workspaceDir, number);
  }
  // 三个后端的失败形状不一样，但都有 `ok`；读不懂一律当作「这张票看不见」。
  if (!result.ok) return null;
  const issue = result.issue as { number?: unknown; title?: unknown; state?: unknown } | undefined;
  if (!issue || typeof issue.number !== "number" || typeof issue.title !== "string") return null;
  const state = issue.state === "OPEN" || issue.state === "CLOSED" ? issue.state : null;
  if (!state) return null;
  return { number: issue.number, title: issue.title, state };
}

/**
 * 读会话标签里指向的票，只留未关闭的。
 *
 * 失败方向同回传件：读不到、读坏了、票已关都只是「这次没有这条证据」，
 * 聚合成一行 warning，绝不抛异常挡住派单。
 */
async function openTicketsOf(
  agents: readonly HistoryAgent[],
  workspaceDir: string,
  readTicket: StaffHistoryTicketReader,
  warnings: string[],
): Promise<StaffHistoryOpenTicket[]> {
  const refs = ticketRefsOf(agents);
  if (refs.length === 0) return [];

  const open: StaffHistoryOpenTicket[] = [];
  const skipped: string[] = [];
  for (const ref of refs) {
    let ticket: StaffHistoryTicketRead | null;
    try {
      ticket = await readTicket(workspaceDir, ref.repoKey, ref.number);
    } catch (error) {
      // 注入的读取器可能漏出异常；默认实现会自己吞掉后端失败并返回 null。
      skipped.push(`${ticketKeyOf(ref)} 读取失败：${detailOf(error)}`);
      continue;
    }
    if (!ticket || !Number.isInteger(ticket.number) || ticket.number <= 0) {
      skipped.push(`${ticketKeyOf(ref)} 读不到`);
      continue;
    }
    if (ticket.state !== "OPEN") {
      skipped.push(`${ticketKeyOf(ref)} 已关闭`);
      continue;
    }
    open.push({
      number: ticket.number,
      title: typeof ticket.title === "string" ? ticket.title.trim() : "",
      ...(ref.repoKey ? { repoKey: ref.repoKey } : {}),
    });
  }

  if (skipped.length > 0) {
    const shown = skipped.slice(0, MAX_WARNING_ITEMS).join("、");
    warnings.push(
      `岗位履历跳过 ${skipped.length} 张票：${shown}${skipped.length > MAX_WARNING_ITEMS ? " 等" : ""}（读不到或已关闭）`,
    );
  }

  // 输出按票号倒序（同一票号在不同仓库各算一张），最多 10 张。
  return open
    .sort((left, right) => right.number - left.number)
    .slice(0, MAX_OPEN_TICKETS);
}

/** 读到的可能多于 N 条（翻查时多翻了几个会话），按时间倒序截到 N 条。 */
function pickRecent(entries: readonly StaffHistoryEntry[], limit: number): StaffHistoryEntry[] {
  return [...entries]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, limit);
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function lineOf(entry: StaffHistoryEntry): string {
  const head = [entry.createdAt, entry.status, entry.summary].filter((item) => item.length > 0).join("｜");
  const lines = [`- ${head}`];
  if (entry.done.length > 0) lines.push(`  完成：${entry.done.join("；")}`);
  if (entry.files.length > 0) lines.push(`  文件：${entry.files.join("、")}`);
  return lines.join("\n");
}

/** 一张票占据一整行：截断时按整行丢，不切半句标题。 */
function ticketLineOf(ticket: StaffHistoryOpenTicket): string {
  const title = ticket.title.trim();
  return title ? `未关闭的票：#${ticket.number} ${title}` : `未关闭的票：#${ticket.number}`;
}

/** 只截一段字符串，不切断 UTF-16 代理对、不修改入参；留一个省略号说明这里被截过。 */
function clip(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars === 1) return "…";
  let end = maxChars - 1;
  // 切点落在 emoji 这类代理对的中间时往回退一格，别产生半个字符。
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

/**
 * 纯渲染：把履历按时间倒序拼成一段，总长不超过 `maxChars`。
 *
 * 截断发生在**整条**的边界上（放不下这条，就连同更早的一起丢），
 * 因为半条「完成：A；B；C…」比没有更误导人。只有最新一条自己就超长时才截字，
 * 否则字少一点但能保住「最近一次做过什么」。
 */
/** 渲染时的一个块：回传件或一张票，各自带分隔符与「放不下时能否截字」。 */
interface RenderBlock {
  text: string;
  separator: string;
  /** 回传件超长时允许截字；票只按整行丢，不切标题。 */
  clipOnOverflow: boolean;
}

/** 去重（同一票号、同一仓库只留一张）后按票号倒序。 */
function ticketsForRender(
  openTickets: readonly StaffHistoryOpenTicket[],
): StaffHistoryOpenTicket[] {
  const seen = new Set<string>();
  return [...openTickets]
    .filter((ticket) => {
      const key = ticketKeyOf(ticket);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.number - left.number);
}

/** 回传件在前、票在后；票与票之间只换行，避免一张票占出两行空白。 */
function renderBlocksOf(
  entries: readonly StaffHistoryEntry[],
  tickets: readonly StaffHistoryOpenTicket[],
): RenderBlock[] {
  const ordered = [...entries].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const blocks: RenderBlock[] = ordered.map((entry) => ({
    text: clip(lineOf(entry), MAX_HISTORY_ENTRY_CHARS),
    separator: "\n\n",
    clipOnOverflow: true,
  }));
  for (const [index, ticket] of tickets.entries()) {
    blocks.push({
      text: ticketLineOf(ticket),
      separator: index === 0 && blocks.length > 0 ? "\n\n" : "\n",
      clipOnOverflow: false,
    });
  }
  return blocks;
}

/** 按整块边界拼装，放不下就停并补一句截断说明。 */
function assembleHistory(blocks: readonly RenderBlock[], cap: number): string {
  const head = `${HISTORY_HEADER}\n\n`;
  const notice = `\n\n${TRUNCATED_NOTICE}`;

  // 连标题和「更早的没列」都放不下：宁可返回空段，也不返回一句没有内容的残标题。
  if (cap <= head.length + TRUNCATED_NOTICE.length) return "";

  let body = "";
  let truncated = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const separator = body ? block.separator : "";
    // 后面还有条目时先给截断说明留位置：否则「刚好放下最后一条」会把说明挤掉，
    // 让读者以为这就是全部。
    const reserve = index === blocks.length - 1 ? 0 : notice.length;
    if (head.length + body.length + separator.length + block.text.length + reserve <= cap) {
      body += `${separator}${block.text}`;
      continue;
    }
    if (!body && block.clipOnOverflow) {
      // 最新一条回传件自己就超长：截短它，至少保住「最近做过什么」。
      const room = cap - head.length - notice.length;
      if (room > TRUNCATED_NOTICE.length) body = clip(block.text, room);
    }
    truncated = true;
    break;
  }

  const rendered = truncated
    ? `${head}${body}${body ? "\n\n" : ""}${TRUNCATED_NOTICE}`
    : `${head}${body}`;
  // 兜底：上面的预留已经保证不超，但入口是公开的，最后再夹一次，长度上限必须是硬的。
  return rendered.length > cap ? rendered.slice(0, cap) : rendered;
}

/** 纯渲染入口：回传件按时间倒序，票按票号倒序，整段不超过 `maxChars`。 */
export function renderHistory(
  entries: readonly StaffHistoryEntry[],
  maxChars: number = DEFAULT_HISTORY_CHARS,
  openTickets: readonly StaffHistoryOpenTicket[] = [],
): string {
  const tickets = ticketsForRender(openTickets);
  if (entries.length === 0 && tickets.length === 0) return "";
  const cap = Math.max(0, Math.floor(maxChars));
  return assembleHistory(renderBlocksOf(entries, tickets), cap);
}

/** 缺输入时返回一条 warning；都齐了返回 null。 */
function missingInputWarning(
  staffId: string,
  workspaceId: string,
  workspaceDir: string,
): string | null {
  if (!staffId) return "岗位履历这次跳过：没有岗位 id";
  if (!workspaceId) return "岗位履历这次跳过：没有工作区 id";
  if (!workspaceDir) return "岗位履历这次跳过：没有工作区目录，读不到回传件";
  return null;
}

/**
 * 按 `deck.staff` 标签反查岗位历史，拼出「你在本项目此前做过什么」。
 *
 * 三个容易安静出错的地方：
 * - `includeArchived` **必须在 `filter` 里**（不是顶层参数）。不传就只看得到活着的会话，
 *   而岗位会话干完就归档——履历会安静地少掉一半；
 * - `list` 的 filter 没有 workspace 这一维，只能把条目拉回来之后在内存里按
 *   `agent.workspaceId` 过滤；同名岗位在不同工作区各有一份，串了就是把别人的活算到自己头上；
 * - 回传件按 **agentId** 存，一个会话一份；读不到只跳过，绝不因为一条坏文件挡住派单。
 */
export async function collectStaffHistory(
  paseo: StaffHistoryPaseo,
  options: StaffHistoryOptions,
): Promise<StaffHistoryResult> {
  const staffId = options.staffId.trim();
  const workspaceId = options.workspaceId.trim();
  const workspaceDir = options.workspaceDir.trim();
  const warnings: string[] = [];

  const missing = missingInputWarning(staffId, workspaceId, workspaceDir);
  if (missing) {
    warnings.push(missing);
    return { text: "", warnings, count: 0, openTickets: [] };
  }

  let listed: unknown;
  try {
    listed = await paseo.agents.list({
      // `includeArchived` 放在 filter 里面：这是宿主真正的参数位置，漏了就只剩活会话。
      filter: { labels: { [DECK_STAFF_LABEL]: staffId }, includeArchived: true },
    });
  } catch (error) {
    warnings.push(`岗位履历读不到会话清单，这次跳过：${detailOf(error)}`);
    return { text: "", warnings, count: 0, openTickets: [] };
  }

  const limit = clampPositiveInt(options.limit, DEFAULT_HISTORY_LIMIT);
  // 多翻几个会话再按回传件时间截 N 条：最近几个会话可能没写回传件，
  // 只翻 N 个会把更早的真实履历漏掉（安静地少数据）。
  const scanLimit = Math.min(MAX_HISTORY_SCAN, limit * HISTORY_SCAN_FACTOR);
  const recent = recentAgentsOf(listed, workspaceId, scanLimit, numberFrom(options.now), warnings);
  const read = await entriesOf(
    recent,
    workspaceDir,
    options.readHandoff ?? readChildHandoff,
    warnings,
  );
  const entries = pickRecent(read, limit);
  // 票在读回传件之后单独读：票的失败不该影响履历，反之亦然。
  const openTickets = await openTicketsOf(
    recent,
    workspaceDir,
    options.readTicket ?? readTicketFromTracker,
    warnings,
  );

  return {
    text: renderHistory(entries, options.maxChars ?? DEFAULT_HISTORY_CHARS, openTickets),
    warnings,
    count: entries.length,
    openTickets,
  };
}
