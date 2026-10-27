# 与 DSH 版的逐项对照

源仓库：[FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck)（DSH CLI 插件）。
本仓库是同一套产品思路的 **Paseo 0.13 插件**。两边宿主能提供的面不一样，所以差异分四类：

- **已有**：功能与语义都对上，落在 Paseo 有的面上。
- **已有 + 换面**：主要能力都在，个别动作因为宿主限制换了出口（例如「注入输入框」改成复制）。
- **换面**：DSH 的承载面在 Paseo 不存在，能力以最近等价物落在别的面上。
- **部分 / 未做**：还有明确缺口；原因写清楚，不假装做到。

## A1–A26 能力盘点（2026-10-27 全量落地后）

> 清单按 DSH 源码重建：文案取自 `src/client/kernel/locale-data.ts`，界面取自
> `src/client/views/`，工具取自 `src/deck/tools/` 与 `src/deck/registration/`。
> 结论按**实际代码与测试**填写；没有实测证据的能力不会写成「已有」。

| # | DSH 版能力 | 本插件 | 结论 | 说明 / 证据 |
|---|---|---|---|---|
| A1 | 任务列表：地图票与普通票同池，地图优先 → 未关闭优先 → 最近更新；行内票号、标题、标签、指派 | 工作区标签页里的任务板，排序口径照搬 | **已有** | `client/deck/BoardView.tsx`、`server/tracker/order.ts` |
| A2 | 列表 KPI：可接 / 阻塞 / 已关闭三个计数 | 三个 KPI 按钮，点一下即筛到对应视图 | **已有** | `BoardView.tsx`；计数口径见 `server/tracker/readiness.ts` |
| A3 | 筛选与排序：全部 / Open / 已关闭 / 阻塞 / 可接 / 已合并，标签、更新、创建、编号、标题 | 六个视图 + 标签筛选 + 四种排序 | **已有** | `BoardView.tsx`、`shared/issues.ts` |
| A4 | 阻塞关系：blockedBy 原生边 + assignee 占用；「被谁阻塞」可点进票面 | `blockedBy` 与认领都进 readiness；阻塞票在详情里逐个可点 | **已有** | `server/tracker/github.ts`（GraphQL `blockedBy`）、`readiness.ts`、`IssueModal.tsx` |
| A5 | 拉取请求：与票同池、独立页签、只读评论、打开 / 已关闭 / 已合并三态 | 独立页签、三态筛选、只读详情 | **已有（仅 GitHub）** | `BoardView.tsx`、`deck_pull_requests_list`；GitLab / 本地后端明确返回 `unsupported-host` |
| A6 | 单票详情：正文 GFM、评论、标签、指派、状态、打开 GitHub | 弹窗详情：Markdown、评论、标签、状态、`openExternalUrl` 打开远端 | **已有** | `client/deck/IssueModal.tsx` |
| A7 | 行级动作：诊断 / 修复 / 研究 / 接手 / 完成、复制链接、复制 prompt | 五种动作提示词 + 复制链接；接手 / 完成是真的写 | **换面** | 动作在 DSH 是注入会话；Paseo 插件改不了输入框（D1），改为复制 |
| A8 | 新建票、`+ bug` 快捷、新建需求（探索 / 实施二选一 + 六段模板） | 新建票（可勾「地图」）+ 探索 / 实施两种需求模板（六节 + `requirement` 标签） | **已有 + 换面** | `client/deck/NewIssueModal.tsx`、`shared/requirement.ts`、`tests/requirement.test.mjs` |
| A9 | 空仓库引导：`git init` + 创建并发布仓库 + 标签补全指引 | 诊断页六步引导：init / remote / repo create / login / 标签 / 目录；只复制，不代跑 | **已有** | `client/deck/SetupGuide.tsx`；仓库可见性交给用户 |
| A10 | 地图详情：五区块、层级与层进度、子票分组（可接 / 认领 / 阻塞 / 关闭）、开始 / 推进按钮 | 五区块 + 子票分组 + 层级（Tarjan 缩环）+ 下一步建议 | **已有 + 换面** | `MapModal.tsx`、`server/tracker/map-route.ts`；开始 / 推进改为复制提示词 |
| A11 | 工作路线：当前会话处理的票 + 跨会话在办表 | 票面维度的路线票（按 `wayfinder:*` 排序），绑定「当前票」 | **换面** | 会话维度拿不到（Paseo 无 `sessionQuery` / 会话事件） |
| A12 | 输入框上方胶囊栏 + 状态栏：可接、故障、需诊断、刷新、处理路径表 | 面板内的可接 / 阻塞 / 已关闭 KPI、错误卡片、刷新、处理路径表 | **换面** | 0.13 无全局状态栏；`addComposerPill` 必须按 `agentId` 注册，注册时拿不到工作区 / 会话列表，无法在 `contribute` 里枚举 |
| A13 | 技能页：27 技能、详情原文、注入对话框、安装 | 技能页：列表、详情、复制原文、按工作区安装到 `.claude/skills` 与 `.agents/skills` | **已有 + 换面** | `client/deck/SkillsView.tsx`；注入换成复制（D1） |
| A14 | 环境检查页：主目录、后端选择、gh、登录态、仓库、技能、初始化，逐项修复指引 | 诊断页：Node / git / gh / 登录态 / 仓库 / 后端 / 技能 / 标签逐项检查，修复命令可复制 | **已有** | `server/env.ts`、`client/deck/DiagnosticsView.tsx`；修复不代跑 |
| A15 | 多后端：GitHub / GitLab / 本地 Markdown，切换前做迁移前置检查 | GitHub 读写；GitLab 只读（glab）；本地 Markdown 读写（`.deck/`） | **部分** | `server/tracker/backend.ts` / `gitlab.ts` / `local.ts`；诊断页会提示「切过去会看不见什么」，但不搬数据、不强制拦截切换 |
| A16 | 标签配色：读、改、复制配色提示词、逐条应用并读回核对 | 标签列表 + 改色 + 读回核对 + 配色提示词复制 | **已有** | `client/deck/LabelsView.tsx`、`server/tracker/labels.ts`、`tests/labels.test.mjs` |
| A17 | 版本管理：状态、文件 diff、提交历史、stage / commit / pull / push、AI 交接 | 状态、diff、stage / unstage / commit / pull / push / fetch、提交历史、AI 交接提示词 | **已有** | `client/deck/VersionView.tsx`、`server/rpc/git.ts` |
| A18 | 仓库初始化向导：探索 / 实施、六步、域文档布局确认 | 诊断页六步引导，含 `docs/`、`.claude/skills`、`.agents/skills` 目录 | **已有** | `SetupGuide.tsx`；不替用户创建远端仓库、不选可见性 |
| A19 | 设置页：后端、语言、调试开关、模板 | 独立设置页：后端、刷新间隔、调试日志、更新检查、语言说明 | **已有** | `client/deck/SettingsView.tsx`、`shared/settings.ts`、`server/settings.ts` |
| A20 | 诊断日志：开关、导出、清空、打开目录 | 开关、刷新、复制导出、清空 | **部分** | `DiagnosticsView.tsx`、`shared/logs.ts`；日志在内存缓冲，宿主没有打开目录 / 写文件的面 |
| A21 | 更新检查与一键安装 | 检查远端 tag、显示当前 / 最新版本、复制安装命令 | **换面** | `server/update.ts`、`SettingsView.tsx`；宿主没有安装插件的调用面，不代跑 |
| A22 | 会话自动命名（规则截取 / 模型摘要） | 无 | **未做** | `agent.create` 钩子看不到首条提示词，`PaseoAgentHandle` 也没有改名方法（只有工作区 `setTitle`，改的不是会话） |
| A23 | 数据新鲜度与配额：上次更新时间、落后提示、GraphQL → REST 回退、额度读数 | 相对时间、窗口说明、额度读数、REST 回退提示、自动刷新 | **已有** | `BoardView.tsx`、`server/tracker/github.ts`、`shared/settings.ts` |
| A24 | 状态横幅：仓库未识别、登录态未就绪、未初始化、环境未就绪 | 面板内错误卡片（按失败原因分类）+ 诊断页逐项检查 | **部分** | `BoardView.tsx`、`DiagnosticsView.tsx`；0.13 没有全局横幅面，只能落在面板内 |
| A25 | Agent 工具：九颗 `deck_*` 追踪器工具 + `deck_probe` + 下一步建议 | 14 个 MCP 工具，读工具预授权、写工具需确认；三种后端按闸门分派 | **已有** | `server/mcp/tools.ts`、`tests/mcp-tools.test.mjs`、`tests/mcp-hooks.test.mjs` |
| A26 | 中英双语 + 像素风卡片 | 中英双语（`defineTranslations`，跟随 App）+ RN 像素风 | **已有** | `client/deck/messages.ts`、`client/deck/pixel.tsx` |

