import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { gitStatusRpc } from "../../../shared/git";
import { VersionView } from "../VersionView";
import { PixelStatusLine, usePixel } from "../pixel";
import { usePanelText } from "./panelText";

/**
 * 版本页签 = 工作树身份块 + 现有 VersionView。
 *
 * 工作树块回答「我现在站在哪个工作树、哪个分支、离远端多远」；
 * 真正的暂存 / 提交 / 拉取 / 推送仍由 `VersionView` 负责，不在这里重写第二套。
 *
 * 没有 worktree 列表 RPC：面板只知道当前工作区目录这一棵工作树。
 * 多工作树视图需要服务端提供 `git worktree list`，已在交付报告里列为缺口。
 */
export function VersionTab({
  theme,
  layout,
  workspaceDir,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
}) {
  const { t } = usePanelText();
  const skin = usePixel(theme);
  const readStatus = useRpc(gitStatusRpc);

  // 与 VersionView 共用同一个 queryKey：两处同时挂载时只发一次 git status。
  const status = useQuery({
    queryKey: ["deck", "git", workspaceDir],
    queryFn: () => readStatus({ workspaceDir }),
    staleTime: 5_000,
  });

  const branch = status.data?.ok ? status.data.branch : null;
  const files = status.data?.ok ? status.data.files : [];
  const head = status.data?.ok ? status.data.headOid.slice(0, 7) : null;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      worktree: {
        gap: 3,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: skin.colors.line,
      },
      label: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      path: {
        color: skin.colors.ink,
        fontSize: 12,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
        lineHeight: 17,
      },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10, alignItems: "center" as const },
      value: { color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily, lineHeight: 16 },
      meta: skin.statuslineText,
      error: skin.error,
    }),
    [skin],
  );

  const upstreamText = branch
    ? branch.upstreamGone
      ? t("version.upstreamGone")
      : branch.upstream || t("version.noUpstream")
    : "";

  return (
    <View style={styles.screen}>
      <View style={styles.worktree}>
        <Text style={styles.label}>{t("version.worktree")}</Text>
        <Text style={styles.path} numberOfLines={2}>
          {workspaceDir}
        </Text>
        {branch && head ? (
          <View style={styles.row}>
            <Text style={styles.value}>
              {t("version.branch")} {branch.name}
            </Text>
            <Text style={styles.value}>{head}</Text>
            <Text style={styles.value}>
              {t("version.upstream")} {upstreamText}
            </Text>
            {branch.ahead > 0 ? <Text style={styles.value}>{t("version.ahead", { n: branch.ahead })}</Text> : null}
            {branch.behind > 0 ? <Text style={styles.value}>{t("version.behind", { n: branch.behind })}</Text> : null}
            <Text style={styles.value}>
              {files.length ? t("version.changes", { n: files.length }) : t("version.clean")}
            </Text>
          </View>
        ) : status.data && !status.data.ok ? (
          <Text style={styles.error}>
            {t("version.statusFailed", { reason: status.data.reason })} — {status.data.detail}
          </Text>
        ) : (
          <Text style={styles.meta}>{t("common.loading")}</Text>
        )}
      </View>

      {status.isError ? (
        <PixelStatusLine skin={skin}>
          <Text style={styles.error}>{status.error.message}</Text>
        </PixelStatusLine>
      ) : null}

      <VersionView theme={theme} layout={layout} workspaceDir={workspaceDir} />
    </View>
  );
}
