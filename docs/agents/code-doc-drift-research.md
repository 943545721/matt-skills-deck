# 避免代码前行、文档残留：机制调研

调查范围：仓库内实现与一手规则；Claude Code 官方文档在本环境未能成功读取或检索，外部机制结论不作未经核验的断言。本文是研究笔记，不是新增长期流程规范。

## 结论

- 当前仓库把代码变更后的验证交给工作流/技能触发：`AGENTS.md` 要求跑 `/code-review`，`implement` 也明确在工作完成后调用它。它不是常驻员工或自动化 hook。来源：[AGENTS.md:17-23](../../AGENTS.md#L17)、[implement/SKILL.md:1-15](../../.claude/skills/implement/SKILL.md#L1)。
- `/code-review` 的目标是固定点之后的 diff，并分开核查仓库规范和最初规格符合度；其流程没有要求全面扫描、同步所有文档。来源：[code-review/SKILL.md:6-11](../../.claude/skills/code-review/SKILL.md#L6)、[code-review/SKILL.md:25-33](../../.claude/skills/code-review/SKILL.md#L25)、[code-review/SKILL.md:74-87](../../.claude/skills/code-review/SKILL.md#L74)。所以它适合作为提醒/发现入口，不足以单独保证文档不漂移。
- 岗位卡不是常驻 AI 员工：它是名册里的职责提示、档案选择、路径范围和并发配置；会话由派单/编排另行创建，并受单例/额度闸控制。来源：[shared/staff.ts:31-58](../../shared/staff.ts#L31)、[server/staff-gates.ts:17-18](../../server/staff-gates.ts#L17)、[server/hooks.ts:656-662](../../server/hooks.ts#L656)。
- 本插件已有 `agent.turn_ended` hook，但当前仅对子会话调用 `TurnReporter`，把 handoff/时间线尾部发送给父会话或进度窗口。来源：[server/hooks.ts:789-800](../../server/hooks.ts#L789)、[server/report.ts:8-23](../../server/report.ts#L8)、[server/report.ts:179-226](../../server/report.ts#L179)。
- 可以在本插件的同一宿主事件注册额外检查逻辑，但当前事件处理器没有建立“代码改动对应哪些文档、哪份文档是权威”的映射。它收到 agent、turnId、outcome 和运行上下文，现有用途是会话收尾回传；事件可复用不等于已有可靠文档审计能力。来源：[server/hooks.ts:792-800](../../server/hooks.ts#L792)、[server/report.ts:30-48](../../server/report.ts#L30)。更稳妥的做法是让实现/评审技能针对本次 diff 判定文档影响，并在有明确事实依据时更新；若未来增加自动 hook，应先做提示或报告，不应无条件改写文档。
- 冲突不能一律“以代码为准”。`domain.md` 规定，产出与 ADR 矛盾时要明确指出而不是悄悄覆盖；领域模型技能要求发现代码与用户描述矛盾时提出冲突，确认术语后就地更新词汇表。历史决策可能需要重新讨论，当前规范要先被理解，单纯实现说明才适合按已确认的当前行为修订。来源：[domain.md:47-51](../../docs/agents/domain.md#L47)、[domain-modeling/SKILL.md:56-64](../../.claude/skills/domain-modeling/SKILL.md#L56)、[writing-for-agents/SKILL.md:78-80](../../.claude/skills/writing-for-agents/SKILL.md#L78)。
- 仓库已有写给代理的文档维护原则：单一事实来源、环境中可直接查到的事实不要复制成易过期缓存、逐行检查相关性/过时内容。它支持减少文档漂移面，但不是自动检测器。来源：[writing-for-agents/SKILL.md:76-81](../../.claude/skills/writing-for-agents/SKILL.md#L76)。

## 建议的责任边界

主要由技能/工作流在每次有意义的实现或评审时触发“文档影响检查”，而不是依赖常驻员工。具体应查看改动与现有文档、ADR、领域术语及规格的关系；结论分为同步实现说明、保留且标记决策冲突、或无需改文档。只有确认文档描述的是当前实现事实且不是尚有效的约束/历史决策后，才更新它。`AGENTS.md` 可以常驻一条简短的检查要求及调用指针；详细检查步骤放在实现或评审技能中，避免常驻上下文重复整份策略。

## 官方资料核验状态

已尝试 Claude Code 官方入口 `https://code.claude.com/docs/en/hooks`、`/skills`、`/sub-agents`，WebFetch 均因无法验证该域名而失败。WebSearch 明确返回无法进行实时搜索的说明，并只给出官方 docs 首页链接；它不是实际搜索结果。因此本文不把 hooks、skills、subagents 的官方行为作为已核实事实。仓库现有机制结论以上述项目源码为准。

## 笔记位置

仓库现有调研笔记目录约定不明确：`docs/agents/` 存放 agent 规则，`.claude/plans/` 存放计划而非调研。本文放在 `docs/agents/code-doc-drift-research.md`，作为唯一研究笔记；没有改动代码、issue 或台账。
