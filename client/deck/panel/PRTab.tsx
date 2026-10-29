import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ListView } from "../../../shared/issues";
import { issuesListRpc } from "../../../shared/issues";
import { repoTargetsRpc } from "../../../shared/repo";
import { readableText } from "../format";
import { FAILURE_KEYS, staticText, useDeckText } from "../i18n";
import { PixelBanner, PixelButton, PixelCard, PixelNum, PixelStatusLine, usePixel } from "../pixel";
import { refreshReasonKey, usePanelText } from "./panelText";
import { usePanelRefresh } from "./usePanelRefresh";

/** PR 页签自己的筛选：合并态单独一档，`view=merged` 由服务端判定。 */
type PrView = Extract<ListView, "all" | "open" | "closed" | "merged">;

const PR_VIEWS: { key: PrView; textKey: "pr.all" | "pr.open" | "pr.closed" | "pr.merged" }[] = [
  { key: "all", textKey: "pr.all" },
  { key: "open", textKey: "pr.open" },
  { key: "closed", textKey: "pr.closed" },
  { key: "merged", textKey: "pr.merged" },
];

/**
 * 拉取请求页签。
 *
 * 与任务页签共用 `issuesListRpc`，但固定 `kind=pull-request`：
 * GitHub 上票和 PR 共用编号空间，靠列表里混着显示再让人自己分辨，迟早点错写操作。
 * PR 在本面板里只读，点开只是看正文与评论，不给合并/关闭按钮。
 */
