/**
 * 会话桥的纯函数层：动作提示词、发送计划、handoff 文档。
 *
 * 为什么单独一层：Paseo 插件不能替用户点开会话，界面要先给出「发到哪、发什么、
 * 忙的时候怎么办」三件事的确切答案，再由服务端执行。把判断放在纯函数里，
 * 客户端预览、服务端执行和测试用的是同一份逻辑，不会出现预览说排队、实际却打断。
 */

import { providerId } from "./orchestration.ts";

export type PromptActionKind =
  | "diagnose"
  | "fix"
  | "research"
  | "discuss"
  | "prototype"
  | "supplement"
  | "execute"
  | "fixate"
  | "takeover"
  | "handoff"
  | "new-requirement"
  | "discuss-wayfinder"
  | "discuss-grill"
  | "bug"
  | "custom";

export interface PromptActionContext {
  lang: "en" | "zh";
  repoKey?: string;
  number?: number;
  title?: string;
  url?: string;
  /** Paseo 的提供方 id，可能是 `provider/model`；只取第一段判断命令方言。 */
  provider?: string;
  notes?: string;
}

type Lang = "zh" | "en";

const pick = <T,>(lang: Lang, zh: T, en: T): T => (lang === "zh" ? zh : en);

/** 动作对应的 DSH 技能；`custom` 不指向技能，只发用户写的说明。 */
export const ACTION_SKILLS: Readonly<Record<PromptActionKind, string | null>> = {
  diagnose: "triage",
  fix: "implement",
  research: "wayfinder",
  discuss: "grill-me",
  prototype: "prototype",
  supplement: "wayfinder",
  execute: "implement",
  fixate: null,
  takeover: "wayfinder",
  handoff: "handoff",
  "new-requirement": "wayfinder",
  "discuss-wayfinder": "wayfinder",
  "discuss-grill": "grill-with-docs",
  bug: "triage",
  custom: null,
};

interface ActionSpec {
  skill: string | null;
  zhWord: string;
  enWord: string;
  zhLead: string;
  enLead: string;
}

