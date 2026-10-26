import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useTabState, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { statusRpc } from "../../shared/status";
import { SkillsView } from "./SkillsView";

/**
 * 面板内的视图状态由 Paseo 持久化（关掉标签页、重启应用后仍在），
 * 所以这里只存「看哪一页」，不存数据本身——数据永远现取，避免陈旧快照被当成事实。
 */
const tabSchema = z.object({ view: z.enum(["board", "skills", "about"]) });
type TabState = z.infer<typeof tabSchema>;
const DEFAULT_TAB_STATE: TabState = { view: "board" };

/**
 * 任务板的工作区面板（P0 骨架版）。
 *
 * 现阶段只做三件事，用来验证宿主契约全部打通：
 * 1. 从工作区快照拿到名字与目录（证明 useWorkspace 可用）；
 * 2. 通过 RPC 向 daemon 取环境读数（证明 server 半与 RPC 通道可用）；
 * 3. 记住用户停在哪一页（证明 tab state 持久化可用）。
 * 真正的票面与地图在 P2 接入，届时把 BoardPlaceholder 换成列表与详情。
 */
export function DeckPanel({ theme, layout, workspaceId, tab }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (snapshot) => ({
    name: snapshot.name,
    directory: snapshot.directory,
    kind: snapshot.kind,
  }));
  const [state, setState] = useTabState(tab, tabSchema, DEFAULT_TAB_STATE);

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
        padding: layout.compact ? 12 : 20,
        gap: 12,
      },
      header: { gap: 2 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 16 : 18, fontWeight: "600" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      tabs: { flexDirection: "row" as const, gap: 8 },
      tab: {
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      tabActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
      tabText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      tabTextActive: { color: theme.colors.foreground, fontSize: 12 },
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
      notice: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{workspace?.name ?? "任务板"}</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {workspace?.directory ?? "工作区目录未知"}
        </Text>
      </View>

      <View style={styles.tabs}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="查看任务板"
          style={[styles.tab, state.view === "board" ? styles.tabActive : null]}
          onPress={() => setState({ view: "board" })}
        >
          <Text style={state.view === "board" ? styles.tabTextActive : styles.tabText}>任务板</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="查看技能"
          style={[styles.tab, state.view === "skills" ? styles.tabActive : null]}
          onPress={() => setState({ view: "skills" })}
        >
          <Text style={state.view === "skills" ? styles.tabTextActive : styles.tabText}>技能</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="查看环境"
          style={[styles.tab, state.view === "about" ? styles.tabActive : null]}
          onPress={() => setState({ view: "about" })}
        >
          <Text style={state.view === "about" ? styles.tabTextActive : styles.tabText}>环境</Text>
        </Pressable>
      </View>

      {state.view === "board" ? (
        <View style={styles.card}>
          <Text style={styles.notice}>
            「技能」页已可用：27 个中英技能可逐个查看原文，并按工作区安装到 .claude/skills 与 .agents/skills。
          </Text>
          <Text style={styles.notice}>
            票面列表、地图详情与三后端（GitHub / GitLab / 本地 Markdown）在 P2 接入。
          </Text>
        </View>
      ) : state.view === "skills" ? (
        workspace ? (
          <SkillsView theme={theme} layout={layout} workspaceDir={workspace.directory} />
        ) : (
          <Text style={styles.notice}>工作区目录未知，暂时无法安装技能。</Text>
        )
      ) : (
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
            <Text style={styles.label}>gh</Text>
            <Text style={status.data?.gh.available ? styles.value : styles.danger}>
              {status.data ? (status.data.gh.available ? (status.data.gh.version ?? "已安装") : "不可用") : "读取中…"}
            </Text>
          </View>
          {status.data && !status.data.gh.available ? (
            <Text style={styles.notice}>{status.data.gh.error ?? "未知原因"}</Text>
          ) : null}
          {status.error ? <Text style={styles.danger}>{status.error.message}</Text> : null}
          <View style={styles.row}>
            <Text style={styles.label}>daemon 目录</Text>
            <Text style={styles.value} numberOfLines={2}>
              {status.data?.daemonCwd ?? "读取中…"}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}
