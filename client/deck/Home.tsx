import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { statusRpc } from "../../shared/status";

/**
 * 整页界面：侧栏入口点开的那一页。
 *
 * 为什么还要这一页：Paseo 打开工作区面板必须先有工作区（面板是标签页，挂在某个工作区上），
 * 而用户刚装完插件时往往还没有打开任何工作区。这一页负责说清「任务板在哪、怎么打开」，
 * 同时给出环境读数，避免用户以为插件没装上。
 */
export function DeckHome({ theme, layout, host }: PluginScreenProps) {
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
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>MattSkillsDeck</Text>
      <Text style={styles.body}>主机：{host.label}</Text>
      <Text style={styles.body}>
        打开任意工作区，在标签栏的 + 号里选择「任务板」，即可把这个工作区的票面与地图并排放在 Agent 旁边。
      </Text>

      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>插件版本</Text>
          <Text style={styles.value}>{status.data?.pluginVersion ?? "读取中…"}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>gh 命令行</Text>
          <Text style={styles.value}>
            {status.data ? (status.data.gh.available ? (status.data.gh.version ?? "已安装") : "不可用") : "读取中…"}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Node</Text>
          <Text style={styles.value}>{status.data?.node ?? "读取中…"}</Text>
        </View>
      </View>

      <Text style={styles.body}>
        当前为 P2 版本：27 个中英技能可查看与安装；任务板能读到工作区所在 GitHub 仓库的票面与评论（只读）。
        写操作、地图详情与环境页在后续阶段接入。
      </Text>
    </View>
  );
}
