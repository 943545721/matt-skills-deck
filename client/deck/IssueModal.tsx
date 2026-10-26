import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesCommentRpc, issuesDetailRpc, issuesSetLabelsRpc } from "../../shared/issues";
import { failureText, promptForIssue, readableText } from "./format";
import type { Lang } from "./i18n";
import { t } from "./i18n";

/**
 * 票面详情。
 *
 * 三个动作都在这里：评论、改标签、复制提示词。前两个会真的改远端，所以按钮上的字要写清
 * 「写到哪」——面板不大，含糊的按钮很容易让人以为只是本地标注。
 */
export function IssueModal({
  theme,
  lang,
  workspaceDir,
  number,
  isCurrent,
  onBind,
  onClose,
}: {
  theme: PluginTheme;
  lang: Lang;
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
        toast.show(`${t(lang, "issue.commentFailed")}：${failureText(lang, result.reason)} — ${result.detail}`, {
          variant: "error",
        });
        return;
      }
      setComment("");
      toast.show(t(lang, "issue.commentDone"), { variant: "success" });
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const labelMutation = useMutation({
    mutationFn: (labels: string[]) => setLabels({ workspaceDir, number, labels }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t(lang, "issue.labelsFailed")}：${failureText(lang, result.reason)} — ${result.detail}`, {
          variant: "error",
        });
        return;
      }
      setLabelDraft(null);
      toast.show(
        t(lang, "issue.labelsDone", { names: result.labels.map((label) => label.name).join(", ") || "—" }),
        { variant: "success" },
      );
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
              <Text style={styles.error}>{failureText(lang, detail.data.reason)}</Text>
              <Text style={styles.hint}>{detail.data.detail}</Text>
            </>
          ) : null}
          {detail.isPending ? <Text style={styles.hint}>{t(lang, "common.loading")}</Text> : null}

          {issue ? (
            <>
              <Text style={styles.title}>{issue.title}</Text>
              <Text style={styles.meta}>
                {issue.state === "OPEN" ? t(lang, "issue.open") : t(lang, "issue.closed")} ·{" "}
                {t(lang, "issue.updatedAt", { date: issue.updatedAt.slice(0, 10) })}
                {issue.assignees.length
                  ? ` · ${t(lang, "issue.assignedTo", { names: issue.assignees.join(", ") })}`
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

              <Markdown>{issue.body || t(lang, "issue.noBody")}</Markdown>

              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(lang, "issue.copyPrompt")}
                  style={styles.action}
                  onPress={() => {
                    void copyText(promptForIssue(lang, issue))
                      .then(() => toast.show(t(lang, "issue.promptCopied"), { variant: "success" }))
                      .catch(() => toast.error(t(lang, "common.copyFailed")));
                  }}
                >
                  <Text style={styles.actionText}>{t(lang, "issue.copyPrompt")}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    isCurrent
                      ? t(lang, "issue.unbindHint", { number })
                      : t(lang, "issue.bindHint", { number })
                  }
                  style={[styles.action, isCurrent ? styles.actionActive : null]}
                  onPress={onBind}
                >
                  <Text style={styles.actionText}>
                    {isCurrent ? t(lang, "issue.bound") : t(lang, "issue.bind")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(lang, "issue.editLabels")}
                  style={styles.action}
                  onPress={() => setLabelDraft(issue.labels.map((label) => label.name).join(", "))}
                >
                  <Text style={styles.actionText}>{t(lang, "issue.editLabels")}</Text>
                </Pressable>
              </View>

              {labelDraft !== null ? (
                <>
                  <TextInput
                    accessibilityLabel={t(lang, "issue.editLabels")}
                    style={styles.input}
                    value={labelDraft}
                    onChangeText={setLabelDraft}
                    placeholder={t(lang, "issue.labelsPlaceholder")}
                    multiline
                  />
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t(lang, "issue.saveLabels")}
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
                      <Text style={styles.actionText}>
                        {labelMutation.isPending ? t(lang, "issue.savingLabels") : t(lang, "issue.saveLabels")}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t(lang, "issue.discardLabels")}
                      style={styles.action}
                      onPress={() => setLabelDraft(null)}
                    >
                      <Text style={styles.actionText}>{t(lang, "common.cancel")}</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.hint}>{t(lang, "issue.labelsHint")}</Text>
                </>
              ) : null}

              {detail.data?.ok
                ? detail.data.comments.map((item, index) => (
                    <View key={`${item.createdAt}-${index}`} style={styles.comment}>
                      <Text style={styles.meta}>
                        {item.author || t(lang, "issue.unknownAuthor")} · {item.createdAt.slice(0, 10)}
                      </Text>
                      <Markdown>{item.body}</Markdown>
                    </View>
                  ))
                : null}

              <TextInput
                accessibilityLabel={t(lang, "issue.submitComment")}
                style={styles.input}
                value={comment}
                onChangeText={setComment}
                placeholder={t(lang, "issue.commentPlaceholder")}
                multiline
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t(lang, "issue.submitComment")}
                style={styles.action}
                onPress={() => commentMutation.mutate()}
              >
                <Text style={styles.actionText}>
                  {commentMutation.isPending
                    ? t(lang, "issue.commenting")
                    : comment.trim()
                      ? t(lang, "issue.submitComment")
                      : t(lang, "issue.commentEmpty")}
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}
