# 多客户端派单编排 + 技能按需生成 方案

- 日期：2026-10-29
- 状态：待确认，未开始实现
- 范围：把「主沟通窗口 / 派单窗口 / 子 agent」这套编排落到 Paseo 0.13 实际能承载的接口上；新增按难度分配客户端与模型、按需生成技能配置。不复制 magpie / ccswrite，不改宿主。

---

## 0. 结论先行

### 0.1 已从源码核实（Paseo 0.13 自带、无需我们造）

宿主 daemon 里已经有 agent-to-agent 编排的地基，路径：`@getpaseo/server/dist/server/server/agent/tools/paseo-tools.js`。

| 能力 | 事实 | 出处 |
|---|---|---|
| 每个 agent 默认自带一套 `paseo` MCP 工具 | `paseoToolsEnabled = true` 默认开启 | `agent-manager.js:346` |
| 建子 agent | `create_agent`：agent 作用域调用默认落在调用者工作区，描述原话「creates your subagent」 | `paseo-tools.js:1146` |
| 指定客户端 + 模型 | `create_agent` 的 `provider` 收 `provider/model`（例 `codex/gpt-5.4`），`settings` 收 `modeId / thinkingOptionId / features` | `paseo-tools.js:1146-1205` |
| 完成回传父级 | `notifyOnFinish` 在 agent 作用域默认 `true`；daemon 用 finish-subscriptions 记 `{childAgentId, callerAgentId, requireParentOwnership}`，子 agent 完成/出错/请求权限都通知父级 | `create-agent/create.js:44-53`、`paseo-tools.js:856-880` |
| 父级不轮询 | 返回 guidance 明写「You will get notified … Do not poll for status」 | `paseo-tools.js:1210` |
| 子 agent 打标 | 自动加 `paseo.parent-server-id`；`labels` 可自定义 | 同上 |
| 改已有会话的模型 | `update_agent` 支持 `setAgentModel / setAgentThinkingOption / setAgentFeature / setAgentMode` | `paseo-tools.js:1656-1685` |
| 客户端/模型目录 | `list_providers / list_models / inspect_provider` | `paseo-tools.js:2252-2340` |
| **「客户端档案」已经是宿主一级概念** | `daemon.agentProfiles[]`：`id/name/icon/color/provider/model/modeId/thinkingOptionId/featureValues/notes`，`list_profiles` 专门给编排 agent 读，**create_agent 没有 profile 参数，要复制字段** | `protocol/dist/agent-profile.js:11`、`paseo-tools.js:2289` |
| **「模型注入配置」已经是宿主一级概念** | `agents.providers.<provider>.env`（本机 claude 就注入了 `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL` → deepseek）、`.additionalModels`、`.enabled`、`.paseoTools`；另有全局 `appendSystemPrompt` | `~/.paseo/config.json`、`protocol/dist/messages.js:49-55,120-139` |
| 插件能读写这份配置（不用改文件） | `paseo.config.get()` / `paseo.config.patch()`；`agentProfiles` 与 `providers` 都在 patch schema 里 | `client/dist/index.d.ts:376-397`、`messages.js:120-139` |
| 插件能拿客户端/模型/模式目录 | `paseo.providers.snapshot/listModels/listModes/listFeatures/listAvailable/diagnostic` | `client/dist/index.d.ts:357-375` |
| 插件能在会话结束时做事 | 生命周期事件 `agent.turn_ended`（`outcome: completed/failed/canceled`）+ `agent.created/closed/archived`，回调里有 `context.paseo` | `plugin/dist/server/lifecycle.d.ts:44-98` |

### 0.2 真实缺口（必须我们自己做）

1. **父 agent id 不落盘给插件读**：daemon 的父子关系在 finish-subscriptions 内存里，agent 快照只有 provider/model/title/labels；`paseo.parent-server-id` 只记 serverId，不含 parentAgentId。→ 父子边要我们自己记账（标签 + 台账）。
2. **插件 SDK 的 `agents.create` 没有 `notifyOnFinish`**：该参数只存在于 MCP 工具层。→ 插件派单时「子完成后通知父」要自己实现（`agent.turn_ended` → 推送给父会话），或者把派单交给派单窗口 agent 用它自己的 `create_agent` 工具做。
3. **我们的 `deck_*` MCP 工具只有 `--workspace`，没有 daemon 连接**（`server/mcp/main.ts`）。→ deck 工具只写台账/文件；真正建会话的是插件 server（有 `paseo`）。
4. **agentProfiles 没有插件级 CRUD 便利接口**：只能整表 patch（读全量 → 改数组 → 写全量），并发写要自己串行化。
5. **难度判定没有任何现成概念**：仓库里只有 issue-kind 与 work-route，难度是纯新增。

