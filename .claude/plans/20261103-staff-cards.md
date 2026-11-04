# 岗位卡（员工名册）

日期：2026-11-03　分支：`feat/multi-project-workspace`

> **落地状态：2026-11-04** —— 代码全部写完；能自动跑的验收全绿；要人点的五条**还没做**。详见下一节。

## 落地状态（2026-11-04）

**六批 + 派单台 + 阀门四全部落地。验收分两档，别把两档混着说。**

- **提交**：`584940b`，本地提交，**未推送**。它与本分支的多项目工作区、群视图合成一个检查点——
  跨块文件（`panelText.tsx`、`OrchestrationView.tsx`、`register.ts`、`server/orchestration.ts`）
  三块都碰，拆开提中间状态单独编不过。
- **自动档（已做，全绿）**：`npm run typecheck` 通过；`npm test` **1582 条通过 / 0 失败**
  （本批落地时是 1533 条 / 124 个测试文件；之后「名册与群记录按目录 + 一个项目一个群」又加到
  **128 个测试文件**，2026-11-04 重跑全绿）。其中本计划相关：`staff-*` 8 个、`group-*` 8 个、
  `contract-*` 3 个、`requirement*` 3 个，另有 `dispatch-form`、`split-guard`、`impact`、`ticket-label` 等。
- **实机档（已做，只到服务端）**：本机 daemon 0.13.2，`paseo plugin reload` 后 `running`、日志无错误行；
  `deck_probe` / `deck_context` 实跑 `ok:true`（GitHub 后端可达，读到 3 张打开的票）；
  用假上下文冷启动真入口 `index.server.ts` 的 `contribute()` → **79 个 RPC 全部挂上、无重名**，
  钩子顺序 `before:agent.create` → `on:agent.permission_requested` ×2（自动放行在前、领地闸在后）
  → `on:agent.created` → `on:agent.turn_ended`；返回的卸载函数为 `function`。
- **未验**：客户端 bundle 能否被 App 加载（本机没有桌面端，`plugin list` 显示 `running` 不算证据）；
  以及**任何 UI 点击**——所以下面那张表里的界面行为都只是「代码与单测层面成立」。

| 批次 | 状态 | 落点 | 证据 |
|---|---|---|---|
| 0 探针 | 已完成（11-03） | 一次性脚本 | 结论已写进第四节开头 |
| 1 数据模型 + 派单带岗位 | 已落地 | `shared/staff.ts`、`shared/orchestration.ts`、`server/orchestration.ts`、`server/mcp/tools.ts` | `tests/staff-cards.test.mjs`、`tests/orchestration-dispatch.test.mjs` |
| 2 名册界面 + 阀门二 + 阀门四 | 已落地 | `StaffPanel.tsx`、`RolesPanel.tsx`、`StopSection.tsx`、`server/hooks.ts` | `tests/staff-gates.test.mjs`（14 条；原计划叫 `agent-created-gate.test.mjs`，落地时并进了这个文件）、`tests/staff-stop.test.mjs`（阀门四此前 0 条测试） |
| 2b 需求票入口 + 影响面 + 定稿 | 已落地 | `shared/requirement.ts`、`shared/impact.ts`、`shared/split-guard.ts`、`server/mcp/tools.ts`、`IssueDetailView.tsx` | `tests/split-guard.test.mjs`、`tests/impact.test.mjs`、`tests/ticket-label.test.mjs` |
| 可选 派单台 | **已做**（原标「可选」，用户要求全面落地） | `shared/dispatch-form.ts`、`DispatchPanel.tsx`、`OrchestrationView.tsx`（新增 `dispatch` 页签） | `tests/dispatch-form.test.mjs` 8 条 |
| 3 归属 + 按区铺票 + 谁能让派 | 已落地 | `shared/staff-guard.ts`、`shared/requirement-split.ts`、`server/requirement-dispatch.ts`、`shared/staff-request.ts` | `tests/staff-guard.test.mjs`、`tests/requirement-split.test.mjs` |
| 4 阀门三 + 协调收件箱 | 已落地 | `server/staff-territory.ts`、`InboxPanel.tsx`、`server/rpc/orchestration.ts`、`register.ts` | `tests/staff-territory.test.mjs`（24 条）、`tests/staff-territory-gate.test.mjs` |
| 4b 跨区代码链条 | 已落地 | `shared/contract-chain.ts`、`server/contract-chain.ts`、`server/chain-gates.ts` | `tests/contract-chain.test.mjs`（26 条）、`tests/contract-chain-server.test.mjs` |
| 5 岗位履历（记忆） | 已落地 | `server/staff-history.ts`、`server/orchestration.ts` 抬头拼装 | `tests/staff-history.test.mjs`（23 条） |
| 6 群视图 + `@全部` | 已落地（客户端落点改叫 `GroupPanel.tsx`） | `shared/group-rpc.ts`、`server/rpc/group.ts`、`GroupPanel.tsx`、`GroupProgress.tsx` | `tests/group-*.test.mjs`（8 个文件） |

**额外落地（计划里是散条目）**：阀门四的按钮放在「编排 → 岗位」底部（`StopSection.tsx`，两道确认 + 可选归档），
第九节第 7 条那两句归档/不转发文案就写在这个按钮旁边；血缘（`kind:"lineage"`）加了保留策略
（500 条 / 90 天，只裁最后一次可动作记录之后的血缘行，不碰别的 kind）。

### 手工验收（待做，只有人点得出来）

按本工作区现在的实况（名册为空、`coordination.jsonl` 不存在）预期如下：

- [ ] **名册存取**：加一张卡 → 存 → 重开还在；中文名不填 id 应自动生成 `staff-xxxxxx`；两张同名卡互不覆盖。
- [ ] **派单台**：名册空时显示「0 张卡 / 名册还没有卡」且**不要求选卡**；建卡后没选卡必须当场拒；
      多仓库工作区没选仓库也要当场拒；按「派出去」后表应变灰锁住。
- [ ] **全停**：本区目前没有带 `deck.staff` 的会话，预期是「0 个会话」，不是报错。
- [ ] **收件箱**：现在应为空列表 + 一句说明（`coordination.jsonl` 还不存在）；之后真出一行请求才算 RPC 三处都通了。
- [ ] **群视图**：`@某张卡` 发一句，看消息里工具调用是否折成一行；`@全部` 应先出清单再铺票。
- [ ] **「至少同时几个」**：调到 3 后派五条活，要真的铺到 3 张卡上（`minConcurrentStaff` 现在未设置）。

用户原话：

> 对就是这样 但是我们要配置很多员工的 应为 方案到执行 需要多分工的

> 岗位卡：员工只是名册上的一张卡（名字 + 职责提示词 + 模型），派活时按卡建一个子会话，干完归档。

## 目标

一个工作区一份**岗位名册**。名册上的每张卡是一个工种（前端、后端、测试、验收……），
写着名字、职责提示词、用哪份模型档案。派单时按卡建子会话：干完就归档，不常驻。

用户要的是「方案到执行多分工」：主窗口谈方案 → 派单窗口拆活 → 逐条任务指定岗位 →
各岗位的会话各自按自己的职责提示词和模型干活 → 结果照现有回传链回到上一级。

名册上的卡有两种：**员工**（只干活）和**经理**（在自己管的那片里再往下派）。
派单窗口是默认的**根经理**，管整个工作区；你可以再往名册里加局部经理，
把它指定到某个目录。两边领地叠上时不是硬拦，是**要求他们先沟通**——见第五节。

## 非目标

- 不改成「常驻员工窗口」：卡不绑会话，不占上下文。
- 不动三个固定窗口（主/派单/进度）的语义：它们是**身份**，不进名册，也不能被名册删掉。
  理由：回传链挂在派单窗口的绑定上，让名册能删它等于留一个断链入口。
- 不做角色库的导入导出、不做岗位之间的自动交接（A 岗位干完自动叫 B 岗位）。
- 不改宿主、不改用户本机设置（`~/.paseo/config.json`、`.deck/orchestration.json` 由用户自己填）。

## 已核实现状

| 事实 | 位置 |
|---|---|
| 三个固定窗口是字面量联合类型，加不了第四个 | `shared/role-prompts.ts:13` `FIXED_ROLE_NAMES` |
| 一个工作区一行绑定，只有三个 `*AgentId` + `prompts` | `shared/orchestration.ts:80` `WorkspaceRoles` |
| 建窗 RPC 的 `role` 是 `z.enum(FIXED_ROLE_NAMES)`，名册外的角色在 schema 层被拒 | `shared/orchestration-rpc.ts:687` |
| 派单任务只带 `difficulty`，没有「谁来做」这一维 | `shared/orchestration-rpc.ts:407-413` `dispatchTaskSchema` |
| 子会话的 `systemPrompt` 通道已存在，建窗就是这么写职责的 | `server/rpc/orchestration.ts:340` → `server/session.ts:206` `createAgent` |
| 派单的 `createFor` 现在只传首条 `prompt`，**没传 `systemPrompt`** | `server/orchestration.ts:1166` |
| 设置归一化逐个字段手抄，漏一个字段就是保存一次把它抹掉 | `shared/orchestration.ts:977` `normalizeOrchestration` |
| `withWorkspaceRoles` 同样手抄字段（已有注释警告过一次） | `shared/orchestration.ts:1076` |
| 子会话标签是会话树、地图预算、回传的认人依据 | `shared/orchestration.ts:442` `buildChildLabels` |
| 档案（`ClientProfile`）来自 daemon 配置，路由按 `profileId` 解析 | `server/orchestration.ts:228` `profilesOf`、`shared/orchestration.ts:303` `resolveRouteTarget` |
| **父子关系写的是真实调用者，不是绑定的派单窗口**——嵌套派单今天就能跑 | `shared/orchestration.ts:573,598` `planDispatch`、`server/mcp/tools.ts:1656-1666` |
| 任何有 deck 工具的会话都能派单，不限于派单窗口（闸很松） | 同上：`planDispatch` 只检查「有没有绑」 |
| 层数上限默认 3、最多 6 | `shared/orchestration.ts:172` `DEFAULT_MAX_DEPTH`、`:1017` `clampInt(...,1,6,...)` |
| 容器工作区有多个仓库时，建票必须带 `repoKey`，而派单的 schema 里没有这个字段 | `server/tracker/targets.ts:473-479`、`shared/orchestration-rpc.ts:407-413` |
| **现役派单只有一个工具，而且它只出计划、不做事**：`deck_dispatch_plan` 返回每条任务的 provider/model/标签/prompt/票面，注释明写「这一步一个字都不写」；建票是模型再调 `deck_issue_create`（要人确认），建会话是模型调宿主 `create_agent` | `server/mcp/tools.ts:1782`、`:1724-1730` 注释、`:1755-1763` 的 hint |
| **另一个会「先建票再建会话」的自动派单路径存在，但客户端一次都没调用**：`runDispatch` → `orchestrationDispatchRpc`；客户端只 `useRpc` 了 12 个别的编排 RPC，没有这一个 | `server/rpc/orchestration.ts:144-158`（handler）、`server/orchestration.ts:1072`（`runDispatch` 本体）、`client/deck/surfaces/OrchestrationView.tsx:93-104` |
| **`ready-for-agent` 会自己亮**：`spec` / `spec-ticket` 建票时自动补上这枚「分诊标签」，所以它**不能当定稿闸** | `shared/issue-kind.ts:64,68`、`:117-124` `labelsToEnsure` |
| **`before agent.create` 不能拒**：签名只允许改造请求或返回 void，没有拒绝通道 | `@getpaseo/plugin/dist/server/lifecycle.d.ts:95-97` |
| **MCP 工具进程里没有 PaseoApi**：`ToolContext` 只有 `workspaceDir`，数不了在跑会话、读不到调用者标签 | `server/mcp/tools.ts:69` |
| **`agent.created` 事件带完整 `context.paseo`**，能 `archive()`——这是唯一「绕不开又能动手」的闸点 | `lifecycle.d.ts:70-72`（事件）、`hooks.ts` 里的 `on(...)` 用法 |
| **跨工作区父链能做**：父边只是子会话上的一枚标签 `paseo.parent-agent-id`，协议里没有 workspace 这一维；daemon 建会话时不比对 `workspaceId`；磁盘上已有跨区父边的实据 | `@getpaseo/protocol/dist/agent-labels.js:1-2,10-15`、`…/create-agent/intent.js:3,8`、`…/agent-manager.js:268-273` |
| **跨仓库 `blockedBy` 不算「阻塞」**：只写进正文隐藏区段；GitHub 的 readiness 只看原生 blocker 节点，GitLab 读正文时还会主动剥掉隐藏区段 | `server/tracker/github/normalize.ts:173,195`、`server/tracker/gitlab.ts:133` |
| **`agent.created` 的事件载荷没有 labels**：要读标签得 `agents.ref(id).refresh()` → `agents.list({filter:{labels}})` → 内存里按 `workspaceId` 过滤（`list` 的 filter 没有 workspaceIds 维度） | `lifecycle` 的 `PluginHookAgent`、`agents.list` 的 filter 定义 |
| **同一插件的多个 `on(...)` 按注册顺序串行 `await`**：deny 先注册就先生效，后到的 allow 会抛 `No pending permission request` 被吞成 warn | `@getpaseo/plugin/dist/server/plugin-process.js:27`、`lifecycle/index.js:158-167`、`providers/claude/agent.js:2241-2243`、`acp-agent.js:1641-1644` |
| **打断正在跑的一轮有 API**：`send(..., {activeTurnBehavior:"interrupt"})`；缺的是 pause/suspend | `@getpaseo/client` `daemon-client.d.ts:165-166`、`server/session.ts:477-485` |
| **四家客户端里三家填权限请求的 `detail`**（2026-11-03 逐家读过源码）：claude 认不出的工具给 `{type:"unknown"}`（`providers/claude/agent.js:1732-1758`）；codex 有四种形状（`codex-app-server-agent.js`）；opencode 老路填、v2 不填；**ACP（cursor）无条件填**（`acp-agent.js`）。也就是说「拿不到 `detail`」几乎只发生在 opencode v2 一条路上 | 见左 |
| **`systemPrompt` 只有三家消费**：claude 走 `preset + append`（`providers/claude/agent.js:2870-2874`）、codex 写 `developerInstructions`（`codex-app-server-agent.js:4123-4131`）、opencode 走 `session.promptAsync({system})` 与 v2 `instructions.entry.put`（`v2/session.js:131-137`）；**cursor/ACP 完全不读**（`acp-agent.js` 里 0 次，`newSession` 只带 `cwd`/`mcpServers`） | 见左 |
| **`agents.list` 的归档开关在 `filter` 里**（`filter.includeArchived`，不传看不到归档的；旁边还有 `filter.includeInternal`）；归档会话本身仍可按 id 取回（加载路径不看 `archivedAt`） | `@getpaseo/protocol` `messages.d.ts:4980-5000` `fetch_agents_request`、`agent-loading.js:24-54` |
| **父会话归档时子会话二选一**：同区且无标签页 → 连坐归档；跨区或开着标签页 → 摘掉 `paseo.parent-agent-id` 继续跑（回传静默停掉） | `agent-manager.js:1164-1176`（分发）、`:268-281`（`shouldDetachFromArchivedParent` / `detachedAgentLabelPatch`）、`server/hooks.ts:313` |
| **会话标签创建后不可变**：`updateAgent` 只在 `DaemonClient` 上，插件侧没有改标签的调用面 | `@getpaseo/client` `daemon-client.d.ts`、插件服务端 API 快照 |
| **客户端没有文件系统访问**：`.deck/**` 只能经 RPC 读；新增方法必须在 `register.ts` 挂载 | `server/rpc/register.ts:140-228` |
| **命令行是 `paseo agents ls`**，列表无标签列，只支持 `--label k=v` / `-a` 过滤 | CLI 帮助输出 |

## 零、干活必须先有需求、再有票（整条链的主干）

用户原话：

> 干活 必须需要创建需求和票的 需求完毕之后 自动分配各个工作区的员工

这句话把整条链定死了，也让「谁分配」这件事落了地：**人分配的是「谁负责哪个区」，
票落到哪个区是算出来的，不是人一条条点的。**

```
探讨需求（现有那套）          ← 主窗口 + wayfinder / grill-with-docs，六节补全
   └── 你确认定稿              ← 点「定稿」按钮打上 deck:定稿，这才算「可以派人干了」
          └── 清单给你看（可配）← 动哪几个区、每区派给谁、几个模型、开几个会话
                 └── 每区一张票 ← 带 repoKey / 工作区归属，机械拆出来
                        └── 该区的员工 ← 名册里领地覆盖它的那张卡
                               └── 子会话 ← 按卡的 duty + 档案建，干完归档
```

**需求这一段完全是现有做法，不新造任何入口。** 用户原话：

> 需求 就给我们目前一样 探讨 需求 确认了 然后分工 我们需要先探讨的

