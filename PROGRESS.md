# 移植进度账本

源仓库：`/www/wwwroot/game.kxhyapp.com/mattpocock-skills`（DSH 版，分支 `dev`）
计划：`mattpocock-skills/.claude/plans/20261026-paseo-port.md`
目标 daemon：本机，Paseo 0.13.0

| 阶段 | 内容 | 状态 | 验收证据 |
|---|---|---|---|
| P0 | 骨架：manifest、双 tsconfig、工作区面板 + 整页界面 + 侧栏行、`deck.status` RPC | **完成** | `paseo plugin ls` = running；`paseo plugin logs` 无错误；两端 typecheck 通过 |
| P1 | 技能包：27×2 技能入库、技能页、按工作区安装按钮 | **完成** | 27/27 中英齐；安装写入 `.claude/skills` 与 `.agents/skills`；重复安装跳过、内容不同判冲突不覆盖；8 条测试全绿 |
| P2 | 只读任务板：`tracker` 领域逻辑迁移、GitHub 后端、列表 + 详情 | **完成（只读部分）** | 远端解析 6 种写法、映射容错、排序不变性共 6 条测试全绿；插件 reload 后 running；`gh` 缺失路径实测给出可执行提示；本机无 gh 与 GitHub 凭据，联网读取未实测（见下） |
| P3 | 写入与动作：评论、标签配色、绑定与切换、复制提示词 | **完成** | 21 条测试全绿（含 3 条配色归一/拒绝用例）；插件 reload 后 running；写命令未联网实测（本机无 gh） |
| P4 | 周边页：版本管理、环境检查、诊断日志、设置、双语 | **完成**：版本管理 10 条 RPC + 页面、诊断页（环境读数 + 操作日志）、日志缓冲、zh/en 双语全量切换（走 SDK `defineTranslations` + `useTranslation`，语言跟随 App；键/占位符一致性由 3 条测试兜底） | 31 条测试全绿；两端 typecheck 通过；插件 reload 后 running 且日志无错；版本管理在临时仓库实测：暂存→预检→提交成功、同票重放被拒、提交后工作区干净；无暂存/无远端/非法路径三条拦截均给出人话；`en` 表被标成 `Record<MessageKey, string>`，少一条键编译不过 |
| P5 | 地图详情、工作路线、deck 工具 MCP 注入、像素风 | **完成**：地图页（五区块 + 工作路线 + 下一步建议，`deck.map` 一条 RPC 一次读完）；7 个 `deck_*` MCP 工具 + 协议层 + `before agent.create` 自动挂载；像素风牌面（直角 + 2px 描边 + 右下 3px 硬投影 + 等宽数字）铺满任务板 / 地图 / 票详情 / 标签栏，其余表单页用同款直角与描边的扁平变体 | 54 条测试全绿（新增 9 条地图、8 条 MCP 协议/注入用例）；地图正文解析照抄源仓库口径，含「标题粘行」「加粗决策」「字面 \\n 还原」；stdio 冒烟实测：`initialize` 回显 2025-06-18、`tools/list` 出 7 个工具、`tools/call` 走通失败分支、缺 `--workspace`/目录不存在均以退出码 2 报人话；两端 typecheck 通过，reload 后 running、日志无错 |
| P6 | 移动端适配、注册表发布、文档收口 | **完成（代码侧）**：触屏端按钮抬到 40pt、触屏判定走 `Platform.OS`（弹窗拿不到 layout）；三处注册标题改用 `deckMessages.message`，英文界面不会再出现中文标题；README / OVERVIEW 双语重写；新增 `docs/port-diff.md`（与 DSH 逐项对照）与 `docs/publishing.md`（注册表条款，逐条来自 CLI 与 protocol 源码） | `docs/` 已进 `package.json` 的 `files`；typecheck 与 54 条测试全绿（复审后增至 64 条，见下一行）；reload 后 running、日志无错。**仍需人到场**：仓库还没有公开远端、注册表 `media` 为空（此环境截不了 UI 图）、注册表提交入口在受限网络下未能核实 |
| P5–P6 复审 | `code-reviewer` 复审 MCP 链路后按结论修的 9 处：入口判定在含空格/非 ASCII 的安装路径下会静默不启动（`file://` 拼字符串 vs 百分号编码）；`process.exit()` 砍掉大于 64KB 的回包尾巴（改为等写入回调 + `process.exitCode`）；状态过滤发生在 100 条混合状态窗口之后，导致 open 视图少票；标签/评论被静默截断却仍允许「整体替换」；工具入参多余键被静默丢弃；通知被回包、非法 id 冒充 null；注入前不检查 Node 版本与入口文件；写评论超时后回落 CLI 造成重复评论 | 64 条测试全绿（新增 10 条：入口含空格/中文路径、慢读端下 128KB 回包完整、`--workspace` 三种非法入参、严格入参、通知与非法 id、注入前置检查、写回落的两条分支）；两端 typecheck 通过；reload 后 running 且日志无错。截断与入口判定两条都先复现后修复：把旧写法临时贴回去，用例 3 只收到 65536 字节且 JSON 不合法。复审第二轮又修三处：入口守卫漏了符号链接安装路径（改为两侧 `realpathSync` 比较，`~/.paseo` 软链到别的盘就会踩）；`HTTP 5xx/408` 不能当「确定被拒」（网关没回话时评论可能已写入）；标签守卫下沉到 `server/tracker/label-guard.ts`，MCP 出口与 RPC 出口共用同一条不变量（`labels-truncated` 已进 shared 的失败枚举）。复审第三轮只剩两条 LOW 建议，取其一落地：入口判定失败时同时置 `process.exitCode = 1`（原来只写 stderr、退出码 0，客户端分不清「异常退出」与「安静消失」），并补一条「被包了一层」的包装进程用例钉住退出码——去掉那行改动用例即红。当前 71 条用例 |

| P7 | 发布准备：远端、版本与包元数据、图标、CI、注册表提交包 | **完成（代码侧）**：仓库推到 `github.com/943545721/matt-skills-deck` 并打了 `v0.1.0` / `v0.1.1`（已转公开，匿名克隆与 raw 均 200）；`package.json` 补 `repository`/`homepage`/`bugs`/`keywords`/`engines`，`files` 带上 `assets/`；新增 512×512 像素风图标 `assets/icon.png`（清单 `icon` 引用，`media` 仍为空）；新增 `.github/workflows/ci.yml`（Node 22 上 `npm ci` + 两套 typecheck + 全部用例）；README 安装命令换成真实地址。注册表流程已核实：公开注册表是 `getpaseo/plugins`，作者开 submission issue、机器人转 review PR；提交包与已校验的记录写在 `docs/registry-submission.md` | 从 `v0.1.0` 干净 clone 后 typecheck 无输出、71 条用例全绿；本机 typecheck/测试/reload 均过；远端 `main` 与 tag 均已推送；注册表记录过离线校验（`node scripts/validate.ts`：390 条 well-formed）。**仓库已转公开**（匿名访问清单/tag/图标均 200）；注册表在线校验通过（`validate.ts --online --changed`：1 record matches its pinned artifact）；用 API 建的 submission issue #1253 因拿不到 `submission` 标签（表单模板才会打、非协作者加标签 403）没触发 review，已关闭。**已按 D6 决定不再上架**：网页表单与 `media` 截图都不再需要；npm 仍保持 `private` |
| P7 后续 | 加载期校验修复：插件在设置里一直显示「失败」，实测是客户端 bundle 加载期的两道校验，一道比一道晚暴露。① `Invalid translation key: prototype`——SDK 的 `flatten` 在**任意层级**拒绝 `prototype` / `constructor` / `__proto__` 和含点号的键，`map.kind.prototype` 改名 `prototypeKind`（en/zh 各一处，`MapModal` 查表同步）。② `Invalid workspace panel id: deck.board`——面的 id 走 `^[a-z][a-z0-9-]*$`，不许点号（与 RPC 方法名不是一套规则），三个面改为 `deck-board` / `deck-home` / `deck` 并抽到 `client/deck/ids.ts`。测试盲区一并补上：`tests/messages.test.mjs` 不再复刻 SDK 规则（漏的正是保留键那条），改为直接调 `defineTranslations` 真身；新增 `tests/ids.test.mjs` 钉住 id 正则 | 两套 `tsc --noEmit` 无输出；`node --test` 74/74；客户端 bundle 重新编译后三个面均注册成功；`paseo plugin reload` 后进程重启、日志干净，用户在设置里确认显示「运行中」。另用 SDK 真身做反向探针：旧键 `prototype` 与含点号键均抛 `Invalid translation key`，新键通过 |
| P7 后续（续） | gh 失败分类与顶栏显示：装了 gh 但没登录时，标题写「GitHub 拒绝了这次操作」、顶栏写「未关联仓库」。新增 `server/tracker/gh-error.ts` 统一分类（退出码 4，或 stderr 点名 `gh auth login` / `not logged into any GitHub hosts` → `gh-unauth`），读/写/标签/地图四条链路共用；`shared/{issues,labels,map}` 的失败枚举随之扩展，`issues.list` / `issues.detail` 失败时也回传已解析的仓库坐标，`BoardView` 据此显示 `owner/name`。`code-reviewer` 复审发现并修掉两处：① 提示词曾匹配 `error.message`，其中拼着完整 argv（含用户写的评论正文），超时 + 正文含「gh auth login」会被误判成没登录，绕过「评论可能已写入」的保护 → 改为只匹配真 stderr，且 stderr 为空时不回显命令行；② 泛化的 `authentication required` 会把企业代理 407 说成没登录 → 收窄为 gh 的两句原话 | 两套 typecheck 干净；84 条用例全绿（新增 10 条：分类器各分支、超时不污染、代理 407、RPC 失败带 repo、没登录不回落 CLI）；本机真实 gh 走 `listIssuesHandler` 得 `gh-unauth` + `943545721/matt-skills-deck`；reload 后 running、日志无错。审查复验结论 **APPROVE**；残留三条非阻塞项见「验证缺口」 |
| P7 后续（差距盘点） | 与 DSH 原版逐项对账：计划引用的 A1–A26 清单在计划文件中并不存在，按 DSH 源码（`kernel/locale-data.ts`、`views/`、`deck/tools/`）重建为 26 项，逐项标注「已有 / 换面 / 部分 / 未做 + 原因」，写入 `docs/port-diff.md`，附缺口优先级与阻塞口径。结论：已有 4、换面 2、部分 9、未做 11。此前 P6 的「完成（代码侧）」只覆盖已交付子集，**不等于能力对齐**；最显眼的缺口是拉取请求（A5）与可接/阻塞/筛选（A2–A4），两者都不需要新的宿主能力 | 每项「未做」都能在 DSH 源码里找到对应文件与文案，且在本仓库无实现；`docs/port-diff.md` 的 A1–A26 表现为本项目唯一对齐口径。本轮未改代码（只改文档），84 条用例与两套 typecheck 不受影响 |

| P8 | 数据层与任务板：拉取请求、阻塞与认领、KPI、筛选排序、新鲜度 | **完成**：GraphQL 同时取 `issues` 与 `pullRequests`（共用编号空间、`isPullRequest` 区分）；`blockedBy` 与 assignee 进 readiness；可接 / 阻塞 / 已关闭 KPI + 六个视图 + 四种排序；`fetchedAt`、`rateLimit`、GraphQL → REST 回退提示、自动刷新（设置 0–300 秒） | `tests/mcp-tools.test.mjs` 的 PR 三态筛选、`tests/issues.test.mjs` 的阻塞口径；两套 typecheck 干净；147 条用例全绿 |
| P9 | 票面动作与当前票 | **完成**：打开远端（`openExternalUrl`）、复制链接、五种动作提示词、接手 / 完成真实写入；绑定「当前票」，任务板标出当前票 | `client/deck/IssueModal.tsx`、`BoardView.tsx`；写路径在 `tests/gh-write.test.mjs` 覆盖（参数、失败分类、超时保护） |
| P10 | 页面深度：地图层级、环境检查、配色提示词、提交历史与 AI 交接、日志、MCP 工具 | **完成**：地图子票分组 + 路线分层（Tarjan 缩环）+ 每层进度；环境检查逐项给修复命令；标签配色提示词；`git log` 提交历史与交接提示词；日志开关 / 刷新 / 复制导出 / 清空；MCP 工具扩到 14 个 | `tests/env.test.mjs` 10 条、`tests/map.test.mjs`、`tests/labels.test.mjs`、`tests/mcp-tools.test.mjs` 12 条；本机 `node --test` 147/147 |
| P11 | 设置与更新 | **完成**：独立设置页（后端、刷新间隔、调试日志、更新检查、语言说明），保存带 revision，两个客户端同时改不会静默覆盖；更新检查读远端 tag、显示当前 / 最新、给出可复制安装命令 | `client/deck/SettingsView.tsx`、`server/update.ts`、`tests/update.test.mjs` 5 条；A22 当时不做（P19 改为创建时规则标题，见 D4） |
| P12 | 工作流与多后端 | **完成**：新建需求的探索 / 实施六段模板 + `requirement` 标签；诊断页六步仓库初始化引导（只复制不代跑）；本地 Markdown 后端（`.deck/` 读写）；GitLab 只读后端（`glab`；P19 已升级为读写）；写路径闸门；后端切换前置提示 | `tests/requirement.test.mjs` 4 条、`tests/local.test.mjs` 13 条、`tests/gitlab.test.mjs` 6 条、`tests/mcp-tools.test.mjs` 本地读写 2 条；`docs/port-diff.md` 已改为 A1–A26 逐项结论（已有 15 / 已有+换面 3 / 换面 4 / 部分 3 / 未做 1） |
| 全量验收 | 26 项落地后的整体复核 | **完成（代码侧）**：两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **147/147**；MCP 工具 14 个，读工具预授权、写工具不预授权；GitLab 写与 PR 在非 GitHub 后端明确拒绝；本地后端写路径不调用 `gh` | 真实 GitHub / GitLab 联网读写与客户端 bundle 外观仍需在有登录态的环境人工确认（见「验证缺口」） |
| P13 | 界面改回原作者的像素设计：不再用宿主 theme 色自配一套 | **完成（代码侧）**：原版是 DOM + CSS，组件不能直接 import；改为逐项搬设计值。新增 `client/deck/pixelTokens.ts`（深色 / 浅色两套 `--pixel-*` 色板 + 8px 棋盘 PNG + 深浅判断），`pixel.tsx` 按原版几何重写（卡片 / 正文 3px、弹窗 4px、卡片投影 3px、按钮投影 2px、等宽粗体、hot 按钮、票号、横幅、状态行），并铺满面板 / 首页 / 任务板 / 地图 / 票详情 / 新建 / 技能 / 标签 / 版本 / 诊断 / 初始化引导；原先散落的宿主色按钮全部换成同一个 `PixelButton`；弹窗正文统一纸面。设置页保留宿主控件，只把命令块改成墨块 | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **150/150**（新增 3 条：两套色板逐值对原版、深浅判定、棋盘 PNG 实际像素与 CSS 渐变同角同格）；`paseo plugin reload` 后 `plugin ls` = running、日志无错；另用宿主自己的 `compilePlugin`（`@getpaseo/server`）编译客户端 bundle 通过，215357 字节，棋盘 data URI 与两套纸面色板都在产物里。外观仍需人在 Paseo 里看一眼（见「验证缺口」） |
| P14 | 视觉减噪 + 仓库详情：① 取消「每个控件都是一圈 3px 边框 + 硬投影」的画法——卡片与分隔改用 1px `line` 细线，输入框 / 弹窗保留 2px `frame`，只有 `solid` 按钮带硬投影；页签改成平铺 + accent 下划线，强调色每个主题只有一个（深色暖金 / 浅色蓝），原「可接 / 阻塞 / 已关闭」KPI 行去掉，计数并进视图页签；`PixelButton` 新增 `outline / solid / ghost / tab` 四种变体。② 新增只读 RPC `deck.repo.info`：GitHub 走 `gh api repos/{owner}/{name}`、GitLab 走 `glab api projects/{path}`、本地后端读 `.deck/` 计数，三种后端映射成同一份 `RepoDetail`（描述、可见性、主语言、Star / Fork、打开的票（含 PR）、默认分支、最近推送、许可、创建时间、主题、本地目录与计数）；任务板顶栏按「宿主标签 + 打开仓库 + 名字 + 刷新」排列，详情紧贴其下，失败时按 `not-found / gh-unauth / …` 给可解释文案；详情单独缓存 5 分钟，手动刷新会连详情一起重取 | 两套 `tsc --noEmit` 无输出；`node --test` **191/191**（新增 7 条仓库详情用例：三种映射的缺字段给 null、`gh api` 参数、404 → `not-found`、本地计数）；`compilePlugin` 客户端 255286 / 服务端 178623 字节，产物里含 `deck.repo.info`、`repoOpenCount` 与 `打开仓库`；本机真实 gh 调 `readRepoInfo` 返回 `943545721/matt-skills-deck` 的实测字段（public / TypeScript / 0★ / 0 open / MIT / pushed 2026-10-27 06:07）；`paseo plugin reload` 后 running、日志干净。**外观仍需人在 Paseo 里看一眼** |

