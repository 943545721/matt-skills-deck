import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, FlatList, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  gitCheckRpc,
  gitCommitRpc,
  gitDiffRpc,
  gitFetchRpc,
  gitLogRpc,
  gitPullRpc,
  gitPushRpc,
  gitStageRpc,
  gitStatusRpc,
  gitUnstageRpc,
} from "../../shared/git";
import type { DeckKey } from "./i18n";
import { staticText, useDeckText } from "./i18n";

type Op = "commit" | "pull" | "push" | "fetch";

/** 失败原因码 → 文案键。用显式表而不是拼字符串，拼错了编译期就能发现。 */
const GIT_FAILURE_KEYS: Record<string, DeckKey> = {
  "no-workspace": "version.failure.no-workspace",
  "git-missing": "version.failure.git-missing",
  "git-failed": "version.failure.git-failed",
  invalid: "version.failure.invalid",
  blocked: "version.failure.blocked",
  "ticket-expired": "version.failure.ticket-expired",
  "head-moved": "version.failure.head-moved",
  "needs-choice": "version.failure.needs-choice",
};

/**
 * 版本管理页。
 *
 * 写操作全部先过 `deck.git.check` 再执行：预检会告诉我们「现在能不能做、推到哪」，
 * 并把当时的 HEAD 与索引指纹记进票据。用户中途切走再回来，票已过期，写不出去。
 * 这条链路比「点一下就推」慢一步，但慢的这一步正是防止「推错分支」的那一步。
 */
