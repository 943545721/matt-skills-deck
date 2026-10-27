import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ItemKind } from "../../shared/issues";
import {
  issuesAssignRpc,
  issuesCommentRpc,
  issuesDetailRpc,
  issuesSetLabelsRpc,
  issuesStateRpc,
} from "../../shared/issues";
import { readableText } from "./format";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";
import { PixelButton, usePixel } from "./pixel";

type PromptMode = "general" | "diagnose" | "fix" | "research" | "take" | "complete";

/**
 * 票面详情。
 *
 * 动作分两类，界面必须让人一眼分清：
 * - 只读/复制类（打开 GitHub、复制链接、复制提示词）不改变远端；
 * - 写类（评论、改标签、接手、关票）会真的改远端，按钮文字里带「GitHub」或动作对象。
 *
 * 拉取请求在这里是只读的：它的评论、标签、指派都不从本插件写。
 */
export function IssueModal({
  theme,
  workspaceDir,
  number,
  kind,
  isCurrent,
  onBind,
  onOpenRelated,
  onClose,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  number: number;
  kind: ItemKind;
  isCurrent: boolean;
  onBind(): void;
  onOpenRelated?(number: number): void;
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
  const assign = useRpc(issuesAssignRpc);
  const setState = useRpc(issuesStateRpc);

  const detail = useQuery({
    queryKey: ["deck", "issue", workspaceDir, kind, number],
    queryFn: () => readIssue({ workspaceDir, number, kind }),
  });

  /** 写成功后就地刷新：详情与列表都会因为一次评论/改标签而变化，两边都要重取。 */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["deck", "issue", workspaceDir, kind, number] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
  };

  const commentMutation = useMutation({
    mutationFn: () => writeComment({ workspaceDir, number, body: comment.trim(), kind }),
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
    mutationFn: (labels: string[]) => setLabels({ workspaceDir, number, labels, kind }),
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

  const assignMutation = useMutation({
    mutationFn: (take: boolean) => assign({ workspaceDir, number, take }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t("issue.actionFailed")}：${staticText(t, FAILURE_KEYS[result.reason] ?? "failure.read")} — ${result.detail}`, {
          variant: "error",
        });
        return;
      }
      toast.show(
        result.assignees.length
          ? t("issue.taken", { names: result.assignees.join(", ") })
          : t("issue.released"),
        { variant: "success" },
      );
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const stateMutation = useMutation({
    mutationFn: (next: "open" | "closed") => setState({ workspaceDir, number, state: next }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t("issue.actionFailed")}：${staticText(t, FAILURE_KEYS[result.reason] ?? "failure.read")} — ${result.detail}`, {
          variant: "error",
        });
        return;
      }
      toast.show(result.state === "CLOSED" ? t("issue.closedDone") : t("issue.reopenedDone"), { variant: "success" });
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const issue = detail.data?.ok ? detail.data.issue : null;
  const isPullRequest = kind === "pull-request";
  // 只读到一部分标签时不许改标签：PUT 是整体替换，会把没读到的标签一起删掉。
  const labelsTruncated = issue ? issue.labelCount > issue.labels.length : false;
  const commentsTruncated =
    detail.data?.ok ? detail.data.commentCount > detail.data.comments.length : false;

  const copy = (text: string, done: string) => {
    void copyText(text)
      .then(() => toast.show(done, { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  /**
   * 把票面拼成一段能直接粘进 Agent 输入框的文字。
   *
   * Paseo 没有「一键填入输入框」的接口，所以只产出文本、由用户粘到想粘的地方；
   * 带上链接是因为 Agent 需要它去读全文，而不是靠这段可能被截断的正文猜。
   * 文案走 `t`，所以同一张票在中文界面和英文界面复制出来的是对应语言。
   */
  const promptForIssue = (target: NonNullable<typeof issue>, mode: PromptMode): string => {
    const names = target.labels.map((label) => label.name).join(", ");
    const ask: Record<PromptMode, string> = {
      general: t("issue.promptAsk"),
      diagnose: t("issue.promptAskDiagnose"),
      fix: t("issue.promptAskFix"),
      research: t("issue.promptAskResearch"),
      take: t("issue.promptAskTake"),
      complete: t("issue.promptAskComplete"),
    };
    return [
      t("issue.promptTitle", { number: target.number, title: target.title }),
      target.url ? t("issue.promptLink", { url: target.url }) : "",
      names ? t("issue.promptLabels", { names }) : "",
      "",
      target.body.trim() || t("issue.promptNoBody"),
      "",
      ask[mode],
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  };

  const skin = usePixel(theme);

  const promptActions: { mode: PromptMode; label: string }[] = [
    { mode: "diagnose", label: t("issue.promptDiagnose") },
    { mode: "fix", label: t("issue.promptFix") },
    { mode: "research", label: t("issue.promptResearch") },
    { mode: "take", label: t("issue.promptTake") },
    { mode: "complete", label: t("issue.promptComplete") },
  ];

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
      blocker: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, alignItems: "center" as const },
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
                {issue.merged
                  ? t("issue.merged")
                  : issue.state === "OPEN"
                    ? t("issue.open")
                    : t("issue.closed")}{" "}
                · {t("issue.updatedAt", { date: issue.updatedAt.slice(0, 10) })}
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

              {issue.blockedBy.length ? (
                <View style={styles.blocker}>
                  <Text style={styles.meta}>{t("issue.blockedByTitle")}</Text>
                  {issue.blockedBy.map((blocker) => (
                    <Pressable
                      key={`${blocker.kind}-${blocker.number}`}
                      accessibilityRole="button"
                      accessibilityLabel={t("issue.openBlocker", { number: blocker.number })}
                      onPress={() => onOpenRelated?.(blocker.number)}
                    >
                      <Text
                        style={[
                          styles.label,
                          {
                            backgroundColor: blocker.state === "OPEN" ? theme.colors.statusDanger : theme.colors.surface2,
                            color: blocker.state === "OPEN" ? "#ffffff" : theme.colors.foregroundMuted,
                          },
                        ]}
                      >
                        #{blocker.number} {blocker.title}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <Markdown>{issue.body || t("issue.noBody")}</Markdown>

              <View style={styles.actions}>
                {issue.url ? (
                  <PixelButton
                    skin={skin}
                    label={t("issue.openOnGithub")}
                    onPress={() => {
                      void openExternalUrl(issue.url).catch((error: unknown) =>
                        toast.error(error instanceof Error ? error.message : String(error)),
                      );
                    }}
                  />
                ) : null}
                {issue.url ? (
                  <PixelButton skin={skin} label={t("issue.copyLink")} onPress={() => copy(issue.url, t("issue.linkCopied"))} />
                ) : null}
                <PixelButton
                  skin={skin}
                  label={t("issue.copyPrompt")}
                  onPress={() => copy(promptForIssue(issue, "general"), t("issue.promptCopied"))}
                />
                {!isPullRequest ? (
                  <PixelButton
                    skin={skin}
                    label={isCurrent ? t("issue.bound") : t("issue.bind")}
                    accessibilityLabel={
                      isCurrent ? t("issue.unbindHint", { number }) : t("issue.bindHint", { number })
                    }
                    active={isCurrent}
                    onPress={onBind}
                  />
                ) : null}
              </View>

              {/* 行级动作的提示词版本：DSH 直接把动作注入会话，这里产出等价文本。 */}
              <View style={styles.actions}>
                {promptActions.map((action) => (
                  <PixelButton
                    key={action.mode}
                    skin={skin}
                    label={action.label}
                    onPress={() => copy(promptForIssue(issue, action.mode), t("issue.promptCopied"))}
                  />
                ))}
              </View>

              {!isPullRequest ? (
                <View style={styles.actions}>
                  <PixelButton
                    skin={skin}
                    label={assignMutation.isPending ? t("issue.working") : t("issue.actionTake")}
                    disabled={assignMutation.isPending}
                    onPress={() => assignMutation.mutate(true)}
                  />
                  <PixelButton
                    skin={skin}
                    label={assignMutation.isPending ? t("issue.working") : t("issue.actionRelease")}
                    disabled={assignMutation.isPending}
                    onPress={() => assignMutation.mutate(false)}
                  />
                  <PixelButton
                    skin={skin}
                    label={stateMutation.isPending ? t("issue.working") : t("issue.actionClose")}
                    disabled={stateMutation.isPending || issue.state === "CLOSED"}
                    onPress={() => stateMutation.mutate("closed")}
                  />
                  <PixelButton
                    skin={skin}
                    label={stateMutation.isPending ? t("issue.working") : t("issue.actionReopen")}
                    disabled={stateMutation.isPending || issue.state === "OPEN"}
                    onPress={() => stateMutation.mutate("open")}
                  />
                </View>
              ) : (
                <Text style={styles.hint}>{t("issue.prReadOnly")}</Text>
              )}

              {!isPullRequest ? (
                <PixelButton
                  skin={skin}
                  label={t("issue.editLabels")}
                  disabled={labelsTruncated}
                  onPress={() => setLabelDraft(issue.labels.map((label) => label.name).join(", "))}
                />
              ) : null}

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

              {!isPullRequest ? (
                <>
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
            </>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}
