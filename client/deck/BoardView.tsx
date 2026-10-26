import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesListRpc } from "../../shared/issues";
import { FAILURE_TEXT, readableText } from "./format";
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
            {header ?? "未关联仓库"}
          </Text>
        </View>
        <Text style={styles.chipText}>
          {list.data?.ok ? `${list.data.issues.length} / ${list.data.totalCount} 张` : ""}
        </Text>
        <View style={styles.spacer} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建票"
          style={styles.action}
          onPress={() => setCreating(true)}
        >
          <Text style={styles.actionText}>新建</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={includeClosed ? "只看未关闭" : "显示已关闭"}
          style={[styles.action, includeClosed ? styles.actionActive : null]}
          onPress={() => setIncludeClosed((value) => !value)}
        >
          <Text style={styles.actionText}>{includeClosed ? "含已关闭" : "仅未关闭"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="刷新任务板"
          style={styles.action}
          onPress={() => void list.refetch()}
        >
          <Text style={styles.actionText}>{list.isFetching ? "刷新中…" : "刷新"}</Text>
        </Pressable>
      </View>

      {failure ? (
        <View style={styles.row}>
          <Text style={styles.error}>{FAILURE_TEXT[failure.reason] ?? "读取失败"}</Text>
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
              ? "读取中…"
              : failure
                ? "修好后点刷新即可，不需要重开面板"
                : "这个仓库还没有票，点「新建」写一张。"}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`查看票 #${item.number} ${item.title}`}
            style={styles.row}
            onPress={() => setOpenNumber(item.number)}
          >
            <View style={styles.rowHead}>
              <Text style={styles.number}>#{item.number}</Text>
              {current === item.number ? (
                <Text style={[styles.label, { backgroundColor: theme.colors.accent, color: "#000000" }]}>当前</Text>
              ) : null}
              {item.isMap ? (
                <Text style={[styles.label, { backgroundColor: theme.colors.surface2, color: theme.colors.foreground }]}>地图</Text>
              ) : null}
              {item.state === "CLOSED" ? (
                <Text style={[styles.label, { backgroundColor: theme.colors.statusSuccess, color: "#000000" }]}>已关闭</Text>
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
            {item.assignees.length ? <Text style={styles.meta}>指派给 {item.assignees.join("、")}</Text> : null}
          </Pressable>
        )}
      />

      {openNumber !== null ? (
        <IssueModal
          theme={theme}
          workspaceDir={workspaceDir}
          number={openNumber}
          isCurrent={current === openNumber}
          onBind={() => onBind(current === openNumber ? undefined : openNumber)}
          onClose={() => setOpenNumber(null)}
        />
      ) : null}

      <NewIssueModal theme={theme} workspaceDir={workspaceDir} open={creating} onClose={() => setCreating(false)} />
    </View>
  );
}
