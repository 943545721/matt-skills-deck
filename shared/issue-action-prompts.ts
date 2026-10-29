import type { ItemKind } from "./issues.ts";

export type IssueAction = "diagnose" | "fix" | "discuss" | "research" | "prototype" | "takeover" | "supplement" | "execute";

export function issueActionPrompt(action: IssueAction, lang: "zh" | "en", kind: ItemKind): string {
  if (kind === "pull-request") return lang === "zh" ? "只审查这个拉取请求；不要尝试修改远端 PR。" : "Review this pull request only; do not try to modify the remote PR.";
  const zh: Record<IssueAction, string> = {
    diagnose: "/triage\n\n## 先核对是否已有实施\n- [ ] 先读正文、评论和已有记录，确认是否已经实施，避免重复修复。\n\n## 调查（建议先查后问）\n- [ ] 先读票面、评论与仓内相关资料；优先复用已有笔记。\n- [ ] 诊断不等于修复：不改业务代码、不开始实施。\n\n## 收尾\n- [ ] 写回真实状态；待拍板事项逐条提问并等待回复。",
    fix: "/implement\n\n## 读现状\n- [ ] 读全正文、评论、验收判据、父子与阻塞边；未认领先认领。\n- [ ] 未关闭的前置票先处理或说明可并行；改动范围不要超出票面。\n\n## 收尾\n- [ ] 跑测试并写回真实状态；完成后关闭，未完成写明缺口。",
    discuss: "/grill-me\n\n## 调查（建议先查后问）\n- [ ] 先读票面、评论和仓内相关资料，再讨论方案与取舍。\n- [ ] 把未决问题逐条问清，不要未经确认就实施。\n\n## 收尾\n- [ ] 记录决定；结论对齐后提醒用户手动执行 /to-spec 与 /to-tickets。",
    research: "/research\n\n## 调查\n- [ ] 先查并复用仓内相关笔记；只有已有资料不能回答时才新做研究。\n- [ ] 新笔记路径和结论写回票面。\n\n## 收尾\n- [ ] 写明证据、结论和仍未知的部分。",
    prototype: "/prototype\n\n## 调查\n- [ ] 先读票面和仓内资料，构建一次性原型验证关键假设。\n- [ ] 原型用于回答问题，不扩展成完整产品实现。\n\n## 收尾\n- [ ] 记录发现、风险、丢弃原型的范围与下一步。",
    takeover: "/wayfinder\n\n## 调查\n- [ ] 读全票面、评论和已有进展；除必须由用户完成的部分外继续推进。\n- [ ] 需要人工权限、设计决定或手工测试时，列出明确步骤与验证方法。\n\n## 收尾\n- [ ] 写回真实状态和下一步。",
    supplement: "/wayfinder\n\n## 读全\n- [ ] 读正文、评论、标签、认领和阻塞关系；已回答的问题不重复问。\n- [ ] 只问最阻塞的一两个问题，明确所需日志、复现步骤或期望结果。\n- [ ] 等待期间不实施、不关闭票；回答后重新分流。",
    execute: "/implement\n\n## 读现状\n- [ ] 读正文、评论、验收判据、父子与阻塞边，确认交付范围。\n- [ ] 先处理未关闭的前置票，或说明为何可以并行。\n\n## 收尾\n- [ ] 跑验证并写回证据；完成后关闭，未完成说明缺口。",
  };
  const en: Record<IssueAction, string> = {
    diagnose: "/triage\n\n## Check for existing implementation first\n- [ ] Read the body, comments and records before acting; do not re-implement completed work.\n\n## Investigate first\n- [ ] Read the ticket, comments and related repository material; reuse existing notes first.\n- [ ] Diagnosis is not fixing: do not change product code or begin implementation.\n\n## Wrap-up\n- [ ] Write the true state back; list decisions and wait for the reply.",
    fix: "/implement\n\n## Read current state\n- [ ] Read the body, comments, acceptance criteria, parent and blockers; claim it if needed.\n- [ ] Resolve open blockers first or explain parallel work; stay within scope.\n\n## Wrap-up\n- [ ] Run tests and write back the true state; close only when complete.",
    discuss: "/grill-me\n\n## Investigate first\n- [ ] Read the ticket, comments and repository material before discussing options and trade-offs.\n- [ ] Resolve open questions explicitly; do not implement before agreement.\n\n## Wrap-up\n- [ ] Record decisions; after alignment, remind the user to run /to-spec and /to-tickets manually.",
    research: "/research\n\n## Investigate\n- [ ] Reuse related repository notes first; research anew only when they cannot answer the question.\n- [ ] Write the new note path and conclusion back into the ticket.\n\n## Wrap-up\n- [ ] State evidence, conclusions and what remains unknown.",
    prototype: "/prototype\n\n## Investigate\n- [ ] Read the ticket and repository material; build a throwaway prototype for the key assumption.\n- [ ] Use it to answer the question, not to build the full product.\n\n## Wrap-up\n- [ ] Record findings, risks, what to discard and the next step.",
    takeover: "/wayfinder\n\n## Investigate\n- [ ] Read the ticket, comments and progress; continue everything except work the user must personally do.\n- [ ] For permissions, design decisions or manual tests, list concrete steps and verification.\n\n## Wrap-up\n- [ ] Write the true state and next step back.",
    supplement: "/wayfinder\n\n## Read the whole ticket\n- [ ] Read the body, comments, labels, claim and blockers; never re-ask what is answered.\n- [ ] Ask only the one or two most blocking questions, naming needed logs, reproduction steps or expected results.\n- [ ] Do not implement or close while waiting; re-triage after the reply.",
    execute: "/implement\n\n## Read current state\n- [ ] Read the body, comments, acceptance criteria, parent and blockers; confirm scope.\n- [ ] Resolve open blockers first or explain why work can proceed in parallel.\n\n## Wrap-up\n- [ ] Run verification and write back evidence; close only when complete.",
  };
  return (lang === "zh" ? zh : en)[action];
}
