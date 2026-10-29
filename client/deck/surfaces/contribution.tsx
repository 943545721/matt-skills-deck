import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DeckAgentPanel } from "./agentPanel.tsx";
import { contributeAttachment } from "./attachment.ts";
import { contributeCommandCenter } from "./commandCenter.ts";
import { contributeHeaderButtons } from "./headers.ts";
import { bindHost } from "./host.tsx";
import { contributePills } from "./pills.ts";
import { DeckDirectory } from "./registry.ts";
import { DeckSidebarFooter } from "./sidebar.tsx";
import { contributeSlash } from "./slash.tsx";
import { surfaceMessages } from "./text.ts";
import { contributeTimeline } from "../timeline/register.tsx";

/**
 * L8 原生座位的总装。
 *
 * 面板 / 整页 / 设置页仍由 `index.client.tsx` 注册；这里只收「跟着 agent 或
 * workspace 走」的座位：composer pill、顶栏按钮、侧栏页脚、agent 面板、
 * 命令中心、`/deck`、附件源和时间线。
 *
 * 一个 client 只建一份 `DeckDirectory`：由 `index.client.tsx` 建好并传入，面板与
 * 这里的所有座位共享同一条 agent/workspace 订阅，避免每个 pill 自己开一条列表流。
 * 清理顺序先摘座位；目录的订阅由入口统一停，防止回调里再碰宿主。
 */
const AGENT_PANEL_ID = "deck-agent-panel";
const SIDEBAR_FOOTER_ID = "deck-footer";

export function contributeSurfaces(client: PluginClientContext, directory: DeckDirectory): () => void {
  const cleanups: Array<() => void> = [
    contributePills(client, directory),
    contributeHeaderButtons(client, directory),
    client.addSidebarFooterItem({
      id: SIDEBAR_FOOTER_ID,
      title: surfaceMessages.message("pill.title"),
      Component: DeckSidebarFooter,
    }),
    client.addAgentPanel({
      id: AGENT_PANEL_ID,
      title: surfaceMessages.message("agentPanel.title"),
      icon: "ListChecks",
      Component: bindHost(client, directory, DeckAgentPanel),
    }),
    contributeCommandCenter(client),
    contributeSlash(client),
    contributeAttachment(client),
    contributeTimeline(client, directory),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
