import type { PluginTheme } from "@getpaseo/plugin";
import type { Appearance } from "../../shared/settings";

/**
 * 像素皮肤的纯数据部分：色板、棋盘贴图、深浅判断。
 *
 * 不带 React / React Native 依赖，好让 `node --test` 直接对着原版的字面量做回归校验；
 * 组件几何在 `pixel.tsx`，那里的 `pixelSkin(theme)` 用的是同一份色板。
 */

export interface PixelColors {
  /** 强边框：输入框、弹窗、主按钮。 */
  frame: string;
  /** 细线：卡片、分隔线、页签下沿。比 frame 弱一档，用来减少整屏方框感。 */
  line: string;
  paper: string;
  card: string;
  ink: string;
  ink2: string;
  shadow: string;
  gold: string;
  acc: string;
  accInk: string;
  ok: string;
  bad: string;
  warn: string;
  stripe: string;
  popline: string;
  hi: string;
  link: string;
  tab1: string;
  tab2: string;
  tabInk: string;
  okBg: string;
  badBg: string;
  warnBg: string;
  warnInk: string;
  seal: string;
  statusEdge: string;
}

/**
 * 真正的深色皮肤：深底浅字，像 IDE 的 dark theme，而不是原版那套棕色棋盘 + 奶油卡片。
 *
 * 等宽粗体、直角、墨底票号仍然照原版，但边框压到 1px、普通控件不带投影，
 * 底色**不铺棋盘**：
 * 整块面板直接取 Paseo 深色界面的 #181b1a，和 IDE 连成一片，不再出现两种深灰交替的底纹。
 */
export const DARK: PixelColors = {
  // 底色直接取 Paseo 深色界面实测的 #181b1a，整块面板与宿主背景同色；
  // 边框 / 卡片 / 文字都从这支中性灰绿派生。
  frame: "#616b65",
  line: "#333b37",
  paper: "#1c201e",
  card: "#222724",
  ink: "#e6eae7",
  ink2: "#a2aba6",
  shadow: "#0b0d0c",
  // 深色只保留一个强调色：暖金。激活标签、主按钮、链接都用它，
  // 不再混紫色（会和边框、正文打架）。
  gold: "#e3b341",
  acc: "#e3b341",
  accInk: "#181b1a",
  ok: "#56d364",
  bad: "#f85149",
  warn: "#d29922",
  stripe: "#2c322f",
  popline: "#353c38",
  hi: "#3a2f14",
  link: "#e3b341",
  // 深色不铺棋盘：整块面板就是 Paseo 的 #181b1a，和 IDE 背景连成一片。
  tab1: "#181b1a",
  tab2: "#181b1a",
  tabInk: "#e6eae7",
  okBg: "#13261a",
  badBg: "#2d1214",
  warnBg: "#2a2110",
  warnInk: "#e3b341",
  seal: "#c9503f",
  statusEdge: "#4a534e",
};

/**
 * 浅色皮肤：纯白 IDE 浅色，不是原版的米色纸面。
 *
 * 背景、卡片、弹窗全部白色，只用 1px 浅灰描边分层次（不加重投影）；
 * 颜色只保留一支蓝色强调（激活态 / 链接 / 标记），红绿橙只出现在状态里。
 */
export const LIGHT: PixelColors = {
  frame: "#d0d7de",
  line: "#e1e6ea",
  paper: "#ffffff",
  card: "#ffffff",
  ink: "#1f2328",
  ink2: "#59636e",
  shadow: "#c9d1d9",
  gold: "#0969da",
  acc: "#0969da",
  accInk: "#ffffff",
  ok: "#1a7f37",
  bad: "#cf222e",
  warn: "#9a6700",
  stripe: "#f6f8fa",
  popline: "#eaeef2",
  hi: "#eef2f5",
  link: "#0969da",
  // 浅色同样不铺棋盘：整块面板就是纯白。
  tab1: "#ffffff",
  tab2: "#ffffff",
  tabInk: "#1f2328",
  // 状态底色统一用中性浅灰，只有文字颜色区分成功 / 失败 / 警告，避免白色界面里铺满彩色块。
  okBg: "#f6f8fa",
  badBg: "#f6f8fa",
  warnBg: "#f6f8fa",
  warnInk: "#9a6700",
  seal: "#cf222e",
  statusEdge: "#d0d7de",
};

/** 原版浅色宿主那一套（米色纸面 + 原版浅色板），只给「经典像素」用。 */
export const CLASSIC_LIGHT: PixelColors = {
  frame: "#3a2c14",
  line: "#c9b998",
  paper: "#f6f1e6",
  card: "#fffdf8",
  ink: "#221d15",
  ink2: "#6f6252",
  shadow: "#241a0c",
  gold: "#a16207",
  acc: "#15803d",
  accInk: "#ffffff",
  ok: "#15803d",
  bad: "#b91c1c",
  warn: "#b45309",
  stripe: "#e7ddc8",
  popline: "#e7ddc8",
  hi: "#dff2e3",
  link: "#2563eb",
  tab1: "#efe8d9",
  tab2: "#e7ddc8",
  tabInk: "#3a2c14",
  okBg: "#d9f2dc",
  badBg: "#fbe3e1",
  warnBg: "#fdf0d3",
  warnInk: "#b45309",
  seal: "#c9503f",
  statusEdge: "#b9ab90",
};