| P15 | 容器工作区识别子目录仓库：① `server/tracker/workspace-repo.ts` 接管仓库解析，顺序为「`.paseo-deck.json` 显式选择 → 工作区根目录远端 → 唯一子目录仓库自动 → 多个不猜」；只扫直接子目录（跳过点目录、最多 30 个、每批 6 个并发 `git remote`），只收 GitHub / GitLab。② 新增 RPC `deck.repo.candidates`（候选 + 当前选择 + `rootIsRepo`）与 `deck.repo.select`（写 / 清 `.paseo-deck.json`，`null` 表示清除）。③ 任务板在容器工作区显示选择条：多个候选列出按钮，唯一候选显示「自动识别」，已选择显示来源子目录 + 「用工作区根目录」；选择后让 `["deck"]` 全部失效重取。④ 选择值只接受单层目录名，`realpath` 必须仍在工作区内，符号链接逃逸 / 路径穿越 / 非 git 目录一律拒绝；文件坏了或目录没了当作没选，不报致命错 | 两套 `tsc --noEmit` 无输出；`node --test` **199/199**（新增 8 条：选择值校验、只扫一层、坏 JSON / 失效目录、写与清除幂等、符号链接逃逸、多个不猜、唯一自动与根目录优先、候选接口）；本机容器工作区只读实测 `readRepoCandidates` 返回 4 个真实候选（kxhyapp.com / kxhyapp.com-saas / mattpocock-skills / paseo-matt-skills-deck），`resolveWorkspaceRepo` 未选择时如实报「4 个仓库，未选定」；`compilePlugin` 客户端 260903 / 服务端 186917 字节，产物含两个新 RPC 与选择条文案；`paseo plugin reload` 后 running、日志干净。**没有在真实容器目录写 `.paseo-deck.json`（避免动用户目录），写入路径只在临时目录验过；界面渲染仍需人在 Paseo 里看一眼** |
| P16 复审修复 | `code-reviewer` 对 P16 判 **REQUEST_CHANGES**，按结论逐条修：① **H1** 筛到某个仓库后 `issues.list` 只回筛过的 `repos`，筛选条与仓库计数据此反推，一选就消失、回不到「全部仓库」——`readBoard` 改为始终回工作区全集，并新增只读 RPC `deck.repo.targets`（`kind` / `repos`（含 `key`、`host`、`dir`、`relDir`、`readOnly`）/ `defaultKey` / `truncated`）；任务板的筛选条、计数、默认项、卡片徽标全部从全集派生，失败横幅的「全部仓库」出口改看实际生效的 `activeRepo`。② **H2** 标签页读 / 写都不带 `repoKey`，多仓库下稳定报「需要指明仓库」——新增仓库选择条（复用 targets 全集），读、写与缓存键都带选中的 `repoKey`；没选定时不发请求，只提示先选。③ **M1** GitLab 只读没有传到票面——`IssueModal` 新增 `readOnly`，隐藏接手 / 关闭 / 评论并禁用改标签，合板卡片也标「只读」。④ **M2** 诊断与 `deck_probe` 仍走单仓库解析——诊断改用 `resolveTargets`，容器工作区逐项列出仓库，混合宿主把 GitLab 只读写进后端详情；`deck_probe` 在目标解析失败时报 `backend: none`，不再假装本地。⑤ **M3** 默认仓库改由服务端下发（`defaultKey`），根目录本身是仓库时为 null，避免首屏请求一个不存在的键。⑥ **M4** `auto` 后端在没装 git / 根目录远端认不出时回落本地 `.deck/`，恢复旧行为；显式后端仍报配置错误。⑦ **M5 / L1** 子目录扫描加 2 秒短缓存（一轮刷新只扫一次），扫描被 30 个目录上限截断时在界面与诊断里明说 | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **216/216**（新增 9 条：筛过后仍回全集、根目录仓库 `relDir` 为 null、auto 回落本地（无仓库 / 远端不可识别）、多仓库标签缺 `repoKey` 拒绝、诊断列出多仓库、诊断本地回落、显式后端解析失败如实报错、auto 解析失败报 `none`）；`compilePlugin` 客户端 276375 / 服务端 204279 字节，产物含 `deck.repo.targets` 与 `labels.selectRepo`；本机真实容器工作区只读实测 `listWorkspaceRepoTargets` 回 4 个仓库、`relDir` 各自对应目录、`defaultKey=943545721/kxhyapp.com`、`truncated=false`，`collectEnvChecks` 的 repo 行列出这 4 个仓库且 `repo` / `backend` 均为 ok、`backend=github`；`paseo plugin reload` 后 running、日志干净。复审第二轮又修两条 MEDIUM 与三条 LOW：手动刷新会一并重取仓库全集，筛着的仓库被删后自动退回「全部」；显式后端解析失败时诊断的后端行改为 fail 并给出「改回 auto」的修法，auto 失败报 `backend: none`；`deck_probe` 的多仓库 `backend` 改为按宿主去重（两个 GitHub 仓库报 `github`，不再报 `mixed`）；标签保存按钮在无改动 / 未选仓库 / GitLab 只读时禁用，并显示只读说明。第一轮复审结论 **APPROVE**（针对前述 H / M / L 修复）；四条增量（MEDIUM 1、MEDIUM 2、LOW 3、LOW 5）送审后再次 **APPROVE**，并按其意见补了标签页同类缺口：单仓库无 `defaultKey` 时只读判定回退到唯一仓库（GitLab 单仓库不再显示可保存）、选中的仓库失效后自动回到「跟随默认」；这两处再送审仍为 **APPROVE**。残留三条非阻断 LOW：显式后端下 30 个目录截断仍不提示；`auto` 下根目录是 Bitbucket 等未知宿主仍直接失败而不回落本地；`forcedMismatch` 的 `gate` 分支在生产路径上已不可达（已有 `targetFailure` 覆盖真实场景），删分支与补测试留待后续清理。**仍未对真实仓库执行写操作，也没有界面截图** |
| P16 | 容器工作区合板：① 新增 `server/tracker/targets.ts` 作为唯一的「工作区 → 仓库集合」解析层：根目录是仓库时只认根目录（单仓库行为不变），不是仓库时把直接子目录里的 GitHub / GitLab 仓库全部纳入，按 `owner/name` 去重；`.paseo-deck.json` 从「限定范围」降级为「默认筛选」；同一解析层同时服务任务板、详情、写路径、仓库详情、地图与 MCP。② 每张票带 `repoKey`（`owner/name`），列表聚合时按仓库并发分组读、单个仓库失败只进 `failures` 不拖垮整板；详情 / 评论 / 标签 / 接手 / 关票 / 新建 / 地图的入参都加 `repoKey`。③ 多目标省略 `repoKey` 一律 `invalid` 并列出可用仓库，绝不按票号猜；GitLab 目标在写路径明确只读（P19 已升级为读写）。④ 客户端任务板：仓库筛选条（全部 / 各仓库）、卡片仓库徽标、按仓库展示本地代码目录与「设为默认 / 清除默认」、部分失败横幅；新建票选目标仓库；票面与地图按 `repoKey + number` 绑定当前票，提示词带仓库与代码目录。⑤ MCP 14 个工具加可选 `repo`，`deck_probe` / `deck_context` / `deck_issues_list` 回 `repos`（含 `dir` 与 `readOnly`）与 `failures` | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **207/207**（新增 `tests/multi-repo.test.mjs` 8 条：多目标缺 `repoKey` 拒绝、单目标兼容、容器解析与默认选择不缩范围、同号票各自保留、单仓库失败隔离、详情路由、写路由与 GitLab 只读、MCP `repo` 过滤与非法键）；本机真实容器工作区只读实测：`readBoard` 聚合出 4 个仓库（kxhyapp.com / kxhyapp.com-saas / mattpocock-skills / paseo-matt-skills-deck）、55 张 open 票、`failures` 为空、`source=graphql`，按 `repoKey` 过滤只回目标仓库，非法键回 `invalid` 并列出 4 个可用仓库；`compilePlugin` 客户端 270411 / 服务端 197078 字节，产物含 `deck.repo.candidates`、`全部仓库`、`repoSetDefault`、`codeDir` 与 `repoKey`；`paseo plugin reload` 后 running、日志无错。**没有对真实仓库执行任何写操作**；合板界面（筛选条 / 徽标 / 部分失败行）仍需人在 Paseo 里看一眼 |
| P17 | 新建票后的可见性：在「拉取请求」页签或别的仓库筛选下建票，成功提示会弹，但界面不跟着走，看起来像「建完什么都没发生」。`NewIssueModal` 新增可选 `onCreated(repoKey)`，在成功提示与失效缓存之后、关闭弹窗之前回调；任务板收到后切到「任务列表 / 未关闭 / 最近更新」，把仓库筛选固定到新票所在仓库，并清空标签筛选（按「bug」筛着时建一张不带该标签的票，切完仓库仍会被筛掉）。新建票底部提示从「工作区所在的仓库」改为「所选仓库」 | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **216/216**（未新增用例：本仓库没有客户端测试设施，`onCreated` 是纯界面回调）；`compilePlugin` 客户端 276615 / 服务端 204279 字节，产物含新提示与两处 `setLabel("")`；只读 `gh issue list` 确认用户建的 **#1「测试任务」在 `943545721/matt-skills-deck`，OPEN，2026-10-27T14:30:47Z**——没显示是因为板子停在「拉取请求」页签（只列 PR），而默认仓库筛选是 `943545721/kxhyapp.com`（容器目录的 `.paseo-deck.json` 选了 `kxhyapp.com`）；容器仓库全集只读实测包含 `943545721/matt-skills-deck`（`relDir=paseo-matt-skills-deck`）；`paseo plugin reload` 后 running、新实例 ready（停止旧实例时宿主仍打印一条 `ERR_IPC_CHANNEL_CLOSED`，两次 reload 都有，属宿主关闭竞态）。`code-reviewer` 首轮 **REQUEST_CHANGES**（MEDIUM：标签筛选没清），补齐后复验 **APPROVE**；残留三条非阻断 LOW：失效缓存发生在切筛选之前（多一次旧查询的网络读取）、仓库全集未加载完时提示文案略超前、FlatList 可能保留滚动位置。**未在 Paseo 界面里实际点一遍新建→自动切换**（需用户操作） |
| P18 | 新建入口按 DSH 补全（A8）：类型改为两张需求卡（探索 `/wayfinder` / 实施 `/grill-with-docs`）+ 普通票 + `+ 缺陷`；需求正文按界面语言铺六节、备注附后；缺陷四字段（实际 / 期望 / 复现 / 环境），「实际」必填，缺项尝试标 `needs-info`、未诊断标 `needs-triage`；建票成功可按开关复制技能提示词。提示词只点名本插件真实注册的 MCP 工具（`deck_issues_list` 等），`suggest_next_steps` / `deck_issue_report` 不再出现；标签失败时让 Agent 先 `deck_issue_get` + `deck_issue_labels` 补齐。探索预建票明确标为「种子票，不是地图」，wayfinder 另建 `wayfinder:map` 并把链接回填；地图开关只在普通票模式显示，需求 / 缺陷强制 `isMap=false`。建票进行中禁止关闭与编辑，避免旧请求成功后清掉新草稿；纯决策逻辑抽到 `shared/new-issue.ts` | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **245/245**（`tests/new-issue.test.mjs` 覆盖只读过滤、默认仓库回退、缺陷四字段、地图标签剥离、草稿快照、迟到成功 / 失败代次组合、`planCurrentSettleNotice` / `planLateFailure` 与 `maybeCreated`；`tests/requirement.test.mjs` 含中文六节、缺陷正文、标签成功 / 失败、空链接、种子票建地图 / 挂路线、提示词工具名与 `MCP_TOOLS` 交叉校验；`tests/mcp-protocol.test.mjs` 钉住 `deck_map_link` 描述；`tests/write.test.mjs` 覆盖建票网络异常 / HTTP 422 / 非 JSON / 缺票号的 `maybeCreated`）；`compilePlugin` 客户端 332014 / 服务端 204859 字节，产物含 `lateFailedAfterCreated` / `maybe-created` 文案、不含 `focusBoard` / `suggest_next_steps` / `deck_issue_report`；`paseo plugin reload` 后 running，最新实例 `[paseo] Plugin ready`（16:46:33Z）。`code-reviewer` 多轮复审：第 5、6 轮 REQUEST_CHANGES 的 HIGH（迟到成功必须无条件 `onCreated`）、MEDIUM（结构化迟到提示 + `planLateFailure`、迟到成功改写 kept 草稿目标仓库）、LOW（`deck_map_link` 描述、`pickedRepo` 自动回退、结果不确定的失败仍说可重提）均已修复，第 7 轮 **APPROVE**。残留非阻塞 LOW：钉住的目标只在本次打开期间有效；后续一次确定失败会清掉先前的 `maybe-created` 警告；`gh-failed` 的统一「被拒绝」标题在超时场景下措辞偏确定。**没有在 Paseo 界面里实际点一遍，剪贴板与 toast 未实测** |
| P19 | 八线全量吸收（A1–A26 收口，规则 / 文案 / schema 按 DSH 原文搬运）：① 工具面：15 个 MCP 工具（DSH 九颗冻结名 + 6 个扩展），补 `suggest_next_steps`、别名归一、只读预授权；② GitHub 后端拆到 `server/tracker/github/`，补 REST 条件请求 / ETag、增量刷新、REST 与 GraphQL 两本额度、权限预检、建票幂等锚点、失败分类与降级；③ GitLab 读写：`glab api` 写路径 + `checkGitLabWritable`（至少 Reporter），标签改色写后读回；创建时 `blockedBy` 失败只记字段、不回滚建票；④ 本地后端识别 `.deck/` 与 `.scratch/` 双布局，补齐正文 / 标记 / 初始化兼容；⑤ 会话与台账：`SessionSheet` 发送到当前 / 新建会话、队列等待、技能可用性核实、`server/ledger.ts` 的 agent / workspace 台账、AI 交接；⑥ 检查目录 16 项 + 六步引导 + 修复动作分派（5 个未接线动作明确标注），发布计划 / dry-run / 确认令牌（不执行）；⑦ 面板刷新策略：注意力、失败退避、额度分账，写入不受降档影响；⑧ 原生座位：胶囊 / 页头 / 助手面板 / 命令中心 / `/deck` / 附件源 / 时间线 transformer + renderer / 侧栏行 / 整页 | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **541/541**；`compilePlugin` 客户端 **592076** / 服务端 **629415** 字节，产物含 `deck.checks.run`、`deck.session.send`、`checkGitLabWritable`、`parentApplied`、`messageKey`、`hasBlockingCycle`；独立 `code-reviewer` 两轮复审均为 **APPROVE**：首轮 2 MEDIUM + 5 LOW 全部修复并复验（显式 `agentId: null` 作用域、复用票 `applied` 标记、发送去重 `messageId`、标签改色写闸门、环预检未知即拒写、登录态 unknown、面板远端建票拒绝 `parentKey` / `idempotencyKey`），复验后又补修其残留的一条预存 LOW（原生阻塞边读失败不再退回正文行、环检测触顶报未知）并再次 APPROVE——**真实远端写入、Paseo 界面点击、设置页加载态仍未验** |
| P20 | **会话入口改为「填输入框」而不是发送**：`SessionSheet` 去掉 `deck.session.send` 调用，改为写宿主 Web bundle 的草稿 store（模块 3598，key `agent:<serverId>:<agentId>`），写完读回 active 草稿再导航到目标会话，由用户自己按发送；目标输入框已有非空草稿时先提示「覆盖并填入」，不静默替换。新建会话成功后记住 `agentId`，预填失败重试只重填、不再建第二个；双击有 busy 闸。0.13.2 的 composer 没有可定位目标会话的稳定 DOM 标记，因此不做 DOM 猜测；草稿 store 失败就复制提示词，并如实说明原因。新建需求 / 技能 / 票面 / 地图 / 检查页的注入入口全部走这条路径；serverId 取宿主界面 props 的 `host.id`（`PluginClientContext` 没有该字段）；新建会话走 `workspaces.ref(workspaceId).agents.create`，避免裸 `agents.create({cwd})` 把会话落到同目录的另一个工作区。创建快照只认 `snapshot.agent.id`：0.13 在 `accepted` 阶段就分配 `agentId`，agent 阶段失败时该 id 仍在但没有 `agent`，若当成已创建会把草稿写进不存在的会话；`outcomeUnknown` 时不继续预填、不自动重试，提示用户先核对会话列表。`server/session.ts` 的发送 RPC 保留为兼容接口，界面不再调用 | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **603/603**（`tests/prefill.test.mjs` 16 条：草稿 key、active 编辑、空草稿保存、缺 serverId / 空文本拒绝、已有草稿确认、显式覆盖、读回必须 active、no-loader / no-store / write-failed / 缺 edit 方法；`tests/creation.test.mjs` 7 条：工作区路由、accepted 预留 id 不算创建、只有 `agent.id` 才算、失败 / 结果不确定如实返回、失败但已有真实 agent 仍算已创建）；`compilePlugin` 客户端 685063 / 服务端 660742 字节；`paseo plugin reload` 后 running，插件日志 `Plugin ready`（17:40:42Z）；`code-reviewer` 复审 **APPROVE**（HIGH：accepted 预留 id 被当成创建成功、失败会假成功并卡死，已用 `snapshot.agent.id` 判定修掉）；**真实客户端输入框是否出现文字仍未验** |
| P21 | 编排与技能生成：① 面板新「编排」页签（角色 / 客户端注入 / 档案 / 难度路由 / 会话树）；② `deck_dispatch_plan` 按难度算出 provider/model、标签、抬头，`deck_handoff` 写回传件；③ `agent.turn_ended` 钩子把子会话结果 `steer` 回传给父会话，一级一级往主窗口走；④ 技能页可按需求生成骨架 + 提示词，校验后才装进 `.claude/skills` 与 `.agents/skills` | **完成（代码侧）** | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **712/712**；stdio 冒烟 `tools/list` **17 个工具**、`deck_dispatch_plan` 四条任务按难度落到 haiku / sonnet / gpt-5、借用路由有 `warnings`；`paseo plugin reload` 后 `Plugin ready`。**编排页与技能弹窗没在界面点过；真实派单 + 回传没跑过** |
| P22 初次验收（历史） | 客户端注入源查看与指定清理：卡片上的「N 个密钥」可点开，新增只读 RPC `deck.orchestration.provider.source`，读取宿主 `<PASEO_HOME>/config.json`，列出源文件路径、匹配的 provider 条目（内建 + `extends` 派生，标出生效的那条）、顶层字段名与 env 键名 / 掩码值；凭据与含用户名/密码的地址只给掩码，主地址与已配置模型名原样。弹窗里可勾选 env 键或整条条目清理：地址 / 凭据键与非空条目需二次确认，服务端摘条目再写回并读回核对（RPC `deck.orchestration.provider.cleanup`）。整条删除写宿主级墓碑 `<PASEO_HOME>/matt-skills-deck-state.json`，`mirrorCodexSiteModels` 不再重建；在卡片重新保存 codex 时清墓碑。同时补上「凭据未设置 → 改」与高级 env 行「改」缺失的编辑表单，并把五处重复编辑器抽成 `EnvEditor` | 两套 `tsc --noEmit` 无输出；`node --test tests/*.test.mjs` **2028/2028**（`tests/provider-source.test.mjs` 3 条：路径 / 生效条目 / 掩码、模型名、缺失 / 坏 JSON / 未找到；`tests/provider-cleanup.test.mjs` 14 条：只删选中键、保护键需确认、空条目 / 非空条目、缺条目 / 未知键 / 重复、归属校验、空数组 / 字符串数组保留、additionalModels 归一、只支持 Claude / Codex、command 条目确认后可删、非数组坏形状、空值保护、未选内容被丢、并发改动、写后读回不一致；`tests/provider-env.test.mjs` 1 条：保护键判定）；`compilePlugin` 客户端 1033132 / 服务端 1512447 字节；`paseo plugin reload` 后 running。`code-review` 源查看双轴 **APPROVE**；清理增量规范轴 **APPROVE**（含强制整条删除与墓碑），需求轴最终复验中。残留 `ClientsPanel.tsx` 974 行（改动前 960 行，800 行上限是既有问题）、卡片 env 仍按旧口径掩码 `OPENAI_MODEL`（源视图只在 `configuredModelIds` 内展示） |

### P22 删除意图与恢复核验补修（2026-11-14）

