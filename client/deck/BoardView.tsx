import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { FlatList, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ItemKind, ListView, RepoSummary, SortKey } from "../../shared/issues";
import { issuesListRpc } from "../../shared/issues";
import type { RepoTargetSummary } from "../../shared/repo";
import { repoInfoRpc, repoSelectRpc, repoTargetsRpc, workspaceProjectsRpc } from "../../shared/repo";
import { freshnessLevel } from "../../shared/refresh";
import { BoardFilters } from "./board/BoardFilters";
import { groupRows, parentKeys, rowKeyOf } from "./board/groupRows";
import { ProjectStrip } from "./board/ProjectStrip";
import { availableFacets, filterByFacets, projectRows } from "./board/projectRows";
import type { DeckKey } from "./i18n";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";
import { labelMatches } from "./labelText";
import { GithubAuthModal } from "./GithubAuthModal";
import { staleBlockerLabels } from "./format";
import { PixelBanner, PixelButton, PixelStatusLine, usePixel } from "./pixel";
import { refreshReasonKey, usePanelText } from "./panel/panelText";
import { TicketRow } from "./panel/TicketRow";
import { usePanelRefresh } from "./panel/usePanelRefresh";

/**
 * 任务板列表（只有 issue）。
 *
 * 拉取请求移到独立页签，这个页面里不再有 kind 开关：
 * 同号票与 PR 混在一张列表里，任何写按钮都要先猜用户点的是哪一种。
 *
 * 三种票的处置状态仍由服务端算好（`readiness`），界面只筛选与展示。
 * 关闭分页是本地分页：列表 RPC 一次最多 100 条、没有 cursor，
 * 所以页脚只承诺「本窗口」，并明确写出远端还有更多。
 */

/** 当前票：票号只在仓库内唯一，任何绑定都必须带 repoKey。 */
export interface CurrentTicket {
  repoKey: string;
  number: number;
}

/** 打开一张票/PR 的引用；详情页在导航栈里，不在弹窗里。 */
export interface TicketRef {
  repoKey: string;
  number: number;
  kind: ItemKind;
}

type BoardFilterView = Extract<ListView, "all" | "open" | "ready" | "blocked" | "closed">;

const PAGE_SIZE = 20;

const VIEWS: { key: BoardFilterView; label: DeckKey }[] = [
  { key: "all", label: "board.viewAll" },
  { key: "open", label: "board.viewOpen" },
  { key: "ready", label: "board.viewReady" },
  { key: "blocked", label: "board.viewBlocked" },
  { key: "closed", label: "board.viewClosed" },
];

const SORTS: { key: SortKey; label: DeckKey }[] = [
  { key: "updated", label: "board.sortUpdated" },
  { key: "created", label: "board.sortCreated" },
  { key: "number", label: "board.sortNumber" },
  { key: "title", label: "board.sortTitle" },
];

