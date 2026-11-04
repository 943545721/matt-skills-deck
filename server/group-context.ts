import { parseGroupMentions } from "../shared/group-rpc.ts";
import type { StaffCard } from "../shared/staff.ts";
import type { GroupRecord } from "./group-store.ts";

/**
 * 群会话的「现拼上下文」。
 *
 * 规格第七节的口径：会话不是记忆单元，是执行单元。每次被唤醒时，把
 * **岗位说明 + 群里与它相关的最近几条 + 岗位履历** 现拼成 systemPrompt，
 * 不维护常驻对话状态。这份模块只做拼装，不读文件、不调宿主；
 * 履历由调用方用 `collectStaffHistory` 取好再传进来，方便单测。
 *
 * 失败方向是放行：这里不做任何校验，拼不出内容就回空串，派活照常。
 */

/** systemPrompt 的总字数上限。提示词每轮都要付钱，不能随群记录无限长。 */
export const GROUP_CONTEXT_MAX_CHARS = 4000;

/** 带进上下文的「@了这位岗位」的群消息条数。 */
export const GROUP_CONTEXT_USER_MESSAGES = 5;

/** 带进上下文的这位岗位自己说过的话条数。 */
export const GROUP_CONTEXT_STAFF_MESSAGES = 3;

/** 单条群消息在提示词里的字数上限：原话通常很短，长贴图/日志不该整段带进去。 */
export const GROUP_CONTEXT_MESSAGE_CHARS = 300;

const TRUNCATED_NOTICE = "（更早的没列）";

export interface GroupContextInput {
  /** 岗位卡；只用到 id / name / duty，测试可以只传这三个字段。 */
  card: Pick<StaffCard, "id" | "name" | "duty">;
  /** 群记录索引，oldest → newest。 */
  records: readonly GroupRecord[];
  /** `collectStaffHistory` 拼好的履历段；空串表示没有历史。 */
  historyText?: string;
  maxChars?: number;
}

export interface GroupContextResult {
  /** 可直接作为 systemPrompt；没有任何内容时是空串。 */
  text: string;
  /** 实际带进提示词的群消息条数（便于日志与测试断言）。 */
  includedRecords: number;
}

function clip(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * 这条消息有没有 @ 到这位岗位（按名字或 id，大小写不敏感）。
 *
 * 必须按 token 精确比对：`@front` 不能命中 `@frontend`，否则一条点名别人的消息
 * 会被带进这位岗位的上下文，看起来像「他点了你」。
 */
function mentionsStaff(text: string, card: Pick<StaffCard, "id" | "name">): boolean {
  const own = [card.name, card.id]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return parseGroupMentions(text).some((mention) => own.includes(mention.token.toLowerCase()));
}

/**
 * 挑出与这位岗位相关的群消息：别人 @ 它的 + 它自己说过的话。
 * 保持时间顺序；同一时刻的按原数组顺序（稳定排序）。
 */
function relevantRecordsOf(
  records: readonly GroupRecord[],
  card: Pick<StaffCard, "id" | "name">,
): GroupRecord[] {
  const users = records.filter((record) => record.kind === "user" && mentionsStaff(record.text, card));
  const staff = records.filter(
    (record) => record.kind === "staff" && record.from.trim() === card.name.trim(),
  );
  const picked = new Set<GroupRecord>([
    ...users.slice(-GROUP_CONTEXT_USER_MESSAGES),
    ...staff.slice(-GROUP_CONTEXT_STAFF_MESSAGES),
  ]);
  return records.filter((record) => picked.has(record));
}

function messageLine(record: GroupRecord): string {
  const who = record.kind === "staff" ? record.from : "你";
  return `- ${record.at} ${who}：${clip(record.text, GROUP_CONTEXT_MESSAGE_CHARS)}`;
}

/**
 * 拼 systemPrompt。顺序刻意固定：
 * 岗位说明 → 群消息 → 履历。群消息最贴近这次被唤醒的原因，放前面；
 * 履历是背景，放最后，被截断时先丢的也是更早的群消息，而不是职责。
 */
export function buildGroupContext(input: GroupContextInput): GroupContextResult {
  const maxChars = Math.max(200, input.maxChars ?? GROUP_CONTEXT_MAX_CHARS);
  const duty = input.card.duty?.trim() ?? "";
  const history = input.historyText?.trim() ?? "";
  const relevant = relevantRecordsOf(input.records, input.card);

  const head: string[] = [];
  if (duty) head.push("## 岗位说明", duty);

  // 履历自己已经有字数上限（`collectStaffHistory` 的 maxChars），不再二次截断；
  // 群消息吃的是剩下的预算。
  const reserved = [head.join("\n"), ...(history ? [history] : [])].join("\n\n").length;
  const title = "## 群里与这个岗位相关的最近消息";
  let budget = maxChars - reserved - title.length - 2;
  const kept: string[] = [];
  for (let index = relevant.length - 1; index >= 0 && budget > 0; index -= 1) {
    const line = messageLine(relevant[index]!);
    if (line.length + 1 > budget) break;
    kept.unshift(line);
    budget -= line.length + 1;
  }
  const truncated = kept.length < relevant.length;

  const parts: string[] = head.length > 0 ? [head.join("\n")] : [];
  if (kept.length > 0) parts.push([title, ...kept, ...(truncated ? [TRUNCATED_NOTICE] : [])].join("\n"));
  if (history) parts.push(history);

  return { text: parts.join("\n\n").trim(), includedRecords: kept.length };
}
