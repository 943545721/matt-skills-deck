import type { RpcOutput } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { SkillMode } from "../../../shared/workspace-projects";
import { skillsInstallRpc, skillsListRpc } from "../../../shared/skills";
import { useDeckText } from "../i18n";
import type { PixelSkin } from "../pixel";
import { PixelButton } from "../pixel";

/**
 * 技能矩阵：行是项目，列是 `.claude` / `.agents`。
 *
 * 每一格只有四句话——一致 / 有差异 / 有缺失 / 未安装——加上「几份一致、几份不同」的计数，
 * 让人一眼看出是哪个项目过期、哪个项目根本没装。故意不在这里放「装这一格」的按钮：
 * 单格覆盖要看清楚是哪份技能先，页面下半部的逐个技能列表才是干这个的地方。
 *
 * 「全部更新」与技能页的「全部安装」走同一条 RPC：模式决定是备份→清理→装，
 * 还是只补缺失。会改哪些目录写在按钮旁边，按之前就知道后果。
 */

type MatrixRow = RpcOutput<typeof skillsListRpc>["projects"][number];
type InstallReport = RpcOutput<typeof skillsInstallRpc>;
type CellStatus = MatrixRow["cells"][number]["status"];

export function SkillMatrix({
  skin,
  rows,
  workspaceMode,
  notes,
  report,
  pending,
  onUpdateAll,
}: {
  skin: PixelSkin;
  rows: MatrixRow[];
  workspaceMode: SkillMode;
  notes: string[];
  /** 上一次「全部更新」的逐项目结果；没更新过时为 null。 */
  report: InstallReport | null;
  pending: boolean;
  onUpdateAll: () => void;
}) {
  const { t } = useDeckText();

  const modeLabel: Record<SkillMode, string> = {
    unified: t("skillsMode.modeUnified"),
    "per-project": t("skillsMode.modePerProject"),
  };
  const statusLabel: Record<CellStatus, string> = {
    current: t("skillsMode.stateCurrent"),
    differs: t("skillsMode.stateDiffers"),
    missing: t("skillsMode.stateMissing"),
    none: t("skillsMode.stateNone"),
  };
  const clientLabel: Record<string, string> = { claude: "Claude", codex: "Codex" };

  const statusTone = (status: CellStatus) => [
    skin.chip,
    skin.chipText,
    status === "current"
      ? { backgroundColor: skin.colors.okBg, color: skin.colors.ok }
      : status === "none"
        ? { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 }
        : { backgroundColor: skin.colors.warnBg, color: skin.colors.warnInk },
  ];

  /** 这次更新会落到哪些目录：按当前模式覆盖到的范围，逐条写出来。 */
  const scopeDirs = rows
    .filter((row) => row.exists)
    .flatMap((row) => row.cells.map((cell) => cell.dir));

  return (
    <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 20 }}>
      <Text style={skin.hintOnChecker}>{t("skillsMode.matrixHint")}</Text>

      <View style={{ borderBottomWidth: 1, borderBottomColor: skin.colors.line, flexDirection: "row", gap: 8, paddingBottom: 4 }}>
        <Text style={[skin.label, { flex: 1.6 }]}>{t("skillsMode.colProject")}</Text>
        {["claude", "codex"].map((client) => (
          <Text key={client} style={[skin.label, { flex: 1 }]}>
            {clientLabel[client]}
          </Text>
        ))}
        <Text style={[skin.label, { flex: 1.2 }]}>{t("skillsMode.colMode")}</Text>
      </View>

      {rows.map((row) => (
        <View
          key={row.key}
          style={{ borderBottomWidth: 1, borderBottomColor: skin.colors.line, flexDirection: "row", gap: 8, paddingBottom: 8 }}
        >
          <View style={{ flex: 1.6, gap: 2 }}>
            <Text style={{ color: skin.colors.ink, fontSize: 13, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily }}>
              {row.key}
            </Text>
            <Text style={skin.hint} numberOfLines={1}>
              {row.dir}
            </Text>
            {row.problem ? (
              <Text style={skin.error}>{t("skillsMode.projectProblem", { problem: row.problem })}</Text>
            ) : null}
          </View>

          {row.cells.map((cell) => (
            <View key={cell.client} style={{ flex: 1, gap: 2 }}>
              <Text style={statusTone(cell.status)} numberOfLines={1}>
                {statusLabel[cell.status]}
              </Text>
              <Text style={skin.hint}>{t("skillsMode.cellCount", { current: cell.current, total: cell.total })}</Text>
              {cell.differs.length ? (
                <Text style={skin.hint}>{t("skillsMode.cellDiffers", { n: cell.differs.length })}</Text>
              ) : null}
              {cell.missing.length ? (
                <Text style={skin.hint}>{t("skillsMode.cellMissing", { n: cell.missing.length })}</Text>
              ) : null}
            </View>
          ))}

          <View style={{ flex: 1.2, gap: 2 }}>
            <Text style={{ color: skin.colors.ink2, fontSize: 12 }}>{modeLabel[row.mode]}</Text>
            <Text style={skin.hint}>
              {row.modeSource === "project" ? t("skillsMode.modeFromProject") : t("skillsMode.modeFromWorkspace")}
            </Text>
          </View>
        </View>
      ))}

      {notes.map((note) => (
        <Text key={note} style={skin.hint}>
          {note}
        </Text>
      ))}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>
        <PixelButton
          skin={skin}
          label={pending ? t("skillsMode.updatingAll") : t("skillsMode.updateAll")}
          accessibilityLabel={t("skillsMode.updateAll")}
          disabled={pending || scopeDirs.length === 0}
          onPress={onUpdateAll}
        />
        <Text style={skin.hint}>
          {t("skillsMode.updateHint", { mode: modeLabel[workspaceMode] })}
        </Text>
      </View>
      <Text style={skin.hint} selectable={scopeDirs.length > 0}>
        {scopeDirs.length ? t("skillsMode.willWrite", { dirs: scopeDirs.join("、") }) : t("skillsMode.nothingToWrite")}
      </Text>

      {report ? (
        <View style={{ gap: 6, paddingTop: 6 }}>
          <Text style={skin.head}>{t("skillsMode.resultTitle")}</Text>
          {report.projects.map((project) => (
            <View key={project.key} style={{ gap: 2, paddingVertical: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Text style={{ color: skin.colors.ink, fontSize: 13, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily }}>
                  {project.key}
                </Text>
                <Text style={[skin.chip, skin.chipText]}>{modeLabel[project.mode]}</Text>
                {project.status === "skipped" ? (
                  <Text style={skin.error}>{t("skillsMode.projectSkipped", { reason: project.reason ?? "" })}</Text>
                ) : null}
                {project.status === "failed" ? (
                  <Text style={skin.error}>{t("skillsMode.projectFailed", { reason: project.reason ?? "" })}</Text>
                ) : null}
              </View>
              {project.cells.map((cell) => (
                <Text key={cell.client} style={{ color: skin.colors.ink2, fontSize: 12, lineHeight: 17 }}>
                  {`${clientLabel[cell.client] ?? cell.client} · ${t("skillsMode.written", { n: cell.written.length })} · ${t("skillsMode.skipped", { n: cell.skipped.length })}`}
                  {cell.conflicts.length ? ` · ${t("skillsMode.conflicts", { ids: cell.conflicts.join("、") })}` : ""}
                  {cell.cleared.length ? ` · ${t("skillsMode.cleared", { n: cell.cleared.length })}` : ""}
                </Text>
              ))}
              {project.backupDir ? (
                <Text style={skin.hint} selectable>
                  {t("skillsMode.backup", { dir: project.backupDir })}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