- 本节更新 P22 初次验收时的恢复条件：整条删除前必须成功保存删除记录；写入结果按 `.ok` 判断，失败时不执行宿主删除。宿主响应异常后按读回状态判断，只有确认条目完全未变时才撤销本次新增记录，既有删除意图不回滚。
- 卡片保存与站点启用共用恢复核验：本次写入与必要保留的 env、模型、command 等字段均已读回确认后才清除 Codex 删除记录；失败、部分落地或无法核对时保留。模型允许重排与宿主裁掉窗口字段，仍核对 ID、重复项、标签、说明、默认项和思考档位。删除记录损坏或不可读时暂停自动接管、重复 env 清理和模型镜像，并在状态页说明原因。
- 当前工作区验证：`npm run typecheck` 两端通过；WSL Ubuntu、官方 Linux Node v22.23.1 下完整 `npm test` **2103/2103**，0 失败、0 跳过。保存与启用两文件定向验证在 Linux 下 **117/117**；Windows Node 下 **116/117**，唯一失败为既有 `0600` 权限断言，实际读回 `0666`，不将其记为通过。恢复核验模块定向覆盖率：行 100%、分支 88.46%、函数 100%。
- 文档核对：同步 README、双语 OVERVIEW 与删除记录注释；核对 `GLOSSARY.md`、`docs/port-diff.md` 与 `AGENTS.md`，没有本次需改写的领域决定，仓库尚无 `docs/adr/`。本轮整批工作区的规范 / 规格两轴审查待完成，历史审查结论不代替本轮验收。
- 包内容检查：`npm pack --dry-run --json` 通过，501 个条目，本次检查的新增客户端 / 服务端模块均包含在包内。本轮未找到可用的 `compilePlugin` 入口，未执行宿主 bundle 编译或真实界面验证；包内容检查不替代这些验证。
- 本轮验证使用模拟 Paseo API 和临时文件；没有读取或删除真实宿主 provider 配置，没有部署、重载、提交或推送。

### P22 规格复审补修（2026-11-15）

- **追加模型元数据核验**：`additionalModelsSignature` 原只比 id + label，宿主吞掉 `description` / `isDefault` / `thinkingOptions` 仍会返回成功。改为 `additionalModelsExpectation` + `additionalModelsPreserved`：写前记住原条目每个字段，读回时逐字段核对；宿主自己补的新字段不算丢数据，`undefined` 与空数组仍区分。新增 3 条字段丢失 → `verify-failed` 回归与 1 条完整保留成功回归，`tests/provider-cleanup.test.mjs` 共 29 条。
- **源读取生命周期**：新增 `ProviderSourceDialog.tsx`，用 `{provider, request}` 世代 + 请求序号归属读取；关闭、重开同一 provider、切换客户端、卸载后，旧 resolve/reject 不写状态也不触发父回调；刷新保留上次结果、同一打开状态最新请求胜出。`tests/provider-source-modal.test.mjs` 25 条覆盖上述组合（含旧清理刷新 A 不能覆盖重开读取 B）。
- **源视图凭据掩码（规格轴 HIGH）**：`server/provider-source.ts` 原按 env 插入顺序取第一个 `*_BASE_URL` 当主地址，备用键排在前面时会把带 `?api_key=` 的地址明文返回；现按 `providerBaseUrlKey()` 选客户端真正读的主键，主键无有效地址才退回第一个地址键，并对 userinfo 与凭据类查询参数（`api_key` / `access_token` / `token` / `secret` 等）一律掩码。非对象条目（手改成 `null`）不再标成 `removable`，与清理侧的 `not-found` 对齐。新增主地址查询串凭据、备用键插队、非对象条目 3 条回归。
- **规范整改**：`server/provider-cleanup.ts` 拆为 prepare / tombstones / write / verify / shared，`runCleanup` 约 27 行；`ClientsPanel.tsx` 由 912 行降至 221 行，卡片拆到 `ProviderCard.tsx` / `ProviderCardFields.tsx` / `ProviderSitesField.tsx` / `ProviderToolsField.tsx` / `providerCardStyles.ts`，编辑、显示、诊断、站点、展开状态拆到 6 个 `use*.ts` hook；源查看仍在 `ProviderSourceDialog.tsx`，高级 env 仍在 `ProviderAdvancedFields.tsx`。所有新文件 < 400 行，主函数不再包含 400 行级 JSX。
- **编辑入口接线**：新增 `tests/provider-edit-wiring.test.mjs` 8 条，转译并驱动整张 `ProviderCard`（含卡片体字段组装与 `envKeysFor` 键推导），只替换 React / 原生控件 / 宿主 UI 边界；fixture 用生产的 `envDisplayOf` / `credentialKeysOf` / `baseUrlOf` 派生。覆盖凭据未设置「改」、已配置密钥行显示 / 改、地址 / 高级行 / 显示名编辑的 `onChange`、新增 env 的 `onChangeText` 与键或值单空禁用、保存包上 provider 并清空、折叠与头部回调；补上规格轴记录的「需求 1 UI 接线无自动化测试」缺口。
- **验证**：`npm run typecheck` 两端通过。WSL Ubuntu + Node v24.20.0（`/opt/node-v24.20.0-linux-x64`）完整 `node --test tests/*.test.mjs` **2141/2141**，0 失败、0 跳过。Windows Node 全量 **2137** 条，最近两次 2044 通过 / 93 失败与 2043 通过 / 94 失败；多出的 1 条是 `window-note-relay` 队列重试用例在全量负载下偶发，单跑 6/6 通过。失败全部落在 gh / git / GitLab / MCP / 技能探测 / 票流程等既有环境性用例，唯一关键词命中是 GitHub `source=rest`，未出现 provider / cleanup / card / source / env 编辑相关用例；仍无逐条基线对照。定向 `card-open-state` / `provider-edit-wiring` / `env-editor` / `provider-source` / `provider-cleanup` 五文件 **53/53**。
- **文档核对**：README、双语 OVERVIEW 的清理读回说明补上「未选中的模型清单、追加模型说明 / 默认项 / 思考档位少一样即失败」；源视图说明补上「主地址与已配置模型名原样，地址自身带 userinfo 或凭据类查询参数时同样掩码」。核对 `GLOSSARY.md`、`docs/port-diff.md` 与 `AGENTS.md`，没有与本次相冲的领域决定，仓库仍无 `docs/adr/`。
- **包内容**：`npm pack --dry-run --json` 519 条，本轮新增的客户端 / 服务端模块全部包含。
- **两轴复审**：规格轴复验 **APPROVE**；原残余风险（需求 1 的 UI 接线无自动化测试）已由 `tests/provider-edit-wiring.test.mjs` 8 条覆盖，定向复验 **APPROVE**，残留 LOW 为地址 / 显示名编辑未调各自的 `onSave`、`useFieldEditing` / `useEnvAddition` 未直接驱动、`cardProps` 约 55 行，均不阻断。规范轴复验 **REQUEST_CHANGES**，唯一 MEDIUM 为 `useCardOpenState.ts` 收起当前卡片时提前 `return`，跳过明文 / 编辑态 / 安装确认清理；已把三项清理移到分支之前，并新增 `tests/card-open-state.test.mjs` 4 条钉住收起、切换、高级区与配置源开关。同轮 LOW 中的 `installingFor` 死代码与 3 个多余导出已删除 / 收窄；函数长度 51–63 行的 4 处仍为 LOW（主要是 prop 解构），不阻断。规范轴最终复验 **APPROVE**；两轴均通过。
- **交付验证（2026-11-15）**：本地提交 `89e3efb` 并推送到 `origin/feat/multi-project-workspace`；`paseo plugin reload matt-skills-deck` 后状态 running（02:25:24 停止、02:25:30 就绪，无错误）。用插件只读 RPC `deck.orchestration.provider.source` 对真实宿主验证：`codex` 返回派生 `deck-codex`（effective）与基座 `codex`，凭据 `OPENAI_API_KEY` 只给 `••••6f2b`，地址 `OPENAI_BASE_URL` 原样；`claude` 未配置返回 not-found。未调用清理 RPC、未修改宿主配置、未打印原始密钥。应用界面可见插件命令与任务板「编排」子页；源弹窗的逐项点击未完成，UI 接线由 `tests/provider-edit-wiring.test.mjs` 覆盖。

### P19 测量（2026-10-28）

- 类型：`npx tsc --noEmit -p tsconfig.json` 与 `npx tsc --noEmit -p tsconfig.server.json` 均无输出。
- 测试：`node --test tests/*.test.mjs` → **541 / 541 pass，0 fail**（GitLab 单文件 34/34）。
- 打包：宿主 `compilePlugin` → 客户端 **592076** 字节 / 服务端 **629415** 字节；产物含
  `deck.checks.run`、`deck.session.send`、`checkGitLabWritable`、`parentApplied`、`assigneesApplied`、
  `blockedByApplied`、`messageKey`、`hasBlockingCycle`，以及复用提示 / 环预检 / 面板远端拒绝的中文文案。
- 本轮重点套件：`tests/session.test.mjs`、`ledger`、`checks`、`publish`、`work-route-view`、
  `tool-contract`、`suggestions`、`github`、`local-layout`、`repo-info`、`refresh`、`auth`、
  `slash`、`transformer`。
- 复审修复（`code-reviewer`，两轮 APPROVE）：
  1. `server/session.ts` 用 `!== undefined` 保留显式 `agentId: null`，新会话的票记进工作区台账；
  2. `server/mcp/tools.ts` 给父票 / 指派 / 阻塞边加 `applied` 标记与复用提示，复用已有票时不再声称本次写入；
  3. `SessionSheet` 发送失败重试沿用同一个 `messageId`，成功或改草稿后换新；
  4. 标签改色 RPC 改走 `resolveWritableBackend`，与其它 GitLab 写路径共用 Reporter 闸门；
  5. GitLab 成环预检读不到节点即拒写；原生边非能力错误（超时 / 5xx）不再退回正文行，200 张上限触顶报未知；
  6. `gh auth status` 只有明确「未登录」才是 fail，网络 / 超时归 unknown；
  7. 面板 RPC 远端建票带 `parentKey` / `idempotencyKey` 时明确拒绝，不静默丢字段。

### P21 编排与技能生成（2026-10-29）

需求：技能可按需求由 AI 生成配置；一个需求可分给多个不同客户端；可配置各客户端模型的注入；
可指定主沟通窗口与派单窗口；按难度分配客户端与模型；结果一级一级往主窗口回传。

- 新增域：`shared/orchestration.ts`（纯逻辑：难度、路由、标签、派单计划、抬头、会话树）、
  `shared/orchestration-rpc.ts`（5 个 RPC）、`server/orchestration-store.ts`（`.deck/orchestration.json`，
  原子写，坏文件回落默认值并标 `corrupt`）、`server/orchestration.ts`（执行层：读状态、存设置、
  改客户端注入、存档案、跑派单）、`server/daemon-profiles.ts`（MCP 侧读 `<PASEO_HOME>/config.json`
  的 `daemon.agentProfiles`）、`server/handoff-store.ts`（`.deck/handoffs/<agentId>.json`）、
  `server/report.ts`（收尾回传）。
- MCP 工具从 15 个变 17 个：`deck_dispatch_plan`（按难度算出 provider/model、标签、抬头，只读）、
  `deck_handoff`（子会话写回传件）。两者都进 preapproved：前者只读，后者只写自己名下的回传件。
- 回传链路：`agent.turn_ended` 钩子 → 读回传件（没有才退回时间线尾部）→ 用
  `activeTurnBehavior: "steer"` 发给 `agent.parentAgentId`。没写回传件时报告里明说这一支没回传。
- 技能生成：`shared/skills-draft.ts` + `server/skills-draft.ts` + 三个 RPC（生成骨架 / 校验 / 安装），
  草稿写 `.deck/skills-draft/<slug>/SKILL.md`；校验不过不装；同名不同内容默认算冲突。
- 界面：面板新增「编排」页签（角色 / 客户端 / 档案 / 路由 / 会话树），技能页新增「按需求生成技能」。
- 难度路由的兜底改成**说出来**：`resolveRoute` 会退到 `normal`、再退到内置默认目标，
  这两种「借来的路由」由 `routeFromOf` 标出，落成 `DispatchTask.routeFrom`，
  在 `deck_dispatch_plan` 的逐条 `warnings` 与编排页的路由行上写明。
  原先文档写的「没配置就拒绝派单」是错的：真实行为是借用，只是之前没人说。
- 类型：`npm run typecheck`（两个 tsconfig）无输出。
- 测试：`node --test tests/*.test.mjs` → **712 / 712 pass，0 fail**；本轮新增
  `tests/orchestration.test.mjs`（20 条）、`tests/skills-draft.test.mjs`（10 条）、
  `tests/orchestration-write.test.mjs`（10 条：注入 env 带上已有键、首次注入照写新键、配置读不到才拒绝、
  现有 env 不是键值表时拒绝、额外模型的 `label` 不丢、
  档案字段不被抹掉、写后读回丢了条目要报错、写后读不到配置只说「没法核对」、删不存在的档案不改写）、
  `tests/orchestration-rpc.test.mjs`（3 条：走 handler 验 `workspaceId` 透传 / 退回唯一角色 / 多角色不猜）、
  `tests/orchestration-dispatch.test.mjs`（6 条：`unknown-workspace` 与 `no-dispatcher` 分开报、
  读不出编排文件报 `settings-unreadable`、超层不夹、成功路径的 provider/标签/抬头、逐条拒绝不连坐）、
  `tests/report.test.mjs` 新增「回传件缺 status / createdAt 坏掉 → 退回时间线」（+1）、
  `tests/mcp-orchestration-tools.test.mjs` 新增「坏文件 / 读不出来都直接报错」（+1）、
  `tests/orchestration-write.test.mjs` 新增「env 为 null / 字符串被拒」「成功删除」「宿主带畸形条目不误报」（+3）、
  `tests/skills-draft.test.mjs` 新增「内容等于骨架时不算覆盖」（+1）、
  `tests/orchestration-rpc.test.mjs` 新增「空白 workspaceId 报 invalid」（+1）、
  `tests/report.test.mjs`（17 条：回传正文三档来源、时间线尾部截取、`steer` 发送、
  同一回合去重、在飞重放只发一次、`turnId` 为空不去重、旧回传件不当新结论、失败不算报过、
  开关默认开）、`tests/orchestration-state.test.mjs`（11 条：
  env 掩码、根级与磁盘两种配置形状都认、两处都空时告警、`routeFrom`、会话树、读失败分类）、
  `tests/mcp-orchestration-tools.test.mjs`（13 条：
  经 `findTool(...).run(...)` 走工具入口——难度分流、拒绝分类（`unknown-workspace` / `no-dispatcher` /
  `depth-exceeded`）、`depth` 必填、按真实调用者写标签、借用路由告警、坏文件降级、
  `deck_handoff` 落盘路径、不接受 `agentId`、没有 `PASEO_AGENT_ID` 就失败）。
- stdio 冒烟（真实入口 `node server/mcp/main.ts --workspace <dir>`）：
  `initialize` → `tools/list` 返回 **17 个工具**，末尾依次是 `deck_handoff`、`deck_dispatch_plan`、
  `suggest_next_steps`；对临时工作区（`.deck/orchestration.json` 里配了 trivial / normal / hard）
  调 `deck_dispatch_plan`，四条任务被接受并各自解析出 `claude/haiku`、`claude/sonnet`、`codex/gpt-5`，
  没配的 `critical` 借到 `claude/sonnet` 且 `warnings` 里明说借用。
- `deck.orchestration.dispatch` RPC 与 `server/orchestration.ts#runDispatch` 是**程序化派单**入口
  （宿主侧一次建多个子会话），AI 走的是 `deck_dispatch_plan` + 宿主的 `create_agent`；界面暂不调用前者。
- 界面清晰度（本轮，用户反馈「视觉不是多清晰」）：
  - 角色页：原来「两个页签 + 一行当前值 + 一串会话」三处都在说同一件事，看不出正在改哪个角色。
    改成两行字段（名字 / 当前值 / 说明，正在编辑的那行带 2px 强调色竖线 + `paper` 底），
    下面一块「选一个会话当作{角色}」的选择器只服务那一行，会话行带强调色竖线与「当前」标记；
    层数与单次上限改成「标签左、`− 数字 +` 右」两栏，并把 `1–6` / `1–24` 的范围写在提示里。
    角色页不再重复底栏的「层数 · 单次最多」（有计数器就够了）。
  - 路由页：难度名与「编辑」按钮同行、解析结果单独一行（扫一列时对得齐）；
    「借用 normal 的路由」从红色错误降为次要色提示（`↳` 前缀），红只留给「这档根本发不出去」。
  - 客户端页：标题行只放名字与展开按钮，状态 / 模型 / 已有 env 键各自独立成行；
    「只追加不删除」的说明从整块底色改成一道竖线。
  - 档案页：标题行只放名字与删除，标识 / 规格单独一行；保存按钮单独成行，并写明「id 相同就是覆盖」。
  - 页面顶部的多条提醒收进一个带竖线的提醒块，不再一条一行散在正文上方；
    服务端把四档难度的路由告警合并成一句（「N 档难度没配路由：…」）。
- 本轮改动后：`npm run typecheck` 无输出；`node --test tests/*.test.mjs` 仍为 **712 / 712**；
  `paseo plugin reload matt-skills-deck` 后 running；stdio 冒烟 17 个工具、难度分流与借用告警不变。
  **这几页的实际观感仍需人在 Paseo 界面里看一眼。**
- 角色选择器接上宿主切窗（用户反馈「点了窗口没自动切换」）：点一行原来是「只把 id 写进
  `.deck/orchestration.json`」，界面上看不出任何变化，看着像没生效。现在点一行 = 设为该角色
  **并**调 `navigation.openAgent` 切过去；会话在别的目录时先 `openWorkspace` 再 `openAgent`
  （只调后者的话当前工作区里找不到这个 id，聊天不会切）。旧宿主没有 `navigation` 时不显示这行提示，
  角色照样能设。**真实切窗行为需要在界面里点一次才算验过。**
- 父子关系落到客户端：宿主把父子关系放在快照的 `parentAgentId` 与标签 `paseo.parent-agent-id`
  两处（我们派单时两边都写），服务端早就在用（`buildAgentTree` 拼会话树、`report.ts` 找父窗口回传）；
  缺的一直是客户端——`AgentInfo` 只映射了 id / 状态 / provider / model / 标题，所以编排页的会话列表
  是平铺的，看不出哪条是子会话。现在 `AgentInfo.parentAgentId` 先取快照字段、没有再退回标签，
  角色页的会话行对子会话加一个中性色「子会话」标和一行「挂在 X 下」。
  **实测（2026-10-29）**：用宿主 SDK 建了一个带 `parent` 的子会话 `6ad6bbd6`（无 prompt，不触发模型回合），
  读回结果推翻了原先的假设——**`agents.list` 快照里 `parentAgentId` 是 `null`**，关系只落在标签
  `paseo.parent-agent-id` 上；`paseo inspect` 的 `parentAgentId` 也是 `None`。所以客户端那条
  「先取字段、退回标签」的退路才是真正生效的那条，单取字段会全部显示成根会话。
  服务端 `readOrchestrationState` 用同一个 api 读出的会话树里，这个子会话正确挂在当前会话下
  （`接手一个已经在跑的项目…` → `父子识别验证（可删）`）。
  子会话留着给界面看「子会话」标，删掉用 `paseo delete 6ad6bbd6`。
