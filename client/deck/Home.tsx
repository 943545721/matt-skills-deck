import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { statusRpc } from "../../shared/status";
import type { Lang } from "./i18n";
import { t } from "./i18n";

/**
 * 整页界面：侧栏入口点开的那一页。
 *
 * 为什么还要这一页：Paseo 打开工作区面板必须先有工作区（面板是标签页，挂在某个工作区上），
 * 而用户刚装完插件时往往还没有打开任何工作区。这一页负责说清「任务板在哪、怎么打开」，
 * 同时给出环境读数，避免用户以为插件没装上。
 *
 * 语言开关放在这里只是本地状态：整页没有 tab 状态可持久化，而这一页的全部内容
 * 就是一段说明，重开回落中文是可以接受的。
 */
export function DeckHome({ theme, layout, host }: PluginScreenProps) {
  const [lang, setLang] = useState<Lang>("zh");
  const readStatus = useRpc(statusRpc);
  const status = useQuery({
    queryKey: ["deck", "status"],
    queryFn: () => readStatus({}),
    staleTime: 30_000,
  });

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
        padding: layout.compact ? 16 : 28,
        gap: 14,
      },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "600" as const },
      body: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        padding: 12,
        gap: 6,
      },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1, textAlign: "right" as const },
      langToggle: {
        marginLeft: "auto" as const,
        paddingVertical: 3,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      langText: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>MattSkillsDeck</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lang === "zh" ? "Switch language to English" : "切换界面语言为中文"}
          style={styles.langToggle}
          onPress={() => setLang(lang === "zh" ? "en" : "zh")}
        >
          <Text style={styles.langText}>{lang === "zh" ? "EN" : "中文"}</Text>
        </Pressable>
      </View>
      <Text style={styles.body}>{t(lang, "home.host", { label: host.label })}</Text>
      <Text style={styles.body}>{t(lang, "home.guidance")}</Text>

      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>{t(lang, "diag.pluginVersion")}</Text>
          <Text style={styles.value}>{status.data?.pluginVersion ?? t(lang, "home.reading")}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>{t(lang, "diag.gh")}</Text>
          <Text style={styles.value}>
            {status.data
              ? status.data.gh.available
                ? status.data.gh.version ?? t(lang, "diag.ghAvailable")
                : t(lang, "diag.ghUnavailable")
              : t(lang, "home.reading")}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Node</Text>
          <Text style={styles.value}>{status.data?.node ?? t(lang, "home.reading")}</Text>
        </View>
      </View>

      <Text style={styles.body}>{t(lang, "home.note")}</Text>
    </View>
  );
}
