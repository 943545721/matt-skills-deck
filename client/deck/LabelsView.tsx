import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, FlatList, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { labelsColorsRpc, labelsListRpc, labelsSyncRpc, type LabelSyncRepoResult } from "../../shared/labels";
import { repoTargetsRpc } from "../../shared/repo";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";
import { PixelBanner, PixelButton, PixelCard, usePixel } from "./pixel";

/** 只把改了颜色的标签发出去：整批发等于每点一次保存就重写几十条，白担限流的风险。 */
function dirtyColor(next: Record<string, string>, original: { name: string; color: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(next)) {
    const before = original.find((label) => label.name === name)?.color ?? "";
    const normalized = value.trim().replace(/^#/, "").toLowerCase();
    if (normalized && normalized !== before) out[name] = normalized;
  }
  return out;
}

/**
 * 标签配色页。
 *
 * 输入框里填 6 位十六进制（带不带 # 都收），失焦不改、只按「保存」才写：
 * 逐字符改色会把每次按键都变成一次 PATCH。
 */
export function LabelsView({
  theme,
  layout,
  workspaceDir,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
}) {
  const { t } = useDeckText();
  const skin = usePixel(theme);
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** 标签属于某个仓库：多仓库工作区必须选定一个，不能拿「全部」去改色。 */
  const [repoPick, setRepoPick] = useState<string | null | undefined>(undefined);
  const toast = useToast();
  const queryClient = useQueryClient();

  const listLabels = useRpc(labelsListRpc);
  const setColors = useRpc(labelsColorsRpc);
  const repoListing = useRpc(repoTargetsRpc);
  const syncAll = useRpc(labelsSyncRpc);
  /** 同步结果按仓库留一份：失败要能逐条看到，不能只在提示条里闪一下。 */
  const [syncReport, setSyncReport] = useState<LabelSyncRepoResult[] | null>(null);

  const targets = useQuery({
    queryKey: ["deck", "repo-targets", workspaceDir],
    queryFn: () => repoListing({ workspaceDir }),
    staleTime: 30_000,
  });
  const repos = targets.data?.ok ? targets.data.repos : [];
  const defaultKey = targets.data?.ok ? targets.data.defaultKey : null;
  const activeRepo = repoPick === undefined ? defaultKey : repoPick;
  const needsPick = repos.length > 1 && !activeRepo;

  const list = useQuery({
    queryKey: ["deck", "labels", workspaceDir, activeRepo ?? "auto"],
    queryFn: () => listLabels({ workspaceDir, repoKey: activeRepo ?? undefined }),
    // 多仓库且没选定时不发请求：服务端会回「需要指明仓库」，那是正常提示，不是故障。
    enabled: !targets.isPending && !needsPick,
    staleTime: 60_000,
  });

  const selectRepo = (key: string) => {
    setRepoPick(key);
    // 换了仓库就是换了一批标签：上一批未保存的颜色不能跟着带过去。
    setEdits({});
  };

  /** 选中的仓库被删掉 / 改名后回到「跟随默认」，别让页面停在失效键上。 */
  useEffect(() => {
    if (repoPick === undefined || repoPick === null || !targets.data?.ok) return;
    if (targets.data.repos.some((item) => item.key === repoPick)) return;
    setRepoPick(undefined);
    setEdits({});
  }, [repoPick, targets.data]);

  const save = useMutation({
    mutationFn: (changes: { name: string; color: string }[]) =>
      setColors({ workspaceDir, repoKey: activeRepo ?? undefined, changes }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${staticText(t, FAILURE_KEYS[result.reason] ?? "failure.read")}：${result.detail}`, { variant: "error" });
        return;
      }
      setEdits({});
      void queryClient.invalidateQueries({ queryKey: ["deck", "labels", workspaceDir] });
      void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
      const summary = [
        result.applied.length ? t("labels.done", { applied: result.applied.length }) : "",
        result.verified.length ? t("labels.verified", { n: result.verified.length }) : "",
        result.failed.length ? t("labels.failedCount", { n: result.failed.length }) : "",
        result.mismatched.length ? t("labels.mismatched", { n: result.mismatched.length }) : "",
        result.readbackFailed ? t("labels.readbackFailed") : "",
      ].filter(Boolean).join(" · ");
      const troubled = result.failed.length + result.mismatched.length > 0 || result.readbackFailed;
      toast.show(summary || t("labels.nothing"), { variant: troubled ? "warning" : "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  /**
   * 同步标签：整块工作区一次，不跟着上面选中的仓库走。
   *
   * 它是「按项目清单把标签建齐」的动作，天然是多仓库的；跟着选中仓库反而要人来回点四次。
   */
  const sync = useMutation({
    mutationFn: () => syncAll({ workspaceDir }),
    onSuccess: (result) => {
      if (!result.ok) {
        setSyncReport(null);
        toast.show(`${staticText(t, FAILURE_KEYS[result.reason] ?? "failure.read")}：${result.detail}`, { variant: "error" });
        return;
      }
      setSyncReport(result.repos);
      const created = result.repos.reduce((sum, row) => sum + row.created.length, 0);
      const existing = result.repos.reduce((sum, row) => sum + row.existing.length, 0);
      const failed = result.repos.reduce((sum, row) => sum + row.failed.length, 0) + result.repos.filter((row) => row.error).length;
      void queryClient.invalidateQueries({ queryKey: ["deck", "labels", workspaceDir] });
      toast.show(
        created === 0 && failed === 0 ? t("workspace.syncNothing") : t("workspace.syncSummary", { created, existing, failed }),
        { variant: failed ? "warning" : "success" },
      );
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const labels = list.data?.ok ? list.data.labels : [];
  const failure = list.data && !list.data.ok ? list.data : null;
  const pending = dirtyColor(edits, labels);
  // 单仓库工作区没有 `defaultKey`（根目录自己就是仓库 / 唯一子仓库），但服务端会自动选中它；
  // 只读判定要跟这个回退对齐，否则只读的单仓库仍会显示可保存。
  const activeEntry = activeRepo
    ? repos.find((item) => item.key === activeRepo)
    : repos.length === 1
      ? repos[0]
      : undefined;
  const readOnlyRepo = activeEntry?.readOnly ?? false;
  /** 没有改动、还没选仓库、或仓库只读时，保存按钮不该发一个注定被拒的请求。 */
  const canSave = Object.keys(pending).length > 0 && !needsPick && !readOnlyRepo;

  /**
   * 配色提示词：只给现状与要求，不预设答案。
   *
   * 颜色由模型按整体协调性提，但「不直接改」写死在提示词里——否则一次复制粘贴
   * 就可能让 Agent 在没有复核的情况下批量 PATCH 几十个标签。
   */
  const copyPalette = () => {
    const listing = labels
      .map((label) => `- ${label.name}: #${label.color || "??????"}${label.description ? ` — ${label.description}` : ""}`)
      .join("\n");
    void copyText(t("labels.palettePrompt", { labels: listing }))
      .then(() => toast.show(t("labels.paletteCopied"), { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      onChecker: skin.hintOnChecker,
      hint: skin.hint,
      error: skin.error,
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        padding: 8,
        marginBottom: 8,
      },
      swatch: { width: 26, height: 18, borderWidth: 1, borderColor: skin.colors.line },
      name: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, flexShrink: 1 },
      input: {
        ...skin.input,
        width: 92,
        paddingVertical: 3,
        paddingHorizontal: 6,
        fontSize: 11,
      },
    }),
    [skin],
  );

  return (
    <View style={styles.screen}>
      {/* 标签是仓库内对象：合板工作区先选仓库，读和写都落到同一个仓库。 */}
      {repos.length > 1 ? (
        <View style={styles.toolbar}>
          <Text style={styles.onChecker}>{t("labels.repoLabel")}</Text>
          {repos.map((item) => (
            <PixelButton
              key={item.key}
              skin={skin}
              mini
              variant="tab"
              label={item.name}
              accessibilityLabel={item.key}
              active={activeRepo === item.key}
              onPress={() => selectRepo(item.key)}
            />
          ))}
        </View>
      ) : null}
      {needsPick ? <Text style={styles.onChecker}>{t("labels.selectRepo")}</Text> : null}
      {readOnlyRepo ? <Text style={styles.onChecker}>{t("labels.readOnly")}</Text> : null}
      <View style={styles.toolbar}>
        <Text style={styles.onChecker}>{labels.length ? t("labels.count", { n: labels.length }) : ""}</Text>
        <View style={{ marginLeft: "auto" as const }} />
        <PixelButton
          skin={skin}
          label={t("labels.copyPalette")}
          accessibilityLabel={t("labels.copyPalette")}
          onPress={copyPalette}
        />
        <PixelButton
          skin={skin}
          label={sync.isPending ? t("workspace.syncRunning") : t("workspace.sync")}
          accessibilityLabel={t("workspace.syncHint")}
          disabled={sync.isPending}
          onPress={() => sync.mutate()}
        />
        <PixelButton
          skin={skin}
          label={
            save.isPending
              ? t("labels.saving")
              : Object.keys(pending).length
                ? t("labels.saveN", { n: Object.keys(pending).length })
                : t("labels.save")
          }
          accessibilityLabel={t("labels.save")}
          active={canSave}
          disabled={!canSave || save.isPending}
          onPress={() => {
            if (!canSave) return;
            save.mutate(Object.entries(pending).map(([name, color]) => ({ name, color })));
          }}
        />
      </View>

      <Text style={styles.onChecker}>{t("labels.hint")}</Text>
      {syncReport && syncReport.length ? (
        <View style={{ gap: 2 }}>
          {syncReport.map((row) => (
            <View key={row.key} style={{ gap: 1 }}>
              <Text style={row.error ? styles.error : styles.onChecker} numberOfLines={2}>
                {row.error
                  ? t("workspace.syncRepoError", { repo: row.key, detail: row.error })
                  : t("workspace.syncRepoLine", {
                      repo: row.repo || row.key,
                      created: row.created.length,
                      existing: row.existing.length,
                      failed: row.failed.length,
                    })}
              </Text>
              {row.failed.map((item) => (
                <Text key={item.name} style={styles.error} numberOfLines={2}>
                  {t("workspace.syncRepoError", { repo: item.name, detail: item.detail })}
                </Text>
              ))}
              {row.deprecated.length ? (
                <Text style={styles.hint}>{t("workspace.syncDeprecated", { names: row.deprecated.join("、") })}</Text>
              ) : null}
              {row.skipped.map((note) => (
                <Text key={note} style={styles.hint} numberOfLines={2}>
                  {note}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
      {failure ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>
            {staticText(t, FAILURE_KEYS[failure.reason] ?? "failure.read")}：{failure.detail}
          </Text>
        </PixelBanner>
      ) : null}

      <FlatList
        data={labels}
        keyExtractor={(item) => item.name}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.onChecker}>{list.isPending ? t("common.loading") : t("labels.empty")}</Text>
        }
        renderItem={({ item }) => {
          const value = edits[item.name] ?? item.color;
          return (
            <PixelCard skin={skin} style={styles.row}>
              <View
                style={[styles.swatch, { backgroundColor: value ? `#${value.replace("#", "")}` : skin.colors.stripe }]}
              />
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.hint, { marginLeft: "auto" as const }]} numberOfLines={1}>
                {item.description}
              </Text>
              <TextInput
                accessibilityLabel={t("labels.colorOf", { name: item.name })}
                style={styles.input}
                value={value}
                onChangeText={(next) => setEdits((current) => ({ ...current, [item.name]: next }))}
                placeholder="rrggbb"
                placeholderTextColor={skin.colors.ink2}
                autoCapitalize="none"
              />
            </PixelCard>
          );
        }}
      />
    </View>
  );
}
