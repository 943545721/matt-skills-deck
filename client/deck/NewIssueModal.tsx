import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesCreateRpc } from "../../shared/issues";
import { failureText } from "./format";
import type { Lang } from "./i18n";
import { t } from "./i18n";

/**
 * 新建票。
 *
 * 只发标题、正文、标签三样：源仓库的写路径也是这么分的（建票一步，标签另补），
 * 指派与父票留给后续阶段——现在放进来只会让这个表单变成一个填不满的问卷。
 */
export function NewIssueModal({
  theme,
  lang,
  workspaceDir,
  open,
  onClose,
}: {
  theme: PluginTheme;
  lang: Lang;
  workspaceDir: string;
  open: boolean;
  onClose(): void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [isMap, setIsMap] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();

  const createIssue = useRpc(issuesCreateRpc);
  const create = useMutation({
    mutationFn: () =>
      createIssue({
        workspaceDir,
        title: title.trim(),
        body,
        labels: labels
          .split(/[,，]/)
          .map((name) => name.trim())
          .filter(Boolean),
        isMap,
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t(lang, "new.failed")}：${failureText(lang, result.reason)} — ${result.detail}`, {
          variant: "error",
        });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
      toast.show(
        result.labelsFailed
          ? t(lang, "new.doneLabelsFailed", { number: result.number })
          : t(lang, "new.done", { number: result.number }),
        { variant: result.labelsFailed ? "warning" : "success" },
      );
      setTitle("");
      setBody("");
      setLabels("");
      setIsMap(false);
      onClose();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
        color: theme.colors.foreground,
        padding: 8,
        fontSize: 12,
      },
      inputBody: { minHeight: 120 },
      actions: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
      action: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionPrimary: { borderColor: theme.colors.accent },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      toggleActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
      toggle: {
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      toggleText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      toggleTextActive: { color: theme.colors.foreground, fontSize: 12 },
    }),
    [theme],
  );

  return (
    <Modal title={t(lang, "new.title")} open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Content>
        <View style={styles.body}>
          <TextInput
            accessibilityLabel={t(lang, "new.titleField")}
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder={t(lang, "new.titleField")}
          />
          <TextInput
            accessibilityLabel={t(lang, "new.bodyField")}
            style={[styles.input, styles.inputBody]}
            value={body}
            onChangeText={setBody}
            placeholder={t(lang, "new.bodyField")}
            multiline
          />
          <TextInput
            accessibilityLabel={t(lang, "new.labelsField")}
            style={styles.input}
            value={labels}
            onChangeText={setLabels}
            placeholder={t(lang, "new.labelsField")}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(lang, "new.markMap")}
            style={[styles.toggle, isMap ? styles.toggleActive : null]}
            onPress={() => setIsMap((value) => !value)}
          >
            <Text style={isMap ? styles.toggleTextActive : styles.toggleText}>
              {isMap ? t(lang, "new.markMapOn") : t(lang, "new.markMap")}
            </Text>
          </Pressable>

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(lang, "new.submit")}
              style={[styles.action, styles.actionPrimary]}
              onPress={() => create.mutate()}
            >
              <Text style={styles.actionText}>
                {create.isPending ? t(lang, "new.submitting") : t(lang, "new.submit")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(lang, "common.cancel")}
              style={styles.action}
              onPress={onClose}
            >
              <Text style={styles.actionText}>{t(lang, "common.cancel")}</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>{t(lang, "new.hint")}</Text>
        </View>
      </Modal.Content>
    </Modal>
  );
}
