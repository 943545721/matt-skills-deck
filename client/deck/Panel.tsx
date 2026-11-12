import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings, useTabState, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { z } from "zod";
import {
  buildNewBugPrompt,
  buildNewSpecPrompt,
  buildNewWayfinderPrompt,
  entryRepoLabel,
} from "../../shared/entry-prompt";
import { repoTargetsRpc } from "../../shared/repo";
import type { RequirementMode } from "../../shared/requirement";
import { deckSettings } from "../../shared/settings";
import { BoardView } from "./BoardView";
import { NewIssueModal } from "./NewIssueModal";
import { DiagnosticsView } from "./DiagnosticsView";
import { LabelsView } from "./LabelsView";
import { PixelButton, PixelScreen, usePixel } from "./pixel";
import { SkillsView } from "./SkillsView";
import { OrchestrationView } from "./surfaces/OrchestrationView";
import { RequirementChooser } from "./entry/RequirementChooser";
import { entryCopy } from "./entry/entryCopy";
import { ChecksTab } from "./panel/ChecksTab";
import { IssueDetailView } from "./panel/IssueDetailView";
import { MapDetailView } from "./panel/MapDetailView";
import { PRTab } from "./panel/PRTab";
import { RunTab } from "./panel/RunTab";
import { VersionTab } from "./panel/VersionTab";
import { usePanelText, type PanelKey } from "./panel/panelText";
import { SessionSheet } from "./session/SessionSheet";
import { useDeckWorkspaceProvider } from "./surfaces/host";

/**
 * 任务板工作区面板。
 *
 * 装配与导航只在这个文件里：
 * - 页签：Board / PR / Skills / Checks / Version / Run / Diagnostics；
 * - 导航栈：board → map detail → issue detail → run。详情是全屏页，不是弹窗，
 *   这样从地图点进一张路线票、再点它的阻塞票，返回键能一层层退回。
 *
 * 状态只存「看哪一页、栈里有哪些引用、当前绑定的票」，不存数据本身：
 * 数据每次现取，避免关掉再打开时把旧快照当成事实。
 */

const currentTicket = z.object({
  repoKey: z.string().min(1).max(200),
  number: z.number().int().min(1),
});

const itemKind = z.enum(["issue", "pull-request"]);

/**
 * 导航栈元素。
 *
 * 只存引用，不存正文：标题 / 提示词都从 RPC 现取，
 * 否则一次持久化会把整份正文写进面板状态。
 */
const stackRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issue"),
    repoKey: z.string().min(1).max(200),
    number: z.number().int().min(1),
    ticketKind: itemKind,
  }),
  z.object({
    kind: z.literal("map"),
    repoKey: z.string().min(1).max(200),
    number: z.number().int().min(1),
    containerKind: z.enum(["map", "spec"]).optional(),
  }),
  z.object({ kind: z.literal("labels") }),
  z.object({
    kind: z.literal("run"),
    repoKey: z.string().min(1).max(200).optional(),
    number: z.number().int().min(1).optional(),
    title: z.string().max(300).optional(),
    ticketKind: itemKind.optional(),
  }),
]);

const tabView = z.enum(["board", "pr", "skills", "orchestrate", "checks", "version", "run", "diagnostics"]);

const tabSchema = z.object({
  view: tabView,
  current: currentTicket.optional(),
  /** 旧版本没有这个字段；缺省按空栈处理。 */
  stack: z.array(stackRef).max(20).optional(),
});
type TabState = z.infer<typeof tabSchema>;
type PanelTab = z.infer<typeof tabView>;
type StackRef = z.infer<typeof stackRef>;
const DEFAULT_TAB_STATE: TabState = { view: "board" };

const TABS: { key: PanelTab; label: PanelKey }[] = [
  { key: "board", label: "tab.board" },
  { key: "pr", label: "tab.pr" },
  { key: "skills", label: "tab.skills" },
  { key: "orchestrate", label: "tab.orchestrate" },
  { key: "checks", label: "tab.checks" },
  { key: "version", label: "tab.version" },
  { key: "run", label: "tab.run" },
  { key: "diagnostics", label: "tab.diagnostics" },
];