就是现在这条：新建需求 → 在会话里把需求谈清楚 → 你确认定稿 → 才轮到分工。

**但「`requirement` 标签 + 六节骨架」这句我先改掉：它今天没有挂到任何入口上。**
`buildRequirementBody` / `requirementLabels` / `buildRequirementPrompt`
（`shared/requirement.ts:41,49,217`）在生产代码里**没有任何调用方**，只有
`tests/requirement.test.mjs` 在调；任务板那张「新建票」表单把 `mode` 写死成 `"issue"`
（`client/deck/NewIssueModal.tsx:157,168`），只留下一个「标记为地图票」开关，
既不铺六节也不挂 `requirement`。所以第二节 2b 不是「往现成骨架上加一节影响面」，
是**先把这套骨架接上一个门**——我自己上一版把「代码里有」当成了「界面上有」，
又犯了一次同样性质的错（详见十点五）。

### 两个门的名字要能一眼分清（现状是混的，而且比我上一版说的更糟）

今天代码里其实已经有两扇门，但两块牌子都在说「地图」，没有一块说「探讨」：

| 你现在点到的 | 实际发出的提示词 | 会话标题 |
|---|---|---|
| 「新建需求」→ 卡片「探索地图」 | `/wayfinder` + 「请帮我处理一个需求」 | `[New] 新建需求` |
| 「新建需求」→ 卡片「实施地图」 | **`/grill-with-docs`** + 「请帮我讨论一个需求」 | `[New] 实施地图` |

（`client/deck/Panel.tsx:243-249`、`client/deck/entry/entryCopy.ts:27-62`、
`shared/entry-prompt.ts:92,108`）

**「探讨」这扇门今天挂着一块写着「实施」的牌子**——用户预感的乱，源头就在这，
不是多虑。另有几条岔路各有各的名字：面板上的「+ bug」；`/deck new` 在**会话里**只往时间线插
一张命令卡（`client/deck/surfaces/slash.tsx:173-181`），卡上点「打开任务板」才开会话面板、
且预填的是 `buildActionPrompt("new-requirement")`（`CommandCard.tsx:49-59`、
`SessionSheet.tsx:219,244`）——**不弹那两张选卡**，选卡只有任务板里的按钮能开
（`Panel.tsx:119,471,516`），而**工作区级**（`/deck-workspace new`）只把提示词复制到剪贴板
（`slash.tsx:224-227`）——同一个命令三种行为；票上那个「讨论」按钮是
**对已有的票**发 `/grill-me`，不是开一张新需求（`client/deck/panel/issuePrompt.tsx:47`）。

（上面这句我上一版写反了：把「工作区级才复制」写成了「`/deck new` 只复制」。已按代码改正。）

**但再往下核一遍，撞到了我自己：我上一轮提的「卡片一改叫新建需求」会撞馆。**

| 门 | 现在叫什么 | 实际做什么 | 证据 |
|---|---|---|---|
| 任务板上的表单 | **新建票** | 真的建一张票：标题 / 正文 / 标签 / 仓库 / 标记为地图票（缺陷那套文案还在，但表单里**没有对应控件**，`messages.ts` 的 `bugActual` 等无人引用） | `client/deck/NewIssueModal.tsx`、`messages.ts:1131-1200` |
| 面板上的按钮 | **新建需求** | **不建票**：弹两张卡 → 开新会话，把 `/wayfinder` 或 `/grill-with-docs` 的原文填进输入框 | `client/deck/Panel.tsx:241-249` |

**挂着「新建需求」牌子的那个门，恰恰不建票；真建票的那个门叫「新建票」。**
我上一轮只盯着卡片改名，等于把这个错钉深一层——卡片一要是也叫「新建需求」，
界面上就同时有两个「新建需求」，一个建票一个不建。

**你已定：甲——牌子归建票那条。** 于是名字这样重挂（这一批只改名与落点，不新增流程）：

| 门 | 改成 | 里面是什么 | 动哪 |
|---|---|---|---|
| 面板按钮（今天叫「新建需求」，却只开会话） | **新建需求** 保留这个名字，但**改成打开建票表单**，类型预选「探索需求」 | 真的建一张需求票 | `client/deck/Panel.tsx:241-249` 的 `openEntry` 改指向表单 |
| 面板按钮（新位置） | **探讨需求**——今天那个「开新会话 + 预填提示词」的按钮改叫这个 | 两条谈法：`/wayfinder`（边谈边建地图）/ `/grill-with-docs`（只谈，暂不建票） | `entryCopy.ts:27-62`、`requirement.ts` 的提示词不变 |
| 任务板「新建票」表单 | 名字不动，**类型里补「探索需求 / 实施需求」两项** | 选这两项 → 铺六节骨架 + `requirement` 标签（今天没有这条） | `NewIssueModal.tsx:157,168` 的 `mode` 不再写死 `"issue"` |
| 斜杠命令 | `/deck new`（**现有**，改指向建票表单）；`/deck discuss`（**新增子命令**——现有子命令只有 `status / attach / next / handoff / fixate / new / help`，没有 `discuss`）= 开会话探讨。**不注册中文命令名** | | `shared/slash.ts:34,84-89`、`client/deck/surfaces/slash.tsx` |

**这个挂法顺手治好另一处混用**：`RequirementMode = "explore" | "implement"`
（`shared/requirement.ts:11`）从此只表示**正文骨架模式**（探索六节：问题 / 目标与非目标 / 约束 /
备选方案 / 建议 / 待定问题；实施六节：背景 / 目标 / 范围 / 步骤 / 测试计划 / 风险与回滚），
不再兼职表示「哪张卡」。今天它两件事都在兼，所以两块牌子和两张卡互相打架。

卡片内的文案也要跟着改：现在写的是「想清楚了要做什么，没想清楚细节」（目标清晰度），
改名后要写**这一步会发生什么**——「边谈边建地图（会产出地图和路线票）」／
「只谈，谈完你自己跑 /to-spec、/to-tickets」。目标清晰度那句留作小字提示。

**斜杠命令不碰中文名（你已定：不能斜杠那个，就用原有的）。** 继续用 `/deck` 这个命令，
**不注册** `/新建需求`、`/探讨需求`。
子命令上：`/deck new` 是现成的（`shared/slash.ts:34`），只需改它的落点；
`/deck discuss` **要新加**——现有子命令全集是 `status / attach / next / handoff / fixate / new / help`，
没有 `discuss`（未知子命令今天一律走 `unknown-command`，`shared/slash.ts:58`）。
理由记在这儿，免得以后有人又想加：插件侧命令名确实是自由字符串
（`node_modules/@getpaseo/plugin/dist/client/contracts.d.ts:273-277` 只有 `name: string`），
但宿主输入框认不认中文没验过；而命令名撞车会让整个插件装载失败
（`client/deck/surfaces/slash.tsx:243-247` 有记）。为两个名字去赌装载失败不合算，
所以**这一条到此为止，不再验、不再排批次**。

**「定稿」怎么机械地表示：一枚插件私有标签 `deck:定稿`，不是 `ready-for-agent`。**

上一版这里写的是 `ready-for-agent`，**那是个会自己亮的闸**：`spec` 与 `spec-ticket`
这两类票在**建票那一刻就自动带上它**（`shared/issue-kind.ts:64,68` 的 `triageLabels`
→ `:117-124` `labelsToEnsure`），模型建一张 `spec` 就等于自己给自己发了许可证。
所以定稿改用另一枚：

- 标签名 **`deck:定稿`**（前缀 `deck:` = 插件私有）。
- **只有客户端界面写得出**：票详情页一个「定稿」按钮（走 RPC，你自己点）。
- **MCP 工具拒绝写这枚标签**：`deck_issue_labels` / `deck_issue_create` 收到任何 `deck:`
  前缀的标签一律拒绝并说明「这枚标签只能由界面上的按钮打」。
  这样「模型给自己发许可证」这条路在插件侧就是堵死的。
- 闸只认这枚：需求票上没有 `deck:定稿` → 派单与群里一律拒绝，提示「这条需求还没定稿，
  先把六节谈完、影响面核完，再点定稿」。
- `ready-for-agent` 仍然有用，但**只作为给人看的现状**，不进任何判定分支
  （它会被自动补上，见上面那行代码）。

**这就是「必须先探讨」的那道闸**，不是又加一层流程：判断依据从一枚会自己亮的仓库标签，
换成一枚只有人手能盖的插件标签。

- **无票不干活，无定稿不分派。** 两道闸门叠在一起：没有票就不给计划、不给建票
  （否则活只活在进程里，窗口一关什么都不剩，正是 `server/tracker/dispatch-ticket.ts:1-20`
  要修的病）；有票但没定稿也不派。
  **闸的落点要把话说准**：拦在 ① `deck_dispatch_plan` 不给计划、② `deck_issue_create`
  拒绝建票这两处，**不是「建不了会话」**——宿主那一步插件管不到（第二节「拦不住的」那段）。
  所以验收也只验这两处，不写「无票时拒绝建会话」这种做不到的用例。
- **定稿之后先列清单，谁拍板可配**（用户已确认：「可以让我看 我们可以动态配置 必须由我确认
  也可以让经理决定」）。清单写：动哪几个区、每个区派给谁、用什么模型、会开几个会话。

  | `confirmRequirementSplit` | 行为 |
  |---|---|
  | `true`（默认） | 清单摆出来，你点确认才开始建票建会话 |
  | `false` | 经理自己决定，直接铺；事后在群里和票面上看得到 |

  为什么默认 `true`：这是人**唯一还能纠正「分工错」的时机**。等到会话跑起来，
  钱已经花出去了。要图省事就关掉，代价是只能事后发现。
  这一跳是插件自己执行的（不是经理的工具调用），所以「停下来等人」是天然能做的——
  不像 AI 会话跑到一半没法挂起（见第五节、阀门四那两处说明）。
- **分配由「经理」做**（用户已确认：「有一个经理 员工统筹 这个会分配给谁干」）。
  **根经理**不是新岗位类型，就是现有的**派单窗口**——它本来就叫「接定稿方案、拆任务、派出去」
  （`shared/role-prompts.ts:57-74`）。这一轮给它补的是**名册**：看得见这个工作区里有谁、
  各自管哪片、各自用什么模型，于是它派活时能写清 `staff`。
  一条活落到谁头上，是经理的决定；名册是它的候选名单。
  **局部经理**是名册上的另一种卡（`kind: "manager"`），只管你指定的目录，下一节展开。
- **经理只能在名册里选**：卡片 id 不在名册里 → 派单拒绝（`unknown-staff`）；
  **名册是空的 → 照旧按难度路由派，只在计划里带一条警告「还没建名册」**（见下一段）。
  名册非空、但这条任务没写 `staff`，或写的卡不在名册里 → 拒绝。
- **你随时可以覆盖**：在会话里说「这件事派给前端」，经理照办；组织架构（谁在名册上、
  管哪片、用什么模型）始终是你定的，经理只管日常分配。
- **人在环上的位置**：探讨需求、确认定稿（打标签）、看一眼这次涉及哪几个区。
  逐条指派由票的归属算，不需要你点。

实现形状：一个需求跨 N 个区 = **N 个派单批次**，每个批次用它自己那个工作区的名册、
路由和派单窗口（配置是按工作区分文件的，见第九节）。票分别建在各自的仓库里，
通过父票 / `Derived from` 挂回同一条需求。

## 一、数据模型（`shared/orchestration.ts`）

```ts
/** 名册上限：一张卡就是一个工种；24 已经超过任何一个人能同时盯住的分工。 */
export const MAX_STAFF_CARDS = 24;
export const MAX_STAFF_NAME_CHARS = 32;
export const MAX_STAFF_DUTY_CHARS = 4000;   // 与 MAX_ROLE_PROMPT_CHARS 同值
export const MAX_STAFF_ID_CHARS = 64;
export const MAX_STAFF_PATHS = 20;
export const MAX_STAFF_CONCURRENCY = 8;

export interface StaffCard {
  /**
   * 稳定键；派单任务与群里的 @ 都用它。
   *
   * **建卡时生成一个与名字无关的随机键**（`staff-` + 6 位小写字母数字），人可改成
   * 小写字母 / 数字 / `-`。**不按名字归一化**——名字允许中文、emoji、重名，
   * 归一化会得到一个空串或撞成同一个 id：前者让中文名的卡静默消失，后者让两张卡互相覆盖。
   */
  id: string;
  /** 显示名，**完全由人定**：没有预置列表，中英文、emoji 都行，**重名也允许**。 */
  name: string;
  /**
   * 这张卡是**经理**还是**员工**。
   *
   * 经理 = 在自己管的那片里能再往下派活；员工 = 只干活。
   * 缺省 `"worker"`：旧文件没有这个字段，名册里全是员工，行为与今天一致。
   * 根经理不要建卡——它就是工作区的派单窗口，见第五节。
   */
  kind?: "manager" | "worker";
  /** 职责提示词 → 子会话的 systemPrompt。空 = 不写系统提示。 */
  duty?: string;
  /** 用哪份档案；不给就按这条任务的 difficulty 走路由。 */
  profileId?: string;
  /**
   * 他**在这个工作区内部**管的范围：相对工作区根的路径前缀，一行一个。
   * 空 = 整个工作区都归他（经理默认就是这个）。
   *
   * **员工和经理用同一把尺子。** 员工的领地是「他改哪片文件」，经理的领地是
   * 「他把哪片派出去」；两种卡都填这个字段，归属算法只写一份。
   *
   * 卡上**不写工作区**：名册本身就属于一个工作区（`.deck/orchestration.json` 按工作区存），
   * 一份名册里的所有卡都在这个工作区里干活。要跨区，是「需求涉及几个工作区」那件事，
   * 由票的归属决定，不由卡去认领别的区。
   */
  paths?: string[];
  /** 同一张卡同时最多几个在跑；默认 1。见「阀门二」。 */
  maxConcurrent?: number;
}

export interface WorkspaceRoles {
  workspaceId: string;
  mainAgentId?: string;
  dispatcherAgentId?: string;
  progressAgentId?: string;
  prompts?: Partial<Record<FixedRole, string>>;
  /** 岗位名册；旧文件没有这一段 = 空名册，派单行为与现在完全一致。 */
  staff?: StaffCard[];
}
```

`OrchestrationSettings`（`shared/orchestration.ts:159-171`）加两个，与 `maxChildrenPerDispatch` 相邻：

```ts
export interface OrchestrationSettings {
  // ……现有四个字段不动
  /**
   * **一批活至少铺在几张员工卡上同时干。** 1 = 不强制铺开（保持今天的行为）。
   * 目的是速度：一批五条活全塞给一个人，跟串行没区别。
   */
  minConcurrentStaff: number;
  /**
   * **需求定稿之后、铺票之前，要不要先列清单给人看。**
   * `true` = 列出来等你点确认（默认）；`false` = 经理自己决定，直接铺。
   * 只影响「需求 → 各区票」这一跳；人自己点的派单仍落在「建票那一下的确认」上（阀门一）。
   */
  confirmRequirementSplit: boolean;
}

export const DEFAULT_MIN_CONCURRENT_STAFF = 1;
export const DEFAULT_CONFIRM_REQUIREMENT_SPLIT = true;
```

放在这个位置，是因为界面上要跟「最大层数 / 单次最多派几个」挤在同一块
（`client/deck/surfaces/orchestration/RolesPanel.tsx:578-600` 的「限制」区，
`OrchStepper` 现成，`onLimits` 现成的），用户一看就知道这三个数是一起管派单的。

**名册不预置任何岗位。** 三种固定窗口之外，一张卡都没有；名字、职责、档案、领地、并发上限
全部由人填。插件不内置「前端 / 后端 / 测试」这类模板——那等于插件替你分工。

配套纯函数（都放 `shared/orchestration.ts`，与 `agentIdOf` 邻近）：

- `staffCardOf(roles, id)`：按 id 取卡，大小写归一后比较；取不到回 `null`。
- `normalizeStaffCards(value)`：trim、丢空 id、id 归一（小写、非 `[a-z0-9-]` 丢）、去重（后者覆盖前者）、
  截断超长、上限 24 张。**归一化路径只截断不拒收**——与 `promptsOf` 同口径。
- `withStaffCards(roles, cards)`：整组替换名册，其它字段原样带走。

**id 一旦生成就不跟着名字走。** 名字随便改，id 只有建卡那一刻定一次——因为 id 写在历史会话的
`deck.staff` 标签里，跟着名字漂就成了「改个名，履历全断」。

**已定：id 只读，建卡时定死，不给改入口。** 名字随便改，id 不动。理由不只是「历史会断」——
会话标签创建后**不可变**（`updateAgent` 只存在于 `DaemonClient` 上，插件侧没有改标签的调用面），
改 id 之后老会话仍挂着旧 id，履历必然分成两段，而这个后果没有任何界面能补救。
所以界面上 id 是一行灰色只读文字，旁边写一句「id 建卡时生成，之后不变」。
卡建错了就删掉重建——那比「改了 id 但历史接不上」诚实。

