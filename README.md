# MattSkillsDeck for Paseo

把 [dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) 移植成 Paseo 插件：
31 个中英双语工程技能（Matt Pocock 那套 + 架构图纸 + 项目梳理），加上多后端工作票面、地图与一组给 Agent 用的 `deck_*` 工具。

当前状态：**DSH 版 A1–A26 已逐项落地**（P0–P19 代码侧完成，P19 为八线全量吸收；仓库公开在 GitHub，打了 `v0.1.0` / `v0.1.1`，可用 git 源安装）。
26 项里 13 项完全对齐、7 项已有但换了出口、2 项以最近等价面承载、4 项部分、0 项未做；逐项证据与剩余差异见
[`docs/port-diff.md`](docs/port-diff.md)，阶段记录见 `PROGRESS.md`。按 D6 决定**不提交公开注册表**。

## 能做什么

- **任务板**：列出工作区所指仓库的 issue，按「地图票优先、开着优先」排序；六个视图（全部、Open、可接、阻塞、
  已关闭、已合并）把可接 / 阻塞 / 已关闭的计数直接写在页签上，另有四种排序；显示最近更新时间、额度读数与
  REST 回退提示，按设置自动刷新；**地图的子票折叠挂在父票下面**（左侧 ▾/▸ 与张数，可一键全部收起 /
  展开），父子只按服务端给的归属认，父票被筛掉时子票照旧单独占一行；拉取请求独立页签，打开 / 已关闭 /
  已合并三态，只读。
- **仓库详情**：顶栏说明连的是哪个宿主、哪个仓库，并给出描述、可见性、主语言、Star / Fork、打开的票（含 PR）、
  默认分支、最近推送、许可、创建时间与主题；本地 `.deck` 后端则给出目录与票 / 标签的实际数量。详情单独取数并
  缓存 5 分钟，不跟着列表轮询烧额度。
- **容器目录**：工作区本身不是 git 仓库、但直接子目录里有仓库时，任务板把**这些仓库的票合成一块板**：
  每张票带仓库徽标，筛选条可以只看某一个仓库，新建票可选目标仓库，标签页也先选仓库再读改；打开票面能看到所属仓库与本地代码目录，
  复制给 Agent 的提示词也带上仓库键与代码路径。工作区根的 `.paseo-deck.json` 只记「默认看哪个仓库」
  （只存一个单层目录名，建议加进 `.gitignore`），不再缩小板子的范围；票面、标签、地图与 MCP 工具共用
  同一份仓库解析结果。只扫一层，不递归进 `node_modules` 之类的目录。
- **票面**：正文 Markdown、评论、整体替换标签、接手 / 完成（真实写入）、打开远端、复制链接与五种动作提示词；
  **时间线**把建票、每条评论、关票、会话接手与最近变动并成一列（远端给关票时刻，本地后端没有就不写这一行）；
  新建票可勾「地图」；**缺陷**票按实际 / 期望 / 复现 / 环境四段建，缺项会尝试标 `needs-info`、未诊断标 `needs-triage`；
  新建**需求**可选探索 / 实施两种六节模板，自动带 `requirement` 标签，建完可复制 `/wayfinder` 或 `/grill-with-docs` 提示词。
- **会话与工作路线**：输入框胶囊按 agent、页头按 workspace 显示本地台账里的当前票 / 最近动作，
  读不到时如实标「不可读」；胶囊 / 页头 / 助手面板里的 `SessionSheet` 可以把动作提示词填进当前会话或新建会话的输入框，
  由你检查后自己按发送；新建会话在创建时带规则标题，已有会话不能改名。可导出 AI 交接。
- **地图**：`wayfinder:map` 票会多一个「打开地图」入口，一屏给出目标、已定决策、雾、路线、层级与每层进度、
  子票分组（可接 / 认领 / 阻塞 / 关闭），以及可复制的下一步建议。
  **需求票与地图票之间有一条引用边**：建图时带 `sourceIssue` 就在地图正文写一行 `Derived from: #19`
  （GitHub 没有「衍生自」这种原生关系），票面上地图显示「来自需求」、需求显示「这张需求建出的地图」，
  两边都能点过去；需求侧是反查地图正文，不是另存一份。
- **技能**：31 个技能中英双语随包分发，可看原文、可复制原文，按工作区一键安装到 `.claude/skills` 与 `.agents/skills`；
  安装前先列出要写的文件，不自动写入。