- 客户端页把「装没装 / 能不能装」说清楚（用户问「没识别是否已安装吗？没有直接安装的控制吗？」）：
  - **识别**：宿主的 provider 快照本来就带 `status = ready | loading | error | unavailable`
    （`unavailable` = 这台机器上找不到命令），界面原来只把这串英文原样印出来。现在翻成
    「可用 / 加载中 / 未安装 / 装了但报错 / 状态未知」，未安装与报错用 `bad` 色。
    **不自己 `which`**：插件和宿主可能跑在不同 PATH 上，自己查的结论和真要拿来跑命令的环境不一致。
  - **诊断**：新增只读 RPC `deck.orchestration.provider.diagnostic`，把宿主的诊断原文
    （`Resolved path` / `Version` / PATH / which 结果）按行铺在卡片里。实测 copilot → `Resolved path: not found`、
    claude → `/usr/bin/claude` + `2.1.309`。
  - **安装**：新增 `deck.orchestration.provider.install`，执行 `npm install -g <pkg>`。
    只有 `shared/provider-install.ts#INSTALL_RECIPES` 里核过包名的四家给按钮
    （claude / codex / copilot / opencode，包名本机 `npm view` 核过）；其余说明「按官方文档装」。
    命令与参数分开传、不经 shell，provider id 只用来查表；同一时间只允许一个安装（并发跑 npm 会踩全局目录）；
    输出去色、只留最后 4000 字回到界面。**界面上要点两次**：先「安装」看到将要执行的命令，再「确认安装」。
  - 硬约束（记下来，挺坑）：插件 RPC 方法名必须匹配 `^[a-z][a-z0-9._-]*$`，写成驼峰的
    `providerInstall` 会让 `paseo plugin reload` 报 `Invalid plugin RPC method`、插件直接 `failed`，
    而 `tsc` 与单测全绿。已加 `tests/rpc-names.test.mjs` 扫全部 `defineRpc` 名字。
- 本轮验证：`npm run typecheck` 无输出；`node --test` **726 / 726**（新增 `tests/provider-install.test.mjs` 8 条、
  `tests/orchestration-rpc.test.mjs` +4 条诊断 handler、`tests/rpc-names.test.mjs` 2 条）；
  `paseo plugin reload` 后 running；宿主诊断文本与 provider 状态用真实 daemon 核对过。
  **「安装」按钮只跑过假 runner，真实的 `npm install -g` 一次都没执行**，也没在界面点过。
- 已注入的键可以逐条改（用户问「这些我怎么没有编辑」）：原来「已注入的键」只是一行只读文本，
  要改只能自己在下面的注入表单里手敲键名。现在展开后是一个键一行（键名 / 掩码 / 「改」），
  点「改」就地开一个掩码输入框，写新值点「注入」即覆盖（服务端本来就是整块 env 带上旧键写回）。
  **删键仍然做不到**：宿主配置补丁只能新增/覆盖，而我们只握有其他键的掩码、拿不到明文，
  没法「除了这个键之外原样写回」；要删只能改 `~/.paseo/config.json`，卡片上的说明已写明。
  本轮：`npm run typecheck` 无输出；`node --test` **726 / 726**；`paseo plugin reload` 后 running；
  **逐条编辑的界面没点过**。
- 已注入的键可以就地看原值（用户问「直接能够查看原值的 能理解吗」）：默认仍然是掩码，
  逐个键有「显示 / 隐藏」。点「显示」才发一次 `deck.orchestration.provider.reveal`，
  只取回**那一个键**的明文，只活在这张卡片的内存里——不进状态快照、不进日志（服务端日志只写
  「按请求展示了 <provider> 的 <key>」，不写值）。取不到就如实显示失败原因
  （`invalid` / `not-found` / `config-failed`），不猜、不返回空串冒充「值为空」。
  这条和「只显示掩码」的旧口径不冲突：明文不再随快照批量下发，而是用户显式点一下才拿一个。
- 模型改成**从宿主选**，不再让人手敲（用户问「这些有用吗，模型不是想这样获取识别的吗？」）：
  - **先摆事实**：宿主本来就认得这些模型。本机实测 `providers.snapshot` 里 claude `status=ready`
    带 **31 个模型**（含 `deepseek-v4.1-flash` / `glm-5.3-flash` / `kimi-k3.1-pro` 这些代理模型），
    codex 带 7 个；配置里声明的模型会被并进这份列表。所以「额外模型」那个手填框是多余的。
  - **两种键不是一回事**：claude 用 `additionalModels`（**追加**在内置列表之上，13 条），
    codex 用 `models`（**替换**内置列表，7 条）。插件原来一律往 `additionalModels` 写——
    对 codex 等于写到一个不生效的地方。现在按现存配置选键（`modelListKeyOf`），写回原来那把。
  - **改动从「只能追加」变成「整份替换」**：RPC 入参 `models` 就是写完之后的完整清单，
    没列进去的会被删掉，条目上宿主自己的字段（`label` / `isDefault` / `description` /
    `thinkingOptions`）原样带回。读回校验同时查「该有的没有」和「该删的还在」，
    后者原来完全不查，取消勾选失败会静默通过。替换模式下清空直接拒绝（否则这个客户端一个模型不剩）。
  - **界面只列我们这条接口的模型**（用户接着说「只需要显示我们接口的，不是说客户端已有的」）：
    `ModelPicker` 就是配置里声明的那 13 个芯片，客户端自带的 18 个（`claude-opus-*` / `sonnet` /
    `haiku` / `fable`…）**一个都不列**——那些是客户端厂商的型号，跟这条链路没关系，混进来只会让人
    自己从 31 个里挑「哪几个是我这条 API 能跑的」。点芯片即移除，下面一个输入框加新模型；
    超过 6 个才出现筛选框。折叠行的「N 个模型」也改成数这份清单（13），不再数宿主的 31。
    为此把芯片层里「内置 / 已选」那套状态整段删掉：清单本身就是我们说了算，
    全选 / 全不选 / 仅看已选对一份「全是自己的」清单没有意义。
  - **模型名不再掩码**：`ANTHROPIC_*_MODEL` 的值就是模型 id，掩成 `••••lash` 只会让人看不出这台机器
    跑的什么。规则是「模型键 + 值形状像模型 id」才明文（`shared/provider-models.ts#isPlainModelValue`），
    `sk-` / `ghp_` / `Bearer` 这类前缀哪怕挂在模型键上也照样遮；凭据与 URL 继续走掩码 + 逐键「显示」。
    实测本机：5 个 `ANTHROPIC_*_MODEL` 现在明文显示 `deepseek-v4.1-flash`，
    `ANTHROPIC_AUTH_TOKEN` 仍是 `••••e36d`、`ANTHROPIC_BASE_URL` 仍是 `••••8083`。
  - 本轮：`npm run typecheck` 无输出；`node --test` **737 / 737**（`tests/provider-models.test.mjs` 10 条，
    改写 `tests/orchestration-state.test.mjs` / `tests/orchestration-write.test.mjs` 里掩码与模型写入的用例）；
    `paseo plugin reload` 后 running；`readOrchestrationState` 用真实 daemon 跑过一遍（上面那组读数就是它出的）。
  - **没做的**：`路由` 与 `档案` 两处的模型输入框仍是手填文本框（同样可以接同一份模型清单，但那两页本来就挤，
    这轮没动）；改模型的界面没在 Paseo 里点过；没有对 codex 的 `models` 真的写一次（写回路径只有 fake 用例）。
- 补上「获取模型」按钮（用户问「我怎还是没找到获取模型的按钮呢」）：
  - 新增 RPC `deck.orchestration.provider.models`，服务端 `server/provider-models-fetch.ts`：
    用配置里**已经有**的 `*_BASE_URL` + `*_API_KEY` / `*_AUTH_TOKEN` 拼一次
    `GET {base}/v1/models`（base 已带 `/v1` 就不重复拼），回包认三种形状
    （`data[].id` / `models[]` / 裸数组），去重后最多 500 个。
  - 凭据只进请求头，**不回给客户端、不进日志**（日志只有 provider / 路径 / 条数）；
    报错里若回显凭据（429 正文里常带 key）会先抹掉再给人看。
  - 失败分八类，各自给下一步动作：`no-endpoint`（没 base url）、`no-credential`（有地址没 key）、
    `unauthorized`（401/403，指出是哪个键被拒）、`http`（其它状态码带正文片段）、
    `network`、`bad-payload`（200 但解析不出）、`config-failed`、`invalid`。凑不齐配置就不发请求。
  - 界面上：模型区块多了「从接口获取模型」，回来一行「接口返回 N 个模型 · 其中 M 个还没加进来」，
    没加进来的以虚线芯片列出（点一下加入一个），另有「全部加入」。
  - **真机实测**（用你的 claude 配置发的真实 GET，只读）：
    `http://192.168.88.12:8083/v1/models` → **14 个模型**，比配置里那 13 个多出
    `gpt-5.3-codex-spark` / `gpt-5.4-mini`，而配置里的 `gpt-5.5` 接口已经不再返回——
    也就是说这个按钮第一次点就能看出清单漂移。codex 那边只有 `SUB2API_API_KEY`、没有 base url，
    如实报 `no-endpoint`，不会去试公开端点。
  - 本轮：`npm run typecheck` 无输出；`node --test` **750 / 750**（新增
    `tests/provider-models-fetch.test.mjs` 13 条）；`paseo plugin reload` 后 running。
  - **没做的**：「加入 / 全部加入」会写 `~/.paseo/config.json`，这条写路径仍只有 fake 用例，
    界面上也没点过（只验了「问接口」这一段，没验「点一下加进清单」）。
- 用户贴了参考图说「UI 数据太乱」——客户端详情改成**设置面板式的字段行**：
  - 一行一个字段，左边 78px 固定字段名、右边是值：名称 / ID / 接入地址 / 凭据 / 模型 / 高级。
    名称与地址是就地改（点「改」变输入框），凭据逐个键显示掩码 + 显示 / 改。
  - **原始那串环境变量挪进「高级」**（默认收起，逐客户端展开）：`ANTHROPIC_AUTH_TOKEN` /
    `ANTHROPIC_BASE_URL` / 五个 `*_MODEL` 不再摊在默认视图里；「档位」标记与档位说明也留在那里面。
    想改任意键时的注入表单、诊断、安装仍在（诊断/安装是一排小按钮）。
  - 模型区块改成「一排可点的型号」：选中的带 ✓ 与强调色描边（点一下移除），
    接口回来但没加进来的用虚线 `＋` 排在后面；上面一排是「从接口获取 / 全选 / 全不选」，
    下面是「筛选 N 个模型…」输入框（以前只在超过 6 个时出现，现在常驻）。
  - 为了这版界面补了两个服务端字段：`baseUrl`（地址不是机密，直接印原值）与 `credentialKeys`
    （只给键名，值永远掩码），另外 `extends`（站点的基座）。`shared/provider-models.ts` 新增
    `baseUrlOf` / `credentialKeysOf` 两个纯函数。
  - 顺带能改**显示名**了：`deck.orchestration.provider` 增加 `label` 入参，写后读回比对。
  - 清掉三个不再使用的文案键（`orch.envNote` / `orch.envKeys` / `orch.modelAddAll`），
    EN/ZH **457 / 457** 对齐。
  - 顺手修掉一处重复类型：`OrchestrationStateResult.providers` 改成 `ReturnType<typeof providerRows>`，
    以后加字段不会再出现「改了一份漏了另一份」。
  - 真机读数（`readOrchestrationState`，工作区 `wks_7d9f68ca2e4771c3`）确认新字段有值：
    claude → `baseUrl=http://192.168.88.12:8083`、`credentialKeys=[ANTHROPIC_AUTH_TOKEN]`、7 个 env；
    codex → 没有 base url、凭据键 `SUB2API_API_KEY`；其余四家（copilot/opencode/pi/omp）空。
  - 本轮：`npm run typecheck` 退出码 0；`node --test` **763 / 763**；`paseo plugin reload` 后 running，日志 `Plugin ready`。
  - **没做的**：这版界面没在 Paseo 里看过（起不了桌面端）；行高、窄屏下 78px 字段名会不会挤、
    模型芯片在十几二十个时的换行观感，都要用户看一眼。
- 用户要「添加站点」（回「需要」）——做出来了：
  - `shared/provider-site.ts`（纯函数）：`BUILTIN_PROVIDER_IDS`（claude/codex/copilot/opencode/pi/omp，
    照 `protocol/provider-manifest` 抄，加注释说明为什么写死）、`normalizeSiteId`、`siteIdProblem`
    （空 / 形状 / 保留字 `acp` / 撞内置 / 撞已有，各有各的话）、`siteEnvKeyNames`（先抄基座已有的
    `*_BASE_URL` / `*_AUTH_TOKEN|_API_KEY|_TOKEN`，没有再按前缀给默认）、`buildSiteEnv`（空值不写、
    去末尾斜杠）、`siteUrlProblem`、`inheritedEnvKeysOf`。
  - `server/provider-site.ts#createProviderSite`：读配置 → 校验 id/基座/地址 → 写
    `agents.providers[id] = { extends, label?, env }` → **写后读回**（条目在不在、`extends` 对不对、
    env 键值一不一致），每一步失败都是独立原因（`invalid` / `exists` / `unknown-base` / `config-failed`）。
    **撞名一律拒，不合并**：用户以为新建一个站点、实际改掉老站点，代价太大。
  - 提示里主动说出继承：派生站点的 env 是 `{...基座, ...本站点}`，所以会明写「继承基座 N 个 env
    （... ANTHROPIC_MODEL ...）：模型类键会指向基座的模型，各站点模型不同时要单独覆盖」。
    凭据不进提示、不进日志。
  - 新 RPC `deck.orchestration.provider.site`（入参 id/extends/label/baseUrl/credential，
    输出四种失败原因）；`server/rpc/register.ts` 注册。
  - 界面：客户端列表底部「＋ 添加站点」→ 内联表单（id / 显示名 / 基于哪个客户端（页签）/ 地址 / 密钥），
    地址与密钥的**键名原样显示**（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`…），不让用户猜；
    id 边输边判、不合法就禁用「创建站点」。建成后收起表单、自动展开新站点并提示下一步是「从接口获取模型」。
    新增 15 条文案（EN/ZH 449/449 对齐）。
  - 本轮：`npm run typecheck` 退出码 0；`node --test` **763 / 763**（新增 `tests/provider-site.test.mjs` 13 条）；
    派生条目的形状用宿主自己的 `ProviderOverridesSchema` 校验过（`safeParse` 通过）；
    `paseo plugin reload` 后 running，日志 `Plugin ready` 无错误。
  - **没做的**：没有真的在 daemon 上建过站点（那要写 `~/.paseo/config.json`，需要用户点头）；
    所以「新建的站点会不会出现在客户端列表里」只有源码依据（daemon 会把派生 provider 解析进注册表），
    没有实测；界面上的表单也没在 Paseo 里点过。
- 用户提出「新装的客户端没有模型，需要先配链接和密钥再获取模型；而且我们可以配多个站点」——先读宿主源码确认多站点是原生能力：
  - `~/.paseo/config.json` 里 provider 存在 `agents.providers`（**不是**根级 `providers`），形状是
    自由 record：`z.preprocess(normalizeAgentProviders, ProviderOverridesSchema)`。
  - 内置 id 只有 6 个：`claude, codex, copilot, opencode, pi, omp`（`protocol/provider-manifest`）。
  - `server/dist/server/server/agent/provider-registry.js#addDerivedProviders`：**非内置 id + `extends: "<内置id>"`
    就是一个派生的「站点」**，会成为独立的 provider（有自己 id / label / env / 模型列表），
    `derivedFromProviderId` 记着基座。`extends: "acp"` 另开一路（cursor / kimi / kiro / traecli 等任意 ACP 客户端）。
  - env 合并是 `{...base.env, ...override.env}`（`mergeRuntimeSettings`）：**派生站点会继承基座的全部 env**，
    所以基座那五个 `ANTHROPIC_*_MODEL` 会跟着复制过去——各站点模型 id 不同时这是个坑（正好印证用户「不要注入」的方向）。
    命令也是继承（`override.command ?? base.command`），`disallowedTools` 取并集。
  - 模型列表：派生站点用自己那条（`models: override.models ?? []`、`additionalModels: override.additionalModels ?? []`），
    **不继承**基座已声明的清单；`profileModelsAreAdditive: false`。也就是说新站点在我们界面上确实是「0 个模型」，
    必须先注入 base url + 凭据，再「从接口获取模型」——和用户描述的顺序一致。
  - 现状差距：编排页只能在**已有的** provider 上改 env / 模型，**没有「添加站点」入口**。要做的话是在
    `agents.providers` 里新建一条 `{extends, label, env, additionalModels}`，再走现成的获取模型流程。
    这条写路径没实测（写 `~/.paseo/config.json`，要用户点头）。
- 回答「这些东西是干什么用的、给我们的注入有关系吗、模型不是在上面吗」时做的实测与界面补注：
  - 实测（`ps -eo pid,args | grep claude`）：宿主起 CLI 时把选中的模型当**命令行参数**传下去——
    `claude … --model deepseek-v4.1-flash`、`--model deepseek-v4-pro`、`--model group/deepseek`。
    所以「上面的模型清单」决定的是会话实际用哪个模型；`ANTHROPIC_*_MODEL` 那几把键管的是
    Claude Code 自己的**档位解析**（`ANTHROPIC_MODEL` 主模型，`DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`
    是 `/model opus|sonnet|haiku` 落到哪个 id，`SMALL_FAST_MODEL` 是旧的快速模型别名）。
    两层都在我们的注入里，但不是同一件事：清单写的是「这条接口提供什么」，环境键写的是「档位映射到什么」。
    当前五个键都是同一个 `deepseek-v4.1-flash`，等于档位区分没打开。
  - 界面：已注入的键里，`ANTHROPIC_*_MODEL` 这类键后面加一个「档位」小标记，
    并在该节标题下加一行说明（新键 `orch.envModelTag` / `orch.envModelNote`，EN/ZH 433/433 对齐）。
    没有替用户改任何键值——档位怎么分是用户的决定。
  - 本轮：`npm run typecheck` 退出码 0、无 error；`node --test` **750 / 750**；`paseo plugin reload` 后 running。
  - **没做的**：命令行 `--model` 与环境变量谁优先，只有「CLI 显式传了 `--model`」这一条间接证据，
    没做 A/B 实测；新增的标记与说明也没在界面上看过。
- 客户端页重排成「一行一个客户端」（用户说「视觉有点乱，能不能让用户看着直爽一些，而不是密密麻麻」）：
  收起来只有两行——名字（13px 粗体）+「`id` · N 个模型 · N 个密钥」副行，右侧是状态点 + 状态字 + 展开箭头，
  整行可点。模型全名、每个键、注入表单、额外模型表单、诊断 / 安装按钮**全部只在展开后出现**，
  展开区按「模型 / 已注入的键 / 注入环境变量 / 额外模型」分节，节标题是 10px 大写小字。
  一屏能扫完八家客户端；状态色只用一处（点 + 一个词），未启用作为副行尾巴出现，不再单独占一行。
  新增两条计数文案 `orch.modelCount` / `orch.keyCount`（EN/ZH 419/419 对齐）。
  本轮：`npm run typecheck` 无输出；`node --test` **726 / 726**；`paseo plugin reload` 后 running。
  **改版后的观感没有截图可验**：这个环境起不了 Paseo 桌面端，行高、窄屏下副行会不会截断、
  展开后一屏塞不塞得下，都要用户在界面里看一眼。原值显示也没在界面上点过。
