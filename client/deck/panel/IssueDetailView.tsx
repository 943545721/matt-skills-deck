import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Markdown, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ItemKind } from "../../../shared/issues";
import type { PromptActionKind } from "../../../shared/session.ts";
import {
  issuesAssignRpc,
  issuesCommentRpc,
  issuesDetailRpc,
  issuesSetLabelsRpc,
  issuesStateRpc,
} from "../../../shared/issues";
import { repoTargetsRpc } from "../../../shared/repo";
import { readableText } from "../format";
import { FAILURE_KEYS, staticText, useDeckText } from "../i18n";
import { PixelBanner, PixelButton, PixelCard, PixelHead, PixelStatusLine, usePixel } from "../pixel";
import { buildIssuePrompt } from "./issuePrompt";
import { usePanelText } from "./panelText";
import { SessionSheet } from "../session/SessionSheet.tsx";
import type { SessionNavigation } from "../session/SessionSheet.tsx";
import { useDeckWorkspaceProvider } from "../surfaces/host.tsx";

/**
 * 票面详情（全屏）。
 *
 * 动作分三类，界面必须让人分清：
 * - 只读：打开网页、复制链接/提示词；
 * - 本地：绑定当前票、附加到会话（只复制 handoff 提示词）；
 * - 远端写：评论、改标签、接手/放手、关票/重开。
 *
 * 关票拆成「评论并关闭」与「直接关闭」两条：前者先发评论再关，
 * 评论成功而关票失败时明确说出「评论已发布、关闭失败」，不把两步混成一句“失败”。
 */
