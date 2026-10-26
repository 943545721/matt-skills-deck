import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DeckHome } from "./client/deck/Home";
import { DeckPanel } from "./client/deck/Panel";

/**
 * 客户端入口：只注册「面」，不放实现。
 *
 * 三个面的分工：
 * - 工作区面板（deck.board）：任务板本体，与 Agent/终端并排，P2 起承载列表与详情；
 * - 整页界面（deck.home）：没有工作区时的落地页，说明入口在哪、环境是否就绪；
 * - 侧栏行（deck）：从侧栏一键回到落地页。
 * 没有注册常驻右栏或全局状态栏——Paseo 不提供这两种面，硬凑会让插件在每个客户端上表现不一致。
 */
function DeckSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ListChecks"
      label="任务板"
      active={currentScreen?.screenId === "deck.home"}
      onPress={() => openScreen({ screenId: "deck.home" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "deck.board",
    title: "任务板",
    icon: "ListChecks",
    locations: ["workspace", "explorer"],
    Component: DeckPanel,
  });
  client.addScreen({ id: "deck.home", title: "任务板", Component: DeckHome });
  client.addSidebarHeaderItem({ id: "deck", title: "任务板", Component: DeckSidebarItem });
  return () => {};
}
