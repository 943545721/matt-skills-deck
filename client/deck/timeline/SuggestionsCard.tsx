import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SessionSheet } from "../session/SessionSheet.tsx";
import { PixelButton, PixelCard, PixelChip, PixelHead, usePixel } from "../pixel.tsx";
import { useDeckAgent, useDeckWorkspace } from "../surfaces/host.tsx";
import { useSurfaceText } from "../surfaces/text.ts";
import type { SuggestData } from "./schemas.ts";

/**
 * 建议气泡。
 *
 * 与 DSH 一致：气泡上只显示短 intro，理由收在点开后的详情里（桌面没有稳定的 hover 层）。
 * 点击永远只做两件事：复制 prompt，或打开 SessionSheet 预览后再决定；
 * 不碰宿主 composer，也不假装有「预填」。
 */
export function SuggestionsCard({ agentId, item, theme }: PluginTimelineItemProps<SuggestData>) {
  const { t } = useSurfaceText();
  const skin = usePixel(theme);
  const toast = useToast();
  const agentState = useDeckAgent(agentId);
  const workspaceId = agentState.agent?.workspaceId ?? "";
  const workspace = useDeckWorkspace(workspaceId || undefined);
  const [selected, setSelected] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const current = selected === null ? null : item.data.items[selected] ?? null;
  const provider = agentState.agent
    ? `${agentState.agent.provider}${agentState.agent.model ? `/${agentState.agent.model}` : ""}`
    : null;

  const copy = async (text: string): Promise<void> => {
    try {
      await copyText(text);
      toast.show(t("common.copied"), { variant: "success" });
    } catch {
      toast.error(t("common.copyFailed"));
    }
  };

  return (
    <PixelCard skin={skin} style={{ padding: 8, gap: 6 }}>
      <PixelHead skin={skin}>{t("timeline.suggestions")}</PixelHead>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {item.data.items.map((suggestion, index) => (
          <Pressable
            key={`${index}:${suggestion.intro}`}
            accessibilityRole="button"
            accessibilityLabel={suggestion.intro}
            accessibilityState={{ selected: selected === index }}
            onPress={() => setSelected(selected === index ? null : index)}
          >
            <Text
              style={[
                skin.chip,
                skin.chipText,
                { paddingVertical: 4, paddingHorizontal: 8 },
                selected === index ? { borderColor: skin.colors.acc, color: skin.colors.acc } : null,
              ]}
            >
              {suggestion.intro}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={skin.hint}>{t("timeline.suggestionsHint")}</Text>

      {current ? (
        <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: skin.colors.line, paddingTop: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={skin.label}>{t("timeline.why")}</Text>
            {typeof current.priority === "number" ? <PixelChip skin={skin}>{current.priority}</PixelChip> : null}
          </View>
          <Text style={skin.hint}>{current.reason}</Text>
          <Text style={skin.value} numberOfLines={6}>{current.prompt}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <PixelButton skin={skin} label={t("timeline.copyPrompt")} onPress={() => void copy(current.prompt)} />
            <PixelButton skin={skin} variant="solid" label={t("timeline.openSession")} onPress={() => setSheetOpen(true)} />
          </View>
        </View>
      ) : null}

      <SessionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={workspace.directory || agentState.agent?.cwd || ""}
        agentId={agentId}
        agentStatus={agentState.agent?.status ?? null}
        provider={provider}
        title={current?.intro}
        action="custom"
        context={current?.reason ? { notes: current.reason } : {}}
        initialPrompt={current?.prompt}
      />
    </PixelCard>
  );
}
