import { Pressable, Text, View } from "react-native";
import { useMemo } from "react";
import { useDeckText } from "../i18n";
import type { PixelSkin } from "../pixel";
import { PixelButton } from "../pixel";
import type { ProjectRow } from "./projectRows";

/**
 * 任务板顶部的项目条：一行一个项目，点哪行就筛到哪个项目。
 *
 * 只在工作区真的有多份清单（v2 且项目数 > 1）时出现；单项目时整块不渲染，
 * 布局与以前一模一样——「多出来的一行」本身就是变化，不该顺手给所有人加。
 *
 * 计数只来自当前窗口的票（与 KPI 同源），窗口外的量由板子顶部那行提示负责。
 * 项目目录读不出来时照常出一行并写明原因：少一行会被当成「项目没了」。
 */
export function ProjectStrip({
  skin,
  rows,
  activeRepo,
  onPick,
  uncovered,
}: {
  skin: PixelSkin;
  rows: readonly ProjectRow[];
  /** 当前筛到哪个仓库键；null = 全部。 */
  activeRepo: string | null;
  onPick(repoKey: string | null): void;
  /** 清单里没写、但磁盘上有的仓库：仍然要能筛过去，否则它们只能在「全部」里碰运气。 */
  uncovered: readonly { key: string; name: string }[];
}) {
  const { t } = useDeckText();
  const styles = useMemo(
    () => ({
      wrap: { gap: 3 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      label: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, letterSpacing: 0.5 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        flexWrap: "wrap" as const,
        paddingVertical: 3,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: skin.colors.line,
      },
      key: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      keyActive: { color: skin.colors.acc },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      ready: { color: skin.colors.ok, fontSize: 11, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      blocked: { color: skin.colors.bad, fontSize: 11, fontFamily: skin.mono.fontFamily },
      problem: { color: skin.colors.warnInk, fontSize: 11, fontFamily: skin.mono.fontFamily },
      spacer: { marginLeft: "auto" as const },
      extra: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, alignItems: "center" as const },
    }),
    [skin],
  );

  if (rows.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.label}>{t("board.projectsTitle")}</Text>
        <PixelButton
          skin={skin}
          mini
          variant="tab"
          label={t("board.projectsAll")}
          active={activeRepo === null}
          onPress={() => onPick(null)}
        />
      </View>

      {rows.map((row) => {
        const active = row.repoKey !== null && row.repoKey === activeRepo;
        return (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={t("board.projectRow", { key: row.key, open: row.open, closed: row.closed })}
            disabled={row.repoKey === null}
            onPress={() => onPick(row.repoKey)}
            style={styles.row}
          >
            <Text style={[styles.key, active ? styles.keyActive : null]}>{row.key}</Text>
            {row.owner ? <Text style={styles.meta}>{row.owner}</Text> : null}
            <Text style={styles.meta}>{t("board.projectOpen", { n: row.open })}</Text>
            <Text style={styles.meta}>{t("board.projectClosed", { n: row.closed })}</Text>
            <Text style={styles.ready}>{t("board.projectReady", { n: row.ready })}</Text>
            <Text style={styles.blocked}>{t("board.projectBlocked", { n: row.blocked })}</Text>
            <View style={styles.spacer} />
            {row.problem ? <Text style={styles.problem}>{t("board.projectProblem", { detail: row.problem })}</Text> : null}
          </Pressable>
        );
      })}

      {uncovered.length ? (
        <View style={styles.extra}>
          <Text style={styles.label}>{t("board.projectUncovered")}</Text>
          {uncovered.map((repo) => (
            <PixelButton
              key={repo.key}
              skin={skin}
              mini
              variant="tab"
              label={repo.name}
              accessibilityLabel={repo.key}
              active={activeRepo === repo.key}
              onPress={() => onPick(repo.key)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
