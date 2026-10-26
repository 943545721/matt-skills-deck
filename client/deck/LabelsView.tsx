import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { labelsColorsRpc, labelsListRpc } from "../../shared/labels";
import { failureText } from "./format";
import type { Lang } from "./i18n";
import { t } from "./i18n";

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
  lang,
  workspaceDir,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  lang: Lang;
  workspaceDir: string;
}) {
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
        toast.show(`${failureText(lang, result.reason)}：${result.detail}`, { variant: "error" });
        return;
      }
      setEdits({});
      void queryClient.invalidateQueries({ queryKey: ["deck", "labels", workspaceDir] });
      void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
      const summary = [
        result.applied.length ? t(lang, "labels.done", { applied: result.applied.length }) : "",
        result.failed.length ? t(lang, "labels.failedCount", { n: result.failed.length }) : "",
      ].filter(Boolean).join(" · ");
      toast.show(summary || t(lang, "labels.nothing"), { variant: result.failed.length ? "warning" : "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const labels = list.data?.ok ? list.data.labels : [];
  const failure = list.data && !list.data.ok ? list.data : null;
  const pending = dirtyColor(edits, labels);

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
      swatch: { width: 26, height: 18, borderRadius: 4 },
      name: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
      input: {
        width: 92,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
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
        <Text style={styles.hint}>{labels.length ? t(lang, "labels.count", { n: labels.length }) : ""}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(lang, "labels.save")}
          style={styles.action}
          onPress={() =>
            save.mutate(Object.entries(pending).map(([name, color]) => ({ name, color })))
          }
        >
          <Text style={styles.actionText}>
            {save.isPending
              ? t(lang, "labels.saving")
              : Object.keys(pending).length
                ? t(lang, "labels.saveN", { n: Object.keys(pending).length })
                : t(lang, "labels.save")}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>{t(lang, "labels.hint")}</Text>
      {failure ? <Text style={styles.error}>{failureText(lang, failure.reason)}：{failure.detail}</Text> : null}

      <FlatList
        data={labels}
        keyExtractor={(item) => item.name}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>{list.isPending ? t(lang, "common.loading") : t(lang, "labels.empty")}</Text>
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
                accessibilityLabel={t(lang, "labels.colorOf", { name: item.name })}
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
