import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { issuesCommentRpc, issuesDetailRpc, issuesSetLabelsRpc } from "../../shared/issues";
import { readableText } from "./format";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";
import { PixelButton, usePixel } from "./pixel";

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
  const { t } = useDeckText();
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
        toast.show(`${t("issue.commentFailed")}：${staticText(t, FAILURE_KEYS[result.reason] ?? "failure.read")} — ${result.detail}`, {
          variant: "error",
        });
        return;
      }
      setComment("");
      toast.show(t("issue.commentDone"), { variant: "success" });
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const labelMutation = useMutation({
    mutationFn: (labels: string[]) => setLabels({ workspaceDir, number, labels }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t("issue.labelsFailed")}：${staticText(t, FAILURE_KEYS[result.reason] ?? "failure.read")} — ${result.detail}`, {
          variant: "error",
        });
        return;
      }
      setLabelDraft(null);
      toast.show(
        t("issue.labelsDone", { names: result.labels.map((label) => label.name).join(", ") || "—" }),
        { variant: "success" },
      );
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const issue = detail.data?.ok ? detail.data.issue : null;
  // 只读到一部分标签时不许改标签：PUT 是整体替换，会把没读到的标签一起删掉。
  const labelsTruncated = issue ? issue.labelCount > issue.labels.length : false;
  const commentsTruncated =
    detail.data?.ok ? detail.data.commentCount > detail.data.comments.length : false;

  /**
   * 把票面拼成一段能直接粘进 Agent 输入框的文字。
   *
   * Paseo 没有「一键填入输入框」的接口，所以只产出文本、由用户粘到想粘的地方；
   * 带上链接是因为 Agent 需要它去读全文，而不是靠这段可能被截断的正文猜。
   * 文案走 `t`，所以同一张票在中文界面和英文界面复制出来的是对应语言。
   */
  const promptForIssue = (target: NonNullable<typeof issue>): string => {
    const names = target.labels.map((label) => label.name).join(", ");
    return [
      t("issue.promptTitle", { number: target.number, title: target.title }),
      target.url ? t("issue.promptLink", { url: target.url }) : "",
      names ? t("issue.promptLabels", { names }) : "",
      "",
      target.body.trim() || t("issue.promptNoBody"),
      "",
      t("issue.promptAsk"),
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  };

  const skin = usePixel(theme);

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      labels: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
      label: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden" as const },
      comment: { borderTopWidth: 2, borderTopColor: theme.colors.border, paddingTop: 8, gap: 3 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      input: {
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        padding: 8,
        fontSize: 12,
        minHeight: 64,
      },
    }),
    [theme, skin],
  );

  return (
    <Modal title={`#${number}`} open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content>
        <View style={styles.body}>
          {detail.error ? <Text style={styles.error}>{detail.error.message}</Text> : null}
          {detail.data && !detail.data.ok ? (
            <>
              <Text style={styles.error}>{staticText(t, FAILURE_KEYS[detail.data.reason] ?? "failure.read")}</Text>
              <Text style={styles.hint}>{detail.data.detail}</Text>
            </>
          ) : null}
          {detail.isPending ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}

          {issue ? (
            <>
              <Text style={styles.title}>{issue.title}</Text>
              <Text style={styles.meta}>
                {issue.state === "OPEN" ? t("issue.open") : t("issue.closed")} ·{" "}
                {t("issue.updatedAt", { date: issue.updatedAt.slice(0, 10) })}
                {issue.assignees.length
                  ? ` · ${t("issue.assignedTo", { names: issue.assignees.join(", ") })}`
                  : ""}
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

              <Markdown>{issue.body || t("issue.noBody")}</Markdown>

              <View style={styles.actions}>
                <PixelButton
                  skin={skin}
                  label={t("issue.copyPrompt")}
                  onPress={() => {
                    void copyText(promptForIssue(issue))
                      .then(() => toast.show(t("issue.promptCopied"), { variant: "success" }))
                      .catch(() => toast.error(t("common.copyFailed")));
                  }}
                />
                <PixelButton
                  skin={skin}
                  label={isCurrent ? t("issue.bound") : t("issue.bind")}
                  accessibilityLabel={
                    isCurrent
                      ? t("issue.unbindHint", { number })
                      : t("issue.bindHint", { number })
                  }
                  active={isCurrent}
                  onPress={onBind}
                />
                <PixelButton
                  skin={skin}
                  label={t("issue.editLabels")}
                  disabled={labelsTruncated}
                  onPress={() => setLabelDraft(issue.labels.map((label) => label.name).join(", "))}
                />
              </View>

              {labelsTruncated ? (
                <Text style={styles.hint}>
                  {t("issue.labelsTruncated", { total: issue.labelCount, shown: issue.labels.length })}
                </Text>
              ) : null}

              {labelDraft !== null ? (
                <>
                  <TextInput
                    accessibilityLabel={t("issue.editLabels")}
                    style={styles.input}
                    value={labelDraft}
                    onChangeText={setLabelDraft}
                    placeholder={t("issue.labelsPlaceholder")}
                    multiline
                  />
                  <View style={styles.actions}>
                    <PixelButton
                      skin={skin}
                      label={labelMutation.isPending ? t("issue.savingLabels") : t("issue.saveLabels")}
                      disabled={labelMutation.isPending}
                      onPress={() =>
                        labelMutation.mutate(
                          labelDraft
                            .split(/[,，]/)
                            .map((name) => name.trim())
                            .filter(Boolean),
                        )
                      }
                    />
                    <PixelButton skin={skin} label={t("common.cancel")} onPress={() => setLabelDraft(null)} />
                  </View>
                  <Text style={styles.hint}>{t("issue.labelsHint")}</Text>
                </>
              ) : null}

              {commentsTruncated && detail.data?.ok ? (
                <Text style={styles.hint}>
                  {t("issue.commentsTruncated", { shown: detail.data.comments.length, total: detail.data.commentCount })}
                </Text>
              ) : null}

              {detail.data?.ok
                ? detail.data.comments.map((item, index) => (
                    <View key={`${item.createdAt}-${index}`} style={styles.comment}>
                      <Text style={styles.meta}>
                        {item.author || t("issue.unknownAuthor")} · {item.createdAt.slice(0, 10)}
                      </Text>
                      <Markdown>{item.body}</Markdown>
                    </View>
                  ))
                : null}

              <TextInput
                accessibilityLabel={t("issue.submitComment")}
                style={styles.input}
                value={comment}
                onChangeText={setComment}
                placeholder={t("issue.commentPlaceholder")}
                multiline
              />
              <PixelButton
                skin={skin}
                label={
                  commentMutation.isPending
                    ? t("issue.commenting")
                    : comment.trim()
                      ? t("issue.submitComment")
                      : t("issue.commentEmpty")
                }
                disabled={commentMutation.isPending || !comment.trim()}
                onPress={() => commentMutation.mutate()}
              />
            </>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}
