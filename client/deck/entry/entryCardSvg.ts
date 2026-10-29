import type { DeckLang } from "../../../shared/requirement.ts";
import type { RequirementMode } from "../../../shared/requirement.ts";

/** DSH entry-card.ts 的定稿几何；这是图，不是另一套卡片排版。 */
export const ENTRY_CARD_W = 368;
export const ENTRY_CARD_H = 232;
const BODY_X = 208;
const CHAIN_TOP = 140;
const CHAIN_CY = 180;
const NODE_H = 16;
const FONT = 9.2;
const MAP = "#c084fc";
const SPEC = "#1D4ED8";
const BLUE = "#93c5fd";
const BLUE_TEXT = "#bfdbfe";
const PURPLE_TEXT = "#e9d5ff";
const DONE = "#56d364";

export interface EntryCardCopy {
  brow: string;
  state: string;
  body: string;
  need: string;
  goalClear: string;
}

const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (x: number, y: number, value: string, size: number, fill: string, extra = ""): string =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(value)}</text>`;
const path = (d: string, color: string, width = 1, extra = ""): string =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const alpha = (hex: string, opacity: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
};

/** DSH 的中文词组保护：不能把「没想清楚」切成「没想清 / 楚」。 */
const KEEP = ["规格", "实施票", "文档", "问号", "开工", "没定", "一条", "几条", "到底", "问清", "清楚", "想清楚", "没想清楚", "什么程度", "细节", "做到", "写成", "落成", "消掉", "摊开", "分头", "探出", "探路", "一排", "每个", "什么", "手里", "多了"];
const CJK = /[㐀-鿿]/;
function units(value: string): string[] {
  if (!CJK.test(value)) return value.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < value.length;) {
    const word = KEEP.find((candidate) => value.startsWith(candidate, i));
    out.push(word ?? value.charAt(i));
    i += word?.length ?? 1;
  }
  return out;
}
export function entryBodyLines(value: string, lang: DeckLang): string[] {
  const limit = lang === "zh" ? 12 : 24;
  const lines: string[] = [];
  let line = "";
  const width = (unit: string) => CJK.test(unit) ? unit.length : Math.max(1, unit.length * 0.55);
  for (const unit of units(value)) {
    const candidate = lang === "zh" ? `${line}${unit}` : `${line}${line ? " " : ""}${unit}`;
    if (line && Array.from(candidate).reduce((sum, char) => sum + width(char), 0) > limit) {
      lines.push(line);
      line = unit;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function capsule(color: string, ink: string, dashed: boolean, need: string): string {
  return `<rect x="6" y="42" width="42" height="20" rx="10" fill="none" stroke="${color}" stroke-width="1.3" ${dashed ? 'stroke-dasharray="3.4 2.4"' : ""}/>` +
    text(27, 56, need, 10.5, ink, 'text-anchor="middle" letter-spacing="0.5"');
}
function qmark(y: number): string {
  return `<circle cx="108" cy="${y}" r="8" fill="#0a0c10" stroke="${PURPLE_TEXT}" stroke-width="1.3"/>` + text(108, y + 3, "?", 10.8, PURPLE_TEXT, 'text-anchor="middle"');
}
function ring(color: string, check: boolean): string {
  return `<circle cx="148" cy="52" r="8" fill="#0b0d11" stroke="${color}" stroke-width="1.4"/>` + (check
    ? path("M144.6 52 l2.4 2.7 4.8-5.4", DONE, 1.8)
    : `<circle cx="148" cy="52" r="3.36" fill="none" stroke="${color}" stroke-width="1.1" opacity=".75"/>`);
}
function ticket(y: number): string {
  return `<rect x="70" y="${y}" width="36" height="17" rx="4" fill="rgba(29,78,216,.42)" stroke="${BLUE}" stroke-width="1.2"/>` +
    path(`M76 ${y + 8.5} l2.2 2.2 4-4.6`, DONE, 1.6) +
    path(`M86 ${y + 6} H101`, BLUE, 1.2, 'opacity=".7"') +
    path(`M86 ${y + 11.5} H94`, BLUE, 1, 'opacity=".35"');
}
function illustration(mode: RequirementMode, need: string): string {
  if (mode === "explore") {
    return capsule(MAP, PURPLE_TEXT, true, need) +
      '<circle cx="60" cy="52" r="5" fill="none" stroke="#c084fc" stroke-opacity=".35"/><circle cx="60" cy="52" r="2.6" fill="#c084fc"/>' +
      path("M62 52 H72", MAP, 1.6) + '<circle cx="76" cy="52" r="3.6" fill="#c084fc"/>' +
      path("M76 52 C84 46 92 26 100 21", MAP, 1.6, 'opacity=".9"') +
      path("M76 52 C86 52 94 52 100 52", MAP, 1.6, 'opacity=".9"') +
      path("M76 52 C84 58 92 78 100 83", MAP, 1.6, 'opacity=".9"') +
      qmark(20) + qmark(52) + qmark(84) +
      path("M116 20 C128 22 138 40 145 50", PURPLE_TEXT, 1.2, 'stroke-dasharray="4 4" opacity=".45"') +
      path("M116 52 C128 52 138 52 145 52", PURPLE_TEXT, 1.2, 'stroke-dasharray="4 4" opacity=".4"') +
      path("M116 84 C128 82 138 64 145 54", PURPLE_TEXT, 1.2, 'stroke-dasharray="4 4" opacity=".35"') +
      ring(PURPLE_TEXT, false).replace('cx="148"', 'cx="150"').replace('cx="148"', 'cx="150"');
  }
  const ys = [8, 31, 54, 77];
  const centers = [16.5, 39.5, 62.5, 85.5];
  return capsule(BLUE, BLUE_TEXT, false, need) + centers.map((cy, i) =>
    path(`M48 52 C56 52 58 ${cy} 68 ${cy}`, BLUE, 1.4, 'opacity=".75"') + ticket(ys[i] ?? 0) +
    path(`M106 ${cy} C118 ${cy} 128 ${cy < 52 ? cy + 8 : cy - 8} 138 50`, BLUE, 1.3, 'opacity=".55"'),
  ).join("") + ring(BLUE_TEXT, true);
}
const nodeWidth = (label: string): number => Math.max(28, Math.ceil((CJK.test(label) ? label.length * FONT : label.length * FONT * 0.55)) + 5);
/** DSH chainNode 的 rx 默认 5；只有探索链四行与右三格显式传 4。 */
function node(x: number, y: number, w: number, label: string, color: string, ink: string, fill: string, dash = false, rx = 5): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${NODE_H}" rx="${rx}" fill="${fill}" stroke="${color}" stroke-width="1" ${dash ? 'stroke-dasharray="3 2"' : ""}/>` +
    text(x + w / 2, y + NODE_H / 2 + FONT * 0.36, label, FONT, ink, 'text-anchor="middle" font-family="Consolas,Menlo,monospace"');
}
const arrow = (x1: number, x2: number, y: number, color: string): string => path(`M${x1} ${y} H${x2 - 3} M${x2 - 3.4} ${y - 2.4} L${x2} ${y} L${x2 - 3.4} ${y + 2.4}`, color);

