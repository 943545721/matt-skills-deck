# DSH 全量吸收与 Paseo 0.13 适配方案

- 日期：2026-10-28
- 状态：待确认，未开始实现
- 范围：把 DSH 的能力、契约、行为与文案完整吸收进 `matt-skills-deck`，落到 Paseo 0.13 实际能承载的界面；不复制 DSH 运行时，不猜接口。

---

## 0. 结论先行

### 0.1 已从实际源码核实

Paseo 0.13 **具备**：

- `paseo.agents.create({ config, cwd, title, prompt, env, idempotencyKey, ... })`，传 `prompt` 会自动发出首轮消息。
- `agent.send(text, options)`，`activeTurnBehavior` 只有 `interrupt | steer`，不传即排队。
- 动态 `addComposerPill`（需 `workspaceId + agentId`）、`addHeaderButton`（需 `workspaceId`），均返回可 `update()` / `remove()` 的注册句柄。
- `addAgentPanel`、`addCommandCenterItem`、`addSlashCommand`、`addAttachmentSource`。
- `addTimelineTransformer` / `addTimelineRenderer`，服务端与客户端都能 `timeline.append()`；同 `id` 覆盖同一行，单条 data 上限 64 KiB，重启 daemon 后不保留。
- 服务端生命周期 hook：`agent.created/turn_started/turn_ended/archived`、`workspace.created` 等，以及 `before("agent.create")`。
- `registerUsageSource`、`registerProvider`、`defineSettings`。
- daemon 启动 provider 时注入 `PASEO_AGENT_ID` / `PASEO_AGENT_CWD`；MCP stdio 子进程是否继承待 Phase 0 实测。

Paseo 0.13 **不具备**：

- composer 预填但不发送。
- 已有会话改名（title 只能在创建时给）。
- 全局 overlay / 全局 banner。
- 替换宿主 composer、控制宿主权限弹窗。
- 直接拿到“当前选中 agent”的全局上下文（pill/agent panel 由宿主按 agent 注册，需自己用 `agents.list({ subscribe })` 维护）。

### 0.2 旧结论更正

`PROGRESS.md` / `docs/port-diff.md` 中 A7/A8/A10/A11/A12/A13/A24 的“宿主没有会话创建 / 输入框注入 / pill 注册面”结论**作废**，必须在 Phase 0 后按实测结果重写。A22（已有会话改名）仍真实受阻，只能做到“新建会话时命名”。

### 0.3 能力落点总表

| DSH 能力 | Paseo 落点 | 状态 |
|---|---|---|
| banner-seat（shell.overlay 根） | header button popover + sidebar footer + 全局 screen | 无全局 overlay，降级落位 |
| dock-seat（details/session-maybe） | workspace panel（已有）+ agent panel（新增） | 可承载 |
| statusbar-seat | composer pill（主）+ header button（兜底） | 可承载，需动态注册 |
| modal-seat | `Modal` / `SessionSheet` | 可承载 |
| toast-seat | `useToast` | 已有 |
| 命令面板 | command center items | 可承载 |
| 斜杠命令 | `addSlashCommand` `/deck` | 可承载，provider 行为有差异 |
| 附件源 | `addAttachmentSource` | 可承载 |
| 时间线卡片 | transformer + renderer + `timeline.append` | 可承载，有 64 KiB / 内存限制 |
| 主题 | `addTheme` | 可选，最后做 |
| 新建会话 + 预填技能 | 新会话 + prompt（会直接发送）或空会话 + 复制 | 无纯预填；必须如实说明 |
| 向当前会话注入 | `agent.send`，默认排队 | 可承载；忙碌需确认，不默认 interrupt |
| 会话命名 | 创建时 title | 已有会话不可改名 |
| 交接（handoff） | 生成文档 + 新建/发送会话 | 可承载 |
| 工作路线（work route） | 文件台账 + agent panel / pill | 可承载 |
| 下一步建议（suggest_next_steps） | MCP 工具 + 时间线气泡 | 可承载；点击只能复制/开会话，不能预填 |
| 列表/地图/票详情/PR/技能/检查/版本/运行/设置/更新 | 面板页签 + 压栈视图 | 可承载 |
| GitHub 25 项操作 | 扩展现有 adapter | 可承载 |
| GitLab 25 项操作（读+写） | `glab api` | 当前只读，需补写 |
| 本地 Markdown `.scratch` 布局 | 双读 + 可选迁移 | 当前 `.deck` 布局有分歧 |
| `docs/agents/*` 配置 | 只读；初始化时经确认写入 | 不自动写用户仓库 |
| 六步引导 / 十项检查 | checks 页签 + setup wizard | 可承载 |
| 发布流程 | git + `gh repo create`，逐次确认 + dry-run | 可承载，需用户批准 |
| 刷新/预算/限流 | 纯策略模块 + 客户端轮询 | 可承载 |
| 提示词族 / 技能目录 / 中英文案 | 全量对照搬迁 | 已核实技能目录 v1.3.1 一致 |

