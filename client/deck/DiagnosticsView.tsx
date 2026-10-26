import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, FlatList, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { logsRpc } from "../../shared/logs";
import { statusRpc } from "../../shared/status";

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
          <Text style={styles.label}>插件版本</Text>
          <Text style={styles.value}>{status.data?.pluginVersion ?? "读取中…"}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Node</Text>
          <Text style={styles.value}>{status.data?.node ?? "读取中…"}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>gh 命令行</Text>
          <Text style={status.data?.gh.available ? styles.value : styles.danger}>
            {status.data ? (status.data.gh.available ? (status.data.gh.version ?? "已安装") : "不可用") : "读取中…"}
          </Text>
        </View>
        {status.data && !status.data.gh.available ? (
          <Text style={styles.hint}>{status.data.gh.error ?? "未知原因"}；票面与标签相关的操作会全部失败。</Text>
        ) : null}
        <View style={styles.row}>
          <Text style={styles.label}>daemon 目录</Text>
          <Text style={styles.value} numberOfLines={2}>
            {status.data?.daemonCwd ?? "读取中…"}
          </Text>
        </View>
      </View>

      <View style={styles.toolbar}>
        <Text style={styles.label}>最近操作</Text>
        <View style={{ marginLeft: "auto" as const }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="刷新日志"
          style={styles.action}
          onPress={() => void logs.refetch()}
        >
          <Text style={styles.actionText}>{logs.isFetching ? "刷新中…" : "刷新"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="复制全部日志"
          style={styles.action}
          onPress={() => {
            void copyText(asText || "（还没有日志）")
              .then(() => toast.show("日志已复制", { variant: "success" }))
              .catch(() => toast.error("复制失败：这个客户端不支持剪贴板"));
          }}
        >
          <Text style={styles.actionText}>复制</Text>
        </Pressable>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(item, index) => `${item.at}-${index}`}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>
            {logs.isPending ? "读取中…" : "还没有写操作记录。评论、改标签、提交、推送都会在这里留一行。"}
          </Text>
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