function chain(mode: RequirementMode, goal: string): string {
  const goalW = nodeWidth(goal);
  const specW = nodeWidth("/to-spec");
  const ticketsW = nodeWidth("/to-tickets");
  const goalNode = (x: number) => node(x, CHAIN_CY - 8, goalW, goal, "#5c636d", "#b4bac2", "transparent", true, 4);
  const specNode = (x: number) => node(x, CHAIN_CY - 8, specW, "/to-spec", BLUE, BLUE_TEXT, alpha(SPEC, 0.3), false, 4);
  const ticketsNode = (x: number) => node(x, CHAIN_CY - 8, ticketsW, "/to-tickets", BLUE, BLUE_TEXT, alpha(SPEC, 0.3), false, 4);
  if (mode === "implement") {
    const start = 26;
    const grillW = nodeWidth("/grill-with-docs");
    const gx = start + grillW + 14;
    const sx = gx + goalW + 14;
    const tx = sx + specW + 14;
    return node(start, CHAIN_CY - 8, grillW, "/grill-with-docs", BLUE, BLUE_TEXT, alpha(SPEC, 0.3)) + arrow(start + grillW, gx, CHAIN_CY, BLUE) + goalNode(gx) + arrow(gx + goalW, sx, CHAIN_CY, BLUE) + specNode(sx) + arrow(sx + specW, tx, CHAIN_CY, BLUE) + ticketsNode(tx);
  }
  const labels = ["/prototype", "/research", "/grilling", "/domain-modeling"];
  const wayX = 22;
  const wayW = nodeWidth("/wayfinder");
  const sx = wayX + wayW + 6;
  const gx = sx + 6;
  const colW = Math.max(...labels.map(nodeWidth));
  const top = CHAIN_CY - (4 * NODE_H + 3 * 2.5) / 2;
  const bottom = top + 3 * (NODE_H + 2.5) + NODE_H;
  const brace = gx + colW + 2;
  const goalX = brace + 16;
  const specX = goalX + goalW + 5;
  const ticketsX = specX + specW + 5;
  return node(wayX, CHAIN_CY - 8, wayW, "/wayfinder", MAP, PURPLE_TEXT, alpha(MAP, 0.12)) + arrow(wayX + wayW, sx, CHAIN_CY, MAP) +
    path(`M${sx} ${CHAIN_CY} V${top + 8} M${sx} ${CHAIN_CY} V${bottom - 8}`, MAP) +
    labels.map((label, i) => {
      const y = top + i * (NODE_H + 2.5);
      return arrow(sx, gx, y + 8, MAP) + node(gx, y, nodeWidth(label), label, MAP, PURPLE_TEXT, alpha(MAP, 0.1), false, 4);
    }).join("") +
    path(`M${brace + 2} ${top + 8} Q${brace + 5} ${top + 8} ${brace + 5} ${top + 16} L${brace + 5} ${CHAIN_CY - 6} Q${brace + 5} ${CHAIN_CY} ${brace + 11} ${CHAIN_CY} Q${brace + 5} ${CHAIN_CY} ${brace + 5} ${CHAIN_CY + 6} L${brace + 5} ${bottom - 16} Q${brace + 5} ${bottom - 8} ${brace + 2} ${bottom - 8}`, MAP) +
    arrow(brace + 11, goalX, CHAIN_CY, MAP) + goalNode(goalX) + arrow(goalX + goalW, specX, CHAIN_CY, BLUE) + specNode(specX) + arrow(specX + specW, ticketsX, CHAIN_CY, BLUE) + ticketsNode(ticketsX);
}

