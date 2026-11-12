# 与 DSH 版的逐项对照

源仓库：[FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck)（DSH CLI 插件）。
本仓库是同一套产品思路的 **Paseo 0.13 插件**。两边宿主能提供的面不一样，所以差异分四类：

- **已有**：功能与语义都对上，落在 Paseo 有的面上。
- **已有 + 换面**：主要能力都在，个别动作因为宿主限制换了出口（例如「注入输入框」改成写入宿主的草稿 store）。
- **换面**：DSH 的承载面在 Paseo 不存在，能力以最近等价物落在别的面上。
- **部分 / 未做**：还有明确缺口；原因写清楚，不假装做到。

## A1–A26 能力盘点（2026-10-28 八线吸收后）

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
| A7 | 行级动作：诊断 / 修复 / 研究 / 接手 / 完成、复制链接、复制 prompt | 五种动作提示词 + 复制链接；接手 / 完成是真的写；票面动作打开 `SessionSheet`，把提示词填进工作区里已有会话或新建会话的输入框；复制提示词仍作为只读出口保留 | **已有 + 换面** | `IssueDetailView.tsx`、`client/deck/session/SessionSheet.tsx`、`client/deck/session/prefill.ts`；0.13 公开 SDK 没有输入框 API，写宿主草稿 store（`agent:<serverId>:<agentId>`）并读回校验，失败才复制；不直接发送消息 |
| A8 | 新建票、`+ bug` 快捷、新建需求（探索 / 实施二选一 + 六段模板） | 新建票分三类：普通票（可勾「地图」）、缺陷四字段（实际 / 期望 / 复现 / 环境，缺项尝试标 `needs-info`、未诊断标 `needs-triage`）、探索 / 实施两张需求卡（六节 + `requirement` 标签）；需求卡通过 `SessionSheet` 默认新建会话，把 `/wayfinder` 或 `/grill-with-docs` 提示词填进新会话输入框 | **已有 + 换面** | `client/deck/NewIssueModal.tsx`、`client/deck/Panel.tsx`、`shared/requirement.ts`、`shared/new-issue.ts`、`tests/requirement.test.mjs`、`tests/new-issue.test.mjs`；DSH 直接开新会话，Paseo 由会话面板建空会话并填入输入框，用户自己按发送 |
| A9 | 空仓库引导：`git init` + 创建并发布仓库 + 标签补全指引 | 诊断页六步引导：init / remote / repo create / login / 标签 / 目录；另有发布计划 RPC 生成 argv 与 dry-run | **已有** | `client/deck/SetupGuide.tsx`、`server/publish.ts`；发布计划只出命令和确认令牌，**不执行** `git` / `gh`，也没有发布页面；仓库可见性交给用户 |
| A10 | 地图详情：五区块、层级与层进度、子票分组（可接 / 认领 / 阻塞 / 关闭）、开始 / 推进按钮 | 五区块 + 子票分组 + 层级（Tarjan 缩环）+ 下一步建议 | **已有 + 换面** | `MapModal.tsx`、`server/tracker/map-route.ts`；开始 / 推进打开 `SessionSheet`，默认跟随工作区最近的已有会话（没有会话时新建），提示词填进该会话的输入框 |
| A11 | 工作路线：当前会话处理的票 + 跨会话在办表 | 真的本地台账：按 agent 与 workspace 两个作用域记录「当前票 / 最近动作 / 待办」；胶囊有 agent 上下文时读该 agent，否则读 workspace，页头固定读 workspace；可导出 AI 交接 | **已有 + 换面** | `server/ledger.ts`、`server/session.ts`、`client/deck/surfaces/workRoute.ts`；台账落在 `<PASEO_HOME>/matt-skills-deck/{agents,workspaces}/*.json`，写入来自 MCP 写操作（`SessionSheet` 只填输入框，不再写台账）；读取分 idle / empty / unreadable / ok 四态，损坏文件返回 `recovered/dropped/corruptPath`，不把「读失败」说成「没有在办」 |
| A12 | 输入框上方胶囊栏 + 状态栏：可接、故障、需诊断、刷新、处理路径表 | 真的输入框胶囊：按 `agents.list({subscribe})` 动态给每个 agent 注册；页头按钮按 `workspaces.list` 给每个 workspace 注册；面板内保留 KPI、错误卡片、刷新与路线表 | **已有 + 换面** | `client/deck/surfaces/pills.ts` / `headers.ts` / `workRoute.ts`、`index.client.tsx` 的 `contributeSurfaces`；0.13 仍没有全局状态栏，胶囊属当前 agent，页头属 workspace，两者读同一份台账 |
| A13 | 技能页：27 技能、详情原文、注入对话框、安装 | 技能页：列表、详情原文、复制原文、按工作区安装到 `.claude/skills` 与 `.agents/skills`；详情可打开 `SessionSheet` 把 `/技能名` 填进已有会话或新建会话的输入框 | **已有 + 换面** | `client/deck/SkillsView.tsx`、`client/deck/session/prefill.ts`；0.13 没有公开的输入框 API，靠宿主草稿 store 实现预填并读回校验；非 slash 提供方仍按可用命令降级 |
| A14 | 环境检查页：主目录、后端选择、gh、登录态、仓库、技能、初始化，逐项修复指引 | 16 项检查目录（gate / env / backend 三组）+ 六步引导；全部六种动作类型已接线：`refresh / open-url / rpc(deck.auth.start)` 直发，`form / wizard` 走通用 `CheckActionModal`（DSH fix contract：required/pattern/cwd-basename/预览/提交合并 cwd），`inject-prompt` 五个键全有原文（cliInstall / ghAuthLogin / glabAuthLogin / setupRun v15 / ensureLabels） | **已有** | `shared/checks.ts`、`server/checks.ts`、`client/deck/panel/ChecksTab.tsx` + `CheckActionModal.tsx` + `checksPrompts.ts`；具名向导 `publish`（两步建仓，提交走 `deck.publish.run` 真执行）与 `backend-picker`（写设置后重查）；setupRun 在 gh:remote 未过时先 toast 阻断，通过后先问域文档布局（single/multi）再注入原文；installSkills 提示词只作回退，主路径是面板自带安装器 |
| A15 | 多后端：GitHub / GitLab / 本地 Markdown，切换前做迁移前置检查 | GitHub、GitLab、本地 Markdown 三种后端都可读写；GitLab 写前检查当前账号权限（至少 Reporter）；本地同时识别 `.deck/` 与 `.scratch/` 两种布局 | **已有 + 换面** | `server/tracker/backend.ts` / `gitlab.ts` / `local.ts` / `write.ts`；写失败区分「没写进去」与「可能写进去了」；诊断页提示切过去会看不见什么，但不自动搬数据、不强制拦截切换；`.scratch` 需要显式初始化，避免把两种布局混着写 |
| A16 | 标签配色：读、改、复制配色提示词、逐条应用并读回核对 | 标签列表 + 改色 + 读回核对 + 配色提示词复制 | **已有** | `client/deck/LabelsView.tsx`、`server/tracker/labels.ts`、`tests/labels.test.mjs` |
| A17 | 版本管理：状态、文件 diff、提交历史、stage / commit / pull / push、AI 交接 | 状态、diff、stage / unstage / commit / pull / push / fetch、提交历史、AI 交接提示词、`git worktree list` 多工作树一览（当前树标注、locked/prunable/bare/detached 徽标、最短唯一后缀显示名） | **已有** | `client/deck/VersionView.tsx`、`server/rpc/git.ts`、`server/git/worktrees.ts`；解析逐字照搬 DSH（-z 与换行双形态），当前树判定用 `rev-parse --show-toplevel` + realpath 比较（macOS /var 软链），裸仓库退回分支名 → HEAD oid；适配点只有一处：`runGit` 非零退出把 stderr 并进 stdout，失败详情取第一行 |
| A18 | 仓库初始化向导：探索 / 实施、六步、域文档布局确认 | 诊断页六步引导，含 `docs/`、`.claude/skills`、`.agents/skills` 目录 | **已有** | `SetupGuide.tsx`；不替用户创建远端仓库、不选可见性 |
| A19 | 设置页：后端、语言、调试开关、模板 | 独立设置页：后端、刷新间隔、调试日志、更新检查、语言说明 | **已有** | `client/deck/SettingsView.tsx`、`shared/settings.ts`、`server/settings.ts` |
| A20 | 诊断日志：开关、导出、清空、打开目录 | 开关、刷新、复制导出、清空 | **部分** | `DiagnosticsView.tsx`、`shared/logs.ts`；日志在内存缓冲，宿主没有打开目录 / 写文件的面 |
| A21 | 更新检查与一键安装 | 检查远端 tag、显示当前 / 最新版本、复制安装命令 | **换面** | `server/update.ts`、`SettingsView.tsx`；宿主没有安装插件的调用面，不代跑 |
| A22 | 会话自动命名（规则截取 / 模型摘要） | 新建会话时按动作与票号规则生成标题（不超 60 字符），随 `agents.create` 一起提交；已存在的会话不能改名 | **部分** | `shared/session.ts` 的 `sessionTitle` / `truncateTitle`、`server/session.ts` 的 `createAgent`；`PaseoAgentHandle` 没有改名方法，宿主只在创建时收 `title`；不做模型摘要 |
| A23 | 数据新鲜度与配额：上次更新时间、落后提示、GraphQL → REST 回退、额度读数 | 相对时间、窗口说明、额度读数、REST 回退提示、自动刷新 | **已有** | `BoardView.tsx`、`server/tracker/github.ts`、`shared/settings.ts` |
| A24 | 状态横幅：仓库未识别、登录态未就绪、未初始化、环境未就绪 | 胶囊显示当前会话状态与路线；页头显示工作区 KPI、板子读取失败与路线；登录态 / 未初始化 / 环境未就绪在面板错误卡片与诊断页；未登录时可直接打开登录弹窗 | **换面** | `client/deck/surfaces/pill.tsx` / `header.tsx` / `WorkRouteRows.tsx`、`BoardView.tsx`、`DiagnosticsView.tsx`、`GithubAuthModal.tsx`；0.13 没有全局横幅面，状态按最近的座位分散显示 |
| A25 | Agent 工具：九颗 `deck_*` 追踪器工具 + `deck_probe` + 下一步建议 | 15 个 MCP 工具：DSH 九颗冻结名 + 6 个扩展（评论、标签、PR 列表、`deck_next_steps`、`deck_probe`、`suggest_next_steps`）；8 个只读工具预授权，写工具需确认；三种后端按闸门分派 | **已有** | `shared/tool-contract.ts`、`server/mcp/tools.ts`、`tests/mcp-tools.test.mjs`、`tests/mcp-hooks.test.mjs`；旧名 `deck_issues_list` / `deck_map` 仍可调用 |
| A26 | 中英双语 + 像素风卡片 | 中英双语（`defineTranslations`，跟随 App）+ RN 像素风；等宽粗体 / 直角 / 墨底票号来自原版 `PixelStyles.ts`，但深色与浅色把边框压到 1px、去掉普通控件投影、导航改成下划线页签（一屏只留一个实心主按钮），「经典像素」才保留原版 3px 框与硬投影；深色是真正的深底浅字，整块底用 Paseo `#181b1a` 纯色、不铺棋盘，强调色统一为暖金；浅色是纯白底 + 浅灰描边 + 单一蓝色强调，同样不铺棋盘；另有「经典像素」保留原版 8px 棕色棋盘；面板顶栏可一键深 / 浅切换 | **已有** | `client/deck/messages.ts`、`client/deck/pixel.tsx`、`pixelTokens.ts`、`Panel.tsx`、`SettingsView.tsx`；`tests/pixel.test.mjs` 对三套色板、深 / 浅纯底、经典棋盘 PNG 像素、深底 / 浅底方向与显式覆盖做逐值校验。原版的 CSS 动画 / hover / 焦点环在 RN 里没有对应实现，按压态用位移近似 |

