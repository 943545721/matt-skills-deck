import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { DECK_PANEL_ID } from "../ids.ts";
import { SessionSheet } from "../session/SessionSheet.tsx";
import { PixelButton, PixelCard, PixelChip, PixelHead, usePixel } from "../pixel.tsx";
import { useDeckAgent, useDeckHost } from "../surfaces/host.tsx";
import { useSurfaceText } from "../surfaces/text.ts";
import type { WorkRouteData } from "./schemas.ts";

/**
 * 工作路线卡。
 *
 * 数据来自两处：`deck_issue_report` 成功调用的 transformer 结果，或 L5 服务端台账
 * 追加的同 kind 插件行。卡片只读；操作是复制票号引用 / 打开该票的 SessionSheet，
 * 不改台账、不再次上报。
 */
export function WorkRouteCard({ agentId, item, theme, timestamp }: PluginTimelineItemProps<WorkRouteData>) {
  const { t } = useSurfaceText();
  const skin = usePixel(theme);
  const toast = useToast();
  const { client } = useDeckHost();
  const agentState = useDeckAgent(agentId);
  const workspaceId = agentState.agent?.workspaceId ?? "";
  const [sheetOpen, setSheetOpen] = useState(false);
  const data = item.data;
  const numeric = /^\d+$/.test(data.key) ? Number(data.key) : undefined;
  const reference = `${data.repoKey ? `${data.repoKey}#` : "#"}${data.key}`;
  const provider = agentState.agent
    ? `${agentState.agent.provider}${agentState.agent.model ? `/${agentState.agent.model}` : ""}`
    : null;

  const copy = async (): Promise<void> => {
    try {
      await copyText(reference);
      toast.show(t("common.copied"), { variant: "success" });
    } catch {
      toast.error(t("common.copyFailed"));
    }
  };

  return (
    <PixelCard skin={skin} style={{ padding: 8, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <PixelHead skin={skin}>{t("timeline.workRoute")}</PixelHead>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <PixelChip skin={skin}>{`#${data.key}`}</PixelChip>
          <PixelChip skin={skin}>{t(data.action === "release" ? "timeline.release" : "timeline.report")}</PixelChip>
        </View>
      </View>
      {data.title ? <Text style={skin.value} numberOfLines={2}>{data.title}</Text> : null}
      {data.note ? <Text style={skin.hint}>{data.note}</Text> : null}
      <Text style={skin.hint} numberOfLines={1}>
        {`${data.repoKey ?? "—"} · ${timestamp.toLocaleTimeString()}`}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <PixelButton skin={skin} label={t("timeline.copy")} onPress={() => void copy()} />
        <PixelButton
          skin={skin}
          label={t("timeline.openSession")}
          disabled={numeric === undefined}
          onPress={() => setSheetOpen(true)}
        />
        {workspaceId ? (
          <PixelButton
            skin={skin}
            variant="ghost"
            label={t("timeline.openBoard")}
            onPress={() => client.openPanel(DECK_PANEL_ID, { workspaceId, agentId })}
          />
        ) : null}
      </View>

      <SessionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={agentState.agent?.cwd ?? ""}
        agentId={agentId}
        agentStatus={agentState.agent?.status ?? null}
        provider={provider}
        title={data.title}
        action="takeover"
        context={{
          repoKey: data.repoKey,
          number: numeric,
          title: data.title,
          notes: data.note,
        }}
      />
    </PixelCard>
  );
}
