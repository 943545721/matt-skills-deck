import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  gitCheckRpc,
  gitCommitRpc,
  gitDiffRpc,
  gitFetchRpc,
  gitPullRpc,
  gitPushRpc,
  gitStageRpc,
  gitStatusRpc,
  gitUnstageRpc,
} from "../../shared/git";

type Op = "commit" | "pull" | "push" | "fetch";

const GIT_FAILURE: Record<string, string> = {
  "no-workspace": "工作区目录不可用",
  "git-missing": "没有找到 git 命令",
  "git-failed": "git 拒绝了这次操作",
  invalid: "输入不合法，没有执行",
  blocked: "现在做不了",
  "ticket-expired": "确认已失效",
  "head-moved": "仓库状态在确认后变了",
  "needs-choice": "需要先选一个远端",
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
  const [message, setMessage] = useState("");
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffStaged, setDiffStaged] = useState(false);
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

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["deck", "git", workspaceDir] });
  };

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
        toast.show(`${GIT_FAILURE[result.reason] ?? "操作失败"}：${result.detail}`, { variant: "error" });
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
      return done.ok ? { kind: "done" as const, detail: done.headAfter.slice(0, 7) } : { kind: "failed" as const, detail: `${GIT_FAILURE[done.reason] ?? "提交失败"}：${done.detail}` };
    },
    onSuccess: (result) => {
      if (result.kind === "done") {
        setMessage("");
        toast.show(`已提交 ${result.detail}`, { variant: "success" });
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
        return done.ok ? { kind: "done" as const, detail: `已取回 ${done.remote}` } : { kind: "failed" as const, detail: done.detail };
      }
      if (input.op === "pull") {
        const done = await pull({ workspaceDir, ticketId: checked.ticketId });
        if (!done.ok) return { kind: "failed" as const, detail: done.detail };
        const text = done.mode === "fast-forward" ? `已快进到 ${done.headAfter.slice(0, 7)}` : done.mode === "up-to-date" ? "已经是最新的" : "已拉取，但读不到 HEAD，结果未知";
        return { kind: "done" as const, detail: text };
      }
      const done = await push({ workspaceDir, ticketId: checked.ticketId });
      if (!done.ok) return { kind: "failed" as const, detail: done.detail };
      return {
        kind: "done" as const,
        detail: done.upToDate ? `${done.remote}/${done.branch} 已经是最新的` : `已推送 ${done.branch} → ${done.remote}`,
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

  /** 记住最后一次点的远端操作，选完远端后按同一个操作重跑。 */
  const lastOp = useRef<Exclude<Op, "commit"> | null>(null);

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
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        padding: 8,
        marginBottom: 6,
      },
      code: { color: theme.colors.foregroundMuted, fontSize: 11, width: 22 },
      path: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
      badge: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, overflow: "hidden" as const },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
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

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.head}>
          {data ? `${data.branch.name || "分离 HEAD"}${data.branch.upstream ? ` → ${data.branch.upstream}` : ""}` : "读取中…"}
        </Text>
        {data && (data.branch.ahead || data.branch.behind) ? (
          <Text style={styles.meta}>
            领先 {data.branch.ahead} · 落后 {data.branch.behind}
          </Text>
        ) : null}
        <View style={{ marginLeft: "auto" as const }} />
        <Pressable accessibilityRole="button" accessibilityLabel="刷新状态" style={styles.action} onPress={refresh}>
          <Text style={styles.actionText}>{status.isFetching ? "刷新中…" : "刷新"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="取回远端记录"
          style={styles.action}
          onPress={() => remoteMutation.mutate({ op: "fetch" })}
        >
          <Text style={styles.actionText}>取回</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="拉取远端更新"
          style={styles.action}
          onPress={() => remoteMutation.mutate({ op: "pull" })}
        >
          <Text style={styles.actionText}>拉取</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="推送到远端"
          style={styles.action}
          onPress={() => remoteMutation.mutate({ op: "push" })}
        >
          <Text style={styles.actionText}>推送</Text>
        </Pressable>
      </View>

      {choices ? (
        <View style={styles.toolbar}>
          <Text style={styles.meta}>选一个远端：</Text>
          {choices.remotes.map((remote) => (
            <Pressable
              key={remote}
              accessibilityRole="button"
              accessibilityLabel={`选择远端 ${remote}`}
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
          <Pressable accessibilityRole="button" accessibilityLabel="取消选择远端" style={styles.action} onPress={() => setChoices(null)}>
            <Text style={styles.actionText}>取消</Text>
          </Pressable>
        </View>
      ) : null}

      {failure ? <Text style={styles.error}>{GIT_FAILURE[failure.reason] ?? "读取失败"}：{failure.detail}</Text> : null}
      {status.error ? <Text style={styles.error}>{status.error.message}</Text> : null}

      {data ? (
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="暂存全部改动"
            style={styles.action}
            onPress={() => stageMutation.mutate({ paths: unstaged, stage: true })}
          >
            <Text style={styles.actionText}>全部暂存</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消全部暂存"
            style={styles.action}
            onPress={() => stageMutation.mutate({ paths: staged, stage: false })}
          >
            <Text style={styles.actionText}>全部取消暂存</Text>
          </Pressable>
          <Text style={styles.meta}>
            已暂存 {staged.length} · 未暂存 {unstaged.length}
          </Text>
        </View>
      ) : null}

      <FlatList
        data={data?.files ?? []}
        keyExtractor={(item) => item.path}
        contentContainerStyle={{ paddingBottom: 8 }}
        ListEmptyComponent={
          <Text style={styles.hint}>{status.isPending ? "读取中…" : data ? "工作区干净，没有可提交的改动。" : ""}</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.code}>{item.code}</Text>
            <Text style={styles.path} numberOfLines={1}>
              {item.path}
            </Text>
            {item.staged ? (
              <Text style={[styles.badge, { backgroundColor: theme.colors.statusSuccess, color: "#000000" }]}>已暂存</Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`查看 ${item.path} 的改动`}
              style={styles.action}
              onPress={() => {
                setDiffStaged(item.staged);
                setDiffPath(item.path);
              }}
            >
              <Text style={styles.actionText}>改动</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.staged ? `取消暂存 ${item.path}` : `暂存 ${item.path}`}
              style={styles.action}
              onPress={() => stageMutation.mutate({ paths: [item.path], stage: !item.staged })}
            >
              <Text style={styles.actionText}>{item.staged ? "取消暂存" : "暂存"}</Text>
            </Pressable>
          </View>
        )}
      />

      <View style={{ gap: 6 }}>
        <TextInput
          accessibilityLabel="提交信息"
          style={styles.input}
          value={message}
          onChangeText={setMessage}
          placeholder="提交信息（会连同已暂存的改动一起提交）"
        />
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="提交已暂存的改动"
            style={styles.action}
            onPress={() => commitMutation.mutate()}
          >
            <Text style={styles.actionText}>{commitMutation.isPending ? "提交中…" : "提交"}</Text>
          </Pressable>
          <Text style={styles.hint}>提交与推送都会先做一次预检，被挡住时会说明原因。</Text>
        </View>
      </View>

      <Modal
        title={diffPath ? `改动：${diffPath}` : "改动"}
        open={diffPath !== null}
        onOpenChange={(open) => {
          if (!open) setDiffPath(null);
        }}
      >
        <Modal.Content>
          <View style={styles.modalBody}>
            {diff.error ? <Text style={styles.error}>{diff.error.message}</Text> : null}
            {diff.data && !diff.data.ok ? <Text style={styles.error}>{GIT_FAILURE[diff.data.reason] ?? "读取失败"}：{diff.data.detail}</Text> : null}
            {diff.data?.ok ? (
              <>
                {diff.data.truncated ? <Text style={styles.hint}>改动太大，只显示前一段。</Text> : null}
                <Markdown>{diff.data.diff ? `\`\`\`diff\n${diff.data.diff}\n\`\`\`` : "_这个文件没有文本改动（可能是二进制或只改了权限）。_"}</Markdown>
              </>
            ) : diff.isPending ? (
              <Text style={styles.hint}>读取中…</Text>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