- 独立审查（`code-reviewer`，REQUEST_CHANGES）后修掉的一批，全部有对应用例：
  ① 读宿主配置只认磁盘形状，而线上 `config.get().config` 是**根级** `providers` / `agentProfiles`
  → 改为两种形状都认，两处都空时明确告警；再配一道「写后读回条数变少就报错」的护栏，
  防止「读到空 + 整表替换」把宿主档案清空。
  ② 追加模型缺必填的 `label`，且数组补丁是替换语义 → 先读现存条目、保留 `label` / `isDefault` /
  `description` 再追加。
  ③ 存档案会丢宿主的 `icon` / `color` / `featureValues` → 改为以现存条目为底合并。
  ④ 技能草稿无条件覆盖同名文件 → 默认不覆盖，返回 `exists` 并仍给出提示词（正常做法是在已有草稿上继续改），
  要重来必须显式 `overwrite`。
  ⑤ `deck_handoff` 在 `PASEO_AGENT_ID` 为空时能替别人写回传件 → 删掉 `agentId` 入参，没有环境变量直接失败。
  ⑥ 上一回合写的回传件被当成本回合结论重复上报 → 按会话记「上次报出去的 `createdAt`」，更旧就退回时间线并注明。
  ⑦ `turnId` 为空时去重键退化成固定值、之后所有回合永久静默 → 没有 `turnId` 就不去重。
  ⑧ `deck_dispatch_plan` 的 `depth` 缺省 0 → 改必填，不再默认「谁都是第一层」。
  ⑨ 标签里的父会话写「配置的派单窗口」而非实际调用者 → 以 `PASEO_AGENT_ID` 为准，不一致时告警。
  ⑩ 客户端整份保存会互相覆盖 → 改动排队，每次落盘前现读一次再叠加。
  ⑪ 编排文件的 `workspaceId` 从角色反推 → 由界面显式传，清空本工作区角色后不再被改成别的工作区。
  ⑫ 派单 `depth` 被夹到上限 → 超层直接 `depth-exceeded`。
  ⑬ 注入 env 单键提交在落盘时会把其它键整块替换掉 → 每次带上已有的全部键，读不到现有 env 就拒绝写入。
- 第二轮独立复验（`code-reviewer`，REQUEST_CHANGES）又抓到四条**改了但没接上**的问题，已修并补用例：
  ⑭ 保存设置 RPC 的 handler 把 `workspaceId` 丢了（函数支持、客户端也传了，唯一生产路径上等于没修）
  → handler 透传，并新增 `tests/orchestration-rpc.test.mjs` 走 handler 断言落盘的 `workspaceId`；
  之前没有任何 orchestration RPC handler 的用例，所以这条完全隐形。
  ⑮ 首次注入 env 永远失败：把「配置读不到」和「这个客户端还没配过 env」混成一种 → 拆开，
  配置可读但 env 缺失时照写新键；原有的那条「必须 config-failed」用例是把这个缺口钉死的，已改写。
  ⑯ `runDispatch` 把 `unknown-workspace` 压回 `no-dispatcher` → 按计划的拒绝原因分开报；
  顶层契约补上 `unknown-workspace`，另加 `settings-unreadable`（编排文件权限 / IO 错误，
  不是「没配过」），`readOrchestration` 新增 `readFailed` 标记，界面与工具都如实说出来。
  ⑰ `difficultyFromLabels` 的注释自称认「我们真正写出去的 `deck.difficulty=hard`」，但前缀表里
  只有冒号形态，用例名与断言也不一致 → 注释改成实际情况（没有任何代码会自动往票上写难度标签，
  是给人手动打的），冒号 / 等号 / 斜杠三种写法都认，用例按实际形态逐条断言。
- 第三轮复验（同一审查者）又指出三处「接了一半」，已修并补用例：
  保存时 `busy` 覆盖到 `state.refetch()` 完成才解除（此前刷新回来前按钮已可点，连点仍净增 1）；
  技能弹窗在换草稿（`exists` 分支 / 改需求或名字）时清掉上一份草稿的冲突清单
  （否则「覆盖冲突并安装」列一批文件、盖另一批）；`deck_dispatch_plan` 与 `runDispatch` 遇到
  **坏文件**也硬失败（`settings-corrupt`），不再用默认值算出「先加一条工作区角色」这种误导。
- 同轮修掉的不阻断项：档案写后读回改按 id 逐个核对（原来按条数比，宿主带一条畸形档案就每次误报）；
  写后读不到配置时如实说「没法核对」而不是把成功的写入报成失败；回传件缺 `status` / `createdAt` 直接判为
  不可用（原来会渲染「状态：undefined」并让旧件反复当新结论上报）；技能安装的冲突在弹窗里列出来并给
  「覆盖冲突并安装」（原来只弹一句「冲突 2」，界面上没有调用点）；「重置为骨架」显式带上原草稿 slug；
  `overwritten` 不再把「内容本来就等于骨架」报成覆盖；编排写盘的临时文件名加随机后缀；
  计数按钮在保存期间禁用；`orch.saved` 文案改成「下一次派单按这个走」，不再说成「对新会话生效」。
- **没有做的验证**：编排页与技能生成弹窗没在 Paseo 界面里点一遍；没有在真实派单里跑过
  「子会话结束 → 父窗口收到回传」这条链路（只验到纯函数与落盘）；注入 env 与档案的写入只在 fake
  的 `config.get` / `config.patch` 上验过，没有在真实 daemon 上留过一次写入。需要在真机点一次。
- 未提交：本轮改动未 commit / push，等用户确认。

## 已定决策

| 编号 | 决策 |
|---|---|
| D1 | ~~**不预填 Agent 输入框**~~ **已被 P20 取代**：`SessionSheet` 现在写宿主草稿 store 并读回校验，把提示词填进已有 / 新建会话的输入框，不发送；已有草稿先确认再覆盖；宿主没有稳定的目标 DOM 标记，写不进去就复制。`server/session.ts` 的发送 RPC 只作兼容保留 |
| D2 | 先常规卡片，P5 再重画像素风 |
| D3 | 技能随包 + 一键安装按钮，不自动写入 |
| D4 | **会话命名只做创建时规则标题**：`agents.create` 接受 `title`，新建会话按动作与票号截取（不超 60 字符）；已存在的会话没有改名 API，也不做模型摘要。`PaseoWorkspaceHandle.setTitle` 改的是工作区名，不拿来冒充会话名 |
| D5 | 设置页只装**影响行为**的项（后端、刷新间隔、调试日志、更新检查）；界面语言仍跟随 App 语言（SDK `useTranslation`），不做插件自带的语言开关；技能包语言是独立开关，默认跟随 App |
| D6 | **不上架公开注册表**：仓库公开 + tag 可装即止，不提交 `getpaseo/plugins`。理由是不愿为此维护审核往来；`docs/registry-submission.md` 保留为流程备查，`media`、提交表单等事项随之关闭 |
| D8 | **编排配置按工作区落文件（`.deck/orchestration.json`），不进插件设置**：插件 RPC 有 `paseo` 句柄，`deck_*` MCP 工具只有 `workspaceDir`，两边要读同一份就必须在工作区里；同时也避开设置页的 revision 竞态。宿主级的东西（客户端档案、provider env）仍走 `paseo.config` |
| D7 | **容器工作区默认合板，不猜仓库**：直接子目录里的仓库全部显示；`.paseo-deck.json` 只作为默认筛选，不再是范围闸门。任何按票号的详情 / 写操作在多仓库下必须显式带 `repoKey`，缺省即拒绝——猜错的代价是「在 A 仓库关掉 B 仓库的同号票」，比多传一个参数糟得多 |

## 验证缺口

- GitHub 读路径已在本机真实 `gh` 上实测：`readRepoInfo` 返回 `943545721/matt-skills-deck` 的实际字段，
  `deck.issues.list` 也能读到真实仓库（当前 0 张票）。映射、排序、远端解析另有单元测试覆盖。
  写路径（评论 / 建票 / 标签）仍只验到参数与失败分支，没有在真实仓库留下写入。
- P17 的「新建后自动切页签 / 仓库 / 清标签筛选」只验到编译产物与类型，**没有在 Paseo 界面里点一遍**；
  FlatList 会不会保留旧滚动位置、切过去后新票是否真的在首屏，都需要用户实际建一张票确认。
- P18 的新建入口（两张需求卡 / 缺陷四字段 / 复制技能提示词 / 建票中禁止关闭）只验到类型、245 条测试、
  编译产物与提示词原文；**没有在 Paseo 界面里实际点一遍**，剪贴板是否真的写入、toast 是否看得见、
  长表单在窄屏下怎么换行，都需要用户确认。
- MCP 侧同理：协议层与工具入参校验有测试，stdio 冒烟跑通了 `initialize` / `tools/list` / 失败分支，
  但「工具真的读到票」与「钩子真的把服务注入进会话」都还没在联网 + 有远端的环境里验过。
  本仓库工作区没有 git 远端，钩子按设计跳过注入，所以这里只验到了「不注入也不报错」。
- 像素风是纯 RN 样式改造，编译与 reload 都过，但外观**没有截图验证**：
  这个环境里起不了 Paseo 桌面端窗口。P13 之后设计值不再自配：色板在 `pixelTokens.ts`、
  组件几何在 `pixel.tsx`，两者分别对应原版的令牌与类名。棋盘底用一张 16×16 的 PNG
  （8px 一格，内嵌 data URI），因为 RN 没有 `repeating-conic-gradient`；
  宿主 `Markdown` 的字色不归插件管，正文单独垫一块宿主底色的纸，不假装能把它也改成墨色。
  P14 又把「每个控件一圈 3px 边框 + 硬投影」收敛成 1px 细线 + 页签，仓库详情块也是纯布局改动；
  同样只验到编译产物与真实数据，**没有截图**，顶栏在窄屏下会不会挤成三行需要人看一眼。
- 子目录选择链路只验到「只读扫描 + 临时目录写入」：本机容器工作区实测能列出 4 个真实候选，
  但**没有在真实容器目录里点选择条**（点了会在 `/www/wwwroot/game.kxhyapp.com` 生成 `.paseo-deck.json`，
  这一步留给你操作并确认）。选择条在窄屏下的换行也没有截图。
- P16 合板只验到「临时目录 + 假 gh + 真实只读目录」：同号票、单仓库失败、详情 / 写路由、MCP `repo` 过滤、
  筛选条不再随筛选消失、标签页选仓库都有用例；真实容器目录只做了只读的仓库全集解析。
  **没有在真实多仓库目录里点筛选条，也没有对任何真实仓库执行写操作。** 筛选条与标签页仓库选择在窄屏下
  会不会挤成两行、卡片只读徽标与「全部仓库」标题的实际观感，仍需人在 Paseo 里看一眼。
- **P19 复审后仍存的验证缺口**：GitHub dedupe / GitLab 复用已有票时 `deck_issue_create` 的 `applied`
  分支只有本地 `.scratch` 用例（两种后端的底层复用各有单元测试，但工具层的标记组合没钉住）；
  `messageId` 重试是纯客户端 ref，没有测试；**真实 GitHub / GitLab 仓库写入、Paseo 界面点击
  （任务板 / 票面 / SessionSheet / 检查页）、设置页加载态都没有实测**。真实远端写入与界面点击需要你授权 / 操作。
- **A1–A26 已逐项落地**：已有 15、已有 + 换面 7、换面 2（A21 / A24）、部分 2（A20 / A22）、
  未做 0。A14 的五个未接线动作（wizard / form / setupRun / ensureLabels / glabAuthLogin）
  与 A17 的 `git worktree list` 多工作树一览已补齐：检查页六种动作类型全接线
  （`CheckActionModal` 通用表单/向导 + `checksPrompts` DSH 原文拼装 + `deck.publish.run`
  真建仓），版本页有 worktree 列表（当前树标注、状态徽标）。剩余差异是宿主边界
  （全局状态栏 / 全局横幅、打开日志目录、插件安装 API、已有会话改名）、发布 dry-run
  计划路线（确认令牌）与 A15 不自动搬数据；逐项说明见 `docs/port-diff.md`。
- P19 的 `SessionSheet` / 台账 / 原生座位只验到单元测试与 bundle 产物：**没有在 Paseo 界面里点过胶囊、
  页头、助手面板**，没有验证发送后目标会话是否真的收到；台账作用域、损坏恢复、忙碌确认都只有单测。
- **P20 的输入框预填只验到纯函数与模拟 store**：草稿 store 模块号 3598、key 形状、
  `saveDraftInput` / `editDraftText` 语义、以及 `host.id = installation.serverId`
  已在 0.13.2 的 Web bundle 里核对，但没有在真实 Paseo 客户端里打开会话确认输入框出现文字；
  创建快照的 `accepted` 预留 id / `failed` 带 `agent` 与否只在 daemon 源码与纯函数测试里核对过，
  没有在真实失败场景下走一遍。0.13.2 的 composer 没有可定位目标的稳定 DOM 标记，所以不做 DOM 兜底，
  写不进去就复制。
  `plugin ls running` 不代表客户端 bundle 能加载，仍以设置页无红字为准。
- **P21 的编排页与技能生成弹窗只验到类型、单测与 stdio 冒烟**：`deck_dispatch_plan` 在真实 MCP 进程里
  跑通（17 个工具、按难度分流、借用路由有 `warnings`），但编排页五个分区、客户端 env 注入的
  `TextInput`、技能骨架弹窗**没有在 Paseo 界面里点过一次**；「子会话结束 → 回传父会话」这条链路
  只验到纯函数（`renderTurnReport`）与钩子接线，没有真的派一个子会话跑完。
  界面外观仍以设置页无红字 + 人工点一遍为准。
- P19 的检查页只验到目录、状态机、组件类型与 bundle 产物：16 项在真实 daemon 上是否都取到正确读数，
  以及已接线的五个动作（publish 向导 / backend-picker / setupRun 布局门 / ensureLabels /
  glabAuthLogin 注入）在真实界面里的交互，需要人在设置页与助手面板里看一遍。
- 发布已有执行段：`deck.publish.run` 由检查页发布向导触发，真建仓与推送（plan / confirm
  仍是 dry-run 路线）；真实建仓没有跑过——会写用户的 GitHub 账号，需要你明确授权才验。
- 设置页加载期校验仍要人确认：`plugin ls` 显示 running **不等于**客户端 bundle 能加载；以设置里
  插件卡片是否出现红字为准（此前两道加载期校验就是这样暴露的）。
- 多后端只验到「本地 Markdown 真实读写 + GitHub / GitLab 的参数、闸门与失败分支」：本地后端有 13 条用例，
  真实 `.deck/` 文件在测试里落盘并回读；GitLab 的读写用假 `glab` 验了 argv、权限闸门、写后读回与
  「没写入 / 可能已写入」分类，**没有在真实 GitLab 项目上写入**；GitHub / GitLab 联网读写仍需在登录态环境跑一次。
- 客户端新增设置页与初始化引导后，**外观与加载期校验只验到编译与翻译表测试**；需要在 Paseo 设置里
  确认插件卡片显示「运行中」，再打开设置页与诊断页各点一遍。
- gh 失败的边角：无效/过期 token（`Bad credentials` 401）仍归 `gh-failed`，详情行能看出原因；
  标签批量改色中途掉登录时，已成功的条目不会回显（PATCH 幂等，重试可收敛）；
  企业代理 407 已正确归为 `gh-failed`，但评论会走「可能已写入」的保守提示（不重发，安全方向）。
  真实代理 407 下的完整 `postComment` 没有实测，本机只验了真实 gh 的 stderr 文本与分类结果。
  顶栏渲染与 `getIssueHandler` 失败带 repo 没有客户端/单测覆盖（仓库无客户端测试设施）。
- P2 没有整份搬运源仓库 `src/tracker`（147 文件 / 2.9 万行）。只迁移了与读路径相关的语义：
  远端解析、票面映射、排序口径、地图标签 `wayfinder:map`。其余（本地 Markdown 后端、绑定与切换、
  三后端抽象）在 P3/P4 按需搬运，避免先造抽象再用它。

## 已知硬约束

- Paseo 无常驻右侧栏、无全局状态栏 → 面板落工作区标签页。输入框胶囊与页头按钮可以动态注册：
  按 `paseo.agents.list({subscribe})` 给每个 agent 注册胶囊、按 `workspaces.list` 给每个 workspace 注册页头；
  没有全局汇总条，也不要假设在 `contribute()` 时能同步拿到列表。
- 客户端无任意网络、无 DOM → 图片走内嵌 data URL；样式只用 RN 原语。
  原版 `PixelStyles.ts` 的 DOM/CSS 组件不能直接 import（`div` / `window` / CSS 类名都不存在），
  要复用的是**设计值与结构**，不是那份 CSS 文本；纸面色板固定取自 `pixelTokens.ts`，不再跟随宿主 accent。
- 插件 API 处于实验期 → `requirements.paseo` 钉 `>=0.13.0 <0.14.0`。
- 服务端无沙箱 → 命令白名单只放 `gh` / `git` / `glab`；`glab` 用于读接口、写接口与 `auth status`，
  写前必须过 `checkGitLabWritable`（至少 Reporter），路径必须落在工作区内。
- 本地后端读写只落在 `.deck/` 或已有 `.scratch/` 工作单元；旧布局根 `issues/` 与 `.scratch/issues/`
  只读，不自动迁移。文件名由票号 / 标题生成，不接受外部传入的文件名；目录不是链接、不跟随符号链接。
- 写路径统一走 `resolveWritableBackend`：GitHub、GitLab、本地都可写；GitLab 的权限由每次写前的闸门判断，
  不要在工具或 RPC 里另开旁路。
- `PaseoAgentHandle` 没有改名方法；新建会话只能通过 `agents.create` 的 `title` 在创建时命名，
  `PaseoWorkspaceHandle.setTitle` 改的是工作区名而不是会话名——不要拿它冒充会话改名。
- 台账作用域必须显式：`agentId: null` 表示 workspace，省略才回退 `PASEO_AGENT_ID`；读取分
  idle / empty / unreadable / ok 四态，不能把读失败说成「没有在办」。
- `SessionSheet` 只把提示词填进聊天输入框，不发送；写宿主草稿 store 后必须读回文本，
  目标已有非空草稿时先提示、确认后才覆盖。宿主没有能定位目标会话的稳定 DOM 标记，
  写不进去就复制提示词，不按可见输入框猜。草稿 key 的 serverId 只能取界面 props 的
  `host.id`；`PluginClientContext` 没有 serverId，从 client 上读会得到空串并让每次预填都失败。
  新建会话必须走 `workspaces.ref(workspaceId).agents.create`：裸 `agents.create({cwd})`
  按目录选工作区，同目录有多个工作区时会落到另一个（实测 `wks_7d9f…` 与 `wks_fdf…`）。
  `server/session.ts` 的发送 RPC 只作兼容保留，界面不调用。
- `server/publish.ts` 只生成计划 / argv / dry-run 与确认令牌，**绝不执行 `git` 或 `gh`**；
  以后接执行段时要另过审查。
- 判 `gh` 失败只认 **stderr + 退出码**：退出码 4（或 stderr 里 gh 自己说 `gh auth login` /
  `not logged into any GitHub hosts`）才是「没登录」。**不要拿 `error.message` 做关键词匹配**——
  execFile 的 message 拼着完整 argv，评论正文、标签名都在里面，会把用户内容当成失败原因
  （超时 + 正文写「gh auth login」会绕过「评论可能已写入」的保护）；也别加泛化的
  `authentication required`，企业代理的 407 就是这句话。统一入口在 `server/tracker/gh-error.ts`。
