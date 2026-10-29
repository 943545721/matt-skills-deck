import type { PluginClientContext } from "@getpaseo/plugin/client";
import { sessionLedgerRpc } from "../../../shared/session-rpc.ts";
import type { WorkRouteEntry, WorkRouteStatus } from "../../../shared/work-route.ts";

/**
 * 工作路线读数（照 DSH `views/shared/workRouteTable.ts` 的口径）。
 *
 * 四种状态分开说，不把「还没有」和「读坏了」混成一句话：
 *   · loading    还没拿到回包；
 *   · empty      读到了，这个作用域就是一条都没有；
 *   · unreadable 读台账那一步真出错了，原因原样带出；
 *   · ok         逐条画。
 *
 * 界面只做时间格式化，不重算状态：状态由写台账的那一侧给出（attached / in-progress / done / released），
 * 客户端按原值显示，认不出就照原样写代号，不编一个词。
 */

export type RpcHost = Pick<PluginClientContext, "rpc">;

export interface WorkRouteScope {
  cwd: string;
  /**
   * 显式 agent id；`null` 有语义——强制按工作区读。
   * 省略时服务端会退回 `PASEO_AGENT_ID`，那是另一个作用域，座位层不该靠它猜。
   */
  agentId: string | null;
}

export interface WorkRouteData {
  scope: "agent" | "workspace";
  entries: WorkRouteEntry[];
  recovered: boolean;
  dropped: number;
  corruptPath: string | null;
  updatedAt: string;
}

export type WorkRouteRead =
  | { state: "loading" }
  | { state: "ok"; data: WorkRouteData }
  | { state: "empty"; data: WorkRouteData }
  | { state: "unreadable"; reason: string };

export async function readWorkRoute(client: RpcHost, scope: WorkRouteScope): Promise<WorkRouteRead> {
  if (!scope.cwd) return { state: "unreadable", reason: "workspace directory unknown" };
  try {
    const result = await client.rpc(sessionLedgerRpc, { cwd: scope.cwd, agentId: scope.agentId });
    if (!result.ok) return { state: "unreadable", reason: `${result.reason}: ${result.detail}` };
    const data: WorkRouteData = {
      scope: result.scope.kind,
      entries: result.ledger.entries,
      recovered: result.recovered,
      dropped: result.dropped,
      corruptPath: result.corruptPath,
      updatedAt: result.ledger.updatedAt,
    };
    return data.entries.length > 0 ? { state: "ok", data } : { state: "empty", data };
  } catch (error) {
    return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 台账状态 → 文案键；认不出的代号由调用方照原样显示，不在这里兜一个假状态。 */
export const WORK_ROUTE_STATUS_KEY = {
  attached: "ledger.status.attached",
  "in-progress": "ledger.status.inProgress",
  done: "ledger.status.done",
  released: "ledger.status.released",
} as const satisfies Record<WorkRouteStatus, string>;

/** 作用域 → 文案键：界面必须写清自己读的是哪一份台账。 */
export function workRouteScopeKey(scope: "agent" | "workspace"): "ledger.scopeAgent" | "ledger.scopeWorkspace" {
  return scope === "agent" ? "ledger.scopeAgent" : "ledger.scopeWorkspace";
}

/**
 * ISO 时刻 → 本机时间：同一天只写时分（16:50），跨天再带月日（10-18 16:50）。
 * 解析不了回空串，调用方退回显示原串；不编一个时间。
 */
export function workRouteClock(iso: string, nowMs: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const pad = (value: number): string => (value < 10 ? "0" : "") + value;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
