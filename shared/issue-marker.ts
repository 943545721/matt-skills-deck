/**
 * 票面对象类型标记的唯一真源（照抄 DSH `src/shared/issue-file/src/marker.ts`，#1277 口径）。
 *
 * 标记长这样，独占一行，写在文件头——幂等锚之后、一级标题之前：
 *   <!-- DSH-ISSUE-KIND: spec -->
 *
 * 为什么要它：规格（spec）与实施票（ticket）约定不带 wayfinder 标签，标签分不出它们；
 * 正文形状只是兜底，所以「这张票是哪一种对象」的唯一真源就是这行注释。
 *
 * 本文件是纯函数：只吃字符串、只吐字符串或 null，不读盘、不读钟、不联网。
 */

/** 九种对象类型。顺序与 DSH 的 ADR 2.1 表一致：容器在前，施工/研判票在后。 */
export const OBJECT_KINDS = Object.freeze([
  "map", "spec", "ticket", "research", "prototype", "grilling", "task", "bug", "issue",
] as const);

export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** 标记名只在这里写一次：写入的行与按行判断的正则都从它拼出来。 */
const MARKER_NAME = "DSH-ISSUE-KIND";

/** 一整行标记的唯一判据：必须从头到尾都是标记，前后多一个字都不算。 */
const MARKER_LINE_RE = new RegExp("^<!--\\s*" + MARKER_NAME + "\\s*:\\s*([a-z]+)\\s*-->$");

/** 约定「正文不补进度区、建票时由工具写类型标记」的两类对象。 */
const HEADER_ONLY_KINDS = Object.freeze(["spec", "ticket"] as const);

export type HeaderOnlyKind = (typeof HEADER_ONLY_KINDS)[number];

/** 运行时判断一个字符串是不是九种合法类型之一。 */
export function isObjectKind(value: unknown): value is ObjectKind {
  return typeof value === "string" && (OBJECT_KINDS as readonly string[]).indexOf(value) >= 0;
}

/** 这个类型是不是「只在文件头写标记」的两类之一。 */
export function isHeaderOnlyKind(value: unknown): value is HeaderOnlyKind {
  return typeof value === "string" && (HEADER_ONLY_KINDS as readonly string[]).indexOf(value) >= 0;
}

/**
 * 给一行可写入的标记文本，结尾带换行（与幂等锚同一习惯）。
 * 传进来的类型不合法时回空串：宁可不写，也不写一行认不出来的注释。
 */
export function markerLineFor(kind: unknown): string {
  if (!isObjectKind(kind)) return "";
  return "<!-- " + MARKER_NAME + ": " + kind + " -->\n";
}

/** 单独一行是不是标记行：去首尾空白后必须精确是 `<!-- DSH-ISSUE-KIND: <合法值> -->`。 */
export function markerKindOnLine(line: unknown): ObjectKind | null {
  const text = typeof line === "string" ? line.trim() : "";
  if (!text) return null;
  const matched = MARKER_LINE_RE.exec(text);
  if (!matched?.[1]) return null;
  return isObjectKind(matched[1]) ? matched[1] : null;
}

/**
 * 读文件头里的类型标记：只看第一个一级标题之前（没有一级标题时只看前 10 行）。
 *
 * 标记是文件元数据，写在标题之前；正文里也可能出现同样的写法（文档里举例说明），那一行不算数。
 * 回 null 表示「文件头没有合法标记」，不是错 —— 调用方按普通票处理。
 */
export function markerKindInHeader(text: unknown): ObjectKind | null {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return null;
  const heading = /^#+\s+/m.exec(raw);
  const head = heading ? raw.slice(0, heading.index) : raw.split("\n").slice(0, 10).join("\n");
  for (const line of head.split("\n")) {
    const kind = markerKindOnLine(line);
    if (kind) return kind;
  }
  return null;
}

/**
 * 读「第一个非空行」上的标记：deck 工具往正文最前面写标记时就是这种形状。
 * 与 `markerKindInHeader` 分开，因为两种调用方读的东西不一样。
 */
export function markerKindAtStart(text: unknown): ObjectKind | null {
  const raw = typeof text === "string" ? text : "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    return markerKindOnLine(line);
  }
  return null;
}

/** 数文本里有几行合法标记（整行判断，正文里引用一句标记写法不算）。 */
export function countMarkerLines(text: unknown): number {
  const raw = typeof text === "string" ? text : "";
  let count = 0;
  for (const line of raw.split("\n")) {
    if (markerKindOnLine(line)) count += 1;
  }
  return count;
}
