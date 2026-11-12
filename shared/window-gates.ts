/**
 * 「谁有资格开一条活」的纯判定层。
 *
 * 配置里的主沟通窗口 / 需求窗口 / 派单窗口 / 进度窗口，过去只是默认值与身份提示词；
 * 任何会话都能派单、都能开子会话、都能建票。这里把判定收成纯函数，供 MCP 入口、RPC 入口
 * 与 `agent.created` 三处共用同一把尺子，避免三处各写一套。
 *
 * 三条口径：
 * 1. 派单是显式动作，失败方向是拒绝——身份不明、工作区不明都不放行。
 * 2. 创建子会话是后台事件，失败方向是放行——读盘失败不能误杀正常会话。
 * 3. 同一个会话同时占多个槽位时，按「派单窗口 > 需求窗口 > 主窗口 > 进度窗口」优先判定。
 *
 * 建票与改需求票也走这里：绑定了需求窗口就只认它；主窗口 / 进度窗口不建票；
 * 还没绑定或身份不明时放行（护栏不是沙箱），由调用方在日志里留一行。
 */

export type WindowRole = "main" | "requirement" | "dispatcher" | "progress";

export interface WindowSlots {
  mainAgentId: string | null;
  requirementAgentId: string | null;
  dispatcherAgentId: string | null;
  progressAgentId: string | null;
}

interface RoleSlotCarrier {
  mainAgentId?: string;
  requirementAgentId?: string;
  dispatcherAgentId?: string;
  progressAgentId?: string;
}

/** 从角色绑定里取四个槽位；空串按「没配」处理。 */
export function windowSlotsOf(role: RoleSlotCarrier | null | undefined): WindowSlots {
  if (!role) return { mainAgentId: null, requirementAgentId: null, dispatcherAgentId: null, progressAgentId: null };
  return {
    mainAgentId: role.mainAgentId?.trim() || null,
    requirementAgentId: role.requirementAgentId?.trim() || null,
    dispatcherAgentId: role.dispatcherAgentId?.trim() || null,
    progressAgentId: role.progressAgentId?.trim() || null,
  };
}

/** 这个会话占的所有槽位；同一个会话可以同时是主窗口和派单窗口。 */
export function rolesOfAgent(slots: WindowSlots | null | undefined, agentId: string | null | undefined): WindowRole[] {
  const id = agentId?.trim();
  if (!slots || !id) return [];
  const roles: WindowRole[] = [];
  if (slots.mainAgentId === id) roles.push("main");
  if (slots.requirementAgentId === id) roles.push("requirement");
  if (slots.dispatcherAgentId === id) roles.push("dispatcher");
  if (slots.progressAgentId === id) roles.push("progress");
  return roles;
}

/** 单值版本：按「派单窗口 > 需求窗口 > 主窗口 > 进度窗口」取一个，给只需要一个身份的地方用。 */
export function roleOfAgent(slots: WindowSlots | null | undefined, agentId: string | null | undefined): WindowRole | null {
  const roles = rolesOfAgent(slots, agentId);
  for (const role of ["dispatcher", "requirement", "main", "progress"] as const) {
    if (roles.includes(role)) return role;
  }
  return null;
}

/* ------------------------------------------------------------------ 派单入口 */

export type DispatchCallerReason =
  | "caller-unknown"
  | "workspace-ambiguous"
  | "no-workspace"
  | "no-dispatcher"
  | "main-cannot-dispatch"
  | "requirement-cannot-dispatch"
  | "progress-cannot-dispatch"
  | "caller-not-dispatcher";

export type DispatchCallerVerdict =
  | { ok: true; dispatcherAgentId: string; role: "dispatcher" }
  | { ok: false; reason: DispatchCallerReason; detail: string };

export interface DispatchCallerInput {
  /** 真实调用者（MCP 取 `PASEO_AGENT_ID`，RPC 取显式传入的 callerAgentId）。 */
  callerAgentId: string | null | undefined;
  /** 这个工作区的角色绑定；`null` = 这个工作区没有任何绑定。 */
  slots: WindowSlots | null | undefined;
  /** 同一个会话命中多个工作区的角色绑定，无法唯一确定它属于哪一片。 */
  workspaceAmbiguous?: boolean;
}

/**
 * 派单调用者判定。
 *
 * 只有绑定的派单窗口能派单；主窗口、需求窗口与进度窗口被点名拒绝，其他会话得到
 * `caller-not-dispatcher`。派单窗口同时也是主窗口时按派单窗口放行——
 * 用户可以把两个槽位合成一个会话，不该反过来把它锁死。
 */
