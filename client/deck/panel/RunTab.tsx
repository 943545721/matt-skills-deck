import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { gitStatusRpc } from "../../../shared/git";
import { issuesDetailRpc } from "../../../shared/issues";
import { logsRpc } from "../../../shared/logs";
import { statusRpc } from "../../../shared/status";
import { useDeckText } from "../i18n";
import { PixelButton, PixelCard, PixelHead, PixelStatusLine, usePixel } from "../pixel";
import { buildIssuePrompt } from "./issuePrompt";
import { usePanelText } from "./panelText";

/**
 * 运行页签（只读）。
 *
 * 回答「现在这个工作区跑的是什么」：插件/Node 版本、守护进程目录、gh 可用性、
 * 工作树分支、最近日志。不给安装、登录、重启这类按钮——它们需要服务端动作，
 * 现有 RPC 里没有，界面就不假装有。
 *
 * 从票面「附加到会话」推入时，附上一段 handoff 提示词。会话桥（L5）还没落地，
 * 这里只复制文本；等 `shared/session.ts` 与服务端 RPC 就位后，把复制按钮换成发送即可。
 */
export interface RunAttachment {
  repoKey: string;
  number: number;
  /** 列表里已有的标题；详情返回后以详情为准。 */
  title?: string;
  kind?: "issue" | "pull-request";
}

