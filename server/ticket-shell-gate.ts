import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ticketCommandVerdict } from "../shared/ticket-command-guard.ts";
import { record } from "./logs.ts";
import { runPermissionGate, type PermissionGateDeps } from "./permission-gates.ts";

/** 日志分类：票闸拒了一条命令，能在「票」这一类里查到。 */
const SCOPE = "issues.guard";

export interface TicketShellGateDeps extends PermissionGateDeps {
  /** 是不是一块有票可读的板子（有远端仓库，或本机已有 `.deck/` / `.scratch/`）。 */
  isDeckBoardWorkspace: (workspaceDir: string) => Promise<boolean>;
}

/**
 * 票闸的 shell 侧：MCP 的票闸拦不住 `gh issue create`，会话照样能绕过去建票。
 *
 * 必须注册在「自动放行」之前，并且把整段判定登记进 `gateInFlight`：自动放行只认这张表，
 * 不认注册顺序；否则判定要起 git 的那几毫秒里，请求可能已经被 allow 掉，
 * 等 deny 到达时宿主那边已经没有这条请求了。
 */
export function registerTicketShellGate(server: PluginServerContext, deps: TicketShellGateDeps): void {
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    const detail = request.detail;
    if (detail?.type !== "shell") return;
    const verdict = ticketCommandVerdict(detail.command);
    if (!verdict.blocked) return;

    await runPermissionGate(deps, agent.id, request.id, async (release) => {
      // 只管有票的板子：别的仓库里 gh 是正常工具，不替别人的项目立规矩。
      // 判不出来就按「不是」处理——宁可漏一次，也不能因为一次 IO 卡住别人的命令。
      let deck = false;
      try {
        deck = await deps.isDeckBoardWorkspace(agent.cwd);
      } catch (error) {
        record(
          "warn",
          SCOPE,
          `判不出是不是有票的板子，本次不拦 gh 命令（${verdict.reason}）：agent=${agent.id}，${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!deck) {
        release();
        return;
      }
      try {
        await context.paseo.agents.ref(agent.id).respondToPermission({
          requestId: request.id,
          response: { behavior: "deny", message: verdict.message },
        });
        record("warn", SCOPE, `拦下绕票闸的 gh 命令（${verdict.reason}）：agent=${agent.id}`);
      } catch (error) {
        record(
          "warn",
          SCOPE,
          `拦绕票闸的 gh 命令失败（${verdict.reason}）：agent=${agent.id}，${error instanceof Error ? error.message : String(error)}；已挡住自动放行`,
        );
      }
    });
  });
}
