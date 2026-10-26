import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Markdown, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { skillsInstallRpc, skillsListRpc, skillsReadRpc } from "../../shared/skills";

type Lang = "en" | "zh";
type SkillState = "none" | "current" | "differs";

const STATE_LABEL: Record<SkillState, string> = {
  none: "未安装",
  current: "已安装",
  differs: "有差异",
};

/**
 * 技能页。
 *
 * 这里刻意不做「自动安装」：写入会改变用户仓库里的文件，必须由人按下按钮并看到将写入哪些目录。
 * 语言切换只影响展示与安装内容，不改变工作区里已有的文件——已经装好的中文技能不会因为切到英文就变。
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
  const [lang, setLang] = useState<Lang>("zh");
  const [detailId, setDetailId] = useState<string | null>(null);
  const toast = useToast();

  const listSkills = useRpc(skillsListRpc);
  const installSkills = useRpc(skillsInstallRpc);
  const readSkill = useRpc(skillsReadRpc);

  const list = useQuery({
    queryKey: ["deck", "skills", lang, workspaceDir],
    queryFn: () => listSkills({ workspaceDir, lang }),
  });

  const detail = useQuery({
    queryKey: ["deck", "skill", lang, detailId],
    queryFn: () => readSkill({ lang, id: detailId ?? "" }),
    enabled: detailId !== null,
  });

  const install = useMutation({
    mutationFn: (ids?: string[]) => installSkills({ workspaceDir, lang, ids }),
    onSuccess: (result) => {
      void list.refetch();
      const parts = [
        result.written.length ? `已写入 ${result.written.length} 个` : "",
        result.skipped.length ? `跳过 ${result.skipped.length} 个` : "",
        result.conflicts.length ? `冲突 ${result.conflicts.length} 个` : "",
      ].filter(Boolean);
      toast.show(parts.join("，") || "没有需要写入的技能", {
        variant: result.conflicts.length ? "warning" : "success",
      });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 10 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      segmented: { flexDirection: "row" as const, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 999 },
      segItem: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 999 },
      segItemActive: { backgroundColor: theme.colors.surface2 },
      segText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      segTextActive: { color: theme.colors.foreground, fontSize: 12 },
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
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
        marginBottom: 8,
        gap: 4,
      },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      name: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      badge: { fontSize: 11, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, overflow: "hidden" as const },
      description: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      modalBody: { gap: 10 },
    }),
    [theme],
  );

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
            accessibilityLabel="中文技能"
            style={[styles.segItem, lang === "zh" ? styles.segItemActive : null]}
            onPress={() => setLang("zh")}
          >
            <Text style={lang === "zh" ? styles.segTextActive : styles.segText}>中文</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="English skills"
            style={[styles.segItem, lang === "en" ? styles.segItemActive : null]}
            onPress={() => setLang("en")}
          >
            <Text style={lang === "en" ? styles.segTextActive : styles.segText}>EN</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="安装全部未安装的技能"
          style={styles.action}
          onPress={() => install.mutate(undefined)}
        >
          <Text style={styles.actionText}>{install.isPending ? "安装中…" : "全部安装"}</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>
        安装会写入工作区的 {".claude/skills"} 与 {".agents/skills"}；已存在且内容不同的文件不会被覆盖。
      </Text>

      {list.error ? <Text style={styles.error}>{list.error.message}</Text> : null}

      <FlatList
        data={list.data?.skills ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>{list.isPending ? "读取中…" : "没有找到技能，检查插件包里的 templates/skills 是否完整"}</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`查看技能 ${item.id}`}
            style={styles.row}
            onPress={() => setDetailId(item.id)}
          >
            <View style={styles.rowHead}>
              <Text style={styles.name}>{item.id}</Text>
              <Text style={badgeStyle(item.state)}>{STATE_LABEL[item.state]}</Text>
            </View>
            <Text style={styles.description} numberOfLines={2}>
              {item.description}
            </Text>
          </Pressable>
        )}
      />

      <Modal
        title={detailId ?? "技能"}
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
                accessibilityLabel={`安装技能 ${detailId}`}
                style={styles.action}
                onPress={() => install.mutate([detailId])}
              >
                <Text style={styles.actionText}>安装这个技能</Text>
              </Pressable>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