**删卡不清理历史。** 卡删了，它派出去的会话与回传件原样留着（标签还指着那个 id），
树与归档页照旧能看到「这是已删除岗位 X 干的活」。清理历史是另一件事，不在本方案里。

**必须同时改的两处**（漏了就是静默丢数据）：

1. `normalizeOrchestration`（`shared/orchestration.ts:977`）解析 `role.staff`；
2. `withWorkspaceRoles`（`shared/orchestration.ts:1076`）重抄 `staff`，
   并且 `keep` 判定要加上 `next.staff`——否则一个只配了名册、还没绑窗口的工作区，
   保存一次名册就整条消失。

## 二、派单带岗位（`shared/orchestration.ts` + `shared/orchestration-rpc.ts`）

- `DispatchTaskInput` 新增 `staff?: string`（卡 id）。
- 新增拒绝原因 `"unknown-staff"`：`DispatchRejection` 联合类型、`dispatchOutcomeSchema` 的
  `reason` 枚举两处都要加。
- `planDispatch`（`shared/orchestration.ts:573`）在 `empty-prompt` 判定之后插入：

  ```
  卡在名册里找不到 → reject(unknown-staff, `名册里没有岗位「${id}」：先在「名册」里加一张卡，或改这条任务的岗位`)
  卡找到 → target 优先用卡的 profileId（走 resolveRouteTarget，档案被删会明确报 profile-missing），
           卡没有 profileId 才按 task.difficulty 走路由
           卡的 duty 写进计划项的 systemPrompt
  ```

- `DispatchTask` 新增 `staffId?: string` 与 `systemPrompt?: string`（计划里就定好，执行侧不再读文件）。
- `buildChildLabels` 新增 `DECK_STAFF_LABEL = "deck.staff"`：子会话标上它是哪个岗位在干。
  会话树、归档页、群视图都靠它认人；命令行侧也能按标签筛
  （**标签值是卡的 id，不是 `true`**：`paseo agents ls --label deck.staff=frontend`；注意是 `ls`，列表里**不显示标签列**，
  只能按 `--label k=v` 或 `-a` 过滤——想「一眼看出分工」得靠插件自己的界面，别指望 CLI）。
- `server/orchestration.ts:1166` `createFor` 把 `systemPrompt` 传下去（有才传）。
- 票面：`createDispatchTicket` 的抬头补一行「岗位：前端（id=frontend）」。

MCP 面同步：`shared/tool-contract.ts:493` + `server/mcp/tools.ts:1602` 的 `deck_dispatch_plan`
每个任务加可选 `staff`，参数说明写明「没写 = 按难度路由」。

### 闸门压在哪：这决定了后面所有「拒绝」写在哪一行

现役派单是一条**三步链**，再加上插件真正拿得到的第四个位置：

```
① deck_dispatch_plan（插件 MCP 进程，纯函数）── 出计划：provider/model/标签/prompt/票面
        ↓  模型拿计划去办事
② deck_issue_create / deck_map_plan_create（插件 MCP 进程，写盘）── 建票 ← 宿主审批
        ↓
③ create_agent（宿主）──────────────────── 建会话
        ↓
④ agent.created 事件（插件服务端，有完整 PaseoApi）── 会话刚建出来那一瞬间
```

四处的真实能力（对着宿主类型核过，不是推测）：

| 位置 | 能不能拒 | 手里有什么 |
|---|---|---|
| ① `deck_dispatch_plan` | **能**（返回 `rejected`） | 只有 `{ workspaceDir }` 和 `PASEO_AGENT_ID`（`server/mcp/tools.ts:69`）。**列不出宿主会话、读不到调用者的标签** |
| ② 建票工具 | **能**（返回 `isError`） | 同上；但能读仓库里的票，所以「定稿 / 影响面」在这里核得动 |
| ③ `create_agent` | **不能** | 插件不在链上 |
| ④ `agent.created` | **不能拒，但能当场 `archive()`** | 完整 `context.paseo`：`agents.ref(id).archive()` / `.refresh()`、`agents.list()`。**但事件本身不带标签**，标签要 refresh + list 才读得到（见下） |

两条必须记住的硬事实：

- **`before agent.create` 拦不住。** 它的签名只能「改造请求」：
  `(input, ctx) => request | void`（`@getpaseo/plugin/dist/server/lifecycle.d.ts:95-97`），
  没有拒绝通道。它今天用来注入 MCP，别把它当闸。
- **MCP 进程里没有 PaseoApi。** 所以「在跑几个会话」「调用者是不是经理」这两件事
  在 ①② 里**判不了**。上一版把单例锁和经理闸放在 ① 里，那是做不到的（`ToolContext`
  只有 `workspaceDir`，`server/mcp/tools.ts:69`）。

于是闸门这样分：

| 闸 | 落在哪 | 拦法 |
|---|---|---|
| 名册里没这张卡 / 名册非空却没写 `staff` / `minConcurrentStaff` 不满足 / 层数超限 / 地图预算超限 | ① | 返回 `rejected` |
| 需求没定稿 / 影响面缺行 / 依据为空 / 要建的区没写 `region` | ② **且必须是所有建票入口** | 返回 `isError` |
| 岗位单例锁 / 只有经理能派 / 没票不许开工 | ④ | 建出来那一瞬间核对，不合规就 `archive()` 并留一条日志 |

**第四条是这一版改的：从「拦」改成「当场撤」。** 代价是会话已经建出来（付了一次创建的钱），
收益是它一秒的活都干不了，而且**这条路绕不开**——`create_agent` 走宿主，宿主管不到，
但宿主一建完必发 `agent.created`。拦不住的第 ③ 步，在这里被追回来。

**④ 的失败方向必须是「放行」**：读不到标签、`agents.list()` 报错、事件里没有 `parentAgentId`，
一律不归档、只记一条 warn。宁可漏一次，也不能把正常会话杀掉。

**④ 里读标签是一套三步，不是一句**（事件载荷 `PluginHookAgent` 上**没有** labels）：

1. `agents.ref(id).refresh()` —— 让宿主把这条会话的标签读进来；
2. `agents.list({ filter: { labels: { "deck.staff": "<卡 id>" } } })` —— 标签值是**卡的 id**
   （不是 `true`；`deck.staff` 的用途是「反查这是哪张卡干的」，值必须是 id），标签是**精确 KV 匹配**，
   只认全等，不能写 `deck.staff=*`；而且 `list` 的 filter **没有 workspaceIds 这一维**；
3. 拿到列表后在内存里按 `entry.workspaceId === agent.workspaceId` 过滤——第 2 步会把
   **所有工作区**里同时开工的 deck 子会话都捞出来，不滤这一步，单例锁会跨区误锁。

配额计数（每 6 小时最多 N 个）也走同一条路，别另写一套。

### ② 那道闸必须**堵住所有建票入口**，不能只堵一个

插件有两处会建票，而且**第二处完全绕过 `deck_issue_create`**：

| 入口 | 走哪 | 上一版有没有闸 |
|---|---|---|
| `deck_issue_create` | 逐张建 | 有 |
| `deck_map_plan_create` | **一次建「地图 + N 张子票」**，内部直接调 `ops.issueCreate`（`server/mcp/tools.ts:1297-1316`） | **没有**——影响面校验、定稿校验一个都不触发 |

所以：**把校验抽成一个共用函数**（`shared/split-guard.ts`），三处都调它：

1. `deck_issue_create`
2. `deck_map_plan_create`（每张子票都过一遍）
3. 插件自己铺票那两处（需求 → 各区、`@全部`）

**还有一层：闸得知道自己在核哪条。** `deck_issue_create` 的入参里没有需求票号、没有岗位，
闸只能去正文里找「岗位：xxx」那一行或 `Refs: #N`——模型不写那一行，它就认不出来。
所以 `createSchema`（`shared/tool-contract.ts:733-757`）补两个字段：

- `requirementKey?: number` —— 建工作票时**必填**（没有它就不许建工作票，这正是「无票不干活」）；
- `staff?: string` —— 建出来要派给哪张卡（写进正文抬头与 `deck.staff` 标签）。

闸按**入参**判，不按正文猜。正文写不写是格式问题，入参有没有是硬问题。

**仍然拦不住的**：模型被归档之后可以再建一次（每次都白花一次创建的固定开销），
以及 ④ 之前那一瞬间发出的第一条提示。这两条是宿主能力的天花板，不是漏写。
- 另一条会「先建票再建会话」的自动派单路径（`runDispatch` / `orchestrationDispatchRpc`）
  确实存在且能硬拦，但**客户端一次都没调用**（只有测试在调）。本方案的闸门**不押在它身上**；
  要不要把客户端接到它上面，是另一个决定，不在这里夹带。

## 三、名册界面（`client/deck/surfaces/orchestration/StaffPanel.tsx` 新增）

- `OrchestrationView` 的 section 联合类型加 `"staff"`，位置放在 `"roles"` 之后、`"clients"` 之前
  （名册回答「谁来做」，客户端回答「用什么做」）。
- 一张卡一行：名字（可改名）、id（只读，建卡时生成或手填）、**员工 / 经理**切换、
  档案下拉（复用 ProfilesPanel 的档案列表，留空显示「按难度路由」）、
  **管哪片**（`paths`，一行一个目录，留空 = 整片）、最多同时几个（`maxConcurrent`）、
  职责提示词（折叠，复用 RolesPanel 里那段折叠控件的形态）、删除。
- 名册顶部写明这一句：「根经理是派单窗口，管整个工作区；这里加的经理只管你指定的目录。」
  否则人会以为把列出来的都叫经理就够了。
- 顶部一个「加一张岗位卡」，上限 24 张时禁用并说明原因。
- 保存仍走 `orchestrationSaveRpc` 整份设置，**不新增 RPC**：界面本来就是整份保存的。
- 文案进 `client/deck/panel/panelText.tsx` 的 `orch.staff.*`，中英各一份。
- 群视图与名册共用同一个「岗位」概念，文案在 `panelText.tsx` 里放一处，别在两边各写一遍。

## 四、群视图（第二批确认后再做）

这批改动大，且依赖上两批，单独确认。

**群成员 = 名册上的岗位 + 三个固定窗口。** 卡不常驻，所以群里 `@前端` 的语义是
「为前端岗开一个会话，替我把这句话做掉」：

- 输入框 `@前端 …` → **先建票，不是直接开会话**：票标题 = 这一句原话，
  标签 `deck.staff=<卡 id>` + `deck.group`，正文带 `Refs: #<需求票>`，
  且那张需求票必须已打 `deck:定稿`（第一节那道闸对群同样生效）。
  **建票那一下就是阀门一**——宿主确认弹窗前你正好看得见「派给了谁」。
  建票成功后才建会话：卡的 duty → `systemPrompt`，你的整句 → 首条 `prompt`，
  卡的档案 → `provider/model`，`parentAgentId` = 派单窗口（回传链照旧）。
  **群里同样不建无票的会话**：群是派活入口，不是聊天窗口。
- 不带 `@` → 发给主窗口；主窗口没绑就报错，不偷偷改发给派单窗口。
- 广播：**v1 不做静默广播**。`@全部` 会先显示「将新建 N 个会话」再要求确认——
  一次建八个会话是八份钱，不能一键就花出去。
- 群消息：只显示「人话」（你的话 + 各会话的文本回复），工具调用折成一行 `⚙ deck_issue_list ×2`，点开才展开。
- 群成员列表 = 按标签过滤宿主会话清单（`filter.labels: { "deck.group": ... }` +
  **`filter.includeArchived: true`**，否则干完活归档的成员会从名册里凭空消失）；
  **不新增存储文件**，会话自己的标签就是成员表。
- 新 RPC `deck.group.send`：路由 + 发送/建会话 + 回落到哪个会话。

**开工前那件事已经验完（2026-11-03，探针直接跑在 `ws://127.0.0.1:6767/ws` 的活 daemon 上，
3 个会话、9 条实时事件、7 档 limit 的前后翻页）**：

- **事件形状对得上，按时间交织可行**：每条 entry 都带 `timestamp`，是 **ISO-8601 UTC 带毫秒**的字符串。
  合并只按 `timestamp` 排序，同毫秒再按 `(agentId, seqStart)` 决胜负——**不要**拿游标当排序键。
- **游标是每个会话自己的**：`{epoch, seq}`，跨会话不可比。`refetch({direction, cursor, limit, projection})`
  按会话翻页；`subscribe` **只推增量**，首屏必须自己 `refetch` 一次。
- `limit` 不精确：给 7 档都试过，返回条数会多给或少给，**不能拿它当「刚好 N 条」的契约**。
- `DaemonClient` 上有 `observeTimeline(agentIds[])`（一次订阅多个会话），但 **`PaseoApi` 没暴露**；
  插件侧只能对每个会话各 `subscribe` 一次，再把增量并进同一张表。

结论：第 6 批的实时群视图按这个做法写（每会话一个订阅 + 本地按时间戳归并）；
不需要退成「按会话分组」。

## 五、你定组织，经理派活

用户原话：

> 岗位 的分工是需要我自己分配的

> 有一个经理 员工统筹 这个会分配给谁干

两句合起来就是一家公司的分工：**组织架构（谁在名册上、管哪片、用什么模型）你定；
日常把活派给谁，是经理的事。** 前面我把它读成「每条活都由人点」，那是我读窄了。

用户又问：

> 我们现在插件的派单 不对吗？

**现有派单没问题，它答的是另一个问题。** 现在的派单答「这活多难、该用哪个模型」：
任务带 `difficulty` → 四档路由 → 档案 → `provider/model`，先建票再建会话，
带幂等键、层数上限、子会话上限、地图并发预算、父子回传。这一整套是对的，一行都不用改。

它缺**两维**，不是一维：

1. **谁做**——`dispatchTaskSchema` 里没有「人」这个字段，所以「派给前端」这句话现在没地方放；
2. **在哪做**——schema 里也没有任何路径 / 区字段（`shared/orchestration-rpc.ts:407-413`
   只有 `key / title / prompt / difficulty / map`）。而归属于哪个岗位、哪个区，
   算法（第七节）吃的是**文件路径**；任务身上既然没有路径，就**算不出区**。

上一版只补了 `staff`，却又在零节写「票落到哪个区是算出来的」——那两句不能同时成立。
这一版任务上加两个字段：

- **`region`（必填）**：`{ repoKey?: string; pathPrefix?: string }`。多仓库工作区必须给
  `repoKey`（正好补上派单 schema 缺 `repoKey` 这个老问题）；`pathPrefix` 不给 = 整片。
- **`staff`（可选）**：给了就以它为准（人覆盖机器）；不给就按 `region` 走归属算法选卡。

**票、幂等、预算、回传、父子关系全部照旧。** 不是重做派单，是给它加两列。

### 派单台是可选的，不是必需的

我前面说「界面上没有手工派活入口，所以要补一个派单台」——**这个推论下得太快。**
经理（派单窗口）本来就是干这行的。所以：

- **默认不需要派单台**。够用的是：经理看到名册 → 调 `deck_dispatch_plan` 时给每条任务写 `staff`。
- 派单台（面板表单、完全不经过模型）只在「你不想打开任何会话也能派活」时才需要，
  列为**可选批次**，你说了再做。

> **2026-11-04 已做**：用户要求全面落地，派单台已建（`shared/dispatch-form.ts` + `DispatchPanel.tsx`，
> 编排页 `dispatch` 页签）。它省掉的是「先开会话让模型调工具」那一跳，**没有省掉确认与建票**：
> 服务端仍是先建票再建会话，面板上要多点一次「确认派出」。表单层只提前拒四种必拒的情况
> （空提示词 / 名册非空没选卡 / 多仓库没选仓库 / 需求票号不是正整数），其余判定仍在服务端。

经理这边的三条：

- **看得到名册**：`deck.orchestration.state` 本来就把整份设置给出去，名册加进去以后
  它自然看得见。不必为「让模型知道有谁」另开一个工具。
- **只能在名册里选**：**名册非空时**，这条任务没写 `staff`、或写的 id 不在名册里 → 报错，
  不静默降级成「按难度随便派」。这条要钉在测试里——它是最容易被「顺手兜底」掉的一处。
  **名册是空的（一张卡都没建）是唯一的例外**：照旧按难度路由派，只在计划里带一条警告
  「还没建名册」。理由是为了让人能一张一张慢慢加卡，不是因为「选不出可以兜底」。
- **派出去的活仍回到派它的人身上**：父子关系写的是**真实调用者**（见下一节），
  所以根经理派的挂在根经理身上、局部经理派的挂在局部经理身上，每一层的账都对得上，
  不需要为「员工」另造一条汇报线。

用户已确认（2026-11-03）：**不绑派单窗口就是不能派。** 不提供「无父节点直接建会话」的旁路。

### 经理自己也有领地：全局经理与局部经理

用户原话：

