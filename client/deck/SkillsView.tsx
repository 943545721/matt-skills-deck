import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Markdown, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { skillsInstallRpc, skillsListRpc, skillsReadRpc } from "../../shared/skills";
import { useDeckText } from "./i18n";

type SkillState = "none" | "current" | "differs";

/**
 * 技能页。
 *
 * 两个语言是两件事：界面文案跟随 App 语言（`useDeckText`），技能包语言是
 * `skillLang`。它们默认一致，但可以分开——有人用中文界面读英文技能原文，
 * 这不该被强行绑在一起。
 * 这里刻意不做「自动安装」：写入会改变用户仓库里的文件，必须由人按下按钮。
 */
export function SkillsView({
  theme,
  layout,
  workspaceDir,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
}) {
  const { t, locale } = useDeckText();
  /** 技能包语言默认跟随界面语言，之后用户可以单独切。 */
  const [skillLang, setSkillLang] = useState<"zh" | "en">(locale.startsWith("zh") ? "zh" : "en");
  const [detailId, setDetailId] = useState<string | null>(null);
  const toast = useToast();

  const listSkills = useRpc(skillsListRpc);
  const installSkills = useRpc(skillsInstallRpc);
  const readSkill = useRpc(skillsReadRpc);

  const list = useQuery({
    queryKey: ["deck", "skills", skillLang, workspaceDir],
    queryFn: () => listSkills({ workspaceDir, lang: skillLang }),
  });

  const detail = useQuery({
    queryKey: ["deck", "skill", skillLang, detailId],
    queryFn: () => readSkill({ lang: skillLang, id: detailId ?? "" }),
    enabled: detailId !== null,
  });

  const install = useMutation({
    mutationFn: (ids?: string[]) => installSkills({ workspaceDir, lang: skillLang, ids }),
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

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 10 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      segmented: { flexDirection: "row" as const, borderWidth: 2, borderColor: theme.colors.border },
      segItem: { paddingVertical: 3, paddingHorizontal: 10 },
      segItemActive: { backgroundColor: theme.colors.surface2 },
      segText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      segTextActive: { color: theme.colors.foreground, fontSize: 12 },
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
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 10,
        marginBottom: 8,
        gap: 4,
      },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      name: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      badge: { fontSize: 11, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden" as const },
      description: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      modalBody: { gap: 10 },
    }),
    [theme],
  );

  const stateLabel: Record<SkillState, string> = {
    none: t("skills.state.none"),
    current: t("skills.state.current"),
    differs: t("skills.state.differs"),
  };

  const badgeStyle = (state: SkillState) => [
    styles.badge,
    {
      color: theme.colors.foreground,
      backgroundColor:
        state === "current" ? theme.colors.statusSuccess : state === "differs" ? theme.colors.statusWarning : theme.colors.surface2,
    },
  ];

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.segmented}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("skills.langZh")}
            style={[styles.segItem, skillLang === "zh" ? styles.segItemActive : null]}
            onPress={() => setSkillLang("zh")}
          >
            <Text style={skillLang === "zh" ? styles.segTextActive : styles.segText}>{t("skills.langZh")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("skills.langEn")}
            style={[styles.segItem, skillLang === "en" ? styles.segItemActive : null]}
            onPress={() => setSkillLang("en")}
          >
            <Text style={skillLang === "en" ? styles.segTextActive : styles.segText}>{t("skills.langEn")}</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("skills.installAll")}
          style={styles.action}
          onPress={() => install.mutate(undefined)}
        >
          <Text style={styles.actionText}>
            {install.isPending ? t("skills.installing") : t("skills.installAll")}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>
        {t("skills.hint", { a: ".claude/skills", b: ".agents/skills" })}
      </Text>

      {list.error ? <Text style={styles.error}>{list.error.message}</Text> : null}

      <FlatList
        data={list.data?.skills ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>{list.isPending ? t("common.loading") : t("skills.empty")}</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.id}
            style={styles.row}
            onPress={() => setDetailId(item.id)}
          >
            <View style={styles.rowHead}>
              <Text style={styles.name}>{item.id}</Text>
              <Text style={badgeStyle(item.state)}>{stateLabel[item.state]}</Text>
            </View>
            <Text style={styles.description} numberOfLines={2}>
              {item.description}
            </Text>
          </Pressable>
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
          <View style={styles.modalBody}>
            {detail.error ? <Text style={styles.error}>{detail.error.message}</Text> : null}
            {detail.data ? <Markdown>{detail.data.markdown}</Markdown> : null}
            {detailId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("skills.installOne")}
                style={styles.action}
                onPress={() => install.mutate([detailId])}
              >
                <Text style={styles.actionText}>{t("skills.installOne")}</Text>
              </Pressable>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
