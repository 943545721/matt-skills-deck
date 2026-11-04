/**
 * 阀门四：全停。
 *
 * 「出事了一个按钮止血」要同时做三件事，少一件都会留下一个还在动的东西：
 * 1. 撤掉它正在等的权限请求（`deny` + `interrupt: true`）；
 * 2. 掐掉正在跑的一轮（`send(..., { activeTurnBehavior: "interrupt" })`）；
 * 3. 可选归档。
 *
 * 没有的是「暂停 / 挂起」：会话只有「在跑 / 不在跑」，没有可恢复的挂起态。
 * 所以界面文案只能写「停手」，不能写「暂停，回头接着跑」。
 *
 * 归档那条副作用要说清：归档一个父窗口会**连坐归档它派出去的同区子会话**
 * （没开标签页的那些）。对「全停」来说这正是想要的，但别顺手归档派单窗口。
 */

import type { PaseoApi } from "@getpaseo/client";
import { DECK_STAFF_LABEL } from "../shared/orchestration.ts";

/** 打断时发过去的那句话：短，明确，别让模型接着自作主张。 */
export const STOP_MESSAGE = "全停：用户按了「全部停手」。立刻停下当前工作，不要继续改文件、不要开新会话，等下一步指令。";

export interface StaffStopInput {
  workspaceId: string;
  workspaceDir: string;
  /** 停手之后要不要顺手归档。默认不归档：还能接着看它做到哪了。 */
  archive?: boolean;
}

export interface StaffStopResult {
  ok: true;
  /** 命中的会话数（同工作区、带 `deck.staff` 标、还活着）。 */
  stopped: number;
  /** 成功撤掉的权限请求数。 */
  denied: number;
  /** 成功打断的轮次数。 */
  interrupted: number;
  /** 成功归档的会话数。 */
  archived: number;
  /** 逐条失败原因：一个会话失败不影响其它会话停手。 */
  failures: string[];
}

export interface StaffStopFailure {
  ok: false;
  reason: "invalid-workspace" | "agents-failed";
  detail: string;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function stopStaffSessions(
  paseo: PaseoApi,
  input: StaffStopInput,
): Promise<StaffStopResult | StaffStopFailure> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) return { ok: false, reason: "invalid-workspace", detail: "需要工作区 id" };

  let listed;
  try {
    listed = await paseo.agents.list({ filter: { includeArchived: false } });
  } catch (error) {
    return { ok: false, reason: "agents-failed", detail: detailOf(error) };
  }

  const targets = listed.entries
    .map((entry) => entry.agent)
    .filter(
      (agent) =>
        agent.workspaceId === workspaceId &&
        !agent.archivedAt &&
        Boolean(agent.labels?.[DECK_STAFF_LABEL]?.trim()),
    );

  let denied = 0;
  let interrupted = 0;
  let archived = 0;
  const failures: string[] = [];

  for (const agent of targets) {
    const handle = paseo.agents.ref(agent.id);

    for (const request of agent.pendingPermissions ?? []) {
      try {
        await handle.respondToPermission({
          requestId: request.id,
          response: { behavior: "deny", interrupt: true, message: "用户按了全停" },
        });
        denied += 1;
      } catch (error) {
        failures.push(`${agent.id} 撤权限失败：${detailOf(error)}`);
      }
    }

    if (agent.status === "running") {
      try {
        await handle.send(STOP_MESSAGE, { activeTurnBehavior: "interrupt" });
        interrupted += 1;
      } catch (error) {
        failures.push(`${agent.id} 打断失败：${detailOf(error)}`);
      }
    }

    if (input.archive) {
      try {
        await handle.archive();
        archived += 1;
      } catch (error) {
        failures.push(`${agent.id} 归档失败：${detailOf(error)}`);
      }
    }
  }

  return { ok: true, stopped: targets.length, denied, interrupted, archived, failures };
}
