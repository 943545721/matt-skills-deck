import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useTabState, useWorkspace } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { BoardView } from "./BoardView";
import { DiagnosticsView } from "./DiagnosticsView";
import type { DeckKey } from "./i18n";
import { staticText, useDeckText } from "./i18n";
import { LabelsView } from "./LabelsView";
import { PixelButton, usePixel } from "./pixel";
import { SkillsView } from "./SkillsView";
import { VersionView } from "./VersionView";

/**
 * 面板内的视图状态由 Paseo 持久化（关掉标签页、重启应用后仍在），
 * 所以这里只存「看哪一页」和「当前票是哪张」，不存数据本身——
 * 数据永远现取，避免陈旧快照被当成事实。
 */
const tabSchema = z.object({
  view: z.enum(["board", "skills", "labels", "version", "diagnostics"]),
  /** 当前票：绑定在「这个工作区」上，换工作区就换一张，符合人的心智。 */
  current: z.number().int().min(1).optional(),
});
type TabState = z.infer<typeof tabSchema>;
const DEFAULT_TAB_STATE: TabState = { view: "board" };

const TABS: { key: TabState["view"]; label: DeckKey; hint: DeckKey }[] = [
  { key: "board", label: "tabs.board", hint: "tabs.boardHint" },
  { key: "skills", label: "tabs.skills", hint: "tabs.skillsHint" },
  { key: "labels", label: "tabs.labels", hint: "tabs.labelsHint" },
  { key: "version", label: "tabs.version", hint: "tabs.versionHint" },
  { key: "diagnostics", label: "tabs.diagnostics", hint: "tabs.diagnosticsHint" },
];

const NO_WORKSPACE: Record<TabState["view"], DeckKey> = {
  board: "common.noWorkspaceBoard",
  skills: "common.noWorkspaceSkills",
  labels: "common.noWorkspaceLabels",
  version: "common.noWorkspaceVersion",
  diagnostics: "common.unknownWorkspace",
};

/**
 * 任务板工作区面板。
 *
 * 五页各管一件事：票、技能、标签配色、版本、诊断。这里只做装配与导航，
 * 每页自己的逻辑都在自己文件里——面板是最容易被加料的地方，先立好边界。
 */
export function DeckPanel({ theme, layout, workspaceId, tab }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (snapshot) => ({
    name: snapshot.name,
    directory: snapshot.directory,
    kind: snapshot.kind,
  }));
  const [state, setState] = useTabState(tab, tabSchema, DEFAULT_TAB_STATE);
  const { t } = useDeckText();
  const skin = usePixel(theme);

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
        borderWidth: 2,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      },
      bindingText: { color: theme.colors.foreground, fontSize: 11 },
      tabs: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const, alignItems: "center" as const },
      notice: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    }),
    [theme, layout.compact, skin],
  );

  const directory = workspace?.directory;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{workspace?.name ?? t("tabs.board")}</Text>
          {state.current ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("issue.unbindHint", { number: state.current })}
              style={styles.binding}
              onPress={() => setState({ ...state, current: undefined })}
            >
              <Text style={styles.bindingText}>
                {t("board.current")} #{state.current} ✕
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.subtitle} numberOfLines={1}>
          {directory ?? t("common.unknownWorkspace")}
        </Text>
      </View>

      <View style={styles.tabs}>
        {TABS.map((item) => (
          <PixelButton
            key={item.key}
            skin={skin}
            label={staticText(t, item.label)}
            accessibilityLabel={staticText(t, item.hint)}
            active={state.view === item.key}
            onPress={() => setState({ ...state, view: item.key })}
          />
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
          <Text style={styles.notice}>{staticText(t, NO_WORKSPACE.board)}</Text>
        )
      ) : state.view === "skills" ? (
        workspace ? (
          <SkillsView theme={theme} layout={layout} workspaceDir={workspace.directory} />
        ) : (
          <Text style={styles.notice}>{staticText(t, NO_WORKSPACE.skills)}</Text>
        )
      ) : state.view === "labels" ? (
        workspace ? (
          <LabelsView theme={theme} layout={layout} workspaceDir={workspace.directory} />
        ) : (
          <Text style={styles.notice}>{staticText(t, NO_WORKSPACE.labels)}</Text>
        )
      ) : state.view === "version" ? (
        workspace ? (
          <VersionView theme={theme} layout={layout} workspaceDir={workspace.directory} />
        ) : (
          <Text style={styles.notice}>{staticText(t, NO_WORKSPACE.version)}</Text>
        )
      ) : (
        <DiagnosticsView theme={theme} layout={layout} workspaceDir={workspace?.directory} />
      )}
    </View>
  );
}
