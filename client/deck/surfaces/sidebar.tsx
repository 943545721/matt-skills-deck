import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DECK_SCREEN_ID } from "../ids.ts";
import { useSurfaceText } from "./text.ts";

/**
 * 侧栏页脚：从任何会话一键回到任务板落地页。
 *
 * 页脚没有工作区上下文，所以这里不显示计数——拿不到工作区目录时去猜一个仓库，
 * 比不显示更糟。计数在面板与顶栏按钮里。
 */
export function DeckSidebarFooter({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const { t } = useSurfaceText();
  return (
    <SidebarRow
      icon="ListChecks"
      label={t("pill.label")}
      active={currentScreen?.screenId === DECK_SCREEN_ID}
      onPress={() => openScreen({ screenId: DECK_SCREEN_ID })}
    />
  );
}
