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
  /** 一句话点到了两个工作区的人：一条派活只落在一个工作区。 */
  "cross-workspace",
  /** 幂等记录读不出来：不能确认这句之前有没有派过，拒绝重试比重复建票 / 建会话安全。 */
  "read-failed",
]);
export type GroupSendReason = z.infer<typeof groupSendReasonSchema>;

export const groupRecordSchema = z.object({
  at: z.string(),
  from: z.string().max(64),
  agentId: z.string().max(300),
  kind: z.enum(["user", "staff", "system"]),
  text: z.string().max(2000),
  /** 这条记录落在哪个工作区。单工作区的旧记录可以不带。 */
  workspaceId: z.string().max(300).optional(),
  workspaceName: z.string().max(300).optional(),
});

export const groupMemberSchema = z.object({
  agentId: z.string(),
  staffId: z.string().max(64),
  title: z.string().max(500),
  status: z.string().max(64),
  archived: z.boolean(),
});

export type GroupMember = z.infer<typeof groupMemberSchema>;

/** 一个工作区名册上的一个人。群成员表按这个画，不按会话清单画。 */
export const groupRosterStaffSchema = z.object({
  staffId: z.string().max(64),
  name: z.string().max(64),
  kind: z.enum(["manager", "worker"]),
});

/** 一个工作区的名册。`detail` 有值时 `staff` 为空是「读失败」，不是「没人」。 */
export const groupRosterSchema = z.object({
  workspaceId: z.string().max(300),
  workspaceDir: z.string().max(4096),
  name: z.string().max(300),
  current: z.boolean(),
  staff: z.array(groupRosterStaffSchema),
  detail: z.string().max(2000).optional(),
});

export type GroupRoster = z.infer<typeof groupRosterSchema>;