- RPC 方法名只能是小写：校验正则是 `^[a-z][a-z0-9._-]*$`，写成 `deck.issues.setLabels` 会让整个插件
  加载失败（报 `Invalid plugin RPC method`，且 `plugin reload` 也一起失败）。所以改成 `deck.issues.labels.replace`。
- 面的 id（工作区面板 / 整页 / 侧栏行）走 `^[a-z][a-z0-9-]*$`，**不允许点号**：写成 `deck.board` 报
  `Invalid workspace panel id`，整个插件在界面上显示「失败」。跟上面 RPC 方法名不是一套规则，别互相套用；
  三个 id 已抽到 `client/deck/ids.ts`，改名前先看 `tests/ids.test.mjs`。
- 文案键不能叫 `prototype` / `constructor` / `__proto__`，也不能含点号：SDK 的 `flatten` 在**任意层级**检查，
  命中即抛，客户端面板根本加载不起来。要表达「原型」时键名用 `prototypeKind` 这类写法。
- 服务端相对导入一律写 `.ts` 扩展名：测试直接用 `node --test` 跑 TypeScript（Node 自带类型剥离），
  不带扩展名会在测试阶段报 `ERR_MODULE_NOT_FOUND`，而 tsc 不报。`allowImportingTsExtensions` 已开。
- 插件运行时的自身目录只能从 `$PASEO_HOME/config.json` 读（实测 `import.meta` 为空、cwd 为 `/`）。
- 给 Agent 挂工具只能走 `before agent.create`：钩子入参被 `.strict()` 重新校验，只能回 `config` 与 `env`，
  **改 `config.cwd` 会被拒**。`mcpServers` 服务名 `paseo` 是保留名；`toolPolicy.preapproved` 里的
  `{kind:"mcp",server,tool}` 会被映射成 Claude 的 `allowedTools: ["mcp__<server>__<tool>"]`（自动放行），
  因此名单里的工具必须真的存在，写错名字不会报错、只会静默变成每次都要确认。
- 注入的 MCP 进程用 `process.execPath` 直接跑 `server/mcp/main.ts`：Node 22.18+ 默认剥离类型，
  不必另找解释器、也不必预先编译出 `.js`。注入前会自检 `process.features.typescript` 与入口文件是否存在，
  不满足就跳过注入并在日志里说明原因——不挂一个每次开会话都起不来的服务。
- MCP 服务名固定为 `matt-skills-deck`：`toolPolicy.preapproved` 按「服务名 + 工具名」映射到 Claude 的
  `allowedTools`，所以用户不能在工作区里自建同名服务（会被插件的注入覆盖）。
- 回包一律等 stdout 写入回调再返回，退出用 `process.exitCode`：`process.exit()` 会砍掉仍在管道里排队的字节，
  大于 64KB 的回包（长票 + 多条长评论）会被截成半截 JSON。
- 子会话收尾回传只能用 `agent.turn_ended` 钩子 + `paseo.agents.ref(parent).send(text, {activeTurnBehavior:"steer"})`：
  `send` 的默认行为是**打断父会话当前回合**，回传一份报告不该把主窗口说到一半的话切断；钩子入参里的
  `timeline` 已标注「永远是空数组」，要内容必须自己 `timeline.refetch({direction:"tail", limit:20})`。
- 宿主对 `agents.providers.<id>` 的补丁是深合并（`undefined` 跳过、`null` 写成 null）：**删不掉已注入的键**。
  界面只提供「新增 / 覆盖一个键」，不假装能删。
- `deck_*` MCP 工具拿不到 `paseo` 句柄，也就拿不到 `config.get()`：客户端档案要从
  `<PASEO_HOME>/config.json` 直读 `daemon.agentProfiles`；写仍然只走插件 RPC，两个进程同时写同一份宿主配置会互相覆盖。
- 角色绑定按 `workspaceId` 索引，而 MCP 侧只有 `workspaceDir`：`.deck/orchestration.json` 里要一并记下
  `workspaceId`（保存设置时从唯一角色推导），否则工具端只能猜。
- 难度路由**一定会兜底**：`resolveRoute` 退到 `normal`，再退到内置默认目标。兜底可以接受（否则四档全空时
  派单开箱即废），但必须被标出来——`routeFromOf` → `DispatchTask.routeFrom` → 工具 `warnings` / 页面路由行。
  别再写成「没配置就拒绝派单」：那是文档曾经的错误说法，`critical` 悄悄跑在 `normal` 的模型上才是真实风险。

## 2026-10-29 站点池：多接入地址 + 多凭证轮询

用户问「怎么加多个接入地址和凭证进行轮询」，要求直接做成插件能力。

**先量清楚宿主的边界**（都在宿主机上实测）：

- `config.json` 里每个 provider 条目只有一个 `env` 对象，`ANTHROPIC_BASE_URL` 是单个字符串——**一个条目一个地址**；
- 协议 schema `MutableDaemonConfigSchema.providers` 是 `Record<string, {...}>`，没有端点列表字段；
- 在 daemon 的 `server` 目录 grep `roundRobin|round-robin|loadBalanc|failover`：**零命中**，宿主没有轮询/故障转移；
- 会话 env 的合并顺序（`provider-launch-config.js#collectProviderEnvOverlays`）：`process.env` → provider `env` → 本次会话 `env`（`create_agent_request.env` 是 overlay，能盖掉 provider 的地址与凭证）；
- 我们自己的路由是按难度四档静态指派，本来也不轮询。

**做出来的东西**（插件侧，不碰宿主轮询语义）：

- `shared/orchestration.ts`：`SitePool { id, label?, members: ClientTarget[] }`；设置里加 `pools` 与
  `poolCursors`（游标和池子必须同文件同读同写，分两处会出现「池子改了、游标指着第 5 位」）；
  `clampCursor` / `pickPoolMember` / `poolOf` / `withPool` / `withoutPool`；`planDispatch` 支持 `poolId`，
  返回 `poolCursors`（只含本批真正用到的池子，被拒的任务不推进游标）。
- 池子优先于 `target`：规则同时挂着两者时按池子走，否则等于悄悄取消轮询。
- `server/orchestration.ts#runDispatch`：从游标开始逐个成员试，**建失败就换下一个**；每尝试一次推进一格
  （失败的站点跳过这一轮）；幂等键按尝试分叉成 `<key>-r<n>`（同键重试会被宿主回放第一次的结果，故障转移就是假的）；
  整组失败时把 `attempted` 带回结果；批末把游标写回 `.deck/orchestration.json`，写不进去只告警不假装成功。
- 状态页多给 `pools` 行（成员在不在宿主、模型有没有声明、这一轮轮到谁、哪几档在用）。
- 客户端：路由页顶部新增「站点池」（建/删/成员多选/共用模型），每档难度多一个「用站点池」；
  MCP `deck_dispatch_plan` 也按游标预览，并明确警告「游标只有插件自己建会话时才推进」。

**验证**：`npm run typecheck` 退出 0；`node --test` **778 / 778**（新增 `tests/pool.test.mjs` 15 条，
含真跑 `runDispatch` 的轮换 / 故障转移 / 游标落盘 / 幂等键分叉）；`paseo plugin reload` → `Plugin ready`。

**没验证的**：新 UI 没在 Paseo 里点过；没有真在工作区里建池子派单（那要真起会话）；
「哪些调用方走 `deck.orchestration.dispatch`」决定了轮询实际会不会发生——MCP 只是计划，自己建会话不推进游标。

## 2026-10-29 「加地址」的入口挪到第一屏

用户反馈「我怎么没看到效果」。实测下来功能在、包也在，**是入口埋没了**：

- 用宿主自己的 `compilePlugin` 编客户端 bundle（850,937 字节）后逐串核对：`orch.pool.title` /
  `orch.route.pickPool` / `onSavePool` 都在包里。注意 esbuild 把中文表转成 `\uXXXX`（大写十六进制），
  直接拿中文 grep bundle 会误判成「没进包」。
- `~/.paseo/config.json` 的 `agents.providers` 只有 `claude` / `codex` 两条，**没有任何派生站点**；
  `.deck/orchestration.json` 里 `routing: []`、没有 `pools` 键，`updatedAt` 早于本次改码。
  也就是：池子必然是空的，四档也挂不上池子。
- 「＋ 添加站点」原本在客户端列表**最底下**（ghost + mini），一个页面滚到底才看得见 ≈ 没有。

改法：

- `ClientsPanel` 顶部加一行：一句说明（一个条目 = 一个地址 + 一份凭证，要多个就一个站点一条，
  之后到「路由」编成池子轮流）+「＋ 添加站点」；表单也在顶部展开，底部那套删掉，不留两份入口。
- 建站点时地址与密钥都是这一步填的，所以**建完顺手问一次 `/v1/models` 并声明**（`onFetchModels` →
  `onSaveModel`），失败只提示不撤销站点。省掉的正是那个坑：站点建了但零模型，轮询永远轮不到它。

**验证**：`npm run typecheck` 退出 0；`npm test` 778 / 778；`paseo plugin reload` → `Plugin ready`；
重编 bundle（852,891 字节）确认含 `orch.siteLead` / `orch.siteCreatedModels` 与中文值。

**没验证的**：界面仍没在 Paseo 里点过；没有真建站点走一遍自动取模型（那会写宿主 `config.json`）。

## 2026-10-29 重构：站点归到客户端下面（平级池子作废）

用户指正：**「不是客户端轮询，而是客户端下的站点轮询」**。上一版把每个站点做成一个平级的派生客户端
（`claude-site1` / `claude-site2`），再在外面套一层「站点池」——概念层级是错的：

- 客户端列表被站点撑开，`claude` 一会儿在、一会儿变成三条；
- 每个站点都要单独声明一遍模型（宿主不继承派生条目的模型清单）；
- 「池子」是第三种概念，用户还得理解它跟客户端什么关系。

**改成：站点是客户端自己的属性。** 派单落到某个客户端时，在它的站点之间轮流，只把地址与凭证注入
**那一次会话**的 `env`（`agents.create({ env })` 覆盖 provider env，daemon dist 里已验证）。
所以：加站点不用重建客户端、不用重新声明模型、也不用回路由页改四条规则。

动了什么：

- 新增 `shared/sites.ts`（纯函数：游标、取站点、id/地址校验、注入键、env、落盘归一化、增删改）
  与 `server/sites-store.ts`（`<PASEO_HOME>/matt-skills-deck/sites.json`，0600、临时文件 + rename、
  进程内串行写）。凭证不进工作区（`.deck/` 被 git 跟踪）。
- `shared/orchestration.ts`：删掉 `pools` / `poolCursors` / `rule.poolId`；`DispatchTask.siteId`、
  `DispatchPlan.siteCursors`；`planDispatch` 按客户端游标取站点。
- `server/orchestration.ts`：状态里的站点并进 provider 行（`sites` / `siteCursor` / `siteNext`），
  `runDispatch` 每尝试一次推进一格（失败也推进），批末把游标合并写回；站点文件读不出来**拒绝派单**，
  不静默退回客户端默认地址。新增 `saveClientSite`（加/改/删，改地址时凭证留空即沿用）。
- RPC：`deck.orchestration.provider.site` → `deck.orchestration.site`（`{provider, site?, removeId?}`）；
  删除 `providerRowSchema` 之外的多余池子 schema。
- 客户端：路由页删掉「站点池」卡片与「用站点池」chips；站点列表挪进每张客户端卡片里
  （`站点` 一行：`名字 · id` / 地址 / 掩码凭证 / 「这一轮」/ 改 / 删，下面是「＋ 添加站点」内联表单）。
- 删除 `shared/provider-site.ts`、`server/provider-site.ts`、`SiteForm.tsx`、
  `tests/provider-site.test.mjs`、`tests/pool.test.mjs`。

**验证**：`npm run typecheck` 两个 tsconfig 均退出 0；`npm test` **773 / 773**
（新的 `tests/sites.test.mjs` 23 条：纯函数、计划层轮换、真跑 `runDispatch` 的 env 注入 / 轮换 /
故障转移 / 游标落盘 / 坏文件拒绝 / 0600）；`paseo plugin reload matt-skills-deck` → `running`；
用宿主自己的 `compilePlugin` 重编（client 837,409 / server 795,939 字节）后按大写 `\uXXXX` 核对：
新中文串（「还没有站点…」「站点不是另一个客户端…」「这一轮从…」）在包内，旧的「站点池」串已不在。

**没验证的**：界面没在 Paseo 里点过（`plugin ls running` 只证明服务端活着）；没有真起会话验证
「会话 env 覆盖 provider env」的端到端行为（daemon 源码路径是结构证据，不是实测）；站点轮换只在
插件自己建会话（`deck.orchestration.dispatch`）时发生，MCP `deck_dispatch_plan` 仍只是预览。

## 2026-10-29 站点按难度分流（「某些站点只在某些难度用」）

用户要求补上这一层：一个客户端下的站点可以**只接某几档难度**（便宜站接 trivial/normal、
强站只接 hard/critical 这类额度分配）。

- `shared/sites.ts`：`Site.difficulties?: Difficulty[]`（空/未设 = 不挑）；`coversDifficulty`、
  `hasSiteFor`、`normalizeDifficulties`；`pickSite(entry, cursor, difficulty)` 从游标往后找
  **第一个接这一档**的站点，下一个位置按整张表算——只用一个游标，不用给每档再乘一份。
- 计划层 `planDispatch`：按任务难度取站点；客户端配了站点但没一个接这一档时**不拒绝**，
  标 `siteFallback: "uncovered"`（走客户端自己的地址），MCP 预览会把它写进 warnings。
- 派单 `runDispatch`：同语义，回落时 env 不注入、游标不动，并在结果 warnings 里
  「`provider` 下的站点都没接 `hard`：这一批里该难度的活用的是客户端自己的地址」（按客户端+难度去重）。
- 状态页：站点行带 `difficulties`；某客户端有站点却没覆盖某几档时直接给警告；
  `siteNext` 语义改为「游标起点」（真正落到哪个还要看难度）。
- 存站点：`difficulties` **省略 = 保留原值**（只改地址不会顺手清掉限制），传空数组 = 明确清成所有难度；
  不认识的值直接 `invalid`，不静默丢弃。
- 客户端：站点表单加四个难度 chips（一个不勾 = 所有难度），列表行显示 `所有难度` 或 `normal · hard`。

**验证**：`npm run typecheck` 退出 0；`npm test` **780 / 780**（`tests/sites.test.mjs` 30 条，
新增按难度取站、按难度分流派单、回落警告且游标不动、省略保留 / 空数组清除 / 非法难度拒绝）；
`paseo plugin reload` → `running`；重编 bundle（client 839,869 / server 799,614 字节）核对新串在包内。

**没验证的**：界面没在 Paseo 里点过；没真起会话跑一遍「不同难度落到不同站点」（端到端要真建会话）。

## 2026-10-29 移除「客户端下的站点 / 轮换」整块功能

用户结论：「这样不太合适，这个功能直接移除吧」。缘由是这条链路根本没有触发点，也没有宿主支持：

- 宿主的 `agents.providers.<id>.env` 是**一个客户端一份**，没有轮询 / 故障转移；插件改 env 走
  `paseo.config.patch`，写的是 `~/.paseo/config.json`，对这个客户端的**所有**会话生效。
- 会话级 `env` 覆盖只在插件自己建会话（`deck.orchestration.dispatch`）时可用，而**界面上没有任何
  入口会调它**，MCP 侧 `deck_dispatch_plan` 只出预览——所以「配两个站点就会轮着用」在实际使用里
  不可能发生（这一点是用户追问「我配置两个，是不是用 claude 就会轮询这两个站的」时查出来的）。

**删掉的东西**

- `shared/sites.ts`、`server/sites-store.ts`（`<PASEO_HOME>/matt-skills-deck/sites.json`）、`tests/sites.test.mjs`（30 条）。
- RPC `deck.orchestration.site`（`orchestrationSiteRpc` / `orchestrationSiteHandler` / 注册条目）；
  `providerRowSchema` 去掉 `sites` / `siteCursor` / `siteNext`，派单结果去掉 `siteSpec` / `attempted`。
- 计划层 `planDispatch`：去掉 `sites` / `siteCursors` 入参、`DispatchTask.siteId` / `siteFallback`、
  `pickSite` 与游标推进；`runDispatch` 回到「一条任务建一次会话」，不再按站点重试、不再注入 env、
  不再落盘游标、不再有「站点文件读不出来就拒绝派单」这条。
- MCP `deck_dispatch_plan`：清单里的 `siteId` 与两条站点警告一并去掉。
- 客户端：`ClientsPanel` 的「站点」一行（列表 / 内联表单 / 难度 chips / 改删按钮 / 相关状态）整块删除，
  `OrchestrationView` 去掉 `siteRpc` 与 `onSaveSite`，`RoutingPanel` 客户端 chip 去掉 ` · n` 后缀，
  `panelText` 删 16 个 `orch.site*` 键（中英各一份），`types.ts` 去掉 `SiteRow`。
- `envKeysFor` 不是站点专属（「地址/凭据写在哪两个键上」客户端自己也要用），从 `shared/sites.ts`
  挪进新的 `shared/provider-env.ts`，`ClientsPanel` 改从那里取。
- `extends` / `派生客户端` 保留：那是宿主原生能力（非内置 id + `extends` 建一个独立 provider），
  文案键 `orch.siteOf` 随之改名 `orch.extendsOf`（`extends {provider}` / `基于 {provider}`）。

**验证**：`npm run typecheck` 两个 tsconfig 均退出 0；`npm test` **750 / 750**
（780 − 30 条站点用例）；`paseo plugin reload matt-skills-deck` → `running`；
用宿主自己的 `compilePlugin` 重编（client 831,457 / server 783,489 字节）后核对：
「站点」「sites.json」「orchestration.site」「siteSpec」「saveClientSite」「轮换」「保存站点」
在两份产物里**一处都不剩**（正向对照：`派单窗口`、`每一档难度…` 仍在包内，说明检索口径有效）。

**没验证的**：界面没在 Paseo 里点过（`plugin ls running` 只证明服务端活着）；改动未提交（用户没点头）。

## 2026-10-29 站点加回来：能继续添加 + 一个「启用」

用户要求：「我们需要能够继续添加」，并且「加一个启用，启用就是使用这个站点的」。
问清了两处语义（用户选定）：
1. 启用 = **写进客户端自己的配置**（`agents.providers.<client>.env`），这个客户端的**新会话**都走它；
2. 同一时刻**只能启用一条**。

与上一版轮询的区别：没有游标、没有故障转移、也没有难度分流——宿主本来就一个客户端一份地址，
所以「启用哪条」是显式动作，不是自动轮换。

- `shared/sites.ts`（重写，去掉游标与难度）：`Site { id, label?, baseUrl, credential }`、
  `SiteBook`（`providers → Site[]`）、`normalizeSiteId` / `siteIdProblem` / `normalizeBaseUrl` /
  `siteUrlProblem`（只认 http/https）、`withSite`（同 id 覆盖、位置不变）、`withoutSite`（删到最后一条
  就整条拿掉）、`normalizeBook`（坏条目逐个丢、数得出来）、`enabledSiteOf`。
