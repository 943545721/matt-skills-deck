import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import { MemberDetail } from "./MemberDetail.tsx";
import type { GroupPick, RailRow } from "./rail-model.ts";

/**
 * 群页右栏：谁在、发给谁、他手上什么活。
 *
 * 为什么把成员从正文挪到右栏：原来「名册 / 进度 / 消息 / 发言」四块竖着叠成一条长页，
 * 派活的时候要点人名，得先把消息区滚到最上面去找人。右栏把人钉在视线里，
 * 点一下人 → 下一句就发给他，同时就地展开他的进度与交接。
 *
 * 头像、圆角、底色分层是照着 IM 的样子来的：一眼要能分出「谁说的」「谁在线」。
 * 但只用一个强调色，分隔仍靠 1px 线——不为了「像聊天软件」把界面刷成彩色方块。
 */

/** 窄屏右栏的高度上限：给消息区留出能读的位置，名册自己滚。 */
const COMPACT_MAX_HEIGHT = 220;

function avatarText(name: string): string {
  // 中文名取第一个字、英文名取首字母：一行里只放一个字符才不会把名字挤出去。
  const trimmed = name.trim();
  return trimmed ? Array.from(trimmed)[0]!.toUpperCase() : "?";
}

export function MemberRail({
  skin,
  t,
  workspaceDir,
  rows,
  pick,
  onPick,
  rosterProblems,
  loading,
  error,
  warnings,
  scrollable,
  onAddStaff,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  /** 群所在目录：成员展开时按它读台账。 */
  workspaceDir: string;
  rows: readonly RailRow[];
  pick: GroupPick | null;
  /** 点同一个人再点一次 = 取消选中（那句话就回到主窗口）。 */
  onPick(next: GroupPick | null): void;
  /** 名册读失败的原因：一条一行，空的 `rows` 不能说成「这个群没有人」。 */
  rosterProblems: readonly string[];
  loading: boolean;
  /** 整页读失败时由父级在顶上写一条：这里只用来压住「名册上没有人」那句假话。 */
  error: string | null;
  warnings: readonly string[];
  /** 宽屏右栏自己滚到底；窄屏只占一段高度，靠上限截住。 */
  scrollable: boolean;
  /** 名册空时给一条出路：直接跳到「岗位」。没有这条路，人只会看到一栏空。 */
  onAddStaff?(): void;
}) {
  const styles = useMemo(
    () => ({
      rail: { gap: 6 },
      /* 宽屏右栏要撑满整列高度，里面的 ScrollView 才有边界可滚。 */
      railFill: { flex: 1 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      headTitle: {
        color: skin.colors.ink,
        fontSize: 12,
        fontWeight: "700" as const,
        fontFamily: skin.mono.fontFamily,
      },
      count: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      hint: { color: skin.colors.ink2, fontSize: 10, lineHeight: 15, fontFamily: skin.mono.fontFamily },
      list: { gap: 2 },
      row: { flexDirection: "row" as const, gap: 8, paddingVertical: 5, paddingLeft: 6, alignItems: "flex-start" as const },
      nameLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      name: { flexShrink: 1, color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      sub: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      respond: {
        borderTopWidth: 1,
        borderTopColor: skin.colors.line,
        paddingTop: 6,
        gap: 1,
      },
      respondLabel: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      respondName: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
    }),
    [skin],
  );

  // 一个项目一个群：右栏列的只有本目录名册上的人，没有别的项目的人可列。
  const renderRow = (row: RailRow) => {
    const selected = pick !== null && pick.staffId === row.staffId;
    // 行里只留会话状态：这个群属于哪个目录，页面顶上那行已经说过。
    const sub = [row.status, row.archived ? t("group.archived") : null].filter(Boolean).join(" · ");
    return (
      <View key={row.staffId}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("group.pick", { name: row.name })}
          accessibilityState={{ selected }}
          onPress={() =>
            onPick(
              selected ? null : { staffId: row.staffId, name: row.name, agentId: row.agentId },
            )
          }
          style={[
            styles.row,
            { borderLeftWidth: 2, borderLeftColor: selected ? skin.colors.acc : "transparent" },
            selected ? { backgroundColor: skin.colors.stripe, borderRadius: 6 } : null,
          ]}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: row.kind === "manager" ? skin.colors.acc : skin.colors.stripe,
            }}
          >
            <Text
              style={{
                color: row.kind === "manager" ? skin.colors.accInk : skin.colors.ink2,
                fontSize: 11,
                fontWeight: "700",
                fontFamily: skin.mono.fontFamily,
              }}
            >
              {avatarText(row.name)}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <View style={styles.nameLine}>
              <Text style={styles.name} numberOfLines={1}>{row.name}</Text>
              <Text style={styles.sub} numberOfLines={1}>
                {t(row.kind === "manager" ? "group.kind.manager" : "group.kind.worker")}
              </Text>
            </View>
            {sub ? <Text style={styles.sub} numberOfLines={1}>{sub}</Text> : null}
          </View>
        </Pressable>
        {selected ? <MemberDetail key={row.staffId} skin={skin} t={t} workspaceDir={workspaceDir} row={row} /> : null}
      </View>
    );
  };

  const body = (
    <View style={styles.list}>
      {loading && rows.length === 0 ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}
      {/* 名册读失败时 `rows` 也是空的：那种空不能写成「还没有人」，否则人以为卡没了。 */}
      {!loading && !error && rows.length === 0 && rosterProblems.length === 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.hint}>{t("group.membersEmpty")}</Text>
          {onAddStaff ? (
            <PixelButton skin={skin} mini variant="ghost" label={t("orch.staffAdd")} onPress={onAddStaff} />
          ) : null}
        </View>
      ) : null}
      {rosterProblems.map((problem) => (
        <Text key={problem} style={styles.hint}>{t("group.rosterFailed", { detail: problem })}</Text>
      ))}
      {rows.map(renderRow)}
      {warnings.map((warning) => (
        <Text key={warning} style={styles.hint}>{warning}</Text>
      ))}
    </View>
  );

  return (
    <View style={[styles.rail, scrollable ? styles.railFill : null]}>
      <View style={styles.head}>
        <Text style={styles.headTitle}>{t("group.members")}</Text>
        <Text style={styles.count}>{t("group.memberCount", { n: rows.length })}</Text>
        {/* 这是哪个项目的群由页面顶上那行说：同一屏里再说一遍只是噪声。 */}
      </View>
      {scrollable ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }}>{body}</ScrollView>
      ) : (
        <ScrollView style={{ maxHeight: COMPACT_MAX_HEIGHT }} contentContainerStyle={{ paddingBottom: 8 }}>
          {body}
        </ScrollView>
      )}
      <View style={styles.respond}>
        <Text style={styles.respondLabel}>{t("group.rail.responder")}</Text>
        <Text style={styles.respondName} numberOfLines={1}>
          {pick ? pick.name : t("group.rail.responderMain")}
        </Text>
        <Text style={styles.hint}>
          {pick ? t("group.rail.responderPicked") : t("group.rail.responderMainHint")}
        </Text>
      </View>
    </View>
  );
}