### 0.3 一句话结论

用户要的六件事里，**R2（不同客户端）、R3（每个客户端的模型注入）、R6（逐级回传）宿主已经具备底层能力**，插件要做的是：把它们的配置和编排变成一块能看见、能改、能审计的面板，并补上「父子台账 + 回传推送 + 难度路由」这三块宿主没做的缝。

---

## 1. 需求 → 落点总表

| # | 需求原话 | 落点 | 依赖 |
|---|---|---|---|
| R1 | 技能可以 ai 根据需求新增对应的配置 | 票面/地图详情「生成技能」：组装技能撰写提示词 → 派给指定 agent → 产出写进 `.deck/skills-draft/<id>/SKILL.md` → 插件按 `server/skills/frontmatter.ts` 校验 → 预览 diff → 用户确认后装入 `templates`/工作区技能目录 | 现有 `skillsReadRpc/skillsInstallRpc`、frontmatter 解析 |
| R2 | 需求分配多种 agent 时可以用不同客户端 | 派单时每条子任务自带 `provider/model + settings`，逐条写进 `create_agent` 参数 | `create_agent`（MCP）或 `agents.create({config})`（SDK） |
| R3 | 新增「各客户端模型的注入配置」 | 新面板「客户端」：读 `paseo.config.get()` 的 `agents.providers` + `daemon.agentProfiles`，编辑 env / additionalModels / profile 字段，`paseo.config.patch()` 写回 | `config.get/patch` |
| R4 | 配置哪个窗口是主沟通窗口、哪个是派单窗口 | 每工作区一份角色绑定（`mainAgentId` / `dispatcherAgentId`），存在 deck 设置里；面板上「设为主窗口 / 设为派单窗口」两个动作 | 需要 `decksettings` 扩展 |
| R5 | 按问题难度分配对应客户端和模型 | 难度四档 `trivial/normal/hard/critical` → 路由表（档位 → client profile）→ 派单时解析成具体 `provider/model/settings`；缺省 normal，允许派单方显式覆盖 | R3 的 profile + 纯函数路由 |
| R6 | 都是一级一级向主窗口返回，都是主窗口的子 agent | 三层：子 agent 用 `deck_report` 写结构化 handoff → 插件 `agent.turn_ended` 把 handoff 推给「上一级」会话 → 派单窗口完成后同样推给主窗口；台账记 parent→child 边 | `turn_ended` 钩子、`sendToAgent` 已存在 |

---

## 2. 设计

### 2.1 名词

- **客户端（provider）**：`claude / codex / opencode …`，宿主的一等概念。用户说的「不同客户端」按此实现。
- **客户端档案（profile）**：宿主的 `agentProfiles` 一条 = 一个 `provider + model + mode + thinking + features` 捆绑，带 `notes` 供编排方选择。**不新建并行概念**，直接用宿主的。
- **注入配置**：`agents.providers.<provider>.env` + `.additionalModels`（这就是本机 claude 走 deepseek 的机制）。另有全局 `appendSystemPrompt`。
- **角色**：主沟通窗口 / 派单窗口，每工作区各一个 agentId。
- **难度**：`trivial / normal / hard / critical`。

### 2.2 领域模型（`shared/orchestration.ts`，纯函数、可单测）

```ts
export const DIFFICULTIES = ["trivial", "normal", "hard", "critical"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface ClientProfileRef {        // 指向宿主 agentProfiles
  profileId: string;
  /** 找不到 profile 时的兜底：provider + 可选 model。 */
  fallback: { provider: string; model?: string };
}

export interface RoutingRule {
  difficulty: Difficulty;
  profile: ClientProfileRef;
  /** 派单时追加到子 agent 提示词前的策略片段（可选）。 */
  promptPreamble?: string;
}

export interface WorkspaceRoles {
  workspaceId: string;
  mainAgentId?: string;
  dispatcherAgentId?: string;
}

export interface OrchestrationSettings {
  roles: WorkspaceRoles[];         // 每工作区一条
  routing: RoutingRule[];          // 缺档位走 normal
  maxDepth: number;                // 默认 3：main → dispatcher → worker
  maxChildrenPerDispatch: number;  // 默认 6
}

export function resolveRoute(settings, difficulty): RoutingRule;      // 有档位取档位，否则 normal，否则硬兜底
export function nextLevel(depth): "dispatcher" | "worker" | "blocked";
export function buildChildLabels(input): Record<string, string>;       // deck.child / deck.parent / deck.ticket / deck.difficulty
export function summarizeTree(edges): TreeSummary;                     // 供 UI 与主窗口汇总
```