- **「现在生效的是哪条」不另存开关**：`enabledSiteOf` 拿宿主配置里的地址与凭证去比对——
  地址一致且（站点没存凭证，或凭证与宿主一致）才算生效。另存一份状态必然漂移
  （用户在 Paseo 里手改地址后，界面还在说「启用的就是这条」）。地址一样、凭证不一样时**不标生效**：
  会话用的是另一把钥匙，标成「就是这条」是骗人。
- `server/sites-store.ts`：`<PASEO_HOME>/matt-skills-deck/sites.json`，临时文件 + rename、0600、
  进程内写路线串行；坏文件报错而不当空表。
- `server/orchestration.ts#saveClientSite(paseo, {provider, site?, removeId?, enableId?})`：
  加/改只落盘；**启用**走 `patchProviderConfig`，只写两个键（地址 + 有才写的凭证），
  且照 `patchProviderConfig` 的老规矩带上该客户端已有的全部 env（宿主落盘时 env 整块替换）；
  凭证留空 = 只换地址，客户端原有的凭证保留。删站**不动宿主配置**，并在 warnings 里说明
  「宿主里还是原来那条」。返回的行一律掩码。
- RPC：`deck.orchestration.site`（`{provider, site?, removeId?, enableId?}`）；状态页 provider 行
  多带 `sites` 与 `enabledSiteId`（`providerStateRowSchema`，客户端类型从它反推）。
- 客户端：客户端卡片「模型」下面多一行「站点」——一条一行（`名字 · id` / 地址 / 掩码凭证），
  生效那条标「当前启用」、其余带「启用」按钮，右边「改 / 删」，底部「＋ 添加」内联表单
  （id / 名字 / 地址 / 凭证），说明文案写明「新会话生效、已开的会话不追溯」。
- 文案：中英各 13 个 `orch.site*` 键（`panelText`）。

**验证**：`npm run typecheck` 两个 tsconfig 均退出 0；`npm test` **764 / 764**
（新增 `tests/sites.test.mjs` 14 条：id/地址校验、加删不可变、`enabledSiteOf` 四种匹配、
坏文件报错、0600 与并发写、加站不动宿主、启用只写两个键且保留其它 env、换站、凭证缺省沿用、
删站不回写、首次给没有配置条目的客户端启用会建出条目、三种拒绝）；
`paseo plugin reload matt-skills-deck` → `running`；重编产物（client 838,221 / server 791,628 字节）里
「当前启用」「deck.orchestration.site」「enabledSiteId」都在。

**没验证的**：界面没在 Paseo 里点过（`plugin ls running` 只证明服务端活着），所以「启用之后
这个客户端的新会话真的换了地址」没有端到端实测——依据是宿主 `collectProviderEnvOverlays` 的合并路径
（结构证据）；改动未提交。

## 2026-10-29 技能安装：范围 × 客户端，状态按客户端分开报

起因：用户问「这些技能能用了吗，怎么感觉只能用 claude 的」，随后指出「不能绑定客户端、也不能只项目级吧」。

先查清事实（都在本机实测，不是推测）：

- 我们的安装只写工作区 `.claude/skills` + `.agents/skills`，**「已安装」是一个合体判断**（两处都 current 才算），
  所以界面根本看不出哪个客户端读得到。
- Claude：宿主启动 claude 时传 `settingSources: ["user","project","local"]`
  （`providers/claude/agent.js:44`），项目级 `.claude/skills` 会被加载。
- Codex：`codex debug prompt-input`（不花模型额度）实测技能根表，工作区有 `r0`/`r1`
  两处家目录根、`<cwd>/.agents/skills` 也在——**`.agents/skills` 就是它认的目录**，
  用户级 `~/.agents/skills` 与它自家的 `~/.codex/skills` 同样认。（原先打算补一个 `.codex/skills`
  安装根，实测后确认不需要。）
- ACP 那几家（copilot / cursor / kimi / kiro / trae / opencode）：宿主 daemon 里
  `skill` 命中 0 次，**找不到任何读取证据**，只能算未验证，不给它们编目录。

改法：技能装到哪儿 = **范围**（本工作区 / 本机全局）× **客户端**（Claude / Codex）两个正交选项。
用户选定：默认本工作区（全局必须显式切）；全局时 Codex 只写 `~/.agents/skills`，不掺 `~/.codex/skills`。

- `server/skills/install.ts`：`SKILL_CLIENT_ROOT`（claude→`.claude/skills`、codex→`.agents/skills`）、
  `skillRoots({scope, clients, workspaceDir, homeDir})`（范围不合法就抛错；**明确传空客户端数组就报错**，
  不悄悄回落成「全装」）、`skillStateAt`（单目录状态）、`skillState`（保留工作区两处合体的旧语义）、
  `installSkills`（默认仍是工作区 + 两边都写，旧调用点不用改）、新增 `removeSkills`。
- 卸载只删**内容与内置源完全一致**的那一份：人改过的、别处装的，原样留着并报 `kept`；
  删完 `rmdir` 顺手收掉空技能目录，目录里还有别人的文件就留着。
- RPC：`skillsListRpc` 改成按客户端报 `states[]` 并返回真实 `roots[]`（界面不再写死目录字符串）；
  `skillsInstallRpc` 加 `scope` / `clients`；新增 `skillsRemoveRpc`（`deck.skills.remove`）。
- 界面（`SkillsView`）：第二行是范围页签（本工作区 / 本机全局）+ 客户端勾选（Claude / Codex），
  勾哪个就只动哪个目录；每行状态拆成 `Claude 已安装` / `Codex 未安装` 两个小标记；
  顶部提示由 `roots` 实际路径拼出，全局模式多一行「落在主目录，所有工作区都带着」；
  卸载要按两下（第一下只变成「确认卸载 N 个」，5 秒自动退回），详情页也有单个卸载。
- 文案：中英各 11 个 `skills.*` 键；`skills.hint` 从 `{{a}}/{{b}}` 改成 `{{dirs}}`。

**验证**：`npm run typecheck` 两个 tsconfig 退出 0；`npm test` **774 / 774**
（新增 `tests/skills-scope.test.mjs` 10 条：目录矩阵、范围非法报错、空客户端报错、全局安装不碰工作区、
只勾一个客户端不建另一个目录、逐目录状态、卸载只删一致的那份、missing、目录非空留着、全局卸载不碰工作区、
同名不同内容算冲突）；`paseo plugin reload matt-skills-deck` → `running`、日志 `Plugin ready`；
重编产物（client 845,560 / server 795,204 字节）里「本机全局」「至少勾一个客户端」「deck.skills.remove」都在。

**没验证的**：界面没在 Paseo 里点过（`plugin ls running` 只证明服务端活着）；全局安装后
「别的仓库的新会话真的能用上」没做端到端实测——依据是 codex 技能根表的实测输出与 Claude 的
`settingSources` 结构；ACP 客户端仍是未验证。改动未提交。

**追加（同日，用户纠正后简化）**：上面那版给了「范围 + 客户端」两个选择题，用户一句
「我们不是给项目绑定的，你还弄那么复杂干什么」把它推翻了。改成只有一个行为：

- 技能只装**用户级**两个目录（`~/.claude/skills`、`~/.agents/skills`），两个都由程序一起写，
  界面不给选择题——那是客户端各自写死的扫描路径，不是用户的决定。
- 删掉了 `scope` / `clients` 参数、`skillRoots()`、以及界面上的范围页签与客户端勾选；
  `skillsListRpc` 不再要 `workspaceDir`（装哪儿跟工作区无关）。
- 保留：按客户端分开的状态标记（只显示不出选择题）、两下确认的卸载、只删内容一致的那一份。
- 已知遗留：技能**草稿**的安装（`skills-draft.ts`）仍写工作区两处，没跟这里统一。
- 验证：`npm run typecheck` 退出 0；`npm test` **771 / 771**（`tests/skills-home.test.mjs` 7 条 +
  `tests/skills.test.mjs` 5 条，全部改为主目录语义）；重编产物 client 842,210 / server 793,464，
  「本机全局」「至少勾一个客户端」已从产物中消失；`paseo plugin reload` → `Plugin ready`。

**再追加（同日，用户澄清后定稿）**：用户明确「我们就是要给**项目级**使用的」。
上面那版改成用户级的做法是我自己推的，推错了。定稿只有一种行为：

- 技能装进 `<工作区>/.claude/skills` 与 `<工作区>/.agents/skills`，两个都由程序一起写；
- 没有「范围」选项（不写 `~/`），也没有「客户端」勾选；
- 保留：按客户端分开的状态标记、两下确认的卸载、只删内容一致的那一份。
- `skillDirs(workspaceDir)`（绝对路径 + 存在性校验）、`skillsListRpc` / install / remove 都回到
  `{ workspaceDir, lang, ids? }`。
- 验证：`npm run typecheck` 退出 0；`npm test` **771 / 771**
  （`tests/skills-install.test.mjs` 7 条 + `tests/skills.test.mjs` 5 条，全部工作区语义）；
  重编产物 client 842,322 / server 793,952，「本机全局」已从产物消失；reload → `Plugin ready`。
- 技能草稿（`skills-draft.ts`）本来就写工作区两处，现在与主流程一致，不再有遗留不一致。

## 2026-10-30 技能双归属：插件内 ↔ 项目内，双向同步

**为什么**：用户要的是「新增技能时能选装进**插件内**还是**项目内**，两边也能互相同步」，
外加一个插件级的「架构图纸」技能。此前技能只有「插件 → 项目」一个方向，项目里自己写的技能出不去。

### 1. 新增技能可选目标（`draft.target`）

- `server/skills/plugin-skills.ts`（新）：`writePluginSkill()` 把正文写进
  `templates/skills/{zh,en}/<slug>/SKILL.md`。两侧都写（外壳按「两侧都在」判断技能完整），
  用哪国语言写是另一回事，所以另一侧如实报 `pendingTranslation`。
- `server/skills-draft.ts`：`installSkillDraft(..., { target, lang, pluginDir })`；
  `target` 缺省 `project`（写进插件包等于改插件源码，必须显式选），返回 `target` 与 `pendingTranslation`。
- `shared/skills-draft.ts`：安装 RPC 输入加 `target`、`lang` 改为必填；输出加 `target` / `pendingTranslation`。
- 界面（`SkillDraftModal`）：校验/安装按钮下加「装到：本项目 / 插件内」页签，
  插件内多一行「这会改插件包自己的源码；写完要重载插件」；另一侧待翻译用 warning toast 说出来。

### 2. 回收：项目内 → 插件内

- `server/skills/adopt.ts`（新）：`listProjectSkills()` 只列插件里**没有同 id** 的技能
  （同 id 属于「有差异」，归技能页管）；两个目录内容不同就不回收（`split`），不替人挑一份；
  文件头 `name` 必须与目录同名。`adoptProjectSkill()` 委托 `writePluginSkill`，冲突不覆盖。
- `shared/skills.ts`：`skillsListRpc` 输出加 `projectOnly[]`；新增 `skillsAdoptRpc`（`deck.skills.adopt`）。
- `server/rpc/skills.ts` + `register.ts`：接线。
- 界面：技能列表底部「本项目自己写的技能（插件里没有）」，每行一个「回收进插件」；
  `split` 的行按钮禁用并写明原因。

### 3. 差异文件可以显式覆盖（插件 → 项目）

- `installSkills({ overwrite })`：默认仍不覆盖；显式 `overwrite` 才替换内容不同的那份。
- `skillsInstallRpc` 加 `overwrite`；详情页在这一份 `differs` 时多一个「用插件版本覆盖」。

### 4. 新技能 `architecture-map`（插件级）

`templates/skills/{zh,en}/architecture-map/SKILL.md`：九个视图（分层技术树 / 代码目录树 /
运行时进程树 / 端到端数据流 / 事件接入与分流 / 链路时序 / 状态机 / 部署拓扑 / 故障降级），
产出 `docs/architecture.html`（单文件、断网可开、每图带 ASCII 折叠）与 `docs/architecture.mmd`。
写死「每条结论都要指到文件，读不出来写未确认」——不许按常识补图。

### 验证

- `npm run typecheck`：两个 tsconfig 均退出 0。
- `npm test`：**780 / 780**（新增 `tests/skills-plugin.test.mjs` 8 条：写插件两侧、跳过/冲突/显式覆盖、
  非法 id、草稿装进插件、回收只列插件没有的、split 拒绝、一致回收、回收冲突；
  `tests/skills-install.test.mjs` 加 1 条显式覆盖）。
- 随包技能数 27 → 28：`tests/skills.test.mjs`、`README.md`、`docs/registry-submission.md`、
  `OVERVIEW.md`、`OVERVIEW.zh-CN.md` 同步改了。
- 重编产物：client 851,796 / server 802,396 字节；探针在产物里找到「回收进插件」「本项目自己写的技能」
  「装到」「插件内」「用插件版本覆盖」「deck.skills.adopt」「listProjectSkills」。
- `paseo plugin reload matt-skills-deck` → `running`，日志 `Plugin ready`。

**没验证的**：

1. 界面没在 Paseo 里点过——页签切换、「回收进插件」、详情页覆盖按钮的实际观感都没看过。
2. 「写进插件后别的项目也能装到」没做端到端实测；依据是 `listBundledSkills` 每次读盘，
   不是跑过一次别的项目的会话。
3. 插件内安装只写 `SKILL.md`，不复制同目录的附属文件（与主流程一致，仍是已知缺口）。
4. 改动未提交，`git diff --cached` 为空。

## 2026-10-30 本项目架构图纸（architecture-map 首次实跑）

用户 `/architecture-map` 触发，产物落在仓库里：

- `docs/architecture.html`（43.8 KB）：九个视图页签（纯 CSS radio 切换，无脚本、无外链），
  每图一张手写 SVG + 一段「ASCII 版」折叠；深色底、单一强调色、1px 细线。
- `docs/architecture.mmd`（7.1 KB）：九个 `%% === N ===` 段落，与 HTML 描述同一件事
  （flowchart / sequenceDiagram / stateDiagram-v2）。

查证方式：`package.json`、`index.server.ts`、`index.client.tsx`、`server/rpc/register.ts`（63 个 handler）、
`server/hooks.ts`、`server/tracker/{targets,backend,write,readiness,github}.ts`、`server/auth.ts`、
`server/update.ts`、`shared/local-layout.ts`、`.github/workflows/ci.yml`；行数与文件数是实测
（client/deck 70 文件 18,543 行、server 88 文件 20,414 行、tests 67 文件、`npm test` 780 条）。

顺带把 `paseo-plugin.json` 的描述从「27 个工程技能」改成「28 个技能」，与上一节的计数同步。

**验证**：HTML 用 `html.parser` 过了一遍——标签无未闭合、无多余闭合；9 个 `<pre>` 里没有残留
未转义的 `<`/`>`；ASCII 最长行 94 字符（上限 100）；全文无 `http` / `src=` / `url()` / `@import`，
断网可开。`npm test` 780 / 780 仍全绿。

**没验证的**：没在真浏览器里看过渲染效果（只做了结构与文本估算的越界检查）；
`<PASEO_HOME>` 实际取值、`.paseo/` 的写入者、GitHub 限流降级策略这三处已标「未确认」，没有编。

## 2026-10-30 architecture-map 技能改版：能吃下超大项目

用户反馈：旧版对超大项目「阐述不行」、HTML 不完整。旧版的问题很具体——九个视图要求手写 SVG、
一条视图塞一个完整系统、没有任何节点预算，项目一大就只能靠「省略」糊过去，而省略又不留痕。

改的是 `templates/skills/{zh,en}/architecture-map/SKILL.md`（154 行，两侧同构）：

1. **先量规模再决定页数**：S/M/L/XL 四档，判据是文件数/目录数/包数（给了现成命令），
   每档写明节点上限与页数上限；XL 的索引页只允许放「域地图 + 部署/调度拓扑 + 一条主链路」。
2. **事实层先行**：`docs/architecture/facts.json` 先由脚本扫出来，画图只读它；
   每条 claim 必须带 `path:line`，扫不出来写 `unconfirmed` + 缺什么。
3. **生成而不是手绘**：HTML 必须由 `build.mjs` / `build.py`（仅标准库、离线）从 facts 渲染，
   SVG 与 ASCII 同源；只允许手绘 S 档的总览图。手写 30 节点以上的 SVG 直接算反模式。
4. **折叠有据**：同类 >3 个列 3 个 + `+N`，HTML 与 ASCII 两处都要出现，全量留在 facts 里；
   裁掉的进「未展开清单」页。静默丢弃 = 造假。
5. **HTML 完整性清单**：doctype/charset/viewport/title、返回索引、纯 CSS 页签、每图 ASCII、
   事实来源表、页脚（生成时间 + 档位数字 + facts 指纹 + 折叠数）、单页 ≤1.5 MB、断网可开、
   SVG 宽度自适应（不许写死 900）。
6. **HPC**：检测到 SLURM/PBS/LSF/K8s Job/AWS Batch/MPI 时加第十个视图「作业与调度」
   （登录/提交节点 → 队列 → 计算池 → 并行文件系统 → 结果），标配额、walltime、checkpoint；
   没检测到就写查过哪些文件。
7. **自检脚本** `check.mjs`：链接与 data-ref 存在、无外链、ASCII 宽度、节点预算、页数、字节、
   claim 有 ref，最后输出一张表；空页签直接判失败。

项目内已安装的两份（`.claude/skills`、`.agents/skills`）同步成同一份正文，三处 md5 一致
（`36b63a22…`）。英文 description 压到 198 字符，符合 200 字上限。

**验证**：`npm test` 780 / 780；两份 SKILL.md 的 frontmatter 都能被 `parseSkillFrontmatter` 解析，
`name` 与目录同名；中文 116 字、英文 198 字描述。

**没验证的**：没有拿一个真正的超大仓库按新流程跑一遍——档位预算（S/M/L/XL 的节点数与页数上限）
是按经验定的，不是实测调出来的。仓库里现有的 `docs/architecture.html` 仍是**旧规则手写**的产物，
不满足新清单（没有 facts.json、没有事实来源表、viewBox 写死 900），要不要按新流程重生成待用户决定。

**同日更正**：用户质问「这是正常项目骨架的图纸，还是你乱写的」。逐条对账后，骨架成立，但有 5 处写错/写偏，
已改 `docs/architecture.html` 与 `docs/architecture.mmd`：

1. `git` 超时写成 10s —— 实际默认 20s（`server/git/exec.ts:34`；读出 5s、push 180s）。
2. 视图 5 写「没有定时任务（grep 未找到 setInterval）」—— 错。有两处：`server/auth.ts:279`（设备码授权轮询）、
   `client/deck/panel/usePanelRefresh.tsx:116`（面板刷新心跳）。不是后台业务作业，但确实存在。
3. 「常驻进程只有两个」说宽了 —— 本插件自己拉起的常驻进程只有插件服务端一个；agent 会话进程由宿主负责，
   不在本仓库内，标为未确认。