> 经理 默认就是 整个工作区 等于是这个工作区 全管 能理解吗 也可以分配指定他在那个目录工作 一旦全局的那个 发现 他下面的 某一个目录也有经理 就需要他们沟通好 的 能理解吗

所以经理不是「一个工作区一个、没有领地」。**经理也有领地，而且和员工用同一把尺子**（`paths`，路径前缀）：

| | 领地 | 谁定 |
|---|---|---|
| **根经理** = 工作区的派单窗口 | 整个工作区（`paths` 留空 = 全管） | 默认，就是现在这个 |
| **局部经理** = 名册上一张 `kind: "manager"` 的卡 | `paths` 指到某个目录 | 你 |

**嵌套时怎么走：** 一条活落在 `kxhyapp.com-saas/` 下面，根经理按领地查一遍名册，
发现那张卡是**经理**、管着这个目录——这一跳就不是「派给员工」，而是**交给那个经理**。
它接手后在自己的那片里再往下派给员工。**越界不是禁止，是找人**——跟员工之间那道门铃
是同一套机制，只是对象换成了经理。

**这条现在就能跑，不用新造父子链。** 已核实的代码事实：

- `planDispatch` 里是 `const dispatcherAgentId = input.callerAgentId?.trim() || configuredDispatcher;`
  ——**放行看绑定，写父子关系看真实调用者**。
- `server/mcp/tools.ts:1656-1666` 把 `PASEO_AGENT_ID` 当真实调用者传下去，并在和
  「绑定的派单窗口」不一致时**明说一句**。
- 所以子会话派活时，它的子会话本来就挂在**它自己**身上，树是能嵌套的。

这一轮要补的只有两件：名册里多一个 `kind: "manager"`；派单前按领地判「这一跳该交给谁」，
而不是闭着眼往下派。

**层的预算**（`DEFAULT_MAX_DEPTH = 3`，可调到 6；`shared/orchestration.ts:172,1017`）：

| 结构 | 最深一层 | 默认 3 层够不够 |
|---|---|---|
| 主窗口 → 根经理 → 员工 | 2 | 够 |
| 主窗口 → 根经理 → 局部经理 → 员工 | 3 | 刚好够 |
| 主窗口 → 根经理 → 区域经理 → 组长 → 员工 | 4 | 不够，得把 `maxDepth` 调到 4 以上 |

所以**「经理最多嵌一层」在默认设置下成立**，再深要你显式调上限。这不是建议，是现实约束：
层数超了子会话直接 `depth-exceeded`，不静默降级。

### 不能老让一个人干：最少同时几个

用户原话：

> 经理 每次派活 不能老是 让一个人干 能理解吗 这块可以改一下我们能够配置 能够至少派多少个员工 同时干活 应为这样速度快

对。一批活全塞给一个人，跟串行没区别——多分工就是为了快。所以加一个可配的下限：
**`minConcurrentStaff`（一批活至少铺在几张员工卡上同时干）**，默认 1（= 不改今天的行为），
范围 1–24，就放在「限制」那块、紧挨着「单次最多派几个」。

**它实际怎么生效**（纯函数判定，放在 `planDispatch` 里）：

```
目标人数 = min(minConcurrentStaff, 这批的任务数)
                         ↑ 只跟任务数取小，**不跟名册容量取小**
```

上一版这里写成了「再跟名册容量取小」，那样名册不够时会悄悄降级成能派几个算几个，
跟下面例外二「不够就拒绝」直接打架。改正：先算目标，再**校验**名册撑不撑得住。

判定顺序（全部在 `deck_dispatch_plan` 里，不给计划就没有「拒绝」以外的结果）：

1. **任务比人少**：一批只有 2 条活、你配了「至少 5 个」→ 目标按 2 算，不报错。
   **想把一条活拆给三个人，是经理的活，不是插件的活**：它决定怎么拆、拆得对不对；
   插件只核对「计划里确实铺开了几个人」，不替它编任务来凑数。
2. **名册不够大**：可接活的员工卡数量 < 目标人数 → **拒绝这一批**，并说明
   「名册只有 2 张能接活的卡，配置要求至少 3 个同时干：加人，或把这个数字调小」。
   不静默降级——降级之后你以为在并行，其实没有。
3. **计划没铺开**：计划里落在**不同卡**上的任务数 < 目标人数 → **拒绝**，
   说明「这批 5 条里有 4 条都在 X 一个人手上，配置要求至少 3 个同时干」。必须硬拦。
   这是这个设置唯一真正起作用的地方。

**「人」按卡算，不按 `maxConcurrent` 算。** 上一版写过「一张卡把 `maxConcurrent` 调到 N
也算 N 个人」——那是把「并发槽位」和「分工」混成一件事，跟例外三直接冲突。
统一成：**目标人数数的是不同的卡**；`maxConcurrent` 只管「这一张卡能同时跑几个任务」，
再多也只算一个人。

**成本要说在前面**：这个数字直接乘进花的钱。默认 1 是为了不改现状；
你调成 3，就是每批活默认开三个会话。界面上把这个数叫「至少同时派几个」，
和「单次最多派几个」并排，一个管下限、一个管上限。

### 现在谁能派单（这道闸今天很松）

已核实：`planDispatch` 只要求「这个工作区绑了一个派单窗口」就放行，
**任何**有这个工作区 deck 工具的会话都能调 `deck_dispatch_plan`——包括员工。
一旦名册有了经理/员工之分，这道闸就显得太松了：员工也能派活，组织图就没意义了。

所以第 3 批要补一条：**调用者的 `deck.staff` 标签指向的卡不是经理 → 不许派**。

**这条也判不了在 ①**（同一节开头那条硬事实：MCP 进程只拿得到 `PASEO_AGENT_ID`，
拿不到它身上的标签）。所以落点在 ④：

- `agent.created` 里，新会话的 `parentAgentId` 指向一个**员工卡**的会话 → 把新会话 `archive()`，
  并给那个员工发一句「你不能派活；要人手发 `deck_staff_request`」；
- 根经理没有卡，不拦；人从面板手工派没有父会话，不拦。
- **不写一个 ① 层的假闸**：读不到标签就判不了，写进验收只会变成一条永远跑不绿的用例。

### 员工要人手：不能自己派，但可以问经理

用户原话：

> 员工需要拉人分工 可以问经理

所以不是把员工拦死，是**给员工留一条正规通道**：

- **员工不能调 `deck_dispatch_plan`**：拒绝，理由写清「你不能派活；需要人手就发一条请求给经理」，
  并把工具名指给它——拒绝必须给出下一步，否则它只会换个写法硬试。
- **员工有 `deck_staff_request`**：说明「我需要人手 / 这块该由别人做」，带三样——
  要什么（一句话）、为什么（越界？量太大？缺我不具备的权限？）、建议交给谁（可空，从名册里选）。
- 请求落进**同一个协调收件箱** `.deck/coordination.jsonl`，只多一个 `kind: "staffing"`
  （越界那条是 `kind: "territory"`）。一个收件箱，人只要看一处，不用记两个地方。
- 经理（根经理，或那片归他的局部经理）收到后三选一：
  **派人**（按建议或自己挑一张卡，走正常派单、票照建）／**不派**（回一句原因，员工继续做
  自己能做的部分）／**转给别的经理**（这条其实归另一个区）。
- 回话走 `sendToAgent`（`server/session.ts:509`），直接发回发起会话，**不改它的父子关系**。
- **写请求时顺手叫醒经理**（否则这条请求要等某个不知情的人打开收件箱才被看见）：
  落盘的同一个动作里，找到那张经理卡的会话（没有活的就发根经理的派单窗口）并 `sendToAgent`
  一句「员工 X 要人手：…」。**只发一次，不重试**，发不出去就只留一条 warn。
- **24 小时没人处置 → `cancelled` + 群里点一条**（见上面状态机）。通道不能只靠人自觉。
- **员工发完请求不空转**：提示词里写清「先把不属于别人的部分做完，等经理回话」。
  代码层不自动「暂停这一轮」：能 `interrupt`（`send(..., {activeTurnBehavior:"interrupt"})`），
  但**没有可恢复的挂起**——打断了就得人再让它接着做，所以这里不打，让它自然收尾。

一句话：**派活只有一个入口（经理），提需求不设门槛。**

## 六、`@全部`

用户要，做。语义：**一条需求铺到名册上每一个区**，每区一张票、派给那个区的员工。

- 提交前弹一次确认，写明「将建 N 张票、N 个会话、分别是哪个区、哪个员工、哪个模型」——
  这是唯一一个一键花 N 份钱的入口，确认弹窗只做汇总，不额外要求输入。
- **为什么只弹一次而不是 N 次**：铺票由**插件自己执行**（和需求铺票同一条路，见第一节
  「这一跳是插件自己执行的」），不是模型逐张调 `deck_issue_create`。所以这里**没有** N 次
  宿主确认——闸就是这一屏。模型自己走「② 逐张建票」那条路时，才是每张一次宿主确认。
- 某张卡失败不影响其它卡：逐条返回，成功的留、失败的报原因（与派单的逐条结果同形）。
- 名册为空时不给这个入口，也不静默退化成「发给主窗口」。
- 同样受「无票不干活」约束：`@全部` 必须先有需求号。

**三处表述统一成一份**（上一版这里、第五节清单、第八节确认卡各写了一遍，措辞不同）：
`@全部` = **一次铺票 + 一次确认**。确认的那一屏就是「每区一张票、派给谁、用什么模型、
一共开几个会话」；`confirmRequirementSplit` 为 `false` 时，这**同一屏**改成事后可查的记录，
不再等确认。「先显示将新建 N 个会话再要求确认」和「跟 @全部 共用同一张确认卡」说的是这一件事。

## 七、记忆

岗位卡不常驻，会话干完就归档，所以「这个岗位上次干过什么」不会自己留在上下文里。
不解决这条，名册上就是二十个每次从零开始的陌生工。

### 群 bot 的三层设计（不是发明，是 IM 里那套的骨架）

1. **唤醒层**：群是广播域，消息落到群里；**只有被 @ 的成员被唤醒**，没被 @ 的消息不进它的上下文。
   不做这条，群里每句话都会喂给每个 bot，钱和噪声一起爆炸。
2. **上下文层**：每次唤醒时**现拼**上下文——岗位说明 + 群里与它相关的那几条 + 检索到的长期记忆。
   不维护一个常驻的对话状态：会话是执行单元，不是记忆单元。
3. **记忆层**：聊天记录只存**索引**（谁、什么时候、说了什么、在哪个会话里）；
   真记忆是**结构化产物**——票、回传件、代码、文档。长期记忆用摘要 + 指针，不留原始流水。

一句话：**bot 没有「记忆」，只有「每次现拼时能找到的东西」。**

### 我们已有的三种记忆（已核实）

| 记忆 | 存哪 | 现状 |
|---|---|---|
| 子会话的自述 | `.deck/handoffs/<agentId>.json` | 已有，`server/handoff-store.ts:15,54`；按 **agentId** 存，没有岗位维度 |
| 票 ↔ 会话的台账 | `~/.paseo/**/workspaces/<id>.json` / `agents/<id>.json` | 已有，`server/ledger.ts:91-112` |
| 这件事本身 | GitHub / GitLab 的票 | 已有，派单强制先建票 |

**缺的不是存储，是索引键。** 第 1 批加的 `deck.staff` 标签不只是给人看的标识，
它是「按岗位反查历史」的唯一键——没有它，履历只能按会话一条条点开。

### 这一批要加的

1. **岗位履历（检索，不存储）**：派单时若任务带 `staff`，读该岗位最近的回传件
   （按 `deck.staff` 标签反查会话 → 读 `.deck/handoffs/<agentId>.json`，取最近 5 条）
   加未关闭的票，拼成一段「你在本项目此前做过什么」放进 `systemPrompt` 的末尾。
   缺省上限 2000 字，超了按时间截断并留一句「更早的没列」。
   **不写摘要文件、不做向量库**：检索式记忆在这个体量下够用，摘要文件会变成第二个真相源。
2. **群记录（索引，不是真相）**：`.deck/group/<workspaceId>.jsonl`，一行一条
   `{ at, from(人/岗位 id), agentId, kind: "user" | "staff", text 摘要或消息 id }`。
   群视图读它，唤醒时也读它。**会话的 timeline 仍是真相**，这份文件删了只丢展示，不丢事实。
   保留策略：只留最近 **5000 条 / 90 天**，超出的在下次写入时裁掉并留一行「更早的已裁剪」；
   不归档、不压缩——它不是账本。

### 这一批已经验过的两件事（上一版写的是「未验」，现在有答案了）

1. **归档后的会话读得到**：`agent-loading.js:24-54` 的加载路径上**没有 `archivedAt` 这道门**，
   归档只影响列表的默认可见性，不影响按 id 取回。所以 `timeline.refetch` 能读。
   仍然按「回传件优先，timeline 只做补充」写——回传件是插件自己的格式，不随宿主升级变形。
2. **但列表默认看不见归档的**：`includeArchived` 在 `filter` 里面，不是顶层参数，
   且不传就是看不到归档的（`fetch_agents_request` 的 `filter.includeArchived?`）。
   履历反查、群成员表这些「按 `deck.staff` 找历史」的地方必须写成
   `agents.list({ filter: { labels: { "deck.staff": id }, includeArchived: true } })`，
   否则查出来的只有活着的那些，履历永远是空的——这种错不报错，只是安静地少一半数据。
   （同一个 `filter` 里还有 `includeInternal`：插件自己的内部 helper 会话默认不列，
   要不要算进履历是另一个决定，别混着改。）

## 七点五、阀门（保险）

用户原话：

> 例图上面的问题 需要增加一个阀门 处理这些问题吧 增加一个保险

前面那两种乱靠提示词只是「劝」，不是「拦」。这里给三道真的会拦住东西的阀门，
每一道都写清它拦得住什么、拦不住什么——不写清就等于假装有保险。

### 阀门一：确认卡已经有一张了——就是建票那一下（不再造第二张）

上一版这里设计了一张独立的「开派前确认卡」。**核下来不需要**：现役派单的第二步
就是 `deck_issue_create`，而它是写操作、**宿主本来就要人点一次确认**
（`server/mcp/tools.ts` 的写工具都不在 `PREAPPROVED_TOOL_NAMES` 里）。

所以这一条改成**把票面抬头写够**，让那一次确认真的能看出「点错人」：

| 抬头里必须有 | 为什么 |
|---|---|
| 工作区 / 仓库（`repoKey`） | 多仓库工作区里，「哪个区」是第一眼要看对的 |
| 岗位名 + id | 「后端的事派给了前端」在这一行就看得见 |
| 档案（provider/model） | 确认这一下花的是哪个模型的钱 |
| 任务首行摘要 | 确认这一票就是你想的那件事 |

**派单台如果以后要做**（可选批次），它省掉的是「开会话」，不是「确认」：它也必须先建票，
于是确认照旧落在同一步。**不再有第二张确认卡。**

**群里 `@名` 也先建票**（第四节），所以同一个确认点把「群里点错人」一起覆盖了——
这也是为什么群那条路不能做成「直接开会话」。

确认点有两种形态，别把话说成只有一种：

| 谁在铺票 | 确认落在哪 |
|---|---|
| 模型（逐张 `deck_issue_create`） | 宿主的确认弹窗，**每张一次** |
| 插件自己铺（需求 → 各区、`@全部`） | **插件自己的那一屏汇总**（`confirmRequirementSplit` 那张卡），一次覆盖 N 张 |

两者都是「人点过一次才花钱」，只是第二种的弹窗是插件画的，不是宿主画的。

**经理自己派活时没有人按确认**——这是设计的取舍：经理存在的意义就是去掉这一步。
它那条路的约束是另外三条：

1. 只能在名册里选（`unknown-staff`），名册非空时必须写 `staff`；
2. 一批最多 `maxChildrenPerDispatch` 个，且要满足 `minConcurrentStaff`；
3. 每一跳先建票、留台账，事后能逐条查；
4. **按工作区的滚动额度**：`每 6 小时最多 N 个 deck 子会话`（默认 12，界面可调）。
   超了在 `agent.created` 上核对并 `archive()`（**不是**在 `deck_dispatch_plan` 里拒——
   ① 数不出在跑几个，见下面阀门二）。理由：单批上限（24）只管一次，
   经理连着派十批谁也拦不住；上限乘上次数才是真正的花费。这条是 `agent.created`
   上数的（同一批事件里既管单例锁，也管额度）。

**「需求 → 各区票」这一跳仍单独有人工确认**，可开关——`confirmRequirementSplit`，默认开
（见第零节）。它管的是「把定稿的需求铺到各区」那一下，覆盖不了「经理日常派单」。

### 阀门二：岗位单例锁（拦「同一批文件被两个会话改」）

名册每张卡带一个 `maxConcurrent`，默认 **1**。