- **Agent 工具**：17 个 MCP 工具（DSH 九颗冻结工具 + 评论、标签、PR、`deck_next_steps`、`deck_probe`、`deck_handoff`、`deck_dispatch_plan`、`suggest_next_steps` 八个扩展）。
  8 个只读工具 + `deck_handoff`（只写自己名下的回传件）预授权，其余写工具每次都要人确认；GitHub / GitLab / 本地 Markdown 三种后端共用同一套工具。
  合板工作区里，读工具可带 `repo`（`owner/name`）只看一个仓库，省略则覆盖全部；写工具在多仓库下必须
  指明 `repo`——票号只在仓库内唯一，插件不会替你猜。
- **编排**：一个工作区一套派单规则，落在 `.deck/orchestration.json`——指定主沟通窗口与派单窗口、层数上限、
  单次最多派几个；**地图并发预算**（一张地图同一时刻最多几个子会话）也在这一份里，派单时按宿主上
  「已经开着几个」硬拦，超了逐条拒绝并说清还剩几个；给每个客户端注入 `env`（只显示掩码）、追加模型、存「provider + 模型 + 模式 + 思考档位」档案，
  改完接入地址或模型后，客户端页的「刷新宿主模型」让宿主立刻重读按工作区缓存的清单（不重启 App，也不动在跑的会话）；
  按 trivial / normal / hard / critical 四档难度指定客户端与模型（没配的档借用 `normal` 的路由，连 normal 也空着才用内置默认目标，
  借用这件事在页面上和 `deck_dispatch_plan` 的 `routeFrom` / `warnings` 里都写出来，不悄悄换成别的档）。
  派单时 `deck_dispatch_plan` 给出该用的客户端、标签与抬头（`depth` 必须自己报，超层直接拒绝，
  标签里的父会话按真实调用者写）；子会话用 `deck_handoff` 写回结果（只写自己名下那份，没有
  `PASEO_AGENT_ID` 就失败），收尾时插件把它回传给创建它的窗口，一层一层往主窗口走；
  上一级那个窗口已经归档发不进去时改送主沟通窗口并在正文里写明绕道，页签里的会话树显示这条链路。
  注入 `env` 时会把该客户端已有的键一起提交——宿主落盘是整块替换，只交新键会把别的键冲掉。
  这套流程（需求票 / 地图票 / 子票怎么分工、每步是谁在动手、闸门与回传链）画成了一张离线图纸：
  [`docs/dispatch-flow.html`](docs/dispatch-flow.html)，六张图 + 每张的 ASCII 版。
- **多项目工作区**：`.paseo-deck.json` 可以写成 v2 项目清单（`version` / `projects[]` / `coordination`），
  每个项目有自己的目录、仓库、角色（后端 / 前端 / 小程序 / 授权 / 运维）与模块清单（area）；
  任务板多出一条项目条，按项目显示开 / 闭 / 可接 / 阻塞，筛选条能按 area 与角色叠着筛；
  跨仓库依赖在正文写固定一行 `Blocked by: 项目键#12`（也认 `owner/repo#12`），读的时候合成一条边，
  对方仓库读不到就标「引用失效」而不是当成已解决；地图页把这类引用单列并给出对方票的状态与外链。
  标签页按清单补齐 `area:*` / `role:*`；诊断页可按项目补齐 `.github/ISSUE_TEMPLATE` 四类模板（只补缺失，绝不覆盖）。
  v1 的 `{"repoDir": "..."}` 照旧能读，插件不替你改写成 v2。细则见 [`docs/multi-project-workspace.md`](docs/multi-project-workspace.md)。
- **其他页**：标签配色（读、改、读回核对、复制配色提示词）、版本管理（状态、diff、提交历史、stage / commit / pull / push、AI 交接、git worktree 多工作树一览）、
  诊断（16 项检查目录 + 六步仓库初始化引导 + 日志开关 / 复制 / 清空；修复动作全部接线，认不出的动作明示「未支持」，不放空按钮）、
  插件设置（后端、刷新间隔、调试日志、更新检查）。
- **双语**：界面跟随 App 语言（中/英），标题与按钮在同一套词表里。

## 后端

设置页的「后端」决定票读写落到哪；`auto` 是默认值：

| 后端 | 读 | 写 | 数据位置 / 依赖 |
|---|---|---|---|
| `auto` | 有 GitHub 远端走 GitHub，有 GitLab 远端走 GitLab，都没有走本地 | 跟随实际后端 | — |
| `github` | 是 | 是 | `gh` 已安装并 `gh auth login` |
| `gitlab` | 是（issue 与评论，系统备注过滤） | 是，写前检查当前账号至少 Reporter；失败区分「没写入」与「可能已写入」 | `glab` 已安装并 `glab auth login` |
| `local` | 是 | 是 | 工作区里的 `.deck/`，也识别 `.scratch/`，无外部依赖 |

本地后端的布局：

