import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DeckHome } from "./client/deck/Home";
import { DeckPanel } from "./client/deck/Panel";
import { DeckSettingsScreen } from "./client/deck/SettingsView";
import { deckMessages } from "./client/deck/i18n";
import { DECK_PANEL_ID, DECK_SCREEN_ID, DECK_SETTINGS_ID, DECK_SIDEBAR_ID } from "./client/deck/ids";

/**
 * 客户端入口：只注册「面」，不放实现。
 *
 * 三个面的分工：
 * - 工作区面板（deck-board）：任务板本体，与 Agent/终端并排，P2 起承载列表与详情；
 * - 整页界面（deck-home）：没有工作区时的落地页，说明入口在哪、环境是否就绪；
 * - 侧栏行（deck）：从侧栏一键回到落地页。
 * id 的取值和为什么不能用点号，见 `client/deck/ids.ts`。
 * 没有注册常驻右栏或全局状态栏——Paseo 不提供这两种面，硬凑会让插件在每个客户端上表现不一致。
 *
 * 三处标题都用 `deckMessages.message` 而不是写死中文：注册时给平台一个「待解析的文案」，
 * 由它在渲染时按 App 语言解析，所以英文界面里的标签页标题不会突然变成中文。
 */
const BOARD_TITLE = deckMessages.message("tabs.board");
const SETTINGS_TITLE = deckMessages.message("settings.title");
function DeckSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ListChecks"
      active={currentScreen?.screenId === DECK_SCREEN_ID}
      onPress={() => openScreen({ screenId: DECK_SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: DECK_PANEL_ID,
    title: BOARD_TITLE,
    icon: "ListChecks",
    locations: ["workspace", "explorer"],
    Component: DeckPanel,
  });
  client.addScreen({ id: DECK_SCREEN_ID, title: BOARD_TITLE, Component: DeckHome });
  client.addSettingsScreen({
    id: DECK_SETTINGS_ID,
    title: SETTINGS_TITLE,
    icon: "Settings",
    Component: DeckSettingsScreen,
  });
  client.addSidebarHeaderItem({ id: DECK_SIDEBAR_ID, title: BOARD_TITLE, Component: DeckSidebarItem });
  return () => {};
}
