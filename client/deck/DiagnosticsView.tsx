import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, FlatList, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { logsRpc } from "../../shared/logs";
import { statusRpc } from "../../shared/status";
import { useDeckText } from "./i18n";

/**
 * 诊断页。
 *
 * 环境读数 + 最近操作日志放在一处：用户遇到「点了没反应」时，先看到的是
 * 「gh 装没装、最近一次失败说了什么」，而不是我们让他去翻 daemon 日志。
 */
export function DiagnosticsView({
  theme,
  layout,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
}) {
  const { t } = useDeckText();
  const toast = useToast();
  const readStatus = useRpc(statusRpc);
  const readLogs = useRpc(logsRpc);

  const status = useQuery({ queryKey: ["deck", "status"], queryFn: () => readStatus({}), staleTime: 30_000 });
  const logs = useQuery({ queryKey: ["deck", "logs"], queryFn: () => readLogs({ limit: 100 }), staleTime: 5_000 });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
        gap: 4,
      },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1, textAlign: "right" as const },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      action: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      logRow: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingVertical: 5,
        gap: 2,
      },
      logHead: { color: theme.colors.foregroundMuted, fontSize: 11 },
      logMessage: { fontSize: 12, color: theme.colors.foreground },
    }),
    [theme],
  );

  const entries = logs.data?.entries ?? [];
  const asText = entries
    .map((entry) => `${entry.at} [${entry.level}] ${entry.scope}: ${entry.message}`)
    .join("\n");

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>{t("diag.pluginVersion")}</Text>
          <Text style={styles.value}>{status.data?.pluginVersion ?? t("common.loading")}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Node</Text>
          <Text style={styles.value}>{status.data?.node ?? t("common.loading")}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>{t("diag.gh")}</Text>
          <Text style={status.data?.gh.available ? styles.value : styles.danger}>
            {status.data
              ? status.data.gh.available
                ? status.data.gh.version ?? t("diag.ghAvailable")
                : t("diag.ghUnavailable")
              : t("common.loading")}
          </Text>
        </View>
        {status.data && !status.data.gh.available ? (
          <Text style={styles.hint}>
            {status.data.gh.error ?? "?"} — {t("diag.ghMissingHint")}
          </Text>
        ) : null}
        <View style={styles.row}>
          <Text style={styles.label}>{t("diag.daemonCwd")}</Text>
          <Text style={styles.value} numberOfLines={2}>
            {status.data?.daemonCwd ?? t("common.loading")}
          </Text>
        </View>
      </View>

      <View style={styles.toolbar}>
        <Text style={styles.label}>{t("diag.recent")}</Text>
        <View style={{ marginLeft: "auto" as const }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("diag.refreshHint")}
          style={styles.action}
          onPress={() => void logs.refetch()}
        >
          <Text style={styles.actionText}>
            {logs.isFetching ? t("common.refreshing") : t("common.refresh")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("diag.copyLogs")}
          style={styles.action}
          onPress={() => {
            void copyText(asText || "—")
              .then(() => toast.show(t("diag.logsCopied"), { variant: "success" }))
              .catch(() => toast.error(t("common.copyFailed")));
          }}
        >
          <Text style={styles.actionText}>{t("common.copy")}</Text>
        </Pressable>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(item, index) => `${item.at}-${index}`}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>{logs.isPending ? t("common.loading") : t("diag.empty")}</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.logRow}>
            <Text style={styles.logHead}>
              {item.at.slice(11, 19)} · {item.scope} · {item.level}
            </Text>
            <Text style={[styles.logMessage, item.level === "error" ? styles.danger : null]}>{item.message}</Text>
          </View>
        )}
      />
    </View>
  );
}
