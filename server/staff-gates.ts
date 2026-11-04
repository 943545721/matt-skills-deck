/**
 * `agent.created` 上的两道岗位闸：岗位单例锁 + 滚动额度。
 *
 * 为什么必须落在 `agent.created` 而不是派单工具里：`deck_dispatch_plan` 跑在 MCP 子进程，
 * `ToolContext` 只有 `workspaceDir`，数不出宿主上已经开着几个会话。`agent.created` 的事件
 * 带完整 `context.paseo`，是唯一「绕不开又能动手」的位置（能 `archive()`）。
 *
 * 失败方向固定为**放行**：读不到标签、列表报错、卡被删了，都只记 warn 不归档——
 * 宁可漏拦一次，也不能把正常会话杀掉。
 */

import { DECK_STAFF_LABEL, type StaffCard } from "../shared/orchestration.ts";

/** 滚动额度的窗口：6 小时。 */
export const STAFF_QUOTA_WINDOW_MS = 6 * 60 * 60 * 1000;

export type StaffGateReason = "staff-singleton" | "staff-quota";

export interface StaffGateDecision {
  archive: boolean;
  reason?: StaffGateReason;
  /** 写进日志的一句话：说清拦的是哪条规则、当时数到几个。 */
  detail?: string;
}

/** 判定要用到的会话快照：只取判定需要的那几列，便于纯函数测试。 */
export interface StaffGateSession {
  id: string;
  workspaceId: string | null;
  labels: Readonly<Record<string, string>>;
  /** ISO-8601；解析不出来就别计数（宁可少拦，不可错杀）。 */
  createdAt: string;
  archivedAt?: string | null;
}

export interface StaffGateInput {
  /** 新会话自己的标签（由 `agent.created` 之后 refresh + list 读出来）。 */
  labels: Readonly<Record<string, string>>;
  workspaceId: string | null;
  selfId: string;
  /** 现在的时间（毫秒），由调用方给，纯函数才可测。 */
  now: number;
  roster: readonly StaffCard[];
  /** 每 6 小时最多几个岗位会话；0 = 关掉这道闸。 */
  quota: number;
  /** 宿主会话清单（可以包含别的会话，内部自己按工作区与标签筛）。 */
  sessions: readonly StaffGateSession[];
}

function staffIdOf(labels: Readonly<Record<string, string>>): string {
  return labels[DECK_STAFF_LABEL]?.trim() ?? "";
}

function createdMs(session: StaffGateSession): number {
  const ms = Date.parse(session.createdAt);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * 下单会话该不该被归档。
 *
 * 顺序：先单例锁（同一张卡同时最多几个），再滚动额度（这个工作区 6 小时内最多几个）。
 * 单例锁先判，是因为它按卡算，对「两个会话抢同一批文件」这件事更直接。
 */
export function decideStaffGate(input: StaffGateInput): StaffGateDecision {
  const staffId = staffIdOf(input.labels);
  if (!staffId) return { archive: false }; // 不是岗位会话，不归这两道闸管。

  const card = input.roster.find((item) => item.id === staffId);
  if (!card) {
    // 卡被删了 / 名册改了：没有上限可依据，放行。调用方会把这条记进日志。
    return { archive: false };
  }

  const sameStaff = input.sessions.filter(
    (session) =>
      session.id !== input.selfId &&
      session.workspaceId === input.workspaceId &&
      staffIdOf(session.labels) === staffId &&
      !session.archivedAt,
  );
  const limit = Math.max(1, Math.round(card.maxConcurrent ?? 1));
  if (sameStaff.length >= limit) {
    return {
      archive: true,
      reason: "staff-singleton",
      detail: `岗位「${card.name}」（id=${staffId}）同时最多 ${limit} 个会话，已经有 ${sameStaff.length} 个在名单上`,
    };
  }

  if (input.quota > 0) {
    const since = input.now - STAFF_QUOTA_WINDOW_MS;
    const recent = input.sessions.filter((session) => {
      if (session.workspaceId !== input.workspaceId) return false;
      if (!staffIdOf(session.labels)) return false;
      if (session.archivedAt) return false;
      const ms = createdMs(session);
      return Number.isFinite(ms) && ms >= since;
    });
    // 自己也在 recent 里：第 quota+1 个才该被拦。
    if (recent.length > input.quota) {
      return {
        archive: true,
        reason: "staff-quota",
        detail: `这个工作区 6 小时内已经开了 ${recent.length - 1} 个岗位会话，额度是 ${input.quota} 个`,
      };
    }
  }

  return { archive: false };
}

/** 名册为空时不必去读宿主会话清单：没有卡就没有这两道闸。 */
export function staffGateApplies(roster: readonly StaffCard[]): boolean {
  return roster.length > 0;
}

export interface WorkerDispatchGateInput {
  /** 新会话的父会话；没有父会话 = 人从面板直接建的，不归这道闸管。 */
  parentAgentId: string | null;
  /** 父会话的标签；读不到就传 null（失败方向是放行）。 */
  parentLabels: Readonly<Record<string, string>> | null;
  roster: readonly StaffCard[];
}

export interface WorkerDispatchGateDecision {
  archive: boolean;
  reason?: "staff-worker-dispatch";
  detail?: string;
}

/**
 * 员工不能派活：父会话的 `deck.staff` 指向一张员工卡时，把它派出去的子会话归档。
 *
 * 为什么不在 `deck_dispatch_plan` 里拦：那个工具跑在 MCP 子进程，拿不到调用者的标签
 * （`ToolContext` 只有 `workspaceDir`）。只有 `agent.created` 这一处既有完整
 * `context.paseo`、又必然被触发，是这道闸唯一绕不开的落点。
 *
 * 根经理没有卡、人从面板手工派没有父会话——两种都不拦。卡被删了也放行：
 * 没有证据就不动别人的会话。
 */
export function decideWorkerDispatch(input: WorkerDispatchGateInput): WorkerDispatchGateDecision {
  if (!input.parentAgentId) return { archive: false };
  const labels = input.parentLabels;
  if (!labels) return { archive: false };
  const staffId = (labels[DECK_STAFF_LABEL] ?? "").trim();
  if (!staffId) return { archive: false };
  const card = input.roster.find((item) => item.id === staffId);
  if (!card || card.kind === "manager") return { archive: false };
  return {
    archive: true,
    reason: "staff-worker-dispatch",
    detail: `岗位「${card.name}」（id=${staffId}）是员工，不能派活；要人手应当发 deck_staff_request 问经理`,
  };
}