### 0.4 移植原则

1. 只移植行为、契约、纯逻辑、文案；**不引入 Cordis / DSH 运行时依赖**。DSH 的 `slots`、`sessionQuery`、`llm`、`skills`、`subprocess`、`timer`、`fs` 在 Paseo 不存在，照抄会直接坏。
2. 每个能力必须有 Paseo 落点，或明确标注“不可得 + 原因 + 最近替代”，不假装。
3. 先实测后实现；Phase 0 探针失败就走降级路径，不硬编。
4. 写操作先确认；测试用临时仓库；不向真实仓库写测试数据。
5. 每个阶段独立可验证、可回滚；不一次性大爆炸。

---

## 1. 目标与非目标

### 目标

- 吸收 DSH 的**全部可迁移能力**：入口、会话桥、面板、跟踪器、初始化/发布/运维、对话智能、提示词与文案、刷新与预算。
- 每个 DSH 界面座位在 Paseo 有明确落点，且行为语义对齐（不是只有壳）。
- 工具契约向 DSH 的 9 个冻结工具 + `deck_probe` + `suggest_next_steps` 对齐，同时保留现有扩展工具，不破坏已有使用。
- 本地/远端后端、多仓库、只读/可写边界都说真话。

### 非目标

- 不复制 DSH 的 Cordis 插件代码或 UI 组件。
- 不实现宿主没有的预填、改名、全局 overlay。
- 不自动向用户真实仓库写文件、建票、建远端仓库；这些必须经用户确认。
- 不在本轮做发布/提交/推送；发布是独立审批动作。

---

## 2. 证据基线

### 2.1 DSH

- 仓库：`/www/wwwroot/game.kxhyapp.com/mattpocock-skills`
- 分支：`dev`
- 提交：`e9f6e8962b65101cdf519e546aaa16eb86a6b96d`
- 版本：`1.9.0-beta.20`（2026-10-26）
- 已读：README、CHANGELOG、config、prompts、copy、tools、skills、statusbar、panel、backends、refresh、naming、handoff、publish、versionControl、local Markdown layout、GitHub/GitLab adapter、guide/check catalog。

关键事实：