export function DeckPanel({ theme, layout, workspaceId, tab, navigation }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (snapshot) => ({
    name: snapshot.name,
    directory: snapshot.directory,
    kind: snapshot.kind,
  }));
  const [state, setState] = useTabState(tab, tabSchema, DEFAULT_TAB_STATE);
  const { t, zh } = usePanelText();
  const skin = usePixel(theme);
  const settings = useSettings(deckSettings);
  const toast = useToast();
  const [writeAllowed, setWriteAllowed] = useState(true);
  const lang: "zh" | "en" = zh ? "zh" : "en";
  const [createOpen, setCreateOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entrySheet, setEntrySheet] = useState<{
    open: boolean;
    prompt: string;
    title: string;
    /** 探讨需求语义上就是新会话；地图动作等默认跟随当前选中会话。 */
    defaultTarget?: "new";
  }>({
    open: false,
    prompt: "",
    title: "",
  });

  // 「新建需求 / + bug」开场白里的仓库字段：有默认仓库就用它，只有一个时直接用，多项目时列出清单。
  const repoTargets = useRpc(repoTargetsRpc);
  const targets = useQuery({
    queryKey: ["deck", "repo-targets", workspace?.directory ?? ""],
    queryFn: () => repoTargets({ workspaceDir: workspace?.directory ?? "" }),
    enabled: Boolean(workspace?.directory),
    staleTime: 60_000,
    retry: false,
  });
  const provider = useDeckWorkspaceProvider(workspaceId);
  // PR 页签只对 GitHub 有意义：GitLab 实例不把 MR 混进 issues 列表，本地 Markdown 更没有 PR。
  // 目标仓库还没读出来（或读失败）时不抢先隐藏，避免一次临时失败把页签永久藏掉。
  const tabs = useMemo(() => {
    const repos = targets.data?.ok ? targets.data.repos : null;
    const hasGitHub = repos === null || repos.some((repo) => repo.host === "github");
    return hasGitHub ? TABS : TABS.filter((item) => item.key !== "pr");
  }, [targets.data]);
  // 多项目工作区没有默认仓库时列出全部清单，而不是留空把三个入口锁死。
  const entryRepo = useMemo(
    () => (targets.data?.ok === true ? entryRepoLabel(targets.data, lang) : ""),
    [targets.data, lang],
  );
  // 一个仓库都读不出来时，入口不该发出「仓库：」后面空白的开场白；
  // 刷新失败时也不拿上一次的清单继续用（isSuccess 会变 false）。
  const entryReady = Boolean(workspace?.directory) && targets.isSuccess && entryRepo !== "";
  const touch = Platform.OS === "ios" || Platform.OS === "android";

  const stack = state.stack ?? [];
  const top = stack[stack.length - 1];
  const bound = state.current;
  const isBound = (repoKey: string, number: number): boolean =>
    bound !== undefined && bound.repoKey === repoKey && bound.number === number;

  const toggleSkin = () => {
    if (settings.status !== "ready") return;
    const next = skin.dark ? "light" : "dark";
    void settings.save({ ...settings.values, appearance: next }, settings.revision).then((saved) => {
      if (!saved) toast.error(t("skin.saveFailed"));
    });
  };

  const push = (ref: StackRef) => {
    setState({ ...state, stack: [...stack, ref].slice(-20) });
  };
  const pop = () => setState({ ...state, stack: stack.slice(0, -1) });
  const switchTab = (view: PanelTab) => setState({ ...state, view, stack: [] });

  const styles = useMemo(
    () => ({
      screen: { padding: layout.compact ? 8 : 10 },
      header: { gap: 2 },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      title: {
        color: skin.colors.tabInk,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
        fontSize: layout.compact ? 16 : 18,
        letterSpacing: 1,
      },
      subtitle: { color: skin.colors.tabInk, fontSize: 11, fontFamily: skin.mono.fontFamily, opacity: 0.9 },
      skinToggle: { marginLeft: "auto" as const },
      binding: {
        paddingVertical: 1,
        paddingHorizontal: 7,
        borderWidth: 1,
        borderColor: skin.colors.line,
        backgroundColor: skin.colors.stripe,
      },
      bindingText: {
        color: skin.colors.ink,
        fontSize: 11,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      tabs: {
        flexDirection: "row" as const,
        gap: 4,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        borderBottomWidth: 1,
        borderBottomColor: skin.colors.line,
      },
      // 页签行右端的动作按钮：透明底、1px 描边、图标 + 文字（会展开浮层的「探讨需求」带下箭头）。
      entryButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        minHeight: touch ? 36 : undefined,
        paddingVertical: touch ? 7 : 2,
        paddingHorizontal: 8,
        borderWidth: 1,
        backgroundColor: "transparent",
      },
      entryButtonText: {
        fontSize: 11,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      notice: skin.hintOnChecker,
      backRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      crumb: { color: skin.colors.tabInk, fontSize: 11, fontFamily: skin.mono.fontFamily },
      content: { flex: 1 },
    }),
    [skin, layout.compact],
  );

  const directory = workspace?.directory;
  const copy = entryCopy(lang);

  /** 选卡后：关掉选路浮层，把 DSH 原文开场白与 `[New]` 标题交给会话面板。 */
  const openEntry = (mode: RequirementMode) => {
    setEntryOpen(false);
    const prompt =
      mode === "explore"
        ? buildNewWayfinderPrompt({ lang, repo: entryRepo })
        : buildNewSpecPrompt({ lang, repo: entryRepo });
    const title = mode === "explore" ? copy.sessionTitle.requirement : copy.sessionTitle.spec;
    setEntrySheet({ open: true, prompt, title, defaultTarget: "new" });
  };

  const openContainerAction = (input: { kind: "inspect" | "execute" | "complete"; repoKey: string; number: number; title: string; containerKind: "map" | "spec"; url: string; total: number; closed: number }) => {
    const complete = input.kind === "complete";
    const inspect = input.kind === "inspect";
    const zhPrompt = lang === "zh";
    const prompt = input.containerKind === "spec"
      ? complete
        ? (zhPrompt ? `复核实施地图 #${input.number}（${input.title}）及其 ${input.closed}/${input.total} 张子票。总结已交付内容、剩余缺口和验证证据；未确认验收条件前不要关闭票。` : `Review implementation map #${input.number} (${input.title}) and its ${input.closed}/${input.total} child tickets. Summarize delivered work, remaining gaps, and verification evidence. Do not close tickets without confirming their acceptance criteria.`)
        : inspect
          ? (zhPrompt ? `/to-tickets ${input.url}\n\n把这张实施地图拆成可执行的票。先读地图和仓库，保留依赖关系与验收条件。` : `/to-tickets ${input.url}\n\nSplit this implementation map into actionable tickets. Read the map and repository first; preserve dependencies and acceptance criteria.`)
          : (zhPrompt ? `/implement-spec ${input.url}` : `/implement-spec ${input.url}`)
      : complete
        ? (zhPrompt ? `完成地图 #${input.number}（${input.title}）。复核全部 ${input.total} 张子票（${input.closed} 张已关闭），验证目标并报告剩余工作；没有证据证明完成前不要关闭地图。` : `Complete map #${input.number} (${input.title}). Review all ${input.total} child tickets (${input.closed} closed), verify the destination and report any remaining work. Do not close the map unless completion is evidenced.`)
        : inspect
          ? (zhPrompt ? `/wayfinder ${input.url}\n\n检查这张地图，澄清目标和雾区，并提出下一个具体步骤；路线清楚前不要实施。` : `/wayfinder ${input.url}\n\nInspect this map, clarify its destination and fog, and propose the next concrete step. Do not implement until the route is clear.`)
          : (zhPrompt ? `/wayfinder ${input.url}\n\n继续这张地图，推进下一张可执行路线票。遵守阻塞关系，并把已验证的进展写回地图。` : `/wayfinder ${input.url}\n\nContinue this map by taking the next ready route ticket. Respect blockers and update the map with verified progress.`);
    const label = inspect ? (input.containerKind === "spec" ? (zhPrompt ? "拆分规格" : "Split spec") : (zhPrompt ? "检查地图" : "Inspect map")) : complete ? (zhPrompt ? "完成地图" : "Complete map") : (zhPrompt ? "执行地图" : "Execute map");
    setEntrySheet({ open: true, prompt, title: `[${label}] #${input.number} ${input.title}` });
  };

  /** DSH 的「+ bug」不弹选路，直接开新会话预填 BUG 单原文。 */
  const openBug = () => {
    setEntrySheet({
      open: true,
      prompt: buildNewBugPrompt({ lang, repo: entryRepo }),
      title: copy.sessionTitle.bug,
      defaultTarget: "new",
    });
  };

  const crumbOf = (ref: StackRef): string => {
    if (ref.kind === "map") return `${t("nav.map")} #${ref.number}`;
    if (ref.kind === "issue") {
      return `${ref.ticketKind === "pull-request" ? "PR" : t("nav.issue")} #${ref.number}`;
    }
    if (ref.kind === "labels") return t("nav.labels");
    return ref.number ? `${t("nav.run")} #${ref.number}` : t("nav.run");
  };

  const noWorkspace = <Text style={styles.notice}>{t("common.noWorkspace")}</Text>;

  const renderStack = () => {
    if (!top || !directory) return noWorkspace;
    if (top.kind === "map") {
      return (
        <MapDetailView
          theme={theme}
          workspaceDir={directory}
          repoKey={top.repoKey}
          number={top.number}
          containerKind={top.containerKind}
          onOpenIssue={(number) => push({ kind: "issue", repoKey: top.repoKey, number, ticketKind: "issue" })}
          onAction={openContainerAction}
        />
      );
    }
    if (top.kind === "issue") {
      return (
        <IssueDetailView
          theme={theme}
          workspaceId={workspaceId}
          workspaceDir={directory}
          repoKey={top.repoKey}
          number={top.number}
          kind={top.ticketKind}
          isCurrent={isBound(top.repoKey, top.number)}
          allowWrite={writeAllowed}
          onBind={() =>
            setState({
              ...state,
              current: isBound(top.repoKey, top.number)
                ? undefined
                : { repoKey: top.repoKey, number: top.number },
            })
          }
          onOpenIssue={(number, kind) => push({ kind: "issue", repoKey: top.repoKey, number, ticketKind: kind })}
          onOpenMap={(number, containerKind) => push({ kind: "map", repoKey: top.repoKey, number, containerKind })}
          onAttach={(ref) =>
            push({
              kind: "run",
              repoKey: ref.repoKey,
              number: ref.number,
              title: ref.title,
              ticketKind: ref.kind,
            })
          }
          navigation={navigation}
        />
      );
    }
    if (top.kind === "labels") {
      return <LabelsView theme={theme} layout={layout} workspaceDir={directory} />;
    }
    return (
      <RunTab
        theme={theme}
        workspaceDir={directory}
        attachment={
          top.repoKey && top.number
            ? {
                repoKey: top.repoKey,
                number: top.number,
                title: top.title,
                kind: top.ticketKind ?? "issue",
              }
            : undefined
        }
      />
    );
  };

  const renderTab = () => {
    if (state.view === "diagnostics") {
      return <DiagnosticsView theme={theme} layout={layout} workspaceDir={directory} />;
    }
    if (!directory) return noWorkspace;
    if (state.view === "board") {
      return (
        <BoardView
          key={directory}
          theme={theme}
          layout={layout}
          workspaceDir={directory}
          current={state.current}
          onBind={(ticket) => setState({ ...state, current: ticket })}
          onOpenIssue={(ref) =>
            push({ kind: "issue", repoKey: ref.repoKey, number: ref.number, ticketKind: ref.kind })
          }
          onOpenMap={(ref) => push({ kind: "map", ...ref })}
          onOpenLabels={() => push({ kind: "labels" })}
          onWriteGate={setWriteAllowed}
        />
      );
    }
    if (state.view === "pr") {
      return (
        <PRTab
          theme={theme}
          layout={layout}
          workspaceDir={directory}
          onOpenPullRequest={(ref) =>
            push({ kind: "issue", repoKey: ref.repoKey, number: ref.number, ticketKind: "pull-request" })
          }
        />
      );
    }
    if (state.view === "skills") {
      return <SkillsView theme={theme} layout={layout} workspaceId={workspaceId} workspaceDir={directory} navigation={navigation} />;
    }
    if (state.view === "orchestrate") {
      return (
        <OrchestrationView
          key={directory}
          theme={theme}
          layout={layout}
          workspaceId={workspaceId}
          workspaceDir={directory}
          navigation={navigation}
        />
      );
    }
    if (state.view === "checks") {
      return <ChecksTab theme={theme} workspaceId={workspaceId} workspaceDir={directory} navigation={navigation} />;
    }
    if (state.view === "version") {
      return <VersionTab theme={theme} layout={layout} workspaceDir={directory} />;
    }
    return <RunTab theme={theme} workspaceDir={directory} />;
  };

  return (
    <PixelScreen skin={skin} style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{workspace?.name ?? t("tab.board")}</Text>
          {state.current ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("nav.unbind", { number: state.current.number })}
              style={styles.binding}
              onPress={() => setState({ ...state, current: undefined })}
            >
              <Text style={styles.bindingText}>
                {t("nav.binding")}{" "}
                {state.current.repoKey === "local" ? t("tab.board") : state.current.repoKey} #{state.current.number} ✕
              </Text>
            </Pressable>
          ) : null}
          <View style={styles.skinToggle}>
            <PixelButton
              skin={skin}
              mini
              variant="ghost"
              label={skin.dark ? t("skin.light") : t("skin.dark")}
              accessibilityLabel={skin.dark ? t("skin.light") : t("skin.dark")}
              onPress={toggleSkin}
              disabled={settings.status !== "ready" || settings.saving}
            />
          </View>
        </View>
        <Text style={styles.subtitle} numberOfLines={1}>
          {directory ?? t("common.noWorkspace")}
        </Text>
      </View>

      <View style={styles.tabs}>
        {tabs.map((item) => (
          <PixelButton
            key={item.key}
            skin={skin}
            variant="tab"
            label={t(item.label)}
            active={state.view === item.key}
            onPress={() => switchTab(item.key)}
          />
        ))}
        <View style={{ flex: 1 }} />
        {/* 牌子归建票那条：这里真的建一张需求票，不是开一个会话。 */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.newRequirementTitle}
          disabled={!entryReady}
          onPress={() => setCreateOpen(true)}
          style={({ pressed }) => [
            styles.entryButton,
            { borderColor: skin.colors.acc },
            pressed ? { opacity: 0.72 } : null,
            !entryReady ? { opacity: 0.5 } : null,
          ]}
        >
          <Icon name="Plus" size={11} color={skin.colors.acc} />
          <Text style={[styles.entryButtonText, { color: skin.colors.acc }]} numberOfLines={1}>
            {copy.newRequirement}
          </Text>
        </Pressable>
        {/* 开会话 + 预填提示词的那条路改叫「探讨需求」：两张卡各是一种谈法。 */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.discussRequirementTitle}
          disabled={!entryReady}
          onPress={() => setEntryOpen(true)}
          style={({ pressed }) => [
            styles.entryButton,
            { borderColor: skin.colors.ink2 },
            pressed ? { opacity: 0.72 } : null,
            !entryReady ? { opacity: 0.5 } : null,
          ]}
        >
          <Icon name="MessageSquare" size={11} color={skin.colors.ink2} />
          <Text style={[styles.entryButtonText, { color: skin.colors.ink2 }]} numberOfLines={1}>
            {copy.discussRequirement}
          </Text>
          <Icon name="ChevronDown" size={9} color={skin.colors.ink2} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.newBugTitle}
          disabled={!entryReady}
          onPress={openBug}
          style={({ pressed }) => [
            styles.entryButton,
            { borderColor: skin.colors.bad },
            pressed ? { opacity: 0.72 } : null,
            !entryReady ? { opacity: 0.5 } : null,
          ]}
        >
          <Icon name="Bug" size={11} color={skin.colors.bad} />
          <Text style={[styles.entryButtonText, { color: skin.colors.bad }]} numberOfLines={1}>
            {copy.newBug}
          </Text>
        </Pressable>
      </View>

      {top ? (
        <View style={styles.backRow}>
          <PixelButton skin={skin} mini variant="ghost" label={t("nav.back")} onPress={pop} />
          <Text style={styles.crumb}>{crumbOf(top)}</Text>
          {stack.length > 1 ? <Text style={styles.crumb}>· {stack.length}</Text> : null}
        </View>
      ) : null}

      <View style={styles.content}>{top ? renderStack() : renderTab()}</View>

      <RequirementChooser
        lang={lang}
        open={entryOpen}
        onOpenChange={setEntryOpen}
        onPick={openEntry}
      />
      {/* 「新建需求」落点：建票表单，类型预选探索需求。仓库清单与 /deck new 同一份 RPC。 */}
      {directory ? (
        <NewIssueModal
          theme={theme}
          workspaceDir={directory}
          repos={(targets.data?.ok ? targets.data.repos : []).map((repo) => ({
            key: repo.key,
            name: repo.name,
            readOnly: repo.readOnly,
          }))}
          defaultRepoKey={targets.data?.ok ? targets.data.defaultKey : null}
          defaultMode="explore"
          open={createOpen}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      <SessionSheet
        open={entrySheet.open}
        onOpenChange={(open) => setEntrySheet((current) => ({ ...current, open }))}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={directory ?? ""}
        provider={provider}
        title={entrySheet.title}
        action="custom"
        context={{}}
        initialPrompt={entrySheet.prompt}
        defaultTarget={entrySheet.defaultTarget}
        navigation={navigation}
      />
    </PixelScreen>
  );
}
