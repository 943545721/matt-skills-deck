/**
 * 需求票的六步骨架。
 *
 * 探索与实施是两条不同的入口：探索先把问题与选项说清楚，实施先把范围与测试说清楚。
 * 骨架只是起点——用户写的备注原样附在后面，不塞进某一个小节里假装已经想清楚了。
 *
 * 纯函数，客户端生成正文、测试校验形状都用这一份。
 */

export type RequirementMode = "explore" | "implement";

const SECTIONS: Record<RequirementMode, readonly string[]> = {
  explore: ["Problem", "Goals and non-goals", "Constraints", "Options", "Recommendation", "Open questions"],
  implement: ["Context", "Goal", "Scope", "Steps", "Test plan", "Risks and rollback"],
};

const PLACEHOLDER = "<!-- Fill this in before implementation. -->";

export function requirementSections(mode: RequirementMode): readonly string[] {
  return SECTIONS[mode];
}

export function buildRequirementBody(mode: RequirementMode, notes: string): string {
  const skeleton = SECTIONS[mode].flatMap((title) => [`## ${title}`, PLACEHOLDER, ""]);
  const trimmed = notes.trim();
  if (!trimmed) return skeleton.join("\n");
  return [...skeleton, "## Notes", trimmed, ""].join("\n");
}

/** 需求票统一带 `requirement`：不抢 wayfinder 路线标签，路线仍由地图显式挂。 */
export function requirementLabels(): string[] {
  return ["requirement"];
}
