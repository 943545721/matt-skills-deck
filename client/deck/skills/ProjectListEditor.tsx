import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { workspaceProjectsRpc, workspaceProjectsSaveRpc } from "../../../shared/repo";
import type { SkillMode } from "../../../shared/workspace-projects";
import { useDeckText } from "../i18n";
import { PixelBanner, PixelButton, PixelModalBody, type PixelSkin } from "../pixel";

/**
 * 项目清单编辑器：面板里唯一能改「工作区有哪些项目」的地方。
 *
 * 只改三格——项目键、目录、技能模式。`repo` / `owner` / `areas` 归项目梳理与标签同步管，
 * 这里不显示也不改；服务端保存时会把旧文件里这几项按项目键原样搬过去。
 *
 * 保存带指纹：打开编辑器时读到的文件指纹一起交回去，别人在这期间改过文件就报「已被别处改过」，
 * 不会把另一份改动悄悄盖掉。
 */

type Listing = RpcOutput<typeof workspaceProjectsRpc>;
type RpcDraft = { key: string; dir: string; skillsMode: SkillMode | null };

/** 编辑中的一行：`uid` 只给 React 当 key，键名改了也不会让输入框丢焦点。 */
type DraftRow = RpcDraft & { uid: number };

let draftSeq = 0;
const nextUid = () => {
  draftSeq += 1;
  return draftSeq;
};

function toDraft(rows: Listing["projects"]): DraftRow[] {
  return rows.map((row) => ({ uid: nextUid(), key: row.key, dir: row.dir, skillsMode: row.skillsMode }));
}

