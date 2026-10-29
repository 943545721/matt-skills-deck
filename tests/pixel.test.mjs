import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import {
  CHECKER_CLASSIC,
  CHECKER_CLASSIC_LIGHT,
  CLASSIC_DARK,
  CLASSIC_LIGHT,
  DARK,
  LIGHT,
  checkerDataUri,
  luminance,
  isDarkTheme,
  pixelColors,
} from "../client/deck/pixelTokens.ts";

const CLASSIC_DARK_ORIGINAL = {
  frame: "#3a2c14",
  line: "#b3a077",
  paper: "#f2e4c0",
  card: "#fffdf4",
  ink: "#2b2113",
  ink2: "#6b5b3e",
  shadow: "#241a0c",
  gold: "#e3a92f",
  acc: "#8b5cf6",
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
  seal: "#c9503f",
  statusEdge: "#9a8f78",
};

/** 经典像素的浅色宿主变体：仍是原版米色纸面，不是新的白色主题。 */
const CLASSIC_LIGHT_ORIGINAL = {
  ...CLASSIC_DARK_ORIGINAL,
  line: "#c9b998",
  paper: "#f6f1e6",
  card: "#fffdf8",
  ink: "#221d15",
  ink2: "#6f6252",
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
  warnInk: "#b45309",
  statusEdge: "#b9ab90",
};

/** 浅色是干净的白色 IDE：纯白底、浅灰描边、单一蓝色强调。 */
const LIGHT_WHITE = {
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
  tab1: "#ffffff",
  tab2: "#ffffff",
  tabInk: "#1f2328",
  okBg: "#f6f8fa",
  badBg: "#f6f8fa",
  warnBg: "#f6f8fa",
  warnInk: "#9a6700",
  seal: "#cf222e",
  statusEdge: "#d0d7de",
};

