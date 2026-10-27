# 与 DSH 版的逐项对照

源仓库：[FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck)（DSH CLI 插件）。
本仓库是同一套产品思路的 **Paseo 0.13 插件**。两边宿主能提供的面不一样，所以差异分三类：

- **照搬语义**：数据怎么读、怎么排、怎么解析，与源仓库同口径，改口径会让两边对同一张票给出不同结论。
- **换面实现**：功能在，但落到了 Paseo 有的面上（标签页、弹窗、剪贴板、MCP 工具）。
- **未做**：宿主没有对应能力，或本轮没排进范围；原因写清楚，不假装做到。

## A1–A26 能力盘点（2026-10-27 重建）

> 移植计划的目标写的是「对齐 DSH 版全部 26 项用户可见能力（A1–A26）」，但计划文件里
> **没有这份清单**，因此一直没有可逐项打勾的验收表。下表按 DSH 源码重建：
> 文案取自 `src/client/kernel/locale-data.ts`，界面取自 `src/client/views/`，
> 工具取自 `src/deck/tools/` 与 `src/deck/registration/`。这是当前唯一的对齐口径。

| # | DSH 版能力 | 本插件 | 结论 | 说明 / 证据 |
|---|---|---|---|---|
| A1 | 任务列表：地图票与普通票同池，地图优先 → 未关闭优先 → 最近更新；行内票号、标题、标签、指派 | 工作区标签页里的任务板，排序口径照搬 | **已有（无 PR）** | `client/deck/BoardView.tsx`、`server/tracker/order.ts`；PR 见 A5 |
| A2 | 列表 KPI：可接 / 阻塞 / 已关闭三个计数 | 无 | **未做** | 缺 blockedBy 与占用口径，见 A4 |
| A3 | 筛选与排序：全部 / Open / 已关闭 / 阻塞 / 可接 / 已合并，标签、更新、创建、编号、标题 | 只有「仅未关闭」一个开关 | **未做** | 数据与 UI 都缺；`vendor` 未实现 |
| A4 | 阻塞关系：blockedBy 原生边 + assignee 占用；「被谁阻塞」可点进地图 | 无 | **未做** | `server/tracker/github.ts` 的查询没取 `blockedBy` / assignee 占用 |
| A5 | 拉取请求：与票同池、独立页签、只读评论、打开 / 已关闭 / 已合并三态 | 无 | **未做** | 未接 GraphQL `pullRequests` 与 `isPullRequest`；此前版本的本文件**漏列了这一项** |
| A6 | 单票详情：正文 GFM、评论、标签、指派、状态、打开 GitHub | 弹窗详情：正文 Markdown、评论、标签、指派、状态 | **已有** | `client/deck/IssueModal.tsx`；没有「在 GitHub 打开」按钮（复制出的提示词里带链接） |
| A7 | 行级动作：诊断 / 修复 / 研究 / 接手 / 完成、复制链接、复制 prompt | 复制处理提示词（含票链接） | **换面** | 动作在 DSH 是注入会话；Paseo 插件改不了输入框（D1） |
| A8 | 新建票、`+ bug` 快捷、新建需求（探索 / 实施二选一 + 六步初始化） | 新建票（可勾「地图」并自动带 `wayfinder:map`） | **部分** | 需求向导按决策不做；`client/deck/NewIssueModal.tsx` |
| A9 | 空仓库引导：`git init` + 创建并发布仓库 + 标签补全指引 | 只报「没有可识别的 GitHub 远端」 | **未做** | 需要仓库创建权限与写 API；当前有闸门，不放行写 |
| A10 | 地图详情：五区块、层级与层进度、子票分组（可接 / 认领 / 阻塞 / 关闭）、开始 / 推进按钮 | 五区块 + 工作路线 + 下一步建议 | **部分** | 层级与子票分组未做；`client/deck/MapModal.tsx` |
| A11 | 工作路线：当前会话处理的票 + 跨会话在办表 | 票面维度的路线票（按 `wayfinder:*` 排序） | **换面** | 会话维度拿不到（Paseo 无 `sessionQuery` / 会话事件） |
| A12 | 输入框上方胶囊栏 + 状态栏：可接、故障、需诊断、刷新、处理路径表 | 无 | **未做** | 0.13 无全局状态栏；`addComposerPill` 必须按 `agentId` 注册，插件拿不到列表 |
| A13 | 技能页：27 技能、详情原文、注入对话框、安装 | 技能页：列表、详情、复制原文、按工作区安装到 `.claude/skills` 与 `.agents/skills` | **已有 + 换面** | `client/deck/SkillsView.tsx`；注入换成复制（D1） |
| A14 | 环境检查页：主目录、后端选择、gh、登录态、仓库、技能、初始化，逐项修复指引 | 诊断页：环境读数 + 操作日志 | **部分** | 有读数，无逐项检查与「注入修复指引」；`client/deck/DiagnosticsView.tsx` |
| A15 | 多后端：GitHub / GitLab / 本地 Markdown，切换前做迁移前置检查 | 只接 GitHub（读与写） | **未做** | GitLab / Markdown 未接；写路径有闸门，避免「假成功」；`server/rpc/repo-gate.ts` |
| A16 | 标签配色：读、改、复制配色提示词、逐条应用并读回核对 | 标签列表 + 改色 + 可读文字色换算 | **部分** | 无「配色提示词」复制；`client/deck/LabelsView.tsx` |
| A17 | 版本管理：状态、文件 diff、提交历史、stage / commit / pull / push、AI 交接 | 状态、diff、stage / unstage / commit / pull / push / fetch、按票提交 | **部分** | `deck.git.log` 已有但页面未接提交历史；无 AI 交接；`client/deck/VersionView.tsx` |
| A18 | 仓库初始化向导：探索 / 实施、六步、域文档布局确认 | 无 | **未做** | 流程外壳，Paseo 没有承载面；决策记为不做 |
| A19 | 设置页：后端、语言、调试开关、模板 | 无独立设置页；语言跟随 App | **未做** | D5；标签配色与诊断各自成页 |
| A20 | 诊断日志：开关、导出、清空、打开目录 | 操作日志缓冲 + 复制 | **部分** | 无开关 / 导出 / 清空 / 打开目录；`client/deck/DiagnosticsView.tsx` |
| A21 | 更新检查与一键安装 | 无 | **未做** | 交给 Paseo 自身的插件更新（计划已定） |
| A22 | 会话自动命名（规则截取 / 模型摘要） | 无 | **未做** | D4：`agent.create` 钩子看不到首条提示词，也没有改名 API |
| A23 | 数据新鲜度与配额：上次更新时间、落后提示、GraphQL → REST 回退、额度读数 | 回包带 `fetchedAt`，界面不展示 | **部分** | 无配额、无 REST 回退、无自动刷新；`shared/issues.ts` |
| A24 | 状态横幅：仓库未识别、登录态未就绪、未初始化、环境未就绪 | 面板内错误卡片（含「gh 未登录」与远端解析失败） | **部分** | 无全局横幅 / 胶囊；`client/deck/BoardView.tsx` |
| A25 | Agent 工具：九颗 `deck_*` 追踪器工具 + `deck_probe` + 下一步建议 | 7 个 MCP 工具：`deck_issues_list` / `deck_issue_get` / `deck_issue_create` / `deck_issue_comment` / `deck_issue_labels` / `deck_map` / `deck_next_steps` | **部分** | 缺 `deck_context`、`deck_issue_patch`（改标题 / 正文 / 状态）、`deck_issue_report`、`deck_map_link`、`deck_map_plan_create`、`deck_probe` 等；`server/mcp/tools.ts` |
| A26 | 中英双语 + 像素风卡片 | 中英双语（`defineTranslations`，跟随 App）+ RN 像素风 | **已有** | `client/deck/messages.ts`、`client/deck/pixel.tsx` |