export function BoardView({
  theme,
  layout,
  workspaceDir,
  current,
  onBind,
  onOpenIssue,
  onOpenMap,
  onOpenLabels,
  onWriteGate,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
  current?: CurrentTicket;
  onBind(ticket: CurrentTicket | undefined): void;
  onOpenIssue(ref: TicketRef): void;
  onOpenMap(ref: { repoKey: string; number: number }): void;
  onOpenLabels(): void;
  /** 把刷新策略算出的写权限交给面板，详情页沿用同一个门。 */
  onWriteGate?(allowWrite: boolean): void;
}) {
  const { t, locale } = useDeckText();
  const { t: pt } = usePanelText();
  const skin = usePixel(theme);
  const toast = useToast();

  const [view, setView] = useState<BoardFilterView>("open");
  const [sort, setSort] = useState<SortKey>("updated");
  const [label, setLabel] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [authOpen, setAuthOpen] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string | null | undefined>(undefined);
  // 模块与角色：只在有配置的项目清单时才有选项，单项目老用户看不到这两行。
  const [area, setArea] = useState("");
  const [role, setRole] = useState("");
  /**
   * 收起来的地图，键是 `仓库#票号`（不是行下标）：刷新、翻页、切视图之后
   * 同一条子票换了位置，收起状态还得跟着同一张图走。
   * 默认空集 = 全都展开：折叠是用户点出来的状态，不该替他预设。
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const listIssues = useRpc(issuesListRpc);
  const repoInfo = useRpc(repoInfoRpc);
  const repoListing = useRpc(repoTargetsRpc);
  const selectRepo = useRpc(repoSelectRpc);
  const readProjects = useRpc(workspaceProjectsRpc);
  const queryClient = useQueryClient();

  const targets = useQuery({
    queryKey: ["deck", "repo-targets", workspaceDir],
    queryFn: () => repoListing({ workspaceDir }),
    staleTime: 30_000,
  });
  const defaultKey = targets.data?.ok ? targets.data.defaultKey : null;
  const truncated = targets.data?.ok ? targets.data.truncated : false;
  const activeRepo = repoFilter === undefined ? defaultKey : repoFilter;

  // 项目清单只决定「怎么分组与怎么筛」；读不出来就是零个项目，界面退回仓库选择器。
  const projects = useQuery({
    queryKey: ["deck", "workspace-projects", workspaceDir],
    queryFn: () => readProjects({ workspaceDir }),
    staleTime: 60_000,
  });

  // 仓库被删掉 / 改名后自动退回「全部」。
  useEffect(() => {
    if (!repoFilter || !targets.data?.ok) return;
    if (targets.data.repos.some((item) => item.key === repoFilter)) return;
    setRepoFilter(null);
  }, [repoFilter, targets.data]);

  const pickRepo = useMutation({
    mutationFn: (dir: string | null) => selectRepo({ workspaceDir, repoDir: dir }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(`${t("board.repoSelectFailed")}：${result.detail}`);
        return;
      }
      toast.show(
        result.selected ? t("board.repoDefaultSet", { dir: result.selected }) : t("board.repoDefaultCleared"),
        { variant: "success" },
      );
      void queryClient.invalidateQueries({ queryKey: ["deck"] });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  /**
   * 一次取回本窗口的 issue（打开 + 关闭），视图切换在本地做。
   *
   * 服务端的 `counts` 是「所有 kind」的窗口计数，会把 PR 算进任务板的 KPI；
   * 而 `readiness` 已经由服务端算好，按它筛选只是选行，不是重算判定。
   * 这样 KPI 与列表严格同源，切换筛选也不会额外烧额度。
   */
  const list = useQuery({
    queryKey: ["deck", "issues", workspaceDir, activeRepo ?? "all", "issue", sort, label],
    enabled: !targets.isPending,
    queryFn: () =>
      listIssues({
        workspaceDir,
        repoKey: activeRepo ?? undefined,
        includeClosed: true,
        view: "all",
        kind: "issue",
        label: label || undefined,
        sort,
        limit: 100,
      }),
    staleTime: 15_000,
  });

  const rateLimit = list.data?.ok ? list.data.rateLimit : null;
  const remaining = rateLimit && rateLimit.limit > 0 ? rateLimit.remaining / rateLimit.limit : null;
  const refresh = usePanelRefresh({ query: list, remaining, enabled: !targets.isPending });

  // 面板的详情页不在这个组件里，但写权限来自同一份额度：只上报判定结果。
  useEffect(() => {
    onWriteGate?.(refresh.decision.allowWrite);
  }, [onWriteGate, refresh.decision.allowWrite]);

  const listedRepos: (RepoTargetSummary | (RepoSummary & { relDir: null }))[] = targets.data?.ok
    ? targets.data.repos
    : list.data?.ok
      ? list.data.repos.map((item) => ({ ...item, relDir: null }))
      : [];
  const repoCount = listedRepos.length;
  const scopedKey = activeRepo ?? (repoCount === 1 ? (listedRepos[0]?.key ?? null) : null);
  const info = useQuery({
    queryKey: ["deck", "repo-info", workspaceDir, scopedKey],
    queryFn: () => repoInfo({ workspaceDir, repoKey: scopedKey ?? undefined }),
    enabled: scopedKey !== null || Boolean(list.data && !list.data.ok && list.data.repo),
    staleTime: 5 * 60_000,
  });
  const detail = info.data?.ok ? info.data.repo : null;

  // 筛选条件变化时关闭分页回到第一页；否则从「已关闭」切回「打开」还停在第 5 页。
  useEffect(() => {
    setPage(1);
  }, [view, sort, label, activeRepo, search, area, role]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      tabbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 2,
        flexWrap: "wrap" as const,
        borderBottomWidth: 1,
        borderBottomColor: skin.colors.line,
        paddingBottom: 2,
      },
      divider: { width: 1, height: 18, backgroundColor: skin.colors.line, marginHorizontal: 6 },
      sectionLabel: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, marginRight: 2 },
      repoBlock: { gap: 4, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: skin.colors.line },
      repoTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      repoLabel: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, letterSpacing: 0.5 },
      hostTag: {
        borderWidth: 1,
        borderColor: skin.colors.line,
        backgroundColor: skin.colors.stripe,
        paddingHorizontal: 6,
      },
      hostText: {
        color: skin.colors.ink2,
        fontSize: 10,
        lineHeight: 16,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      openRepo: {
        color: skin.colors.link,
        fontSize: 11,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      repoName: {
        color: skin.colors.ink,
        fontSize: 14,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
        flexShrink: 1,
        lineHeight: 20,
      },
      repoRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      repoFacts: { gap: 2, marginTop: 2 },
      repoDescription: { color: skin.colors.ink2, fontSize: 12, lineHeight: 17 },
      repoPicker: { gap: 4, marginTop: 4 },
      pickerRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, alignItems: "center" as const },
      onChecker: skin.hintOnChecker,
      spacer: { marginLeft: "auto" as const },
      label: {
        fontSize: 10,
        lineHeight: 16,
        paddingHorizontal: 6,
        overflow: "hidden" as const,
        borderWidth: 1,
        borderColor: skin.colors.line,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      hint: skin.hint,
      error: skin.error,
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const, alignItems: "center" as const },
      freshness: skin.statuslineText,
      kpiRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 16, alignItems: "flex-end" as const },
      kpi: { gap: 0 },
      kpiLabel: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily, letterSpacing: 0.5 },
      kpiNum: { color: skin.colors.ink, fontSize: 18, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      kpiNumAccent: { color: skin.colors.acc },
      kpiNote: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily, marginLeft: "auto" as const },
      // 地图分组：父行左边固定 14px 放 ▾ 和张数，子票靠一道 1px 竖线挂在同一列下面。
      // 固定宽度是为了让「有子票的图」和「普通票」的卡片左边缘对齐——不对齐时一列票看起来是歪的。
      groupBar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingBottom: 2 },
      groupToggle: { width: 14, alignItems: "center" as const, paddingTop: 9, gap: 0 },
      groupChevron: { fontSize: 11, lineHeight: 14, color: skin.colors.ink2, fontFamily: skin.mono.fontFamily },
      groupChevronOpen: { color: skin.colors.acc },
      groupCount: { fontSize: 9, lineHeight: 11, color: skin.colors.ink2, fontFamily: skin.mono.fontFamily },
      rowWrap: { flexDirection: "row" as const, gap: 4 },
      rowGutter: { width: 14 },
      rowMain: { flex: 1 },
      childWrap: { marginLeft: 14, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: skin.colors.line },
    }),
    [skin],
  );

  const repo = list.data?.ok ? list.data.repo : list.data?.repo;
  const scopedSummary = activeRepo
    ? listedRepos.find((item) => item.key === activeRepo) ?? null
    : repoCount === 1
      ? listedRepos[0] ?? null
      : null;
  const header = scopedSummary
    ? scopedSummary.host === "local"
      ? scopedSummary.name
      : scopedSummary.key
    : repoCount > 1
      ? t("board.repoAll")
      : repo
        ? repo.host === "local"
          ? repo.name
          : `${repo.owner}/${repo.name}`
        : null;
  const host = scopedSummary?.host ?? repo?.host ?? null;
  const hostKey: DeckKey =
    host === "github"
      ? "board.hostGithub"
      : host === "gitlab"
        ? "board.hostGitlab"
        : host === "local"
          ? "board.hostLocal"
          : "board.hostOther";
  const repoWebUrl = scopedSummary?.webUrl ?? repo?.webUrl ?? null;

  const dateText = (iso: string | null): string | null => {
    if (!iso) return null;
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  };

  const visibilityKey: DeckKey =
    detail?.visibility === "public"
      ? "board.repoPublic"
      : detail?.visibility === "private"
        ? "board.repoPrivate"
        : detail?.visibility === "internal"
          ? "board.repoInternal"
          : "board.repoVisibilityUnknown";

  const facts: string[] = [];
  if (detail) {
    if (detail.host !== "local") facts.push(t(visibilityKey));
    if (detail.localDir) facts.push(t("board.repoLocalDir", { path: detail.localDir }));
    if (detail.language) facts.push(detail.language);
    if (detail.stars !== null) facts.push(t("board.repoStars", { n: detail.stars }));
    if (detail.forks !== null) facts.push(t("board.repoForks", { n: detail.forks }));
    if (detail.openIssues !== null) facts.push(t("board.repoOpenCount", { n: detail.openIssues }));
    if (detail.defaultBranch) facts.push(t("board.repoBranch", { name: detail.defaultBranch }));
    if (dateText(detail.pushedAt)) facts.push(t("board.repoPushed", { when: dateText(detail.pushedAt) as string }));
    if (detail.localIssueCount !== null && detail.localLabelCount !== null) {
      facts.push(t("board.repoLocalCounts", { issues: detail.localIssueCount, labels: detail.localLabelCount }));
    }
  }
  const extras: string[] = [];
  if (detail) {
    if (detail.license) extras.push(t("board.repoLicense", { name: detail.license }));
    if (dateText(detail.createdAt)) extras.push(t("board.repoCreated", { when: dateText(detail.createdAt) as string }));
    if (detail.topics.length) extras.push(t("board.repoTopics", { list: detail.topics.join(", ") }));
  }

  const failure = list.data && !list.data.ok ? list.data : null;
  const issues = list.data?.ok ? list.data.issues : [];
  const fetchedAt = list.data?.ok ? list.data.fetchedAt : null;
  const source = list.data?.ok ? list.data.source : null;
  const failures = list.data?.ok ? list.data.failures : [];
  const repoNameOf = (key: string): string => listedRepos.find((item) => item.key === key)?.name ?? key;
  const readOnlyOf = (key: string): boolean => listedRepos.find((item) => item.key === key)?.readOnly ?? false;
  const activeEntry = activeRepo ? listedRepos.find((item) => item.key === activeRepo) : undefined;
  const defaultEntry = defaultKey ? listedRepos.find((item) => item.key === defaultKey) : undefined;
  const canSetDefault = Boolean(activeEntry?.relDir && defaultKey !== activeRepo);
  const canClearDefault = Boolean(defaultEntry);

  const ageText = (iso: string): string => {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return "";
    const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
    if (minutes < 1) return pt("board.freshNow");
    if (minutes < 60) return pt("board.freshMinutes", { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return pt("board.freshHours", { n: hours });
    return pt("board.freshDays", { n: Math.round(hours / 24) });
  };

  // 视图筛选只选行：readiness 是服务端算好的单一事实，客户端不重新推导阻塞关系。
  const viewRows =
    view === "all"
      ? issues
      : view === "open"
        ? issues.filter((item) => item.state === "OPEN")
        : view === "closed"
          ? issues.filter((item) => item.state === "CLOSED")
          : issues.filter((item) => item.readiness === view);
  // 模块 / 角色这两维同样只是选行，且在搜索之前做：搜索命中数要说的是「这一维筛完还剩几张」。
  const facetRows = filterByFacets(viewRows, { area, role });
  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? facetRows.filter(
        (item) =>
          item.title.toLowerCase().includes(needle) ||
          `#${item.number}`.includes(needle) ||
          String(item.number) === needle ||
          item.labels.some((itemLabel) => labelMatches(itemLabel.name, needle, locale)),
      )
    : facetRows;
  const shownIssues = view === "closed" ? filtered.slice(0, page * PAGE_SIZE) : filtered;
  /**
   * 地图与子票排成可折叠的树。
   *
   * 只在**这一屏**上认父子（见 groupRows 的口径）：分组不改变取数与筛选，
   * 所以筛选把父票筛掉时子票照样占一行，不会有票因为「父票没在这一屏」而消失。
   */
  const boardRows = groupRows(shownIssues, collapsed);
  const groupKeys = parentKeys(shownIssues);
  const allCollapsed = groupKeys.length > 0 && groupKeys.every((key) => collapsed.has(key));
  const toggleGroup = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /** KPI 与列表来自同一窗口、同一 kind；不读服务端那份含 PR 的 counts。 */
  const windowCounts = {
    total: issues.length,
    ready: issues.filter((item) => item.readiness === "ready").length,
    claimed: issues.filter((item) => item.readiness === "claimed").length,
    blocked: issues.filter((item) => item.readiness === "blocked").length,
    closed: issues.filter((item) => item.state === "CLOSED").length,
  };
  /**
   * 项目条与筛选项都从配置来。
   *
   * 项目数 ≤ 1 时整块不出：单项目工作区不该多出一行「只有一个项目的项目条」，
   * 那是把多项目界面强加给老用户。筛选项只从配置的 areas / owner 取——选项是配置、
   * 标签是事实，用标签反推选项会让筛出来的东西取决于这一窗口恰好拉到哪些票。
   */
  const configProjects = projects.data?.ok ? projects.data.projects : [];
  const rows = projectRows(configProjects, issues, listedRepos);
  const facets = availableFacets(configProjects);
  const stripVisible = configProjects.length > 1;
  const uncovered = stripVisible
    ? listedRepos
        .filter((entry) => !rows.some((row) => row.repoKey === entry.key))
        .map((entry) => ({ key: entry.key, name: entry.name }))
    : [];
  const hasLocalMore = view === "closed" && shownIssues.length < filtered.length;
  const freshness = fetchedAt ? freshnessLevel(Date.now() - Date.parse(fetchedAt)) : "fresh";
  const isBound = (repoKey: string, number: number): boolean =>
    current?.repoKey === repoKey && current.number === number;

  const statusText = [
    fetchedAt ? pt("board.freshness", { age: ageText(fetchedAt) }) : "",
    list.data?.ok
      ? pt("board.kpi.window", { shown: windowCounts.total, total: list.data.totalCount })
      : "",
    rateLimit ? t("board.rateLimit", { remaining: rateLimit.remaining, limit: rateLimit.limit }) : "",
    source === "rest" ? t("board.restNotice") : "",
    source === "local" ? t("board.localNotice") : "",
    pt(refreshReasonKey(refresh.decision.reason)),
  ]
    .filter(Boolean)
    .join(" · ");

  const kpis = list.data?.ok
    ? [
        { key: "ready", label: pt("board.kpi.ready"), value: windowCounts.ready, accent: true },
        { key: "claimed", label: pt("board.kpi.claimed"), value: windowCounts.claimed, accent: false },
        { key: "blocked", label: pt("board.kpi.blocked"), value: windowCounts.blocked, accent: false },
        { key: "closed", label: pt("board.kpi.closed"), value: windowCounts.closed, accent: false },
      ]
    : [];

  return (
    <View style={styles.screen}>
      <View style={styles.repoBlock}>
        <View style={styles.repoTop}>
          <Text style={styles.repoLabel}>{t("board.repoLabel")}</Text>
          {host ? (
            <View style={styles.hostTag}>
              <Text style={styles.hostText}>{t(hostKey)}</Text>
            </View>
          ) : null}
          {repoCount > 1 ? (
            <View style={styles.hostTag}>
              <Text style={styles.hostText}>{t("board.repoCount", { n: repoCount })}</Text>
            </View>
          ) : null}
          {repoWebUrl ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t("board.openRepo")}
              onPress={() => void openExternalUrl(repoWebUrl).catch(() => toast.error(t("board.openRepoFailed")))}
            >
              <Text style={styles.openRepo}>{t("board.openRepo")} ↗</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.repoRow}>
          <Text style={styles.repoName} numberOfLines={1}>
            {header ?? t("board.unbound")}
          </Text>
          {scopedSummary?.readOnly ? (
            <Text style={[styles.label, { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 }]}>
              {t("board.repoReadOnly")}
            </Text>
          ) : null}
          {list.data?.ok ? (
            <Text style={styles.meta}>
              {t("board.count", { shown: list.data.issues.length, total: list.data.totalCount })}
            </Text>
          ) : null}
          <View style={styles.spacer} />
          <PixelButton
            skin={skin}
            label={list.isFetching ? t("common.refreshing") : t("common.refresh")}
            accessibilityLabel={t("board.refreshHint")}
            onPress={() => {
              void targets.refetch();
              refresh.refreshNow();
              void info.refetch();
            }}
          />
        </View>

        {stripVisible ? (
          // 有项目清单时用项目条代替纯仓库选择器：同一件事（筛到一个仓库），项目条多给了
          // 角色与负载，两套控件并排只会让人多点一次。
          <ProjectStrip
            skin={skin}
            rows={rows}
            activeRepo={activeRepo}
            onPick={(repoKey) => setRepoFilter(repoKey)}
            uncovered={uncovered}
          />
        ) : repoCount > 1 ? (
          <View style={styles.repoPicker}>
            <View style={styles.pickerRow}>
              <PixelButton
                skin={skin}
                mini
                variant="tab"
                label={t("board.repoAll")}
                active={activeRepo === null}
                onPress={() => setRepoFilter(null)}
              />
              {listedRepos.map((item) => (
                <PixelButton
                  key={item.key}
                  skin={skin}
                  mini
                  variant="tab"
                  label={item.name}
                  accessibilityLabel={item.key}
                  active={activeRepo === item.key}
                  onPress={() => setRepoFilter(item.key)}
                />
              ))}
            </View>
          </View>
        ) : null}
        {truncated ? <Text style={styles.meta}>{t("board.repoScanTruncated")}</Text> : null}
        {scopedSummary && scopedSummary.host !== "local" ? (
          <Text style={styles.meta}>{t("board.codeDir", { dir: scopedSummary.dir })}</Text>
        ) : null}
        {canSetDefault || canClearDefault || (defaultKey !== null && defaultKey === activeRepo) ? (
          <View style={styles.pickerRow}>
            {defaultKey !== null && defaultKey === activeRepo ? (
              <Text style={styles.meta}>
                {t("board.repoDefaultSet", { dir: defaultEntry?.relDir ?? defaultKey })}
              </Text>
            ) : null}
            {canSetDefault ? (
              <PixelButton
                skin={skin}
                mini
                variant="ghost"
                label={t("board.repoSetDefault")}
                disabled={pickRepo.isPending}
                onPress={() => {
                  if (activeEntry?.relDir) pickRepo.mutate(activeEntry.relDir);
                }}
              />
            ) : null}
            {canClearDefault ? (
              <PixelButton
                skin={skin}
                mini
                variant="ghost"
                label={t("board.repoUseRoot")}
                disabled={pickRepo.isPending}
                onPress={() => pickRepo.mutate(null)}
              />
            ) : null}
          </View>
        ) : null}
        {detail ? (
          <View style={styles.repoFacts}>
            {detail.description ? (
              <Text style={styles.repoDescription} numberOfLines={3}>
                {detail.description}
              </Text>
            ) : null}
            {facts.length ? <Text style={styles.meta}>{facts.join(" · ")}</Text> : null}
            {extras.length ? <Text style={styles.meta}>{extras.join(" · ")}</Text> : null}
          </View>
        ) : info.data && !info.data.ok && scopedKey !== null ? (
          <Text style={styles.meta}>
            {t("board.repoInfoFailed")} · {info.data.detail}
          </Text>
        ) : null}
      </View>

      {!refresh.decision.allowWrite ? (
        <PixelBanner skin={skin} tone="warning">
          <Text style={styles.hint}>{pt("refresh.writePaused")}</Text>
        </PixelBanner>
      ) : null}

      {failures.length ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>{t("board.repoFailures")}</Text>
          {failures.map((item) => (
            <Text key={item.repoKey} style={styles.hint}>
              {item.repoKey} · {staticText(t, FAILURE_KEYS[item.reason] ?? "failure.read")} — {item.detail}
            </Text>
          ))}
        </PixelBanner>
      ) : null}

      {kpis.length ? (
        <View style={styles.kpiRow}>
          {kpis.map((kpi) => (
            <View key={kpi.key} style={styles.kpi}>
              <Text style={styles.kpiLabel}>{kpi.label}</Text>
              <Text style={[styles.kpiNum, kpi.accent ? styles.kpiNumAccent : null]}>{kpi.value}</Text>
            </View>
          ))}
          <Text style={styles.kpiNote}>{pt("board.kpi.windowHint")}</Text>
        </View>
      ) : null}

      <View style={styles.tabbar}>
        {VIEWS.map((item) => {
          const n = !list.data?.ok
            ? null
            : item.key === "ready"
              ? windowCounts.ready
              : item.key === "blocked"
                ? windowCounts.blocked
                : item.key === "closed"
                  ? windowCounts.closed
                  : null;
          return (
            <PixelButton
              key={item.key}
              skin={skin}
              variant="tab"
              label={n === null ? staticText(t, item.label) : `${staticText(t, item.label)} ${n}`}
              active={view === item.key}
              onPress={() => setView(item.key)}
            />
          );
        })}
        <View style={styles.divider} />
        <PixelButton skin={skin} mini variant="tab" label={pt("nav.labels")} onPress={onOpenLabels} />
      </View>

      <View style={styles.toolbar}>
        <Text style={styles.sectionLabel}>{t("board.sortLabel")}</Text>
        {SORTS.map((item) => (
          <PixelButton
            key={item.key}
            skin={skin}
            variant="tab"
            label={staticText(t, item.label)}
            active={sort === item.key}
            onPress={() => setSort(item.key)}
          />
        ))}
      </View>

      <BoardFilters
        skin={skin}
        search={search}
        onSearch={setSearch}
        label={label}
        labelDraft={labelDraft}
        onLabelDraftChange={setLabelDraft}
        onApplyLabel={() => setLabel(labelDraft.trim())}
        onClearLabel={() => {
          setLabel("");
          setLabelDraft("");
        }}
        areas={facets.areas}
        area={area}
        onArea={setArea}
        roles={facets.roles}
        role={role}
        onRole={setRole}
      />
      {search ? (
        <Text style={styles.meta}>
          {pt("board.searchCount", { n: filtered.length })} · {pt("board.localQuery")}
        </Text>
      ) : null}

      {failure ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>{staticText(t, FAILURE_KEYS[failure.reason] ?? "failure.read")}</Text>
          <Text style={styles.hint}>{failure.detail}</Text>
          {failure.reason === "gh-unauth" || failure.reason === "gh-missing" ? (
            <>
              <Text style={styles.hint}>
                {failure.reason === "gh-missing" ? t("auth.ghMissingHint") : t("auth.inlineHint")}
              </Text>
              <View style={styles.actions}>
                <PixelButton skin={skin} label={t("auth.title")} active onPress={() => setAuthOpen(true)} />
              </View>
            </>
          ) : null}
          {activeRepo !== null ? (
            <View style={styles.actions}>
              <PixelButton skin={skin} label={t("board.repoAll")} onPress={() => setRepoFilter(null)} />
            </View>
          ) : null}
        </PixelBanner>
      ) : null}
      {list.error ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>{list.error.message}</Text>
          <PixelButton skin={skin} label={pt("common.retry")} onPress={refresh.refreshNow} />
        </PixelBanner>
      ) : null}

      {statusText ? (
        <PixelStatusLine skin={skin}>
          <Text style={styles.freshness}>{statusText}</Text>
        </PixelStatusLine>
      ) : null}
      {freshness !== "fresh" ? (
        <Text style={styles.hint}>
          {freshness === "red" ? pt("board.staleRed") : pt("board.staleYellow")}
        </Text>
      ) : null}

      {groupKeys.length ? (
        <View style={styles.groupBar}>
          <Text style={styles.hint}>{pt("board.groups", { n: groupKeys.length })}</Text>
          <View style={styles.spacer} />
          <PixelButton
            skin={skin}
            mini
            variant="ghost"
            label={allCollapsed ? pt("board.expandAll") : pt("board.collapseAll")}
            onPress={() => setCollapsed(allCollapsed ? new Set() : new Set(groupKeys))}
          />
        </View>
      ) : null}

      <FlatList
        data={boardRows}
        keyExtractor={(row) => rowKeyOf(row.item)}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        onEndReachedThreshold={0.2}
        onEndReached={() => {
          if (hasLocalMore) setPage((prev) => prev + 1);
        }}
        ListEmptyComponent={
          <Text style={styles.onChecker}>
            {list.isPending
              ? pt("common.loading")
              : failure
                ? pt("board.emptyAfterFailure")
                : search
                  ? pt("board.emptySearch")
                  : pt("board.empty")}
          </Text>
        }
        ListFooterComponent={
          <View style={{ gap: 6 }}>
            {view === "closed" ? (
              <Text style={styles.onChecker}>
                {pt("board.paging", { shown: shownIssues.length, loaded: filtered.length })}
              </Text>
            ) : null}
            {hasLocalMore ? (
              <PixelButton
                skin={skin}
                label={pt("board.loadMore")}
                onPress={() => setPage((prev) => prev + 1)}
              />
            ) : null}
            {list.data?.ok && list.data.hasMore ? (
              <>
                <Text style={styles.onChecker}>{pt("board.hasMore", { n: list.data.issues.length })}</Text>
                {repoWebUrl ? (
                  <PixelButton
                    skin={skin}
                    variant="ghost"
                    label={pt("board.openWeb")}
                    onPress={() =>
                      void openExternalUrl(`${repoWebUrl}/issues`).catch(() => toast.error(t("board.openRepoFailed")))
                    }
                  />
                ) : null}
              </>
            ) : null}
          </View>
        }
        renderItem={({ item: boardRow }) => {
          const item = boardRow.item;
          // 跨仓库引用读不到时，票仍算阻塞；这里把原因挂在行下面，别让人以为它莫名其妙不能接。
          const stale = staleBlockerLabels(item);
          const body = (
            <>
              <TicketRow
                skin={skin}
                item={item}
                showRepo={activeRepo === null && repoCount > 1}
                repoName={repoNameOf(item.repoKey)}
                readOnly={readOnlyOf(item.repoKey)}
                bound={isBound(item.repoKey, item.number)}
                onOpen={(ref) => onOpenIssue(ref)}
                onOpenMap={(ref) => onOpenMap(ref)}
              />
              {stale.length ? (
                <Text style={styles.onChecker}>{t("deps.staleBlocker", { refs: stale.join("、") })}</Text>
              ) : null}
            </>
          );

          // 子票：靠一道竖线挂在父票下面，比自己再缩进一层的卡片窄一点，读起来才像从属关系。
          // 层数不设死（需求 → 地图 → 票）：每深一层多让一档，竖线仍在最外面。
          if (boardRow.depth > 0) {
            return (
              <View style={[styles.childWrap, { marginLeft: 14 + (boardRow.depth - 1) * 12 }]}>{body}</View>
            );
          }

          // 折叠是父行的动作，不是整行的动作：整行点击仍然是打开这张票，
          // 所以开关不放进卡片里，单独占左边这 14px。
          const toggle =
            boardRow.childCount && boardRow.expanded !== undefined ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: boardRow.expanded }}
                accessibilityLabel={
                  boardRow.expanded
                    ? pt("board.collapseChildren", { n: boardRow.childCount })
                    : pt("board.expandChildren", { n: boardRow.childCount })
                }
                onPress={() => toggleGroup(rowKeyOf(item))}
                style={styles.groupToggle}
              >
                <Text style={[styles.groupChevron, boardRow.expanded ? styles.groupChevronOpen : null]}>
                  {boardRow.expanded ? "▾" : "▸"}
                </Text>
                <Text style={styles.groupCount}>{boardRow.childCount}</Text>
              </Pressable>
            ) : (
              // 没有子票的票也留这 14px：不留的话，一列卡片会被地图行顶歪。
              <View style={styles.rowGutter} />
            );

          return (
            <View style={styles.rowWrap}>
              {toggle}
              <View style={styles.rowMain}>{body}</View>
            </View>
          );
        }}
      />


      <GithubAuthModal theme={theme} open={authOpen} onClose={() => setAuthOpen(false)} />
    </View>
  );
}