**合计（26 项）**：已有 15（A1–A6、A9、A14、A16–A19、A23、A25、A26）、
已有 + 换面 7（A7、A8、A10、A11、A12、A13、A15）、换面 2（A21、A24）、
部分 2（A20、A22）、未做 0。

## 仍然存在的差异（宿主边界与明确未接项）

1. **A22 会话自动命名**：新建会话只能在 `agents.create` 时带标题（当前按动作与票号规则截取），
   已存在的会话没有改名 API；不做模型摘要，也不改工作区名硬凑。
2. **A12 全局状态栏**：`addComposerPill` / `addHeaderButton` 已经按 agent / workspace 动态注册，
   但 0.13 没有全局状态栏；胶囊属当前 agent，页头属 workspace，信息不汇总成一个总条。
3. **A24 全局状态横幅**：同上，0.13 没有全局横幅面；胶囊负责会话与路线，页头负责 KPI 与板子失败，
   登录态 / 初始化 / 环境则落在面板错误卡片和诊断页，不汇总成一条总横幅。
4. **A20 打开日志目录**：日志在内存缓冲里，宿主没有文件管理器面；导出以复制文本实现。
5. **A15 迁移**：三种后端都能读写，但没有自动搬数据；诊断页只提示「切过去会看不见哪些票」，
   切换本身不拦截；`.scratch` 布局需要显式初始化。