- 冻结工具顺序：`deck_context`、`deck_issue_get`、`deck_map_snapshot`、`deck_issue_list`、`deck_issue_create`、`deck_map_plan_create`、`deck_map_link`、`deck_issue_patch`、`deck_issue_report`；另有 `deck_probe`、`suggest_next_steps`。
- 面板页签：list、PR、skills、checks、versionControl；另有 map detail、issue detail、run panel、settings、update。
- 本地布局：`.scratch/<feature>/spec.md`、`.scratch/<effort>/map.md`、`.scratch/<effort>/issues/NN-<slug>.md`；一个目录只放一种容器；旧根 `issues/` 只读。
- 工作区配置：`docs/agents/workspace.yaml` v2（`version/backendId/pickedAt/source/layout`），旧 `workspace.json`；声明文件 `docs/agents/issue-tracker.md`；标签色 `docs/agents/label-colors.yaml`。
- 六步引导：后端选择 → `gh` 安装 → `gh` 登录 → 远端关联 → tracker 初始化 → 技能探测。
- 检查原语：`commandExists`、`fileExists`、`env`、`skillProbe`、`homeDir`、`dirWritable`；动作：`inject-prompt`、`open-url`、`rpc`、`form`、`refresh`、`wizard`。
- 刷新：注意力模型、5s 活跃探测、120s 黄区、10 分钟对账、写事件刷新、8/30/120/300s 失败退避、35% 服务端剩余额度、30% 写预留、GraphQL 点数/REST 请求数分账。
- 发布：`git init`（已是 git 则跳过）→ `git add .` → `git commit --allow-empty`（用户身份缺失时回退）→ `gh repo create <name> --private|--public --source=. --push`，或建远端后 `set-url` + push。

### 2.2 Paseo

- `@getpaseo/plugin` 0.13.0、`@getpaseo/client` 0.13.0（`node_modules/@getpaseo/*/dist/*.d.ts`）。
- 已读：client contracts、buttons、lifecycle、server 端 agent create / title / provider slash 解析 / agent-manager、官方 plugin SKILL.md、宿主源码。
- 关键差异：
  - Claude provider 只拦截 `rewind` 与 `CLAUDE_ROOT_ONLY_COMMANDS`，其他 `/xxx` 原样传给 Claude SDK。
  - OpenCode / Codex 会用 `listCommands()` 解析已知命令；Codex 把已知技能转 `$skill`，未知命令仍有兜底。
  - 因此 `/wayfinder` 这类技能命令不能假设所有 provider 都会展开，Phase 0 必须实测，prompt 层也要有纯文本写法。

### 2.3 当前仓库基线

- 当前工作区有大量未提交改动（上一轮 A8 等），Phase 0 开始前只做基线确认，不提交。
- 现有 MCP 工具 14 个；面板 5 个页签（board/skills/labels/version/diagnostics）。
- 本地后端写 `.deck/issues/<n>.md`、`.deck/issues/<n>.comments.json`、`.deck/labels.json`。
- GitLab 在 `server/tracker/backend.ts` 被显式限定只读。

---

## 3. 目标架构

### 3.1 新增模块

```text
shared/
  session.ts        动作类型、prompt 构造、目标解析、发送决策、handoff 渲染
  suggestions.ts    suggest_next_steps 校验/排序/裁剪
  checks.ts         检查项与六步引导的纯状态机
  refresh.ts        注意力、退避、预算、读写分道
  tool-contract.ts  DSH 工具名/别名/参数语义
  local-layout.ts   .scratch / .deck 双读、slug、迁移计划
  work-route.ts     agent ↔ ticket 台账的纯转换

server/
  session.ts        create/send/capability RPC
  ledger.ts         工作路线与 handoff 状态（原子写、锁、保留期）
  state.ts          插件状态目录、原子写、损坏恢复
  checks.ts         环境探测、技能探测、安装/登录动作
  publish.ts        发布命令构造、dry-run、确认令牌
  tracker/
    github/         查询、写入、预算、权限、子票、blocked-by、preflight
    gitlab.ts       读 + 写（glab api）
    local.ts        .scratch 布局 + .deck 兼容
    config.ts       workspace.yaml / 声明文件 / label-colors

client/deck/
  surfaces/         ComposerPill、HeaderButton、AgentPanel、CommandCenter、AttachmentSource
  timeline/         建议气泡、工作路线卡、transformer
  session/          SessionSheet
  panel/            Board、PR、Checks、Version(+worktree)、Run、MapDetail、IssueDetail
  setup/            向导、引导卡、检查列表
```

文件控制在 200–400 行、单文件 <800 行；现有 `server/tracker/github.ts` 已偏大，Phase 4 按查询/写入/预算/权限拆分。

