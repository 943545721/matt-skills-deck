import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton, PixelHead } from "../../pixel.tsx";

/**
 * 编排页共用的小零件：区块、数值行。
 *
 * 为什么抽出来：角色页与地图预算页在同一个滚动区里，两处风格不一样时，
 * 人会读成「这是两件不相干的事」。同一套标题、同一套数字对齐，才像一张表。
 *
 * 这里一律不画卡片框：区块之间靠留白断开，行与行之间只用 1px 线
 * （见 `/root/.claude/CLAUDE.md` 的界面口径：单强调色、细线、少方框）。
 */

/** 区块：标题 + 可选的右侧读数；内容紧跟其下。 */
export function OrchSection({
  skin,
  title,
  aside,
  children,
}: {
  skin: PixelSkin;
  title: string;
  /** 右侧读数：数量、「不限」这类一句话状态。别放长句，它会挤掉标题。 */
  aside?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row" as const, alignItems: "center" as const, gap: 8 }}>
        <PixelHead skin={skin}>{title}</PixelHead>
        <View style={{ flex: 1 }} />
        {aside ? (
          <Text
            style={{ color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily }}
            numberOfLines={1}
          >
            {aside}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/**
 * 数值行：标签左、取值范围紧贴右侧、步进器固定宽度靠右。
 *
 * 固定宽度是为了让「最大层数」与「一次最多派几个」的数字竖着对齐——
 * 数字不对齐时，一列参数看起来像散落的按钮。
 */
export function OrchStepper({
  skin,
  label,
  range,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  skin: PixelSkin;
  label: string;
  /** 形如 `1–6`：范围写在标签这一行，不再单独占一句说明。 */
  range: string;
  value: number;
  min: number;
  max: number;
  /** 上一次保存还没落盘时禁用：连点两下都按同一份旧值算，净增只有 1。 */
  disabled?: boolean;
  onChange(next: number): void;
}) {
  return (
    <View style={{ flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 4 }}>
      <Text
        style={{ flex: 1, color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily }}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text style={{ color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily }}>{range}</Text>
      <View style={{ flexDirection: "row" as const, alignItems: "center" as const, gap: 4, width: 100, justifyContent: "flex-end" }}>
        <PixelButton
          skin={skin}
          mini
          label="−"
          onPress={() => onChange(Math.max(min, value - 1))}
          disabled={disabled || value <= min}
        />
        <Text
          style={[
            skin.num,
            {
              color: skin.colors.ink,
              fontSize: 13,
              minWidth: 20,
              textAlign: "center",
              ...(skin.mono.fontFamily ? { fontFamily: skin.mono.fontFamily } : {}),
            },
          ]}
        >
          {value}
        </Text>
        <PixelButton
          skin={skin}
          mini
          label="+"
          onPress={() => onChange(Math.min(max, value + 1))}
          disabled={disabled || value >= max}
        />
      </View>
    </View>
  );
}

/** 一组行之间的 1px 分隔线：第一行不画，避免和区块标题贴成双线。 */
export function rowDivider(skin: PixelSkin, first: boolean) {
  return first ? null : { borderTopWidth: 1, borderTopColor: skin.colors.line };
}