export function PRTab({
  theme,
  layout,
  workspaceDir,
  onOpenPullRequest,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
  onOpenPullRequest(ref: { repoKey: string; number: number }): void;
}) {
  const { t } = usePanelText();
  const text = useDeckText();
  const skin = usePixel(theme);
  const [view, setView] = useState<PrView>("open");
  const [sort, setSort] = useState<"updated" | "number">("updated");
  const [repoKey, setRepoKey] = useState<string | null>(null);

  const listPullRequests = useRpc(issuesListRpc);
  const readTargets = useRpc(repoTargetsRpc);

  const targets = useQuery({
    queryKey: ["deck", "repo-targets", workspaceDir],
    queryFn: () => readTargets({ workspaceDir }),
    staleTime: 30_000,
  });

  const list = useQuery({
    queryKey: ["deck", "pull-requests", workspaceDir, repoKey ?? "all", view, sort],
    enabled: !targets.isPending,
    queryFn: () =>
      listPullRequests({
        workspaceDir,
        kind: "pull-request",
        view,
        sort,
        repoKey: repoKey ?? undefined,
        limit: 100,
      }),
    staleTime: 15_000,
  });

  const rateLimit = list.data?.ok ? list.data.rateLimit : null;
  const remaining = rateLimit && rateLimit.limit > 0 ? rateLimit.remaining / rateLimit.limit : null;
  const refresh = usePanelRefresh({ query: list, remaining });
  const rows = list.data?.ok ? list.data.issues : [];
  const repos = targets.data?.ok ? targets.data.repos : [];
  const failure = list.data && !list.data.ok ? list.data : null;
  const repoName = (key: string): string => repos.find((item) => item.key === key)?.name ?? key;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        flexWrap: "wrap" as const,
        borderBottomWidth: 1,
        borderBottomColor: skin.colors.line,
        paddingBottom: 2,
      },
      divider: { width: 1, height: 16, backgroundColor: skin.colors.line, marginHorizontal: 4 },
      spacer: { marginLeft: "auto" as const },
      onScreen: skin.hintOnChecker,
      error: skin.error,
      hint: skin.hint,
      item: { marginBottom: 8 },
      body: { padding: 10, gap: 5 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      title: { color: skin.colors.ink, fontSize: 13, fontWeight: "700" as const, lineHeight: 19, flexShrink: 1 },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      labels: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
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
      state: {
        fontSize: 10,
        lineHeight: 16,
        paddingHorizontal: 6,
        borderWidth: 1,
        borderColor: skin.colors.line,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      status: skin.statuslineText,
      dim: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
    }),
    [skin],
  );

  const stateOf = (item: { merged: boolean; state: string }): { label: string; style: object } => {
    if (item.merged) {
      return {
        label: t("pr.stateMerged"),
        style: { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 },
      };
    }
    if (item.state === "OPEN") {
      return { label: t("pr.stateOpen"), style: { backgroundColor: skin.colors.okBg, color: skin.colors.ok } };
    }
    return { label: t("pr.stateClosed"), style: { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 } };
  };

  const statusText = [
    t(refreshReasonKey(refresh.decision.reason)),
    list.data?.ok
      ? t("board.kpi.window", { shown: list.data.issues.length, total: list.data.totalCount })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        {PR_VIEWS.map((item) => (
          <PixelButton
            key={item.key}
            skin={skin}
            variant="tab"
            label={t(item.textKey)}
            active={view === item.key}
            onPress={() => setView(item.key)}
          />
        ))}
        <View style={styles.divider} />
        <PixelButton
          skin={skin}
          variant="tab"
          label={text.t("board.sortUpdated")}
          active={sort === "updated"}
          onPress={() => setSort("updated")}
        />
        <PixelButton
          skin={skin}
          variant="tab"
          label={text.t("board.sortNumber")}
          active={sort === "number"}
          onPress={() => setSort("number")}
        />
        <View style={styles.spacer} />
        <PixelButton
          skin={skin}
          mini
          label={list.isFetching ? t("common.refreshing") : t("common.refresh")}
          onPress={refresh.refreshNow}
        />
      </View>

      {repos.length > 1 ? (
        <View style={styles.bar}>
          <PixelButton
            skin={skin}
            mini
            variant="tab"
            label={t("board.repoAll")}
            active={repoKey === null}
            onPress={() => setRepoKey(null)}
          />
          {repos.map((repo) => (
            <PixelButton
              key={repo.key}
              skin={skin}
              mini
              variant="tab"
              label={repo.name}
              accessibilityLabel={repo.key}
              active={repoKey === repo.key}
              onPress={() => setRepoKey(repo.key)}
            />
          ))}
        </View>
      ) : null}

      {failure ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>
            {staticText(text.t, FAILURE_KEYS[failure.reason] ?? "failure.read")}
          </Text>
          <Text style={styles.hint}>{failure.detail}</Text>
        </PixelBanner>
      ) : null}
      {list.error ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>{list.error.message}</Text>
          <PixelButton skin={skin} label={t("common.retry")} onPress={refresh.refreshNow} />
        </PixelBanner>
      ) : null}

      <PixelStatusLine skin={skin}>
        <Text style={styles.status}>{statusText}</Text>
      </PixelStatusLine>

      <FlatList
        data={rows}
        keyExtractor={(item) => `${item.repoKey}-${item.number}`}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.onScreen}>
            {list.isPending ? t("common.loading") : failure ? t("board.emptyAfterFailure") : t("pr.empty")}
          </Text>
        }
        renderItem={({ item }) => {
          const state = stateOf(item);
          return (
            <View style={styles.item}>
              <PixelCard skin={skin}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`#${item.number} ${item.title}`}
                  style={styles.body}
                  onPress={() => onOpenPullRequest({ repoKey: item.repoKey, number: item.number })}
                >
                  <View style={styles.head}>
                    <PixelNum skin={skin}>#{item.number}</PixelNum>
                    <Text style={[styles.state, state.style]}>{state.label}</Text>
                    {repos.length > 1 && repoKey === null ? (
                      <Text style={[styles.label, { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 }]}>
                        {repoName(item.repoKey)}
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
                          style={[
                            styles.label,
                            { backgroundColor: `#${label.color}`, color: readableText(label.color) },
                          ]}
                        >
                          {label.name}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  <Text style={styles.meta}>
                    {t("pr.updated", { date: item.updatedAt.slice(0, 10) })}
                    {item.assignees.length ? ` · ${item.assignees.join(", ")}` : ""}
                  </Text>
                </Pressable>
              </PixelCard>
            </View>
          );
        }}
      />
      <Text style={styles.dim}>{t("pr.readOnly")}</Text>
    </View>
  );
}
