import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, FlatList, Markdown, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  skillsAdoptRpc,
  skillsInstallRpc,
  skillsListRpc,
  skillsReadRpc,
  skillsRemoveRpc,
} from "../../shared/skills";
import { useDeckText } from "./i18n";
import { usePanelText } from "./panel/panelText.tsx";
import { SkillDraftModal } from "./skills-draft/SkillDraftModal.tsx";
import { PixelBanner, PixelButton, PixelCard, PixelModalBody, usePixel } from "./pixel";
import { SessionSheet } from "./session/SessionSheet.tsx";
import type { SessionNavigation } from "./session/SessionSheet.tsx";
import { useDeckWorkspaceProvider } from "./surfaces/host.tsx";

type SkillState = "none" | "current" | "differs";
type SkillClient = "claude" | "codex";

/**
 * 技能页。
 *
 * 两个语言是两件事：界面文案跟随 App 语言（`useDeckText`），技能包语言是
 * `skillLang`。它们默认一致，但可以分开——有人用中文界面读英文技能原文，
 * 这不该被强行绑在一起。
 *
 * 装进**当前项目**：`.claude/skills`（Claude 读）与 `.agents/skills`（Codex 读）由程序一起写，
 * 界面不给选择题——那是客户端各自写死的扫描路径，不是用户的决定。
 *
 * 状态仍按客户端分开显示：一个「已安装」标签说不清「Claude 能读、Codex 读不到」。
 * 这里刻意不做「自动安装」：写入会改变用户仓库里的文件，必须由人按下按钮。
 */