`shared/` 不碰宿主，全部可 `node --test`。

### 2.3 配置层（R3 / R4 / R5）

新面板 `client/deck/surfaces/OrchestrationView.tsx`，三个页签：

1. **角色**：列出本工作区会话（已有 `useDeckWorkspaceAgents`），两个单选「主沟通窗口 / 派单窗口」。未设置时给出提示，不猜默认值。
2. **客户端**：`paseo.providers.snapshot()` 列出 provider 与可用模型；表格显示每个 provider 的 `env` 键值（值做掩码，只露尾 4 位）、`additionalModels`、`enabled`。编辑走 `paseo.config.patch({providers: {...}})`。
   - 默认只允许改 env 的**新增/修改**，删键二次确认。
   - 写失败按 daemon 返回的真实错误展示，不吞。
3. **难度路由**：四行，每行选一个 profile（`list_profiles` 的等价物 = `paseo.config.get().daemon.agentProfiles`），显示解析后的 `provider/model/mode`。

工作区级设置落 `decksettings` 的新字段 `orchestration`，schema 在 `shared/settings.ts` 里用 zod 校验，旧配置读不到就给默认值（兼容已有 host 设置文件）。

### 2.4 派单执行（R2 / R5 / R6 的入口）

票面 / 地图条目上新增「派单」按钮（`IssueModal` / `MapModal`），弹 `DispatchSheet`：

1. **拆活**：清单化子任务（标题 + 承担者 + 难度 + 目标会话 = 派单窗口）。默认按票的 checklist / map 的 ticket 自动生成草稿。
2. **预览**：每条显示解析后的 `provider/model/mode`、目标工作区、将写入的标签、提示词全文。**必须点确认才发**（沿用项目已有的写操作确认口径）。
3. **执行**（插件 server，新 `server/rpc/dispatch.ts`）：
   ```
   for each task:
     const route = resolveRoute(settings, task.difficulty)
     const created = await paseo.workspaces.ref(workspaceId).agents.create({
       config: { provider, cwd, model, modeId, thinkingOptionId, featureValues },
       initialPrompt: task.prompt,
       labels: buildChildLabels({ parentAgentId: dispatcherAgentId, ticket, difficulty }),
       idempotencyKey: `deck-dispatch:${ticketKey}:${task.key}`,
     })
     记录台账边
   ```
   任一失败：**不静默跳过**，返回逐条结果，UI 显示哪些成了、哪些没成、为什么。

### 2.5 回传（R6 的核心缝）

三层，缺一不可：

1. **子 → 上一级（结构化）**：派单提示词里要求子 agent 结束时调用我们已有的 `deck_report` 类工具（新增 `deck_handoff`，参数 `{ status, summary, artifacts, blocking, nextStep }`），写进 `.deck/handoffs/<ticketKey>/<childAgentId>.json`。MCP 侧有 workspaceDir，够用。
2. **上一级 → 上一级（推送）**：插件 server 监听 `agent.turn_ended`，若该 agentId 在台账里是某个子节点：
   - `completed`：读 handoff 文件；缺就 `timeline.refetch({direction:"tail",limit:20})` 取尾部文本，压缩成一段；
   - `failed / canceled`：把 `outcome.error.message` 原样带上，不倒装成成功；
   - 用 `sendToAgent` 推给父会话（忙则排队，沿用现有 `sendToAgent` 的排队语义），标题 `[子任务回传] <ticket> / <difficulty>`。
3. **主窗口汇总**：派单窗口自己结束时同样走第 2 步推给主窗口；主窗口收到的是「派单窗口的汇总 + 逐条子结果链接」，不是 6 条散消息。`maxDepth` 到顶时拒绝再派，直接报错。

台账（`server/ledger.ts` 同款持久化，新增 `server/dispatch-ledger.ts`）：`{ ticketKey, parentAgentId, childAgentId, difficulty, profileId, provider, model, createdAt, status, handoffPath }`，保留策略同 work-route（30 天 / 500 条）。

### 2.6 技能按需生成（R1）

- 入口：`SkillsView` 顶部「从需求生成」+ 票面「生成技能」。
- 流程：选票/需求文本 → 组装技能撰写提示词（要求：frontmatter `name/description/when-to-use` + 何时不该用 + 步骤 + 输出契约）→ 派给派单窗口（或指定会话）→ agent 只能写 `.deck/skills-draft/<slug>/SKILL.md` → 插件 `server/skills/frontmatter.ts` 解析校验（缺字段/重名/超长直接报错）→ UI 并排 diff 预览 → 用户确认 → 走既有安装路径落盘。
- **不自动落盘、不自动覆盖同名技能**：生成即草稿，装不装由人定。