6. **A10 / A13 与票面行内动作的「注入会话」**：地图动作、票面动作和技能详情都已接入
   `SessionSheet`。工作区里已有的聊天窗口可以选，提示词会填进它的输入框，由用户检查后自己按发送；
   新建需求仍默认落在新会话，避免混进正在进行的聊天；这个工作区已有聊天时，
   面板会提示可以切到「已有会话」填进现有输入框。写宿主 Web bundle 的草稿 store
   （模块 3598，0.13.x 已验证）并读回文本；serverId 必须取宿主界面 props 的 `host.id`
   （公开的 `PluginClientContext` 没有这个字段，按 client 猜只会得到空串）。
   新建会话用 `workspaces.ref(workspaceId).agents.create` 绑定当前工作区——裸
   `agents.create({cwd})` 会按目录重新解析工作区，同目录有多个工作区时新会话会落到另一个。
   目标输入框已有草稿时先提示，确认后才覆盖。创建快照只认 `snapshot.agent.id`：
   `accepted` 阶段的 `agentId` 是宿主预留的，agent 阶段失败时它仍在但没有 `agent`，
   拿它当已创建会写进不存在的会话；`outcomeUnknown` 时提示先核对，不继续预填。宿主不提供
   可定位目标的 DOM 标记，所以不做 DOM 猜测，写不进去就复制提示词，不会把「没填进去」报成成功。