const groupCandidateSchema = z.object({
  staffId: z.string().max(64),
  name: z.string().max(64),
  /** 重名跨工作区时带上，让人点的是「哪个工作区的这张卡」，不是改过的名字。 */
  workspaceId: z.string().max(300).optional(),
  workspaceDir: z.string().max(4096).optional(),
  workspaceName: z.string().max(300).optional(),
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

/** 群成员（宿主会话清单按 `deck.group` 过滤）+ 群记录（索引，不是真相）。 */
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
      /** 按工作区分组的名册。当前工作区排在第一位。 */
      rosters: z.array(groupRosterSchema),
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

/** 一份名册，属于一个工作区。当前工作区用 `staff` + `workspace`，其余放 `otherRosters`。 */
export interface GroupRosterSlice {
  workspaceId: string;
  workspaceDir: string;
  /** 给人看的工作区名。候选里用它，不把目录路径当名字。 */
  name: string;
  staff: readonly { id: string; name: string }[];
}

export interface GroupStaffCandidate {
  staffId: string;
  name: string;
  workspaceId?: string;
  workspaceDir?: string;
  workspaceName?: string;
}

export interface GroupSendScope {
  workspaceId: string;
  workspaceDir: string;
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
  /** 当前请求所在的工作区。没给时按「只有这一份名册」处理，候选不带工作区。 */
  workspace?: GroupRosterSlice;
  /** 其它工作区的名册。名字对不上当前区、或跨区重名时到这里找。 */
  otherRosters?: readonly GroupRosterSlice[];
}

export type GroupSendPlan =
  | { ok: true; phase: "preview"; targets: GroupTargetPlan[]; scope?: GroupSendScope }
  | { ok: true; phase: "send"; targets: GroupTargetPlan[]; scope?: GroupSendScope }
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
  card: { staffId: string; name: string },
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

interface Address {
  staffId: string;
  name: string;
  workspaceId: string;
  workspaceDir: string;
  workspaceName: string;
}

function slicesOf(input: GroupSendPlanInput): GroupRosterSlice[] {
  const here: GroupRosterSlice = input.workspace ?? {
    workspaceId: "",
    workspaceDir: "",
    name: "",
    staff: input.staff,
  };
  const current: GroupRosterSlice = input.workspace ? { ...input.workspace, staff: input.staff } : here;
  return [current, ...(input.otherRosters ?? [])];
}

function addresses(
  slices: readonly GroupRosterSlice[],
  match: (card: { id: string; name: string }) => boolean,
): Address[] {
  const hits: Address[] = [];
  for (const slice of slices) {
    for (const card of slice.staff) {
      if (!match(card)) continue;
      hits.push({
        staffId: card.id,
        name: card.name,
        workspaceId: slice.workspaceId,
        workspaceDir: slice.workspaceDir,
        workspaceName: slice.name,
      });
    }
  }
  return hits;
}

function candidateOf(hit: Address): GroupStaffCandidate {
  if (!hit.workspaceId) return { staffId: hit.staffId, name: hit.name };
  return {
    staffId: hit.staffId,
    name: hit.name,
    workspaceId: hit.workspaceId,
    workspaceDir: hit.workspaceDir,
    workspaceName: hit.workspaceName,
  };
}

function scopeOf(hit: Address): { scope: GroupSendScope } | Record<string, never> {
  if (!hit.workspaceId || !hit.workspaceDir) return {};
  return { scope: { workspaceId: hit.workspaceId, workspaceDir: hit.workspaceDir } };
}

/** 给人看的名册清单。有工作区名时写在 id 旁边，不改卡的名字。 */
function rosterLabel(slices: readonly GroupRosterSlice[]): string {
  const parts: string[] = [];
  for (const slice of slices) {
    for (const card of slice.staff) {
      const where = slice.name ? `${card.id} · ${slice.name}` : card.id;
      parts.push(`${card.name}（${where}）`);
    }
  }
  return parts.join("、") || "（名册是空的）";
}

function unknownStaff(token: string, slices: readonly GroupRosterSlice[]): GroupSendPlan {
  return {
    ok: false,
    reason: "unknown-staff",
    detail: `名册上没有「${token}」。现有岗位：${rosterLabel(slices)}。`,
  };
}

function ambiguousStaff(token: string, hits: readonly Address[]): GroupSendPlan {
  return {
    ok: false,
    reason: "ambiguous-staff",
    detail: `「${token}」对应 ${hits.length} 张卡，点一个再发。`,
    candidates: hits.map(candidateOf),
  };
}

/**
 * 按 id 找卡：点选走这里。id 命中就不再用名字匹配，避免同名卡把点选搅回去。
 */
function planPickedStaff(input: GroupSendPlanInput, text: string, staffId: string): GroupSendPlan {
  const slices = slicesOf(input);
  const needle = staffId.trim().toLowerCase();
  const hits = addresses(slices, (card) => card.id.toLowerCase() === needle);
  // 人已经点了当前这份名册上的卡。别的工作区碰巧有同一个 id，不再拿来问第二次。
  const homeId = slices[0]?.workspaceId ?? "";
  const atHome = homeId ? hits.filter((hit) => hit.workspaceId === homeId) : [];
  const chosen = atHome.length === 1 ? atHome : hits;
  if (chosen.length === 0) return unknownStaff(staffId.trim(), slices);
  if (chosen.length > 1) return ambiguousStaff(staffId.trim(), hits);
  const hit = chosen[0]!;
  return {
    ok: true,
    phase: "send",
    targets: [planForStaff(hit, text, input.requirement!.number)],
    ...scopeOf(hit),
  };
}

/**
 * 按正文里的 `@` 找人。id 优先于名字；重名把原名列出来让人点，不自动加后缀。
 * 点到的人必须落在同一个工作区：一条派活不跨区建会话。
 */
function planNamedMentions(
  input: GroupSendPlanInput,
  text: string,
  named: readonly GroupMention[],
  requirementNumber: number,
): GroupSendPlan {
  const slices = slicesOf(input);
  const resolved: Address[] = [];
  for (const mention of named) {
    const needle = mention.token.trim().toLowerCase();
    const byId = addresses(slices, (card) => card.id.toLowerCase() === needle);
    const hits = byId.length
      ? byId
      : addresses(slices, (card) => card.name.trim().toLowerCase() === needle);
    if (hits.length === 0) return unknownStaff(mention.token, slices);
    if (hits.length > 1) return ambiguousStaff(mention.token, hits);
    const hit = hits[0]!;
    const seen = resolved.some((item) => item.staffId === hit.staffId && item.workspaceId === hit.workspaceId);
    if (!seen) resolved.push(hit);
  }

  const workspaceIds = [...new Set(resolved.map((item) => item.workspaceId))];
  if (workspaceIds.length > 1) {
    return {
      ok: false,
      reason: "cross-workspace",
      detail: "一条消息点到了多个工作区的人。一条派活只落在一个工作区里：点一个人再发。",
      candidates: resolved.map(candidateOf),
    };
  }

  const first = resolved[0];
  return {
    ok: true,
    phase: "send",
    targets: resolved.map((card) => planForStaff(card, text, requirementNumber)),
    ...(first ? scopeOf(first) : {}),
  };
}

/**
 * 把一句群消息算成目标清单。纯函数：不建票、不建会话、不读文件。
 *
 * 返回 `phase: "preview"` 时调用方只能把清单递给界面；`"send"` 才是可以动手的。
 * `scope` 给出这句实际落在哪个工作区：点了别的区的人，会话就建在那个区。
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

  // `@全部` 只铺当前工作区的名册。跨区的人要点名，不能一次把所有区的钱花出去。
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