export function SkillsView({
  theme,
  layout,
  workspaceId,
  workspaceDir,
  navigation,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceId: string;
  workspaceDir: string;
  navigation?: SessionNavigation;
}) {
  const { t, locale } = useDeckText();
  const skin = usePixel(theme);
  /** 技能包语言默认跟随界面语言，之后用户可以单独切。 */
  const [skillLang, setSkillLang] = useState<"zh" | "en">(locale.startsWith("zh") ? "zh" : "en");
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 「全部卸载」要按两下：第一下只把按钮变成确认，5 秒后自己退回。 */
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** 由详情页转交给 SessionSheet 的技能名；非空即打开会话面板。 */
  const [injectName, setInjectName] = useState<string | null>(null);
  /** 等详情 Modal 真正关闭后，再打开会话面板；两个 Modal 不在同一批更新里切换。 */
  const [pendingSkill, setPendingSkill] = useState<string | null>(null);
  const toast = useToast();
  const provider = useDeckWorkspaceProvider(workspaceId);
  const { t: tp } = usePanelText();
  const [draftOpen, setDraftOpen] = useState(false);

  const listSkills = useRpc(skillsListRpc);
  const installSkills = useRpc(skillsInstallRpc);
  const removeSkills = useRpc(skillsRemoveRpc);
  const readSkill = useRpc(skillsReadRpc);
  const adoptSkill = useRpc(skillsAdoptRpc);

  const list = useQuery({
    queryKey: ["deck", "skills", skillLang, workspaceDir],
    queryFn: () => listSkills({ workspaceDir, lang: skillLang }),
  });

  const detail = useQuery({
    queryKey: ["deck", "skill", skillLang, detailId],
    queryFn: () => readSkill({ lang: skillLang, id: detailId ?? "" }),
    enabled: detailId !== null,
  });

  useEffect(() => {
    if (pendingSkill === null || detailId !== null) return;
    setInjectName(pendingSkill);
    setPendingSkill(null);
  }, [detailId, pendingSkill]);

  // 确认态会自动过期：切走领域、换范围都重新问一遍，不要留一个随时会误触的按钮。
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  const install = useMutation({
    mutationFn: (input?: { ids?: string[]; overwrite?: boolean }) =>
      installSkills({ workspaceDir, lang: skillLang, ids: input?.ids, overwrite: input?.overwrite }),
    onSuccess: (result) => {
      void list.refetch();
      const touched = result.written.length + result.skipped.length + result.conflicts.length;
      toast.show(
        touched
          ? t("skills.installSummary", {
              written: result.written.length,
              skipped: result.skipped.length,
              conflicts: result.conflicts.length,
            })
          : t("skills.installNothing"),
        { variant: result.conflicts.length ? "warning" : "success" },
      );
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const remove = useMutation({
    mutationFn: (ids?: string[]) => removeSkills({ workspaceDir, lang: skillLang, ids }),
    onSuccess: (result) => {
      void list.refetch();
      setConfirmRemove(false);
      const touched = result.removed.length + result.kept.length;
      toast.show(
        touched
          ? t("skills.removeSummary", { removed: result.removed.length, kept: result.kept.length })
          : t("skills.removeNothing"),
        { variant: result.kept.length ? "warning" : "success" },
      );
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  /**
   * 回收：项目里自己写的技能 → 插件包。方向与安装相反，
   * 所以放在列表下面单独一段，不混进上面的技能行里。
   */
  const adopt = useMutation({
    mutationFn: (id: string) => adoptSkill({ workspaceDir, lang: skillLang, id }),
    onSuccess: (result, id) => {
      void list.refetch();
      if (!result.ok) {
        toast.error(result.reason === "split" ? t("skills.adoptSplit") : result.detail);
        return;
      }
      toast.show(
        t("skills.adoptSummary", {
          id,
          written: result.written.length,
          skipped: result.skipped.length,
          conflicts: result.conflicts.length,
        }),
        { variant: result.conflicts.length ? "warning" : "success" },
      );
      if (result.pendingTranslation.length) {
        toast.show(t("skills.adoptPending", { langs: result.pendingTranslation.join("、") }), { variant: "warning" });
      }
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 10 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      onChecker: skin.hintOnChecker,
      row: {
        padding: 10,
        marginBottom: 8,
        gap: 4,
      },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      name: { color: skin.colors.ink, fontSize: 13, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      badge: {
        ...skin.chipText,
        fontSize: 10,
        lineHeight: 16,
        paddingHorizontal: 6,
        overflow: "hidden" as const,
        borderWidth: 1,
        borderColor: skin.colors.line,
      },
      description: { color: skin.colors.ink2, fontSize: 12, lineHeight: 17 },
      hint: skin.hint,
      error: skin.error,
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      modalBody: { gap: 10 },
      docPlate: skin.docPlate,
    }),
    [skin],
  );

  const stateLabel: Record<SkillState, string> = {
    none: t("skills.state.none"),
    current: t("skills.state.current"),
    differs: t("skills.state.differs"),
  };
  const clientLabel: Record<SkillClient, string> = {
    claude: t("skills.client.claude"),
    codex: t("skills.client.codex"),
  };

  const badgeStyle = (state: SkillState) => [
    styles.badge,
    state === "current"
      ? { backgroundColor: skin.colors.okBg, color: skin.colors.ok }
      : state === "differs"
        ? { backgroundColor: skin.colors.warnBg, color: skin.colors.warnInk }
        : { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 },
  ];

  const rows = list.data?.skills ?? [];
  const roots = list.data?.roots ?? [];
  const projectOnly = list.data?.projectOnly ?? [];
  /** 这个范围下「已经装上了」的技能数：卸载按钮只按它决定是否可点，别让空按钮可点。 */
  const installedCount = rows.filter((row) => row.states.some((entry) => entry.state === "current")).length;
  /** 详情页里这一份在项目里是否与插件版本不同：不同才给「用插件版本覆盖」。 */
  const detailDiffers = rows.some(
    (row) => row.id === detailId && row.states.some((entry) => entry.state === "differs"),
  );

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <PixelButton
          skin={skin}
          variant="tab"
          label={t("skills.langZh")}
          accessibilityLabel={t("skills.langZh")}
          active={skillLang === "zh"}
          onPress={() => setSkillLang("zh")}
        />
        <PixelButton
          skin={skin}
          variant="tab"
          label={t("skills.langEn")}
          accessibilityLabel={t("skills.langEn")}
          active={skillLang === "en"}
          onPress={() => setSkillLang("en")}
        />
        <View style={{ marginLeft: "auto" as const }} />
        <PixelButton
          skin={skin}
          variant="ghost"
          label={tp("draft.open")}
          accessibilityLabel={tp("draft.open")}
          onPress={() => setDraftOpen(true)}
        />
        <PixelButton
          skin={skin}
          label={install.isPending ? t("skills.installing") : t("skills.installAll")}
          accessibilityLabel={t("skills.installAll")}
          onPress={() => install.mutate(undefined)}
        />
        <PixelButton
          skin={skin}
          variant="ghost"
          label={
            remove.isPending
              ? t("skills.removing")
              : confirmRemove
                ? t("skills.removeConfirm", { count: installedCount })
                : t("skills.remove")
          }
          accessibilityLabel={t("skills.remove")}
          disabled={remove.isPending || installedCount === 0}
          onPress={() => {
            if (!confirmRemove) {
              setConfirmRemove(true);
              return;
            }
            remove.mutate(undefined);
          }}
        />
      </View>

      <Text style={styles.onChecker}>
        {t("skills.hint", { dirs: roots.map((root) => root.dir).join("、") || "—" })}
      </Text>

      {list.error ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>{list.error.message}</Text>
        </PixelBanner>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.onChecker}>{list.isPending ? t("common.loading") : t("skills.empty")}</Text>
        }
        ListFooterComponent={
          projectOnly.length ? (
            <View style={{ gap: 6, marginTop: 8 }}>
              <Text style={styles.onChecker}>{t("skills.projectOnlyTitle")}</Text>
              <Text style={styles.hint}>{t("skills.projectOnlyHint")}</Text>
              {projectOnly.map((item) => (
                <PixelCard key={item.id} skin={skin} style={styles.row}>
                  <View style={styles.rowHead}>
                    <Text style={styles.name}>{item.id}</Text>
                    {item.split ? (
                      <Text style={[styles.badge, { color: skin.colors.warnInk }]}>{t("skills.adoptSplit")}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.description} numberOfLines={2}>
                    {item.description}
                  </Text>
                  <View style={styles.actions}>
                    <PixelButton
                      skin={skin}
                      variant="ghost"
                      label={adopt.isPending ? t("skills.adopting") : t("skills.adopt")}
                      accessibilityLabel={t("skills.adopt")}
                      disabled={adopt.isPending || item.split}
                      onPress={() => adopt.mutate(item.id)}
                    />
                  </View>
                </PixelCard>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <PixelCard skin={skin} style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.id}
              onPress={() => setDetailId(item.id)}
            >
              <View style={styles.rowHead}>
                <Text style={styles.name}>{item.id}</Text>
                {item.states.map((entry) => (
                  <Text key={entry.client} style={badgeStyle(entry.state)}>
                    {clientLabel[entry.client]} {stateLabel[entry.state]}
                  </Text>
                ))}
              </View>
              <Text style={styles.description} numberOfLines={2}>
                {item.description}
              </Text>
            </Pressable>
          </PixelCard>
        )}
      />

      <Modal
        title={detailId ?? t("tabs.skills")}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        <Modal.Content>
          <PixelModalBody skin={skin} style={styles.modalBody}>
            {detail.error ? (
              <PixelBanner skin={skin}>
                <Text style={styles.error}>{detail.error.message}</Text>
              </PixelBanner>
            ) : null}
            {detail.data ? (
              <View style={styles.docPlate}>
                <Markdown>{detail.data.markdown}</Markdown>
              </View>
            ) : null}
            {detailId ? (
              <View style={styles.actions}>
                <PixelButton
                  skin={skin}
                  label={t("skills.installOne")}
                  accessibilityLabel={t("skills.installOne")}
                  onPress={() => install.mutate({ ids: [detailId] })}
                />
                {detailDiffers ? (
                  <PixelButton
                    skin={skin}
                    variant="ghost"
                    label={t("skills.overwriteOne")}
                    accessibilityLabel={t("skills.overwriteOne")}
                    disabled={install.isPending}
                    onPress={() => install.mutate({ ids: [detailId], overwrite: true })}
                  />
                ) : null}
                <PixelButton
                  skin={skin}
                  variant="ghost"
                  label={t("skills.removeOne")}
                  accessibilityLabel={t("skills.removeOne")}
                  disabled={remove.isPending}
                  onPress={() => remove.mutate([detailId])}
                />
                <PixelButton
                  skin={skin}
                  label={t("skills.loadOne")}
                  accessibilityLabel={t("skills.loadOne")}
                  disabled={!detail.data}
                  onPress={() => {
                    if (!detailId) return;
                    // 把 `/技能` 填进选中聊天窗口的输入框，不直接发送。
                    // 先关详情；pendingSkill 在详情真正关闭后的 effect 里再开会话面板。
                    setDetailId(null);
                    setPendingSkill(detailId);
                  }}
                />
                <PixelButton
                  skin={skin}
                  label={t("skills.copyOne")}
                  accessibilityLabel={t("skills.copyOne")}
                  disabled={!detail.data}
                  onPress={() => {
                    const text = detail.data?.markdown ?? "";
                    if (!text) return;
                    void copyText(text)
                      .then(() => toast.show(t("common.copied"), { variant: "success" }))
                      .catch(() => toast.error(t("common.copyFailed")));
                  }}
                />
              </View>
            ) : null}
          </PixelModalBody>
        </Modal.Content>
      </Modal>

      <SkillDraftModal
        open={draftOpen}
        onOpenChange={setDraftOpen}
        theme={theme}
        lang={skillLang}
        t={tp}
        workspaceId={workspaceId}
        workspaceDir={workspaceDir}
        provider={provider}
        navigation={navigation}
        onInstalled={() => void list.refetch()}
      />

      <SessionSheet
        open={injectName !== null}
        onOpenChange={(open) => {
          if (!open) setInjectName(null);
        }}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={workspaceDir}
        provider={provider ?? ""}
        title={injectName ? `[Skill] ${injectName}` : undefined}
        action="custom"
        context={{}}
        skill={injectName ?? undefined}
        navigation={navigation}
      />
    </View>
  );
}
