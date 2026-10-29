import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { statusRpc } from "../../shared/status";
import { useDeckText } from "./i18n";
import { PixelCard, PixelScreen, usePixel } from "./pixel";

/**
 * 整页界面：侧栏入口点开的那一页。
 *
 * 为什么还要这一页：Paseo 打开工作区面板必须先有工作区（面板是标签页，挂在某个工作区上），
 * 而用户刚装完插件时往往还没有打开任何工作区。这一页负责说清「任务板在哪、怎么打开」，
 * 同时给出环境读数，避免用户以为插件没装上。
 */
export function DeckHome({ theme, layout, host }: PluginScreenProps) {
  const { t } = useDeckText();
  const skin = usePixel(theme);
  const readStatus = useRpc(statusRpc);
  const status = useQuery({
    queryKey: ["deck", "status"],
    queryFn: () => readStatus({}),
    staleTime: 30_000,
  });

  const styles = useMemo(
    () => ({
      screen: { padding: layout.compact ? 12 : 28, gap: 14 },
      title: {
        color: skin.colors.tabInk,
        fontSize: layout.compact ? 20 : 24,
        fontWeight: "700" as const,
        fontFamily: skin.mono.fontFamily,
        letterSpacing: 1,
      },
      body: skin.hintOnChecker,
      card: { padding: 12, gap: 6 },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      label: { color: skin.colors.ink2, fontSize: 12 },
      value: { color: skin.colors.ink, fontSize: 12, flexShrink: 1, textAlign: "right" as const },
    }),
    [skin, layout.compact],
  );

  return (
    <PixelScreen skin={skin} style={styles.screen}>
      <Text style={styles.title}>MattSkillsDeck</Text>
      <Text style={styles.body}>{t("home.host", { label: host.label })}</Text>
      <Text style={styles.body}>{t("home.guidance")}</Text>

      <PixelCard skin={skin} style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>{t("diag.pluginVersion")}</Text>
          <Text style={styles.value}>{status.data?.pluginVersion ?? t("home.reading")}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>{t("diag.gh")}</Text>
          <Text style={styles.value}>
            {status.data
              ? status.data.gh.available
                ? status.data.gh.version ?? t("diag.ghAvailable")
                : t("diag.ghUnavailable")
              : t("home.reading")}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Node</Text>
          <Text style={styles.value}>{status.data?.node ?? t("home.reading")}</Text>
        </View>
      </PixelCard>

      <Text style={styles.body}>{t("home.note")}</Text>
    </PixelScreen>
  );
}
