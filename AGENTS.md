# matt-skills-deck · agent 配置

## Agent skills

### Issue tracker

票与规格都放在 GitHub Issues（`gh` CLI），地图与子票用 `wayfinder:*` 标签。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个分诊角色与标签字符串同名（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：仓库根目录一份 `GLOSSARY.md`，架构决定放 `docs/adr/`。见 `docs/agents/domain.md`。

## 改完代码之后

**改代码后必须核对文档、跑 `/code-review`，再汇报。** 顺序固定：

1. `npm run typecheck` 与 `npm test` 全绿；
2. 调 `/code-doc-drift` 对照本次改动检查相关说明文档；确认只是实现说明过时时，按已确认的需求和行为同步；若与 ADR、规范或用户决定冲突，先报告，不擅自改决定；
3. 调 `/code-review` 审这批改动（不是只看测试过没过），按结论处理 CRITICAL / HIGH，能修的 MEDIUM 一并修；
4. 汇报文档核对结论与审查结论；审查没过就不说「完成」。