const ACTIONS: Record<PromptActionKind, ActionSpec> = {
  diagnose: {
    skill: "triage",
    zhWord: "诊断",
    enWord: "Diagnose",
    zhLead: "先诊断这张票：查清现象、影响和可能原因，这一步不要直接改代码。",
    enLead: "Diagnose this ticket first: establish the symptom, impact and likely cause; do not change code yet.",
  },
  fix: {
    skill: "implement",
    zhWord: "修复",
    enWord: "Fix",
    zhLead: "按已经对齐的方案实施这张票，改动范围不要超出票面。",
    enLead: "Implement this ticket along the agreed plan; keep the change inside the ticket's scope.",
  },
  research: {
    skill: "wayfinder",
    zhWord: "研究",
    enWord: "Research",
    zhLead: "围绕这张票做一次调研：先查仓内既有资料，再决定要不要新查。",
    enLead: "Research this ticket: look for existing material in the repository first, then decide whether a new pass is needed.",
  },
  discuss: {
    skill: "grill-me",
    zhWord: "讨论",
    enWord: "Discuss",
    zhLead: "先讨论这张票的方案、取舍和未决问题，不要直接改代码。",
    enLead: "Discuss the options, trade-offs and open questions for this ticket before changing code.",
  },
  prototype: {
    skill: "prototype",
    zhWord: "原型验证",
    enWord: "Prototype",
    zhLead: "用一次性原型验证这张票的关键设计假设，验证后报告结果与风险。",
    enLead: "Use a throwaway prototype to test the key design assumption, then report findings and risks.",
  },
  supplement: {
    skill: "wayfinder",
    zhWord: "补充信息",
    enWord: "Supplement",
    zhLead: "先找出这张票缺失的关键信息，向我提出必要问题，得到回答后再重新分流。",
    enLead: "Identify the missing key information, ask me what is needed, and re-triage after I answer.",
  },
  execute: {
    skill: "implement",
    zhWord: "执行",
    enWord: "Execute",
    zhLead: "按票面要求执行这张票，保持范围克制，并报告改动与验证结果。",
    enLead: "Execute this ticket within its stated scope and report the changes and verification results.",
  },
  fixate: {
    skill: null,
    zhWord: "沉淀",
    enWord: "Consolidate",
    zhLead: `告一段落。暂停推进，执行「思维对齐 · 成果沉淀」，从第一性原理出发：

## 沉淀
- [ ] 全量复述：把我从会话开始到现在、我问过你并得到明确回答的内容，按五类逐条列出（每条 = 我问的问题 → 你的回答）：目的地 / 约束与偏好 / 已确认的决定 / 待决问题 / 雾区（隐约可见但还不清晰）
- [ ] 不压缩、不合并——宁可啰嗦不可省略；一次全部列完，不分批
- [ ] 每条标注出处：我的问题（短句）+ 你的原话关键短句（≤50 字，超出以省略号截断）+ 上下文提示（如主题/轮次）

## 可疑遗漏
- [ ] 单列一节「可疑遗漏」：列出我问过但未纳入的，以及你提过但被判断为无关、模糊或执行细节的内容，并写明判断理由。

## 核对
- [ ] 列完（含「可疑遗漏」）后停下，等我逐条核对；我确认或修正后，再执行落盘。

## 落盘
- [ ] 有对应 ticket：写入 ticket 的「## 对齐成果」节，不写 map 正文。
- [ ] 只有 map：写入 .scratch/alignment/<ts>-<短标题>.md，并在 map Notes 追加指针。
- [ ] 都没有：写入对齐记录文件并告知完整路径。

## 工具
- [ ] issue 操作优先使用 deck_ 工具
- [ ] 及时使用 deck_issue_report
- [ ] 回复前按 /ask-matt 判断是否调用 suggest_next_steps。`,
    enLead: `This phase wraps up here. Pause progress and run the "alignment & consolidation" pass, from first principles:

## Consolidate
- [ ] Restate everything I have explicitly answered since this session started, in five categories: Destination / Constraints & preferences / Confirmed decisions / Open questions / Fog.
- [ ] No compression or merging; list everything in one batch.
- [ ] Annotate every item with my question, a key quote of your answer (≤50 chars), and a context hint.

## Suspected omissions
- [ ] List questions I answered but you omitted, plus things you judged off-topic, vague, or execution detail; state your reason for each.

## Review
- [ ] Stop after the list and wait for my item-by-item review. Persist only after I confirm or correct it.

## Persist
- [ ] With a ticket, write an "## Alignment outcomes" section into that ticket.
- [ ] With only a map, write .scratch/alignment/<ts>-<short>.md and point to it from the map Notes.
- [ ] With neither, write the alignment note and report its full path.

## Tools
- [ ] Prefer deck_ tools for issue operations
- [ ] Report handled tickets with deck_issue_report
- [ ] Before replying, follow /ask-matt and call suggest_next_steps when appropriate.`,
  },
  takeover: {
    skill: "wayfinder",
    zhWord: "接手",
    enWord: "Take over",
    zhLead: "接手这件事：先读票面、评论和已有进展，再确认下一步。",
    enLead: "Take this over: read the ticket, its comments and the work so far, then confirm the next step.",
  },
  handoff: {
    skill: "handoff",
    zhWord: "交接",
    enWord: "Hand off",
    zhLead: "请做一次交接：把当前进展、已完成、未完成和下一步写清楚。",
    enLead: "Produce a handoff: state current progress, what is done, what is left and the next step.",
  },
  "new-requirement": {
    skill: "wayfinder",
    zhWord: "新需求",
    enWord: "New requirement",
    zhLead: "把这条需求整理成可执行的票，先确认目标与非目标。",
    enLead: "Turn this requirement into an actionable ticket; settle goals and non-goals first.",
  },
  "discuss-wayfinder": {
    skill: "wayfinder",
    zhWord: "探讨需求",
    enWord: "Discuss requirement",
    zhLead: "先探讨这个需求，边谈边把地图和路线票建出来；谈清楚之前不要改代码。",
    enLead: "Discuss this requirement first and build the map and route tickets as you go; do not change code before it is settled.",
  },
  "discuss-grill": {
    skill: "grill-with-docs",
    zhWord: "探讨需求（只谈）",
    enWord: "Discuss requirement (talk only)",
    zhLead: "只探讨这个需求，逐条问清目标、边界和风险；这一步不建票、不改代码，谈完我自己再拆。",
    enLead: "Discuss only: pin down goals, boundaries and risks question by question. Do not create tickets or change code; I will split the work myself afterwards.",
  },
  bug: {
    skill: "triage",
    zhWord: "缺陷诊断",
    enWord: "Diagnose bug",
    zhLead: "按 BUG 单处理：先澄清现象与复现，再查重，最后给结论。",
    enLead: "Handle this as a BUG: clarify the symptom and reproduction, check for duplicates, then conclude.",
  },
  custom: {
    skill: null,
    zhWord: "自定义",
    enWord: "Custom",
    zhLead: "按下面的说明处理。",
    enLead: "Handle this as described below.",
  },
};