- **落在 `agent.created` 上核，不在派单工具里核**：`deck_dispatch_plan` 跑在 MCP 进程里，
  拿不到宿主会话清单（`ToolContext` 只有 `workspaceDir`，`server/mcp/tools.ts:69`），
  在 ① 里数「在跑几个」是做不到的（上一版写在那，是错的）。
  改成：会话建出来那一刻读它的 `deck.staff` 标签，数同标签在跑几个，超了就 `archive()`；
- 门禁效果：超额的那个会话**活不到第一轮**，并在日志与群里说明「前端已有 1 个在跑（会话 abc123），这张卡上限 1」；
- 读不到标签 / 列不出会话时不归档，只记一条 warn（**失败方向是放行**）。
- 人把上限调成 2 才允许并行——**默认不并行**，这是保险的默认值。
- 机械判定，不看内容、不猜文件域，所以不会误伤。

### 阀门三：领地 + 跨区找邻居（不是墙，是门铃）

用户原话：

> 总体 就给员工似的 他负责那个区 然后跨区了 需要给那个区的员工协调 能理解吗

这就是设计的正解：**每个人有自己管的区（领地），越界不是「不许动」，是「得找那个区的同事」。**
所以这道阀门不是一堵墙，是一个门铃。

**区 = 工作区**（用户已确认：「工作区 是工作区」「一个工作区 有多个员工的」）。
一个工作区可以坐着一屋子人，所以「谁管这片」还要再落一层：卡上的 `paths`。

**归属怎么算**（纯字符串，不猜语义，**先经理层、后员工层**）：

1. 先看这条路径落在**哪个工作区**的根目录下 → 该工作区的名册说了算；
2. **经理层先算**：在所有 `kind: "manager"` 的卡里取 `paths` 最长前缀命中者；
   都没命中 → 根经理（它默认管整片）；
3. **再在命中的那个经理的领地内找员工**：只看领地被它覆盖的员工卡，同样取最长前缀；
   没有员工命中 → 这片归**这个经理自己的那个会话**干（经理窗口本来就能写码，根经理今天
   就在干这活），不另开一个员工会话——「经理只派活」说的是它不替员工改代码，
   不是它手上没有会话；
4. 一条路径不属于任何工作区 → 无主；落在某个工作区但没人声明这片 → 也算无主。都走确认。

**为什么必须「经理层优先」，而不是所有卡一起取最长前缀**：上一版就是一起取的，
于是「经理管 `saas/`、员工管 `saas/src/x/`」时，一条活落在 `saas/src/x/a.ts`，
最长的命中是**员工**——根经理直接派给他，局部经理被整个跳过，而且**不报错**。
票照建、钱照花，你以为中间那层在管，其实没有。先算经理层就不会跳层。

（前缀比较一律吃到 `/` 边界：`web/` 不吞 `web-admin/`，`server/` 不吞 `server-old/`。
名册里只有一张卡、或只有一张卡填了 `paths`，就是它。）

**命中的不同层，含义不同**：命中员工 = 这片归他改；命中经理 = 先问那个经理
（**它自己干，还是派给它领地里的员工**，由它定），不是「别动」。
两种都不叫「禁止」，区别只是下一步找谁。

**同一把尺子，两个用法**：派单前用它判「这一跳该交给谁」，运行中用它在权限请求上判
「这条路径归谁」。两处调的是同一个纯函数，免得「派单时认为归 A、写文件时认为归 B」。

**越界时发生什么**（`edit` / `write` 且 `filePath` 不在自己负责的区里）：

1. 权限请求被拒（`behavior: "deny"`），给发起方的说明是「这片归 X，去跟 X 协调」，不是「禁止」；
2. 插件生成一条**协调请求**投到群里：

   > 前端 → 后端：需要改 `server/api/user.ts`（后端的区）
   > 原任务：给登录接口加上验证码校验　｜　发起会话：abc123

3. 人在**收件箱**里有三个按钮（第 4 批先在编排页里给一个列表，第 6 批群视图复用同一份行组件——
   不能等到群视图做完才有地方按）：
   - **批准这一次**：一次性放行，不改变领地，日志留痕；
   - **交给后端**：把这条请求作为任务转派给该区的岗位（新建或续用它的会话），原文带过去；
   - **驳回**：原会话收到「这片归后端，**去协调**」并继续做自己的活。
4. 没人管的路径（不属于任何卡）→ 不算「别人的区」，但也不算自己的：**弹确认**，不当成放行。

协调请求落在 `.deck/coordination.jsonl`，一行一条，重启不丢：

```
kind: "territory" | "staffing" | "contract"     // 越界 / 要人手 / 契约对不上（见第五、十节）
{ at, kind, workspaceId, fromStaff, toStaff | null, paths[], sessionAgentId, taskSummary,
  need?,          // 仅 staffing：要什么人、为什么
  field?,         // 仅 contract：哪一条字段/路由对不上
  state }
state: "pending" | "approved-once" | "consumed" | "reassigned" | "denied" | "staffed" | "declined"
     | "contract-changed" | "impl-changed" | "superseded" | "cancelled"
```

三种 `kind` 共用一份文件、一套状态机：

- `territory`：`pending → approved-once → consumed | reassigned | denied`
- `staffing`：`pending → staffed | declined`
- `contract`：`pending → contract-changed | impl-changed`（「两边都改」先按 `contract-changed` 记）
- 任何 `pending` 都可以 → `superseded` / `cancelled`（见下）

**`approved-once` 到底「这一次」是什么**（上一版没定义，等于没写）：

- 粒度 = **（`sessionAgentId`, 归一化后的路径）**，不是「一次调用」；
- 用掉一次就转 `consumed`，下次同会话再写同一路径要重新点；
- 归一化 = 相对工作区根目录、折叠 `.` / `..`、大小写按文件系统实际值；
- 一批 20 个文件落在别人区 → **按（会话，目标区）聚合成一条请求**，不是 20 条，
  「批准这一次」也是整批放行一次。

**两个终态补的是「人不动」的可能**：

- `superseded`：同会话同区更早的 pending 被新的一条覆盖（重试不刷屏）；
- `cancelled`：目标卡被删、需求被关、或超过 24 小时没人处置 → 自动转 `cancelled` 并在群里点一条。

**一个收件箱**，是因为人只有一双眼睛；分成三个文件，最后一定有两个不被打开。

**界面怎么读到这个文件**（上一版漏了，会卡在「客户端根本拿不到工作区文件」上）：
客户端跑在浏览器 / 宿主 UI 里，**没有文件系统访问**。所以 `.deck/coordination.jsonl`
必须由一个 RPC 吐出来，形状与现有编排 RPC 一致：

- 契约加在 `shared/orchestration-rpc.ts`（新方法，别塞进已有方法里改形状）；
- handler 加在 `server/rpc/orchestration.ts`，读文件 + 过状态机；
- **必须在 `server/rpc/register.ts` 里 `server.handle(...)` 挂上**（`server/rpc/register.ts:140-228`），
  否则前端拿到的是 `Unknown RPC method`——这一步最容易漏，它不在「看起来相关」的文件里。
- 三个按钮（批准一次 / 转派 / 拒绝）各自也是一个 RPC，**写请求不能由客户端直接落盘**。

`toStaff` 由上面的归属算法算出，也可能是 null（无主区）。**插件不判断该不该改，只判断归谁管**——
归属是确定的，价值判断不是。

**可选自动转派**：同一个工作区内，归属唯一时可开「自动转派给该区岗位」，默认**关**。
开了等于越界一次就自动为隔壁开一个会话——那是花钱，必须由人主动打开。

**这道阀门的真实强度**：`ToolCallDetail` 确实带 `filePath` / `command`
（`@getpaseo/protocol` `agent-types.d.ts:174-201`），`AgentPermissionRequest.detail` 就挂在请求上
（同文件 `408-420`）。**哪家填了 `detail`**：claude 填——它在 `providers/claude/agent.js:1732-1758`
把工具入参映射成 `{type:"edit"|"write"|...}`，并带 `filePath`；认不出的工具名给
`{type:"unknown"}`（那就等于没有归属证据）。cursor 不填（实测）。codex / opencode 这一版仍未验。
`detail` 缺失或 `type:"unknown"` 时就**判断不了归属**，
一律退回人工确认（不自动放行、也不自动拒绝）。这道阀门是「有证据就按规矩走，没证据就找人」，
不是「保证拦住所有越界」。

**和「自动放行权限请求」的冲突：能解，但顺序是硬条件。** 那道开关
（`server/hooks.ts:167` 的 `AUTO_ALLOW_KINDS = tool | other`）在 deck 工作区里替用户
**一律点头**，而越界写正好落在 `tool` 那一类里。两个处理函数挂在同一个
`agent.permission_requested` 上——上一版写「这个顺序我没验过」，这一版验了：

- 同一个插件注册的处理函数存在 `Map<name, Set<handler>>` 里
  （`@getpaseo/plugin/dist/server/plugin-process.js:27`），`lifecycle/index.js:158-167`
  按**注册顺序串行 `await`**，没有 priority 参数。顺序 = `registerHooks()` 里的代码顺序。
- 所以：**先注册领地判定、并在它的处理函数里 `await` 完整个判定，再注册自动放行**，
  领地的 deny 就会先落地；后面那条 allow 到达宿主时，那条权限请求已经不在了，
  claude / acp 两个客户端都抛 `No pending permission request with id`
  （`providers/claude/agent.js:2241-2243`、`acp-agent.js:1641-1644`），插件侧按 warn 吞掉
  （`server/hooks.ts:303-306` 已有的分支）——**deny 不会被翻回 allow**。
- 两个前提要写进实现里，缺一条就退回「拦不住」：① 两个处理函数必须在**同一个插件进程**里
  （跨插件没有顺序保证）；② 领地那条必须**真的 `await`**，不能 fire-and-forget 地扔出去。

第 4 批的验收里固定两条：开了自动放行时「越界 → 仍是 deny」，以及日志里出现一条
`No pending permission request`（那是顺序生效的正面证据，不是错误）。

### 阀门四：全停（出事了先止血）

一个「全部停手」按钮：把当前工作区里所有 `deck.staff` 会话逐个拒绝当前权限请求
（`behavior: "deny"` + `interrupt: true`），并可选归档。

- 协议里有这个能力：`AgentPermissionResponse` 的 deny 分支带 `interrupt?: boolean`
  （`agent-types.d.ts:426-431`），句柄上有 `archive()`
  （`@getpaseo/client` `index.d.ts:304`）。
- **打断正在跑的一轮是真的有 API**：`agents.send(..., { activeTurnBehavior: "interrupt" })`
  （`@getpaseo/client` `daemon-client.d.ts:165-166`，`server/session.ts:477-485` 已经在用）。
  所以阀门四其实是两条腿：一条 `send(interrupt)` 掐掉正在跑的一轮，
  一条 `respondToPermission(deny)` 撤掉它正在等的那个确认。
- **没有**的是「暂停 / 挂起」（pause / suspend）：会话只有「在跑 / 不在跑」，没有可恢复的挂起态。
  按钮提示里写「停手」可以，写「暂停，回头接着跑」不行。
- 「可选归档」那条副作用要说清：归档一个父窗口会**连坐归档它派出去的同区子会话**
  （`agent-manager.js:1164-1176`，没开标签页的那些）。对「全停」来说这是想要的效果——
  但也意味着别顺手归档派单窗口，否则下面的活会一起没。

## 八、谁会收到话：这层闸在哪（「乱」的问题）

用户原话：

> 有管理员吗 bot 的模式 因为不能问题是后端的 发群里 前端也在那处理 这是不是就乱了 这怎么处理的呢？

在 IM 里确实会乱，因为 bot 是**常驻成员**：它在群里，读得到群消息，谁先抢到谁答。
多数产品的解法是「只有被 @ 的 bot 才收到投递」，但那只靠平台遵守，bot 本身仍在那儿。

我们这里结构上更硬：**岗位卡不是常驻成员，它平时不存在。**

- 群里一条消息只有被 @ 到的岗位**才会被建出会话**。没 @ 的岗位不建会话，**
  因此不存在「它也看到并且开始处理」这种可能**——它的上下文里根本没有这条消息。
- 没 @ 任何人 → 只投给主窗口，不投给任何岗位。
- 会话之间**不共享上下文**：前端的会话读不到「给后端的那条」。这不是靠纪律，是靠它们本来就不是同一个进程。
- 所以插件就是这个群的管理员：它决定谁被唤醒、唤醒时给什么上下文。
  没有第二个「分派 bot」，也不需要——唤醒动作本身就是分派。

### 真实存在的两种乱，以及处理

1. **人点错人**：后端的事 @ 了前端。系统不去猜对错（那又变成模型替人分工），
   但每张岗位卡的默认职责提示词末尾固定加一句：
   「如果这件事不属于你的职责，说明它该找谁，不要动手。」
   同时群里那条消息的抬头写明「这条是发给前端的」。
2. **一次点了两个岗位，两边改同一批文件**：这是分工本身的冲突，不是投递冲突。
   处理：一条消息一个目标；要并行就给两个**不同文件域**的任务，并在群里各自说清改哪里。
   系统不替你判「文件域互斥」——猜错比不猜更贵，走票面写清楚。

## 九、多工作区协调

用户原话：

> 按照工作区 但是 就像如果多喝工作区 可以 互相协调 能理解吗 ？

核实过：编排配置是**按工作区目录**存的 `<工作区>/.deck/orchestration.json`，
文件里还写着所属 `workspaceId`（`server/orchestration-store.ts:16-22,58-81`）。
所以「名册按工作区一份」是多开工作区之后的两份独立名册，天然不共享。

协调方案（2026-11-04 按用户指令改过一版：**一个项目一个群**）：

1. **群按目录分**：一个目录一个群。群页只读**当前目录**的名册、群记录与会话，成员栏只列本目录
   名册上的人。原 v1 第 1 条「群能同时看多个工作区、成员表按工作区分组列人」**作废**——
   那样做等于把几个项目的群并成一个，用户 2026-11-04 明确否掉了
   （「我们每一个项目 都要有独立的群」「你不能把插件 只能一个群啊」）。
   群标签 `deck.group` 的值写**目录**（`path.resolve(workspaceDir)`），不写 `workspaceId`：
   同一目录在宿主里每次重开都换一个 id，标签写 id 会让成员在换 id 之后集体从群里消失。
2. **发话时从名册里选人**（点选成员，不是解析写死的文本格式）；
   想用文字 `@` 也行：先按你给的名字匹配，重名时弹出候选让你点，**不自动加后缀**——
   后缀怎么写、叫什么名字，是你的事，不是插件的约定。
3. **派活不跨区建会话**：`createAgent` 必须带 `workspaceId`，不带时宿主会为同一目录另登记一条工作区
   （`server/orchestration.ts:1174` 已因此固定传 id）。所以一条任务始终落在一个工作区里。
   跨区协作 = 同一张地图下**两张票、两批派单**，各自回传到各自的派单窗口。
4. **共同的记账**：地图引用本来就支持跨仓库（`normalizeMapRef` 接受 `owner/repo#N`，
   `shared/orchestration.ts:193`）。「一个需求两边都改」就是一张地图 + 两张票，
   进度按**需求票号**汇总（群页填需求票号就能看，`GroupProgress` 按仓库分列并排显示）。

### 先选形状：父目录一个工作区，还是一个仓库一个工作区

用户 2026-11-04 问的是 `kexin/` 这种「一个目录里两个仓库」
（`kxhyapp.com` + `kxhyapp.com-saas`，用户原话：「他们是一个整体项目 怎么协调开发的呢」）。
两种形状都成立，但只有一种和「一个项目一个群」对得上：

- **A、父目录一个工作区（整体项目用这个）**：`kexin/` 一个目录 = 一个群、一张名册、一个派单窗口。
  两个仓库的活按岗位卡上的 `paths` 分（`kxhyapp.com/apps/...` 给客户端的人，
  `kxhyapp.com-saas/apps/...` 给 saas 的人）。一个需求碰到两个仓库 = **一批派单、两张票**，
  票面各自标 `repoKey`——批次是按**工作区**分的，不是按仓库分的
  （`server/requirement-batch-plan.ts`）。越界照样走门铃：同一张名册里按路径找那段归谁。
  **这条路上用不到跨区父链**：全在一个 `workspaceId` 里，父子链天生同区。
  前提是父目录有 `.paseo-deck.json` 的 v2 `projects` 清单，把两个仓库都列进去。没有它，
  插件把父目录当成一个本地单仓库（`server/tracker/targets.ts:152-211` 的回退），
  票落不到那两块 GitHub 板，多仓库校验也会整段跳过（`repoKeys` 是空数组）。
- **B、一个仓库一个工作区**：父目录、子目录各开一个工作区、各一份名册。这时才需要下面的
  跨区父链、跨区批次、门铃找隔壁区；一个需求跨两区 = **两批派单、两张票**。

B 的机制不能因为选了 A 就拆掉：仓库随时可能被拆成两个工作区打开，B 是兜底形状。
A 的代价也写清：所有人在一张名册上（成员栏会比一栏长），两个仓库共用一个派单窗口。

