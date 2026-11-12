/**
 * 窗口之间的「自动条子」：派单被拒、错在别人的票上时，由插件把原因递回该负责的窗口。
 *
 * 为什么需要它：拒绝发生在派单窗口，能改的地方在需求窗口。过去只能靠人复制粘贴转述，
 * 用户就成了窗口之间的消息总线。条子落文件、由 relay 按当前绑定投递，理由与
 * `dispatch-handoffs` 一样——MCP 工具进程没有宿主连接，写不了消息。
 *
 * 纯函数：不读盘、不取会话、不读钟；id 由入参算出来，同一个错只递一次。
 */

/** FNV-1a 的偏移基与质数：两条独立的累加器用不同质数，好让单条路径的碰撞不至于同时出现。 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SECOND_PRIME = 0x85ebca6b;

/** 每个累加器只取 32 位，拼起来正好 16 位十六进制。 */
const HALF_WIDTH = 8;

/**
 * 16 位十六进制的稳定指纹：只用来去重，不做安全用途。
 *
 * 不用 node:crypto：这一层同时给客户端打包，`shared/` 里不能引宿主模块。
 */
function fingerprint(seed: string): string {
  let first = FNV_OFFSET_BASIS;
  let second = FNV_PRIME;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    first = Math.imul(first ^ code, FNV_PRIME) >>> 0;
    second = Math.imul(second ^ (code + index), SECOND_PRIME) >>> 0;
  }
  return first.toString(16).padStart(HALF_WIDTH, "0") + second.toString(16).padStart(HALF_WIDTH, "0");
}

/** 条子格式版本；以后改字段时靠它分别处理旧件。 */
export const WINDOW_NOTE_VERSION = 1;

/** 目前只往需求窗口递：票面写坏这一类错误，只有它改得动。 */
export const WINDOW_NOTE_ROLES = Object.freeze(["requirement"] as const);
export type WindowNoteRole = (typeof WINDOW_NOTE_ROLES)[number];

export interface WindowNoteEnvelope {
  readonly version: typeof WINDOW_NOTE_VERSION;
  /** 内容指纹：同一个错重复触发不会重复投递。 */
  readonly noteId: string;
  readonly createdAt: string;
  readonly workspaceId: string;
  /** 谁触发的（通常是派单窗口）。只用于说明来源，不作收件人判定。 */
  readonly fromAgentId: string;
  readonly toRole: WindowNoteRole;
  /** 相关需求票号；没有就 null。 */
  readonly requirementKey: number | null;
  /** 机器可读原因，与派单拒绝的 reason 同名。 */
  readonly reason: string;
  /** 给人看的那一句原因，原样转述。 */
  readonly detail: string;
  /** 已经试过几次投递。失败一次加一，超过上限才移进 failed/。 */
  readonly attempts: number;
  /** 上一次投递失败的时刻；还没失败过就是空串。用来给重试留最小间隔。 */
  readonly lastAttemptAt: string;
  /**
   * 上一次失败时投给哪个窗口；还没失败过就是空串。
   *
   * 间隔只约束「同一个收件人」的重试：需求窗口绑了但没开时那次失败，记的是当时那个窗口；
   * 之后窗口新建出来、或换绑到另一个窗口，那是一条新路子，不该被旧间隔按住。
   */
  readonly lastAttemptReceiver: string;
}

/**
 * 这个拒绝是不是「票面写坏了」——只有这类才值得递条子。
 *
 * 其余拒绝（身份不明、并发超限、配置读不出来）改票没用，递过去只会让需求窗口白跑一趟。
 */
export const TICKET_FAULT_REASONS: readonly string[] = Object.freeze([
  "bad-impact",
  "missing-impact",
  "empty-impact",
  "unknown-workspace",
]);

export function isTicketFault(reason: unknown): boolean {
  const value = typeof reason === "string" ? reason.trim() : "";
  return TICKET_FAULT_REASONS.includes(value);
}

/** ISO 时间里 `2026-11-06T05` 的长度：截到这里就只剩日期与小时。 */
const HOUR_PREFIX_LENGTH = 13;

/**
 * 条子 id：原因 + 需求票号 + 一小时的桶。
 *
 * 桶的作用：同一个错在重试时不该刷屏；一小时之后还在错，就再提醒一次。
 */
export function windowNoteId(input: {
  readonly reason: string;
  readonly detail: string;
  readonly requirementKey: number | null;
  readonly at: string;
}): string {
  const hour = input.at.slice(0, HOUR_PREFIX_LENGTH);
  const seed = [input.reason, String(input.requirementKey ?? ""), input.detail, hour].join("\u0000");
  return fingerprint(seed);
}

/** 递给需求窗口的那段话：先说清被拒在哪，再说清它该改什么。 */
export function renderWindowNote(envelope: WindowNoteEnvelope, lang: "zh" | "en" = "zh"): string {
  const ticket = envelope.requirementKey === null ? "" : `#${envelope.requirementKey}`;
  if (lang === "en") {
    return [
      `[Deck] Dispatch was refused${ticket ? ` for ${ticket}` : ""}: ${envelope.detail}`,
      `You are this project's requirement window and this ticket's body is yours to fix: correct it with deck_issue_patch, then tell the dispatch window it can retry.`,
      `(This note was delivered by the plugin because the refusal belongs to a ticket you own; nobody relayed it by hand.)`,
    ].join("\n\n");
  }
  return [
    `[Deck · 插件自动递条子] 派单窗口被拒${ticket ? `，票 ${ticket}` : ""}：${envelope.detail}`,
    "你是这个项目的需求窗口，这张票的正文归你改：用 deck_issue_patch 把上面那处改对，改完告诉用户（或派单窗口）可以重试了。",
    "这条是插件直接递过来的——用户没有复制粘贴，也不用他来传话。",
  ].join("\n\n");
}
