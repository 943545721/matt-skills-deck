import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { ItemKind } from "../../../shared/issues";
import type { BoardIssue } from "../../../shared/issues";
import { issueAreas, issueRoles } from "../board/projectRows";
import { activeBlockers, blockerLabel, clockText, readableText } from "../format";
import { useDeckText } from "../i18n";
import type { PixelSkin } from "../pixel";
import { PixelButton, PixelCard, PixelNum } from "../pixel";

/**
 * 任务板的一行。
 *
 * 从 BoardView 抽出来只为一件事：列表行与筛选/分页逻辑分开后，
 * 改徽标和改查询不会互相踩行数上限。所有数据都来自服务端算好的字段，
 * 这里不做任何 readiness 推导。
 */
export function TicketRow({
  skin,
  item,
  showRepo,
  repoName,
  readOnly,
  bound,
  onOpen,
  onOpenMap,
}: {
  skin: PixelSkin;
  item: BoardIssue;
  /** 合板且没筛具体仓库时为 true。 */
  showRepo: boolean;
  repoName?: string;
  readOnly: boolean;
  bound: boolean;
  onOpen(ref: { repoKey: string; number: number; kind: ItemKind }): void;
  onOpenMap(ref: { repoKey: string; number: number }): void;
}) {
  const { t } = useDeckText();
  const styles = useMemo(
    () => ({
      item: { marginBottom: 8 },
      body: { padding: 10, gap: 5 },
      headWrap: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
      head: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        flexWrap: "wrap" as const,
      },
      /** 读数不折行也不缩：时间被挤到第二行，一列票就扫不成列了。行高对齐徽标那一条基线。 */
      clock: {
        color: skin.colors.ink2,
        fontSize: 10,
        lineHeight: 16,
        fontFamily: skin.mono.fontFamily,
        flexShrink: 0 as const,
      },
      title: { color: skin.colors.ink, fontSize: 13, fontWeight: "700" as const, flexShrink: 1, lineHeight: 19 },
      labels: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
      label: {
        fontSize: 10,
        lineHeight: 16,
        paddingHorizontal: 6,
        overflow: "hidden" as const,
        borderWidth: 1,
        borderColor: skin.colors.line,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const, alignItems: "center" as const },
    }),
    [skin],
  );

  const neutral = { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 };
  // area / role 单独成徽标：它们是配置里的定位信息，混在几十个标签里等于没显示。
  const areas = issueAreas(item);
  const roles = issueRoles(item);
  const otherLabels = item.labels.filter((label) => !/^(area|role):/.test(label.name));
  // 只报还在挡路的：对方已经关掉的边留在历史里，照抄出来会让「能接了」的票看起来还堵着。
  const blocking = activeBlockers(item);
  // 行上没有时间时（解析不了）这一格留空，不写「未知时间」这种占位。
  const clock = clockText(item.updatedAt);
  return (
    <View style={styles.item}>
      <PixelCard skin={skin}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`#${item.number} ${item.title}`}
          style={styles.body}
          onPress={() => onOpen({ repoKey: item.repoKey, number: item.number, kind: "issue" })}
        >
          <View style={styles.headWrap}>
            <View style={styles.head}>
              <PixelNum skin={skin}>#{item.number}</PixelNum>
              {item.containerKind ? <Text style={[styles.label, { backgroundColor: item.containerKind === "spec" ? "#dbeafe" : skin.colors.acc, color: item.containerKind === "spec" ? "#1e3a8a" : skin.colors.accInk }]}>{item.containerKind === "spec" ? "SPEC" : "MAP"}</Text> : null}
              {showRepo ? <Text style={[styles.label, neutral]}>{repoName ?? item.repoKey}</Text> : null}
              {areas.map((area) => (
                <Text key={`area-${area}`} style={[styles.label, { borderColor: skin.colors.acc, color: skin.colors.acc }]}>
                  {area}
                </Text>
              ))}
              {roles.map((role) => (
                <Text key={`role-${role}`} style={[styles.label, neutral]}>
                  {role}
                </Text>
              ))}
              {showRepo && readOnly ? <Text style={[styles.label, neutral]}>{t("board.repoReadOnly")}</Text> : null}
              {bound ? (
                <Text style={[styles.label, { backgroundColor: skin.colors.acc, color: skin.colors.accInk }]}>
                  {t("board.current")}
                </Text>
              ) : null}
              {item.state === "CLOSED" ? (
                <Text style={[styles.label, { backgroundColor: skin.colors.okBg, color: skin.colors.ok }]}>
                  {t("board.closed")}
                </Text>
              ) : null}
              {item.readiness === "blocked" ? (
                <Text style={[styles.label, { backgroundColor: skin.colors.badBg, color: skin.colors.bad }]}>
                  {t("board.blockedBadge")}
                </Text>
              ) : null}
              {item.readiness === "claimed" ? (
                <Text style={[styles.label, { backgroundColor: skin.colors.warnBg, color: skin.colors.warnInk }]}>
                  {t("board.claimedBadge")}
                </Text>
              ) : null}
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
            </View>
            {/* 时间是这一行的读数，不是一句说明：放在右上角自己一列，
                既不跟标题抢那一行，也不会因为多了它让每行都多出一行高度。 */}
            {clock ? (
              <Text style={styles.clock} numberOfLines={1}>
                {t("board.updated", { time: clock })}
              </Text>
            ) : null}
          </View>
          {otherLabels.length ? (
            <View style={styles.labels}>
              {otherLabels.map((label) => (
                <Text
                  key={label.name}
                  style={[styles.label, { backgroundColor: `#${label.color}`, color: readableText(label.color) }]}
                >
                  {label.name}
                </Text>
              ))}
            </View>
          ) : null}
          {item.assignees.length ? (
            <Text style={styles.meta}>{t("board.assignees", { names: item.assignees.join(", ") })}</Text>
          ) : null}
          {blocking.length ? (
            <Text style={styles.meta}>
              {t("board.blockedBy", { list: blocking.map(blockerLabel).join("、") })}
            </Text>
          ) : null}
        </Pressable>
      </PixelCard>
      {item.isMap || item.containerKind === "spec" ? (
        <View style={styles.actions}>
          <PixelButton
            skin={skin}
            mini
            label={t("map.open")}
            onPress={() => onOpenMap({ repoKey: item.repoKey, number: item.number })}
          />
        </View>
      ) : null}
    </View>
  );
}