---

## 3. 阶段（每阶段可独立验证）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 实测校准：`paseo.config.get/patch` 改 `agentProfiles` 与 provider `env` 后是否即时生效；`agents.create` 传 `config.model` 是否被接受；`turn_ended` 在子 agent 上的到达时延 | 一份实测记录，写进本文件「实测结果」段；任何一条与 0.1 不符就回来改方案 |
| P1 | `shared/orchestration.ts` 模型 + `resolveRoute` / `nextLevel` / `buildChildLabels` / `summarizeTree` + 单测 | `node --test` 全绿，纯函数无宿主依赖 |
| P2 | OrchestrationView 三角色/客户端/路由三个页签 + `decksettings.orchestration` 读写 | 手动改一次 provider env 并读回一致；路由表存盘后刷新仍在 |
| P3 | DispatchSheet + `server/rpc/dispatch.ts` 派单执行 + 逐条结果回显 + 台账 | 真机派 2 条不同 profile 的子任务，会话列表里 provider/model 与预览一致 |
| P4 | `deck_handoff` MCP 工具 + `turn_ended` 回传推送 + 树视图 | 子 agent 结束后父会话确实多出一条回传消息；失败子任务带原始错误 |
| P5 | 技能按需生成（草稿 → 校验 → diff → 安装） | 生成一个技能全文，故意漏 frontmatter 字段能被拦下 |
| P6 | 文档：`OVERVIEW*.md` / `PROGRESS.md` / README 角色与编排章节；`version.md` | 文档与实现一致 |

P0 不通过不许进 P1（避免把没验证的接口写进 600 行业务代码）。

---

## 4. 测试

- 纯函数：`tests/orchestration.test.mjs` —— 路由缺档位兜底、难度→profile、深度封顶、标签构造、树汇总、台账读写去重。
- RPC：`tests/dispatch.test.mjs` —— mock `paseo`，覆盖「部分失败」「idempotencyKey 重复提交」「maxChildren 超限」。
- 技能：`tests/skill-draft.test.mjs` —— frontmatter 缺字段、重名、超长、合法。
- 回归：现有 610 条必须全绿；`npm run typecheck` 干净。

---

## 5. 风险与明确不做

**风险**

1. 整表 patch `agentProfiles` 会覆盖别人并发改的值 → 串行化 + 写前重读 + 只改目标条目。
2. 回传推送会消耗父会话 token：默认只在「子任务结束」推一次，不做周期性状态播报；可在设置里关。
3. 难度由人/规则定，模型自评难度会虚高 → 首版只接受显式难度或标签推导，不接受 LLM 自评。
4. `provider/model` 名写错只会在建会话时报错 → 预览阶段就用 `providers.snapshot` 校验存在性。
5. `sendToAgent` 在父会话忙碌时的排队行为沿用现状，可能出现延迟，不假装即时。

**不做**

- 不改宿主 composer、不接管权限弹窗。
- 不做「自动持续编排」（自主循环派单）——每次派单都要人确认。
- 不新建第二套 profile 概念，不与宿主 `agentProfiles` 分叉。
- 不在插件里重写 agent-to-agent 能力；能用 `paseo` 自带 MCP 工具的路径（例如让派单窗口自己 `create_agent` + `notifyOnFinish`）留作 P4 之后的备选方案，首版走插件确定性派单。

---

## 6. 待确认项

1. **magpie / ccswrite 的源码在哪**（仓库路径或链接）？本机没找到任何副本（`~`、`/www/wwwroot` 全盘无匹配）。想对齐的到底是它们的哪一部分：配置文件结构？模型注入方式？还是派单/多窗口那套调度？
2. **「客户端」的口径**：按 Paseo 的 provider（claude / codex / opencode…）理解，对吗？还是指不同的 Paseo host/daemon（多机）？这决定 R2 是改 create 参数还是改 host 选择。
3. **注入配置的作用面**：只影响**新建**会话，还是也要能改**已有**会话？（`setAgentModel` 支持后者，但思考档/features 改动对进行中的轮次无效。）
4. **难度由谁定**：人工在派单时选（首版默认）／按票面标签自动推／让派单窗口 agent 判断后回填？
5. **主窗口与派单窗口是否必须不同会话**？允许同一个 agent 兼任吗（省 token，但层级只剩两层）？
6. **回传粒度**：每条子任务结束就推一次，还是等派单窗口聚合后推一次？（后者省 token，但主窗口看不到中间失败。）
