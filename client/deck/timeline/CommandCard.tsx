import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { DECK_PANEL_ID } from "../ids.ts";
import { SessionSheet } from "../session/SessionSheet.tsx";
import { PixelButton, PixelCard, PixelChip, PixelHead, usePixel } from "../pixel.tsx";
import { useDeckAgent, useDeckHost } from "../surfaces/host.tsx";
import { useSurfaceText } from "../surfaces/text.ts";
import type { CommandData } from "./schemas.ts";

/**
 * `/deck` 与命令中心在 agent 会话里的可见结果。
 *
 * slash 回调没有 toast；结果写进这一行，用户能看到命令做了什么，
 * 还能复制快照或打开 SessionSheet。`session.context` 只带票的标识，
 * 不带正文——64 KiB 的 data 上限不能被票面撑爆。
 */
export function CommandCard({ agentId, item, theme }: PluginTimelineItemProps<CommandData>) {
  const { t } = useSurfaceText();
  const skin = usePixel(theme);
  const toast = useToast();
  const { client } = useDeckHost();
  const agentState = useDeckAgent(agentId);
  const [sheetOpen, setSheetOpen] = useState(false);
  const data = item.data;
  const provider = agentState.agent
    ? `${agentState.agent.provider}${agentState.agent.model ? `/${agentState.agent.model}` : ""}`
    : undefined;

  const copy = async (): Promise<void> => {
    if (!data.copyText) return;
    try {
      await copyText(data.copyText);
      toast.show(t("common.copied"), { variant: "success" });
    } catch {
      toast.error(t("common.copyFailed"));
    }
  };

  return (
    <PixelCard skin={skin} style={{ padding: 8, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <PixelHead skin={skin}>{data.title}</PixelHead>
        <PixelChip skin={skin}>{`/deck ${data.command}`}</PixelChip>
      </View>
      {data.lines.map((line, index) => (
        <Text key={`${index}:${line}`} style={index === 0 ? skin.value : skin.hint} numberOfLines={4}>
          {line}
        </Text>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {data.copyText ? <PixelButton skin={skin} label={t("timeline.copy")} onPress={() => void copy()} /> : null}
        {data.session ? (
          <PixelButton skin={skin} variant="solid" label={t("timeline.openSession")} onPress={() => setSheetOpen(true)} />
        ) : null}
        {data.openBoard ? (
          <PixelButton
            skin={skin}
            variant="ghost"
            label={t("timeline.openBoard")}
            onPress={() => client.openPanel(DECK_PANEL_ID, { workspaceId: data.workspaceId, agentId })}
          />
        ) : null}
      </View>

      {data.session ? (
        <SessionSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          theme={theme}
          workspaceId={data.workspaceId}
          workspaceDir={data.workspaceDir}
          agentId={agentId}
          agentStatus={agentState.agent?.status ?? null}
          provider={provider}
          title={data.title}
          action={data.session.action}
          context={data.session.context}
          initialPrompt={data.session.prompt}
        />
      ) : null}
    </PixelCard>
  );
}
