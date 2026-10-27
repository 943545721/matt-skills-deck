import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { FlatList, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ItemKind, ListView, SortKey } from "../../shared/issues";
import { issuesListRpc } from "../../shared/issues";
import { deckSettings } from "../../shared/settings";
import { readableText } from "./format";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";
import { IssueModal } from "./IssueModal";
import { MapModal } from "./MapModal";
import { NewIssueModal } from "./NewIssueModal";
import { PixelButton, PixelCard, usePixel } from "./pixel";

/**
 * 任务板列表。
 *
 * 只负责「看到哪些票、点开哪一张」，详情与写操作都在各自的弹窗里：
 * 一个文件管一屏，改评论框时不用在列表逻辑里翻。
 *
 * 三种票的状态（可接 / 阻塞 / 已关闭）由服务端算好，界面只做筛选与展示：
 * 同一个判定如果客户端再算一遍，早晚会和 MCP、地图页给出不同答案。
 */
export function BoardView({
  theme,
  layout,
  workspaceDir,
  current,
  onBind,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
  /** 当前票：绑在面板状态里，换工作区就换一张。 */
  current?: number;
  onBind(number: number | undefined): void;
}) {
  const { t } = useDeckText();
  const skin = usePixel(theme);
  const settings = useSettings(deckSettings);

  const [kind, setKind] = useState<ItemKind>("issue");
  const [view, setView] = useState<ListView>("open");
  const [sort, setSort] = useState<SortKey>("updated");
  const [label, setLabel] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  const [openKind, setOpenKind] = useState<ItemKind>("issue");
  const [creating, setCreating] = useState(false);
  /** 地图弹窗：地图票的入口，与票面详情并列，而不是替代它。 */
  const [mapNumber, setMapNumber] = useState<number | null>(null);

  const refreshSeconds = settings.status === "ready" ? settings.values.refreshSeconds : 60;
  const listIssues = useRpc(issuesListRpc);
  const list = useQuery({
    queryKey: ["deck", "issues", workspaceDir, kind, view, sort, label],
    queryFn: () =>
      listIssues({
        workspaceDir,
        includeClosed: view === "all" || view === "closed",
        view,
        kind,
        label: label || undefined,
        sort,
      }),
    staleTime: 15_000,
    refetchInterval: refreshSeconds > 0 ? refreshSeconds * 1000 : false,
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      chip: {
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      chipText: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: skin.mono.fontFamily },
      spacer: { marginLeft: "auto" as const },
      // 一行 = 主卡片 + 可选的地图按钮；间距放在这一层，卡片自己的投影才不会把行距吃掉。
      item: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8, marginBottom: 8 },
      // 主卡片吃掉整行宽度，地图按钮贴右；标题再长也只在卡片里折行。
      itemMain: { flex: 1 },
      rowBody: { padding: 10, gap: 5 },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      number: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: skin.mono.fontFamily },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 },
      labels: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
      label: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      failureBody: { padding: 10, gap: 4 },
      labelInput: {
        width: 130,
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        paddingVertical: 3,
        paddingHorizontal: 6,
        fontSize: 11,
      },
      freshness: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
    }),
    [theme, skin],
  );

  // 失败时也显示仓库名：能读列表失败，说明远端已经解析出来了（RPC 会把它带回来）。
  // 只有远端本身没认出来（no-repo / unsupported-host）才退回「未关联仓库」。
  const repo = list.data?.ok ? list.data.repo : list.data?.repo;
  const header = repo ? (repo.host === "local" ? `${repo.name}（本地）` : `${repo.owner}/${repo.name}`) : null;
  const failure = list.data && !list.data.ok ? list.data : null;
  const issues = list.data?.ok ? list.data.issues : [];
  const counts = list.data?.ok ? list.data.counts : null;
  const fetchedAt = list.data?.ok ? list.data.fetchedAt : null;
  const rateLimit = list.data?.ok ? list.data.rateLimit : null;
  const source = list.data?.ok ? list.data.source : null;

  const ageText = (iso: string): string => {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return "";
    const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
    if (minutes < 1) return t("board.freshNow");
    if (minutes < 60) return t("board.freshMinutes", { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t("board.freshHours", { n: hours });
    return t("board.freshDays", { n: Math.round(hours / 24) });
  };

  const views: { key: ListView; label: string }[] = [
    { key: "all", label: t("board.viewAll") },
    { key: "open", label: t("board.viewOpen") },
    { key: "ready", label: t("board.viewReady") },
    { key: "blocked", label: t("board.viewBlocked") },
    { key: "closed", label: t("board.viewClosed") },
    { key: "merged", label: t("board.viewMerged") },
  ];
  const sorts: { key: SortKey; label: string }[] = [
    { key: "updated", label: t("board.sortUpdated") },
    { key: "created", label: t("board.sortCreated") },
    { key: "number", label: t("board.sortNumber") },
    { key: "title", label: t("board.sortTitle") },
  ];

  const openIssue = (number: number, itemKind: ItemKind) => {
    setOpenKind(itemKind);
    setOpenNumber(number);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.chip}>
          <Text style={styles.chipText} numberOfLines={1}>
            {header ?? t("board.unbound")}
          </Text>
        </View>
        <Text style={styles.chipText}>
          {list.data?.ok
            ? t("board.count", { shown: list.data.issues.length, total: list.data.totalCount })
            : ""}
        </Text>
        <View style={styles.spacer} />
        <PixelButton skin={skin} label={t("board.new")} onPress={() => setCreating(true)} />
        <PixelButton
          skin={skin}
          label={list.isFetching ? t("common.refreshing") : t("common.refresh")}
          accessibilityLabel={t("board.refreshHint")}
          onPress={() => void list.refetch()}
        />
      </View>

      {/* 页签：票与拉取请求共用编号空间，但写操作完全不同，所以分面展示。 */}
      <View style={styles.toolbar}>
        <PixelButton
          skin={skin}
          label={t("board.tabIssues")}
          active={kind === "issue"}
          onPress={() => setKind("issue")}
        />
        <PixelButton
          skin={skin}
          label={t("board.tabPullRequests")}
          active={kind === "pull-request"}
          onPress={() => setKind("pull-request")}
        />
        <View style={styles.spacer} />
        {counts ? (
          <>
            <PixelButton
              skin={skin}
              label={t("board.kpiReady", { n: counts.ready })}
              accessibilityLabel={t("board.kpiHint", { label: t("board.viewReady") })}
              active={view === "ready"}
              onPress={() => setView(view === "ready" ? "open" : "ready")}
            />
            <PixelButton
              skin={skin}
              label={t("board.kpiBlocked", { n: counts.blocked })}
              accessibilityLabel={t("board.kpiHint", { label: t("board.viewBlocked") })}
              active={view === "blocked"}
              onPress={() => setView(view === "blocked" ? "open" : "blocked")}
            />
            <PixelButton
              skin={skin}
              label={t("board.kpiClosed", { n: counts.closed })}
              accessibilityLabel={t("board.kpiHint", { label: t("board.viewClosed") })}
              active={view === "closed"}
              onPress={() => setView(view === "closed" ? "open" : "closed")}
            />
          </>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        {views.map((item) => (
          <PixelButton
            key={item.key}
            skin={skin}
            label={item.label}
            active={view === item.key}
            onPress={() => setView(item.key)}
          />
        ))}
      </View>

      <View style={styles.toolbar}>
        <Text style={styles.chipText}>{t("board.sortLabel")}</Text>
        {sorts.map((item) => (
          <PixelButton
            key={item.key}
            skin={skin}
            label={item.label}
            active={sort === item.key}
            onPress={() => setSort(item.key)}
          />
        ))}
        <View style={styles.spacer} />
        <TextInput
          accessibilityLabel={t("board.labelFilter")}
          style={styles.labelInput}
          value={labelDraft}
          onChangeText={setLabelDraft}
          onSubmitEditing={() => setLabel(labelDraft.trim())}
          placeholder={t("board.labelFilterPlaceholder")}
          autoCapitalize="none"
        />
        <PixelButton skin={skin} label={t("board.apply")} onPress={() => setLabel(labelDraft.trim())} />
        {label ? (
          <PixelButton
            skin={skin}
            label={t("board.clear", { label })}
            onPress={() => {
              setLabel("");
              setLabelDraft("");
            }}
          />
        ) : null}
      </View>

      {failure ? (
        <PixelCard skin={skin} style={styles.failureBody}>
          <Text style={styles.error}>{staticText(t, FAILURE_KEYS[failure.reason] ?? "failure.read")}</Text>
          <Text style={styles.hint}>{failure.detail}</Text>
        </PixelCard>
      ) : null}
      {list.error ? <Text style={styles.error}>{list.error.message}</Text> : null}

      <Text style={styles.freshness}>
        {[
          fetchedAt ? ageText(fetchedAt) : "",
          counts ? t("board.window", { shown: counts.total, total: list.data?.ok ? list.data.totalCount : 0 }) : "",
          rateLimit ? t("board.rateLimit", { remaining: rateLimit.remaining, limit: rateLimit.limit }) : "",
          source === "rest" ? t("board.restNotice") : "",
          source === "local" ? t("board.localNotice") : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>

      <FlatList
        data={issues}
        keyExtractor={(item) => `${item.kind}-${item.number}`}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>
            {list.isPending
              ? t("common.loading")
              : failure
                ? t("board.emptyAfterFailure")
                : kind === "pull-request"
                  ? t("board.emptyPrs")
                  : view === "all" || view === "open"
                    ? t("board.empty")
                    : t("board.emptyView")}
          </Text>
        }
        ListFooterComponent={
          list.data?.ok && list.data.hasMore ? <Text style={styles.hint}>{t("board.hasMore")}</Text> : null
        }
        renderItem={({ item }) => (
          <View style={styles.item}>
            <View style={styles.itemMain}>
              <PixelCard skin={skin}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`#${item.number} ${item.title}`}
                  style={styles.rowBody}
                  onPress={() => openIssue(item.number, item.kind)}
                >
                  <View style={styles.rowHead}>
                    <Text style={styles.number}>#{item.number}</Text>
                    {item.kind === "pull-request" ? (
                      <Text style={[styles.label, { backgroundColor: "#8250df", color: "#ffffff" }]}>
                        {item.merged ? t("board.merged") : t("board.pr")}
                      </Text>
                    ) : null}
                    {current === item.number && item.kind === "issue" ? (
                      <Text style={[styles.label, { backgroundColor: theme.colors.accent, color: "#000000" }]}>
                        {t("board.current")}
                      </Text>
                    ) : null}
                    {item.state === "CLOSED" && !item.merged ? (
                      <Text style={[styles.label, { backgroundColor: theme.colors.statusSuccess, color: "#000000" }]}>
                        {t("board.closed")}
                      </Text>
                    ) : null}
                    {item.readiness === "blocked" ? (
                      <Text style={[styles.label, { backgroundColor: theme.colors.statusDanger, color: "#ffffff" }]}>
                        {t("board.blockedBadge")}
                      </Text>
                    ) : null}
                    {item.readiness === "claimed" ? (
                      <Text style={[styles.label, { backgroundColor: theme.colors.statusWarning, color: "#000000" }]}>
                        {t("board.claimedBadge")}
                      </Text>
                    ) : null}
                    <Text style={styles.title} numberOfLines={2}>
                      {item.title}
                    </Text>
                  </View>
                  {item.labels.length ? (
                    <View style={styles.labels}>
                      {item.labels.map((label) => (
                        <Text
                          key={label.name}
                          style={[styles.label, { backgroundColor: `#${label.color}`, color: readableText(label.color) }]}
                        >
                          {label.name}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  {item.assignees.length ? (
                    <Text style={styles.meta}>{t("board.assignees", { names: item.assignees.join(", ") })}</Text>
                  ) : null}
                  {item.blockedBy.length ? (
                    <Text style={styles.meta}>
                      {t("board.blockedBy", {
                        list: item.blockedBy.map((blocker) => `#${blocker.number}`).join("、"),
                      })}
                    </Text>
                  ) : null}
                </Pressable>
              </PixelCard>
            </View>
            {item.isMap && item.kind === "issue" ? (
              <PixelButton skin={skin} label={t("map.open")} onPress={() => setMapNumber(item.number)} />
            ) : null}
          </View>
        )}
      />

      {openNumber !== null ? (
        <IssueModal
          theme={theme}
          workspaceDir={workspaceDir}
          number={openNumber}
          kind={openKind}
          isCurrent={openKind === "issue" && current === openNumber}
          onBind={() => onBind(current === openNumber ? undefined : openNumber)}
          onOpenRelated={(number) => openIssue(number, "issue")}
          onClose={() => setOpenNumber(null)}
        />
      ) : null}

      {mapNumber !== null ? (
        <MapModal
          theme={theme}
          workspaceDir={workspaceDir}
          number={mapNumber}
          open
          onOpenIssue={(number) => {
            setMapNumber(null);
            openIssue(number, "issue");
          }}
          onClose={() => setMapNumber(null)}
        />
      ) : null}

      <NewIssueModal
        theme={theme}
        workspaceDir={workspaceDir}
        open={creating}
        onClose={() => setCreating(false)}
      />
    </View>
  );
}