export function RunTab({
  theme,
  workspaceDir,
  attachment,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  attachment?: RunAttachment;
}) {
  const { t } = usePanelText();
  const { locale } = useDeckText();
  const skin = usePixel(theme);
  const toast = useToast();
  const queryClient = useQueryClient();

  const readStatus = useRpc(statusRpc);
  const readGit = useRpc(gitStatusRpc);
  const readLogs = useRpc(logsRpc);
  const readIssue = useRpc(issuesDetailRpc);

  const status = useQuery({
    queryKey: ["deck", "run-status"],
    queryFn: () => readStatus({}),
    staleTime: 30_000,
  });
  const git = useQuery({
    queryKey: ["deck", "git", workspaceDir],
    queryFn: () => readGit({ workspaceDir }),
    staleTime: 5_000,
  });
  const logs = useQuery({
    queryKey: ["deck", "logs", 20],
    queryFn: () => readLogs({ limit: 20 }),
    staleTime: 5_000,
    // 写操作在别处发生时这一页通常正开着；10 秒自取一次，不用逼用户点刷新。
    refetchInterval: 10_000,
  });
  const detail = useQuery({
    queryKey: [
      "deck",
      "issue",
      workspaceDir,
      attachment?.repoKey ?? "",
      attachment?.kind ?? "issue",
      attachment?.number ?? 0,
    ],
    queryFn: () =>
      readIssue({
        workspaceDir,
        repoKey: attachment?.repoKey,
        kind: attachment?.kind ?? "issue",
        number: attachment?.number ?? 1,
      }),
    enabled: Boolean(attachment),
  });

  const issue = detail.data?.ok ? detail.data.issue : null;
  const prompt = useMemo(
    () =>
      issue && attachment
        ? buildIssuePrompt({
            locale,
            issue,
            repoKey: attachment.repoKey,
            repoWebUrl: detail.data?.ok ? detail.data.repo.webUrl : null,
            kind: attachment.kind ?? "issue",
            mode: "attach",
          })
        : "",
    [issue, attachment, locale, detail.data],
  );

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      bar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      spacer: { marginLeft: "auto" as const },
      card: { padding: 10, gap: 5 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      label: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      value: { color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily, lineHeight: 16, flexShrink: 1 },
      title: { color: skin.colors.ink, fontSize: 13, fontWeight: "700" as const, lineHeight: 19 },
      onScreen: skin.hintOnChecker,
      hint: skin.hint,
      error: skin.error,
      prompt: {
        color: skin.colors.ink,
        fontSize: 11,
        lineHeight: 17,
        fontFamily: skin.mono.fontFamily,
        backgroundColor: skin.colors.stripe,
        padding: 8,
      },
      log: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, lineHeight: 16 },
      logError: { color: skin.colors.bad, fontSize: 11, fontFamily: skin.mono.fontFamily, lineHeight: 16 },
      logWarn: { color: skin.colors.warnInk, fontSize: 11, fontFamily: skin.mono.fontFamily, lineHeight: 16 },
      meta: skin.statuslineText,
    }),
    [skin],
  );

  const copy = (text: string) => {
    void copyText(text)
      .then(() => toast.show(t("common.copied"), { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["deck", "run-status"] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "git", workspaceDir] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "logs"] });
    if (attachment) void queryClient.invalidateQueries({ queryKey: ["deck", "issue", workspaceDir] });
  };

  const branch = git.data?.ok ? git.data.branch : null;
  const gh = status.data?.gh ?? null;
  const logRows = logs.data?.entries ?? [];

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Text style={styles.title}>{t("run.title")}</Text>
        <View style={styles.spacer} />
        <PixelButton skin={skin} label={t("common.refresh")} onPress={refreshAll} />
      </View>

      <PixelCard skin={skin}>
        <View style={styles.card}>
          <PixelHead skin={skin}>{t("run.status")}</PixelHead>
          {status.isPending ? <Text style={styles.onScreen}>{t("common.loading")}</Text> : null}
          {status.isError ? <Text style={styles.error}>{status.error.message}</Text> : null}
          {status.data ? (
            <>
              <View style={styles.row}>
                <Text style={styles.label}>{t("run.plugin")}</Text>
                <Text style={styles.value}>{status.data.pluginVersion}</Text>
                <Text style={styles.label}>{t("run.node")}</Text>
                <Text style={styles.value}>{status.data.node}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>{t("run.gh")}</Text>
                <Text style={styles.value}>
                  {gh?.available
                    ? `${t("run.ghOk")} · ${gh.version ?? gh.path ?? ""}`
                    : `${t("run.ghMissing")}${gh?.error ? ` · ${gh.error}` : ""}`}
                </Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>{t("run.daemon")}</Text>
                <Text style={styles.value}>{status.data.daemonCwd}</Text>
              </View>
            </>
          ) : null}
        </View>
      </PixelCard>

      <PixelCard skin={skin}>
        <View style={styles.card}>
          <PixelHead skin={skin}>{t("run.worktree")}</PixelHead>
          <Text style={styles.value}>{workspaceDir}</Text>
          {branch ? (
            <View style={styles.row}>
              <Text style={styles.value}>
                {t("version.branch")} {branch.name}
              </Text>
              <Text style={styles.value}>
                {t("version.upstream")}{" "}
                {branch.upstreamGone ? t("version.upstreamGone") : branch.upstream || t("version.noUpstream")}
              </Text>
              {branch.ahead > 0 ? <Text style={styles.value}>{t("version.ahead", { n: branch.ahead })}</Text> : null}
              {branch.behind > 0 ? <Text style={styles.value}>{t("version.behind", { n: branch.behind })}</Text> : null}
              <Text style={styles.value}>
                {git.data?.ok && git.data.clean
                  ? t("version.clean")
                  : t("version.changes", { n: git.data?.ok ? git.data.files.length : 0 })}
              </Text>
            </View>
          ) : git.data && !git.data.ok ? (
            <Text style={styles.error}>{git.data.detail}</Text>
          ) : null}
        </View>
      </PixelCard>

      <PixelCard skin={skin}>
        <View style={styles.card}>
          <PixelHead skin={skin}>{t("run.attached")}</PixelHead>
          {!attachment ? (
            <Text style={styles.hint}>{t("run.noSession")}</Text>
          ) : detail.isPending ? (
            <Text style={styles.onScreen}>{t("common.loading")}</Text>
          ) : detail.data && !detail.data.ok ? (
            <Text style={styles.error}>{detail.data.detail}</Text>
          ) : issue ? (
            <>
              <Text style={styles.title}>
                #{issue.number} {issue.title}
              </Text>
              <Text style={styles.hint}>{t("run.sessionNote")}</Text>
              <Text style={styles.prompt}>{prompt}</Text>
              <View style={styles.row}>
                <PixelButton skin={skin} label={t("run.copyPrompt")} onPress={() => copy(prompt)} />
              </View>
            </>
          ) : (
            <Text style={styles.hint}>{attachment.title ?? ""}</Text>
          )}
        </View>
      </PixelCard>

      <PixelCard skin={skin}>
        <View style={styles.card}>
          <PixelHead skin={skin}>{t("run.logs")}</PixelHead>
          {logs.isPending ? <Text style={styles.onScreen}>{t("common.loading")}</Text> : null}
          {logs.data && logRows.length === 0 ? (
            <Text style={styles.hint}>
              {status.data && !status.data.debugLogging ? t("run.logsOff") : t("run.noLogs")}
            </Text>
          ) : null}
          {logRows.map((entry, index) => (
            <Text
              key={`${entry.at}-${index}`}
              style={entry.level === "error" ? styles.logError : entry.level === "warn" ? styles.logWarn : styles.log}
            >
              {entry.at.slice(11, 19)} {entry.level.toUpperCase()} {entry.scope} · {entry.message}
            </Text>
          ))}
        </View>
      </PixelCard>

      <PixelStatusLine skin={skin}>
        <Text style={styles.meta}>{t("run.readOnly")}</Text>
      </PixelStatusLine>
    </View>
  );
}
