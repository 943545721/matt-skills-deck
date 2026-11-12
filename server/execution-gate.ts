/**
 * D 执行门：主窗口 / 需求窗口 / 派单窗口 / 进度窗口不改文件。
 *
 * 身份提示词里写着「不改代码」，但那只是话；这条闸在权限请求上直接 deny。
 * 执行窗口（派单窗口开出来的子会话）不受影响——它们本来就该干活。
 *
 * 只判得清的三类：`write` / `edit` / 会改文件的 shell。读、搜、跑测试、调 MCP 工具
 * 一律放行；`gh` / `glab` 让给票闸，免得同一条命令被两条闸各拒一次。
 *
 * 配置读不出来、会话属于哪片分不清：放行 + warn。这是护栏，不是沙箱。
 */

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { executionBlockFor, executionDenyMessage } from "../shared/execution-guard.ts";
import { roleOfAgent } from "../shared/window-gates.ts";
import { ticketCommandVerdict } from "../shared/ticket-command-guard.ts";
import { record } from "./logs.ts";
import { readOrchestration } from "./orchestration-store.ts";
import { runPermissionGate, type PermissionGateDeps } from "./permission-gates.ts";
import { roleSlotsFor } from "./role-window.ts";

const SCOPE = "window.guard";

export type ExecutionGateDeps = PermissionGateDeps;

export function registerExecutionGate(server: PluginServerContext, deps: ExecutionGateDeps): void {
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    const detail = request.detail;
    if (!detail) return;
    // gh / glab 由票闸处理：这里再判一次只会让同一条命令收到两条不同的拒绝理由。
    if (detail.type === "shell" && typeof detail.command === "string" && ticketCommandVerdict(detail.command).blocked) {
      return;
    }
    const block = executionBlockFor(detail);
    if (!block.block) return;

    await runPermissionGate(deps, agent.id, request.id, async (release) => {
      let read;
      try {
        read = await readOrchestration(agent.cwd);
      } catch (error) {
        release();
        record(
          "warn",
          SCOPE,
          `执行门读编排设置失败，本次不拦：agent=${agent.id}，${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (read.readFailed || read.corrupt) {
        release();
        record(
          "warn",
          SCOPE,
          `执行门读不出编排设置（${read.detail ?? (read.corrupt ? "文件损坏" : "IO 失败")}），本次不拦：agent=${agent.id}`,
        );
        return;
      }
      const lookup = roleSlotsFor(read.settings, agent.workspaceId);
      if (!lookup.ok) {
        release();
        record("warn", SCOPE, `执行门分不清会话属于哪片（${lookup.detail}），本次不拦：agent=${agent.id}`);
        return;
      }
      const role = roleOfAgent(lookup.slots, agent.id);
      if (!role) {
        // 执行会话、面板手工会话：没有角色槽位，就该让它们干活。
        release();
        return;
      }

      const kind = block.kind ?? detail.type;
      try {
        await context.paseo.agents.ref(agent.id).respondToPermission({
          requestId: request.id,
          response: { behavior: "deny", message: executionDenyMessage(role, kind) },
        });
        record("warn", SCOPE, `执行门拦下 ${role} 窗口的 ${kind}：agent=${agent.id}`);
      } catch (error) {
        // 拒绝没送到也保持 held：自动放行不能把它翻回来。
        record(
          "warn",
          SCOPE,
          `执行门拒绝失败（${role}/${kind}）：agent=${agent.id}，${error instanceof Error ? error.message : String(error)}；已挡住自动放行`,
        );
      }
    });
  });
}
