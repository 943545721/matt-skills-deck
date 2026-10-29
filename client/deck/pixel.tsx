import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { ImageSourcePropType, StyleProp, TextStyle, ViewStyle } from "react-native";
import { deckSettings } from "../../shared/settings";
import type { Appearance } from "../../shared/settings";
import type { PixelColors } from "./pixelTokens";
import { checkerDataUri, isDarkTheme, pixelColors } from "./pixelTokens";

export { isDarkTheme } from "./pixelTokens";
export type { PixelColors } from "./pixelTokens";

/**
 * 像素风皮肤。
 *
 * 这一套不是自己另起的设计：色板、边框粗细、投影偏移、等宽字体全部照抄
 * DSH 原插件的 `PixelStyles.ts`（纸面、墨色、3px 框、硬投影、8px 棋盘底）。
 * 原版是 DOM + CSS，Paseo 的面板是 React Native，CSS 类名不能直接搬，
 * 但**设计值能一个不差地搬**——这里做的就是这件事，而不是再发明一套「像像素」的配色。
 * 唯一的偏离：深色用与 Paseo 相同的 #181b1a 纯色底，浅色用纯白底，两者都不铺棋盘；
 * 棋盘只留给「经典像素」。
 *
 * 皮肤有三套：深色（深底浅字，像 IDE 的 dark theme）、浅色（纯白底黑字）、
 * 经典像素（原版深色宿主的棕色棋盘 + 奶油纸）。默认（auto）按宿主 `surface0`
 * 的亮度在深色 / 浅色之间选，因为 PluginTheme 不带 appearance 字段；
 * 设置里的「外观」可以显式钉住任意一套。
 */

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const TOUCH = Platform.OS === "ios" || Platform.OS === "android";

/**
 * 几何。
 *
 * 原版给每样东西都套 3px 框 + 硬投影，一屏里同时出现二十个方框时非常吵
 * （整个界面像一张表格）。这里保留直角和像素字体，但把日常控件压到 1px 细线，
 * 投影只留给主按钮与弹窗：层级靠留白和字色，而不是靠框的粗细。
 */
const EDGE = 1;
const MODAL_EDGE = 2;
const DEPTH = 0;

export const PIXEL_MARK = "▚";

export interface PixelSkin {
  dark: boolean;
  colors: PixelColors;
  mono: TextStyle;
  /** 只有「经典像素」有棋盘；深色 / 浅色都是纯色底（null）。 */
  checker: ImageSourcePropType | null;
  depth: number;
  screen: ViewStyle;
  screenInner: ViewStyle;
  shadow: ViewStyle;
  cardShadow: ViewStyle;
  card: ViewStyle;
  modalShadow: ViewStyle;
  modal: ViewStyle;
  modalBody: ViewStyle;
  plate: ViewStyle;
  button: ViewStyle;
  buttonActive: ViewStyle;
  buttonPressed: ViewStyle;
  buttonText: TextStyle;
  buttonTextActive: TextStyle;
  /** 文字按钮：不画框，只占字宽。 */
  ghost: ViewStyle;
  ghostText: TextStyle;
  /** 页签：无框、无底，选中时强调色文字 + 下划线。 */
  tab: ViewStyle;
  tabActive: ViewStyle;
  tabText: TextStyle;
  tabTextActive: TextStyle;
  chip: ViewStyle;
  chipText: TextStyle;
  num: TextStyle;
  head: TextStyle;
  label: TextStyle;
  value: TextStyle;
  hint: TextStyle;
  hintOnChecker: TextStyle;
  error: TextStyle;
  banner: ViewStyle;
  bannerWarn: ViewStyle;
  bannerText: TextStyle;
  statusline: ViewStyle;
  statuslineText: TextStyle;
  input: TextStyle;
  docPlate: ViewStyle;
  mark: TextStyle;
}

