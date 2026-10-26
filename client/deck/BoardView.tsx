import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Markdown, Modal } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesDetailRpc, issuesListRpc } from "../../shared/issues";

/**
 * 标签配色直接取仓库里配置的十六进制值，再用亮度决定字色。
 * 不统一成主题色：标签色本身是用户表达（谁负责、处于什么环节），抹平它等于丢掉信息。
 */
function readableText(hex: string): "#000000" | "#ffffff" {
  const raw = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return "#000000";
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#000000" : "#ffffff";
}

const FAILURE_TEXT: Record<string, string> = {
  "no-repo": "这个工作区没有可识别的 GitHub 远端",
  "unsupported-host": "当前远端不是 GitHub",
  "gh-missing": "没有找到 gh 命令",
  "gh-failed": "读取 GitHub 失败",
};

/**
 * 只读任务板。
 *
 * P2 只做读：票面列表 + 详情。写操作（评论、改标签、绑定）在 P3 接入，
 * 所以这里没有任何按钮会改变远端状态——打开这个面板是安全的。
 */
export function BoardView({
  theme,
  layout,
  workspaceDir,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
}) {
  const [includeClosed, setIncludeClosed] = useState(false);
  const [openNumber, setOpenNumber] = useState<number | null>(null);

  const listIssues = useRpc(issuesListRpc);
  const readIssue = useRpc(issuesDetailRpc);

  const list = useQuery({
    queryKey: ["deck", "issues", workspaceDir, includeClosed],
    queryFn: () => listIssues({ workspaceDir, includeClosed }),
    staleTime: 15_000,
  });

  const detail = useQuery({
    queryKey: ["deck", "issue", workspaceDir, openNumber],
    queryFn: () => readIssue({ workspaceDir, number: openNumber ?? 0 }),
    enabled: openNumber !== null,
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
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
      modalBody: { gap: 10 },
      comment: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: 8,
        gap: 3,
      },
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
                : "这个仓库还没有票。P3 起可以在面板里直接新建。"}
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

      <Modal
        title={openNumber ? `#${openNumber}` : "票面"}
        open={openNumber !== null}
        onOpenChange={(open) => {
          if (!open) setOpenNumber(null);
        }}
      >
        <Modal.Content>
          <View style={styles.modalBody}>
            {detail.error ? <Text style={styles.error}>{detail.error.message}</Text> : null}
            {detail.data && !detail.data.ok ? (
              <>
                <Text style={styles.error}>{FAILURE_TEXT[detail.data.reason] ?? "读取失败"}</Text>
                <Text style={styles.hint}>{detail.data.detail}</Text>
              </>
            ) : null}
            {detail.data?.ok ? (
              <>
                <Text style={styles.title}>{detail.data.issue.title}</Text>
                <Text style={styles.hint}>
                  {detail.data.issue.state === "OPEN" ? "未关闭" : "已关闭"} · 更新于 {detail.data.issue.updatedAt.slice(0, 10)}
                </Text>
                <Markdown>{detail.data.issue.body || "_这张票没有正文。_"}</Markdown>
                {detail.data.comments.map((comment, index) => (
                  <View key={`${comment.createdAt}-${index}`} style={styles.comment}>
                    <Text style={styles.meta}>
                      {comment.author} · {comment.createdAt.slice(0, 10)}
                    </Text>
                    <Markdown>{comment.body}</Markdown>
                  </View>
                ))}
              </>
            ) : detail.isPending ? (
              <Text style={styles.hint}>读取中…</Text>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