**合计（26 项）**：已有 15（A1–A6、A9、A14、A16–A19、A23、A25、A26）、
已有 + 换面 3（A8、A10、A13）、换面 4（A7、A11、A12、A21）、
部分 3（A15、A20、A24）、未做 1（A22）。

## 仍然存在的差异（都是宿主边界，不是「以后再说」）

1. **A22 会话自动命名**：没有 Agent 改名 API，`agent.create` 也看不到首条提示词。
   能做的只有工作区 `setTitle`，但那改的是工作区名，不是会话名；不改语义硬凑。
2. **A12 输入框胶囊栏 / 全局状态栏**：`addComposerPill` 与 `addHeaderButton` 都要
   `agentId` / `workspaceId`，而插件在 `contribute()` 里拿不到注册时的列表。信息本身
   （KPI、故障、刷新、路线）已经在面板内给全。
3. **A24 全局状态横幅**：同上，0.13 没有全局横幅面；面板错误卡片与诊断页承担了这件事。
4. **A20 打开日志目录**：日志在内存缓冲里，宿主没有文件管理器面；导出以复制文本实现。
5. **A15 迁移**：三种后端都能读写（GitLab 只读），但没有自动搬数据；诊断页只提示
   「切过去会看不见哪些票」，切换本身不拦截。