以下都是形状 B 的机制（形状 A 用不到，但留着兜底）。

**跨工作区就是「跨区」本身**，走的还是同一个门铃。一个会话的 `cwd` 是甲区，
它要改乙区的文件，就是越界 → 生成协调请求，`toStaff` = **乙区名册里
领地覆盖这条路径的那张卡**（卡上不写工作区，见第一节：名册本身属于一个工作区，
所以「乙区那张卡」就是「去读乙区的名册，按归属算法找」）。
转派到乙区时新建会话必须显式带乙区的 `workspaceId`，**并且设跨区父链**（回传落到派它的
那个窗口；取证结论见下，同 daemon 内一律设，跨 daemon 才退回「不设父节点 + 票状态可见」）。

**跨区父链：做（上一版写「不做」，是被「没验证过」吓住了；这一版去验了，能做）。**

取证结论（对着 `@getpaseo/protocol` / `@getpaseo/server` 的实现核的）：

- 父边的身份就是子会话记录上的一枚标签 `paseo.parent-agent-id`
  （`@getpaseo/protocol/dist/agent-labels.js:1-2,10-15`），**协议里没有 workspace 这一维**；
- daemon 建会话时把调用者 id 直接写进这枚标签，**不比对 `workspaceId`**
  （`@getpaseo/server/dist/server/server/agent/create-agent/intent.js:3,8`）；
- 「落哪个工作区」和「父是谁」是两条互不相干的判断（`intent.js:17-26` `resolvePlacement`）；
- daemon 自己就把跨工作区父子边当成正常情形：`shouldDetachFromArchivedParent` 里有
  `const isCrossWorkspace = parent.workspaceId !== child.workspaceId` 这个分支
  （`agent-manager.js:268-273`）；
- 回传是「按 agent id 往本地 daemon 的某个会话 `send`」
  （`server/report.ts:220`），既不带也不查 `workspaceId`；
- 磁盘上**已经有**一条跨工作区父边（2026-11-03，两个不同 `workspaceId` 的记录，
  子会话带 `paseo.parent-agent-id`）——宿主接受并落盘过。

所以：**同一个 daemon 内，跨区一律设父链**，回传落到派它的那个窗口。

两条边界，写清不装：

- **跨 daemon 不行**：`callerAgentId` 只在本机解析（`.../server/session.js:3280-3287`），
  跨 host 建会话会直接抛 `Caller agent … not found`。遇到跨 daemon 的区，
  退回「不设父节点 + 票状态可见」，并在计划里点名说明。
- **会话树里那条边看不见**：`readOrchestrationState` 按 `workspaceId` 过滤会话
  （`server/orchestration.ts:486-503`），父会话不在本区列表里，
  `shared/orchestration.ts:860` 的 `index.has(parentId)` 就不成立——
  跨区子会话在**两边**的树里都显示成根节点。功能不受影响，但界面会骗人。
  补法：树在拼装时对「有 `paseo.parent-agent-id` 但父不在本区」的节点标一个
  「跨区 ↹」，不强行塞进树里。
- **父会话归档时，子会话有两个结局，都不是「报错兜底」**（这一条上一版写错了）。
  daemon 的处理在 `agent-manager.js:1164-1176`，二选一：

  - **子会话已归档（最常见）**：父归档时，**同工作区、且子会话没有开着的标签页**的子会话
    会被**一起归档**（`archiveAgentUnlocked` / `archiveSnapshotUnlocked`）。它连跑都跑不了，
    谈不上回传。
  - **摘掉父标签、继续跑**：只有「跨工作区」或「子会话有开着的标签页」时才走这条
    （`shouldDetachFromArchivedParent`，`agent-manager.js:268-272`）。摘标签由
    `detachedAgentLabelPatch` 做（把 `paseo.parent-agent-id` 置 null，`:274-281`），
    于是 `server/hooks.ts:313` 的 `if (!agent.parentAgentId) return;` 直接返回——
    **一条日志都不会留**。

  `report.ts` 里那段兜底（`report.ts:231-243`）只有 `send` 抛错才走得到，
  上面两条路都走不到。所以：

  - 照旧保留 `report.ts` 的兜底（父还在但不可达时有用）；
  - 把「归档父窗口 = 连坐归档它派出去的同区子会话」写进界面文案——这是宿主的默认行为，
    不是我们的选择，用户必须知道按「归档」会捎带走一片；
  - 另外加一条：`agent.created` 见到 `parentAgentId !== null` 时把「子 → 父」记进
    `.deck/coordination.jsonl`，链断了也有据可查；
  - 界面上不承诺「子会话一定回传」，只说「父窗口还在时回传」。

### 核实过的实例：`/www/wwwroot/game.kxhyapp.com/kexin`

去看过这个目录了。它是**容器目录，本身不是仓库**：

```
kexin/                   ← 没有 .git，不是 git 仓库
├── kxhyapp.com/         ← 独立仓库，origin = github 943545721/kxhyapp.com
└── kxhyapp.com-saas/    ← 独立仓库，origin = github 943545721/kxhyapp.com-saas
```

`kxhyapp.com/apps/{admin-web,club-web,h5,pc-web}` 与 `kxhyapp.com-saas/{src,packages}`
都是**同一个仓库里的子目录**，不是独立仓库。所以「多」只有一层：两个仓库。

插件本来就认这种容器目录（`server/tracker/workspace-repo.ts:13-27` 的注释里，
正好拿 `/www/wwwroot/game.kxhyapp.com` 当例子）。把它当工作区打开时，
`resolveWorkspaceTargets` 扫出两个仓库，界面给选择条。

**但派单在这种工作区里现在建不出票**——已核实，不是推测：

- `dispatchTaskSchema` 没有 `repoKey`（`shared/orchestration-rpc.ts:411-418`）；
- `runDispatch` 建票时也不传（`server/orchestration.ts:1191` 附近）；
- 于是 `pickTarget` 走到「派单建票需要指明仓库：这个工作区有 2 个仓库…请带上 repoKey」
  （`server/tracker/targets.ts:473-479`）→ `ticket-failed` → 整条不派。

这正好说明「每个仓库一个经理」为什么不是花活：**经理的领地就是仓库，`repoKey` 由它的领地算出来**，
不该让人每条任务手填一次。所以第 1 批先把 `repoKey` 加到任务上（可选，单仓库不填），
第 3 批再让它由经理的领地自动带出。

## 十、跨区的代码链条（A 改的东西，B 要接得上）

用户原话：

> 还有就是要考虑到 我们会遇到这种情况 假设 A的代码 需要和B的代码链条 就距离 我让你参考的 一个saas端 还有客户端 他那个代码 需要代码配合的 能理解吗

理解。**这一节我一开始写错过一次，先把错误留在纸上**，因为它正好是下面「十点五」要防的那类事故：
我当时凭「一边是前端工程、一边是后端服务」推断出「后端加接口、客户端调」，把 kexin 的跨区关系
写成了**接口契约**。你指出这是错的——优惠券本来就是客户端的自有功能，跟授权端的关系是
「**这个客户端有没有这个功能**」。回头一行行读，你说得对：

| 事实 | 证据 |
|---|---|
| 优惠券的功能主体在 `kxhyapp.com` 里 | `kxhyapp.com/app/common/service/MemberCouponRedemptionService.php`，券与订单 / 商品 / 结算同在一个应用 |
| 但 saas 侧确实有优惠券的**运行时接口**，靠运行时令牌进 | `src/Controller/RuntimeCouponController.php`、`src/Service/RuntimeCouponPolicyService.php`、`src/Service/RuntimeOrderCouponService.php`、`src/Service/RuntimeAccessTokenService.php` |
| 授权端管的是**权益 / 许可**，粒度是「功能键」 | `PluginAdministrationCatalogTrait.php:50,91,95`：`platform_plugins.plugin_key` ↔ `license_entitlements.feature_key` ↔ `release_artifacts.plugin_key` |
| 没授权连**发版包**都下不到 | `ReleaseManifestDownloadTrait.php:39`：下载时 `JOIN license_entitlements ON feature_key = plugin_key AND license_id = ?` |
| 权益是**冻结**的：新功能不会自动追上存量客户端 | `ClientFeatureUpgradeService` 类注释：「订单客户端功能权益升级：历史订单默认冻结，只有显式升级才同步新功能包版本」「新增功能直接插入权益；移除功能只置 blocked，不删除授权行」 |

所以一条「加优惠券功能」的需求，在 kexin 里真实的样子是：**功能做在 `kxhyapp.com`，
接口走 saas 的 Runtime 那一层，能不能给这个客户端用由 `feature_key` 的授权决定，
而权益对存量订单是冻结的。** 我上一版写成「后端加个接口、前端显示减了多少钱」——
那句话可以套在任何一对前后端仓库上，等于没读。

**差别在哪**：我读的是「仓库类型」（前端 / 后端），你问的是「**权限与归属**」。
前者能靠目录结构猜，后者只能靠读代码。这条教训落成下面两件事：跨区关系不止三类
（补一类「能力 / 授权」），以及侦查结论必须带证据、由另一方核（十点五）。

### 先把「跨区」分四级，别一律当并行

| 级别 | 什么情况 | 怎么派 |
|---|---|---|
| **一、无关** | 两条活碰不到对方 | 两批并行，谁也不等谁 |
| **二、有契约** | 两边要对同一个接口 | **先在影响面表写定契约那两列**，写定之后两边并行 |
| **三、强依赖** | B 必须等 A 先落地（A 的产出是 B 的输入） | B 的票记 `blockedBy: <对方仓库>#A`（写进正文隐藏区段），**闸由 `deck_dispatch_plan` 自己读对方票的开闭来判**，不指望仓库的 `ready` 标记（见下一节那张表） |
| **四、能力 / 授权** | 功能在客户端做，但**授权端**决定「这个客户端有没有这个功能」 | **先核权益项再派**；核不清就不派 |

第四类的判据（能查，不靠猜）：这个功能是不是按 客户端 / 订单 / 租户 授予的。证据就是它在授权端
的功能目录或权益行里出现——kexin 里就是 `platform_plugins.plugin_key` /
`license_entitlements.feature_key` / `release_artifacts.plugin_key` 这条链上有没有它。
有，就在影响面表那一行填三样：`feature_key`、存量客户端是否显式升级、升级会不会碰到
已冻结的历史订单。**不建授权票**（你已定只留验收票）。

第四类怎么派：

- **开发并行，验收卡住**：客户端的开发票不受阻挡（功能可以先写），但**验收票**
  要挂上另一端——不是授权票（它不存在了），而是**授权端那一区的工作票**（真去改权益的那张）。
  权益没开的时候写「验收通过」是假的。
  **但只挂已经存在的票**：如果授权端那一区还标着「待核」（只有研究票、没有工作票），
  就不许挂一条指向空气的 `blockedBy`，改成验收票正文里记一行
  「待授权端工作票：`feature_key=<键>`」，并让验收票自己的状态是「等授权端动工」。
  同一仓库内用原生边，跨仓库用正文引用（理由见三级那条），两种都由插件判。
- **不给存量客户端升级时，需求票里必须有一句明说**：否则上线那天才发现老客户看不到这个功能。
  这一句就是影响面表里 `存量升级 = 否` 那一格 + 表下一行说明。

默认是「一」。经理拆活时必须显式声明是二、三还是四——**没声明就按一处理**，
但跨仓库的两张票会在警告里被点名（见下表最后一行）。

### 契约与权益写在哪：影响面表的列，不是新票（你已定：只留验收票）

**你已定：三张辅助票里只留验收票；契约与权益不进票，进需求票「影响面」表的列。**

| 原来打算建票的 | 现在放哪 | 为什么够 |
|---|---|---|
| 契约票（接口形状） | 影响面表加两列：`契约摘要`（路由 / 签名 / 字段名 / 错误码，一行写完）、`契约在哪`（代码路径或文档） | 契约真正的用处是「两边读的是同一份」。同一份就在需求票里，两边都能读 |
| 授权票（权益项） | 同表的 `权益项`（`feature_key`）与 `存量升级`（是 / 否）两列 | 一个权益项就是一个字符串 + 一个是非，塞得进一行 |

**什么情况下才真的开一张票**：契约长到写不进一格（一个接口十几个字段那种）。
那时的做法是**开一张普通 `kind: "issue"` 票**，不新增标签、不新增 kind、不新增状态机——
就写在影响面表那一行里「详见 #123」（第五列的第四种写法，格式表在十点五节）。

**代价要说清**：这张表是**文本**，插件只能校验「填没填、是不是空」，校验不了
「两边是不是真的对上了」。所以它靠的是「写在同一张票上、两边都看得见」，
不是靠机器强制。这一点跟验收票同一个性质。

### 契约变了怎么办：第三种协调请求（保留）

收件箱现在是三种 kind：

```
kind: "territory" | "staffing" | "contract"
```

`contract` 的语义：**我的实现跟影响面表里那一行对不上 / 我需要改那一行。**

- 谁发：任一区的员工或经理，写明「哪一条字段、为什么」。
- 三个处置：**改表**（需求票的影响面那一行更新，两边都收到通知）／**改你的实现**
  （回复拒绝并说明）／**两边都改**（少见，但留口子）。
- 表一改，**两边的工作票面各记一笔**，群里也有消息——否则只有改的那边知道，
  另一边照着旧契约干完了。

### 两边都干完了，谁验「接得上」

**具体是哪一步会漏，举个例子**（还用 kexin，这次读对了）：

需求是「给存量客户端加优惠券满减」。客户端 `kxhyapp.com` 那边正常开发：券的核销、订单金额
扣减、页面显示（`MemberCouponRedemptionService` 一带）。票关了、绿的、单测也过了。

但**没有一个人去看权益**：这个功能归属哪个权益项、存量订单要不要显式升级
（`ClientFeatureUpgradeService` 的注释写得很清楚——历史订单默认冻结，只有显式升级才同步
新功能包版本）。于是代码在、测试绿，老客户端的权益里没有这一项，上线当天客户看不到。

两个会话各自都没做错自己那一半，**盲点在中间**：开发只看代码，没人看权益。
这不是谁偷懒，是分工的固有盲点——每个人都只看自己那块。

（注意：同一个盲点在**不跨区**时也会发生。同一个仓库里，改代码的人和改配置 / 权益的人
如果是两个员工，一样各看一半。所以验收票不是「跨区专用」，是「有链条专用」。）

**v1 的做法：不自动联调，但要求有链条的需求必须建一张验收票。**

- 票上写清楚：跑哪条场景、步骤、期望结果。
- 谁来跑：派给一张**验收岗位卡**（花一个会话的钱），或者**你自己跑**（不花钱）。
- **必须有主**：验收票建出来就带 assignee —— 名册里有验收岗位卡就指派给它，
  没有就指派给你（`assignees` 是后端本来就支持的字段）。**没有主的验收票不算数**，
  建票时就拒绝并说「先建一张验收岗位卡，或自己认领」。
- 插件不判断「跑没跑过」，只判断「这张票在不在、关没关」。

**「未验收」不能是派生标记。** 派生标记的问题是：你一关需求，默认看板只显示打开的票，
这枚标记就连同整条盲点一起从界面上蒸发，**一点痕都不留**。
所以 v1 改成两步都做：

1. **关需求票时，插件往需求票正文写一行持久记录**：
   `验收：未验收（验收票 #123 仍开着，2026-11-03 关闭）`——票关着也读得到，搜 `验收：未验收` 就能捞出来；
2. 板子上那一枚「未验收」标记继续显示（关票前看得见），但它只是提醒，不是唯一痕迹。

**为什么不硬挡**：把「必须验收完才能关需求」做成硬闸，只会逼人随手打个勾，
比不验更糟。所以关票照放行，痕留着，责任在人。

不做自动联调的原因：跨仓库起服务、连数据库、造数据，各家差太远；插件做不到，
硬造一个「联调通过」比不造更害人。

### 插件能硬保的、和只能靠人的

| | 谁保 | 怎么保（**闸门落在哪一行，见第二节末尾那张三步链**） |
|---|---|---|
| 声明了有链条，影响面表里契约那两列必须填 | 插件 | `deck_issue_create` 拒绝 + `deck_dispatch_plan` 不给计划两处都查 |
| 强依赖的 B 不能先开工 | **插件自己判** | **不能靠仓库的 `ready` 判定**——跨仓库引用写进正文隐藏区段，GitHub 的 readiness 只看原生 blocker 节点（`server/tracker/github/normalize.ts:173,195`），GitLab 那边还会主动 `stripCrossRepoBlock` 把隐藏区段剥掉再读（`server/tracker/gitlab.ts:133`）。所以 `blockedBy: owner/repo#12` 在板子上**显示 ready**，这道闸一次都不会响。改成：`deck_dispatch_plan` 自己去读对方仓库那张票的开闭状态，没关就拒 |
| 契约变更两边都知道 | 插件 | 影响面那一行改了 → 群消息 + 两边票面各记一笔 |
| 有链条就必须有验收票、且必须有人认领 | 插件 | 建四区的票时检查；缺票或没 assignee 就拒绝建票。关需求时不拦，但往正文写一行 `验收：未验收（…#N）` |
| 契约本身写得对不对 | 人 / 模型 | 插件不看内容，只保证「有一份、写在同一张票上、两边读的是同一份」 |
| 跨仓库但没声明链条 | **只警告，不拒绝** | 同地图跨两个仓库的票，计划里与票面点名 |