7. ~~A14 的部分修复动作未接线~~ **已补齐**：六种动作类型全部接线，`inject-prompt` 的
   五个键（cliInstall / ghAuthLogin / glabAuthLogin / setupRun / ensureLabels）注入
   DSH 原文；`form / wizard` 走通用弹窗；认不出的动作仍明示「未支持」，不做假按钮。
8. **发布执行**：`deck.publish.run` 会真建仓（git init / add / commit + `gh repo create`
   + push）——只有检查页发布向导点「创建并发布」才会走到；`deck.publish.plan` /
   `deck.publish.confirm` 仍是只出计划的 dry-run 路线，确认令牌只供调用方复验。
9. ~~A17 多 worktree~~ **已补齐**：版本页有 `git worktree list` 一览（当前树标注、
   状态徽标、最短唯一后缀名），新建 / 删除仍在终端操作。

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

- **注入到对话框（A7 / A10 / A13）**：0.13 公开 SDK 没有 composer / draft API，但插件 bundle 与
  宿主 Web UI 在同一个 JS 世界里执行。`SessionSheet` 写宿主草稿 store 的
  `agent:<serverId>:<agentId>` 记录（已挂载输入框立即更新，未挂载的开会话时水合），
  写完读回文本，再导航到目标会话。草稿 store 不可用时直接复制提示词——宿主没有能定位
  目标会话的稳定 DOM 标记，按可见输入框猜会把文字填进别的聊天窗口。
  整个路径不发送消息，最后一步由用户按发送。模块编号与 store 方法都不是公开协议，宿主升级会显式失败并退回复制。
