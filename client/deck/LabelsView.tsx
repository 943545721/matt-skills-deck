import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, FlatList, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { labelsColorsRpc, labelsListRpc } from "../../shared/labels";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";

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
  const [edits, setEdits] = useState<Record<string, string>>({});
  const toast = useToast();
  const queryClient = useQueryClient();

  const listLabels = useRpc(labelsListRpc);
  const setColors = useRpc(labelsColorsRpc);

  const list = useQuery({
    queryKey: ["deck", "labels", workspaceDir],
    queryFn: () => listLabels({ workspaceDir }),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (changes: { name: string; color: string }[]) => setColors({ workspaceDir, changes }),
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

  const labels = list.data?.ok ? list.data.labels : [];
  const failure = list.data && !list.data.ok ? list.data : null;
  const pending = dirtyColor(edits, labels);

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
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      action: {
        marginLeft: "auto" as const,
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
      swatch: { width: 26, height: 18 },
      name: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
      input: {
        width: 92,
        borderWidth: 2,
        borderColor: theme.colors.border,
        color: theme.colors.foreground,
        paddingVertical: 3,
        paddingHorizontal: 6,
        fontSize: 11,
      },
    }),
    [theme],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.hint}>{labels.length ? t("labels.count", { n: labels.length }) : ""}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("labels.copyPalette")}
          style={[styles.action, { marginLeft: 8 }]}
          onPress={copyPalette}
        >
          <Text style={styles.actionText}>{t("labels.copyPalette")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("labels.save")}
          style={styles.action}
          onPress={() =>
            save.mutate(Object.entries(pending).map(([name, color]) => ({ name, color })))
          }
        >
          <Text style={styles.actionText}>
            {save.isPending
              ? t("labels.saving")
              : Object.keys(pending).length
                ? t("labels.saveN", { n: Object.keys(pending).length })
                : t("labels.save")}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>{t("labels.hint")}</Text>
      {failure ? <Text style={styles.error}>{staticText(t, FAILURE_KEYS[failure.reason] ?? "failure.read")}：{failure.detail}</Text> : null}

      <FlatList
        data={labels}
        keyExtractor={(item) => item.name}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>{list.isPending ? t("common.loading") : t("labels.empty")}</Text>
        }
        renderItem={({ item }) => {
          const value = edits[item.name] ?? item.color;
          return (
            <View style={styles.row}>
              <View
                style={[styles.swatch, { backgroundColor: value ? `#${value.replace("#", "")}` : theme.colors.surface2 }]}
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
                autoCapitalize="none"
              />
            </View>
          );
        }}
      />
    </View>
  );
}