### 3.2 数据流

```text
DSH 动作（建票/诊断/修复/研究/接手/收尾/下一步）
        │
        ▼
shared/session.ts 生成 PromptAction
        │
        ├─ 复制到剪贴板（永不失败的兜底）
        ├─ 当前 agent：agent.send（默认排队；忙碌确认；不默认 interrupt）
        └─ 新 agent：agents.create({ title, prompt, cwd, idempotencyKey })
                          │
                          ▼
                   Paseo 首轮消息自动发出
                   （部分失败要如实报告，不假装成功）

MCP 工具调用（agent 内）
        │
        ├─ 读写 tracker（GitHub/GitLab/local）
        ├─ 写工作路线台账（PASEO_AGENT_ID 可用时按 agent）
        └─ suggest_next_steps → 时间线 transformer 识别 tool_call → 气泡
```

### 3.3 状态存放

| 状态 | 位置 | 理由 |
|---|---|---|
| 工作路线台账、handoff、插件日志 | `~/.paseo/matt-skills-deck/` | 不污染用户仓库；跨工作区可查 |
| 面板页签、筛选、上次仓库 | Paseo 插件 persisted state | 宿主已有持久化 |
| 建议气泡 | 会话 tool_call 参数（权威）+ 可选 timeline 行 | 时间线是内存态，不能当数据库 |
| DSH 工作区配置 | 只读 `docs/agents/*` | 用户仓库归用户 |
| 初始化写入 | setup wizard 经确认后写 | 不自动改用户仓库 |

多仓库：沿用现有 `repo` 参数与按工作区解析 remote；台账同时记录 `workspaceId` / `repoKey` / `agentId`。

---

## 4. 工具契约对齐

### 4.1 命名

| 现有 | 目标 | 处理 |
|---|---|---|
| `deck_issues_list` | `deck_issue_list` | 新名为主，旧名保留别名一个版本 |
| `deck_issue_get` | `deck_issue_get` | 不变 |
| `deck_map` | `deck_map_snapshot` | 新名为主，旧名别名 |
| `deck_next_steps` | 保留 | 规则型下一步，**不是** DSH 的 `suggest_next_steps` |
| `deck_issue_comment` | 保留为扩展 | DSH 用 `deck_issue_patch.comment`；两者都可用 |
| `deck_issue_labels` | 保留为扩展 | DSH 用 patch 的 `addLabels/removeLabels` |
| `deck_pull_requests_list` | 保留为扩展 | PR 页签读取用 |
| `deck_issue_create` | 同名扩展 | `kind`、`label`、`parentKey`、`blockedBy`、`idempotencyKey`、`originalWords`、`workRouteDetail` |
| `deck_issue_patch` | 同名扩展 | `key`、`comment`、`addLabels/removeLabels`、`assignees`、`title/body`、`originalWords`、`progress`、`close/closeReason`、`workRouteDetail` |
| `deck_issue_report` | 同名扩展 | `key`、`note`、`workRouteDetail`、`release`；不再有 progress |
| `deck_map_plan_create` | 同名 | 与 DSH 对齐 |
| `deck_map_link` | 同名 | 与 DSH 对齐 |
| `deck_probe` | 同名 | 不变 |
| `deck_context` | 同名 | 不变 |
| — | `suggest_next_steps` | 新增，DSH 精确契约 |

### 4.2 语义

- `deck_issue_create` 的 kind：`map | map-ticket | spec | spec-ticket | bug | issue`；`map-ticket` 必须带 `wayfinder:research|prototype|grilling|task` 之一。
- `deck_issue_patch`：关票必须带 comment（spec/map）；不支持 reopen；正文 60 KB 上限；`originalWords` 幂等。
- `deck_issue_list`：`state(open/closed/all)`、`type(issue/map/spec/all)`、`labels`（AND）、`assignee`、`query`、`limit` 50/200；只回薄行，不回正文/评论。
- `deck_map_snapshot`：`key`、`frontierOnly`、`detail(full|thin)`；回子行、进度、五个地图区段。
- `suggest_next_steps`：2–4 条；`intro ≤10`、`prompt ≤500`、`reason ≤200`、`priority 0–10`；按 priority 降序、空值最后；无状态。
- 写工具**不**加入 `before("agent.create")` 的 preapproved 列表；只读工具继续预批准，写操作走宿主审批。

