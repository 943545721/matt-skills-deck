import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesListRpc } from "../../shared/issues";
import { failureText, readableText } from "./format";
import type { Lang } from "./i18n";
import { t } from "./i18n";
import { IssueModal } from "./IssueModal";
import { NewIssueModal } from "./NewIssueModal";

/**
 * 任务板列表。
 *
 * 只负责「看到哪些票、点开哪一张」，详情与写操作都在各自的弹窗里：
 * 一个文件管一屏，改评论框时不用在列表逻辑里翻。
 */
export function BoardView({
  theme,
  layout,
  lang,
  workspaceDir,
  current,
  onBind,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  lang: Lang;
  workspaceDir: string;
  /** 当前票：绑在面板状态里，换工作区就换一张。 */
  current?: number;
  onBind(number: number | undefined): void;
}) {
  const [includeClosed, setIncludeClosed] = useState(false);
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const listIssues = useRpc(issuesListRpc);
  const list = useQuery({
    queryKey: ["deck", "issues", workspaceDir, includeClosed],
    queryFn: () => listIssues({ workspaceDir, includeClosed }),
    staleTime: 15_000,
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      chip: {
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      chipText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      spacer: { marginLeft: "auto" as const },
      action: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      actionActive: { borderColor: theme.colors.accent },
      row: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
        marginBottom: 8,
        gap: 5,
      },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      number: { color: theme.colors.foregroundMuted, fontSize: 11 },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 },
      labels: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
      label: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, overflow: "hidden" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme],
  );

  const header = list.data?.ok ? `${list.data.repo.owner}/${list.data.repo.name}` : null;
  const failure = list.data && !list.data.ok ? list.data : null;
  const issues = list.data?.ok ? list.data.issues : [];

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.chip}>
          <Text style={styles.chipText} numberOfLines={1}>
            {header ?? t(lang, "board.unbound")}
          </Text>
        </View>
        <Text style={styles.chipText}>
          {list.data?.ok
            ? t(lang, "board.count", { shown: list.data.issues.length, total: list.data.totalCount })
            : ""}
        </Text>
        <View style={styles.spacer} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(lang, "board.new")}
          style={styles.action}
          onPress={() => setCreating(true)}
        >
          <Text style={styles.actionText}>{t(lang, "board.new")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={includeClosed ? t(lang, "board.onlyOpenHint") : t(lang, "board.withClosedHint")}
          style={[styles.action, includeClosed ? styles.actionActive : null]}
          onPress={() => setIncludeClosed((value) => !value)}
        >
          <Text style={styles.actionText}>
            {includeClosed ? t(lang, "board.withClosed") : t(lang, "board.onlyOpen")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(lang, "board.refreshHint")}
          style={styles.action}
          onPress={() => void list.refetch()}
        >
          <Text style={styles.actionText}>
            {list.isFetching ? t(lang, "common.refreshing") : t(lang, "common.refresh")}
          </Text>
        </Pressable>
      </View>

      {failure ? (
        <View style={styles.row}>
          <Text style={styles.error}>{failureText(lang, failure.reason)}</Text>
          <Text style={styles.hint}>{failure.detail}</Text>
        </View>
      ) : null}
      {list.error ? <Text style={styles.error}>{list.error.message}</Text> : null}

      <FlatList
        data={issues}
        keyExtractor={(item) => String(item.number)}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>
            {list.isPending
              ? t(lang, "common.loading")
              : failure
                ? t(lang, "board.emptyAfterFailure")
                : t(lang, "board.empty")}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`#${item.number} ${item.title}`}
            style={styles.row}
            onPress={() => setOpenNumber(item.number)}
          >
            <View style={styles.rowHead}>
              <Text style={styles.number}>#{item.number}</Text>
              {current === item.number ? (
                <Text style={[styles.label, { backgroundColor: theme.colors.accent, color: "#000000" }]}>
                  {t(lang, "board.current")}
                </Text>
              ) : null}
              {item.isMap ? (
                <Text style={[styles.label, { backgroundColor: theme.colors.surface2, color: theme.colors.foreground }]}>
                  {t(lang, "board.map")}
                </Text>
              ) : null}
              {item.state === "CLOSED" ? (
                <Text style={[styles.label, { backgroundColor: theme.colors.statusSuccess, color: "#000000" }]}>
                  {t(lang, "board.closed")}
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
              <Text style={styles.meta}>{t(lang, "board.assignees", { names: item.assignees.join(", ") })}</Text>
            ) : null}
          </Pressable>
        )}
      />

      {openNumber !== null ? (
        <IssueModal
          theme={theme}
          lang={lang}
          workspaceDir={workspaceDir}
          number={openNumber}
          isCurrent={current === openNumber}
          onBind={() => onBind(current === openNumber ? undefined : openNumber)}
          onClose={() => setOpenNumber(null)}
        />
      ) : null}

      <NewIssueModal
        theme={theme}
        lang={lang}
        workspaceDir={workspaceDir}
        open={creating}
        onClose={() => setCreating(false)}
      />
    </View>
  );
}
