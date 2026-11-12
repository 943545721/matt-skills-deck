import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { renderHandoffMessage, type HandoffEnvelope } from "../shared/handoff-to-dispatcher.ts";
import { workspaceRolesOf } from "../shared/orchestration.ts";
import { deliverMessage } from "./delivery.ts";
import {
  isHandoffPending,
  listPendingHandoffs,
  markHandoffFailed,
  markHandoffSent,
  recordHandoffAttempt,
} from "./dispatch-handoff-store.ts";
import { readOrchestration } from "./orchestration-store.ts";
import { record } from "./logs.ts";

/**
 * 交接件投递员：把主窗口写进 outbox 的件送进当前绑定的派单窗口。
 *
 * 触发点只有两个后台事件：`agent.turn_ended` 与 `agent.created`。
 * 主窗口写完件这一轮就结束了，第一下正好赶在它空下来时投递；
 * 派单窗口后来才绑定 / 才建出来时，`agent.created` 补送。
 *
 * 每次投递前都**重新解析**当前派单窗口，不信信封里的旧 id：用户可能在写件之后
 * 到面板里换了窗口，按旧 id 送等于把活交给一个已经不管事的人。
 */

const SCOPE = "dispatch.handoff";

export interface DispatchHandoffRelayDeps {
  /** 仅供测试：换一个投递函数。 */
  deliver?: typeof deliverMessage;
}

export function registerDispatchHandoffRelay(
  server: PluginServerContext,
  deps: DispatchHandoffRelayDeps = {},
): void {
  const deliver = deps.deliver ?? deliverMessage;
  /** 同一个工作区的两次 drain 串行跑，避免同一份件被两个事件同时读出来各送一遍。 */
  const chains = new Map<string, Promise<void>>();
  /** 已交给投递队列、还没拿到结果的件：`<dir>\0<handoffId>`。 */
  const inFlight = new Set<string>();
  /** 「没有派单窗口」只提醒一次，别让每个事件都刷一行同样的日志。 */
  const warnedNoDispatcher = new Set<string>();

  function schedule(workspaceDir: string, paseo: PaseoApi): void {
    const previous = chains.get(workspaceDir) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => drain(workspaceDir, paseo))
      .catch((error: unknown) => {
        record("warn", SCOPE, `投递交接件失败：${workspaceDir}，${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (chains.get(workspaceDir) === next) chains.delete(workspaceDir);
      });
    chains.set(workspaceDir, next);
  }

  server.on("agent.turn_ended", ({ agent }, context) => {
    if (agent.cwd) schedule(agent.cwd, context.paseo);
  });

  // 派单窗口可能是主窗口交接之后才建出来 / 才绑定的；建会话时补一次。
  server.on("agent.created", ({ agent }, context) => {
    if (agent.cwd) schedule(agent.cwd, context.paseo);
  });

  async function drain(workspaceDir: string, paseo: PaseoApi): Promise<void> {
    const pending = await listPendingHandoffs(workspaceDir);
    if (pending.length === 0) return;
    const read = await readOrchestration(workspaceDir);
    if (read.readFailed || read.corrupt) {
      record("warn", SCOPE, `编排设置读不出来，交接件先留在 pending：${workspaceDir}`);
      return;
    }
    for (const envelope of pending) {
      const key = `${workspaceDir}\u0000${envelope.handoffId}`;
      if (inFlight.has(key)) continue;
      // pending 是 drain 开始时读的快照：这期间上一次投递可能已经把它送走了，按快照再送一遍就是重复派活。
      if (!(await isHandoffPending(workspaceDir, envelope.handoffId))) continue;
      const roles = workspaceRolesOf(read.settings, envelope.workspaceId);
      const dispatcher = roles?.dispatcherAgentId?.trim() ?? "";
      if (!dispatcher) {
        if (!warnedNoDispatcher.has(key)) {
          warnedNoDispatcher.add(key);
          record("info", SCOPE, `交接件 ${envelope.handoffId} 还没有收件人：这个工作区没配派单窗口，先留在 pending`);
        }
        continue;
      }
      warnedNoDispatcher.delete(key);
      if (dispatcher === envelope.mainAgentId) {
        await markHandoffFailed(workspaceDir, envelope, "主窗口与派单窗口是同一个会话：没有可投递的收件人");
        continue;
      }
      inFlight.add(key);
      // 直发失败时 `deliver` 会先回调 onDropped、再把错误抛出来；catch 里不能再记一次，
      // 否则同一次失败算两回 attempts，五次上限三次就用完了。
      let attemptsRecorded = false;
      try {
        await deliver(paseo, dispatcher, renderHandoffMessage(envelope), {
          // 先搬文件再放开 inFlight：反过来的话，下一次 drain 会在文件还没移走的空档里再送一遍。
          onDelivered: () => {
            void markHandoffSent(workspaceDir, envelope)
              .catch((error: unknown) => {
                record("warn", SCOPE, `交接件已送达但移入 sent/ 失败：${envelope.handoffId}，${error instanceof Error ? error.message : String(error)}`);
              })
              .finally(() => inFlight.delete(key));
          },
          onDropped: (reason) => {
            attemptsRecorded = true;
            void recordHandoffAttempt(workspaceDir, envelope, reason)
              .catch((error: unknown) => {
                record("warn", SCOPE, `交接件投递失败但记 attempts 失败：${envelope.handoffId}，${error instanceof Error ? error.message : String(error)}`);
              })
              .finally(() => inFlight.delete(key));
          },
        });
      } catch (error) {
        inFlight.delete(key);
        if (!attemptsRecorded) {
          await recordHandoffAttempt(workspaceDir, envelope, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }
}