**合计（26 项）**：已有 4（A1、A6、A13、A26）、换面 2（A7、A11）、部分 9（A8、A10、A14、A16、A17、A20、A23、A24、A25）、未做 11（A2、A3、A4、A5、A9、A12、A15、A18、A19、A21、A22）。
A13 同时含换面成分（注入对话框改为复制原文），按「已有」计；不做四舍五入式的「基本对齐」表述。

## 缺口清单（按可见度与可行性排序）

### 第一优先：数据已在 gh 能力范围内，用户一眼能看到

1. **A5 拉取请求**：查询加 `pullRequests` 连接与 `isPullRequest` 标记，列表同池、独立页签、只读评论、三种状态。工作量中等（M），不依赖新宿主能力。
2. **A4 + A2 + A3 阻塞 / 可接 / 筛选排序**：列表查询补 `blockedBy` 与 assignee，前端加 KPI、筛选行与排序。工作量中等（M），与源仓库口径必须一致（「打开的被阻塞者才算阻塞」）。
3. **A23 最近更新时间**：`fetchedAt` 已有，界面显示「N 分钟前」即可。小（S）。

### 第二优先：把现有页面补到 DSH 的深度

4. **A17 提交历史**：`deck.git.log` 已有，页面接上；AI 交接（A17 后半）另算。小（S）。
5. **A16 配色提示词**：把当前标签与颜色拼成提示词复制，复用 D1 的剪贴板路径。小（S）。
6. **A10 地图层级与子票分组**：需要在查询里取子票与 `parent`，前端按可接 / 认领 / 阻塞 / 关闭分组。中等（M）。
7. **A20 诊断日志导出 / 清空 / 开关**：服务端已有日志缓冲，补导出与清空 RPC。小到中（S/M）。
8. **A6 打开 GitHub**：若 SDK 提供外链能力则接；没有就继续用复制链接。