export function judgeDispatchCaller(input: DispatchCallerInput): DispatchCallerVerdict {
  const caller = input.callerAgentId?.trim() ?? "";
  if (!caller) {
    return {
      ok: false,
      reason: "caller-unknown",
      detail: "拿不到本会话的 agent id（PASEO_AGENT_ID 为空）：派单必须有会话身份，身份不明时不开工。",
    };
  }
  if (input.workspaceAmbiguous) {
    return {
      ok: false,
      reason: "workspace-ambiguous",
      detail: `会话 ${caller} 同时命中多个工作区的角色绑定：先到「编排」里确认它属于哪个工作区。`,
    };
  }
  const slots = input.slots;
  if (!slots) {
    return {
      ok: false,
      reason: "no-workspace",
      detail: "这个工作区没有任何角色绑定：先到「编排」里加一条工作区角色。",
    };
  }
  const dispatcher = slots.dispatcherAgentId;
  if (!dispatcher) {
    return {
      ok: false,
      reason: "no-dispatcher",
      detail: "这个工作区还没有指定派单窗口：先到「编排」里选一个会话。",
    };
  }
  if (caller === dispatcher) return { ok: true, dispatcherAgentId: dispatcher, role: "dispatcher" };
  // 与 roleOfAgent 同序：同时占需求与主窗口的会话按需求窗口回答，别两处给两个身份。
  if (caller === slots.requirementAgentId) {
    return {
      ok: false,
      reason: "requirement-cannot-dispatch",
      detail: "需求窗口只建需求票，不派活：把票号交给主窗口或派单窗口，由派单窗口拆活。",
    };
  }
  if (caller === slots.mainAgentId) {
    return {
      ok: false,
      reason: "main-cannot-dispatch",
      detail: "主窗口不派活：把需求票号和任务交给派单窗口（deck_handoff_to_dispatcher），由它拆活。",
    };
  }
  if (caller === slots.progressAgentId) {
    return {
      ok: false,
      reason: "progress-cannot-dispatch",
      detail: "进度窗口只旁听，不派活：派单由派单窗口负责。",
    };
  }
  return {
    ok: false,
    reason: "caller-not-dispatcher",
    detail: `这次是 ${caller} 在派单，绑定的派单窗口是 ${dispatcher}：只有派单窗口能派单。`,
  };
}

/* ------------------------------------------------------------------ 主窗口交接 */

export type HandoffCallerReason = "caller-unknown" | "caller-not-main" | "no-main" | "no-dispatcher" | "dispatcher-is-main";

export type HandoffCallerVerdict =
  | { ok: true; mainAgentId: string; dispatcherAgentId: string }
  | { ok: false; reason: HandoffCallerReason; detail: string };

/** 交接只有主窗口能发；没有派单窗口就没有收件人，也不能假装已交接。 */
export function judgeHandoffCaller(input: {
  callerAgentId: string | null | undefined;
  slots: WindowSlots | null | undefined;
}): HandoffCallerVerdict {
  const caller = input.callerAgentId?.trim() ?? "";
  if (!caller) {
    return { ok: false, reason: "caller-unknown", detail: "拿不到本会话的 agent id（PASEO_AGENT_ID 为空）：交接必须有会话身份。" };
  }
  const slots = input.slots;
  const main = slots?.mainAgentId ?? null;
  const dispatcher = slots?.dispatcherAgentId ?? null;
  if (!main) {
    return { ok: false, reason: "no-main", detail: "这个工作区还没有指定主沟通窗口：先到「编排」里选一个会话。" };
  }
  if (caller !== main) {
    return {
      ok: false,
      reason: "caller-not-main",
      detail: `只有主沟通窗口能交接：当前调用者是 ${caller}，主沟通窗口是 ${main}。`,
    };
  }
  if (!dispatcher) {
    return { ok: false, reason: "no-dispatcher", detail: "这个工作区还没有指定派单窗口：先到「编排」里选一个会话，再交接。" };
  }
  if (dispatcher === main) {
    return {
      ok: false,
      reason: "dispatcher-is-main",
      detail: "主窗口与派单窗口是同一个会话：直接在这个窗口里派单，不需要交接。",
    };
  }
  return { ok: true, mainAgentId: main, dispatcherAgentId: dispatcher };
}

/* ------------------------------------------------------------------ 需求票写入 */

export type TicketWriteReason = "requirement-window-only" | "requirement-cannot-write-work";

export type TicketWriteVerdict =
  | { ok: true }
  | { ok: false; reason: TicketWriteReason; detail: string };

/**
 * 需求票的写闸：工作区绑定了需求窗口之后，只有它能建 / 改需求票；
 * 它自己也只碰需求票，不建、不改工作票。
 *
 * 两条失败方向：
 * - 没绑定需求窗口时放行——老工作区不该因为没配这个槽位就再也建不了票；
 * - 身份不明（拿不到 `PASEO_AGENT_ID`）时放行，与创建门 / 执行门一致，这是护栏不是沙箱。
 */