/** 原版深色宿主那一套（棕色棋盘 + 奶油纸），保留成「经典像素」，不再冒充深色主题。 */
export const CLASSIC_DARK: PixelColors = {
  frame: "#3a2c14",
  line: "#b3a077",
  paper: "#f2e4c0",
  card: "#fffdf4",
  ink: "#2b2113",
  ink2: "#6b5b3e",
  shadow: "#241a0c",
  gold: "#e3a92f",
  acc: "#8b5cf6",
  accInk: "#ffffff",
  ok: "#0e8a16",
  bad: "#a3231a",
  warn: "#f59e0b",
  stripe: "#ddcda1",
  popline: "#e8d9ae",
  hi: "#ffe1a1",
  link: "#5b3df0",
  tab1: "#93764f",
  tab2: "#8a6f4d",
  tabInk: "#f2e4c0",
  okBg: "#d9f2dc",
  badBg: "#fbe3e1",
  warnBg: "#fdf0d3",
  warnInk: "#9a6a00",
  seal: "#c9503f",
  statusEdge: "#9a8f78",
};

/** 16×16、8px 方格的棋盘 PNG，对应原版 `repeating-conic-gradient` 的 8px 底纹。 */
export const CHECKER_CLASSIC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIUlEQVR4nGPoyvfFiiaX+WNFDKMaaKIBlwQug0Y10EQDAFmfTxAKkXd6AAAAAElFTkSuQmCC";
export const CHECKER_CLASSIC_LIGHT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIklEQVR4nGN4fvcEVvT+xU2siGFUA0004JLAZdCoBppoAABJrp4fp1h2BAAAAABJRU5ErkJggg==";

/**
 * 棋盘贴图只给「经典像素」；深色与浅色（IDE 风）都返回 null，面板直接用 `tab2` 纯色底。
 * 这样不会出现两格交替的纹理，也不会在缩放时留下贴图接缝。
 */
export function checkerDataUri(colors: PixelColors): string | null {
  if (colors === CLASSIC_DARK) return CHECKER_CLASSIC;
  if (colors === CLASSIC_LIGHT) return CHECKER_CLASSIC_LIGHT;
  return null;
}

function channel(value: string): number {
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  const n = Number.isFinite(parsed) ? parsed : 0;
  return Math.max(0, Math.min(255, trimmed.endsWith("%") ? (n / 100) * 255 : n));
}

/** 支持 #rgb / #rrggbb / rgb()/rgba()；认不出就返回 null，调用方按深色处理（原版默认皮肤）。 */
export function luminance(color: string): number | null {
  const value = color.trim().toLowerCase();
  let rgb: [number, number, number] | null = null;
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3) rgb = [0, 1, 2].map((i) => Number.parseInt(hex.slice(i, i + 1).repeat(2), 16)) as [number, number, number];
    else if (hex.length >= 6) rgb = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  } else {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (match) {
      const parts = (match[1] ?? "").split(",");
      if (parts.length >= 3) rgb = [channel(parts[0] ?? ""), channel(parts[1] ?? ""), channel(parts[2] ?? "")];
    }
  }
  if (!rgb || rgb.some((n) => !Number.isFinite(n))) return null;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** 宿主本身是不是深色。认不出的颜色按深色处理。 */
export function isHostDark(theme: PluginTheme): boolean {
  const value = luminance(theme.colors.surface0);
  return value === null ? true : value < 0.5;
}

/**
 * 当前这套皮肤是不是深底浅字。
 *
 * `auto` / `classic` 跟随宿主；`dark` / `light` 是人的显式选择，优先于宿主。
 */
export function isDarkTheme(theme: PluginTheme, appearance: Appearance = "auto"): boolean {
  if (appearance === "dark") return true;
  if (appearance === "light") return false;
  return isHostDark(theme);
}

/**
 * 皮肤选择。
 *
 * - auto：宿主深色给真正深色皮肤，宿主浅色给纯白浅色；
 * - dark / light：IDE 意义上的深底浅字 / 白底黑字；
 * - classic：原版 DSH 的两套像素皮肤（深色宿主是棕色棋盘，浅色宿主是米色纸面）。
 */
export function pixelColors(theme: PluginTheme, appearance: Appearance = "auto"): PixelColors {
  if (appearance === "dark") return DARK;
  if (appearance === "light") return LIGHT;
  if (appearance === "classic") return isHostDark(theme) ? CLASSIC_DARK : CLASSIC_LIGHT;
  return isHostDark(theme) ? DARK : LIGHT;
}
