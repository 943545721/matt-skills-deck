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
import { PixelBanner, PixelButton, PixelModalBody, usePixel } from "./pixel";

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
  repoKey,
  repoDir,
  repoWebUrl,
  readOnly = false,
  number,
  kind,
  isCurrent,
  onBind,
  onOpenRelated,
  onClose,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  /** 票属于哪个仓库：票号只在仓库内唯一，写操作必须带它。 */
  repoKey: string;
  /** 本地代码目录与远端地址：复制给 Agent 的提示词要能直接指到代码。 */
  repoDir?: string;
  repoWebUrl?: string | null;
  /** 当前账号没有写权限：读与复制提示词照常，写操作整块禁用。 */
  readOnly?: boolean;
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
    queryKey: ["deck", "issue", workspaceDir, repoKey, kind, number],
    queryFn: () => readIssue({ workspaceDir, repoKey, number, kind }),
  });

  /** 写成功后就地刷新：详情与列表都会因为一次评论/改标签而变化，两边都要重取。 */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["deck", "issue", workspaceDir, repoKey, kind, number] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
  };

  const commentMutation = useMutation({
    mutationFn: () => writeComment({ workspaceDir, repoKey, number, body: comment.trim(), kind }),
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
    mutationFn: (labels: string[]) => setLabels({ workspaceDir, repoKey, number, labels, kind }),
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
    mutationFn: (take: boolean) => assign({ workspaceDir, repoKey, number, take }),
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
    mutationFn: (next: "open" | "closed") => setState({ workspaceDir, repoKey, number, state: next }),
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
      t("issue.promptRepo", { repo: repoKey }),
      repoDir ? t("issue.promptCodeDir", { dir: repoDir }) : "",
      repoWebUrl ? t("issue.promptRemote", { url: repoWebUrl }) : "",
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
      title: { color: skin.colors.ink, fontSize: 15, fontWeight: "700" as const, lineHeight: 21 },
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
      comment: { borderTopWidth: 1, borderTopColor: skin.colors.line, paddingTop: 8, gap: 4 },
      hint: skin.hint,
      error: skin.error,
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
      blocker: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, alignItems: "center" as const },
      docPlate: skin.docPlate,
      input: {
        ...skin.input,
        minHeight: 64,
      },
    }),
    [skin],
  );

  return (
    <Modal title={`#${number}`} open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content>
        <PixelModalBody skin={skin} style={styles.body}>
          {detail.error ? (
            <PixelBanner skin={skin}>
              <Text style={styles.error}>{detail.error.message}</Text>
            </PixelBanner>
          ) : null}
          {detail.data && !detail.data.ok ? (
            <PixelBanner skin={skin}>
              <Text style={styles.error}>{staticText(t, FAILURE_KEYS[detail.data.reason] ?? "failure.read")}</Text>
              <Text style={styles.hint}>{detail.data.detail}</Text>
            </PixelBanner>
          ) : null}
          {detail.isPending ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}

          {issue ? (
            <>
              <Text style={styles.title}>{issue.title}</Text>
              <Text style={styles.meta}>
                {repoKey === "local" ? t("board.hostLocal") : repoKey}
                {repoDir ? ` · ${t("board.codeDir", { dir: repoDir })}` : ""}
              </Text>
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
                            backgroundColor: blocker.state === "OPEN" ? skin.colors.badBg : skin.colors.stripe,
                            color: blocker.state === "OPEN" ? skin.colors.bad : skin.colors.ink2,
                          },
                        ]}
                      >
                        #{blocker.number} {blocker.title}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <View style={styles.docPlate}>
                <Markdown>{issue.body || t("issue.noBody")}</Markdown>
              </View>

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
                readOnly ? (
                  <Text style={styles.hint}>{t("issue.readOnly")}</Text>
                ) : (
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
                )
              ) : (
                <Text style={styles.hint}>{t("issue.prReadOnly")}</Text>
              )}

              {!isPullRequest ? (
                <PixelButton
                  skin={skin}
                  label={t("issue.editLabels")}
                  disabled={labelsTruncated || readOnly}
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
                    placeholderTextColor={skin.colors.ink2}
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
                      <View style={styles.docPlate}>
                        <Markdown>{item.body}</Markdown>
                      </View>
                    </View>
                  ))
                : null}

              {!isPullRequest && !readOnly ? (
                <>
                  <TextInput
                    accessibilityLabel={t("issue.submitComment")}
                    style={styles.input}
                    value={comment}
                    onChangeText={setComment}
                    placeholder={t("issue.commentPlaceholder")}
                    placeholderTextColor={skin.colors.ink2}
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
        </PixelModalBody>
      </Modal.Content>
    </Modal>
  );
}