最后一行是刻意的：**硬拦一条其实没依赖的跨仓库任务，比放过一条有依赖的，代价更大。**

## 十点五、侦查错了，后面干的都是错的（这一节在所有闸门之上）

用户原话：

> 我们怎么能够预防这些问题 本身的 侦查都不对 后续干的活就不是错误的吗

对，而且顺序就是这样：**侦查是上游。侦查错一行，后面每一道闸门都在认真保护一个错的前提。**
上面补「能力 / 授权」那一类和重写例子，修的是这一次的错；这一节修的是「为什么会错、以后怎么拦住」。

先把代价结构摆出来，因为它决定了闸门该压在哪：

| 环节 | 错一次的代价 |
|---|---|
| 侦查（要动哪几个区、为什么） | 几分钟读代码 |
| 上层的闸门（影响面表 / 领地 / 验收票） | 那个区派单窗口的一次只读核对（不新建会话） |
| 开工（每个区一个写码会话） | 每区一个写码会话 + 返工 + 一次假验收 |

**越往上游，错的代价越大、拦住它越便宜。** 所以闸门不能全压在下面。

### 三件必须改的事

**一、侦查结论要写成「可证伪的断言」，不是叙述。**

每条断言三件套，缺一件就不算结论：

| 字段 | 内容 | 反例（我上一版写的） |
|---|---|---|
| 区 / 仓库 | 到底动哪一块 | 「后端 + 客户端」（大而空） |
| 依据 | 路径:行 / 路由 / 表 / 配置项 / 权限项——**读到的原文** | 没有，只有「显然是前后端配合」 |
| 结论 | 要动 / 不动 / 待核 | 直接「要动」 |

**「仓库类型」不算依据。** 「它是前端、它是后端，所以后端出接口、前端调」这句话可以套在
任何一对仓库上，等于没读。依据必须是**这次这个功能**在那个仓库里的具体落点。

**二、核的人不能是提的人。**

仓库本来就有这条规矩：执行者自报「完成」不算验收（全局规范 `~/.claude/CLAUDE.md` §2.6
的分工表就是这么定的；仓库自己的 `AGENTS.md` 里没有这张表），
今天只用在代码上。把它往前挪一格——**用在侦查上**：

- 经理拆完活给出的「动哪几个区」清单（就是 `confirmRequirementSplit` 那张卡）。
- **每个区那一行，由那个区的经理 / 派单窗口在点「定稿」之前回一句**：
  「要动，依据是 X」/「不要动，因为 Y」/「待核」。只读、不写码。

  **两个确认点别混成一件**（上一版这里混了）：
  | 哪个 | 什么时候 | 谁点头 |
  |---|---|---|
  | 影响面核对（本节） | **定稿之前**——表不完整就不许点「定稿」 | 每个区的经理 / 派单窗口各回一句 |
  | 铺票清单（`confirmRequirementSplit`） | **定稿之后**——票可以拆了，才轮到列清单 | 你（默认开）或经理 |

  所以「先核影响面、再定稿、然后才列清单」是顺序，不是三次确认同一件事。

**上一版这里写成了「由那个区的员工核」——那是个死循环**：员工是派单之后才建的会话，
而「核完才派」又要求他先核。改正：核的人是**那个区已有的会话**（那个工作区的派单窗口 /
经理），不是将来要建的那个员工会话。跨工作区时也一样——去问那个工作区的主窗口，不新建会话。

错的区在自己那一栏就被那块的人否掉了——**没有人比那块的人更清楚那块要不要动。**

**三、没核过的行不派，改派一张研究票。**

- 清单里状态是「待核」的区：**不建会话、不建工作票**，只建一张 `wayfinder:research` 路线票，
  研究「这块要不要动、依据在哪」。
- 结论回填到需求票影响面那一行，**同时成为下一次的既有笔记**
  （`shared/entry-prompt.ts` 的「优先复用仓内既有笔记」那条现成规矩，现在有地方落了）。
- 核出来「不要动」，就是这次省下的一个写码会话。这道闸是**省钱**的，不是加流程。

### 免得它变成官僚：单区的活不要这张表

**这道闸只对「可能跨区 / 有链条」的需求生效。** 判断在定稿那一刻做：

| 情况 | 影响面表 | 手续 |
|---|---|---|
| 只动一个仓库 / 一个区 | **插件自动填一行**（区 = 当前工作区，依据 = 需求票本身，结论 = 要动，核的人 = 「单区，免核」） | 0 额外步骤 |
| 跨两个以上仓库，或声明了链条 | 必须人工填满、每行有人核 | 每区一次只读核对 |

否则改一个错别字也要走「六节 → 表 → 核 → 清单 → 票 → 会话 → 验收」，那是把流程当成目的。
**默认是前者**：没声明跨区，就按单区自动填。

### 落在哪：需求票多一节「影响面」

**四列固定 + 第五列可选**，机器可读；派单读这一节，不读散文。
第五列承载「链条」，这样契约与权益不用另建票（见第十节）。

```md
## 影响面
| 区 / 仓库 | 依据 | 结论 | 核的人 | 链条（没有就留空） |
|---|---|---|---|---|
| kxhyapp.com | app/common/service/MemberCouponRedemptionService.php:1 | 要动 | kxhyapp.com 的经理（2026-11-03） | 契约：POST /runtime/coupon/apply {amount, code} → {discount} |
| kxhyapp.com-saas | src/Service/ClientFeatureUpgradeService.php:11-15 | 要动 | saas 的经理（2026-11-03） | 权益：feature_key=coupon，存量升级=否 |
| kxhyapp.com/apps/h5 | — | 待核 | — | |
```

第五列写法只有四种（写别的按格式错误拒绝）：

- `契约：<一行摘要>` —— 二类，两边要对同一个接口；
- `权益：feature_key=<键>，存量升级=是|否` —— 四类，授权端决定有没有这个功能；
- `等 #<票号>` —— 三类，强依赖那张票关了才开工；
- `详见 #<票号>` —— 二类但契约长到写不进一格时用（见第十节：那张是普通 `kind: "issue"` 票）；
  这一格只留指针，校验只认「票号存在且是开着的」，不校验票里写了什么。

- **两处校验**：要建的每个区必须有一行、结论「要动」、`核的人`非空 → 缺行就
  **`deck_dispatch_plan` 不给计划**；建这一区的票时 **`deck_issue_create` 也再查一遍**
  （模型可能绕过计划直接建票）。两处都查，是因为没有第三条路能拦住它。
- **「待核」不是拦路虎，是分流**：待核的区**只建一张 `wayfinder:research` 研究票**，
  不建工作票（见十点五节「没核过的行不派」）。
  **「工作票 `blockedBy` 挂研究票」这句删掉了**（上一版写着，是错的）：工作票根本还没建，
  哪来的边可挂。真正的关门动作是**研究票关掉那一刻的重新评估**——
  插件监听那张票转成关闭，读回填的结论：「要动」就按影响面那一行补建工作票并回到清单确认；
  「不动」就把那一行改成不动、记一笔。研究票一直不开也不关 → 那一区就一直不派，
  这是对的（没核过的行本来就不该开工），但**必须在需求票上看得见**：
  需求票正文里那张表的这一行标着「待核」，谁打开都知道它卡在哪。
  于是定稿时「待核」行**允许存在**——要么你当场把它核成「要动 / 不动」，
  要么它变成研究票，两条路都不会让没核过的行悄悄开工。
  **两条校验各自管谁**：`核的人`非空、结论必须是「要动」——这两条只对**要建工作票的区**生效；
  标「待核」的行天然没有核的人（还没核），它也不建工作票，所以不受这两条约束。
- **「依据为空」和「写待核」不是一回事**：写 `待核` 是「还没查，我知道」；
  依据栏**空着**是「连要查什么都没写」——后者一律定稿不通过。
- **它还依赖六节骨架先接上门**：那套骨架今天没有入口（见零节），2b 批的第一件事是接线，
  第二件事才是加这一节。

### 这一节插件能硬保的、和只能靠人的

| | 谁保 | 怎么保 |
|---|---|---|
| 每行都有依据，不许空着 | 插件 | 表格 schema 校验：依据为空 → 定稿不通过 |
| 每行都有人核 | 插件 + 人 | 「核的人」为空 → 该区不派 |
| 依据是**真的** | **只能靠人** | 插件读不出「这行代码跟你说的对不对」。所以核的人必须是**那个区已有的窗口**（那个工作区的派单窗口 / 经理，不是将来才建的员工会话）——编造的依据在那一栏被否掉，这是唯一可靠的检查点 |

## 分阶段与验收

| 批次 | 内容 | 文件 | 验收 |
|---|---|---|---|
| **0** | ~~一条探针~~ **已完成（2026-11-03）**：探针跑在活 daemon 上，结论已写进第四节开头 | 一次性脚本，不进仓库 | 结论：按 `timestamp` 交织可行、游标不可跨会话、`subscribe` 只推增量、`limit` 不精确 |
| 1 | 数据模型（`StaffCard` / `kind` / `paths` / `maxConcurrent` / `minConcurrentStaff` / `confirmRequirementSplit`）+ 归一化 + 派单带岗位 + `deck.staff` 标签 + 票面抬头（含工作区 / 岗位 / 档案）+ MCP 参数 + 任务级 `repoKey` + 最少同时几个的判定 | `shared/orchestration.ts`、`shared/orchestration-rpc.ts`、`shared/tool-contract.ts`、`server/orchestration.ts`、`server/mcp/tools.ts` | 单测：名册归一化边界、`newStaffId` 生成与去重、`unknown-staff` 拒绝、**空名册时 `tasks` / `rejected` 与今天逐字节一致**（只多一条 `warnings`「还没建名册」）、**名册非空但没写 `staff` 时拒绝**、卡的档案优先生效、多仓库工作区不带 `repoKey` 时明确拒绝并列出仓库（新拒绝原因 `repo-required`）、`minConcurrentStaff` 三条判定（任务比人少按任务数算 / 名册不够时拒绝 / 计划没铺开时拒绝，**铺开度按真的放行的任务算**：被别的理由拒掉的、写了不存在 id 的、派给经理的都不算人头） |
| 2 | 名册界面 + 「限制」区加「至少同时派几个」「铺票前要我确认」「每 6 小时最多几个会话」+ **阀门二改落 `agent.created`**、阀门四全停 | `StaffPanel.tsx`（新）、`OrchestrationView.tsx`、`RolesPanel.tsx`、`types.ts`、`panelText.tsx`、`server/hooks.ts` | 单测：`agent.created` 里同 `deck.staff` 标签超额 → 归档新会话并留日志、读不到标签时**不归档只 warn**（失败方向是放行）、滚动额度超了 → 新会话被 `archive()` 并在日志里报已用多少。手工：加卡/改档/删卡各存一次重开还在（**中文名不填 id 也能存**、两张同名卡互不覆盖）；把「至少同时派几个」调到 3 后派五条活，必须真的铺到 3 张卡上；两个开关各存一次重开还在；全停按钮拒掉挂着的权限 |
| 2b | **需求票正式入口 + 影响面（十点五）+ 定稿标签换成插件私有的 `deck:定稿` + 建票闸收口**：先把六节骨架接上门（今天没挂，见零节）→ 加「影响面」一节（四列 + 可选第五列）→ 票详情页加「**定稿**」按钮（唯一能写 `deck:定稿` 的地方）→ **MCP 工具拒写任何 `deck:` 前缀标签** → `createSchema` 加 `requirementKey` / `staff` → 校验抽成 `shared/split-guard.ts`，**三个建票入口共用** → 「待核」转研究票 + **零节那两处落点改名**（`/deck new` → 建票表单、`/deck discuss` → 开会话） | `shared/requirement.ts`、`shared/impact.ts`（新）、`shared/split-guard.ts`（新）、`shared/tool-contract.ts`、`shared/labels.ts`、`server/mcp/tools.ts`、`client/deck/NewIssueModal.tsx`、`client/deck/panel/IssueDetailView.tsx`、`client/deck/Panel.tsx`、`client/deck/entry/entryCopy.ts`、`client/deck/surfaces/slash.tsx` | 单测：从入口建出的票正文含六节且带 `requirement`；依据为空 → 不许定稿；**结论「要动」但「核的人」为空 → 该区不给计划、也不建这一区的票**；结论「待核」的区**放行定稿但不建工作票、只建研究票**；缺行的区 → 建票拒绝并点名；第五列四种写法各收一次、写别的 → 拒绝；**`spec` / `spec-ticket` 建票后自动带的 `ready-for-agent` 不算定稿**；**`deck_issue_create` / `deck_map_plan_create` 两条路都被同一份 `split-guard` 拦住**（`deck_map_plan_create` 建 3 张子票时逐张校验）；**任何 `deck:` 前缀标签经 MCP 写入 → 拒绝**；`/deck new` 打开建票表单（不是只有命令卡、不是复制提示词）、**新增子命令** `/deck discuss` 开会话并预填两条谈法之一（未知子命令仍走 `unknown-command`），**不新增中文命令名** |
| 可选 | 派单台（面板表单，完全不经过模型） | `DispatchPanel.tsx`（新） | 只在你要「不打开会话也能派活」时才做 |
| 3 | 归属算法（**经理层优先**）+ 派单任务补 **`region`** + 需求 → 每区一张票（跨工作区多批次）+ 两道闸（无票不干活 / 无 `deck:定稿` 不分派）+ **经理按领地带出 `repoKey`** + **只有经理能派（落在 `agent.created` 追认）** + **跨区设父链** + **员工 `deck_staff_request`** | `shared/staff-guard.ts`（新）、`shared/requirement-split.ts`（新）、`server/requirement-dispatch.ts`（新）、`shared/staff-request.ts`（新）、`shared/orchestration-rpc.ts`、`server/orchestration.ts`、`server/mcp/tools.ts`、`server/hooks.ts` | 单测：**归属先算经理层**（员工卡再深也跳不过经理）、按区拆票、票的父挂回需求、区里没员工时明确拒绝（不回落）、无票时不给计划也不给建票、需求没打 `deck:定稿` 时拒绝、**任务没有 `region` → 拒绝**、**给了 `staff` 就按它、不给就按 `region` 算**、`confirmRequirementSplit=true` 时先出清单不建任何东西、`=false` 时直接铺但票面记录都在、跨区两批各用自己工作区的名册与派单窗口、**跨区子会话的 `parentAgentId` 指向派它的那个窗口（不改成子会话本区）**、员工卡派出的子会话被 `agent.created` 归档、局部经理领地内的活交给它而不是直派、员工卡调用计划被拒且拒绝里带出 `deck_staff_request`（**状态迁移那张表在第 4 批验，收件箱那时才有**）、容器工作区的 `repoKey` 由经理领地推出 |
| 4 | 阀门三（越界拦截 + 跨区协调）：**复用第 3 批的归属函数**，越界拒 + 生成协调请求、三种处置、协调记录落盘，**外加一个最小收件箱列表**（只在编排页里列表 + 三个按钮；群视图第 6 批再复用同一份行组件，别等到第 6 批才有地方按下这三个按钮） | `server/staff-territory.ts`（新）、`server/hooks.ts`、`server/orchestration.ts`、**`shared/orchestration-rpc.ts`（加收件箱契约）**、**`server/rpc/orchestration.ts`（加 handler）**、**`server/rpc/register.ts`（`server.handle(...)` 挂载，`server/rpc/register.ts:140-228`）**、`client/deck/surfaces/OrchestrationView.tsx`、`client/deck/surfaces/orchestration/InboxPanel.tsx`（新） | 单测：越界 edit/write 拒并生成请求、read/search 不拦、**`shell` 明确记为放行且写进日志**（不是拦不住，是选的不拦，日志要能看出来）、`detail` 缺失不自动放行、**开了 `autoAllowPermissions` 时越界仍是 deny，且日志里出现一条 `No pending permission request`（注册顺序生效的正面证据）**、三种处置各写对 state、`deck_staff_request` 走 `pending → staffed \| declined`；手工：**编排页里收件箱能列出真的一行请求**（说明 RPC 契约 + handler + `register.ts` 三处都接上了，不是 `Unknown RPC method`） |
| 4b | **跨区代码链条**：四级判定、影响面第五列（契约 / 权益 / 等票）的校验、跨仓库依赖**由插件自己读对方票**、`contract` 协调请求、验收票要求（含必须有 assignee） | `shared/contract-chain.ts`（新）、`server/contract-chain.ts`（新）、`server/orchestration.ts`、`server/mcp/tools.ts`、`client/deck/panel/IssueDetailView.tsx` | 单测：二级缺契约摘要 → 拒绝建票；三级被依赖票未关 → **`deck_dispatch_plan` 自己去读对方仓库那张票**并拒绝（不依赖仓库 `ready`）；四级缺 `feature_key` / `存量升级` → 拒绝建票；**验收票只挂已存在的票**（对方还在「待核」时改记正文一行，不挂空边）、**没有 assignee 就拒绝建票**；影响面那一行改了 → **两边票面各记一笔 + `.deck/coordination.jsonl` 一条 `kind:"contract"`**（不写「一条群消息」——群视图第 6 批才有）；跨仓库无声明 → **只警告不拒绝**；关需求票时 → **正文写一行 `验收：未验收（…#N）`**（客户端那枚标记由 `IssueDetailView` 画） |
| 5 | 岗位履历（记忆） | `server/staff-history.ts`（新）、`server/orchestration.ts` 抬头拼装、`server/mcp/tools.ts` | 单测：按 `deck.staff` 反查、最近 5 条上限、2000 字截断、无历史时不写空段、读不到回传件不影响派单 |
| 6 | 群视图 + 群记录 + `@全部` | `shared/group-rpc.ts`（新）、`server/rpc/group.ts`（新）、**`server/rpc/register.ts`（挂载）**、`client/deck/surfaces/GroupView.tsx`（新） | 单测：群内 `@名` **先建票再建会话**（票带 `deck.staff` / `deck.group` / `Refs: #需求票`）、需求票没打 `deck:定稿` 时整句被拒且不建票不建会话、`@全部` 一次确认后由插件自己铺 N 张票（不是逐张触发宿主确认）。手工：看一眼群消息里工具调用折成一行。依赖第 0 批那条探针（时间线事件形状）：对得上才做实时订阅，对不上就只做拉取 |