/** React Native Image 可加载的原版 SVG；不是用通用图标重新猜一张。 */
export function entryCardSvg(mode: RequirementMode, copy: EntryCardCopy, lang: DeckLang): string {
  const identity = mode === "explore" ? MAP : SPEC;
  const color = mode === "explore" ? MAP : BLUE;
  const ink = mode === "explore" ? PURPLE_TEXT : BLUE_TEXT;
  const art = illustration(mode, copy.need);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ENTRY_CARD_W}" height="${ENTRY_CARD_H}" viewBox="0 0 ${ENTRY_CARD_W} ${ENTRY_CARD_H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">` +
    `<rect x="0.5" y="0.5" width="367" height="231" rx="12" fill="#10131a" stroke="${identity}" stroke-opacity="${mode === "explore" ? ".45" : ".75"}"/>` +
    '<rect x="12" y="12" width="184" height="116" rx="8" fill="#0a0c10" stroke="#2a2d35"/>' +
    `<g transform="translate(20,18)">${art}</g>` +
    text(208, 36, copy.brow, 11, color, 'opacity=".72" letter-spacing="1.2"') +
    text(208, 64, copy.state, 17, color, 'font-weight="700"') +
    entryBodyLines(copy.body, lang).map((line, i) => text(BODY_X, 86 + i * 17, line, 12, "#a1a1aa")).join("") +
    '<rect x="12" y="140" width="344" height="80" rx="8" fill="#0a0c10" stroke="#2a2d35"/>' + chain(mode, copy.goalClear) + "</svg>";
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 纯 JS 的 Base64：宿主 React Native 里没有 btoa，也不能依赖 Node Buffer。 */
function toBase64(bytes: string): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const value =
      (bytes.charCodeAt(index) << 16) | (bytes.charCodeAt(index + 1) << 8) | bytes.charCodeAt(index + 2);
    out += B64.charAt((value >> 18) & 63) + B64.charAt((value >> 12) & 63) + B64.charAt((value >> 6) & 63) + B64.charAt(value & 63);
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const value = bytes.charCodeAt(index) << 16;
    out += B64.charAt((value >> 18) & 63) + B64.charAt((value >> 12) & 63) + "==";
  } else if (rest === 2) {
    const value = (bytes.charCodeAt(index) << 16) | (bytes.charCodeAt(index + 1) << 8);
    out += B64.charAt((value >> 18) & 63) + B64.charAt((value >> 12) & 63) + B64.charAt((value >> 6) & 63) + "=";
  }
  return out;
}

/** 先按 UTF-8 百分比编码还原成字节，再 Base64；不依赖 btoa / Buffer。 */
export function entryCardDataUri(svg: string): string {
  const bytes = encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return `data:image/svg+xml;base64,${toBase64(bytes)}`;
}
