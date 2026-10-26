/**
 * 地图正文解析（wayfinder map 的五个区块）。
 *
 * 语义照抄源仓库 `src/tracker/body-parse.ts`：他们那边地图票正文由 agent 按模板写，
 * 面板只读不写，所以解析规则必须和写侧一致；差一个空格就会让「Not yet specified」整节变成空。
 *
 * 本文件是纯函数：不碰网络、不碰文件、不改入参。区块缺了就回空串或空数组，永不返回 null——
 * 界面拿到的永远是确定的形状。
 */

/** 一条决策：标题、链接与那句话本身。 */
export interface MapDecision {
  title: string;
  url: string;
  gist: string;
}

/** 地图五个区块的解析结果。 */
export interface ParsedMapBody {
  /** `## Destination`：目标那一句。 */
  destination: string;
  /** `## Notes`：备注。 */
  notes: string;
  /** `## Decisions so far`：已定的决策。 */
  decisions: MapDecision[];
  /** `## Not yet specified`：还没定的事（HTML 注释行不算）。 */
  fog: string[];
  /** `## Out of scope`：明确不做的（HTML 注释行不算）。 */
  outOfScope: string[];
}

/** 只有这五个标题能切出区块；正文里讨论标题本身不算标题。 */
export const MAP_SECTION_TITLES = ["Destination", "Notes", "Decisions so far", "Not yet specified", "Out of scope"];

/** 决策那句话的截断上限：够看清意思，又不至于把弹窗撑成一屏。 */
const GIST_LIMIT = 240;

/** 剥 BOM；真实换行少于两处而字面 `\n` 存在时，把字面 `\n` 还原。上游可能交来空值，按空串处理。 */
export function normalizeBody(raw: unknown): string {
  let text = String(raw || "").replace(/^﻿/, "");
  const realNewlines = (text.match(/\n/g) ?? []).length;
  const literalNewlines = (text.match(/\\n/g) ?? []).length;
  if (realNewlines < 2 && literalNewlines > 0) text = text.replace(/\\n/g, "\n");
  return text;
}

/**
 * 把粘在上一行末尾的规范标题拆成独立行。
 *
 * 只拆「`## 标题` 出现在行中且一直写到行尾」这一种形状；后面还跟字的（正文在讨论标题本身）
 * 原样保留，围栏代码块里的一律不动。
 */
export function splitGluedHeadings(body: unknown): string {
  const fenceRe = /^\s*(`{3,}|~{3,})/;
  const titles = MAP_SECTION_TITLES.map((title) => title.replace(/ /g, "\\s+")).join("|");
  const gluedRe = new RegExp(`^(.*\\S)\\s*##\\s*(${titles})\\s*$`);
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of String(body || "").split(/\r?\n/)) {
    const fenceMatch = line.match(fenceRe);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? "`";
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }
    const glued = line.match(gluedRe);
    if (glued) {
      out.push(glued[1] ?? "");
      out.push(`## ${(glued[2] ?? "").replace(/\s+/g, " ").trim()}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** 超长就退到 240 字内最后一个完整词后面再补省略号；一个完整词都没有时硬切。 */
export function truncateGist(gist: string): string {
  const text = String(gist || "");
  if (text.length <= GIST_LIMIT) return text;
  const head = text.slice(0, GIST_LIMIT);
  const lastBlank = head.search(/\s+\S*$/);
  const kept = (lastBlank > 0 ? head.slice(0, lastBlank) : head).replace(/\s+$/, "");
  return `${kept === "" ? head : kept}…`;
}

/**
 * 一条决策行。两种写法都认：
 * 经典 `- [标题](链接) — 一句话`，以及加粗 `- **标题**：一句话`（标题里可以再嵌一个链接）。
 */
export function parseDecisionLine(line: string): MapDecision | null {
  if (line.startsWith("- [")) {
    const link = line.match(/\[(.+?)\]\((.+?)\)/);
    const gist = line.replace(/^-\s*\[.+?\]\(.+?\)\s*[-–—]?\s*/, "");
    return { title: link?.[1] ?? line, url: link?.[2] ?? "", gist: truncateGist(gist) };
  }
  const bold = line.match(/^-\s*\*\*(.+?)\*\*\s*[:：-]?\s*(.*)$/);
  if (bold) {
    const inner = bold[1] ?? "";
    const link = inner.match(/\[(.+?)\]\((.+?)\)/);
    // `[#1057](链接)` 这种把票号写成链接文字本身，标题里只留票号。
    const title = link ? inner.replace(`[${link[1]}](${link[2]})`, link[1] ?? "") : inner;
    return { title, url: link?.[2] ?? "", gist: truncateGist(bold[2] ?? "") };
  }
  return null;
}

/** 按二级标题切块，取出五个区块。`##` 与标题之间允许没有空格（`##Notes` 也算标题）。 */
export function parseMapBody(body: unknown): ParsedMapBody {
  const out: ParsedMapBody = { destination: "", notes: "", decisions: [], fog: [], outOfScope: [] };
  if (!body) return out;
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of splitGluedHeadings(normalizeBody(body)).split(/\r?\n/)) {
    const heading = line.match(/^##\s*(.+?)\s*$/);
    if (heading) {
      current = heading[1] ?? "";
      sections[current] = sections[current] ?? [];
      continue;
    }
    if (current !== null) (sections[current] ??= []).push(line);
  }
  const clean = (arr: string[] | undefined): string[] => (arr ?? []).map((one) => one.trim()).filter(Boolean);
  out.destination = clean(sections["Destination"]).join(" ");
  out.notes = clean(sections["Notes"]).join(" ");
  out.decisions = clean(sections["Decisions so far"])
    .map((line) => parseDecisionLine(line))
    .filter((decision): decision is MapDecision => decision !== null);
  out.fog = clean(sections["Not yet specified"]).filter((line) => !line.startsWith("<!--"));
  out.outOfScope = clean(sections["Out of scope"]).filter((line) => !line.startsWith("<!--"));
  return out;
}