- **工作路线（A11）**：不依赖宿主的会话查询，改由插件在 MCP 写操作时记台账；
  作用域分 agent 与 workspace，读失败 / 文件损坏都显式暴露，不伪装成「没有在办」。
- **模型生成建议（A25）**：源仓库的建议由模型生成；这里改成纯规则码（理由 + 提示词模板在前端按语言组装），因为插件不该在每次读地图时额外烧一次模型调用。
- **GitLab 读写（A15）**：读走 `glab api`；写前用 `checkGitLabWritable` 检查当前账号至少 Reporter，
  写失败区分「没写进去」与「可能写进去了」；标签改色写后读回核对，不只看命令退出码。
- **本地 Markdown（A15）**：两种布局都读：`.deck/issues/<n>.md`（评论同名 `.comments.json`，标签 `.deck/labels.json`）
  与 `.scratch/<unit>/spec.md` / `map.md` / `issues/NN-slug.md`；写回各自原布局，旧根 `issues/` 与
  `.scratch/issues/` 只读，不自动迁移。用户可以自己编辑、提交、grep。
- **更新检查（A21）**：只查 tag、只给命令，不代跑 `paseo plugin install`。
- **仓库初始化与发布（A9 / A18）**：只复制命令；发布计划只生成 argv / dry-run，
  不替用户 `git init`、建远端或选仓库可见性，也不执行 `git` / `gh`。
