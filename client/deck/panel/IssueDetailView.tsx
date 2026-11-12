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
import { sessionLedgerRpc } from "../../../shared/session-rpc";
import { clockText, readableText } from "../format";
import { labelDisplayName } from "../labelText";
import type { IssueEventKind } from "./issueTimeline";
import { buildIssueTimeline, firstLine, isTicketOf } from "./issueTimeline";
import type { WorkRouteStatus } from "../../../shared/work-route.ts";
import { DECK_FINALIZE_LABEL, finalizeProblem, REQUIREMENT_LABEL } from "../../../shared/impact.ts";
import { acceptanceTicketNumberOf, hasPendingAcceptanceRecord } from "../../../shared/contract-chain.ts";
import type { PanelKey } from "./panelText";

/** 时间线里的事件类别 → 文案键。 */
const TIMELINE_KIND_KEY: Record<IssueEventKind, PanelKey> = {
  created: "issue.timelineCreated",
  comment: "issue.timelineComment",
  session: "issue.timelineSession",
  closed: "issue.timelineClosed",
  updated: "issue.timelineUpdated",
};

/** 台账那四步 → 文案键。状态由写台账的一侧给出，界面不改写也不猜。 */
const TIMELINE_STATUS_KEY: Record<WorkRouteStatus, PanelKey> = {
  attached: "issue.timelineStatus.attached",
  "in-progress": "issue.timelineStatus.inProgress",
  done: "issue.timelineStatus.done",
  released: "issue.timelineStatus.released",
};
import { FAILURE_KEYS, staticText, useDeckText } from "../i18n";
import { PixelBanner, PixelButton, PixelCard, PixelHead, PixelStatusLine, usePixel } from "../pixel";
import { buildIssuePrompt } from "./issuePrompt";
import { RequirementDispatchButton } from "./RequirementDispatchButton.tsx";
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
  const readLedger = useRpc(sessionLedgerRpc);

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
   * 本机台账：谁在什么时候接过这张票。
   *
   * 按工作区读（`agentId: null`），再按 `仓库#票号` 筛——同一张票可能被几个会话
   * 先后接过，全部都要出现在时间线上。读不到时时间线照常出远端那几条，
   * 界面上明说「会话那一段没算进来」，不假装这张票没人碰过。
   */
  const ledger = useQuery({
    queryKey: ["deck", "ledger", workspaceDir, null],
    queryFn: () => readLedger({ cwd: workspaceDir, agentId: null }),
    // 工作区目录未知时这份台账根本没有作用域，发出去只会换回一条参数错误。
    enabled: Boolean(workspaceDir),
    staleTime: 15_000,
  });

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
  /**
   * 验收痕迹：正文里持久写着「验收：未验收」，或需求票挂着的验收票还开着。
   * 前者关票后仍然在正文里，所以标记关票后照样可见；后者只在验收票开着时出现。
   * 只读、不改票：读不到验收票就不标（不把「不知道」说成「未验收」）。
   */
  const pendingAcceptanceLine = issue ? hasPendingAcceptanceRecord(issue.body) : false;
  const acceptanceNumber = issue ? acceptanceTicketNumberOf(issue.body) : null;
  const acceptance = useQuery({
    queryKey: ["deck", "issue-acceptance", workspaceDir, repoKey, acceptanceNumber],
    queryFn: () => readDetail({ workspaceDir, repoKey, number: acceptanceNumber as number, kind: "issue" }),
    enabled: Boolean(issue && acceptanceNumber !== null && !pendingAcceptanceLine && !isPullRequest),
  });
  const readOnly = isPullRequest || Boolean(target?.readOnly);
  const canWrite = allowWrite && !readOnly;
  const labelsTruncated = issue ? issue.labelCount > issue.labels.length : false;
  /** 定稿按钮只长在需求票上，而且只在没定稿时露出。 */
  const isRequirement = Boolean(issue?.labels.some((label) => label.name.toLowerCase() === REQUIREMENT_LABEL));
  const finalized = Boolean(
    issue?.labels.some((label) => label.name.toLowerCase() === DECK_FINALIZE_LABEL.toLowerCase()),
  );
  const commentsTruncated = detail.data?.ok ? detail.data.commentCount > detail.data.comments.length : false;

  const sessions = issue && ledger.data?.ok
    ? ledger.data.ledger.entries.filter((entry) => isTicketOf(entry, { repoKey, number }))
    : [];
  const ledgerUnreadable = ledger.data ? !ledger.data.ok : false;
  const timeline = issue
    ? buildIssueTimeline({
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        closedAt: issue.closedAt ?? null,
        comments: detail.data?.ok ? detail.data.comments : [],
        sessions,
      })
    : [];

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

  /**
   * 定稿：给需求票补一枚 `deck:定稿`。
   *
   * 这是**唯一**该标签的合法来源——MCP 工具会拒绝 `deck:` 前缀，模型不能给自己发许可证。
   * 点之前先核影响面：表坏了 / 依据空着 / 「要动」没写核的人，都在这里挡下并说清哪一行。
   */
  const finalizeRequirement = (): void => {
    if (!issue) return;
    // 读不到仓库清单时不能拿空清单顶上：那等于判成「单区、免人工表」，
    // 跨仓库需求会在按钮这里放过、到派单窗口才报 missing-impact——错落在没权限改票的那个人身上。
    if (!targets.data?.ok) {
      toast.show(t("issue.finalizeNeedsRepos"), { variant: "error" });
      return;
    }
    const problem = finalizeProblem(issue.body, targets.data.repos.map((repo) => repo.key));
    if (problem) {
      toast.show(`${t("issue.finalizeBlocked")}：${problem}`, { variant: "error" });
      return;
    }
    labelsMutation.mutate([...issue.labels.map((label) => label.name), DECK_FINALIZE_LABEL]);
  };

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
      return { step: "done" as const, detail: "", warnings: closed.warnings ?? [] };
    },
    onSuccess: (result) => {
      if (result.step !== "done") {
        toast.show(result.detail, { variant: "error" });
        invalidate();
        return;
      }
      setComment("");
      // 关票成功但验收痕迹没写成（或验收票读不到）：不能只说「关闭完成」，否则用户以为正文已留痕。
      if (result.warnings.length) {
        toast.show(`${t("issue.closeDone")}；${result.warnings.join("；")}`, { variant: "warning" });
      } else {
        toast.show(t("issue.closeDone"), { variant: "success" });
      }
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
      acceptance: {
        fontSize: 10,
        lineHeight: 16,
        paddingHorizontal: 6,
        overflow: "hidden" as const,
        borderWidth: 1,
        borderColor: skin.colors.line,
        color: skin.colors.warn,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
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
      // 时间线：时间靠右成一列、事件名固定宽度、中间正文自己伸缩——三列对齐才扫得动。
      timelineRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 3 },
      timelineDivider: { borderTopWidth: 1, borderTopColor: skin.colors.line },
      timelineKind: { width: 62, color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      timelineText: { flex: 1, color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily },
      timelineClock: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
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
  const acceptancePending =
    pendingAcceptanceLine
    || (acceptance.data?.ok === true && acceptance.data.issue.state === "OPEN");
  /** 「不知道」不能标成「未验收」，但也不能静默：读失败单独说一句。 */
  const acceptanceUnreadable =
    acceptanceNumber !== null
    && !pendingAcceptanceLine
    && (acceptance.isError || (acceptance.data !== undefined && !acceptance.data.ok));
  const parent = detail.data.parent;
  /** 地图票正文里的 `Derived from: #N`：它来自哪条需求。 */
  const derivedFrom = issue?.derivedFrom ?? null;
  /** 需求票的反查结果：哪些地图是从这张需求长出来的。 */
  const derivedMaps = detail.data.derivedMaps ?? [];
  const derivedMapsFailed = detail.data.derivedMapsFailed === true;
  const children = detail.data.children ?? [];
  const childrenTotal = detail.data.childrenTotal ?? children.length;
  const childrenCut = detail.data.childrenTruncated === true;
  const childrenProblem = detail.data.childrenProblem ?? "";
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
        {acceptancePending ? <Text style={styles.acceptance}>{t("issue.acceptancePending")}</Text> : null}
        <Text style={[styles.label, { backgroundColor: isClosed ? skin.colors.stripe : skin.colors.okBg, color: isClosed ? skin.colors.ink2 : skin.colors.ok }]}>
          {issue.merged ? text.t("issue.merged") : isClosed ? t("issue.stateClosed") : t("issue.stateOpen")}
        </Text>
      </View>

      <Text style={styles.meta}>
        {repoKey}
        {target?.dir ? ` · ${target.dir}` : ""}
      </Text>
      <Text style={styles.meta}>
        {t("issue.updated", { date: clockText(issue.updatedAt) })}
        {issue.assignees.length ? ` · ${t("issue.assigned", { names: issue.assignees.join(", ") })}` : ""}
      </Text>
      {acceptanceUnreadable ? (
        <Text style={styles.hint}>{t("issue.acceptanceUnreadable", { number: acceptanceNumber ?? 0 })}</Text>
      ) : null}

      {!allowWrite && !readOnly ? <PixelBanner skin={skin} tone="warning"><Text style={styles.hint}>{t("issue.writePaused")}</Text></PixelBanner> : null}
      {readOnly ? (
        <Text style={styles.hint}>{isPullRequest ? text.t("issue.prReadOnly") : t("issue.readOnly")}</Text>
      ) : null}

      {issue.labels.length ? (
        <View style={styles.labels}>
          {issue.labels.map((label) => (
            <Text
              key={label.name}
              accessibilityLabel={label.name}
              style={[styles.label, { backgroundColor: `#${label.color}`, color: readableText(label.color) }]}
            >
              {labelDisplayName(label.name, text.locale)}
            </Text>
          ))}
        </View>
      ) : null}

      {/* 时间线：建票、评论、会话接手、最近变动并成一列，按时间倒序。
          只列有时间的步骤——状态历史远端不给，宁可少一行，也不编一个时刻。 */}
      <PixelCard skin={skin}>
        <View style={styles.card}>
          <PixelHead skin={skin}>{t("issue.timeline")}</PixelHead>
          {timeline.map((event, index) => {
            const who = event.kind === "comment" && event.who ? `@${event.who}` : null;
            const sessionWho = event.kind === "session" && event.who ? event.who.slice(0, 8) : null;
            const detailParts =
              event.kind === "comment"
                ? [who, firstLine(event.body ?? "")]
                : event.kind === "session"
                  ? [sessionWho, event.status ? t(TIMELINE_STATUS_KEY[event.status]) : null, event.note]
                  : [];
            return (
              <View
                key={`${event.kind}-${event.at}-${index}`}
                style={[styles.timelineRow, index === 0 ? null : styles.timelineDivider]}
              >
                <Text style={styles.timelineKind} numberOfLines={1}>
                  {t(TIMELINE_KIND_KEY[event.kind])}
                </Text>
                <Text style={styles.timelineText} numberOfLines={1}>
                  {detailParts.filter(Boolean).join(" ")}
                </Text>
                <Text style={styles.timelineClock} numberOfLines={1}>
                  {clockText(event.at)}
                </Text>
              </View>
            );
          })}
          {ledgerUnreadable ? <Text style={styles.hint}>{t("issue.timelineLedgerFailed")}</Text> : null}
        </View>
      </PixelCard>

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

      {derivedFrom !== null ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("issue.derivedFrom")}</PixelHead>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("map.openIssue", { number: derivedFrom })}
              onPress={() => onOpenIssue(derivedFrom, "issue")}
            >
              <Text style={styles.meta}>#{derivedFrom}</Text>
            </Pressable>
          </View>
        </PixelCard>
      ) : null}

      {derivedMaps.length || derivedMapsFailed ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("issue.derivedMaps")}</PixelHead>
            {derivedMaps.map((map) => (
              <Pressable
                key={map.number}
                accessibilityRole="button"
                accessibilityLabel={t("map.openIssue", { number: map.number })}
                onPress={() => onOpenMap(map.number, "map")}
              >
                <Text style={styles.meta}>
                  #{map.number} {map.title}
                </Text>
              </Pressable>
            ))}
            {derivedMapsFailed ? <Text style={styles.hint}>{t("issue.derivedMapsFailed")}</Text> : null}
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
      {/* 清单被截断 / 读失败时即使一张都没列出来也要说，不能显示成「没有子票」。 */}
      {childrenCut && childrenTotal <= children.length ? (
        <Text style={styles.hint}>
          {childrenProblem
            ? t("issue.childrenUnreadable", { reason: childrenProblem })
            : t("issue.childrenCut", { shown: children.length })}
        </Text>
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
          {isRequirement && !finalized ? (
            <PixelButton
              skin={skin}
              active
              label={t("issue.finalize")}
              disabled={!canWrite || busy || labelsMutation.isPending}
              onPress={finalizeRequirement}
            />
          ) : null}
        </View>
      ) : null}

      {/* 定稿之后才出现：没定稿就拆票，等于按一份还在改的图纸开工。 */}
      {isRequirement && !isPullRequest ? (
        <RequirementDispatchButton
          theme={theme}
          workspaceId={workspaceId}
          workspaceDir={workspaceDir}
          requirementNumber={number}
          requirementRepoKey={repoKey}
          finalized={finalized}
          disabled={!canWrite}
          onDispatched={() => {
            void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
            void queryClient.invalidateQueries({ queryKey: ["deck", "issue", workspaceDir, repoKey, kind, number] });
          }}
        />
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
                {item.author || t("common.unknown")} · {clockText(item.createdAt)}
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
