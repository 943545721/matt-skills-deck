import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { StaffCard } from "./staff.ts";

/**
 * 群视图的线上契约与**纯路由**。
 *
 * 群的语义是「派活入口，不是聊天窗口」：
 * - 不带 `@` → 发给主窗口；主窗口没绑就报错，不偷偷改发给派单窗口；
 * - `@岗位` → 先建票、再建会话（票带着 `deck.staff` 与 `Refs: #需求票`）；
 * - `@全部` → 一次确认后由插件自己铺 N 张票，不是逐张触发宿主确认。
 *
 * 路由放在这里而不是 handler 里，是因为它全是判定：谁被点到、票面写什么、
 * 需求没定稿时整句拒绝。判定不碰 IO，才能一条条测清楚；handler 只负责
 * 「按这份计划建票、建会话、落群记录」。
 */

/**
 * 群标签。值是**这个群所在目录**，不是 workspaceId：同一个目录每次重开都会换一个
 * workspaceId，群却还是同一个。口径是「一个项目一个群」。
 */
export const DECK_GROUP_LABEL = "deck.group";

/** 群消息里一条消息转成的派单计划；`toMain` 时 `staffId` 为 null。 */
export const groupTargetPlanSchema = z.object({
  staffId: z.string().max(64).nullable(),
  name: z.string().max(64),
  toMain: z.boolean(),
  /** 票标题 = 这一句原话（截到宿主能接受的长度）。主窗口不收票，这个字段仍带着。 */
  ticketTitle: z.string().max(200),
  /** 票正文：`Refs: #需求票` + 群派给谁 + 原话。 */
  ticketBody: z.string().max(20_000),
});

export type GroupTargetPlan = z.infer<typeof groupTargetPlanSchema>;

export const groupDeliverySchema = z.object({
  staffId: z.string().max(64).nullable(),
  name: z.string().max(64),
  agentId: z.string().max(300).nullable(),
  ticketNumber: z.number().int().positive().nullable(),
  /** 单个目标失败时写原因；其他目标照常派。 */
  detail: z.string().max(2000).optional(),
});

export type GroupDelivery = z.infer<typeof groupDeliverySchema>;

export const groupSendReasonSchema = z.enum([
  "empty",
  "no-main",
  "unknown-staff",
  "ambiguous-staff",
  "mixed-all",
  "no-staff-on-roster",
  "no-requirement",
  "requirement-not-final",
  "invalid-workspace",
  /** 幂等记录读不出来：不能确认这句之前有没有派过，拒绝重试比重复建票 / 建会话安全。 */
  "read-failed",
]);
export type GroupSendReason = z.infer<typeof groupSendReasonSchema>;

/**
 * 一条群记录。不带工作区：群读只读当前目录的记录，别的目录的对话不会出现在这里。
 *
 * `system` 保留下来只为读旧文件：早先跨目录转派时会写一行「已转派给 …」的索引，
 * 那些记录还躺在磁盘上，读不出来就成了「消息凭空消失」。现在没有地方再写这个 kind。
 */
export const groupRecordSchema = z.object({
  at: z.string(),
  from: z.string().max(64),
  agentId: z.string().max(300),
  kind: z.enum(["user", "staff", "system"]),
  text: z.string().max(2000),
});

export const groupMemberSchema = z.object({
  agentId: z.string(),
  staffId: z.string().max(64),
  title: z.string().max(500),
  status: z.string().max(64),
  archived: z.boolean(),
});

export type GroupMember = z.infer<typeof groupMemberSchema>;

/** 本群名册上的一个人。群成员表按这个画，不按会话清单画（没起会话的人也在）。 */
export const groupRosterStaffSchema = z.object({
  staffId: z.string().max(64),
  name: z.string().max(64),
  kind: z.enum(["manager", "worker"]),
});

/** 本群名册上的人。`detail` 有值时 `staff` 为空是「读失败」，不是「没人」。 */
export const groupRosterSchema = z.object({
  staff: z.array(groupRosterStaffSchema),
  detail: z.string().max(2000).optional(),
});

export type GroupRoster = z.infer<typeof groupRosterSchema>;

const groupCandidateSchema = z.object({
  staffId: z.string().max(64),
  /** 重名时把原名列出来让人点，不自动改名。 */
  name: z.string().max(64),
});

const scope = {
  workspaceId: z.string().min(1).max(300),
  workspaceDir: z.string().min(1).max(4096),
};

/**
 * 发一条群消息。
 *
 * `confirmAll` 只对 `@全部` 有意义：没有它时服务端只回清单（`status: "preview"`），
 * 一张票也不建。这不是安全边界，是「八个会话是八份钱」的那一次停顿。
 */
