import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useTabState, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { statusRpc } from "../../shared/status";
import { BoardView } from "./BoardView";
import { LabelsView } from "./LabelsView";
import { SkillsView } from "./SkillsView";

/**
 * 面板内的视图状态由 Paseo 持久化（关掉标签页、重启应用后仍在），
 * 所以这里只存「看哪一页」和「当前票是哪张」，不存数据本身——数据永远现取，
 * 避免陈旧快照被当成事实。
 */
const tabSchema = z.object({
  view: z.enum(["board", "skills", "labels", "about"]),
  /** 当前票：绑定在「这个工作区」上，换工作区就换一张，符合人的心智。 */
  current: z.number().int().min(1).optional(),
});
type TabState = z.infer<typeof tabSchema>;
const DEFAULT_TAB_STATE: TabState = { view: "board" };

const TABS = [
  { key: "board" as const, label: "任务板", hint: "查看任务板" },
  { key: "skills" as const, label: "技能", hint: "查看技能" },
  { key: "labels" as const, label: "标签", hint: "查看标签配色" },
  { key: "about" as const, label: "环境", hint: "查看环境" },
];

/**
 * 任务板工作区面板。
 *
 * 四页各管一件事：票、技能、标签配色、环境读数。这里只做装配与导航，
 * 每页自己的逻辑都在自己文件里——面板是最容易被加料的地方，先立好边界。
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
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 16 : 18, fontWeight: "600" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      binding: {
        paddingVertical: 2,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      },
      bindingText: { color: theme.colors.foreground, fontSize: 11 },
      tabs: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
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
        <View style={styles.titleRow}>
          <Text style={styles.title}>{workspace?.name ?? "任务板"}</Text>
          {state.current ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`解除当前票 #${state.current}`}
              style={styles.binding}
              onPress={() => setState({ ...state, current: undefined })}
            >
              <Text style={styles.bindingText}>当前票 #{state.current} ✕</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.subtitle} numberOfLines={1}>
          {workspace?.directory ?? "工作区目录未知"}
        </Text>
      </View>

      <View style={styles.tabs}>
        {TABS.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={item.hint}
            style={[styles.tab, state.view === item.key ? styles.tabActive : null]}
            onPress={() => setState({ ...state, view: item.key })}
          >
            <Text style={state.view === item.key ? styles.tabTextActive : styles.tabText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      {state.view === "board" ? (
        workspace ? (
          <BoardView
            theme={theme}
            layout={layout}
            workspaceDir={workspace.directory}
            current={state.current}
            onBind={(number) => setState({ ...state, current: number })}
          />
        ) : (
          <Text style={styles.notice}>工作区目录未知，暂时读不到票面。</Text>
        )
      ) : state.view === "skills" ? (
        workspace ? (
          <SkillsView theme={theme} layout={layout} workspaceDir={workspace.directory} />
        ) : (
          <Text style={styles.notice}>工作区目录未知，暂时无法安装技能。</Text>
        )
      ) : state.view === "labels" ? (
        workspace ? (
          <LabelsView theme={theme} layout={layout} workspaceDir={workspace.directory} />
        ) : (
          <Text style={styles.notice}>工作区目录未知，暂时读不到标签。</Text>
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
