import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  skillsDraftInstallRpc,
  skillsDraftRpc,
  skillsDraftValidateRpc,
} from "../../../shared/skills-draft.ts";
import type { PanelKey } from "../panel/panelText.tsx";
import { PixelBanner, PixelButton, PixelModalBody, usePixel } from "../pixel.tsx";
import { SessionSheet } from "../session/SessionSheet.tsx";
import type { SessionNavigation } from "../session/SessionSheet.tsx";

/**
 * 按需求生成技能。
 *
 * 这里不假装「一点就有成品」：先生成骨架和提示词，把提示词填进你选中的会话让 AI 去写，
 * 写回来再校验、再安装。三步都在界面上留痕，装进 `.claude/skills` 的那一下始终由人按下。
 */
export function SkillDraftModal({
  open,
  onOpenChange,
  theme,
  lang,
  t,
  workspaceId,
  workspaceDir,
  provider,
  navigation,
  onInstalled,
}: {
  open: boolean;
  onOpenChange(next: boolean): void;
  theme: PluginTheme;
  lang: "zh" | "en";
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  workspaceId: string;
  workspaceDir: string;
  provider: string | null;
  navigation?: SessionNavigation;
  onInstalled(): void;
}) {
  const skin = usePixel(theme);
  const toast = useToast();
  const [requirement, setRequirement] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [fillOpen, setFillOpen] = useState(false);
  /** 同名草稿已存在（服务端没覆盖）：只把「重置为骨架」这个显式动作露出来。 */
  const [exists, setExists] = useState(false);
  /** 安装时撞上的文件：列出来并给一个「覆盖冲突并安装」，不让用户看着「冲突 2」没处下手。 */
  const [conflicts, setConflicts] = useState<string[]>([]);
  /**
   * 装到哪儿。默认本项目——写进插件包等于改插件源码，必须是显式选的。
   * 两个方向都能同步：插件 → 项目是技能页的安装，项目 → 插件是技能页的回收。
   */
  const [target, setTarget] = useState<"project" | "plugin">("project");

  const draftRpc = useRpc(skillsDraftRpc);
  const validateRpc = useRpc(skillsDraftValidateRpc);
  const installRpc = useRpc(skillsDraftInstallRpc);

  const create = useMutation({
    mutationFn: (input: { overwrite?: boolean; slug?: string }) =>
      draftRpc({
        workspaceDir,
        requirement,
        lang,
        ...(name.trim() ? { name: name.trim() } : {}),
        // 「重置为骨架」明确指回那份已有的草稿：不靠「名字/需求重新算一遍 slug」碰巧算出同一个。
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.overwrite ? { overwrite: true } : {}),
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        if (result.reason === "exists") {
          // 已有草稿原样保留，但路径与提示词照样给出来：正常动作是在它上面继续改。
          setExists(true);
          setSlug(result.slug);
          setFile(result.file);
          setPrompt(result.prompt);
          setProblems(null);
          // 换草稿了：上一条草稿的安装冲突不能留在界面上，
          // 否则「覆盖冲突并安装」列的是一批文件、盖的却是另一批。
          setConflicts([]);
          toast.show(t("draft.exists"), { variant: "warning" });
          return;
        }
        toast.error(result.detail);
        return;
      }
      setExists(false);
      setSlug(result.slug);
      setFile(result.file);
      setPrompt(result.prompt);
      setProblems(null);
      setConflicts([]);
      toast.show(t("draft.created", { slug: result.slug }), { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const validate = useMutation({
    mutationFn: () => validateRpc({ workspaceDir, slug: slug ?? "" }),
    onSuccess: (result) => {
      if (!result.ok) {
        setProblems([result.detail]);
        return;
      }
      setProblems(result.problems);
      if (result.problems.length === 0) toast.show(t("draft.valid"), { variant: "success" });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const install = useMutation({
    mutationFn: (overwrite: boolean) =>
      installRpc({ workspaceDir, slug: slug ?? "", overwrite, target, lang }),
    onSuccess: (result) => {
      if (!result.ok) {
        setProblems((current) => [...(current ?? []), result.detail]);
        toast.error(result.detail);
        return;
      }
      const summary = t("draft.installSummary", {
        written: result.written.length,
        skipped: result.skipped.length,
        conflicts: result.conflicts.length,
      });
      setConflicts(result.conflicts);
      toast.show(summary, { variant: result.conflicts.length ? "warning" : "success" });
      // 插件内那份另一语言的正文还是这份，别让它看起来像已经翻好了。
      if (result.pendingTranslation.length) {
        toast.show(t("draft.pendingTranslation", { langs: result.pendingTranslation.join("、") }), { variant: "warning" });
      }
      if (result.written.length) onInstalled();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      label: skin.label,
      input: skin.input,
      inputBody: { ...skin.input, minHeight: 96 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      mono: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      prompt: {
        ...skin.docPlate,
        padding: 8,
      },
      promptText: { color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily, lineHeight: 16 },
      problem: { color: skin.colors.warnInk, fontSize: 11, fontFamily: skin.mono.fontFamily },
    }),
    [skin],
  );

  const reset = () => {
    setRequirement("");
    setName("");
    setSlug(null);
    setFile(null);
    setPrompt(null);
    setProblems(null);
    setExists(false);
    setConflicts([]);
  };

  const busy = create.isPending || validate.isPending || install.isPending;

  return (
    <>
      <Modal
        title={t("draft.title")}
        open={open}
        onOpenChange={(next) => {
          if (!next && (create.isPending || install.isPending)) return;
          onOpenChange(next);
        }}
      >
        <Modal.Content>
          <PixelModalBody skin={skin} style={styles.body}>
            <Text style={styles.label}>{t("draft.requirement")}</Text>
            <TextInput
              accessibilityLabel={t("draft.requirement")}
              style={styles.inputBody}
              value={requirement}
              onChangeText={(next) => {
                setRequirement(next);
                // 需求或名字一改，「同名草稿已存在」的那个提示就不再成立，先收起来。
                setExists(false);
                setConflicts([]);
              }}
              editable={!busy}
              placeholder={t("draft.requirementHint")}
              placeholderTextColor={skin.colors.ink2}
              multiline
            />
            <Text style={styles.label}>{t("draft.name")}</Text>
            <TextInput
              accessibilityLabel={t("draft.name")}
              style={styles.input}
              value={name}
              onChangeText={(next) => {
                setName(next);
                setExists(false);
                setConflicts([]);
              }}
              editable={!busy}
              placeholder={t("draft.nameHint")}
              placeholderTextColor={skin.colors.ink2}
              autoCapitalize="none"
            />

            <View style={styles.row}>
              <PixelButton
                skin={skin}
                label={create.isPending ? t("draft.creating") : t("draft.create")}
                disabled={busy || !requirement.trim()}
                onPress={() => create.mutate({})}
              />
              {exists ? (
                <PixelButton
                  skin={skin}
                  variant="ghost"
                  label={t("draft.overwrite")}
                  disabled={busy}
                  onPress={() => create.mutate({ overwrite: true, ...(slug ? { slug } : {}) })}
                />
              ) : null}
              <PixelButton skin={skin} variant="ghost" label={t("common.cancel")} onPress={reset} disabled={busy} />
            </View>

            {file ? (
              <Text style={styles.mono} numberOfLines={2}>
                {t("draft.file")}：{file}
              </Text>
            ) : null}

            {prompt ? (
              <>
                <Text style={styles.label}>{t("draft.promptLabel")}</Text>
                <View style={styles.prompt}>
                  <Text style={styles.promptText} numberOfLines={8}>
                    {prompt}
                  </Text>
                </View>
                <View style={styles.row}>
                  <PixelButton
                    skin={skin}
                    label={t("draft.fill")}
                    disabled={!provider}
                    onPress={() => setFillOpen(true)}
                  />
                  <PixelButton
                    skin={skin}
                    variant="ghost"
                    label={t("draft.copyPrompt")}
                    onPress={() => {
                      void copyText(prompt)
                        .then(() => toast.show(t("common.copied"), { variant: "success" }))
                        .catch(() => toast.error(t("common.copyFailed")));
                    }}
                  />
                  <PixelButton
                    skin={skin}
                    label={validate.isPending ? t("draft.validating") : t("draft.validate")}
                    disabled={busy}
                    onPress={() => validate.mutate()}
                  />
                </View>

                <Text style={styles.label}>{t("draft.target")}</Text>
                <View style={styles.row}>
                  <PixelButton
                    skin={skin}
                    variant="tab"
                    label={t("draft.targetProject")}
                    accessibilityLabel={t("draft.targetProject")}
                    active={target === "project"}
                    onPress={() => {
                      setTarget("project");
                      setConflicts([]);
                    }}
                  />
                  <PixelButton
                    skin={skin}
                    variant="tab"
                    label={t("draft.targetPlugin")}
                    accessibilityLabel={t("draft.targetPlugin")}
                    active={target === "plugin"}
                    onPress={() => {
                      setTarget("plugin");
                      setConflicts([]);
                    }}
                  />
                  <PixelButton
                    skin={skin}
                    variant="solid"
                    label={install.isPending ? t("draft.installing") : t("draft.install")}
                    disabled={busy}
                    onPress={() => install.mutate(false)}
                  />
                </View>
                <Text style={styles.mono}>
                  {target === "plugin" ? t("draft.pluginHint") : t("draft.targetHint")}
                </Text>
                {!provider ? <Text style={styles.mono}>{t("draft.noProvider")}</Text> : null}
              </>
            ) : null}

            {problems && problems.length > 0 ? (
              <PixelBanner skin={skin} tone="warning">
                <Text style={styles.label}>{t("draft.problems")}</Text>
                {problems.map((problem) => (
                  <Text key={problem} style={styles.problem}>
                    · {problem}
                  </Text>
                ))}
              </PixelBanner>
            ) : null}
            {problems && problems.length === 0 ? <Text style={styles.mono}>{t("draft.valid")}</Text> : null}

            {conflicts.length > 0 ? (
              <PixelBanner skin={skin} tone="warning">
                <Text style={styles.label}>{t("draft.installConflicts")}</Text>
                {conflicts.map((conflict) => (
                  <Text key={conflict} style={styles.problem}>
                    · {conflict}
                  </Text>
                ))}
                <View style={styles.row}>
                  <PixelButton
                    skin={skin}
                    variant="ghost"
                    label={t("draft.installOverwrite")}
                    disabled={busy}
                    onPress={() => install.mutate(true)}
                  />
                </View>
              </PixelBanner>
            ) : null}
          </PixelModalBody>
        </Modal.Content>
      </Modal>

      <SessionSheet
        open={fillOpen}
        onOpenChange={(next) => setFillOpen(next)}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={workspaceDir}
        provider={provider ?? ""}
        title={slug ? `[Skill] ${slug}` : undefined}
        action="custom"
        context={{}}
        initialPrompt={prompt ?? ""}
        defaultTarget="current"
        navigation={navigation}
      />
    </>
  );
}