export const groupSendRpc = defineRpc({
  name: "deck.group.send",
  input: z.object({
    ...scope,
    text: z.string().min(1).max(20_000),
    /** 这条消息挂在哪个需求票下；带 `@` 时必须给，且那张票必须已 `deck:定稿`。 */
    requirementNumber: z.number().int().positive().nullable().optional(),
    confirmAll: z.boolean().optional(),
    /** 重试幂等键：同一句重发不重复建票。 */
    requestId: z.string().max(200).optional(),
    /**
     * 点名册选中的人。给了就只派给这张卡，正文里的 `@` 不再当路由。
     * 不改名字、不加后缀：重名时由调用方先点定这一张。
     */
    staffId: z.string().min(1).max(64).optional(),
    lang: z.enum(["en", "zh"]).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      status: z.literal("preview"),
      targets: z.array(groupTargetPlanSchema),
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(true),
      status: z.literal("sent"),
      deliveries: z.array(groupDeliverySchema),
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: groupSendReasonSchema,
      detail: z.string(),
      candidates: z.array(groupCandidateSchema).optional(),
    }),
  ]),
});

/** 群成员（宿主会话清单按 `deck.group` 过滤）+ 本群名册 + 群记录（索引，不是真相）。 */
export const groupReadRpc = defineRpc({
  name: "deck.group.read",
  input: z.object({
    ...scope,
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      members: z.array(groupMemberSchema),
      /** 本群名册。一个群只属于一个目录，所以只有这一份。 */
      roster: groupRosterSchema,
      records: z.array(groupRecordSchema),
      skipped: z.number().int(),
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid-workspace", "read-failed"]),
      detail: z.string(),
    }),
  ]),
});

export interface GroupMention {
  /** 原文里的 token，不含 `@`。 */
  token: string;
  all: boolean;
  /** 按名字 / id 命中的卡；`all` 或没命中时为 null。 */
  staffId: string | null;
  /** 同名的卡多于一张时列出候选，调用方据此拒绝并让人点选。 */
  candidates: { staffId: string; name: string }[];
}

/** `@名字` / `@id` / `@全部` / `@all`；按出现顺序，重复的 token 只算一次。 */
export function parseGroupMentions(text: string): GroupMention[] {
  const out: GroupMention[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/@([^\s@，,。:：!！?？]+)/g)) {
    const token = (match[1] ?? "").trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push({ token, all: /^(全部|所有人|all|everyone)$/i.test(token), staffId: null, candidates: [] });
  }
  return out;
}

/**
 * 重名时给界面点的那种候选。
 *
 * 只带本群名册里的一张卡：一个群只属于一个目录，不存在「哪个工作区的那张」。
 */
export interface GroupStaffCandidate {
  staffId: string;
  name: string;
}

export interface GroupSendPlanInput {
  text: string;
  staff: readonly StaffCard[];
  /** 主窗口（绑定了 `paseo.main-agent-id` 的那个会话）；没绑就是 null。 */
  mainAgentId: string | null;
  requirement: { number: number; finalized: boolean } | null;
  /** `@全部` 的二次确认；只对 `@全部` 有意义。 */
  confirmAll?: boolean;
  /**
   * 点名册选中的卡。给了就只派给这个人，正文里的 `@` 不当路由。
   * 重名时调用方已经点定了这一张，这里不再改名字。
   */
  staffId?: string;
}

export type GroupSendPlan =
  | { ok: true; phase: "preview"; targets: GroupTargetPlan[] }
  | { ok: true; phase: "send"; targets: GroupTargetPlan[] }
  | {
      ok: false;
      reason: GroupSendReason;
      detail: string;
      candidates?: GroupStaffCandidate[];
    };

/** 正文里有没有 `@全部` / `@all`。界面用它决定「点选的人」要不要让路给广播。 */
export function groupTextIsBroadcast(text: string): boolean {
  return parseGroupMentions(text).some((mention) => mention.all);
}

const MAX_TICKET_TITLE = 200;

function ticketTitleOf(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TICKET_TITLE ? `${oneLine.slice(0, MAX_TICKET_TITLE - 1)}…` : oneLine;
}

function ticketBodyOf(text: string, requirementNumber: number, name: string, staffId: string): string {
  return [
    `Refs: #${requirementNumber}`,
    "",
    `群派给：${name}（${staffId}）`,
    "",
    "原话：",
    text.trim(),
    "",
  ].join("\n");
}

function planForStaff(
  card: GroupStaffCandidate,
  text: string,
  requirementNumber: number,
): GroupTargetPlan {
  return {
    staffId: card.staffId,
    name: card.name,
    toMain: false,
    ticketTitle: ticketTitleOf(text),
    ticketBody: ticketBodyOf(text, requirementNumber, card.name, card.staffId),
  };
}

function requirementProblem(
  input: GroupSendPlanInput,
): { reason: GroupSendReason; detail: string } | null {
  if (!input.requirement) {
    return {
      reason: "no-requirement",
      detail: "群里派活要先有一张需求票：这条消息没有挂在任何需求下，整句不派。",
    };
  }
  if (!input.requirement.finalized) {
    return {
      reason: "requirement-not-final",
      detail: `需求 #${input.requirement.number} 还没定稿（缺 deck:定稿）：整句不派，也不建票。`,
    };
  }
  return null;
}

