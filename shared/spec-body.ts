const SECTIONS = [
  ["problem", ["Problem Statement", "问题陈述"]],
  ["solution", ["Solution", "解决方案"]],
  ["userStories", ["User Stories", "用户故事"]],
  ["implDecisions", ["Implementation Decisions", "实现决策"]],
  ["testDecisions", ["Testing Decisions", "测试决策"]],
  ["outOfScope", ["Out of Scope", "不在范围内"]],
  ["furtherNotes", ["Further Notes", "补充说明"]],
] as const;

export type ParsedSpecBody = {
  problem: string;
  solution: string;
  userStories: string[];
  implDecisions: string[];
  testDecisions: string[];
  outOfScope: string[];
  furtherNotes: string[];
};

export function parseSpecBody(raw: unknown): ParsedSpecBody {
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  const out: ParsedSpecBody = { problem: "", solution: "", userStories: [], implDecisions: [], testDecisions: [], outOfScope: [], furtherNotes: [] };
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const name = String(heading?.[1] ?? "").trim().toLowerCase();
    const match = SECTIONS.find(([, names]) => names.some((candidate) => candidate.toLowerCase() === name));
    if (!match) continue;
    const start = (heading?.index ?? 0) + String(heading?.[0] ?? "").length;
    const end = headings[index + 1]?.index ?? text.length;
    const lines = text.slice(start, end).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("<!--"));
    const content = lines.join(" ");
    if (match[0] === "userStories" || match[0] === "implDecisions" || match[0] === "testDecisions" || match[0] === "outOfScope" || match[0] === "furtherNotes") {
      out[match[0]] = lines;
    } else {
      out[match[0]] = content;
    }
  }
  return out;
}

export const SPEC_SECTION_KEYS = SECTIONS.map(([key]) => key);
