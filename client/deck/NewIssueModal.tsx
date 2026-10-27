import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesCreateRpc } from "../../shared/issues";
import { buildRequirementBody, requirementLabels, type RequirementMode } from "../../shared/requirement";
import { PixelButton, usePixel } from "./pixel";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";

/**
 * 新建票。
 *
 * 只发标题、正文、标签三样：源仓库的写路径也是这么分的（建票一步，标签另补），
 * 指派与父票留给后续阶段——现在放进来只会让这个表单变成一个填不满的问卷。
 */
export function NewIssueModal({
  theme,
  workspaceDir,
  open,
  onClose,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useDeckText();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [isMap, setIsMap] = useState(false);
  /** issue = 普通票；其余两种先铺六步骨架，探索与实施的章节不同。 */
  const [mode, setMode] = useState<"issue" | RequirementMode>("issue");
  const toast = useToast();
  const queryClient = useQueryClient();
  const skin = usePixel(theme);

  const createIssue = useRpc(issuesCreateRpc);
  const create = useMutation({
    mutationFn: () => {
      const parsed = labels
        .split(/[,，]/)
        .map((name) => name.trim())
        .filter(Boolean);
      const wanted = mode === "issue" ? parsed : [...parsed, ...requirementLabels()];
      return createIssue({
        workspaceDir,
        title: title.trim(),
        body: mode === "issue" ? body : buildRequirementBody(mode, body),
        labels: [...new Set(wanted)],
        isMap,
      });
    },
    onSuccess: (result) => {
      if (!result.ok) {
        toast.show(`${t("new.failed")}：${staticText(t, FAILURE_KEYS[result.reason] ?? "failure.read")} — ${result.detail}`, {
          variant: "error",
        });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
      toast.show(
        result.labelsFailed
          ? t("new.doneLabelsFailed", { number: result.number })
          : t("new.done", { number: result.number }),
        { variant: result.labelsFailed ? "warning" : "success" },
      );
      setTitle("");
      setBody("");
      setLabels("");
      setIsMap(false);
      setMode("issue");
      onClose();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      input: {
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        padding: 8,
        fontSize: 12,
      },
      inputBody: { minHeight: 120 },
      actions: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
    }),
    [theme, skin],
  );

  return (
    <Modal title={t("new.title")} open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Content>
        <View style={styles.body}>
          <TextInput
            accessibilityLabel={t("new.titleField")}
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder={t("new.titleField")}
          />
          <TextInput
            accessibilityLabel={t("new.bodyField")}
            style={[styles.input, styles.inputBody]}
            value={body}
            onChangeText={setBody}
            placeholder={t("new.bodyField")}
            multiline
          />
          <TextInput
            accessibilityLabel={t("new.labelsField")}
            style={styles.input}
            value={labels}
            onChangeText={setLabels}
            placeholder={t("new.labelsField")}
          />
          <View style={styles.actions}>
            <Text style={styles.hint}>{t("new.modeLabel")}</Text>
            <PixelButton skin={skin} label={t("new.modeIssue")} active={mode === "issue"} onPress={() => setMode("issue")} />
            <PixelButton skin={skin} label={t("new.modeExplore")} active={mode === "explore"} onPress={() => setMode("explore")} />
            <PixelButton skin={skin} label={t("new.modeImplement")} active={mode === "implement"} onPress={() => setMode("implement")} />
          </View>
          {mode === "issue" ? null : <Text style={styles.hint}>{t("new.modeHint")}</Text>}
          <View style={styles.actions}>
            <PixelButton
              skin={skin}
              label={isMap ? t("new.markMapOn") : t("new.markMap")}
              active={isMap}
              onPress={() => setIsMap((value) => !value)}
            />
          </View>

          <View style={styles.actions}>
            <PixelButton
              skin={skin}
              label={create.isPending ? t("new.submitting") : t("new.submit")}
              disabled={create.isPending}
              onPress={() => create.mutate()}
            />
            <PixelButton skin={skin} label={t("common.cancel")} onPress={onClose} />
          </View>
          <Text style={styles.hint}>{t("new.hint")}</Text>
        </View>
      </Modal.Content>
    </Modal>
  );
}
