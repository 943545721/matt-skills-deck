/**
 * 建票时补正文骨架（照抄 DSH `src/deck/rules/minimal-spec.ts` 的 ensureBody）。
 *
 * 地图先补五个区块，然后所有位置值都补一个「## 进度」；进度区永远放在最后。
 * 判据是「正文里有没有认得出的那一行」，所以空正文照样要补；已有同一判据的标题不重复补。
 */
import { MAP_SECTION_TITLES } from "./map-body.ts";
import { ruleFor } from "../../shared/issue-kind.ts";

/** 把一段文本里的正则元字符转义掉：区块标题要按原文匹配。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 地图正文缺哪几个区块（按 `## 标题` 这一行的原文判）。 */
function missingMapBlocks(text: string): string[] {
  return MAP_SECTION_TITLES.filter((title) => !new RegExp("^##\\s*" + escapeRegExp(title) + "\\s*$", "m").test(text));
}

/**
 * 正文里有没有认得出的进度标题。
 * 口径：`## 进度` 与 `## 进度：80%`、`## Progress: 40%` 都算有 —— 不这么宽的话，
 * 已经带了百分比的票会被再插一段重复的进度区。
 */
function hasProgressHeading(text: string): boolean {
  return /^##\s*(?:进度|Progress)(?:\s*[：:]\s*\d{1,3}\s*%?)?\s*$/m.test(text);
}

export function ensureIssueBody(body: unknown, kind: unknown): { body: string; added: string[] } {
  const text = typeof body === "string" ? body : "";
  const added: string[] = [];
  let out = text;
  const rule = ruleFor(kind);
  if (rule?.mapBlocks) {
    const missing = missingMapBlocks(text);
    if (missing.length) {
      out = out.replace(/\s*$/, "") + "\n" + missing.map((title) => "\n## " + title + "\n").join("");
      for (const title of missing) added.push("## " + title);
    }
  }
  // 进度区所有位置值都补（含规格与实施票）；已有同一判据的标题不重复补。
  if (!hasProgressHeading(text)) {
    out = (out.replace(/\s*$/, "") + "\n\n## 进度\n").replace(/^\n+/, "");
    added.push("## 进度");
  }
  return { body: out, added };
}
