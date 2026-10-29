import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { copyText, FlatList, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { EnvCheckId } from "../../shared/env";
import { envCheckRpc } from "../../shared/env";
import { logsClearRpc, logsRpc } from "../../shared/logs";
import { deckSettings } from "../../shared/settings";
import { statusRpc } from "../../shared/status";
import type { DeckKey } from "./i18n";
import { staticText, useDeckText } from "./i18n";
import { GithubAuthModal } from "./GithubAuthModal";
import { SetupGuide } from "./SetupGuide";
import { PixelBanner, PixelButton, PixelCard, usePixel } from "./pixel";

const ENV_STATUS_KEYS: Record<"ok" | "warn" | "fail" | "skip", DeckKey> = {
  ok: "diag.envStatus.ok",
  warn: "diag.envStatus.warn",
  fail: "diag.envStatus.fail",
  skip: "diag.envStatus.skip",
};

/** 检查项 id → 文案键。用显式表，漏一项编译期就报错。 */
const CHECK_KEYS: Record<EnvCheckId, DeckKey> = {
  node: "diag.checks.node",
  git: "diag.checks.git",
  gh: "diag.checks.gh",
  "gh-auth": "diag.checks.ghAuth",
  glab: "diag.checks.glab",
  "glab-auth": "diag.checks.glabAuth",
  workspace: "diag.checks.workspace",
  repo: "diag.checks.repo",
  backend: "diag.checks.backend",
  skills: "diag.checks.skills",
  labels: "diag.checks.labels",
};

/**
 * 诊断页。
 *
 * 三块按「先看结论、再看日志」排：环境检查回答「为什么用不了」，
 * 日志回答「刚才那一下发生了什么」。修复命令只复制、不代跑——
 * 装工具、登录、改远端都要用户自己确认。
 */
export function DiagnosticsView({
  theme,
  layout,
  workspaceDir,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir?: string;
}) {
  const { t } = useDeckText();
  const skin = usePixel(theme);
  const toast = useToast();
  const queryClient = useQueryClient();
  const readStatus = useRpc(statusRpc);
  const readLogs = useRpc(logsRpc);
  const clearLogs = useRpc(logsClearRpc);
  const checkEnv = useRpc(envCheckRpc);
  const settings = useSettings(deckSettings);
  const [authOpen, setAuthOpen] = useState(false);

  const status = useQuery({ queryKey: ["deck", "status"], queryFn: () => readStatus({}), staleTime: 30_000 });
  const logs = useQuery({ queryKey: ["deck", "logs"], queryFn: () => readLogs({ limit: 100 }), staleTime: 5_000 });
  const env = useQuery({
    queryKey: ["deck", "env", workspaceDir ?? ""],
    queryFn: () => checkEnv({ workspaceDir }),
    staleTime: 30_000,
  });

  const clear = useMutation({
    mutationFn: () => clearLogs({}),
    onSuccess: (result) => {
      toast.show(t("diag.cleared", { n: result.cleared }), { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["deck", "logs"] });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const debugOn = settings.status === "ready" ? settings.values.debugLogging : true;
  const toggleLogging = () => {
    if (settings.status !== "ready") return;
    void settings.save({ ...settings.values, debugLogging: !debugOn }, settings.revision).then((saved) => {
      if (!saved) toast.error(settings.saveError ?? t("diag.loggingFailed"));
    });
  };

  const copyFix = (command: string) => {
    void copyText(command)
      .then(() => toast.show(t("diag.envFixCopied"), { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      card: { padding: 10, gap: 4 },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      onChecker: skin.hintOnChecker,
      label: { color: skin.colors.ink2, fontSize: 12 },
      value: { color: skin.colors.ink, fontSize: 12, flexShrink: 1, textAlign: "right" as const },
      danger: { color: skin.colors.bad, fontSize: 12 },
      warning: { color: skin.colors.warnInk, fontSize: 12 },
      success: { color: skin.colors.ok, fontSize: 12 },
      muted: { color: skin.colors.ink2, fontSize: 12 },
      hint: skin.hint,
      head: { ...skin.head, fontSize: 13 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      checkRow: {
        borderTopWidth: 2,
        borderTopColor: skin.colors.stripe,
        paddingVertical: 6,
        gap: 2,
      },
      checkHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      checkName: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, flexShrink: 1 },
      logRow: {
        borderTopWidth: 2,
        borderTopColor: skin.colors.stripe,
        paddingVertical: 5,
        gap: 2,
      },
      logHead: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      logMessage: { fontSize: 12, color: skin.colors.ink },
    }),
    [skin],
  );

  const statusStyle = (value: "ok" | "warn" | "fail" | "skip") =>
    value === "ok" ? styles.success : value === "warn" ? styles.warning : value === "fail" ? styles.danger : styles.muted;

  const entries = logs.data?.entries ?? [];
  const asText = entries
    .map((entry) => `${entry.at} [${entry.level}] ${entry.scope}: ${entry.message}`)
    .join("\n");

  return (
    <View style={styles.screen}>
      <PixelCard skin={skin} style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>{t("diag.pluginVersion")}</Text>
          <Text style={styles.value}>{status.data?.pluginVersion ?? t("common.loading")}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Node</Text>
          <Text style={styles.value}>{status.data?.node ?? t("common.loading")}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>{t("diag.daemonCwd")}</Text>
          <Text style={styles.value} numberOfLines={2}>
            {status.data?.daemonCwd ?? t("common.loading")}
          </Text>
        </View>
      </PixelCard>

      <View style={styles.toolbar}>
        <Text style={[styles.head, { color: skin.colors.tabInk }]}>{t("diag.env")}</Text>
        {env.data ? (
          <Text style={styles.onChecker}>
            {t("diag.envBackend")}: {env.data.backend}
          </Text>
        ) : null}
        <View style={{ marginLeft: "auto" as const }} />
        <PixelButton
          skin={skin}
          label={env.isFetching ? t("diag.envRunning") : t("diag.envRun")}
          accessibilityLabel={t("diag.envRun")}
          onPress={() => void env.refetch()}
        />
      </View>

      <PixelCard skin={skin} style={styles.card}>
        {env.data ? (
          <>
            <Text style={styles.label}>
              {t("diag.envCheckedAt", { time: env.data.checkedAt.slice(11, 19) })}
            </Text>
            {env.data.checks.map((check) => (
              <View key={check.id} style={styles.checkRow}>
                <View style={styles.checkHead}>
                  <Text style={[styles.checkName, statusStyle(check.status)]}>
                    {staticText(t, ENV_STATUS_KEYS[check.status])}
                  </Text>
                  <Text style={styles.checkName}>{staticText(t, CHECK_KEYS[check.id])}</Text>
                  {check.fix ? (
                    <PixelButton
                      skin={skin}
                      label={t("diag.envFix")}
                      accessibilityLabel={`${t("diag.envFix")}: ${check.fix}`}
                      mini
                      onPress={() => copyFix(check.fix ?? "")}
                    />
                  ) : null}
                  {(check.id === "gh" || check.id === "gh-auth") && check.status === "fail" ? (
                    <PixelButton
                      skin={skin}
                      label={t("auth.title")}
                      accessibilityLabel={t("auth.title")}
                      mini
                      onPress={() => setAuthOpen(true)}
                    />
                  ) : null}
                </View>
                <Text style={styles.hint}>{check.detail}</Text>
                {check.fix ? <Text style={styles.muted}>{check.fix}</Text> : null}
              </View>
            ))}
          </>
        ) : (
          <Text style={styles.hint}>{env.isPending ? t("diag.envRunning") : t("diag.envRun")}</Text>
        )}
        {env.error ? <Text style={styles.danger}>{env.error.message}</Text> : null}
      </PixelCard>

      <SetupGuide theme={theme} />

      <View style={styles.toolbar}>
        <Text style={styles.onChecker}>{t("diag.logging")}</Text>
        <PixelButton
          skin={skin}
          label={settings.saving ? t("diag.loggingSaving") : debugOn ? t("common.on") : t("common.off")}
          accessibilityLabel={t("diag.loggingHint")}
          active={debugOn}
          onPress={toggleLogging}
        />
        {!debugOn ? <Text style={styles.onChecker}>{t("diag.loggingOff")}</Text> : null}
      </View>

      <View style={styles.toolbar}>
        <Text style={styles.onChecker}>{t("diag.recent")}</Text>
        <View style={{ marginLeft: "auto" as const }} />
        <PixelButton
          skin={skin}
          label={logs.isFetching ? t("common.refreshing") : t("common.refresh")}
          accessibilityLabel={t("diag.refreshHint")}
          onPress={() => void logs.refetch()}
        />
        <PixelButton
          skin={skin}
          label={t("common.copy")}
          accessibilityLabel={t("diag.copyLogs")}
          onPress={() => {
            void copyText(asText || "—")
              .then(() => toast.show(t("diag.logsCopied"), { variant: "success" }))
              .catch(() => toast.error(t("common.copyFailed")));
          }}
        />
        <PixelButton
          skin={skin}
          label={t("diag.clear")}
          accessibilityLabel={t("diag.clear")}
          onPress={() => clear.mutate()}
        />
      </View>
      <Text style={styles.onChecker}>{t("diag.exportHint")}</Text>
      {settings.saveError ? (
        <PixelBanner skin={skin}>
          <Text style={styles.danger}>{settings.saveError}</Text>
        </PixelBanner>
      ) : null}

      <FlatList
        data={entries}
        keyExtractor={(item, index) => `${item.at}-${index}`}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.onChecker}>{logs.isPending ? t("common.loading") : t("diag.empty")}</Text>
        }
        renderItem={({ item }) => (
          <PixelCard skin={skin} style={styles.card}>
            <View style={styles.logRow}>
              <Text style={styles.logHead}>
                {item.at.slice(11, 19)} · {item.scope} · {item.level}
              </Text>
              <Text style={[styles.logMessage, item.level === "error" ? styles.danger : null]}>{item.message}</Text>
            </View>
          </PixelCard>
        )}
      />

      <GithubAuthModal theme={theme} open={authOpen} onClose={() => setAuthOpen(false)} />
    </View>
  );
}