```
.deck/
  issues/<n>.md            # frontmatter + 正文
  issues/<n>.comments.json # 评论
  labels.json              # 标签目录与颜色
```

`.deck/` 可以直接用编辑器改、用 git 提交、用 grep 找。如果工作区已经是 `.scratch/` 布局，读路径也认它；
两种布局不会自动互搬。切换后端不会自动搬数据，诊断页会提示「切过去会看不见哪些票」；
GitLab 的写权限由每次操作前的闸门判断，至少需要 Reporter。

## 安装

```bash
# 本地目录（开发用）
paseo plugin install /绝对路径/paseo-matt-skills-deck

# Git（推荐钉 tag）
paseo plugin install git:943545721/matt-skills-deck --ref v0.1.1

paseo plugin reload matt-skills-deck     # 改完代码热更新
paseo plugin ls                          # 应显示 running
paseo plugin logs matt-skills-deck       # 出问题时看这里
```

前提：Paseo `>=0.13.0 <0.15.0`（0.14 的客户端 SDK 与 0.13 逐字节相同、服务端只多出 `defineAgentTool`
 与几个只读字段，所以同一份代码两条线都能跑；0.15 之后没比对过，不放）。GitHub 后端需要 `gh` 并已登录；GitLab 后端需要 `glab` 并已登录，
写操作还要求当前账号在目标项目至少是 Reporter；只用本地后端则不需要任何 CLI。没有登录时，任务板和诊断页会直接给一个「登录 GitHub」按钮：
浏览器流程把 gh 的一次性验证码搬到面板上，连不上 github.com 时改用 Token（只经 stdin 交给 gh，插件不保存）；
不需要自己开终端敲命令。缺什么时面板不装死，会直接说明原因。

插件设置页（Paseo 设置 → 插件 → MattSkillsDeck）可以改后端、刷新间隔、调试日志和像素皮肤
（跟随 Paseo / 深色 / 浅色 / 经典像素），并检查远端有没有更新的 tag。
更新检查只查不装：宿主没有安装插件的调用面，这里给出一条可复制的 `paseo plugin install ...` 命令。

## 开发

```bash
npm install
npm run typecheck    # 客户端与服务端各一份 tsconfig，边界靠类型检查兜住
npm test             # node --test，直接跑 TypeScript（Node 自带类型剥离）
```

改完代码后 `paseo plugin reload matt-skills-deck` 即可；两端 typecheck 与全量 `node --test` 是提交前的门槛。
测试覆盖三种后端的读写分派、地图解析与分层、MCP 工具参数、失败分类、GitHub 登录流程
（验证码解析、token 只走 stdin、401 却退出 0 的坑）、会话发送与台账四态、GitLab 写权限闸门，
以及检查目录的每一条分支。

## 结构

```
paseo-plugin.json    清单：id、要求、媒体
index.client.tsx     注册面：工作区面板、整页界面、侧栏行、设置页、胶囊、页头、助手面板、命令中心、时间线
index.server.ts      注册 RPC 与生命周期钩子
shared/              两端共用的 RPC 契约（Zod）：issues、map、repo、labels、env、logs、settings、requirement、update、auth、session、checks、publish
client/deck/         插件界面：任务板、地图、技能、标签、版本、诊断、设置、初始化引导、像素皮肤
client/deck/board/   任务板的项目条与 area / role 筛选（纯计算单独成文件，node 直接可测）
client/deck/skills/  技能页的项目 × 客户端矩阵
client/deck/surfaces/ 原生座位：胶囊、页头、助手面板、命令中心、斜杠命令、附件源、时间线
client/deck/session/  SessionSheet + prefill：填入当前 / 新建会话输入框、复制兜底
client/deck/panel/    助手面板页签（检查目录等）
server/tracker/      票面领域逻辑：多后端分派、gh / glab / 本地 Markdown 读写、地图正文、路线与建议
server/rpc/          RPC 处理器（一条 RPC 一个文件）
server/workspace/    多项目工作区的落盘动作：issue 模板、标签同步的计划与执行
server/mcp/          给 Agent 的 MCP 服务端（协议层 + 17 个工具，含多项目的 repo 作用域）
server/session.ts    会话创建 / 发送 RPC（兼容保留）、技能可用性核实、台账附注
server/ledger.ts     agent / workspace 两个作用域的本地台账
server/checks.ts     16 项检查目录与六步引导
server/publish.ts    发布计划 / dry-run（不执行 git / gh）
server/hooks.ts      before agent.create：按工作区后端注入 deck 工具
server/env.ts        环境检查的逐项规则
server/update.ts     远端 tag 检查
templates/skills/    随包的 31 个技能（中英双语）
```