/** 给人看的名册清单：名字 + id，不把目录路径当名字。 */
function rosterLabel(staff: readonly StaffCard[]): string {
  const parts = staff.map((card) => `${card.name}（${card.id}）`);
  return parts.join("、") || "（名册是空的）";
}

function unknownStaff(token: string, staff: readonly StaffCard[]): GroupSendPlan {
  return {
    ok: false,
    reason: "unknown-staff",
    detail: `名册上没有「${token}」。现有岗位：${rosterLabel(staff)}。`,
  };
}

function ambiguousStaff(token: string, hits: readonly StaffCard[]): GroupSendPlan {
  return {
    ok: false,
    reason: "ambiguous-staff",
    detail: `「${token}」对应 ${hits.length} 张卡，点一个再发。`,
    candidates: hits.map((card) => ({ staffId: card.id, name: card.name })),
  };
}

/**
 * 按 id 找卡：点选走这里。id 命中就不再用名字匹配，避免同名卡把点选搅回去。
 */
function planPickedStaff(input: GroupSendPlanInput, text: string, staffId: string): GroupSendPlan {
  const needle = staffId.trim().toLowerCase();
  const card = input.staff.find((item) => item.id.toLowerCase() === needle);
  if (!card) return unknownStaff(staffId.trim(), input.staff);
  return {
    ok: true,
    phase: "send",
    targets: [planForStaff({ staffId: card.id, name: card.name }, text, input.requirement!.number)],
  };
}

/**
 * 按正文里的 `@` 找人。id 优先于名字；重名把原名列出来让人点，不自动加后缀。
 */
function planNamedMentions(
  input: GroupSendPlanInput,
  text: string,
  named: readonly GroupMention[],
  requirementNumber: number,
): GroupSendPlan {
  const resolved: GroupStaffCandidate[] = [];
  for (const mention of named) {
    const needle = mention.token.trim().toLowerCase();
    const byId = input.staff.filter((card) => card.id.toLowerCase() === needle);
    const hits = byId.length
      ? byId
      : input.staff.filter((card) => card.name.trim().toLowerCase() === needle);
    if (hits.length === 0) return unknownStaff(mention.token, input.staff);
    if (hits.length > 1) return ambiguousStaff(mention.token, hits);
    const hit = hits[0]!;
    if (!resolved.some((item) => item.staffId === hit.id)) resolved.push({ staffId: hit.id, name: hit.name });
  }

  return {
    ok: true,
    phase: "send",
    targets: resolved.map((card) => planForStaff(card, text, requirementNumber)),
  };
}

/**
 * 把一句群消息算成目标清单。纯函数：不建票、不建会话、不读文件。
 *
 * 返回 `phase: "preview"` 时调用方只能把清单递给界面；`"send"` 才是可以动手的。
 * 这里只认得**本群名册**上的卡：一个群属于一个目录，别的项目的人不在这份名册里。
 */
export function planGroupSend(input: GroupSendPlanInput): GroupSendPlan {
  const text = input.text.trim();
  if (!text) return { ok: false, reason: "empty", detail: "群消息是空的，没有可派的内容。" };

  // 点选优先于正文里的 `@`：人已经点定了这张卡，正文只是交给他的那句话。
  const picked = input.staffId?.trim();
  if (picked) {
    const problem = requirementProblem(input);
    if (problem) return { ok: false, ...problem };
    return planPickedStaff(input, text, picked);
  }

  const mentions = parseGroupMentions(text);
  const named = mentions.filter((mention) => !mention.all);
  const wantsAll = mentions.some((mention) => mention.all);
  if (wantsAll && named.length > 0) {
    return {
      ok: false,
      reason: "mixed-all",
      detail: "@全部 不能和具体岗位写在同一条消息里：要么整条广播，要么点一个人。",
    };
  }

  if (mentions.length === 0) {
    if (!input.mainAgentId) {
      return {
        ok: false,
        reason: "no-main",
        detail: "没有 @ 的消息发给主窗口，但当前工作区没有绑定主窗口：先绑定，或 @ 一个岗位。",
      };
    }
    return {
      ok: true,
      phase: "send",
      targets: [
        {
          staffId: null,
          name: "主窗口",
          toMain: true,
          ticketTitle: ticketTitleOf(text),
          ticketBody: text,
        },
      ],
    };
  }

  const problem = requirementProblem(input);
  if (problem) return { ok: false, ...problem };
  const requirementNumber = input.requirement!.number;

  // `@全部` 只铺本群名册：一个群一个目录，不存在「顺便把别的项目的人也叫上」。
  if (wantsAll) {
    if (input.staff.length === 0) {
      return {
        ok: false,
        reason: "no-staff-on-roster",
        detail: "名册上还没有岗位卡：@全部 没有可派的人。先到编排页加卡。",
      };
    }
    const targets = input.staff.map((card) => planForStaff({ staffId: card.id, name: card.name }, text, requirementNumber));
    return input.confirmAll ? { ok: true, phase: "send", targets } : { ok: true, phase: "preview", targets };
  }

  return planNamedMentions(input, text, named, requirementNumber);
}
