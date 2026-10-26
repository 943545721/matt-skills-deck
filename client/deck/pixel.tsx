import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

/**
 * 像素风牌面。
 *
 * 不用图片、不用阴影 API，只靠三件事做出「硬」的观感：
 * 1. 直角 —— 圆角一律 0，卡片像贴纸一样方；
 * 2. 双线边 —— 2px 描边，等于像素画里的外轮廓；
 * 3. 硬投影 —— 外层容器用描边色当背景，靠右下 3px 的内边距露出一个实心方块，
 *    而不是半透明渐变。外层不加负边距：内容自然贴在左上，投影只出现在右下。
 *
 * 颜色全部取自 theme token，所以深浅色主题都成立；这里只有几何常量是固定的。
 */

const EDGE = 2;
const DEPTH = 3;

/** 区块标题前的方块记号：便宜、不依赖字体图标、又立刻点出像素感。 */
export const PIXEL_MARK = "▚";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/**
 * 触屏判定。
 *
 * 用 `Platform.OS` 而不是宿主给的 `layout.platform`：皮肤在弹窗里也要用，而弹窗拿不到 layout；
 * 两者在运行时本来指同一件事。手机上的按钮要高到手指能稳稳点到（约 40pt），
 * 桌面端保持紧凑，不然一屏能放下的票会少一半。
 */
const TOUCH = Platform.OS === "ios" || Platform.OS === "android";

export interface PixelSkin {
  /** 投影露出的厚度，布局里要对齐时用得上。 */
  depth: number;
  shadow: ViewStyle;
  plate: ViewStyle;
  button: ViewStyle;
  buttonActive: ViewStyle;
  buttonPressed: ViewStyle;
  buttonText: TextStyle;
  buttonTextActive: TextStyle;
  mark: TextStyle;
  mono: TextStyle;
}

export function pixelSkin(theme: PluginTheme, touch: boolean = TOUCH): PixelSkin {
  const line = theme.colors.border;
  return {
    depth: DEPTH,
    shadow: { backgroundColor: line, paddingRight: DEPTH, paddingBottom: DEPTH },
    plate: {
      backgroundColor: theme.colors.surface1,
      borderWidth: EDGE,
      borderColor: line,
      borderRadius: 0,
    },
    button: {
      minHeight: touch ? 40 : undefined,
      justifyContent: "center" as const,
      paddingVertical: touch ? 8 : 5,
      paddingHorizontal: touch ? 14 : 10,
      borderRadius: 0,
      borderWidth: EDGE,
      borderColor: line,
      backgroundColor: theme.colors.surface2,
    },
    buttonActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
    buttonPressed: { backgroundColor: theme.colors.surface1 },
    buttonText: { color: theme.colors.foreground, fontSize: touch ? 13 : 12 },
    // 选中态用强调色作底，字必须翻成深色才读得清（与版面上其他强调徽标保持一致）。
    buttonTextActive: { color: "#000000", fontSize: touch ? 13 : 12, fontWeight: "600" as const },
    mark: { color: theme.colors.accent, fontSize: 11, lineHeight: 16 },
    mono: { fontFamily: MONO },
  };
}

/** 主题对象在宿主里是稳定引用，但换主题/切深浅色时必须重算，所以按引用缓存。 */
export function usePixel(theme: PluginTheme): PixelSkin {
  return useMemo(() => pixelSkin(theme), [theme]);
}

export function PixelCard({
  skin,
  style,
  children,
}: {
  skin: PixelSkin;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View style={skin.shadow}>
      <View style={[skin.plate, style]}>{children}</View>
    </View>
  );
}

export function PixelButton({
  skin,
  label,
  accessibilityLabel,
  onPress,
  active = false,
  disabled = false,
}: {
  skin: PixelSkin;
  label: string;
  accessibilityLabel?: string;
  onPress(): void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={skin.shadow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled, selected: active }}
        disabled={disabled}
        style={({ pressed }) => [
          skin.button,
          active ? skin.buttonActive : null,
          pressed && !disabled ? skin.buttonPressed : null,
          disabled ? { opacity: 0.5 } : null,
        ]}
        onPress={onPress}
      >
        <Text style={active ? skin.buttonTextActive : skin.buttonText} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

/** 卡片小标题：方块记号 + 标题，替代原先光秃秃的一行粗体。 */
export function PixelHead({ skin, style, children }: { skin: PixelSkin; style?: StyleProp<TextStyle>; children: ReactNode }) {
  return (
    <Text style={style}>
      <Text style={skin.mark}>{PIXEL_MARK} </Text>
      {children}
    </Text>
  );
}