4. `sites.json` 路径漏了「或 `~/.paseo`」（`server/sites-store.ts:4`）。
5. 「17 个 deck_* 工具」不准确 —— 其中 `suggest_next_steps` 不是 `deck_*` 前缀，改为「17 个 MCP 工具」。

核对通过、未改的：63 个 RPC handler、17 个 MCP 工具、8 个面板页签、28 技能 × zh/en（每侧 30 项含 README/GLOSSARY）、
client/deck 70 文件 18,543 行、server 88 / 20,414、shared 44 / 9,196、tests 67 / 15,346、780 条测试、
React 19.1.0 / RN 0.81.5 / zod 4 / tanstack 5 / Node ≥22.18、`gh` 20s 超时、GitLab ≥ Reporter 写闸门。

**结构自检**：HTML 标签无未闭合；9 个 ASCII 块最长 94 字符；无外链。

**这次暴露的问题**：新技能要求每条 claim 带 `path:line`，正是为了堵住第 1、2 条这类「凭印象写数字」——
旧版没有这个约束，我按印象填了超时和 setInterval。检查脚本只能查结构，查不了数字对不对，数字靠 facts.json 的 refs 兜。

## 运行页「最近日志」为空：原因与修正

用户反馈：运行了好几遍，运行页的「最近日志」还是「没有日志」。

**实测原因**（三条，都不是 bug）：

1. **缓冲在进程内**：`server/logs.ts` 是 200 条的内存环形缓冲，没有落盘；每次
   `paseo plugin reload` 都是新进程，缓冲从空开始。开发期重载了四五次，所以每次看都是空的。
2. **只记写操作与失败**：59 处 `record()` 全在写路径和错误分支（issues 15、git 12、编排 8、回传 6、
   labels 5、模型列表 4、hooks 4、附件 3、发布 2）。**启动、读列表、切页签都不记**，
   `npm test` 也在另一个进程里跑，不会进插件缓冲——「运行了好几遍」本身不产生日志。
3. **不是开关的问题**：`DEFAULT_SETTINGS.debugLogging` 为 `true`（`server/settings.ts:14`），门没关。

**修正**（只补信息，不改「不落盘」的既有决定）：

- `server/logs.ts` 新增 `recordStartup()`：启动时记一行「启动 v0.1.0 · node v22.23.4 · pid … ·
  内存缓冲 200 条，重载即清空」。仍走 `record()`，所以调试日志关掉时连这条也不记。
- `registerDeckSettings` 改为返回首次读取的 promise（`server/settings.ts:29`），
  `index.server.ts:17` 等它完成再记——避免绕过用户关掉的开关。
- `shared/status.ts` / `server/status.ts` 的输出加 `debugLogging`；运行页空态分两种说法：
  开关关着说「设置里关掉了调试日志」，开着说「还没有条目。日志从插件启动时开始，只记写操作与失败，
  重载插件会清空」（`client/deck/panel/panelText.tsx` 的 `run.noLogs` / `run.logsOff`）。
- 运行页日志查询加 `refetchInterval: 10_000`，写操作发生后面板自己更新，不用按刷新。

**验证**：`npm run typecheck` 通过；`npm test` 782 / 782（新增 2 条启动行测试）；
用假的 `PluginServerContext` 直接跑 `contribute()`：63 个 handler，日志缓冲恰好一条启动记录；
已 `paseo plugin reload`。

**没做的**：日志仍不落盘。跨重载保留历史需要写 `<PASEO_HOME>/matt-skills-deck/`，
这与「只在内存、不碰用户目录」的现有设计相冲突，等用户明确要再做。

## Codex 配置「填了就是不生效，还得再建站点」：改成一步到位

用户原话：「你这不是傻逼逻辑吗 为什么配置那么难理解。优化视觉吧 配置就是配置了 怎么还那么麻烦」，
前置要求是「这块的注入必须是实际生效的」。

**病根**：宿主 Codex 适配器只把 `extends: "codex"` 且 `env.OPENAI_BASE_URL` 非空的派生条目
（id 固定 `deck-codex`）当成本次会话的 provider 配置；写在内建 `codex` 上的 env 宿主根本不读。
插件早期正是写在内建条目上的，于是卡片上地址填得好好的、会话却走 `~/.codex/config.toml`。
让用户理解这两层、再手动「建站点 → 启用」是把内部实现泄漏给了使用者。

**修正**：

- `server/codex-adopt.ts`（新）：内建 `codex` 上有地址、`deck-codex` 又不存在时，插件自己把地址搬过去
  （env 只写适配器真读的 `OPENAI_BASE_URL` + `OPENAI_API_KEY`，凭证从旧键挑一把抄过来，
  模型清单一起走），搬完读回核对；`ensureCodexAddressEffective`
  是读状态与建会话钩子共用的唯一入口，失败分 `patch-failed` / `unverified`（后者是「写进去了但没核对上」，
  不能报成没搬成），措辞只有 `describeCodexEnsureFailure` 一处。
- `server/provider-entry.ts`（新）：provider 条目读/写的判据（可用性、写目标、旧地址探测、凭证挑选、
  模型清单归一）收在一处，`orchestration.ts` 与 `codex-adopt.ts` 都从这儿拿，避免三份判据漂移。
- `server/orchestration.ts`：写地址进派生条目时顺手 `enabled: true`（用户存地址就是要它生效）；
  建派生条目时把内建条目上的凭证一起带过去（先存凭证、后存地址也不会丢）；写完读回不是能用的形状
  就报失败，不报「保存成功」；派生条目被停用/没地址/没继承 codex 且配过地址时，页面顶部告警。
- 客户端卡片主区只留 接入地址 / 凭据 / 模型 / 站点（可选备用线路），名称与 id 收进「高级」；
  `orch.siteNone` 改成「站点是可选的备用线路」，不再暗示必须建站点。

**验证**：`npm run typecheck` 通过；`npm test` 1639 / 1639（新增 adopt 自愈、读写路径、钩子接管、
告警与假成功等 20 余条）；已 `paseo plugin reload`（13:39:41 Plugin ready）。此前实测：
`~/.paseo/config.json` 出现 `deck-codex`（`extends: codex`、`enabled: true`、env 三条、模型 group/site8083），
`paseo run --provider codex/group/site8083` 建出的会话 provider 显示 `deck-codex`，回合正常返回。

**没做的**：

- 「只存凭证、没存地址」时不再额外告警：没有地址就没有可注入的目标，而内建 `codex` 的 env 宿主到底
  用不用，没有实测结论，不拿未证实的结论吓用户。
- 会话列表/回传里的 provider 字段会显示派生 id `deck-codex`（宿主的记录就是它），没做显示归一。
- 「把内建 `codex` 上那条旧地址清掉」只是顺手尝试：宿主对 provider 补丁是深合并还是整块替换，
  `PROGRESS.md` 里两条记录相反，尚未定论，所以文档里没承诺已经删掉。

## 「为什么我们插件要有这个东西」：派生条目的 env 只留真读的两个键

用户指着卡片上 Codex 的第二条凭据问：`SUB2API_API_KEY` 是什么、为什么插件要留它，要求「直接源头清理」。

**实测原因**：那是用户原来 sub2api 配置里的**旧键名**。宿主 Codex 适配器只读 `OPENAI_BASE_URL` 与
`OPENAI_API_KEY`，别的名字它看都不看；插件早先「整份照抄旧 env」的搬运方式，把旧键名一起抄进了
`deck-codex.env`，于是卡片上多出一行没人读、也解释不了的东西。

**修正**：

- 造派生条目时**只写两个键**：`OPENAI_BASE_URL` + `OPENAI_API_KEY`（`server/codex-adopt.ts` 的接管路径
  与 `server/orchestration.ts` 的卡片写入路径都改了；内建条目上的其它键留在原处，不动用户配置）。
- 已写下的残渣：`pruneRedundantCodexEnv` 在读到客户端配置时顺手清掉。宿主的 provider 补丁是深合并
  （`deepMerge`，`undefined` 跳过），**删不掉单个 env 键**；唯一真删的口径是 `removeProviders`，
  而宿主先处理移除、再合并同一补丁里的新条目，所以「摘掉 + 写回干净形状」放在一个补丁里不会留空窗。
  只删「名字像凭据、值又和 `OPENAI_API_KEY` 一模一样」的键；值不同、条目停用都不动。清理失败只记日志，
  不挡读状态、也不挡建会话。

**验证**：`npm run typecheck` 通过；`npm test` 1644 / 1644；已 `paseo plugin reload`（13:56:54 ready）。
实测：`~/.paseo/config.json` 的 `deck-codex.env` 从三个键变成 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 两个，
模型清单与 `enabled: true` 保留；随后 `paseo run --provider codex/group/site8083` 建出的会话
provider 仍是 `deck-codex`、回合返回 ok（会话已删除）。

**没做的**：内建 `codex` 上那份 `SUB2API_API_KEY` 不动——那是用户自己的配置，卡片读的是派生条目、
看不见它，也不生效；宿主没有「删单个 env 键」的口径，硬删要连内建 provider 整条摘掉，代价太大。

## 「换个项目的新窗口就不显示 gpt-6」：模型清单一处配置、两边写

用户截图对比：同一个 Codex 配置，A 窗口的模型选择器里有 `group/site8083` 与 `auto/gpt-6-astra`，
换到另一个项目开新窗口，列表里只剩 `group/site8083`。

**实测原因**（不是缓存，也不是配置没写进去）：

- `~/.paseo/config.json` 里 `deck-codex.models` 两个都在、`codex.models` 只有 `group/site8083`；
- 用 daemon 客户端读四个工作区的 `providers.snapshot`，每个工作区的 `deck-codex` 都是两个模型——
  所以问题不在「按工作区缓存的快照过期」；
- 宿主的模型选择器是**按 provider 条目各显示一份**：截图里那个列表标题是「Codex」（内建条目），
  读的就是 `codex.models`；A 窗口那一次选的是「Deck Codex」（派生条目），读的是 `deck-codex.models`。

一句话：一条配置分成了两份清单，选择器停在哪一行就显示哪一份。用户没理由理解这两层的区别。

**修正**：

- 保存模型清单时（`patchProviderConfig`）**两边都写**：派生条目可用时，同一份清单照写到内建 `codex`，
  各自落在条目自己用的那把键上（`models` 是替换内置列表、`additionalModels` 是追加，搬错键等于写了个不生效的地方）；
  照写没落地会在读回里给一句警告，不报「保存成功」了事（`server/orchestration.ts`）。
  只删「派生条目改之前也有」的那些（用户面板里取消的），内建那一行用户自己在 Paseo 设置里加的模型留着
  （`mirroredModelsOf`）——面板读的是派生条目，那些模型在面板上看不见，整份替换删掉就是替人做决定。
- 读客户端页时顺手对齐（`mirrorCodexSiteModels`，`server/codex-adopt.ts`）：两份对不齐就以可用的派生条目为准
  **只补不删**地照写一次（内建那行可能有用户自己加的模型；补用的是 `withMissingModels`），
  用户不用为了「换个窗口也能看到」再保存一遍；顺序不同不算不一致，写不进去只提示、不挡读状态。
  派生条目停用/没地址时不动内建条目的清单——那是用户明确留下的状态。
- 老路径 `enableSite`（直写补丁、不经 `patchProviderConfig`）也补上同一次对齐，否则启用站点之后
  「Codex」那一行仍是旧清单；清单按**来源条目自己那把键**取，`models` / `additionalModels` 两种形状都覆盖，
  写完读回核对。显示名抽成 `CODEX_SITE_LABEL`，三处建/改派生条目共用。
- 自愈只记「写进去了、读回还缺」这一种（宿主拒收）：写盘抛错、读不回来都是瞬时故障，不记忆，
  下次读客户端页再试；用户重新保存模型时清空记忆（`forgetMirrorFailures`）。

**验证**：`npm run typecheck` 通过；`npm test` 1666 / 1666 全绿（新增 3 条写入路径 + 7 条对齐用例
+ 2 条读状态用例 + 2 条启用站点用例 + 6 条清单合并单元用例 + 1 条「别家客户端带 OPENAI_BASE_URL」）。实机：重载插件前 `~/.paseo/config.json` 里
`codex.models` 只有 `group/site8083`、`deck-codex.models` 两个都有；重载后调一次
`deck.orchestration.state`，`codex.models` 变成 `group/site8083` + `auto/gpt-6-astra`，自愈生效。

**没做的**：没有把「保存后自动刷新所有工作区的宿主快照」接进写入路径。实测四个工作区的快照都已经有这两个模型，
触发不了用户报的这个现象；而且读宿主源码（`mutable-provider-config-owner` 订阅 `store.onApply` →
`installGeneration` 会删掉变更 provider 在所有 target 上的缓存目录并重新 warm up）说明 provider 配置改动
本来就会传到所有工作区，不需要手动刷新。`providers.refresh()`（不带 `cwd`）会去 warm up 所有工作区，
日志里一次就跑了 33 秒，放在保存按钮后面是拿用户的等待换一个当前并不存在的问题。客户端页的「刷新宿主模型」仍在
（只刷当前工作区）。

## 「为什么我们的没有低/中/高档位」：档位改成跟宿主快照走

用户原话：「为什么我们的没有这个选项了 不能写死 要动态 … 新的电脑 又不能注入了？」
前置事实：宿主每个模型都会报 `thinkingOptions` / `defaultThinkingOptionId`，换模型就换一套。

**病根**：插件把宿主快照压成了 `models: string[]`，档位数据在入口就被丢掉；界面上只有档案页
一个自由文本框，四档难度的直填目标连这个字段都没有，用户只能盲填一个 id，填错也不出声。

**修正**：

- `server/provider-snapshot-view.ts` 的 `modelThinkingOf()`：按模型保留 `thinkingOptions`
  （`id` / `label` / `description?` / `isDefault?`）与 `defaultThinkingOptionId`；字段缺失、
  类型不对、重复 id、默认指向不存在的档位，一律退化成「没有档位」，不抛错、不挡状态页。
  `modelIdsOf` 顺带先验数组（`models` 是对象时原来整页状态读不出来）。
- 契约 `shared/orchestration-rpc.ts` 加**可选** `modelThinking`，`models: string[]` 语义不变
  ——模型清单的读写与镜像不受影响，老快照照读。
- 客户端新增 `ThinkingChoices.tsx`：只渲染宿主报出来的档位，没报就整块不渲染；未选时提示
  「不选就走模型默认的 X」。`thinkingChoicesOf()` 未选模型 / 客户端不在清单 / 模型无档位
  一律返回 `none`，绝不补一个默认档；`withModelClearingThinking()` 换模型时清旧档，返回新对象。
- 档案页与四档难度的直填目标都接上；点已选中的项是无操作，不会把档位误清成空。手填框保留
  （宿主没报档位时它是唯一入口）。四档的手填草稿按难度分开存——共用一份会串档。
- 代码里没有档位常量列表；`low/high/max` 只出现在测试夹具里。

**验证**：`npm run typecheck` 通过；`npm test` 1680 / 1680 全绿。真机读宿主快照
（`providers.snapshot`，本机 daemon）：Claude 的 `group/site8083` 报 low/medium/high/max、
默认 high；`codex` 与 `deck-codex` 的两个模型（`group/site8083`、`auto/gpt-6-astra`）**一个档位都不报**，
所以 Codex 上不会出现 chips、只剩手填框——这是宿主的数据决定的，不是渲染问题。
插件已于 16:33:29 reload（Plugin ready，无报错）。

**没做的**：

- 聊天窗口（宿主输入栏）里没有档位选择器，也不打算做。插件能 `addComposerPill` 放按钮进去，
  但 `PaseoApi` 没暴露 `setAgentThinkingOption`（宿主 daemon 内部有 `set_agent_thinking_request`），
  点下去改不了正在跑的会话，只能当摆设。真要能选，得宿主把这条 API 开出来。
- Codex 模型不报档位，插件面板上就只剩手填；若想让聊天栏出现下拉，只能在 `~/.codex/config.toml`
  写 `model_reasoning_effort`，宿主读到的默认档会被报成一个可选项——那是用户本机配置，插件不代改。

## 「档位放在客户端卡片上」：每个模型带自己的默认思考档位

用户原话：「这个档位应是在图二这个地方 客户端 注入的根据对应的模型 配置对应的单位 这样才是合理的」。
#29 把档位接到了宿主快照上，但入口只在档案页与难度路由；#30 要求把默认档放回客户端卡片的模型清单上。

**改动**：

- 设置新增 `OrchestrationSettings.modelThinking: Array<{ provider, model, thinkingOptionId }>`
  （`shared/orchestration.ts`）。旧设置文件没有这一段时按空表处理：归一化走
  `normalizeModelThinking(record.modelThinking)`，`undefined` 返回 `[]`，读写都不报错；
  `DEFAULT_ORCHESTRATION` 里也是 `modelThinking: []`。
- 归一规则只在 `shared/model-thinking.ts`：缺字段的条目丢掉、按 trim 后的 provider + model 去重
  （保留第一条）、条数按 `MAX_MODEL_THINKING`（200，与单个客户端的模型清单写入上限同源）封顶。
- 解析只此一份 `resolveThinkingOptionId()`：档案 / 路由里显式的 `thinkingOptionId` 优先；
  没有才用卡片上同 provider + model 的默认档；两处都没有就不传，由宿主用模型自己的默认。
  `withResolvedThinking()` 把结果写回目标并返回新对象；上下文里的 `modelsByProvider`
  会先判模型还在不在清单里——模型被删掉后，残留的默认档不再下发。
- 五个建会话入口共用这套解析，上下文统一由 `thinkingContextOf()` 拼：派单
  （`server/orchestration.ts`）、改派（`server/staff-reassign.ts`）、建派单窗口
  （`server/rpc/orchestration.ts`）、群发（`server/rpc/group.ts`）、MCP `deck_dispatch_plan`
  （`server/mcp/tools.ts`）。
- 客户端：`ClientsPanel` 模型区新增 `ModelThinkingList`，每个已选模型显示当前默认档，可设 / 清；
  选项走 `thinkingChoicesOf()`，只列宿主为该模型报出的档位，宿主没报就只留手填；
  清除即从表里移除该条，整表以新数组写回设置保存。中英文案在 `panelText.tsx`。
- 不写死档位 id：代码里没有档位常量列表，`low` / `medium` / `high` 只出现在测试夹具里。

**验证**（客户端改动完成后实测）：`npm run typecheck` 通过；`npm test` 1705 / 1705 全绿，
含 `tests/model-thinking.test.mjs`（服务端解析 / 归一）与 `tests/model-thinking-default.test.mjs`
（卡片表的查找、去重、封顶、清除）。宿主快照的档位数据见上一节实测：Claude 的
`group/site8083` 报 low / medium / high / max，Codex 的两个模型一个档位都不报——所以 Codex
卡片上不出现 chips，只有手填框，这是宿主数据决定的，不是渲染问题。

**没做的**：

- 没有清理「模型从卡片清单删掉后」留在 `modelThinking` 里的残留条目：删模型走的是客户端注入
  （`deck.orchestration.provider`），不经过设置保存；残留条目由 `modelsByProvider` 在解析时挡掉，
  界面上也不显示。要不要顺手清掉由后续决定。
- 聊天窗口输入栏仍然改不了档位（原因见上一节），这次只动卡片与派单解析。