export function ProjectListEditor({
  skin,
  workspaceDir,
  open,
  onOpenChange,
  onSaved,
}: {
  skin: PixelSkin;
  workspaceDir: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 保存成功后通知外层重新取数（矩阵与任务板都按这份清单分格）。 */
  onSaved: () => void;
}) {
  const { t } = useDeckText();
  const toast = useToast();
  const readProjects = useRpc(workspaceProjectsRpc);
  const saveProjects = useRpc(workspaceProjectsSaveRpc);
  const [rows, setRows] = useState<DraftRow[]>([]);
  /** 打开那一刻的指纹；保存时交回去比对。 */
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const seeded = useRef(false);

  const listing = useQuery({
    queryKey: ["deck", "workspace-projects", workspaceDir],
    queryFn: () => readProjects({ workspaceDir }),
    enabled: open,
  });

  // 每次打开都按服务端现状重铺一次草稿：编辑器不该记住上一次没保存的改动。
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (!listing.data || seeded.current) return;
    seeded.current = true;
    setRows(toDraft(listing.data.projects));
    setFingerprint(listing.data.fingerprint);
    setWarnings([]);
  }, [open, listing.data]);

  /**
   * 清单还没读回来就不许保存。
   *
   * 否则「草稿是空数组 + 没带指纹」正好绕过比对，把用户真实的清单整份替换成空清单——
   * 这是这条写入路径上最贵的一种错，宁可让按钮先灰着。
   */
  const ready = listing.data !== undefined && fingerprint !== null;

  const save = useMutation({
    mutationFn: () =>
      saveProjects({
        workspaceDir,
        projects: rows.map((row) => ({ key: row.key, dir: row.dir, skillsMode: row.skillsMode })),
        ...(fingerprint !== null ? { expectedFingerprint: fingerprint } : {}),
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.detail);
        // 冲突时只把指纹换成磁盘上那一版的：草稿留着不动，人看一眼再按一次才是覆盖。
        if (result.reason === "stale") {
          const fresh = await listing.refetch();
          if (fresh.data) setFingerprint(fresh.data.fingerprint);
        }
        return;
      }
      setFingerprint(result.fingerprint);
      setWarnings(result.warnings);
      toast.show(
        result.backup ? t("projectsEditor.savedWithBackup", { dir: result.backup }) : t("projectsEditor.saved"),
        { variant: result.warnings.length ? "warning" : "success" },
      );
      void listing.refetch();
      onSaved();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const patch = (uid: number, next: Partial<RpcDraft>) =>
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, ...next } : row)));

  const addRow = () => setRows((current) => [...current, { uid: nextUid(), key: "", dir: "", skillsMode: null }]);
  const removeRow = (uid: number) => setRows((current) => current.filter((row) => row.uid !== uid));

  /** 扫描到的仓库里还没进清单的，一键补成行：目录取目录名，键沿用同一套小写连字符规则。 */
  const missingScanned = useMemo(() => {
    const listed = new Set(rows.map((row) => row.dir.trim()));
    return (listing.data?.scanned ?? []).filter((repo) => !listed.has(repo.dir));
  }, [listing.data, rows]);

  const fillFromScan = () =>
    setRows((current) => [
      ...current,
      ...missingScanned.map((repo) => ({
        uid: nextUid(),
        key: repo.dir.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "project",
        dir: repo.dir,
        skillsMode: null,
      })),
    ]);

  const modeOptions: Array<{ value: SkillMode | null; label: string }> = [
    { value: null, label: t("projectsEditor.modeFollow") },
    { value: "unified", label: t("projectsEditor.modeUnified") },
    { value: "per-project", label: t("projectsEditor.modePerProject") },
  ];

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      hint: skin.hint,
      error: { ...skin.hint, color: skin.colors.warnInk },
      input: skin.input,
      inputNarrow: { ...skin.input, minHeight: 44 },
      row: { gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: skin.colors.line },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      label: { ...skin.label },
    }),
    [skin],
  );

  return (
    <Modal title={t("projectsEditor.title")} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <PixelModalBody skin={skin} style={styles.body}>
          <Text style={styles.hint}>{t("projectsEditor.intro")}</Text>

          {listing.data?.kind === "v1" ? <Text style={styles.hint}>{t("projectsEditor.v1Note")}</Text> : null}
          {listing.data?.kind === "none" && !listing.data.error ? (
            <Text style={styles.hint}>{t("projectsEditor.noneNote")}</Text>
          ) : null}
          {listing.data?.error ? (
            <PixelBanner skin={skin}>
              <Text style={styles.error}>{t("projectsEditor.brokenNote", { detail: listing.data.error.detail })}</Text>
            </PixelBanner>
          ) : null}

          {rows.length === 0 ? <Text style={styles.hint}>{t("projectsEditor.empty")}</Text> : null}

          {rows.map((row) => (
            <View key={row.uid} style={styles.row}>
              <TextInput
                accessibilityLabel={t("projectsEditor.colKey")}
                style={styles.inputNarrow}
                value={row.key}
                onChangeText={(value) => patch(row.uid, { key: value })}
                editable={!save.isPending}
                placeholder={t("projectsEditor.colKey")}
                placeholderTextColor={skin.colors.ink2}
              />
              <TextInput
                accessibilityLabel={t("projectsEditor.colDir")}
                style={styles.inputNarrow}
                value={row.dir}
                onChangeText={(value) => patch(row.uid, { dir: value })}
                editable={!save.isPending}
                placeholder={t("projectsEditor.colDir")}
                placeholderTextColor={skin.colors.ink2}
              />
              <View style={styles.actions}>
                {modeOptions.map((option) => (
                  <PixelButton
                    key={String(option.value)}
                    skin={skin}
                    variant="tab"
                    label={option.label}
                    active={row.skillsMode === option.value}
                    disabled={save.isPending}
                    onPress={() => patch(row.uid, { skillsMode: option.value })}
                  />
                ))}
                <PixelButton
                  skin={skin}
                  variant="ghost"
                  label={t("projectsEditor.removeRow")}
                  disabled={save.isPending}
                  onPress={() => removeRow(row.uid)}
                />
              </View>
            </View>
          ))}

          {warnings.map((warning) => (
            <Text key={warning} style={styles.hint}>
              {warning}
            </Text>
          ))}

          <View style={styles.actions}>
            <PixelButton
              skin={skin}
              variant="ghost"
              label={t("projectsEditor.addRow")}
              disabled={save.isPending}
              onPress={addRow}
            />
            {missingScanned.length ? (
              <PixelButton
                skin={skin}
                variant="ghost"
                label={t("projectsEditor.fillFromScan", { n: missingScanned.length })}
                disabled={save.isPending}
                onPress={fillFromScan}
              />
            ) : null}
          </View>

          <Text style={styles.hint} selectable>
            {t("projectsEditor.target", { dir: workspaceDir })}
          </Text>

          <View style={styles.actions}>
            <PixelButton skin={skin} label={t("common.cancel")} disabled={save.isPending} onPress={() => onOpenChange(false)} />
            <PixelButton
              skin={skin}
              label={save.isPending ? t("common.saving") : t("common.save")}
              disabled={save.isPending || !ready}
              onPress={() => save.mutate()}
            />
          </View>
        </PixelModalBody>
      </Modal.Content>
    </Modal>
  );
}