/** 真正的深色皮肤：深底浅字，不是原版棕色棋盘。 */
const DARK_NIGHT = {
  frame: "#616b65",
  line: "#333b37",
  paper: "#1c201e",
  card: "#222724",
  ink: "#e6eae7",
  ink2: "#a2aba6",
  shadow: "#0b0d0c",
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
  // 深色不铺棋盘：两格同色，整块底就是 Paseo 的 #181b1a。
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

const theme = (surface0) => ({ colors: { surface0 } });

test("深色 / 浅色 / 经典像素四套色板逐值钉住", () => {
  assert.deepEqual(DARK, DARK_NIGHT);
  assert.deepEqual(LIGHT, LIGHT_WHITE);
  assert.deepEqual(CLASSIC_LIGHT, CLASSIC_LIGHT_ORIGINAL);
  assert.deepEqual(CLASSIC_DARK, { ...CLASSIC_DARK_ORIGINAL, accInk: "#ffffff", warnInk: "#9a6a00" });
});

test("深色只保留一个强调色：激活态、链接、标记都用同一支暖金", () => {
  assert.equal(DARK.acc, DARK.gold);
  assert.equal(DARK.link, DARK.gold);
  assert.equal(DARK.accInk, DARK.tab2);
});

test("深色底是 Paseo 同色的纯色，不铺棋盘", () => {
  assert.equal(DARK.tab1, "#181b1a");
  assert.equal(DARK.tab2, "#181b1a");
  assert.equal(checkerDataUri(DARK), null);
});

test("浅色是纯白底，不铺棋盘，只留一支蓝色强调", () => {
  assert.equal(LIGHT.paper, "#ffffff");
  assert.equal(LIGHT.card, "#ffffff");
  assert.equal(LIGHT.tab1, "#ffffff");
  assert.equal(LIGHT.tab2, "#ffffff");
  assert.equal(checkerDataUri(LIGHT), null);
  assert.equal(LIGHT.acc, LIGHT.gold);
  assert.equal(LIGHT.acc, LIGHT.link);
  assert.notEqual(LIGHT.acc, LIGHT.ok);
  assert.notEqual(LIGHT.acc, LIGHT.bad);
  assert.equal(new Set([LIGHT.okBg, LIGHT.badBg, LIGHT.warnBg]).size, 1);
});

test("深色是深底浅字，浅色是白底黑字", () => {
  assert.ok((luminance(DARK.card) ?? 1) < 0.2, "深色卡片必须是深底");
  assert.ok((luminance(DARK.ink) ?? 0) > 0.75, "深色正文必须是浅字");
  assert.ok((luminance(LIGHT.card) ?? 0) > 0.85, "浅色卡片必须是浅底");
  assert.ok((luminance(LIGHT.ink) ?? 1) < 0.2, "浅色正文必须是深字");
});

test("深浅判定跟随宿主底色亮度，认不出的颜色退回原版深色皮肤", () => {
  assert.equal(isDarkTheme(theme("#0d1117")), true);
  assert.equal(isDarkTheme(theme("#f6f1e6")), false);
  assert.equal(isDarkTheme(theme("rgb(255, 255, 255)")), false);
  assert.equal(isDarkTheme(theme("rgba(13, 17, 23, 1)")), true);
  assert.equal(isDarkTheme(theme("#fff")), false);
  assert.equal(isDarkTheme(theme("")), true);
  assert.equal(pixelColors(theme("#f6f1e6")), LIGHT);
  assert.equal(pixelColors(theme("#0d1117")), DARK);
  assert.equal(luminance("#000"), 0);
  assert.ok(Math.abs((luminance("#fff") ?? 0) - 1) < 1e-9);
});

test("外观设置显式钉住深色 / 浅色，auto 才看宿主", () => {
  assert.equal(isDarkTheme(theme("#f6f1e6"), "dark"), true);
  assert.equal(isDarkTheme(theme("#0d1117"), "light"), false);
  assert.equal(pixelColors(theme("#f6f1e6"), "dark"), DARK);
  assert.equal(pixelColors(theme("#0d1117"), "light"), LIGHT);
  assert.equal(isDarkTheme(theme("#0d1117"), "auto"), true);
  assert.equal(isDarkTheme(theme("#f6f1e6"), "auto"), false);
  assert.equal(pixelColors(theme("#0d1117"), "auto"), DARK);
  assert.equal(pixelColors(theme("#f6f1e6"), "auto"), LIGHT);
});

test("经典像素仍按宿主选原版棕色 / 米色，不冒充 IDE 深色", () => {
  assert.equal(pixelColors(theme("#0d1117"), "classic"), CLASSIC_DARK);
  assert.equal(pixelColors(theme("#f6f1e6"), "classic"), CLASSIC_LIGHT);
  assert.equal(checkerDataUri(CLASSIC_DARK), CHECKER_CLASSIC);
  assert.equal(checkerDataUri(CLASSIC_LIGHT), CHECKER_CLASSIC_LIGHT);
  assert.equal(isDarkTheme(theme("#0d1117"), "classic"), true);
  assert.equal(isDarkTheme(theme("#f6f1e6"), "classic"), false);
});

/** 直接解 PNG 像素，免得底纹「看起来是棋盘」其实整张同色。 */
function pixels(dataUri) {
  const png = Buffer.from(dataUri.split(",")[1], "base64");
  assert.equal(png.readUInt32BE(16), 16, "宽 16px");
  assert.equal(png.readUInt32BE(20), 16, "高 16px");
  assert.equal(png[25], 2, "真彩色 RGB");
  const idat = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = [];
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const base = y * 49 + 1 + x * 3;
      out.push(`#${raw.subarray(base, base + 3).toString("hex")}`);
    }
  }
  return out;
}

test("经典像素的棋盘贴图与两色一致，8px 一格，与 CSS 渐变同一角起手", () => {
  for (const [dataUri, colors] of [
    [CHECKER_CLASSIC, CLASSIC_DARK],
    [CHECKER_CLASSIC_LIGHT, CLASSIC_LIGHT],
  ]) {
    const data = pixels(dataUri);
    assert.deepEqual(new Set(data), new Set([colors.tab1, colors.tab2]));
    // CSS repeating-conic-gradient(A 0 25%, B 0 50%) 的第一格是 B，所以左上是 tab2。
    assert.equal(data[0], colors.tab2);
    assert.equal(data[7], colors.tab2);
    assert.equal(data[8], colors.tab1);
    assert.equal(data[7 * 16], colors.tab2);
    assert.equal(data[8 * 16], colors.tab1);
    assert.equal(data[9 * 16 + 9], colors.tab2);
  }
});

test("细线比强边框更贴近卡片底色：界面靠留白分层，不靠粗框", () => {
  for (const [name, palette] of [
    ["深色", DARK],
    ["浅色", LIGHT],
  ]) {
    const card = luminance(palette.card) ?? 0;
    const line = Math.abs((luminance(palette.line) ?? 0) - card);
    const frame = Math.abs((luminance(palette.frame) ?? 0) - card);
    assert.ok(line < frame, `${name}：line 必须比 frame 更淡，否则整屏又会变成一排方框`);
  }
});