**第 3 批的 `deck_staff_request` 直接写 `.deck/coordination.jsonl`（`kind: "staffing"`）**，
和越界请求同一个文件——上一版说它先写 `.deck/staff-requests/`，那是给第 4 批埋了一个读不到的文件。
第 4 批只加「读它 + 三个按钮 + 状态迁移」，不换路径、不迁移数据。

每批独立：1 做完 MCP 侧能指定岗位；2 做完能在界面上派人；3 做完需求能自动铺到各区；
4 做完越界写会被拒并找人；4b 做完跨两区的需求能先对契约再接；5 做完岗位带履历；6 才是群。

## 测试

- `tests/staff-cards.test.mjs`（新）：归一化（超长截断 / 上限 24 / 旧文件无 staff / 手填非法 id 拒绝）、
  **中文名不填 id 也能存住**（`newStaffId` 生成 `staff-xxxxxx`，与名字无关）、**两张同名卡各自独立互不覆盖**、
  `staffCardOf` 大小写、`withWorkspaceRoles` 不丢名册（含「只有名册没绑窗口」那条）。
- `tests/staff-gates.test.mjs`（新；原计划名 `agent-created-gate.test.mjs`，落地时并入了这个文件，14 条）：
  `agent.created` 里同 `deck.staff` 超额 → 归档新会话；
  员工卡派出的子会话 → 归档；滚动额度超了 → 归档并记一条；
  **读不到标签 / 列表报错 / 没有 `parentAgentId` → 一律不归档，只 warn**（失败方向是放行）；
  **另一个工作区里同样 `deck.staff=frontend` 的会话不计入本区配额**（证明内存里那一步 workspaceId 过滤真的做了）。

- `tests/split-guard.test.mjs`（新）：同一份校验被三个入口共用——`deck_issue_create`、
  `deck_map_plan_create`（建 N 张子票时**逐张**过）、插件自铺；
  `spec` / `spec-ticket` 自带的 `ready-for-agent` **不算定稿**；
  任何 `deck:` 前缀标签经 MCP 写入 → 拒绝；`requirementKey` 缺失 → 不许建工作票。
- `tests/orchestration-dispatch.test.mjs` 增补：`unknown-staff` 拒绝、卡的 profileId 生效、
  卡无 profileId 时回落难度路由、卡的 duty 落到 `systemPrompt`、`deck.staff` 标签写进计划。
- `tests/mcp-tools.test.mjs`：`deck_dispatch_plan` 带 `staff` 的入参校验。
- `tests/staff-guard.test.mjs`（新）：归属**三步**——① 先定工作区；② 在 `kind: "manager"`
  的卡里取 `paths` 最长前缀定经理层（都没命中 → 根经理）；③ 只在该经理领地内的员工卡里
  取最长前缀（`web/` 与 `web-admin/` 互不吞并、`server/api` 归 `server/` 而不是 `ser`）；
  经理领地内的活即使有更深的员工卡也**不跳过经理层**；经理层命中而领地内没有员工 → 归该经理的会话；
  名册只有一张卡时直接归它；没人声明这片路径时走确认；
  `edit`/`write` 越界拒、界内放、`read`/`search` 放、`shell` 放、`detail` 缺失时不自动放行。
  （**单例锁不在这里**——它落在 `agent.created`，见 `tests/staff-gates.test.mjs`。）
- `tests/staff-territory.test.mjs`（新）：协调请求落盘与三种处置的 state 迁移，
  以及「同一路径重复越界不重复刷请求」（→ `superseded`）；`kind: "territory"` 与 `kind: "staffing"`
  混在一个文件里互不干扰，`staffing` 走 `pending → staffed | declined`；
  `approved-once` 按（会话, 路径）计一次、用掉转 `consumed`、同路径重试要重新点；
  目标卡被删 / 超 24 小时 → `cancelled`；一批 20 个文件落在同一区 → **聚合成一条**请求。
- `tests/requirement-split.test.mjs`（新）：需求按区拆票（每区一张、父挂回需求）、
  区里没员工时明确拒绝且不回落、无票时不给计划且不给建票、需求没打 `deck:定稿` 时不派、
  `confirmRequirementSplit=true` 时只出清单、一张票一个会话都不建，
  `false` 时直接铺且票面与群记录都留得下、跨区两批各用自己的名册与派单窗口。
- `tests/contract-chain.test.mjs`（新）：四级判定（无关 / 有契约 / 强依赖 / 能力·授权）各走对分支；
  二级缺契约摘要 → 拒绝且理由说得清；三级被依赖票未关 → 拒绝、已关 → 放行；
  四级缺 `feature_key` 或 `存量升级` → 拒绝建票；
  影响面第五列写错格式（比如写成「契约:」全角冒号）→ 拒绝；
  跨仓库 `blockedBy` 写进正文隐藏区段而不是试图建父子边；影响面那行变更 → 两边票面各一条 + 一条群消息；
  跨仓库没声明链条 → **只警告不拒绝**（钉死这一条，防止后来被「顺手改成硬拦」）；
  验收票缺失 → 板上标「未验收」，关票照常放行。
- `tests/settings.test.mjs` 不受影响（名册在编排文件，不在插件设置）。

## 风险

1. ~~`systemPrompt` 到底被哪家客户端认~~ —— **已验清（2026-11-03）**：
   claude 走 `systemPrompt:{type:"preset",preset:"claude_code",append}`（`providers/claude/agent.js:2870-2874`）；
   codex 写进 `developerInstructions`（`codex-app-server-agent.js:4123-4131`）；
   opencode 走 `session.promptAsync({system})` 与 v2 的 `instructions.entry.put`（`:2637,2647`、`v2/session.js:131-137`）。
   **cursor（ACP）完全不读**：`acp-agent.js` 里 `systemPrompt` 出现 0 次，`newSession({cwd, mcpServers})` 根本没带（`:1101-1104`）。
   残留风险收窄成一条：岗位卡如果被指到 ACP 客户端，职责提示词只是个摆设。
   缓解：`deck.staff` 标签照旧 + 界面上对 ACP 卡给一句「这家客户端不读职责提示词」。
   说明：宿主的 `agent.config.apply` 仍不收 `systemPrompt`，只能在创建时写死。
2. **卡指向的档案被删**：`resolveRouteTarget` 会明确报 `profile-missing`，不会静默换模型（已有行为，复用）。
3. **名册被保存抹掉**：`normalizeOrchestration` 与 `withWorkspaceRoles` 两处手抄字段是历史高发区，
   第 1 批的测试要专门钉这两条。
4. **成本**：一次派单最多 24 个名额（`maxChildrenPerDispatch` 上限），名册只是给这些名额分组，
   不改变上限；群里的 `@全部` 是新增的花钱入口，所以做了二次确认。
5. **`minConcurrentStaff` 是直接乘进钱的旋钮**：调成 3，每批活默认开三个会话。
   所以默认 1（不改现状），并且当名册撑不住这个数时**拒绝而不是悄悄降到能派多少算多少**。

## 待确认清单

**已清空。M 与 N 你都定为「甲」。**

### N（已定：甲）「新建需求」这块牌子归建票那条路

- 面板「新建需求」→ 打开**建票表单**（类型预选探索需求），不再只是开会话；
- 面板另立「**探讨需求**」→ 开会话，两条谈法（`/wayfinder` 边谈边建地图 / `/grill-with-docs` 只谈）；
- 「新建票」表单类型补「探索需求 / 实施需求」，选后铺六节骨架 + `requirement`；
- `/deck new` = 建需求票；`/deck discuss` = 开会话探讨（**这一枚是新加的子命令**，现有只有 `fixate` 没有 `discuss`）；
- `RequirementMode` 从此只管骨架，不再兼职表示「哪张卡」。

（我上一轮提的「只在卡片上改名」= 乙，已撤回：那会让界面上同时出现两个「新建需求」。）

### M（已定：甲）有链条的需求，必须建一张验收票

- 声明了链条的需求，**必须建一张验收票**（缺了就在板子上标「未验收」）；
- **不挡你关需求**——不推荐「必须验收完才能关」，那只会逼人随手打个勾，比不验更糟；
- 盲点与跨不跨区无关（同一仓库里两个员工也各看一半），所以只在**真的声明了链条**时生效，
  普通并行的活一张票都不会多；
- 第四类（能力 / 授权）的验收票 `blockedBy` **授权端那一区的工作票**（改权益的那张，
  不是一张专门的「授权票」）——权益没开就写「验收通过」是假的。

### 这些我按「沿用现状 / 不做」处理了，你不同意再说

- **A 根经理 = 现有的派单窗口**，不另立一张叫「经理」的卡：它现在的职责提示词就是
  「接定稿方案、拆任务、派出去」。再要一个经理，就是名册上加 `kind: "manager"` 的卡。
- **L 员工不能直接派活**（你已定）：调 `deck_dispatch_plan` 一律拒绝，并把 `deck_staff_request`
  指给它——要人手就问经理，不自己拉。
- **K 转交直接转**（你已定）：根经理发现某片归局部经理时，直接把活交过去、建票建会话，
  不额外弹确认。事后在群里与票面都查得到这一跳。
- **B 定稿要能机械判定**（你已定）——但**不用 `ready-for-agent`**：那枚 `spec` / `spec-ticket`
  建票时会被自动补上（`shared/issue-kind.ts:64,68,117-124`），模型建张 `spec` 就自己发了许可证。
  改成插件私有标签 **`deck:定稿`**，只能从票详情页的按钮点出去，MCP 工具拒绝写 `deck:` 前缀。
  需求票没这枚，派单一律拒绝。
- **C 铺票前先列清单，拍板人可配**（你已定）：`confirmRequirementSplit` 默认开 = 你确认；
  关 = 经理自己决定。跟 `@全部` 共用同一张确认卡。
- **契约由拆活的经理写进影响面表**（v1）：两个区的员工各出一版草案再合成更好，但那是下一轮；
  契约不再单独建票（你已定只留验收票）。
- **O 跨仓库但没声明链条**：**只警告不拒绝**。硬拦一条其实没依赖的任务，代价更大。
- **D 同卡两行任务**：不做单例锁就不存在这个问题；做了锁就当场拒绝并说明。**沿用现状**。
- **E 越界按钮**：领地那一批才涉及，到时候按三个做（批准这一次 / 驳回 / 交给那个区的人）。
- **F 进度窗口**：现在就有，不动。
- **G 固定窗口不进名册**：现在就是这样，不动。
- **H 名册上限**：与派单的 `maxChildrenPerDispatch` 上限（24）对齐，先用这个数。
- **I 任务模板**：不做。
- **J 自动转派**：不做，只有手动三选一。

## 你自己说了算的东西（列在这儿，免得又被我写死）

| 是什么 | 谁定 | 默认 |
|---|---|---|
| 岗位叫什么名字 | 你 | 空（名册不预置任何岗位） |
| 岗位 id | 你（可改） | 建卡时生成的随机键 `staff-xxxxxx`，与名字无关（名字可以是中文、可以重名） |
| 职责提示词 | 你 | 空（不写系统提示） |
| 用哪个模型档案 | 你 | 空（按任务难度走路由） |
| 他在这个工作区里管哪片 | 你（`paths`） | 不填 = 整片都归他 |
| 谁是经理（统筹分配） | 你 | 默认派单窗口（根经理，管整个工作区） |
| 要不要局部经理、管哪个目录 | 你 | 不加，只有根经理 |
| 每条活派给谁 | 经理（你随时可覆盖） | 经理必须在名册里选，选不出就报错；名册还没建时按难度派并带警告 |
| 员工能不能派活 | 你（已定） | 不能直接派；发 `deck_staff_request` 问经理 |
| 定稿后铺票前要不要我拍板 | 你（`confirmRequirementSplit`） | 要（列清单一并确认） |
| 一批活至少同时几个员工干 | 你（`minConcurrentStaff`） | 1（不强制铺开） |
| 每张卡同时能跑几个 | 你（`maxConcurrent`） | 1 |
| 群里怎么被点到 | 你（名字）＋点选 | 点选优先，文字 @ 按名字匹配、重名弹候选 |

## 状态：名册与群记录都按**目录**归属（2026-11-04）

两个「换个工作区打开就串台」的真故障，同一条口径修完：

- **名册**（`.deck/orchestration.json` 里的 `staff`）属于目录，不属于 workspaceId。
  同一个目录在宿主里会攒出好几个 id（每次重开一个），卡若跟着 id 分桶，换一个 id 打开
  岗位页就是空的，删掉的卡还会从旧 id 里复活。读走 `rosterOf()`（合并 + 按 id 去重），
  写走 `withDirectoryRoster()`（整份落到当前 id，并清掉其它条目里的卡）。
  槽位（主窗口 / 派单窗口 / 进度窗口）仍按 id：会话本来就属于具体工作区。
- **群记录**（`.deck/group/<workspaceId>.jsonl`）属于目录。读走 `readGroupDirectory()`
  （这个目录下所有 id 的记录，按时间排）；别的目录的对话不再出现在本项目的群里。
- **一个项目一个群**（2026-11-04 用户口径：「我们每一个项目 都要有独立的群」）。所以群读
  只给**本目录**一份名册（`readGroupRoster(workspaceDir)` → `roster: { staff, detail? }`），
  不再列宿主里别的目录的人；`deck.group.send` 也只在本群名册里找人，正文 `@` 或点选
  对不上就是 `unknown-staff`，不转派、不在别的目录建票建会话。
  早先那版「名册跨目录并排 + 点别人转派 + 在本群留一行索引」已经拆掉：
  那个入口让人在本项目的群里点到别的项目的员工，等于把话派错了地方。
- **群标签写目录**：`deck.group` 的值由 `workspaceId` 改成 `path.resolve(workspaceDir)`。
  同一个目录每次重开都换一个 id，标签写 id 的话换一个 id 打开，名册上 12 个人、右栏却说
  「都还没起过会话」。读会话时同时查目录 key 与当前 id（后者兜住改格式之前建的老会话），
  按 agent id 去重。更早的 id 下建的会话查不到——宿主的列表只能按标签值精确过滤，
  历史 id 没法枚举；这比改格式之前不差（那时换 id 打开也看不见），新会话一律写目录 key。
- 记录文件仍按 `workspaceId` 存（`.deck/group/<id>.jsonl`），读的时候按目录合并。

**文档同步（2026-11-04）：** 第九节「协调方案（v1）」第 1 条「群能同时看多个工作区、
成员表按工作区分组」与上面这条口径冲突，已按代码改写成「群按目录分」，并补了一节
「先选形状：父目录一个工作区，还是一个仓库一个工作区」——用户 2026-11-04 问
`kexin/`（`kxhyapp.com` + `kxhyapp.com-saas` 一个整体项目）怎么协调，答案是父目录一个
工作区即一个群、一批派单、两张票；那种形状用不到跨区父链，跨区父链只服务于
「一个仓库一个工作区」的兜底形状。查过磁盘：`kexin/`、两个子目录都没有 `.deck`，
父目录也没有 `.paseo-deck.json`——所以它现在既没有群名册，也会被当成本地单仓库。
