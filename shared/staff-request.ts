/**
 * 员工向经理要人：`deck_staff_request` 的入参形状与校验。
 *
 * 员工不能派活（落点在 `agent.created` 的追认），但可以发一条请求。请求落进
 * 和越界协调同一个收件箱 `.deck/coordination.jsonl`，`kind: "staffing"`——
 * 人只有一双眼睛，分两个文件最后一定有一个没人打开。
 *
 * 纯函数：不读盘、不取会话、不读钟。实际写入走
 * `server/staff-territory.ts` 的 `requestCoordination(kind: "staffing")`。
 */

import { MAX_STAFF_ID_CHARS, normalizeStaffId } from "./staff.ts";
import { normalizeOwnerPath } from "./staff-guard.ts";

/** 工具名只在这里写一次：`shared/tool-contract.ts` 与 MCP handler 都引用它。 */
export const STAFF_REQUEST_TOOL_NAME = "deck_staff_request";

/** 请求人要的区：仓库 + 路径前缀。和派单任务上的 `region` 同形。 */
export interface StaffRequestRegion {
  readonly repoKey?: string;
  readonly pathPrefix?: string;
}

/** 员工能填的字段。`staff` 是「建议交给谁」，不是「我是谁」。 */
export interface StaffRequestInput {
  /** 要什么（一句话）。 */
  readonly task: string;
  /** 为什么：越界？量太大？缺权限？ */
  readonly why: string;
  /** 建议交给名册上的哪张卡；可空。 */
  readonly staff?: string;
  /** 这块活落在哪片；可空。 */
  readonly region?: StaffRequestRegion;
  /**
   * 请求人自己的岗位 id。
   *
   * MCP 进程只拿得到 `PASEO_AGENT_ID`，拿不到它身上的 `deck.staff` 标签；
   * 所以由模型从自己的岗位提示词里带过来。没带就记 `unknown`，不冒充别人。
   */
  readonly fromStaff?: string;
}

export interface StaffRequestContext {
  readonly workspaceId: string;
  readonly sessionAgentId: string;
  /** 名册里可选的 id；给了就核对「建议交给谁」确实在名册里。 */
  readonly staffIds?: readonly string[];
  /** 注入时钟，测试用。 */
  readonly at?: string;
}

/** 一条待落盘的协调请求；字段与 `CoordinationRequestInput` 对齐。 */
export interface StaffRequestPlan {
  readonly kind: "staffing";
  readonly workspaceId: string;
  readonly fromStaff: string;
  readonly toStaff: string | null;
  readonly paths: string[];
  readonly sessionAgentId: string;
  readonly taskSummary: string;
  readonly need: string;
  readonly at?: string;
}

export type StaffRequestRejectReason =
  | "empty-task"
  | "empty-why"
  | "no-agent-id"
  | "no-workspace"
  | "invalid-staff"
  | "unknown-staff"
  | "invalid-region";

export type StaffRequestBuild =
  | { readonly ok: true; readonly request: StaffRequestPlan }
  | { readonly ok: false; readonly reason: StaffRequestRejectReason; readonly detail: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `..` 不能让请求指到工作区外：领地判定失效的入口一个都不能留。 */
function safePrefix(value: unknown): { ok: true; path: string } | { ok: false; detail: string } {
  const raw = text(value);
  if (!raw) return { ok: true, path: "" };
  const normalized = normalizeOwnerPath(raw);
  if (!normalized || normalized.split("/").includes("..")) {
    return { ok: false, detail: `region.pathPrefix 只能写工作区内部的路径（不能有 ..）：${raw}` };
  }
  return { ok: true, path: normalized };
}

/**
 * 校验并拼出协调请求。
 *
 * 拒绝只回原因与一句人话；调用方（MCP handler）原样转述，不再自己改写。
 * `staff` 写成字符串而不是数组：一张卡对一个人，多条需求由人合并。
 */
export function planStaffRequest(input: unknown, context: StaffRequestContext): StaffRequestBuild {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const task = text(raw.task);
  const why = text(raw.why);
  if (!task) {
    return { ok: false, reason: "empty-task", detail: "「要什么」不能为空：用一句话说明需要谁来做哪件事。" };
  }
  if (!why) {
    return { ok: false, reason: "empty-why", detail: "「为什么」不能为空：写清是越界、量太大，还是缺你不具备的权限。" };
  }
  const sessionAgentId = text(context.sessionAgentId);
  if (!sessionAgentId) {
    return { ok: false, reason: "no-agent-id", detail: "拿不到本会话的 agent id（PASEO_AGENT_ID 为空），无法写这条请求。" };
  }
  const workspaceId = text(context.workspaceId);
  if (!workspaceId) {
    return { ok: false, reason: "no-workspace", detail: "分不清这条请求属于哪个工作区：读不到编排文件里的 workspaceId。" };
  }

  const rawStaff = text(raw.staff);
  let toStaff: string | null = null;
  if (rawStaff) {
    const staffId = normalizeStaffId(rawStaff);
    if (!staffId || staffId.length > MAX_STAFF_ID_CHARS) {
      return { ok: false, reason: "invalid-staff", detail: `「建议交给谁」的 id 不合法：${rawStaff}（只能用小写字母、数字和 -）` };
    }
    if (context.staffIds && !context.staffIds.includes(staffId)) {
      return {
        ok: false,
        reason: "unknown-staff",
        detail: `名册里没有 id 为「${staffId}」的卡：可选 ${context.staffIds.join(" / ") || "（名册为空）"}`,
      };
    }
    toStaff = staffId;
  }

  const region = (typeof raw.region === "object" && raw.region !== null ? raw.region : {}) as Record<string, unknown>;
  const prefix = safePrefix(region.pathPrefix);
  if (!prefix.ok) return { ok: false, reason: "invalid-region", detail: prefix.detail };
  const repoKey = text(region.repoKey);
  // 收件箱里没有「仓库」这一列：仓库名也当成路径前缀的一部分存，人不至于丢掉线索。
  const paths = prefix.path ? [prefix.path] : repoKey ? [repoKey] : [];

  const rawFrom = text(raw.fromStaff);
  let fromStaff = "unknown";
  if (rawFrom) {
    const normalized = normalizeStaffId(rawFrom);
    if (!normalized || normalized.length > MAX_STAFF_ID_CHARS) {
      return { ok: false, reason: "invalid-staff", detail: `「我是谁」的 id 不合法：${rawFrom}（只能用小写字母、数字和 -）` };
    }
    if (context.staffIds && context.staffIds.length && !context.staffIds.includes(normalized)) {
      return {
        ok: false,
        reason: "unknown-staff",
        detail: `名册里没有 id 为「${normalized}」的卡：可选 ${context.staffIds.join(" / ")}`,
      };
    }
    fromStaff = normalized;
  }
  return {
    ok: true,
    request: {
      kind: "staffing",
      workspaceId,
      fromStaff,
      toStaff,
      paths,
      sessionAgentId,
      taskSummary: task,
      need: why,
      ...(text(context.at) ? { at: text(context.at) } : {}),
    },
  };
}