export function VersionView({
  theme,
  layout,
  workspaceDir,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
}) {
  const { t } = useDeckText();
  const [message, setMessage] = useState("");
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffStaged, setDiffStaged] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 多远端时让用户点一个：不替人选，也不让人手打远端名。 */
  const [choices, setChoices] = useState<{ op: Exclude<Op, "commit">; remotes: string[] } | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();

  const readStatus = useRpc(gitStatusRpc);
  const stage = useRpc(gitStageRpc);
  const unstage = useRpc(gitUnstageRpc);
  const check = useRpc(gitCheckRpc);
  const commit = useRpc(gitCommitRpc);
  const pull = useRpc(gitPullRpc);
  const fetchRemote = useRpc(gitFetchRpc);
  const push = useRpc(gitPushRpc);
  const readDiff = useRpc(gitDiffRpc);
  const readLog = useRpc(gitLogRpc);

  const failureTextOf = (reason: string) => staticText(t, GIT_FAILURE_KEYS[reason] ?? "version.failure.git-failed");

  const status = useQuery({
    queryKey: ["deck", "git", workspaceDir],
    queryFn: () => readStatus({ workspaceDir }),
    staleTime: 5_000,
  });

  const diff = useQuery({
    queryKey: ["deck", "git-diff", workspaceDir, diffPath, diffStaged],
    queryFn: () => readDiff({ workspaceDir, path: diffPath ?? "", staged: diffStaged }),
    enabled: diffPath !== null,
  });

  const history = useQuery({
    queryKey: ["deck", "git-log", workspaceDir],
    queryFn: () => readLog({ workspaceDir, limit: 20 }),
    enabled: historyOpen,
    staleTime: 10_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["deck", "git", workspaceDir] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "git-log", workspaceDir] });
  };

  /** 记住最后一次点的远端操作，选完远端后按同一个操作重跑。 */
  const lastOp = useRef<Exclude<Op, "commit"> | null>(null);

  const stageMutation = useMutation({
    // 两条 RPC 的失败形状一致、成功形状不同（staged / unstaged），在这里归一成「做成了没」。
    mutationFn: async (input: { paths: string[]; stage: boolean }): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> => {
      const result = input.stage
        ? await stage({ workspaceDir, paths: input.paths })
        : await unstage({ workspaceDir, paths: input.paths });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason, detail: result.detail };
    },
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${failureTextOf(result.reason)}：${result.detail}`, { variant: "error" });
        return;
      }
      refresh();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const commitMutation = useMutation({
    mutationFn: async () => {
      const checked = await check({ workspaceDir, op: "commit" });
      if (!checked.ok) return { kind: "blocked" as const, detail: checked.detail };
      const done = await commit({ workspaceDir, ticketId: checked.ticketId, message });
      return done.ok
        ? { kind: "done" as const, detail: done.headAfter.slice(0, 7) }
        : { kind: "failed" as const, detail: `${failureTextOf(done.reason)}：${done.detail}` };
    },
    onSuccess: (result) => {
      if (result.kind === "done") {
        setMessage("");
        toast.show(t("version.committed", { sha: result.detail }), { variant: "success" });
        refresh();
        return;
      }
      toast.show(result.detail, { variant: result.kind === "blocked" ? "warning" : "error" });
    },
  });

  const remoteMutation = useMutation({
    mutationFn: async (input: { op: Exclude<Op, "commit">; remote?: string }) => {
      lastOp.current = input.op;
      const checked = await check({ workspaceDir, op: input.op, remote: input.remote });
      if (!checked.ok) {
        return {
          kind: "failed" as const,
          detail: checked.detail,
          candidates: checked.reason === "needs-choice" ? checked.candidates ?? [] : undefined,
        };
      }
      if (input.op === "fetch") {
        const done = await fetchRemote({ workspaceDir, ticketId: checked.ticketId });
        return done.ok
          ? { kind: "done" as const, detail: t("version.fetched", { remote: done.remote }) }
          : { kind: "failed" as const, detail: `${failureTextOf(done.reason)}：${done.detail}` };
      }
      if (input.op === "pull") {
        const done = await pull({ workspaceDir, ticketId: checked.ticketId });
        if (!done.ok) return { kind: "failed" as const, detail: `${failureTextOf(done.reason)}：${done.detail}` };
        const text =
          done.mode === "fast-forward"
            ? t("version.pulled", { sha: done.headAfter.slice(0, 7) })
            : done.mode === "up-to-date"
              ? t("version.upToDate")
              : t("version.pullUnknown");
        return { kind: "done" as const, detail: text };
      }
      const done = await push({ workspaceDir, ticketId: checked.ticketId });
      if (!done.ok) return { kind: "failed" as const, detail: `${failureTextOf(done.reason)}：${done.detail}` };
      return {
        kind: "done" as const,
        detail: done.upToDate
          ? t("version.pushUpToDate", { remote: done.remote, branch: done.branch })
          : t("version.pushed", { branch: done.branch, remote: done.remote }),
      };
    },
    onSuccess: (result) => {
      if (result.candidates?.length) {
        setChoices({ op: lastOp.current ?? "push", remotes: result.candidates });
        return;
      }
      toast.show(result.detail, { variant: result.kind === "done" ? "success" : "error" });
      if (result.kind === "done") refresh();
    },
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 8 },
      head: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      action: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surface2,
        borderWidth: 2,
        borderColor: theme.colors.border,
      },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 8,
        marginBottom: 6,
      },
      code: { color: theme.colors.foregroundMuted, fontSize: 11, width: 22 },
      path: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
      badge: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden" as const },
      input: {
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        padding: 8,
        fontSize: 12,
      },
      modalBody: { gap: 8 },
    }),
    [theme],
  );

  const data = status.data?.ok ? status.data : null;
  const failure = status.data && !status.data.ok ? status.data : null;
  const staged = data?.files.filter((file) => file.staged).map((file) => file.path) ?? [];
  const unstaged = data?.files.filter((file) => !file.staged).map((file) => file.path) ?? [];

  /**
   * AI 交接：把「现在仓库是什么状态」写成一段可以直接粘给 Agent 的上下文。
   *
   * 历史按需拉取：只在用户按下按钮时才跑 `git log`，不给每次打开版本页都加一次子进程。
   * 拉不到历史也照样给交接（标注为空），不让一个次要读取失败挡掉主要信息。
   */
  const copyHandoff = async () => {
    let commits = history.data?.ok ? history.data.commits : [];
    if (!history.data) {
      const fresh = await history.refetch();
      commits = fresh.data?.ok ? fresh.data.commits : [];
    }
    const branch = data
      ? `${data.branch.name || t("version.detached")}${data.branch.upstream ? ` → ${data.branch.upstream}` : ""}`
      : t("version.detached");
    const files = data?.files.length
      ? data.files.map((file) => `- ${file.code} ${file.path}${file.staged ? " (staged)" : ""}`).join("\n")
      : t("version.clean");
    const commitText = commits.length
      ? commits.map((entry) => `- ${entry.short} ${entry.subject}`).join("\n")
      : t("version.historyEmpty");
    await copyText(t("version.handoffPrompt", { branch, files, commits: commitText }))
      .then(() => toast.show(t("version.handoffCopied"), { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.head}>
          {data
            ? `${data.branch.name || t("version.detached")}${data.branch.upstream ? ` → ${data.branch.upstream}` : ""}`
            : t("common.loading")}
        </Text>
        {data && (data.branch.ahead || data.branch.behind) ? (
          <Text style={styles.meta}>
            {t("version.ahead", { n: data.branch.ahead })} · {t("version.behind", { n: data.branch.behind })}
          </Text>
        ) : null}
        <View style={{ marginLeft: "auto" as const }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.refresh")}
          style={styles.action}
          onPress={refresh}
        >
          <Text style={styles.actionText}>
            {status.isFetching ? t("common.refreshing") : t("common.refresh")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("version.fetch")}
          style={styles.action}
          onPress={() => remoteMutation.mutate({ op: "fetch" })}
        >
          <Text style={styles.actionText}>{t("version.fetch")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("version.pull")}
          style={styles.action}
          onPress={() => remoteMutation.mutate({ op: "pull" })}
        >
          <Text style={styles.actionText}>{t("version.pull")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("version.push")}
          style={styles.action}
          onPress={() => remoteMutation.mutate({ op: "push" })}
        >
          <Text style={styles.actionText}>{t("version.push")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("version.history")}
          style={styles.action}
          onPress={() => setHistoryOpen(true)}
        >
          <Text style={styles.actionText}>{t("version.history")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("version.handoff")}
          style={styles.action}
          onPress={() => void copyHandoff()}
        >
          <Text style={styles.actionText}>{t("version.handoff")}</Text>
        </Pressable>
      </View>

      {choices ? (
        <View style={styles.toolbar}>
          <Text style={styles.meta}>{t("version.chooseRemote")}</Text>
          {choices.remotes.map((remote) => (
            <Pressable
              key={remote}
              accessibilityRole="button"
              accessibilityLabel={t("version.chooseRemoteHint", { name: remote })}
              style={styles.action}
              onPress={() => {
                const picked = choices;
                setChoices(null);
                remoteMutation.mutate({ op: picked.op, remote });
              }}
            >
              <Text style={styles.actionText}>{remote}</Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.cancel")}
            style={styles.action}
            onPress={() => setChoices(null)}
          >
            <Text style={styles.actionText}>{t("common.cancel")}</Text>
          </Pressable>
        </View>
      ) : null}

      {failure ? (
        <Text style={styles.error}>
          {failureTextOf(failure.reason)}：{failure.detail}
        </Text>
      ) : null}
      {status.error ? <Text style={styles.error}>{status.error.message}</Text> : null}

      {data ? (
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("version.stageAll")}
            style={styles.action}
            onPress={() => stageMutation.mutate({ paths: unstaged, stage: true })}
          >
            <Text style={styles.actionText}>{t("version.stageAll")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("version.unstageAll")}
            style={styles.action}
            onPress={() => stageMutation.mutate({ paths: staged, stage: false })}
          >
            <Text style={styles.actionText}>{t("version.unstageAll")}</Text>
          </Pressable>
          <Text style={styles.meta}>
            {t("version.staged", { n: staged.length })} · {t("version.unstaged", { n: unstaged.length })}
          </Text>
        </View>
      ) : null}

      <FlatList
        data={data?.files ?? []}
        keyExtractor={(item) => item.path}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 8 }}
        ListEmptyComponent={
          <Text style={styles.hint}>
            {status.isPending ? t("common.loading") : data ? t("version.clean") : ""}
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.code}>{item.code}</Text>
            <Text style={styles.path} numberOfLines={1}>
              {item.path}
            </Text>
            {item.staged ? (
              <Text style={[styles.badge, { backgroundColor: theme.colors.statusSuccess, color: "#000000" }]}>
                {t("version.stagedBadge")}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t("version.diff")} ${item.path}`}
              style={styles.action}
              onPress={() => {
                setDiffStaged(item.staged);
                setDiffPath(item.path);
              }}
            >
              <Text style={styles.actionText}>{t("version.diff")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.staged ? t("version.unstage") : t("version.stage")} ${item.path}`}
              style={styles.action}
              onPress={() => stageMutation.mutate({ paths: [item.path], stage: !item.staged })}
            >
              <Text style={styles.actionText}>
                {item.staged ? t("version.unstage") : t("version.stage")}
              </Text>
            </Pressable>
          </View>
        )}
      />

      <View style={{ gap: 6 }}>
        <TextInput
          accessibilityLabel={t("version.messagePlaceholder")}
          style={styles.input}
          value={message}
          onChangeText={setMessage}
          placeholder={t("version.messagePlaceholder")}
        />
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("version.commit")}
            style={styles.action}
            onPress={() => commitMutation.mutate()}
          >
            <Text style={styles.actionText}>
              {commitMutation.isPending ? t("version.committing") : t("version.commit")}
            </Text>
          </Pressable>
          <Text style={styles.hint}>{t("version.hint")}</Text>
        </View>
      </View>

      <Modal
        title={t("version.historyTitle")}
        open={historyOpen}
        onOpenChange={(open) => {
          if (!open) setHistoryOpen(false);
        }}
      >
        <Modal.Content>
          <View style={styles.modalBody}>
            {history.error ? <Text style={styles.error}>{history.error.message}</Text> : null}
            {history.data && !history.data.ok ? (
              <Text style={styles.error}>{failureTextOf(history.data.reason)}：{history.data.detail}</Text>
            ) : null}
            {history.data?.ok ? (
              history.data.commits.length ? (
                history.data.commits.map((entry) => (
                  <View key={entry.oid} style={styles.row}>
                    <Text style={styles.code}>{entry.short}</Text>
                    <View style={{ flexShrink: 1 }}>
                      <Text style={styles.path} numberOfLines={2}>
                        {entry.subject}
                      </Text>
                      <Text style={styles.meta}>
                        {entry.author} · {entry.date.slice(0, 10)}
                      </Text>
                    </View>
                  </View>
                ))
              ) : (
                <Text style={styles.hint}>{t("version.historyEmpty")}</Text>
              )
            ) : history.isPending ? (
              <Text style={styles.hint}>{t("common.loading")}</Text>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title={diffPath ? t("version.diffTitle", { path: diffPath }) : t("version.diff")}
        open={diffPath !== null}
        onOpenChange={(open) => {
          if (!open) setDiffPath(null);
        }}
      >
        <Modal.Content>
          <View style={styles.modalBody}>
            {diff.error ? <Text style={styles.error}>{diff.error.message}</Text> : null}
            {diff.data && !diff.data.ok ? (
              <Text style={styles.error}>
                {failureTextOf(diff.data.reason)}：{diff.data.detail}
              </Text>
            ) : null}
            {diff.data?.ok ? (
              <>
                {diff.data.truncated ? <Text style={styles.hint}>{t("version.diffTruncated")}</Text> : null}
                <Markdown>
                  {diff.data.diff ? `\`\`\`diff\n${diff.data.diff}\n\`\`\`` : t("version.diffEmpty")}
                </Markdown>
              </>
            ) : diff.isPending ? (
              <Text style={styles.hint}>{t("common.loading")}</Text>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