export function IssueDetailView({
  theme,
  workspaceId,
  workspaceDir,
  repoKey,
  number,
  kind,
  isCurrent,
  allowWrite = true,
  onBind,
  onOpenIssue,
  onOpenMap,
  onAttach,
  navigation,
}: {
  theme: PluginTheme;
  workspaceId: string;
  workspaceDir: string;
  repoKey: string;
  number: number;
  kind: ItemKind;
  isCurrent: boolean;
  /** 刷新预算判定：false 时禁用所有远端写。 */
  allowWrite?: boolean;
  onBind(): void;
  onOpenIssue(number: number, kind: ItemKind): void;
  onOpenMap(number: number, containerKind?: "map" | "spec"): void;
  onAttach(ref: { repoKey: string; number: number; title: string; kind: ItemKind }): void;
  navigation?: SessionNavigation;
}) {
  const { t } = usePanelText();
  const text = useDeckText();
  const { locale } = text;
  const skin = usePixel(theme);
  const provider = useDeckWorkspaceProvider(workspaceId);
  const toast = useToast();
  const queryClient = useQueryClient();

  const [comment, setComment] = useState("");
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [actionSheet, setActionSheet] = useState<{ open: boolean; action: PromptActionKind }>({ open: false, action: "diagnose" });

  const readDetail = useRpc(issuesDetailRpc);
  const postComment = useRpc(issuesCommentRpc);
  const replaceLabels = useRpc(issuesSetLabelsRpc);
  const assign = useRpc(issuesAssignRpc);
  const setState = useRpc(issuesStateRpc);
  const readTargets = useRpc(repoTargetsRpc);

  const detail = useQuery({
    queryKey: ["deck", "issue", workspaceDir, repoKey, kind, number],
    queryFn: () => readDetail({ workspaceDir, repoKey, number, kind }),
  });
  const targets = useQuery({
    queryKey: ["deck", "repo-targets", workspaceDir],
    queryFn: () => readTargets({ workspaceDir }),
    staleTime: 30_000,
  });

  const target = targets.data?.ok ? targets.data.repos.find((item) => item.key === repoKey) : undefined;

  /**
   * 跨仓库阻塞项的外部链接。
   *
   * 障碍项自己只有 `owner/repo#n`，没有宿主信息；宿主从工作区的仓库列表里查。
   * 查不到（对方仓库不在本工作区）就返回 null——宁可只显示引用，也不猜一个
   * 可能不存在的地址：点开 404 比点不开更让人怀疑数据。
   */
  const crossRepoUrl = (repo: string, issueNumber: number): string | null => {
    const repos = targets.data?.ok ? targets.data.repos : [];
    const found = repos.find((item) => item.key === repo || `${item.owner}/${item.name}` === repo);
    return found?.webUrl ? `${found.webUrl}/issues/${issueNumber}` : null;
  };
  const issue = detail.data?.ok ? detail.data.issue : null;
  const isPullRequest = kind === "pull-request";
  const readOnly = isPullRequest || Boolean(target?.readOnly);
  const canWrite = allowWrite && !readOnly;
  const labelsTruncated = issue ? issue.labelCount > issue.labels.length : false;
  const commentsTruncated = detail.data?.ok ? detail.data.commentCount > detail.data.comments.length : false;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["deck", "issue", workspaceDir, repoKey, kind, number] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "pull-requests", workspaceDir] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "map", workspaceDir, repoKey] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "git", workspaceDir] });
  };

  const failText = (reason: string, detailText: string): string =>
    `${staticText(text.t, FAILURE_KEYS[reason] ?? "failure.read")} — ${detailText}`;

  const commentMutation = useMutation({
    mutationFn: () => postComment({ workspaceDir, repoKey, number, kind, body: comment.trim() }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t("issue.commentFailed")}：${failText(result.reason, result.detail)}`, { variant: "error" });
        return;
      }
      setComment("");
      toast.show(t("issue.commentDone"), { variant: "success" });
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const labelsMutation = useMutation({
    mutationFn: (labels: string[]) => replaceLabels({ workspaceDir, repoKey, number, kind, labels }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t("issue.labelsFailed")}：${failText(result.reason, result.detail)}`, { variant: "error" });
        return;
      }
      setLabelDraft(null);
      toast.show(
        t("issue.labelsDone") +
          (result.labels.length ? ` · ${result.labels.map((label) => label.name).join(", ")}` : ""),
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
        toast.show(`${t("issue.actionFailed")}：${failText(result.reason, result.detail)}`, { variant: "error" });
        return;
      }
      toast.show(
        result.assignees.length ? t("issue.taken", { names: result.assignees.join(", ") }) : t("issue.released"),
        { variant: "success" },
      );
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  /** 关票：可选先发一条关闭原因。两步分别报告，绝不合并成一次“失败”。 */
  const closeMutation = useMutation({
    mutationFn: async (input: { reason: string }) => {
      const reason = input.reason.trim();
      if (reason) {
        const posted = await postComment({ workspaceDir, repoKey, number, kind, body: reason });
        if (!posted.ok) return { step: "comment" as const, detail: failText(posted.reason, posted.detail) };
      }
      const closed = await setState({ workspaceDir, repoKey, number, state: "closed" });
      if (!closed.ok) {
        return {
          step: "close" as const,
          detail: `${failText(closed.reason, closed.detail)}${reason ? `；${t("issue.closeHint")}` : ""}`,
        };
      }
      return { step: "done" as const, detail: "" };
    },
    onSuccess: (result) => {
      if (result.step !== "done") {
        toast.show(result.detail, { variant: "error" });
        invalidate();
        return;
      }
      setComment("");
      toast.show(t("issue.closeDone"), { variant: "success" });
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const reopenMutation = useMutation({
    mutationFn: () => setState({ workspaceDir, repoKey, number, state: "open" }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t("issue.actionFailed")}：${failText(result.reason, result.detail)}`, { variant: "error" });
        return;
      }
      toast.show(t("issue.reopenedDone"), { variant: "success" });
      invalidate();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const copy = (value: string, done: string) => {
    void copyText(value)
      .then(() => toast.show(done, { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  const generalPrompt = (): string =>
    issue
      ? buildIssuePrompt({
          locale,
          issue,
          repoKey,
          repoDir: target?.dir ?? null,
          repoWebUrl: detail.data?.ok ? detail.data.repo.webUrl : target?.webUrl ?? null,
          kind,
          mode: "general",
        })
      : "";

  const attach = () => {
    if (!issue) return;
    const prompt = buildIssuePrompt({
      locale,
      issue,
      repoKey,
      repoDir: target?.dir ?? null,
      repoWebUrl: detail.data?.ok ? detail.data.repo.webUrl : target?.webUrl ?? null,
      kind,
      mode: "attach",
    });
    void copyText(prompt)
      .then(() => {
        toast.show(t("issue.attachCopied"), { variant: "success" });
        onAttach({ repoKey, number, title: issue.title, kind });
      })
      .catch(() => toast.error(t("common.copyFailed")));
  };

  const styles = useMemo(
    () => ({
      screen: { flex: 1 },
      body: { gap: 10, paddingBottom: 20 },
      bar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      spacer: { marginLeft: "auto" as const },
      title: { color: skin.colors.ink, fontSize: 15, fontWeight: "700" as const, lineHeight: 21 },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, lineHeight: 16 },
      hint: skin.hint,
      error: skin.error,
      onScreen: skin.hintOnChecker,
      card: { padding: 10, gap: 6 },
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
      doc: skin.docPlate,
      input: { ...skin.input, minHeight: 64 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
      blocker: { gap: 3 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      comment: { borderTopWidth: 1, borderTopColor: skin.colors.line, paddingTop: 8, gap: 4 },
      grow: { flexShrink: 1 },
    }),
    [skin],
  );

  if (detail.isPending) return <Text style={styles.onScreen}>{t("common.loading")}</Text>;
  if (detail.error) {
    return (
      <PixelBanner skin={skin}>
        <Text style={styles.error}>{detail.error.message}</Text>
        <PixelButton skin={skin} label={t("common.retry")} onPress={() => void detail.refetch()} />
      </PixelBanner>
    );
  }
  if (!detail.data?.ok) {
    const failure = detail.data && !detail.data.ok ? detail.data : null;
    return (
      <PixelBanner skin={skin}>
        <Text style={styles.error}>
          {failure ? staticText(text.t, FAILURE_KEYS[failure.reason] ?? "failure.read") : t("common.empty")}
        </Text>
        {failure ? <Text style={styles.hint}>{failure.detail}</Text> : null}
      </PixelBanner>
    );
  }
  if (!issue) return <Text style={styles.onScreen}>{t("common.empty")}</Text>;

  const isClosed = issue.state === "CLOSED";
  const parent = detail.data.parent;
  const children = detail.data.children ?? [];
  const childrenTotal = detail.data.childrenTotal ?? children.length;
  const blocking = detail.data.blocking ?? [];
  const blockingTruncated = detail.data.blockingTruncated === true;
  // 原生边（本仓库、远端认得的）与正文固定行里的跨仓库引用分列：
  // 前者点开是同一个板上的票，后者只能开外链，混在一列会让人以为都能在本板里看。
  const nativeBlockers = issue.blockedBy.filter((blocker) => blocker.source !== "body");
  const crossBlockers = issue.blockedBy.filter((blocker) => blocker.source === "body");
  const busy =
    commentMutation.isPending || labelsMutation.isPending || assignMutation.isPending || closeMutation.isPending || reopenMutation.isPending;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <View style={styles.bar}>
        <Text style={styles.title} numberOfLines={2}>
          #{issue.number} {issue.title}
        </Text>
        <View style={styles.spacer} />
        <Text style={[styles.label, { backgroundColor: isClosed ? skin.colors.stripe : skin.colors.okBg, color: isClosed ? skin.colors.ink2 : skin.colors.ok }]}>
          {issue.merged ? text.t("issue.merged") : isClosed ? t("issue.stateClosed") : t("issue.stateOpen")}
        </Text>
      </View>

      <Text style={styles.meta}>
        {repoKey}
        {target?.dir ? ` · ${target.dir}` : ""}
      </Text>
      <Text style={styles.meta}>
        {t("issue.updated", { date: issue.updatedAt.slice(0, 10) })}
        {issue.assignees.length ? ` · ${t("issue.assigned", { names: issue.assignees.join(", ") })}` : ""}
      </Text>

      {!allowWrite && !readOnly ? <PixelBanner skin={skin} tone="warning"><Text style={styles.hint}>{t("issue.writePaused")}</Text></PixelBanner> : null}
      {readOnly ? (
        <Text style={styles.hint}>{isPullRequest ? text.t("issue.prReadOnly") : t("issue.readOnly")}</Text>
      ) : null}

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

      {parent ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("issue.parent")}</PixelHead>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("map.openIssue", { number: parent.number })}
              onPress={() => {
                if (parent.containerKind) onOpenMap(parent.number, parent.containerKind);
                else onOpenIssue(parent.number, "issue");
              }}
            >
              <Text style={styles.meta}>
                #{parent.number} {parent.title}
                {parent.containerKind ? ` · ${parent.containerKind.toUpperCase()}` : ""}
              </Text>
            </Pressable>
          </View>
        </PixelCard>
      ) : null}

      {issue.blockedBy.length ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("issue.blockedBy")}</PixelHead>
            {nativeBlockers.map((blocker) => (
              <Pressable
                key={`${blocker.kind}-${blocker.number}`}
                accessibilityRole="button"
                accessibilityLabel={t("map.openIssue", { number: blocker.number })}
                onPress={() => onOpenIssue(blocker.number, blocker.kind)}
              >
                <Text style={styles.meta}>
                  #{blocker.number} {blocker.title} · {blocker.state === "OPEN" ? t("issue.stateOpen") : t("issue.stateClosed")}
                </Text>
              </Pressable>
            ))}
            {crossBlockers.length ? (
              <View style={styles.blocker}>
                <Text style={styles.hint}>{text.t("issue.crossRepoTitle")}</Text>
                {crossBlockers.map((blocker) => {
                  const url = blocker.repo ? crossRepoUrl(blocker.repo, blocker.number) : null;
                  const ref = `${blocker.repo ?? ""}#${blocker.number}`;
                  const stateText =
                    blocker.state === "OPEN"
                      ? t("issue.stateOpen")
                      : blocker.state === "CLOSED"
                        ? t("issue.stateClosed")
                        : text.t("issue.blockerUnreadable");
                  return (
                    <Pressable
                      key={`cross-${ref}`}
                      accessibilityRole={url ? "link" : "text"}
                      accessibilityLabel={text.t("issue.openCrossRepo", { ref })}
                      disabled={!url}
                      onPress={() => {
                        if (!url) return;
                        void openExternalUrl(url).catch(() => toast.error(text.t("issue.openCrossRepoFailed")));
                      }}
                    >
                      <Text style={styles.meta}>
                        {ref} {blocker.title} · {stateText}
                        {blocker.stale ? ` · ${text.t("issue.blockerStale")}` : ""}
                        {url ? " ↗" : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        </PixelCard>
      ) : null}

      {blocking.length ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("issue.blocking")}</PixelHead>
            {blocking.map((blocked) => (
              <Pressable
                key={`${blocked.kind}-${blocked.number}`}
                accessibilityRole="button"
                accessibilityLabel={t("map.openIssue", { number: blocked.number })}
                onPress={() => onOpenIssue(blocked.number, blocked.kind)}
              >
                <Text style={styles.meta}>
                  #{blocked.number} {blocked.title} · {blocked.state === "OPEN" ? t("issue.stateOpen") : t("issue.stateClosed")}
                </Text>
              </Pressable>
            ))}
            {blockingTruncated ? <Text style={styles.hint}>{t("issue.blockingTruncated")}</Text> : null}
          </View>
        </PixelCard>
      ) : null}

      <View style={styles.doc}>
        <Markdown>{issue.body || t("issue.noBody")}</Markdown>
      </View>

      {children.length ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("issue.children")}</PixelHead>
            {children.map((child) => (
              <Pressable
                key={`${child.kind}-${child.number}`}
                accessibilityRole="button"
                accessibilityLabel={t("map.openIssue", { number: child.number })}
                onPress={() => onOpenIssue(child.number, child.kind)}
              >
                <Text style={styles.meta}>
                  #{child.number} {child.title} · {child.state === "OPEN" ? t("issue.stateOpen") : t("issue.stateClosed")}
                  {child.containerKind ? ` · ${child.containerKind.toUpperCase()}` : ""}
                </Text>
              </Pressable>
            ))}
            {childrenTotal > children.length ? (
              <Text style={styles.hint}>
                {t("issue.childrenTruncated", { shown: children.length, total: childrenTotal })}
              </Text>
            ) : null}
          </View>
        </PixelCard>
      ) : null}

      <View style={styles.actions}>
        <PixelButton
          skin={skin}
          label={t("issue.openWeb")}
          onPress={() => {
            void openExternalUrl(issue.url).catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error)),
            );
          }}
        />
        <PixelButton skin={skin} label={t("issue.copyLink")} onPress={() => copy(issue.url, t("common.copied"))} />
        <PixelButton skin={skin} label={t("issue.copyPrompt")} onPress={() => copy(generalPrompt(), t("common.copied"))} />
        {!isPullRequest ? (
          <PixelButton
            skin={skin}
            active={isCurrent}
            label={isCurrent ? t("issue.bound") : t("issue.bind")}
            onPress={onBind}
          />
        ) : null}
        {issue.isMap || issue.containerKind === "spec" ? (
          <PixelButton skin={skin} label={t("issue.openMap")} onPress={() => onOpenMap(issue.number, issue.containerKind === "spec" ? "spec" : "map")} />
        ) : null}
        <PixelButton skin={skin} label={t("issue.attach")} onPress={attach} disabled={!issue} />
      </View>
      <Text style={styles.hint}>{locale.startsWith("zh") ? "动作" : "Actions"}</Text>
      <View style={styles.actions}>
        {(["diagnose", "fix", "discuss", "research", "prototype", "takeover", "supplement", "execute"] as const).map((action) => (
          <PixelButton
            key={action}
            skin={skin}
            label={text.t(`issue.action.${action === "prototype" ? "prototypeAction" : action}` as never)}
            onPress={() => setActionSheet({ open: true, action })}
          />
        ))}
      </View>
      <Text style={styles.hint}>{t("issue.attachHint")}</Text>

      <SessionSheet
        open={actionSheet.open}
        onOpenChange={(open) => setActionSheet((current) => ({ ...current, open }))}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={workspaceDir}
        provider={provider ?? ""}
        action={actionSheet.action}
        context={{ repoKey, number, title: issue.title, url: issue.url }}
        navigation={navigation}
      />

      {!isPullRequest ? (
        <View style={styles.actions}>
          <PixelButton
            skin={skin}
            label={assignMutation.isPending ? t("issue.working") : t("issue.take")}
            disabled={!canWrite || busy}
            onPress={() => assignMutation.mutate(true)}
          />
          <PixelButton
            skin={skin}
            label={assignMutation.isPending ? t("issue.working") : t("issue.release")}
            disabled={!canWrite || busy}
            onPress={() => assignMutation.mutate(false)}
          />
          <PixelButton
            skin={skin}
            label={reopenMutation.isPending ? t("issue.reopening") : t("issue.reopen")}
            disabled={!canWrite || busy || !isClosed}
            onPress={() => reopenMutation.mutate()}
          />
          <PixelButton
            skin={skin}
            label={t("issue.labels")}
            disabled={!canWrite || labelsTruncated}
            onPress={() => setLabelDraft(issue.labels.map((label) => label.name).join(", "))}
          />
        </View>
      ) : null}

      {labelsTruncated ? (
        <Text style={styles.hint}>
          {t("issue.labelsTruncated", { shown: issue.labels.length, total: issue.labelCount })}
        </Text>
      ) : null}

      {labelDraft !== null ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <TextInput
              accessibilityLabel={t("issue.labels")}
              style={styles.input}
              value={labelDraft}
              onChangeText={setLabelDraft}
              placeholder={t("issue.labelsHint")}
              placeholderTextColor={skin.colors.ink2}
              multiline
            />
            <View style={styles.actions}>
              <PixelButton
                skin={skin}
                label={labelsMutation.isPending ? t("issue.savingLabels") : t("issue.saveLabels")}
                disabled={labelsMutation.isPending || !canWrite}
                onPress={() =>
                  labelsMutation.mutate(
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
          </View>
        </PixelCard>
      ) : null}

      <PixelCard skin={skin}>
        <View style={styles.card}>
          <PixelHead skin={skin}>{t("issue.comments")}</PixelHead>
          {commentsTruncated && detail.data.ok ? (
            <Text style={styles.hint}>
              {t("issue.commentsTruncated", { shown: detail.data.comments.length, total: detail.data.commentCount })}
            </Text>
          ) : null}
          {detail.data.comments.length === 0 ? <Text style={styles.hint}>{t("issue.noComments")}</Text> : null}
          {detail.data.comments.map((item, index) => (
            <View key={`${item.createdAt}-${index}`} style={styles.comment}>
              <Text style={styles.meta}>
                {item.author || t("common.unknown")} · {item.createdAt.slice(0, 10)}
              </Text>
              <View style={styles.doc}>
                <Markdown>{item.body}</Markdown>
              </View>
            </View>
          ))}

          {!readOnly ? (
            <>
              <TextInput
                accessibilityLabel={t("issue.commentPlaceholder")}
                style={styles.input}
                value={comment}
                onChangeText={setComment}
                placeholder={t("issue.commentPlaceholder")}
                placeholderTextColor={skin.colors.ink2}
                multiline
              />
              <View style={styles.actions}>
                <PixelButton
                  skin={skin}
                  label={commentMutation.isPending ? t("issue.posting") : t("issue.post")}
                  disabled={!canWrite || busy || !comment.trim()}
                  onPress={() => commentMutation.mutate()}
                />
                <PixelButton
                  skin={skin}
                  label={closeMutation.isPending ? t("issue.closing") : t("issue.closeWithComment")}
                  disabled={!canWrite || busy || !comment.trim() || isClosed}
                  onPress={() => closeMutation.mutate({ reason: comment })}
                />
                <PixelButton
                  skin={skin}
                  variant="ghost"
                  label={isClosed ? t("issue.stateClosed") : t("issue.closeNow")}
                  disabled={!canWrite || busy || isClosed}
                  onPress={() => closeMutation.mutate({ reason: "" })}
                />
              </View>
              <Text style={styles.hint}>{t("issue.closeHint")}</Text>
            </>
          ) : null}
        </View>
      </PixelCard>

      <PixelStatusLine skin={skin}>
        <Text style={styles.meta}>
          {repoKey}
          {target?.host ? ` · ${target.host}` : ""}
        </Text>
      </PixelStatusLine>
    </ScrollView>
  );
}