/**
 * 提示词方言。
 *
 * Paseo 目前只把命令当作「消息开头的斜杠命令」交给提供方；claude / codex / opencode
 * 三个内置提供方都能展开。其它提供方没有实证，宁可写清楚的自然语言，也不要发一条
 * 只会被当成普通文本的 `/triage` 让用户以为技能已经触发。
 */
export type PromptDialect = "slash" | "text";

const SLASH_PROVIDERS = new Set(["claude", "codex", "opencode"]);

export function promptDialect(provider: string | undefined): PromptDialect {
  // 客户端 id 归一只有 `providerId` 一个入口；这里的名单和预授权能力名单是两回事
  // （那一份在 `server/hooks.ts`），成员碰巧相同，别合并。
  return SLASH_PROVIDERS.has(providerId(provider)) ? "slash" : "text";
}

/** 行内文字：压掉换行与连续空白，标题不会被用户正文里的换行撑开。 */
function cleanInline(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** 块文字：保留换行，只统一 CRLF 并去掉首尾空白。 */
function cleanBlock(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
}

/** 命令不可用时用的纯文本开头：点名技能，但明确这是文字说明。 */
function textLead(skill: string, lang: Lang): string {
  return pick(
    lang,
    `请按 ${skill} 技能的说明处理这件事（当前提供方不保证展开技能命令，下面用纯文本写清要求）。`,
    `Follow the ${skill} skill to handle this (this provider does not reliably expand skill commands, so the instruction is written out in plain text).`,
  );
}

function contextLines(ctx: PromptActionContext, lang: Lang): string[] {
  const lines: string[] = [];
  const repo = cleanInline(ctx.repoKey ?? "");
  if (repo) lines.push(pick(lang, `仓库：${repo}`, `Repo: ${repo}`));
  const title = cleanInline(ctx.title ?? "");
  if (typeof ctx.number === "number" && Number.isFinite(ctx.number)) {
    const ticket = `#${ctx.number}${title ? ` ${title}` : ""}`;
    lines.push(pick(lang, `票：${ticket}`, `Ticket: ${ticket}`));
  } else if (title) {
    lines.push(pick(lang, `标题：${title}`, `Title: ${title}`));
  }
  const url = cleanInline(ctx.url ?? "");
  if (url) lines.push(pick(lang, `链接：${url}`, `Link: ${url}`));
  return lines;
}

const CLOSING: Record<Lang, string> = {
  zh: "结束时把真实状态、已做与未做写回这张票；没做的事不要写成已完成。",
  en: "When you finish, write the real status plus what was and was not done back into the ticket; never present unfinished work as done.",
};

const HANDOFF_CLOSING: Record<Lang, string> = {
  zh: "结尾输出完整的 handoff Markdown：摘要、已完成、进行中、下一步、涉及文件；不要把未做的事写成已完成。",
  en: "Finish with a complete handoff in Markdown: summary, done, in progress, next steps and files; never present unfinished work as done.",
};

/**
 * 动作提示词。
 *
 * 结构化上下文（仓库 / 票号 / 链接）放在技能命令之后，技能本身负责流程，
 * 这里只补票面事实和用户备注，不重复技能规则，避免两边说法漂移。
 */
export function buildActionPrompt(kind: PromptActionKind, ctx: PromptActionContext): string {
  const spec = ACTIONS[kind];
  const lang: Lang = ctx.lang === "zh" ? "zh" : "en";
  const dialect = promptDialect(ctx.provider);
  const lines: string[] = [];
  if (spec.skill) {
    lines.push(dialect === "slash" ? `/${spec.skill}` : textLead(spec.skill, lang));
  }
  lines.push(pick(lang, spec.zhLead, spec.enLead));
  lines.push(...contextLines(ctx, lang));
  const notes = cleanBlock(ctx.notes ?? "");
  if (notes) {
    lines.push(pick(lang, `补充说明：\n${notes}`, `Notes:\n${notes}`));
  } else if (kind === "custom") {
    lines.push(
      pick(
        lang,
        "（用户没有写补充说明：先问清楚要做什么，再动手。）",
        "(The user wrote no notes: ask what to do before acting.)",
      ),
    );
  }
  lines.push("", kind === "handoff" ? HANDOFF_CLOSING[lang] : CLOSING[lang]);
  return lines.join("\n");
}

/**
 * 技能详情里的「发到会话」。
 *
 * 斜杠方言直接发 `/技能名`；其它提供方不保证展开命令，改发一句明确的纯文本说明，
 * 不把字面量 `/技能名` 当成普通消息发出去。
 */
export function buildSkillPrompt(skill: string, ctx: PromptActionContext): string {
  const name = cleanInline(skill.replace(/^\/+/, ""));
  if (!name) return "";
  const lang: Lang = ctx.lang === "zh" ? "zh" : "en";
  return promptDialect(ctx.provider) === "slash" ? `/${name}` : textLead(name, lang);
}

/** 会话标题里的一行人类可读描述，不带 `[New]` 前缀，也不截断。 */
export function actionTitle(kind: PromptActionKind, ctx: PromptActionContext): string {
  const spec = ACTIONS[kind];
  const lang: Lang = ctx.lang === "zh" ? "zh" : "en";
  const word = pick(lang, spec.zhWord, spec.enWord);
  const number =
    typeof ctx.number === "number" && Number.isFinite(ctx.number) ? `#${ctx.number}` : "";
  const title = cleanInline(ctx.title ?? "");
  const detail = [number, title].filter(Boolean).join(" ");
  return detail ? `${word} ${detail}` : word;
}

/** 新建会话标题的统一前缀；与 DSH 的 `[New]` 一致，便于在侧栏一眼认出。 */
export const SESSION_TITLE_PREFIX = "[New] ";

/** 新建会话标题上限（字符数，按 Unicode 码点算）。 */
export const SESSION_TITLE_MAX_CHARS = 60;

/** 按码点截断：不会把一个 emoji 或中文劈成半个。 */
export function truncateTitle(text: string, max = SESSION_TITLE_MAX_CHARS): string {
  const points = Array.from(cleanInline(text));
  if (points.length <= max) return points.join("");
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function sessionTitle(kind: PromptActionKind, ctx: PromptActionContext): string {
  return truncateTitle(`${SESSION_TITLE_PREFIX}${actionTitle(kind, ctx)}`);
}

export type SessionTarget =
  | { kind: "current"; agentId: string }
  | { kind: "new"; cwd: string }
  | { kind: "copy" };

/** 工作区里可注入的会话；字段来自宿主 agent 快照，排序只依赖时间与状态。 */
export interface SessionCandidate {
  id: string;
  title?: string | null;
  provider?: string;
  model?: string | null;
  status?: "initializing" | "idle" | "running" | "error" | "closed";
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
}

const SESSION_STATUS_RANK: Record<NonNullable<SessionCandidate["status"]>, number> = {
  running: 4,
  initializing: 3,
  idle: 2,
  error: 1,
  closed: 0,
};

function sessionActivityAt(candidate: SessionCandidate): number {
  const raw = candidate.lastUserMessageAt ?? candidate.updatedAt ?? "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 选择「要注入哪个聊天窗口」时的会话顺序。
 *
 * 最近有用户消息的排前面，其次是最近更新的；时间相同再按状态。
 * 已关闭的会话不再接收消息，直接排除。返回新数组，不改调用方数据。
 */
export function rankSessionCandidates<T extends SessionCandidate>(candidates: readonly T[]): T[] {
  return candidates
    .filter((candidate) => candidate.status !== "closed")
    .slice()
    .sort((left, right) => {
      const byActivity = sessionActivityAt(right) - sessionActivityAt(left);
      if (byActivity !== 0) return byActivity;
      const byStatus =
        (SESSION_STATUS_RANK[right.status ?? "idle"] ?? 0) -
        (SESSION_STATUS_RANK[left.status ?? "idle"] ?? 0);
      if (byStatus !== 0) return byStatus;
      return left.id.localeCompare(right.id);
    });
}

/** 目录归一化：去首尾空白与末尾斜杠；根目录保留为 `/`。 */
export function normalizeSessionDir(directory: string): string {
  const trimmed = directory.trim();
  if (!trimmed) return "";
  const noTrail = trimmed.replace(/\/+$/, "");
  return noTrail || "/";
}

/**
 * 一个工作区的「已有会话」范围。
 *
 * 同一目录可能出现多个 workspaceId（例如用户又把同一个项目开了一次），
 * 这时只按 workspaceId 过滤会把同目录的另一批会话藏起来。规则：
 * - workspaceId 相同，一定是这个工作区的会话；
 * - 否则只要 cwd 与工作区目录一致（同目录的其他工作区，或快照里
 *   workspaceId 缺失的会话），也归入这个工作区。
 */
export function matchesWorkspaceScope(
  candidate: { workspaceId?: string | null; cwd?: string | null },
  workspaceId: string,
  workspaceDir?: string,
): boolean {
  if (candidate.workspaceId === workspaceId) return true;
  const dir = normalizeSessionDir(workspaceDir ?? "");
  if (!dir) return false;
  return normalizeSessionDir(candidate.cwd ?? "") === dir;
}

export interface SessionSendInput {
  action: PromptActionKind;
  ctx: PromptActionContext;
  target: SessionTarget;
  /** 目标会话当前是否正在跑回合；界面应把自己看到的真实状态传进来。 */
  busy?: boolean;
  /** 缺省 queue：不替用户打断正在跑的工作。 */
  sendMode?: "queue" | "interrupt" | "steer";
  /** 同一次点击的重试应复用同一个 key；缺省按动作与提示词生成稳定 key。 */
  idempotencyKey?: string;
}

export interface SessionSendPlan {
  target: SessionTarget;
  prompt: string;
  title?: string;
  sendMode: "queue" | "interrupt" | "steer";
  requiresConfirmation: boolean;
  /** 动作指向的技能名；`custom` 没有。 */
  skill?: string;
  /** 命令不被提供方接受时改发的纯文本版本。 */
  plainPrompt?: string;
  /** 只在新建会话时有值。 */
  idempotencyKey?: string;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function defaultIdempotencyKey(input: SessionSendInput, prompt: string): string {
  const material = [input.action, input.ctx.repoKey ?? "", input.ctx.number ?? "", prompt].join("\u0000");
  return `deck-${input.action}-${fnv1a(material)}`;
}

/**
 * 发送计划。
 *
 * 三条硬规则：
 * 1. 默认 queue；`interrupt` 只能由用户显式选择，任何缺省路径都不会打断。
 * 2. 忙碌时一律要求确认，确认框里默认仍是排队。
 * 3. 新建会话标题不超过 60 个字符，并带上稳定的幂等键。
 */
export function planSessionSend(input: SessionSendInput): SessionSendPlan {
  const prompt = buildActionPrompt(input.action, input.ctx);
  const sendMode = input.sendMode ?? "queue";
  const base: SessionSendPlan = {
    target: input.target,
    prompt,
    sendMode,
    // 复制不产生副作用；只有给正在跑的会话发消息才需要确认忙碌。
    requiresConfirmation: input.target.kind === "current" && input.busy === true,
  };
  const skill = ACTION_SKILLS[input.action];
  if (skill) {
    base.skill = skill;
    base.plainPrompt = buildActionPrompt(input.action, { ...input.ctx, provider: undefined });
  }
  if (input.target.kind === "new") {
    base.title = sessionTitle(input.action, input.ctx);
    base.idempotencyKey = input.idempotencyKey ?? defaultIdempotencyKey(input, prompt);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Handoff 文档
// ---------------------------------------------------------------------------

export interface HandoffTicket {
  repoKey?: string;
  number?: number;
  title?: string;
  url?: string;
}

export interface HandoffEntry {
  text: string;
  note?: string;
}

export interface HandoffInput {
  lang?: "en" | "zh";
  title?: string;
  createdAt?: string;
  agentId?: string;
  ticket?: HandoffTicket;
  summary?: string;
  done?: Array<HandoffEntry | string>;
  inProgress?: Array<HandoffEntry | string>;
  nextSteps?: Array<HandoffEntry | string>;
  risks?: Array<HandoffEntry | string>;
  files?: string[];
  notes?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inlineOf(value: unknown): string {
  return typeof value === "string" ? cleanInline(value) : "";
}

function blockOf(value: unknown): string {
  return typeof value === "string" ? cleanBlock(value) : "";
}

function entriesOf(value: unknown): HandoffEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      const text = cleanInline(item);
      return text ? [{ text }] : [];
    }
    const record = asRecord(item);
    if (!record) return [];
    const text = inlineOf(record.text);
    if (!text) return [];
    const note = inlineOf(record.note);
    return note ? [{ text, note }] : [{ text }];
  });
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = inlineOf(item);
    return text ? [text] : [];
  });
}

function ticketLine(ticket: HandoffTicket | undefined): string {
  if (!ticket) return "";
  const repo = inlineOf(ticket.repoKey);
  const number =
    typeof ticket.number === "number" && Number.isFinite(ticket.number) ? `#${ticket.number}` : "";
  const id = repo && number ? `${repo}${number}` : repo || number;
  const title = inlineOf(ticket.title);
  return [id, title].filter(Boolean).join(" ");
}

function bullet(entry: HandoffEntry): string {
  return entry.note ? `- ${entry.text} — ${entry.note}` : `- ${entry.text}`;
}

function section(heading: string, lines: string[]): string[] {
  return lines.length ? [`## ${heading}`, ...lines, ""] : [];
}

/**
 * 渲染交接文档。
 *
 * 输入来自会话或界面，按 `unknown` 接收：字段类型不对就忽略该字段，宁可少写一节，
 * 也不把 `[object Object]` 写进交接文档。连对象都不是才抛错——那是调用方的编程错误。
 */
export function renderHandoff(input: unknown): string {
  const record = asRecord(input);
  if (!record) throw new TypeError("renderHandoff 需要 handoff 对象");
  const handoff = record as unknown as HandoffInput;
  const lang: Lang = handoff.lang === "zh" ? "zh" : "en";
  const title = inlineOf(handoff.title);
  const lines: string[] = [title ? pick(lang, `# Handoff：${title}`, `# Handoff: ${title}`) : "# Handoff", ""];

  const meta: string[] = [];
  const createdAt = inlineOf(handoff.createdAt);
  if (createdAt) meta.push(pick(lang, `- 生成时间：${createdAt}`, `- Created: ${createdAt}`));
  const agentId = inlineOf(handoff.agentId);
  if (agentId) meta.push(pick(lang, `- Agent：${agentId}`, `- Agent: ${agentId}`));
  const ticket = ticketLine(handoff.ticket);
  if (ticket) meta.push(pick(lang, `- 票：${ticket}`, `- Ticket: ${ticket}`));
  const url = inlineOf(handoff.ticket?.url);
  if (url) meta.push(pick(lang, `- 链接：${url}`, `- Link: ${url}`));
  if (meta.length) lines.push(...meta, "");

  const summary = blockOf(handoff.summary);
  const done = entriesOf(handoff.done);
  const inProgress = entriesOf(handoff.inProgress);
  const nextSteps = entriesOf(handoff.nextSteps);
  const risks = entriesOf(handoff.risks);
  const files = stringsOf(handoff.files);
  const notes = stringsOf(handoff.notes);

  lines.push(...section(pick(lang, "摘要", "Summary"), summary ? [summary] : []));
  lines.push(...section(pick(lang, "已完成", "Done"), done.map(bullet)));
  lines.push(...section(pick(lang, "进行中", "In progress"), inProgress.map(bullet)));
  lines.push(...section(pick(lang, "下一步", "Next steps"), nextSteps.map(bullet)));
  lines.push(...section(pick(lang, "风险与注意", "Risks and cautions"), risks.map(bullet)));
  lines.push(...section(pick(lang, "涉及文件", "Files"), files.map((file) => `- \`${file}\``)));
  lines.push(...section(pick(lang, "备注", "Notes"), notes.map((note) => `- ${note}`)));

  if (!summary && !done.length && !inProgress.length && !nextSteps.length && !risks.length && !files.length && !notes.length) {
    lines.push(
      pick(
        lang,
        "（没有可交接的内容：摘要、已完成、进行中、下一步都为空。）",
        "(Nothing to hand off: summary, done, in progress and next steps are all empty.)",
      ),
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