### 第三优先：工作流外壳或宿主限制

9. **A25 剩余工具**：`deck_issue_patch`、`deck_issue_report`、`deck_map_link`、`deck_map_plan_create` 等，按实际使用频率补。中等（M）。
10. **A8 新建需求向导 / A18 初始化向导**：DSH 特有工作流外壳，Paseo 没有对应承载面，需要重新设计落点。大（L）。
11. **A15 多后端 / A9 空仓库引导**：写接口与权限模型都要新做，风险高。大（L）。
12. **A12 胶囊栏 / A22 会话命名 / A21 更新检查**：宿主能力缺失，保持不做，等平台补 API。

## 照搬过来的语义（改了就是 bug）

- 规范标签与颜色：`bug` `needs-triage` `needs-info` `ready-for-agent` `ready-for-human` `wayfinder:grilling` `wayfinder:map` `wayfinder:prototype` `wayfinder:research` `wayfinder:task`。
- 地图正文五个区块：`Destination` / `Notes` / `Decisions so far` / `Not yet specified` / `Out of scope`；`##` 与标题之间没有空格也算标题；粘在上一行末尾的标题会被切开；围栏代码块里的不动。
- 决策行两种写法：`- [标题](链接) — 一句话` 与 `- **标题**：一句话`；加粗写法里 `[#1057](链接)` 只留票号当标题。
- 决策那句话超 240 字就退到最后一个完整词再加省略号。
- 雾与「不做」里的 HTML 注释行不进界面，其余行（含 `- ` 符号）原样保留。
- 路线只收 `wayfinder:research|prototype|grilling|task`，**剔除地图票自己**；开着的排在关掉的前面，同类按票号升序。
- 建议按「先目标、再雾、再研究/讨论/原型/任务」的次序给。
- 阻塞口径（补做 A4 时必须照搬）：只有**打开**的阻塞者才算阻塞；assignee 占用也计入「阻塞」；关掉的阻塞者不影响可接。

## 没搬的部分与原因

- **拉取请求（A5）与阻塞/可接（A2–A4）**：此前既没实现，也没写进这份对照表——这是文档缺口，现已补上。两者都不需要新的宿主能力，属于该补而没补。
- **多后端（A15）**：GitLab 与本地 Markdown 的读写都没接。写路径尤其需要闸门——GitLab 的写接口没实现时若放行，用户会看到「成功」而远端什么也没发生。
- **流程向导（A8 / A18）**：「探索 / 实施」二选一 + 六步初始化是 DSH 特有的工作流外壳，Paseo 没有对应的承载面，硬搬到标签页里只会变成一屏的说明文字。
- **注入到对话框（A7 / A11）**：Paseo 插件拿不到 Agent 的输入框，只能产出文本由用户粘贴。
- **模型生成建议（A25）**：源仓库的建议由模型生成（2–4 条、限制各自长度与优先级），这里改成纯规则码（理由 + 提示词模板在前端按语言组装），因为插件不该在每次读地图时额外烧一次模型调用。
- **会话维度（A11 / A12 / A22）**：Paseo 插件拿不到会话列表、首条提示词与改名 API，凡是依赖会话的功能都只能换面或不做。