export function judgeRequirementTicketWriter(input: {
  callerAgentId: string | null | undefined;
  slots: WindowSlots | null | undefined;
  /** 写入之前这张票是不是需求票；新建时与 `nextIsRequirement` 相同。 */
  currentIsRequirement: boolean;
  /** 写完之后是不是需求票；改标签时要按目标标签集重算，不能只看现状。 */
  nextIsRequirement: boolean;
}): TicketWriteVerdict {
  const caller = input.callerAgentId?.trim() ?? "";
  if (!caller) return { ok: true };
  const requirement = input.slots?.requirementAgentId ?? null;
  // 还没绑定需求窗口：这道闸不生效，别把老工作区锁死。
  if (!requirement) return { ok: true };
  const was = input.currentIsRequirement;
  const next = input.nextIsRequirement;
  if (caller === requirement) {
    if (was && next) return { ok: true };
    if (was && !next) {
      return {
        ok: false,
        reason: "requirement-cannot-write-work",
        detail: "这次写入会把需求票改成工作票：需求窗口只建需求票，不写工作票。",
      };
    }
    // 现状不是需求票，等于在写工作票；同一个会话同时是派单窗口时按派单窗口放行。
    if (roleOfAgent(input.slots, caller) !== "requirement") return { ok: true };
    return {
      ok: false,
      reason: "requirement-cannot-write-work",
      detail: "需求窗口只建需求票，不建也不改工作票：把需求交给派单窗口，由它拆成工作票。",
    };
  }
  if (was || next) {
    return {
      ok: false,
      reason: "requirement-window-only",
      detail: `需求票只有需求窗口（${requirement}）能建、能改：当前调用者是 ${caller}。要动需求票请到需求窗口。`,
    };
  }
  return { ok: true };
}

export type TicketCreateReason = "main-cannot-create-tickets" | "progress-cannot-create-tickets";

/**
 * 建票闸：主窗口与进度窗口不建票。
 *
 * 需求窗口与派单窗口各自有专门的票型闸；这里只兜住另外两个只读窗口，
 * 让「主窗口仍然不建票」不只是提示词里的一句话。执行会话不受影响。
 */
export function judgeTicketCreator(input: {
  callerAgentId: string | null | undefined;
  slots: WindowSlots | null | undefined;
}): { ok: true } | { ok: false; reason: TicketCreateReason; detail: string } {
  const caller = input.callerAgentId?.trim() ?? "";
  if (!caller) return { ok: true };
  const role = roleOfAgent(input.slots, caller);
  if (role === "main") {
    return {
      ok: false,
      reason: "main-cannot-create-tickets",
      detail: "主窗口不建票：需求交给需求窗口建票，派活交给派单窗口。",
    };
  }
  if (role === "progress") {
    return {
      ok: false,
      reason: "progress-cannot-create-tickets",
      detail: "进度窗口只旁听，不建票：需求交给需求窗口，工作票由派单窗口拆。",
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ 创建子会话 */

export type RoleChildReason = "main-cannot-create" | "requirement-cannot-create" | "progress-cannot-create";

export type RoleChildDecision =
  | { archive: false }
  | { archive: true; reason: RoleChildReason; detail: string; notice: string };

export interface RoleChildInput {
  /** 新会话的父会话；没有父会话 = 人从面板手工建，不归这道闸管。 */
  parentAgentId: string | null | undefined;
  /** 父会话占的角色槽位。 */
  parentRoles: readonly WindowRole[];
  /** 新会话自己就是配置里的角色窗口：绝不能因为它有父会话就归档。 */
  childIsRoleWindow?: boolean;
}

/**
 * 主窗口 / 需求窗口 / 进度窗口不能直接开子会话；派单窗口可以，已派出的执行会话也可以。
 *
 * 新会话本身是角色窗口时一律放行：角色窗口重建时可能带着父会话，
 * 把它归档等于把整条链的上游拆掉。
 */
export function decideRoleChild(input: RoleChildInput): RoleChildDecision {
  if (!input.parentAgentId?.trim()) return { archive: false };
  if (input.childIsRoleWindow) return { archive: false };
  const roles = input.parentRoles;
  if (roles.includes("dispatcher")) return { archive: false };
  // 与 roleOfAgent 同序：同时占需求与主窗口的会话按需求窗口回答，别两处给两个身份。
  if (roles.includes("requirement")) {
    return {
      archive: true,
      reason: "requirement-cannot-create",
      detail: "需求窗口只建需求票，不开执行会话。",
      notice: "需求窗口只建需求票：这次新建的会话已归档。要派活请交给派单窗口。",
    };
  }
  if (roles.includes("main")) {
    return {
      archive: true,
      reason: "main-cannot-create",
      detail: "主窗口不直接开执行会话：派活要走派单窗口。",
      notice: "主窗口不直接开执行会话：这次新建的会话已归档。把需求票号和任务交给派单窗口（deck_handoff_to_dispatcher），由它派。",
    };
  }
  if (roles.includes("progress")) {
    return {
      archive: true,
      reason: "progress-cannot-create",
      detail: "进度窗口只旁听，不开执行会话。",
      notice: "进度窗口只旁听：这次新建的会话已归档。",
    };
  }
  return { archive: false };
}