分层硬规则：`client/` 不 import `node:*`，`server/` 不 import `client/`，跨边界数据一律过 `shared/` 的 Zod 契约。
两套 tsconfig 就是为了让这三条在编译期就报错。

## 与 DSH 版的差异

完整的逐项对照见 [`docs/port-diff.md`](docs/port-diff.md)。最影响使用体感的几条：

- 面板落在**工作区标签页**，不是常驻右栏；输入框胶囊与页头会按 agent / workspace 动态注册，
  但 0.13 没有全局状态栏，KPI 与故障信息仍在面板内。
- 「一键填入输入框」真的填输入框；能填入的入口（胶囊 / 页头 / 助手面板 / 时间线 / 票面 / 地图 / 技能页）
  都走 `SessionSheet`，写宿主草稿 store 并读回校验后导航到已有会话或新建会话，**不发送消息**；
  目标输入框已有草稿时先提示、确认后才覆盖；写不进去就复制提示词，让你自己粘贴。
  你检查文字后自己按发送，复制提示词作为只读出口保留。
- Agent 工具走**独立 MCP 子进程**；GitHub / GitLab 远端一定注入，本地后端只在工作区已有 `.deck/`
  （或在设置里明确选了 local）时注入，避免每个空目录都多出十几个工具。写工具默认要确认。
- 会话自动命名只做到**创建时规则标题**：`agent.create` 能看到调用方给的 title，但没有改名 API，
  已存在的会话不能重命名，也不做模型摘要。
- GitLab 后端**读写都有**，每次写前检查权限（至少 Reporter）；本地 Markdown 后端也读写，
  默认 `.deck/`，并识别 `.scratch/`。
- 发布有两条路线：检查页向导走 `deck.publish.run` 真建仓推送，`deck.publish.plan` / `confirm` 是只出计划的 dry-run 路线；
  检查页里 `wizard / form / setupRun / ensureLabels / glabAuthLogin` 这些动作还没接线，界面会明说。
- 像素风的基础来自 DSH 原版 `PixelStyles.ts`：直角、等宽粗体、墨底纸字票号、红边故障横幅；
  「经典像素」完整保留原版 3px 框、硬投影、8px 棋盘与棕 / 米色板。
  深色 / 浅色两套改成**细线 + 页签**：卡片和分隔线只画 1px，普通控件不再带投影，
  导航与筛选是「选中项下划线」而不是一排彩色方框，一屏里只有一个主按钮是实心强调色。
  深色按同一套几何做深底浅字（像 IDE 的 dark theme），整块底取 Paseo 深色界面实测的
  `#181b1a`，强调色统一为暖金；浅色是**纯白底 + 浅灰描边 + 单一蓝色强调**，同样不铺棋盘；
  默认跟随 Paseo，面板顶栏有一键深 / 浅快捷键，设置里也可以选「经典像素」。
  原版是 DOM + CSS，Paseo 面板是 React Native，所以 CSS 类名不能 import，颜色与几何则逐项对齐
  （`client/deck/pixelTokens.ts` + `tests/pixel.test.mjs` 逐值钉住）。

## 已知限制

- 本机验证只到「编译 / 单测 / reload / 失败分支」；真实 GitHub / GitLab 读写与 MCP 注入需要在有登录态的环境里跑一遍。
  GitLab 写路径目前只用假 `glab` 验过命令与失败分类，没有在真实 GitLab 项目上留过写入。
- Agent 工具要求 daemon 跑在 Node 22.18+（插件直接用当前 Node 跑 `server/mcp/main.ts`）。版本不满足或入口文件缺失时，
  插件会跳过注入并在 `paseo plugin logs` 里说明，不会挂一个起不来的服务。
- MCP 服务名固定 `matt-skills-deck`（预授权名单按服务名映射），不要在工作区里自建同名服务。
- 像素风外观没有截图验证：这个环境起不了 Paseo 桌面端窗口。
- GitLab 的合并请求（MR）还没接；PR 页签只对 GitHub 后端返回数据。
  发布 RPC 只生成 argv / dry-run，没有执行段，也还没有发布页面。
- 版本页没有 `git worktree list`，多工作树同时开工时只能看当前工作树。
- 更新检查需要本机有 `git` 且能访问 GitHub；失败时如实报错，不会猜一个「已是最新」。
- 插件 API 处于实验期，`requirements.paseo` 钉在 `>=0.13.0 <0.15.0`：0.13 与 0.14 比对过，
  0.14 的**守护进程**（不只是 App）没实跑过，只在 0.13.2 的守护进程上验过。

## 许可

MIT，见 `LICENSE`；第三方来源见 `NOTICE.md`。
