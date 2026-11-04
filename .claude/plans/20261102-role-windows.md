# 三个固定窗口：主窗口 / 派单窗口 / 进度窗口

日期：2026-11-02　分支：`feat/multi-project-workspace`

## 目标

一个项目一份「群」，群里三个固定职能窗口，各带自己的身份提示词：

| 窗口 | 干什么 | 现在 |
|---|---|---|
| 主窗口 | 跟用户探讨方案，不改代码、不建票、不派活 | `mainAgentId` 有，但没有任何提示词约束 |
| 派单窗口 | 接定稿方案，拆任务、派给执行窗口 | `dispatcherAgentId` 有 |
| 进度窗口 | 只收进度：谁在跑、谁卡住、哪张票做完了 | **没有** |

三个窗口由**插件创建**，身份提示词写在 `config.systemPrompt`（宿主原生系统提示，每轮生效，
不像一句聊天记录会被冲淡）。

## 非目标

- 不做「角色库」（用户建的一批自定义人设）。本轮只做三个固定窗口。
- 不动执行窗口的派单链：子会话、`deck_handoff`、父子回传、地图预算全部照旧。
- 不改宿主的模式（modeId）：提示词是软约束，模式是硬约束，但用户明确不动它。

## 现状（已核实）

- `WorkspaceRoles` 只有 `mainAgentId` / `dispatcherAgentId`（`shared/orchestration.ts:64-72`）。
- `PaseoAgentConfig.systemPrompt` 存在（`@getpaseo/client` 类型 165 行），宿主把它映射成各客户端的原生指令字段。
- 事后改配置的 `agent.config.apply` 只收 `modelId / modeId / thinkingOptionId / featureValues`，**没有 systemPrompt** —— 所以身份只能在创建时写死，这也是选「插件建窗口」的唯一原因。
- 插件现在的 `createAgent`（`server/session.ts`）没有往下传 `systemPrompt`，加上即可。
- 回传只有一条路：子会话 → 它的上一级；失败兜底给主窗口（`server/report.ts:197-216`）。进度窗口没有位置。

## 方案

### 1. 数据模型（`shared/orchestration.ts`）

```ts
export type FixedRole = "main" | "dispatcher" | "progress";
export const FIXED_ROLES = ["main", "dispatcher", "progress"] as const;

export interface WorkspaceRoles {
  workspaceId: string;
  mainAgentId?: string;
  dispatcherAgentId?: string;
  progressAgentId?: string;                       // 新增
  prompts?: Partial<Record<FixedRole, string>>;    // 新增：用户改过的身份提示
}
```

- `DEFAULT_ROLE_PROMPTS: Record<FixedRole, { zh: string; en: string }>`：三段默认身份提示。
  主窗口那段写明「只探讨方案，不改代码、不建票、不派活；方案定稿交给派单窗口」。
- `rolePromptFor(roles, role, lang)`：有自定义用自定义，否则用默认。
- `agentIdOf(roles, role)`：一个地方取三个槽位，别处不再写 `role.mainAgentId ?? ...` 的重复分支。
- `normalizeOrchestration`：解析 `progressAgentId` 与 `prompts`（各自 trim、长度上限 4000）。
- **`withWorkspaceRoles` 必须一起改**：它现在只重抄三个字段（`shared/orchestration.ts:936-946`），
  不改会静默丢掉 `progressAgentId` 与 `prompts`。

### 2. 建窗口（新增 RPC `deck.orchestration.window`）

契约在 `shared/orchestration-rpc.ts`，处理在 `server/rpc/orchestration.ts`。

- 入参：`workspaceDir`、`workspaceId`、`role`、`recreate?: boolean`、`lang?: "zh" | "en"`。
- 客户端/模型：跟 **normal 档路由**走（`resolveRoute` + `resolveRouteTarget`），不新增配置项。
- 建会话：`createAgent` 加 `systemPrompt` 字段；`title` 写成「主窗口 / 派单窗口 / 进度窗口」；
  `labels` 写 `deck.role: <role>` 与 `deck.role.window: "1"`（与会话树现有的标签口径一致）。
  不传首条 `prompt`：窗口建出来停在 idle，等用户开口。
- `recreate=true`：先归档旧会话（失败只记 warning，不阻断），再建新的，避免两个主窗口并存。
- 建成功后用 `withWorkspaceRoles` 写回槽位，返回 `{ ok, agentId, title, previousAgentId, warnings }`。

### 3. 界面（`client/deck/surfaces/orchestration/RolesPanel.tsx`）

- 三个槽位行，写法沿用现有两行：标题一行、`客户端/模型 · 状态 · 短 id` 一行，1px 线分隔。
- 每行右侧：`建窗口`（没有时）/ `重建`（已有时）/ `清除`。
- 已有会话仍可指派（保留现在的 pick 流程）——那是插件建不出窗口时的兜底，代价很小。
- 槽位指向的会话已不在列表里时，行上直接写「已归档，需重建」，不留一个死 id。
- 每行下面一个可折叠的「身份提示词」编辑区：预填默认值，改过才存进 `prompts`；
  存的是文本，不是从默认值改出的 diff。
- 文案（`client/deck/panel/panelText.tsx`）：`orch.main` 改成「主窗口 / Main window」，
  新增 `orch.progress`、`orch.buildWindow`、`orch.rebuildWindow`、`orch.prompt` 等词条。

### 4. 回传抄送（`server/report.ts`）

- 新增 `progressAgentFor(workspaceDir, workspaceId)`，与 `mainAgentFor` 同源读设置。
- `deliver` 送到上一级成功后：配了进度窗口、且它不是上一级也不是主窗口时，再发一份
  `【进度】…` 抄送。失败只 `record("warn", …)`，**不打断主链路**。
- 沿用现有的 `seen` 去重键，同一份回传不会抄送两次。

## 阶段

1. 数据模型 + 默认提示词 + 归一化 + 测试（纯函数，先绿）。
2. `createAgent` 传 `systemPrompt`；`deck.orchestration.window` RPC + 测试。
3. 面板三行 + 提示词编辑 + 文案（中英）。
4. 回传抄送 + 测试。
5. `npm run typecheck` / `npm test` → `/code-review`。

## 测试

- `tests/orchestration-role-windows.test.mjs`（新）：默认提示词存在且非空、自定义覆盖默认、
  `normalizeOrchestration` 保留 `progressAgentId` 与 `prompts`、`withWorkspaceRoles` 不丢新字段、
  `agentIdOf` 三槽位取值。
- `tests/orchestration-rpc.test.mjs`：新 RPC 的入参校验（role 只认三个值、recreate 缺省为假）。
- `tests/report.test.mjs`：配了进度窗口时抄送一次；进度窗口 = 上一级时不重复发；
  抄送失败不影响主投递成功。

## 风险

- **`withWorkspaceRoles` 漏改** → 保存一次就把 `prompts` 与 `progressAgentId` 抹掉。放第一阶段的测试里锁死。
- **用户手工归档窗口** → 槽位指向死会话。面板要能识别并提示重建，不能显示得像正常的。
- **某些客户端不吃 `systemPrompt`** → 窗口建得出来但身份没生效。要在返回值里把宿主的 `notice`
  透出来，别让人以为生效了。

## 待确认

- 建窗口时不传首条 `prompt`，宿主是否允许（`PaseoAgentCreateOptions.prompt` 标着可选，但没实测）。
- 三个客户端里哪几个真正支持 `systemPrompt` 映射。