- **编排与向上回传（超出 A 清单）**：DSH 版没有「派单窗口 / 难度路由 / 子会话回传」这套东西，
  这里按宿主能力新造：一个工作区一份 `.deck/orchestration.json` 记角色、难度路由与派单上限；
  客户端注入与档案仍写在宿主配置（`paseo.config`），插件只做读写与掩码展示。  客户端注入与档案仍写在宿主配置（`paseo.config`），插件只做读写与掩码展示。
  「多地址」不另起炉灶：宿主本来就支持在 `agents.providers` 里用 `extends` 派生一个独立客户端
  （非内置 id + `extends: "<内置id>"`，daemon 的 `addDerivedProviders` 会把它解析成正规 provider），
  插件只负责建这条记录、写它的地址与密钥、再问接口要模型清单；撞 id 一律拒而不合并。
  写这两样各有一道「不毁数据」的规矩：注入 env 每次带上已有的全部键（宿主落盘时 `env` 是整块替换，
  只交新键会把别的键冲掉），档案整表写回前把不认识的字段（`icon` / `color` / `featureValues`）原样带上，
  写后读回条数变少就报错而不是返回成功。
  难度路由**会兜底**（精确档 → `normal` → 内置默认目标），但兜底一律标成 `routeFrom` 并写进
  `deck_dispatch_plan` 的 `warnings`，不把 `critical` 悄悄降成 `normal` 的模型而不说。
  「按票面标签推难度」只做识别（`difficulty:hard` / `difficulty=hard` / `difficulty/hard` 等写法），
  **没有代码会自动往票上写难度标签**——难度由派单人给，或由人手动打标签。
  回传链路由插件的 `agent.turn_ended` 钩子承担（`steer` 发送，不打断父会话当前回合），
  子会话优先用自己的 `deck_handoff` 回传件，没有才退回读时间线尾部；回传件只能写自己名下的那份
  （agent id 只取 `PASEO_AGENT_ID`），上一回合留下的旧件不会被当成新结论重放；缺 `status` / `createdAt`
  的回传件直接判为不可用，宁可退回读时间线，也不拿半份文件上报。
  `deck_dispatch_plan` 的 `depth` 必填、超层直接拒绝，标签里的父会话以实际调用者为准。
  派单失败分得开：「没绑过角色」（`unknown-workspace`）、「绑了但没选派单窗口」（`no-dispatcher`）、
  「编排文件读不出来」（`settings-unreadable`，权限 / IO，不是「没配过」）各报各的。
  客户端装没装：宿主 provider 快照的 `status` 直接给（`unavailable` = 这台机器没有这个命令），
  插件只翻译不自己 `which`；「为什么不可用」走宿主的 provider 诊断原文；「装」只对核过 npm 包名的四家给按钮，
  执行 `npm install -g`、不经 shell、同一时间一个、界面上要点两次确认。
  模型清单不必手敲：模型区块有「从接口获取模型」，用配置里已有的 base url + 凭据发一次
  `GET {base}/v1/models`，凭据只进请求头、不回客户端也不进日志，失败按
  缺地址 / 缺凭据 / 鉴权被拒 / HTTP / 网络 / 回包解析不出 分开说。接口提供上下文窗口
  与推理档位时，加入模型会一并保存到 provider 模型定义，宿主可用于能力识别；接口没提供的字段不猜。
  但宿主的 Codex 适配器只留 id / 标签 / 思考档位（`buildCodexModelDefinition`），窗口到不了会话：
  代理模型名不在 Codex 自己的模型目录里，会话就退回内置默认窗口（272000 的 95%，也就是会话里那行 258k），
  自动压缩阈值跟着放大，先撞的是接口那侧更小的上限，报出来的却是「ran out of room」。
  所以保存 Codex 模型清单（以及启用站点）时，插件会把「本机 `codex debug models --bundled` 拿到的内置目录」
  与「接口报的窗口」合成一份目录文件 `<CODEX_HOME>/deck-model-catalog.json`，再把
  `-c model_catalog_json="…"` 接进派生条目 `deck-codex` 的启动命令（宿主的 `command` 是「替换启动命令」入口；
  它给 Codex 的 `options` 是 strict 校验的，塞 `model_catalog_json` 进去会直接抛错、会话建不起来）。
  用户原有的可执行文件与参数保留，重复保存只替换这一项。
  本机实测：同一会话加这份目录前报 `model_context_window=258400`，加上之后按接口的 128000 报 `121600`。
  接口没报窗口时插件不写这份文件（编一个出来等于把「不知道」换成「知道」）；写不进去只告警，
  不拦模型清单保存，也不把启动命令指过去。保存后还会读回核对 `command` 里确实带着这个路径，
  没带上就警告「这批模型的窗口对会话仍然无效」，而不是报保存成功。**自动压缩本身仍由 Codex app-server 按其上下文用量管理**，插件只把窗口喂对，
  不伪造任何压缩参数。本机实测
  `http://192.168.88.12:8083/v1/models` 回 14 个模型，与配置里那 13 个已有漂移（多两个、少一个）。
  模型只列**我们这条接口提供的那些**（配置里声明的，本机 claude 13 条、codex 7 条）：
  客户端自带的型号（`claude-opus-*` / `sonnet` / `haiku`…，本机另有 18 条）不进清单——
  它们是客户端厂商的目录，跟接的这条链路无关。宿主快照里的 `models` 仍然要读，用来判断
  「这个值是不是模型名」（决定 env 里哪些键明文显示），也用来确认写进去的模型宿主真的认了。
  写回要看清这个客户端用的是哪把键——`models` 是替换内置列表、`additionalModels` 是追加在内置之上，
  写错等于没生效或把内置列表清空；所以按现存配置选键，且入参是**完整清单**（替换语义）而不是「追加一条」。
  模型类的环境变量（`ANTHROPIC_*_MODEL`）在界面上明文显示：模型名不是机密，掩成 `••••lash` 只有噪音；
  凭据与 URL 仍只给掩码，明文要逐键点「显示」单独取。
  编排页的画法：一页一个职责，角色页是「两行字段 + 只为那一行服务的会话选择器」，
  路由/客户端/档案的每一行都是「标题行 + 一行独立的事实」，借用路由用次要色提示而不是红色报错——
  红只留给「这档根本发不出去」。用户配置里的值只以掩码出现，明文不回传客户端。
- **容器工作区合板（超出 A 清单）**：工作区本身不是仓库时，直接子目录下所有 GitHub / GitLab 仓库的票
  合成一块板；每张票带 `repoKey` 与本地代码目录，筛选条按仓库收敛，新建票选目标仓库。
  `.paseo-deck.json` 只决定默认筛选，不再限制板子范围；多仓库下读详情 / 写操作必须带 `repoKey`，
  缺省直接拒绝，不按票号猜——两个仓库都有 `#12` 是常态。