### 4.3 兼容

- 旧工具名保留别名一个版本，prompts 全部改用新名；测试交叉校验“prompt 只点名真实注册的工具”。
- 现有 14 个工具不删；文档标注哪些是 DSH 冻结面、哪些是本插件扩展。

---

## 5. 阶段计划

### Phase 0 — 宿主能力实测（2–3 天）

目的：把“类型里有”变成“运行时确实可用”，避免照着一个不工作的接口建七层楼。

要实测：

1. 动态 composer pill：按 `agents.list({ subscribe })` 增删，agent 切换/归档时 `update/remove`；无 agent 时是否隐藏。
2. header button popover：workspace 级注册、`visible/disabled/update`。
3. agent panel：`params.agentId` 是否稳定、归档后行为。
4. command center：全局/工作区条目、打开方式。
5. slash command：agent/workspace 两种上下文，`/deck` 是否被宿主拦截、是否真的“不发给 agent”、错误 toast。
6. `agents.create({ prompt, title, cwd, idempotencyKey })`：是否自动发首轮、部分失败如何暴露、标题是否按首行截断。
7. `agent.send`：Claude / Codex / OpenCode 对 `/wayfinder`、`/grill-with-docs` 的处理；忙碌时排队/interrupt/steer 的实际表现。
8. timeline：append、同 id 覆盖、transformer、renderer、refetch 后是否在、64 KiB 边界。
9. MCP 子进程是否继承 `PASEO_AGENT_ID` / `PASEO_AGENT_CWD`（加一个临时 debug 工具返回 env）。
10. attachment source：search 入参、返回快照、无结果表现。
11. multi-host：至少本地两个工作区；云端/远程标注为未测。

交付：

- 一个临时调试面板（只在 dev 构建；Phase 0 结束移除或收进 diagnostics）。
- `.claude/plans/20261028-phase0-spike-report.md`：逐项“实测通过 / 降级 / 不可用 + 证据”。
- 更新本方案的降级矩阵。

出口标准：

- 每一项都有实测结论；没有“应该可以”。
- 需要用户操作的项（真实 Paseo UI、真实会话）由用户点一次并确认现象。

降级矩阵（预置）：

| 失败项 | 降级 |
|---|---|
| composer pill 不稳定 | header button + sidebar footer + 面板页签 |
| agent panel 不可用 | workspace panel 内的 agent 视图 |
| slash `/deck` 不稳定 | command center + 面板按钮 |
| `agents.create` 部分失败不可观测 | 先建空 agent，再 `send`，错误逐条报告 |
| provider 不展开 `/skill` | 纯文本 prompt + 复制；不假装技能已加载 |
| timeline append/render 不可用 | agent panel / pill popover 内读 tool_call 渲染建议 |
| `PASEO_AGENT_ID` 不继承 | 台账降为 workspace 级，不按 agent 归因 |
| attachment source 不可用 | 复制票面文本到剪贴板 |

### Phase 1 — 会话桥与工作路线底座（4–6 天）

交付：

- `shared/session.ts`：`PromptAction`、`buildActionPrompt(action, ctx, provider)`、`planSend`、`sessionTitleForTicket`、`planHandoff`。
- `shared/work-route.ts` + `server/ledger.ts`：agent ↔ ticket 台账，原子写、锁、保留期、损坏恢复。
- `server/session.ts`：能力查询、创建会话、发送消息、台账读写 RPC。
- `client/deck/session/SessionSheet.tsx`：prompt 预览/编辑、目标（当前 agent / 新 agent / 复制）、provider/model、标题、发送模式、结果状态。
- 现有五种动作（诊断/修复/研究/接手/收尾）改为打开 SessionSheet，复制仍是一等公民。
- 新建需求后可“复制提示词”或“建会话”；建会话默认空会话 + 复制，自动发送需显式勾选。
- 写工具不进 preapproved；发送到忙碌 agent 必须确认，默认排队。

