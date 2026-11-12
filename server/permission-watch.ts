import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent, PluginServerContext } from "@getpaseo/plugin/server";
import { deliverMessage } from "./delivery.ts";
import { record } from "./logs.ts";

/** 日志分类：与回传分开，用户能只看「有人在等我」。 */
const SCOPE = "permission.watch";

/**
 * 一条权限请求等了多久还没人点，才值得打扰主窗口。
 *
 * 45 秒足够让正常审批（用户就在子会话窗口里）自己解决；只有真卡住的那条才会发提醒。
 * 太短会把每次点击都变成一条消息。
 */
export const DEFAULT_WAIT_MS = 45_000;

/** 记多少条「已经提醒过」的请求，防同一事件被重放成两条消息。 */
const NOTIFIED_LIMIT = 500;

export interface PermissionWatchDeps {
  /** 这个工作区的主沟通窗口；读不到就当没配，不发。 */
  mainAgentFor: (workspaceDir: string, workspaceId: string | null) => Promise<string | null>;
  /** 仅供测试：改等待时长。 */
  waitMs?: number;
}

/**
 * 提醒里写「在等什么」。写文件带上路径，用户一眼认得出是哪处改动；
 * shell 只写种类——命令原文可能带着密钥，不进消息也不进日志。
 */
function describePendingPermission(request: AgentPermissionRequest): string {
  const detail = request.detail;
  if (detail?.type === "write" || detail?.type === "edit") {
    return `${request.name} ${detail.filePath}`;
  }
  return `${request.kind}/${request.name}`;
}

interface PendingPermission {
  agent: PluginHookAgent;
  request: AgentPermissionRequest;
  paseo: PaseoApi;
  timer: NodeJS.Timeout;
  /** resolved / 会话归档关闭都在这里落旗；提醒发出前会再确认一次。 */
  settled: boolean;
}

/**
 * 「子会话在等你点确认」的提醒。
 *
 * 子会话的权限请求只在它自己的窗口里弹。用户坐在主窗口时看不见，会话就那样卡着，
 * 连回合结束的回传都不会有；截图里那种「写到一半停在 Write 确认」正是这样被漏掉的。
 *
 * 每条子会话请求起一个计时器：超过 `waitMs` 还没 resolved，就往主沟通窗口发一句短话，
 * 说清是哪一支、在等哪一种确认。`agent.permission_resolved` 一到就清掉计时器，
 * 所以正常点掉的请求不会留下噪音。
 *
 * 归档 / 关闭的会话是特例：宿主直接清空待确认列表，不发 resolved。所以这两个事件也要清表，
 * 否则一个已经被关掉的会话还会在 45 秒后报「在等你」。
 *
 * 只管子会话（有 `parentAgentId`）：主窗口自己的请求就弹在用户眼前，不需要再提醒一次。
 */
export function registerPermissionWatch(server: PluginServerContext, deps: PermissionWatchDeps): void {
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
  const pending = new Map<string, PendingPermission>();
  const notified = new Set<string>();
  const keyOf = (agentId: string, requestId: string) => `${agentId}\u0000${requestId}`;

  function rememberNotified(key: string): void {
    notified.add(key);
    if (notified.size <= NOTIFIED_LIMIT) return;
    const oldest = notified.values().next().value;
    if (oldest) notified.delete(oldest);
  }

  function settle(agentId: string, requestId: string): void {
    const entry = pending.get(keyOf(agentId, requestId));
    if (!entry) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    pending.delete(keyOf(agentId, requestId));
  }

  server.on("agent.permission_requested", ({ agent, request }, context) => {
    if (!agent.parentAgentId) return;
    const key = keyOf(agent.id, request.id);
    if (pending.has(key) || notified.has(key)) return;
    const entry: PendingPermission = {
      agent,
      request,
      paseo: context.paseo,
      settled: false,
      timer: setTimeout(() => {
        rememberNotified(key);
        void notify(key, entry);
      }, waitMs),
    };
    entry.timer.unref?.();
    pending.set(key, entry);
  });

  server.on("agent.permission_resolved", ({ agent, requestId }) => {
    settle(agent.id, requestId);
  });

  // 关掉的会话不会再有人点那条确认，提醒它没有意义。
  server.on("agent.archived", ({ agent }) => clearAgent(agent.id));
  server.on("agent.closed", ({ agent }) => clearAgent(agent.id));

  function clearAgent(agentId: string): void {
    for (const [key, entry] of pending) {
      if (entry.agent.id !== agentId) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      pending.delete(key);
    }
  }

  async function notify(key: string, entry: PendingPermission): Promise<void> {
    try {
      const mainAgentId = await deps.mainAgentFor(entry.agent.cwd, entry.agent.workspaceId);
      if (!mainAgentId) {
        record("info", SCOPE, `子会话 ${entry.agent.id} 的确认等久了，但这个工作区没配主沟通窗口，不发提醒`);
        pending.delete(key);
        return;
      }
      // 查主窗口这几毫秒里用户可能已经点掉、会话也可能被关了；消息不能再发。
      if (entry.settled) return;
      if (mainAgentId === entry.agent.id) {
        pending.delete(key);
        return;
      }
      const title = entry.agent.title?.trim() || entry.agent.id;
      const seconds = Math.round(waitMs / 1000);
      // 主窗口也在跑活时先排队；等待期间请求被点掉就不必再送（stillRelevant）。
      await deliverMessage(
        entry.paseo,
        mainAgentId,
        [
          `【等你确认】子会话「${title}」在等一次 ${describePendingPermission(entry.request)}，已经 ${seconds} 秒。`,
          "它在点头之前不会继续；去它的窗口点一下，或先在这里让我替你处理。",
        ].join("\n"),
        { stillRelevant: () => !entry.settled },
      );
      record("info", SCOPE, `子会话 ${entry.agent.id} 的权限请求等待超时，已提醒主窗口 ${mainAgentId}`);
    } catch (error) {
      // 没送到就别把「已提醒」的标记留着：宿主若重发这条请求，还能再试一次。
      notified.delete(key);
      record("warn", SCOPE, `提醒主窗口失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 表项留给 resolved / 归档来清：提醒可能还在队列里，那时还要靠它判断请求是否已被点掉。
  }
}