6. **A7 / A10 / A11 / A13 的「注入会话」**：插件拿不到 Agent 输入框，全部改成复制提示词 / 原文。

## 照搬过来的语义（改了就是 bug）

- 规范标签与颜色：`bug` `needs-triage` `needs-info` `ready-for-agent` `ready-for-human` `wayfinder:grilling` `wayfinder:map` `wayfinder:prototype` `wayfinder:research` `wayfinder:task`。
- 地图正文五个区块：`Destination` / `Notes` / `Decisions so far` / `Not yet specified` / `Out of scope`；`##` 与标题之间没有空格也算标题；粘在上一行末尾的标题会被切开；围栏代码块里的不动。
- 决策行两种写法：`- [标题](链接) — 一句话` 与 `- **标题**：一句话`；加粗写法里 `[#1057](链接)` 只留票号当标题。
- 决策那句话超 240 字就退到最后一个完整词再加省略号。
- 雾与「不做」里的 HTML 注释行不进界面，其余行（含 `- ` 符号）原样保留。
- 路线只收 `wayfinder:research|prototype|grilling|task`，**剔除地图票自己**；开着的排在关掉的前面，同类按票号升序。
- 建议按「先目标、再雾、再研究/讨论/原型/任务」的次序给。
- 阻塞口径：只有**打开**的阻塞者才算阻塞；assignee 占用单独算 `claimed`；关掉的阻塞者不影响可接。
- 地图层级只看路线**内部**的阻塞边，成环时先缩强连通分量再分层。

## 与 DSH 不同的实现选择

- **注入到对话框（A7 / A10 / A11 / A13）**：Paseo 插件拿不到 Agent 的输入框，只能产出文本由用户粘贴。
- **模型生成建议（A25）**：源仓库的建议由模型生成；这里改成纯规则码（理由 + 提示词模板在前端按语言组装），因为插件不该在每次读地图时额外烧一次模型调用。
- **GitLab 只读（A15）**：`glab api` 的读接口稳定，写接口没有做；写路径在 `resolveWritableBackend` 明确拒绝，避免「界面显示成功、远端什么也没发生」。
- **本地 Markdown（A15）**：票在 `.deck/issues/<n>.md`，评论在同名 `.comments.json`，标签目录在 `.deck/labels.json`；用户可以自己编辑、提交、grep。
- **更新检查（A21）**：只查 tag、只给命令，不代跑 `paseo plugin install`。
- **仓库初始化（A9 / A18）**：只复制命令，不替用户 `git init`、建远端或选仓库可见性。