测试：

- prompt 形状、provider 语法分支、发送决策、标题截断、handoff 渲染。
- 台账原子性、并发写、损坏恢复、保留期。
- RPC 失败分类（未登录、仓库不存在、权限不足、超时）。

出口：

- 单元测试全绿；真实 Paseo 里由用户确认“新会话确实创建/发送/失败提示正确”。

### Phase 2 — 原生界面座位（5–7 天）

交付：

- 动态 composer pill：agent 维度显示当前票/下一步/忙碌态；点击 popover 打开 SessionSheet 或面板。
- header button：仓库计数、setup 警告、快捷入口。
- sidebar footer：deck 状态行。
- command center：开板、建票、附加票、setup、diagnostics。
- agent panel：当前 agent 的票、工作路线、建议、handoff。
- `/deck` 斜杠命令（agent/workspace）：`status`、`attach <n>`、`next`、`handoff`、`new`、`help`；纯解析/规划函数可测。
- attachment source：把票面（号/标题/正文/评论摘要）作为完整快照附加。
- timeline：`suggest_next_steps` 气泡、工作路线卡；transformer 隐藏原始工具行或折叠。
- 主题（可选，最后做）。

测试：

- `/deck` 解析、命令规划、attachment 快照、transformer 纯函数、pill 状态归并。

出口：

- 用户在真实 Paseo 确认 pill/header/agent panel/command center/附件/气泡都在正确位置；不支持的宿主自动隐藏。

### Phase 3 — 面板全量对齐（7–10 天）

交付：

- 面板导航栈：board → map detail → issue detail → run；页签：Board、PR、Skills、Checks、Version(+worktree)、Run、Diagnostics。
- Board：KPI、标签/负责人/查询筛选、关闭分页、排序、空态/错误态。
- PR 页签：状态筛选、详情、与票同池排序。
- Issue detail：评论、标签、字段编辑、关票（需 comment）、附加到会话、动作按钮。
- Banners：无仓库、后端未配置、gh 缺失/未登录、tracker 未初始化、技能缺失、写失败。
- 快照信封：`fetchedAt/source/rateLimit/stale/version`；按仓库缓存；REST ETag/304；增量刷新；失败退避。
- 刷新策略：注意力模型（活跃 5s / 黄区 120s / 对账 10min / 写事件刷新 / 8-30-120-300 退避），页面不可见时不轮询。
- Run 面板：会话/工具调用/工作路线的只读运行视图。

测试：

- 筛选/分页/排序、刷新状态机、退避序列、缓存失效、详情动作规划。

出口：

- 面板在窄屏可滚动；用户确认视觉与交互；刷新不打扰输入。

### Phase 4 — 跟踪器契约与后端全量（10–15 天，关键路径）

交付：

- 工具契约按第 4 节落地；别名、schema、语义、幂等、readback。
- GitHub：GraphQL 点数预算、REST 请求预算、限流分族、ETag/304、增量 since、权限（viewerPermission）、子票（GraphQL）、blocked-by 读写、标签色、评论分页、计数、PR、幂等、preflight。
- GitLab：`glab api` 读 + 写，25 项操作；未安装/未登录走检查链；写逐次确认。
- 本地 Markdown：`.scratch` 布局 + `.deck` 双读；原子写队列；slug 冲突 `-2…-50`；一个目录一种容器；旧根 `issues/` 只读；迁移为“复制 + dry-run”，不移动、不删。
- `docs/agents/workspace.yaml` v2 / 旧 json / `issue-tracker.md` / `label-colors.yaml`：读取兼容；写入只在 setup 明确确认后。
- YAML：先做受限 codec（只覆盖这几个 schema + fixtures）；若 Phase 0 证明 `compilePlugin` 能打包依赖，再评估引入成熟库。
- 多仓库：`repo` 参数、按工作区解析 remote、只读仓库拒绝写入。

