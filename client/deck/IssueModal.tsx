import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesCommentRpc, issuesDetailRpc, issuesSetLabelsRpc } from "../../shared/issues";
import { FAILURE_TEXT, promptForIssue, readableText } from "./format";

/**
 * 票面详情。
 *
 * 三个动作都在这里：评论、改标签、复制提示词。前两个会真的改远端，所以按钮上的字要写清
 * 「写到哪」——面板不大，含糊的按钮很容易让人以为只是本地标注。
 */
export function IssueModal({
  theme,
  workspaceDir,
  number,
  isCurrent,
  onBind,
  onClose,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  number: number;
  isCurrent: boolean;
  onBind(): void;
  onClose(): void;
}) {
  const [comment, setComment] = useState("");
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();

  const readIssue = useRpc(issuesDetailRpc);
  const writeComment = useRpc(issuesCommentRpc);
  const setLabels = useRpc(issuesSetLabelsRpc);

  const detail = useQuery({
    queryKey: ["deck", "issue", workspaceDir, number],
    queryFn: () => readIssue({ workspaceDir, number }),
  });

  /** 写成功后就地刷新：详情与列表都会因为一次评论/改标签而变化，两边都要重取。 */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["deck", "issue", workspaceDir, number] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
  };

  const commentMutation = useMutation({
    mutationFn: () => writeComment({ workspaceDir, number, body: comment.trim() }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${FAILURE_TEXT[result.reason] ?? "评论失败"}：${result.detail}`, { variant: "error" });
        return;
      }
      setComment("");
      toast.show("评论已发到 GitHub", { variant: "success" });
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const labelMutation = useMutation({
    mutationFn: (labels: string[]) => setLabels({ workspaceDir, number, labels }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${FAILURE_TEXT[result.reason] ?? "改标签失败"}：${result.detail}`, { variant: "error" });
        return;
      }
      setLabelDraft(null);
      toast.show(`标签已改为 ${result.labels.map((label) => label.name).join("、") || "空"}`, { variant: "success" });
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const issue = detail.data?.ok ? detail.data.issue : null;

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      labels: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
      label: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, overflow: "hidden" as const },
      comment: { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8, gap: 3 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      action: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionActive: { borderColor: theme.colors.accent },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
        color: theme.colors.foreground,
        padding: 8,
        fontSize: 12,
        minHeight: 64,
      },
    }),
    [theme],
  );

  return (
    <Modal title={`#${number}`} open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content>
        <View style={styles.body}>
          {detail.error ? <Text style={styles.error}>{detail.error.message}</Text> : null}
          {detail.data && !detail.data.ok ? (
            <>
              <Text style={styles.error}>{FAILURE_TEXT[detail.data.reason] ?? "读取失败"}</Text>
              <Text style={styles.hint}>{detail.data.detail}</Text>
            </>
          ) : null}
          {detail.isPending ? <Text style={styles.hint}>读取中…</Text> : null}

          {issue ? (
            <>
              <Text style={styles.title}>{issue.title}</Text>
              <Text style={styles.meta}>
                {issue.state === "OPEN" ? "未关闭" : "已关闭"} · 更新于 {issue.updatedAt.slice(0, 10)}
                {issue.assignees.length ? ` · 指派给 ${issue.assignees.join("、")}` : ""}
              </Text>
              {issue.labels.length ? (
                <View style={styles.labels}>
                  {issue.labels.map((label) => (
                    <Text
                      key={label.name}
                      style={[styles.label, { backgroundColor: `#${label.color}`, color: readableText(label.color) }]}
                    >
                      {label.name}
                    </Text>
                  ))}
                </View>
              ) : null}

              <Markdown>{issue.body || "_这张票没有正文。_"}</Markdown>

              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`复制票 #${number} 的提示词`}
                  style={styles.action}
                  onPress={() => {
                    void copyText(promptForIssue(issue))
                      .then(() => toast.show("提示词已复制，粘到 Agent 输入框即可", { variant: "success" }))
                      .catch(() => toast.error("复制失败：这个客户端不支持剪贴板"));
                  }}
                >
                  <Text style={styles.actionText}>复制提示词</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={isCurrent ? `取消当前票 #${number}` : `把票 #${number} 设为当前票`}
                  style={[styles.action, isCurrent ? styles.actionActive : null]}
                  onPress={onBind}
                >
                  <Text style={styles.actionText}>{isCurrent ? "✓ 当前票" : "设为当前票"}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`编辑票 #${number} 的标签`}
                  style={styles.action}
                  onPress={() => setLabelDraft(issue.labels.map((label) => label.name).join(", "))}
                >
                  <Text style={styles.actionText}>改标签</Text>
                </Pressable>
              </View>

              {labelDraft !== null ? (
                <>
                  <TextInput
                    accessibilityLabel="标签名，逗号分隔"
                    style={styles.input}
                    value={labelDraft}
                    onChangeText={setLabelDraft}
                    placeholder="用逗号分隔，留空表示清空标签"
                    multiline
                  />
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="保存标签到 GitHub"
                      style={styles.action}
                      onPress={() =>
                        labelMutation.mutate(
                          labelDraft
                            .split(/[,，]/)
                            .map((name) => name.trim())
                            .filter(Boolean),
                        )
                      }
                    >
                      <Text style={styles.actionText}>{labelMutation.isPending ? "保存中…" : "保存到 GitHub"}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="放弃改标签"
                      style={styles.action}
                      onPress={() => setLabelDraft(null)}
                    >
                      <Text style={styles.actionText}>取消</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.hint}>这里是整体替换：保存后这张票只有上面这些标签。</Text>
                </>
              ) : null}

              {detail.data?.ok
                ? detail.data.comments.map((item, index) => (
                    <View key={`${item.createdAt}-${index}`} style={styles.comment}>
                      <Text style={styles.meta}>
                        {item.author || "未知作者"} · {item.createdAt.slice(0, 10)}
                      </Text>
                      <Markdown>{item.body}</Markdown>
                    </View>
                  ))
                : null}

              <TextInput
                accessibilityLabel="写一条评论"
                style={styles.input}
                value={comment}
                onChangeText={setComment}
                placeholder="写一条评论（会发到 GitHub）"
                multiline
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="提交评论到 GitHub"
                style={styles.action}
                onPress={() => commentMutation.mutate()}
              >
                <Text style={styles.actionText}>
                  {commentMutation.isPending ? "提交中…" : comment.trim() ? "提交评论" : "写点什么再提交"}
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}