/**
 * 触屏判定。
 *
 * 用 `Platform.OS` 而不是宿主给的 `layout.platform`：皮肤在弹窗里也要用，而弹窗拿不到 layout；
 * 两者在运行时本来指同一件事。手机上的按钮要高到手指能稳稳点到（约 40pt），
 * 桌面端保持原版紧凑尺寸，不然一屏能放下的票会少一半。
 */
export function pixelSkin(theme: PluginTheme, touch: boolean = TOUCH, appearance: Appearance = "auto"): PixelSkin {
  const dark = isDarkTheme(theme, appearance);
  const c = pixelColors(theme, appearance);
  const checkerUri = checkerDataUri(c);
  const mono = { fontFamily: MONO };
  const buttonFont = { fontFamily: MONO, fontWeight: "700" as const, fontSize: touch ? 13 : 12 };

  return {
    dark,
    colors: c,
    mono,
    checker: checkerUri ? { uri: checkerUri } : null,
    depth: DEPTH,
    screen: {
      flex: 1,
      backgroundColor: c.tab2,
      borderWidth: MODAL_EDGE,
      borderColor: c.frame,
      borderRadius: 0,
      overflow: "hidden",
    },
    screenInner: { flex: 1, padding: 10, gap: 10 },
    // 原版靠 translate + box-shadow 做「按下去陷进纸里」；RN 没有内阴影，
    // 用一个右下留白的实色底模拟同样的硬投影。只给主按钮用，普通控件不再带投影。
    shadow: { backgroundColor: c.shadow, paddingRight: 2, paddingBottom: 2 },
    cardShadow: {},
    card: {
      backgroundColor: c.card,
      borderWidth: EDGE,
      borderColor: c.line,
      borderRadius: 0,
    },
    modalShadow: { backgroundColor: c.shadow, paddingRight: 6, paddingBottom: 6 },
    modal: {
      backgroundColor: c.paper,
      borderWidth: MODAL_EDGE,
      borderColor: c.line,
      borderRadius: 0,
    },
    modalBody: { padding: 12, gap: 10 },
    plate: {
      backgroundColor: c.card,
      borderWidth: EDGE,
      borderColor: c.line,
      borderRadius: 0,
    },
    button: {
      minHeight: touch ? 36 : undefined,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      paddingVertical: touch ? 7 : 3,
      paddingHorizontal: touch ? 12 : 10,
      borderRadius: 0,
      borderWidth: EDGE,
      borderColor: c.frame,
      backgroundColor: "transparent",
    },
    // 原版 `.pixel-btn.hot`：强调色底 + 反色字。用在「当前选中 / 主操作」上。
    buttonActive: { backgroundColor: c.acc, borderColor: c.acc },
    buttonPressed: { opacity: 0.72 },
    buttonText: { ...buttonFont, color: c.ink },
    buttonTextActive: { ...buttonFont, color: c.accInk },
    ghost: {
      justifyContent: "center" as const,
      alignItems: "center" as const,
      paddingVertical: touch ? 6 : 3,
      paddingHorizontal: 4,
      backgroundColor: "transparent",
    },
    ghostText: { ...buttonFont, color: c.ink2 },
    // 页签不带框：一屏里最多只有一条下划线是强调色，其余都是灰字。
    tab: {
      minHeight: touch ? 32 : undefined,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      paddingVertical: touch ? 5 : 3,
      paddingHorizontal: touch ? 10 : 8,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
      backgroundColor: "transparent",
    },
    tabActive: { borderBottomColor: c.acc },
    tabText: { ...buttonFont, color: c.ink2 },
    tabTextActive: { ...buttonFont, color: c.acc },
    chip: {
      borderWidth: EDGE,
      borderColor: c.line,
      backgroundColor: c.stripe,
      borderRadius: 0,
      paddingHorizontal: 7,
      paddingVertical: 0,
    },
    chipText: { color: c.ink, fontSize: 11, fontFamily: MONO, fontWeight: "700" as const },
    // 原版 `.pixel-num`：墨底纸字的票号。
    num: {
      flexShrink: 0,
      fontFamily: MONO,
      fontWeight: "700" as const,
      fontSize: 11,
      backgroundColor: c.frame,
      color: c.paper,
      paddingHorizontal: 6,
      minWidth: 26,
      textAlign: "center" as const,
    },
    head: { ...mono, color: c.ink, fontSize: 13, fontWeight: "700" as const, letterSpacing: 0.5 },
    label: { color: c.ink2, fontSize: 12, fontFamily: MONO },
    value: { color: c.ink, fontSize: 12, fontFamily: MONO, flexShrink: 1 },
    hint: { color: c.ink2, fontSize: 12, lineHeight: 18 },
    hintOnChecker: { color: c.tabInk, fontSize: 12, lineHeight: 18, fontFamily: MONO },
    error: { color: c.bad, fontSize: 12, lineHeight: 18 },
    banner: {
      backgroundColor: c.badBg,
      borderWidth: EDGE,
      borderColor: c.line,
      borderLeftWidth: 3,
      borderLeftColor: c.bad,
      borderRadius: 0,
      paddingVertical: 8,
      paddingHorizontal: 10,
      gap: 2,
    },
    bannerWarn: { backgroundColor: c.warnBg, borderLeftColor: c.warn },
    bannerText: { color: c.ink, fontSize: 13, lineHeight: 19 },
    // 读数行就是一行灰字，不再用「卡片 + 8px 状态色」再画一个框。
    statusline: {
      borderTopWidth: EDGE,
      borderTopColor: c.line,
      paddingTop: 6,
      paddingBottom: 2,
    },
    statuslineText: { color: c.ink2, fontSize: 11, fontFamily: MONO, lineHeight: 16 },
    input: {
      borderWidth: EDGE,
      borderColor: c.frame,
      backgroundColor: c.paper,
      color: c.ink,
      borderRadius: 0,
      padding: 8,
      fontSize: 12,
      fontFamily: MONO,
    },
    // 宿主 Markdown 用宿主主题的字色，铺在纸面上会读不清；正文单独垫一块宿主底色的纸。
    // 这是唯一不能照抄原版 CSS 的地方，因为 Markdown 组件的样式不归插件管。
    docPlate: {
      backgroundColor: theme.colors.surface1,
      borderWidth: EDGE,
      borderColor: c.line,
      borderRadius: 0,
      padding: 8,
    },
    mark: { color: c.gold, fontSize: 11, lineHeight: 16 },
  };
}

