import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { NAV_GROUPS, type OrchestrationSection } from "./nav.ts";

/**
 * 编排页左栏：三段分组 + 一行一页。
 *
 * 不画方框、不加底色：一屏十个方框比十个页签更吵（界面口径见 `/root/.claude/CLAUDE.md`：
 * 单强调色、1px 细线、页签代替方框）。选中态是左侧 2px 强调线 + 正文字色，与群页的
 * 选中行同一套语言，这样「左栏选中的」与「右栏选中的」看起来是同一件事。
 *
 * 窄屏（手机）不摆左栏：左栏占掉 130px 之后正文只剩半个屏。改成顶部两行折行页签，
 * 分组之间用一条竖线断开。
 */

function Row({
  skin,
  label,
  active,
  onPress,
}: {
  skin: PixelSkin;
  label: string;
  active: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        paddingVertical: 5,
        paddingLeft: 8,
        paddingRight: 6,
        borderLeftWidth: 2,
        borderLeftColor: active ? skin.colors.acc : "transparent",
        borderRadius: 3,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: active ? skin.colors.ink : skin.colors.ink2,
          fontSize: 12,
          fontWeight: active ? "700" : "400",
          fontFamily: skin.mono.fontFamily,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function OrchNav({
  skin,
  t,
  section,
  compact,
  onPick,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  section: OrchestrationSection;
  compact: boolean;
  onPick(next: OrchestrationSection): void;
}) {
  const styles = useMemo(
    () => ({
      column: { width: 118, gap: 10 },
      groupLabel: {
        color: skin.colors.ink2,
        fontSize: 10,
        letterSpacing: 0.5,
        paddingLeft: 8,
        paddingBottom: 2,
        fontFamily: skin.mono.fontFamily,
      },
      group: { gap: 1 },
      wide: { gap: 6 },
      strip: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 2 },
      divider: { width: 1, height: 12, backgroundColor: skin.colors.line, marginHorizontal: 4 },
    }),
    [skin],
  );

  if (compact) {
    return (
      <View style={styles.strip}>
        {NAV_GROUPS.map((group, index) => (
          <View key={group.key} style={styles.strip}>
            {index === 0 ? null : <View style={styles.divider} />}
            {group.items.map((item) => (
              <Row
                key={item.key}
                skin={skin}
                label={t(item.label)}
                active={section === item.key}
                onPress={() => onPick(item.key)}
              />
            ))}
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.column}>
      {NAV_GROUPS.map((group) => (
        <View key={group.key} style={styles.group}>
          <Text style={styles.groupLabel} numberOfLines={1}>
            {t(group.label)}
          </Text>
          {group.items.map((item) => (
            <Row
              key={item.key}
              skin={skin}
              label={t(item.label)}
              active={section === item.key}
              onPress={() => onPick(item.key)}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