测试：

- GraphQL/REST/glab 响应 fixtures；Markdown 解析/序列化；迁移 dry-run；幂等键复用；权限拒绝；限流退避；路径穿越与 slug 注入。

出口：

- 临时仓库上完成建票/改票/评论/标签/关票/子票/阻断的读写往返；真实仓库只做用户批准的只读验证。
- 所有写失败都能区分“未写入 / 可能已写入”，不谎报成功。

### Phase 5 — 环境、初始化、发布与运维（5–7 天）

交付：

- 十项检查 + 六步引导：后端选择、gh 安装、gh 登录、远端关联、tracker 初始化、技能探测；原语与动作按 DSH 目录。
- Setup wizard：表单、刷新、重查、跳转安装/登录、注入 prompt。
- 技能探测/安装：wayfinder、setup-matt-pocock-skills、ask-matt；与本地技能目录 v1.3.1 对齐。
- 发布流程：命令构造器 + dry-run + 二次确认；`git init/add/commit --allow-empty` 回退；`gh repo create` 或 set-url + push；失败分类。
- 更新：版本比较、一键更新入口、失败回退说明。
- 日志：debug 日志、导出、诊断页展示；不记录 token。
- 诊断：MCP 工具清单、仓库解析、后端能力、限流余量、插件版本。

测试：

- 检查评估器、引导状态机、发布命令构造（不执行）、确认令牌、版本比较、日志脱敏。

出口：

- 新工作区从零走完六步引导；发布只在用户确认后执行，测试用临时仓库。

### Phase 6 — 对话智能、提示词与文案（6–8 天）

交付：

- `suggest_next_steps` MCP 工具（精确契约）+ 时间线气泡（Phase 2 的渲染器接上）；点击复制 prompt 或打开 SessionSheet；不预填。
- 工作路线：附加票、状态推进、fixate/progress、关票联动；agent panel / pill 展示。
- Handoff：从台账 + 票 + 会话摘要生成 Markdown；预览、复制、保存、开新会话；新会话可 claim。
- 命名：建会话时按票标题给 title；已有会话不改名。
- 提示词族：逐项对照 DSH `config/prompts` 全量搬迁，工具名换成本仓库真实名；中英文 SameShape。
- 可选 usage source：把 GitHub 限流窗口接到宿主使用量显示；宿主不显示就隐藏。
- 文案：en/zh 全量补齐；空态、错误、确认、危险操作。

测试：

- 建议校验/排序/裁剪；handoff 渲染快照；台账状态转换；prompt 快照；中英文键形状；工具名交叉校验。

出口：

- 在真实会话里让 agent 调 `suggest_next_steps`，气泡出现、点击行为正确；用户确认。

### Phase 7 — 加固、文档与发布准备（3–5 天）

交付：

- 全量 `npm run typecheck`、`npm test`、`compilePlugin`、bundle 体积对比。
- 真实 Paseo 冒烟（用户操作）：pill、panel、slash、建议、setup、发布 dry-run。
- 安全审查：命令注入（repo/owner/slug）、路径穿越、token 不入 argv/日志、写工具审批、body 上限。
- 文档：README、OVERVIEW、PROGRESS、port-diff 全面改写；迁移指南；回滚说明；能力/限制清单。
- 发布提案（不执行）：版本号、变更摘要、已知限制、回滚路径。

出口：

- 所有测试与审查通过；文档与实测一致；用户批准后才提交/发布。

---

## 6. 待拍板的决定（附推荐）