/**
 * 主题对象在宿主里是稳定引用，但换主题 / 切深浅色时必须重算，所以把设置也放进依赖。
 * 设置还在读或读失败时按 auto 显示：外观设置坏了不该让面板整块不渲染。
 */
export function usePixel(theme: PluginTheme): PixelSkin {
  const settings = useSettings(deckSettings);
  const appearance: Appearance = settings.status === "ready" ? settings.values.appearance : "auto";
  return useMemo(() => pixelSkin(theme, TOUCH, appearance), [theme, appearance]);
}

/**
 * 整块底 + 4px 外框，对应原版 `.pixel-tab`。
 *
 * 只有「经典像素」铺原版 8px 棋盘；深色 / 浅色都不铺，直接露出 `tab2` 的纯色底。
 */
export function PixelScreen({
  skin,
  style,
  children,
}: {
  skin: PixelSkin;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View style={skin.screen}>
      {skin.checker ? (
        <Image
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          source={skin.checker}
          resizeMode="repeat"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View style={[skin.screenInner, style]}>{children}</View>
    </View>
  );
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
    <View style={skin.cardShadow}>
      <View style={[skin.card, style]}>{children}</View>
    </View>
  );
}

/** 弹窗正文的纸面：4px 框 + 8px 硬投影。 */
export function PixelModalBody({
  skin,
  style,
  children,
}: {
  skin: PixelSkin;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View style={skin.modalShadow}>
      <View style={[skin.modal, skin.modalBody, style]}>{children}</View>
    </View>
  );
}

/**
 * 按钮的四种形态，按「这一屏里它有多重要」选，而不是随手加框：
 *
 * - `solid`：主操作（新建、提交、登录），实心强调色，唯一带硬投影的按钮；
 * - `outline`：次要操作（刷新、应用、取消），1px 细框；
 * - `ghost`：文字按钮，用在卡片里，不画框；
 * - `tab`：页签 / 筛选，无框，选中时强调色文字 + 下划线。
 */
export type PixelButtonVariant = "outline" | "solid" | "ghost" | "tab";

export function PixelButton({
  skin,
  label,
  accessibilityLabel,
  onPress,
  active = false,
  disabled = false,
  mini = false,
  variant = "outline",
}: {
  skin: PixelSkin;
  label: string;
  accessibilityLabel?: string;
  onPress(): void;
  active?: boolean;
  disabled?: boolean;
  mini?: boolean;
  variant?: PixelButtonVariant;
}) {
  const filled = variant === "solid" || (variant === "outline" && active);
  const body = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      style={({ pressed }) => [
        variant === "tab" ? skin.tab : variant === "ghost" ? skin.ghost : skin.button,
        mini ? { paddingVertical: 1, paddingHorizontal: 8 } : null,
        variant === "tab" && active ? skin.tabActive : null,
        variant === "outline" && active ? skin.buttonActive : null,
        variant === "solid" ? skin.buttonActive : null,
        pressed && !disabled ? skin.buttonPressed : null,
        disabled ? { opacity: 0.5 } : null,
      ]}
      onPress={onPress}
    >
      <Text
        style={[
          variant === "tab"
            ? active
              ? skin.tabTextActive
              : skin.tabText
            : variant === "ghost"
              ? active
                ? skin.tabTextActive
                : skin.ghostText
              : filled || active
                ? skin.buttonTextActive
                : skin.buttonText,
          mini ? { fontSize: 11 } : null,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
  // 只有主操作保留硬投影；其余按钮平铺，避免一屏十几个错位的小方块。
  return variant === "solid" ? <View style={skin.shadow}>{body}</View> : body;
}

/** 票号：墨底纸字的 `#123`，原版 `.pixel-num`。 */
export function PixelNum({ skin, children }: { skin: PixelSkin; children: ReactNode }) {
  return <Text style={skin.num}>{children}</Text>;
}

/** 小徽标：原版 `.pixel-tab .dsws-chip`，2px 框、直角、等宽粗体。 */
export function PixelChip({
  skin,
  style,
  textStyle,
  children,
}: {
  skin: PixelSkin;
  style?: StyleProp<TextStyle>;
  textStyle?: StyleProp<TextStyle>;
  children: ReactNode;
}) {
  return (
    <Text style={[skin.chip, skin.chipText, textStyle, style]} numberOfLines={1}>
      {children}
    </Text>
  );
}

/** 失败/警告条：原版 `.pixel-banner`。 */
export function PixelBanner({
  skin,
  tone = "error",
  style,
  children,
}: {
  skin: PixelSkin;
  tone?: "error" | "warning";
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View style={skin.cardShadow}>
      <View style={[skin.banner, tone === "warning" ? skin.bannerWarn : null, style]}>{children}</View>
    </View>
  );
}

/** 状态行：一行灰字 + 顶部细线，不再单独画一个带状态色顶边的框。 */
export function PixelStatusLine({
  skin,
  style,
  children,
}: {
  skin: PixelSkin;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return <View style={[skin.statusline, style]}>{children}</View>;
}

/** 卡片小标题：方块记号 + 标题，替代原先光秃秃的一行粗体。 */
export function PixelHead({ skin, style, children }: { skin: PixelSkin; style?: StyleProp<TextStyle>; children: ReactNode }) {
  return (
    <Text style={[skin.head, style]}>
      <Text style={skin.mark}>{PIXEL_MARK} </Text>
      {children}
    </Text>
  );
}
