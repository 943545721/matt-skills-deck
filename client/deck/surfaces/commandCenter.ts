import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DECK_PANEL_ID, DECK_SCREEN_ID } from "../ids.ts";
import { appendDeckCommand } from "../timeline/command.ts";
import { surfaceMessages } from "./text.ts";

/**
 * 命令中心条目。
 *
 * 全局只开整页；工作区开面板；agent 上下文额外给「交接 / 新会话」——
 * 这两个动作在 slash 里已经有可见的时间线结果，命令中心复用同一条路径，
 * 不另造一个没有反馈的空动作。
 */
export function contributeCommandCenter(client: PluginClientContext): () => void {
  const cleanups = [
    client.addCommandCenterItem({
      id: "deck-open-home",
      title: surfaceMessages.message("command.openBoard"),
      icon: "ListChecks",
      keywords: ["deck", "board", "issues"],
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: DECK_SCREEN_ID }),
    }),
    client.addCommandCenterItem({
      id: "deck-open-board",
      title: surfaceMessages.message("command.openBoard"),
      icon: "ListChecks",
      keywords: ["deck", "board", "issues"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel(DECK_PANEL_ID),
    }),
    client.addCommandCenterItem({
      id: "deck-handoff",
      title: surfaceMessages.message("command.handoff"),
      icon: "ArrowLeftRight",
      keywords: ["deck", "handoff", "session"],
      context: "agent",
      onSelect: async ({ paseo, agent, workspace }) => {
        await appendDeckCommand(paseo, agent.id, {
          command: "handoff",
          title: client.i18n.t(surfaceMessages, "slash.handoffTitle"),
          lines: [client.i18n.t(surfaceMessages, "slash.handoffHint")],
          workspaceId: workspace.id,
          workspaceDir: workspace.directory,
          agentId: agent.id,
          openBoard: true,
          session: { action: "handoff", context: agent.title ? { notes: agent.title } : {} },
        });
      },
    }),
    client.addCommandCenterItem({
      id: "deck-new-session",
      title: surfaceMessages.message("command.newSession"),
      icon: "Plus",
      keywords: ["deck", "new", "session"],
      context: "agent",
      onSelect: async ({ paseo, agent, workspace }) => {
        await appendDeckCommand(paseo, agent.id, {
          command: "new",
          title: client.i18n.t(surfaceMessages, "slash.newTitle"),
          lines: [client.i18n.t(surfaceMessages, "slash.newHint")],
          workspaceId: workspace.id,
          workspaceDir: workspace.directory,
          agentId: agent.id,
          openBoard: true,
          session: { action: "new-requirement", context: {} },
        });
      },
    }),
  ];
  return () => {
    for (const cleanup of cleanups) void cleanup();
  };
}