| # | 决定 | 推荐 |
|---|---|---|
| 1 | 工具改名策略 | 新名为主 + 旧名别名一个版本；prompts 全量改新名；测试交叉校验 |
| 2 | 本地布局 | 双读；新本地工作区在用户明确初始化后用 `.scratch`；迁移复制 + dry-run，不自动 |
| 3 | GitLab 写入 | 补全写（`glab api`），逐次确认；未安装/未登录走检查链 |
| 4 | 动作默认行为 | 当前会话默认复制；新会话默认空会话 + 复制；自动发送需勾选；忙碌默认排队，不 interrupt |
| 5 | 工作路线状态位置 | `~/.paseo/matt-skills-deck`；不写用户仓库；`docs/agents/*` 只读，初始化时经确认写 |
| 6 | 建议气泡存储 | 以会话 tool_call 参数为权威；timeline 行只做展示，不当数据库 |
| 7 | YAML 依赖 | 先受限 codec；Phase 0 证明可打包依赖后再评估 |
| 8 | 接受硬边界 | 预填、改名、全局 overlay 不可得；其余全部落位 |

---

## 7. 执行与验收流程

1. 你确认本方案与第 6 节决定。
2. Phase 0 先做探针，产出实测报告；有失败项先改降级矩阵，再继续。
3. 每个阶段按 TDD：RED（失败测试）→ GREEN（最小实现）→ REFACTOR（测试保护下重构）。
4. 每阶段结束：`npm run typecheck` + `npm test` + `compilePlugin`；随后交 `code-reviewer` 审查；修复后由审查者独立复验。
5. 每阶段只报告实测结果；UI 项必须由你在真实 Paseo 里确认，否则标注“未实测”。
6. 不提交、不推送、不发布、不写 GitHub、不建真实远端仓库，除非你逐次批准。
7. 写操作验证用临时仓库；真实仓库只做你批准的只读检查。
8. 不默认 `bypassPermissions`；需要放宽时用项目级最小 allow，任务结束复核。
9. 每阶段更新 `PROGRESS.md` 与 `docs/port-diff.md`，按实测改结论，保留“不可得/降级”说明。

## 8. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 宿主 API 类型有、运行时无 | 整个会话桥返工 | Phase 0 实测 + 降级矩阵 |
| provider 技能命令不展开 | 提示词失效 | 纯文本 prompt + 复制兜底；Phase 0 实测 |
| `agents.create` 部分失败 | 重复建会话/丢首轮 | idempotencyKey + 先建后发 + 如实报告 |
| timeline 64 KiB/内存态 | 建议丢失 | tool_call 为权威；不依赖时间线持久化 |
| 工具改名破坏旧 prompts | agent 调不到工具 | 别名 + prompts 全量更新 + 交叉测试 |
| GitHub GraphQL 点数耗尽 | 刷新失败 | 分族预算、REST 回退、退避、写预留 |
| GitLab `glab` 不可用 | 写入不可用 | 检查链 + 明确错误，不假装成功 |
| 本地布局迁移丢数据 | 用户数据损坏 | 复制、dry-run、备份、不删旧 |
| 写工具被预批准 | 越权写仓库 | 写工具不进 preapproved；宿主审批 |
| 仓库名/slug 注入 | 命令/路径注入 | 参数数组、白名单校验、不拼 shell |
| 范围过大 | 周期长 | 阶段独立可验收；Phase 0/4 关键路径优先 |

## 9. 工作量

- 单人串行：约 6–8 周（含测试与审查）。
- 三路并行（界面 / 跟踪器 / 运维）：约 3–4 周；Phase 0 与 Phase 4 仍是关键路径，不可跳过。
- 每个 Phase 结束都可独立验收；不要求一次做完才可用。

## 10. 不做什么

- 不复制 DSH 的 Cordis 运行时/组件。
- 不伪造预填、改名、全局 overlay。
- 不自动写用户仓库、不自动建远端、不自动发布。
- 不在未实测时声称“已支持”。
- 不提交/推送/发布，除非用户明确批准。
