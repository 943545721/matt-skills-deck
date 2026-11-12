# 配置窗口硬门：主窗口 → 派单窗口 → 执行窗口

> 状态：待用户确认后实施。用户已选定「全套硬门」。
> 实施必须在当前分支 `feat/multi-project-workspace` 的现有工作树上继续，不得回退未提交改动。
>
> 追加（2026-11-05）：票闸把 `gh` 建票全局拦住之后，只读窗口里必须有一个能落需求票。
> 用户选定新增第四个固定窗口「需求窗口」：绑定了它之后，只有它能经 MCP
> `deck_issue_create` / `deck_issue_patch` / `deck_issue_labels` 写需求票，它自己也不建工作票；
> 没绑定需求窗口时这道闸不拦。四道硬门都认这个新角色。

## 1. 目标

把「用户 ↔ 主沟通窗口 → 派单窗口 → 执行窗口 → 回传」变成插件强制执行的唯一通道。

| 门 | 位置 | 作用 |
|---|---|---|
| A 入口门 | MCP `deck_dispatch_plan`、`deck_requirement_dispatch`、RPC 派单 | 只有绑定的派单窗口能派单；主窗口、进度窗口、其他会话被拒并给出下一步 |
| B 交接工具 | 新增 MCP `deck_handoff_to_dispatcher` | 主窗口把「需求票号 + 任务 + 验收」交给派单窗口；只走投递队列，不建会话、不建票 |
| C 创建门 | `agent.created` | 主窗口/进度窗口直接开出的子会话当场归档并通知；派单窗口与执行会话放行 |
| D 执行门 | `agent.permission_requested` | 主/派单/进度窗口的 Write、Edit、改文件 shell 被拒；只读放行 |
| E 票门对齐 | `runDispatch` | RPC 派单也必须有 `requirementKey`，与 MCP 的 `no-requirement`、定稿、链条闸一致 |

非目标：不改角色槽位语义；不改岗位单例锁/员工不能派活/额度/地图预算；D 是护栏不是沙箱；C 不重算深度；交接工具不建票不建会话；不改 `.deck/orchestration.json` 既有字段。

## 2. 已核实事实

- `shared/orchestration.ts:853`：`dispatcherAgentId = callerAgentId || configuredDispatcher`，不校验调用者。
- `server/mcp/tools.ts:1900`：非派单窗口调用只 push warning，照样出计划。
- `server/mcp/tools.ts:1935+`：MCP 逐条要求 `requirementKey`（`no-requirement`）与 `deck:定稿`。
- `server/orchestration.ts:1422-1560`：RPC 直接按配置派单窗口建会话，不要求需求票、不校验调用者。
- `server/hooks.ts:813`：`agent.created` 只做 lineage、员工派活归档、岗位额度；不检查父会话是否主/进度窗口。
- `server/ticket-shell-gate.ts`：已有的「先打 held 标记 → 判定 → deny」模式。
- `server/delivery.ts`：忙时排队；当前入队即返回，调用方不知道何时真正送出。
- `server/hooks.ts` 已 950+ 行：新逻辑必须拆独立文件。

## 3. 方案

### 3.1 纯判定模块（阶段 0）

- `shared/window-gates.ts`
  - `judgeDispatchCaller(...)`：调用者 id、工作区角色、工作区是否歧义、员工卡类型 → 放行 / 拒绝原因。
  - `judgeHandoffCaller(...)`：主窗口、派单窗口槽位 → 放行 / 拒绝原因。
  - `decideRoleChild(...)`：父会话 id、角色槽位、子会话是否角色窗口 → 放行 / 归档。
- `shared/execution-guard.ts`
  - `executionBlockFor(detail)`：只判 write / edit。
  - `shellMutationVerdict(command)`：shell 是否可能改文件。
- `shared/handoff-to-dispatcher.ts`：工具名、输入类型、信封、中英文消息渲染。

### 3.2 A 入口门

判定顺序（MCP）：
1. 保留员工卡检查（非经理员工 → `staff-cannot-dispatch`）。
2. `judgeDispatchCaller`：
   - 无 `PASEO_AGENT_ID` → `caller-unknown`
   - 工作区无法唯一定位 → `workspace-ambiguous`
   - 无派单窗口 → `no-dispatcher`
   - 调用者是主窗口且不是派单窗口 → `main-cannot-dispatch`
   - 调用者是进度窗口且不是派单窗口 → `progress-cannot-dispatch`
   - 其他非派单窗口 → `caller-not-dispatcher`
   - 是派单窗口 → 放行；主=派单时按派单窗口放行
3. 比较对象必须是 `workspaceRoles.dispatcherAgentId`，不是 `plan.dispatcherAgentId`。

入口覆盖：`runDispatchPlan`、`runRequirementDispatchTool`、`runDispatch`。

RPC 人工通道：`callerAgentId` 缺省 = 人工/面板操作，放行 + warning；明确提供则必须等于派单窗口。

失败方向：拒绝（读不到角色、读不到调用者、工作区歧义都拒）。

### 3.3 B 交接工具

工具名 `deck_handoff_to_dispatcher`，只有主窗口能调。

入参：`workspaceId?`、`requirementKey`（必填）、`requirementRepoKey?`、`summary`、`tasks[]`（`title?`/`prompt`/`acceptance?`/`staff?`/`repoKey?`/`map?`）、`constraints?`、`lang?`。不接受 `depth`/`dispatchId`/`callerAgentId`。

校验/原因：`caller-unknown`、`caller-not-main`、`no-main`、`no-dispatcher`、`dispatcher-is-main`、`no-requirement`、`invalid-handoff`、`write-failed`。

行为：
1. 原子写 `.deck/dispatch-handoffs/pending/<handoffId>.json`（临时文件 + rename）。
2. `handoffId` 由主窗口 + 工作区 + 需求号 + 任务内容稳定哈希；重复调用返回 `duplicate: true`，不重复入队。
3. 不建票、不建会话、不调 `gh`。

relay（`server/dispatch-handoff-relay.ts`）：
- 在 `agent.turn_ended` 与 `agent.created` 时 drain，按工作区串行。
- 每次投递前重新解析当前派单窗口，不信任信封里的旧 id。
- 用 `deliverMessage`；成功后才移到 `sent/`，失败留在 `pending/` 并累计 attempts，超过 5 次移 `failed/` 并记日志。
- `server/delivery.ts` 增加可选 `onDelivered` / `onDropped` 回调；现有调用方不传，行为不变。

工具契约：`shared/tool-contract.ts` 顺序与 spec；`server/mcp/tools.ts` 的 `HANDLERS`、`PREAPPROVED_TOOL_NAMES`；`shared/role-prompts.ts` 补工具名与「没有票号先向用户要」。

### 3.4 C 创建门

位置：`agent.created` 读设置成功之后、名册早退之前（空名册也要受约束）。

- 无父会话 → 放行（面板手工会话、角色窗口）。
- 子会话本身是角色窗口 → 放行。
- 父 = 派单窗口 → 放行。
- 父 = 主窗口或进度窗口且不等于派单窗口 → `archive()` + 通知父窗口（`deliverMessage`）。
- 父无法识别 / 配置读不出 / 工作区歧义 → 放行 + warn（后台事件失败方向是放行）。
- 主=派单 → 放行。

### 3.5 D 执行门

注册顺序：岗位越界闸 → 票闸 → **D** → 投递队列 → 确认提醒 → 自动放行。

角色识别（`server/role-window.ts`）：按 `agent.workspaceId` 精确匹配槽位；workspaceId 为空时全表扫描，唯一命中才用；多命中/读不出 → 放行 + warn。不缓存。

判定：
- `write` / `edit` → 拦。
- `shell`：先让给票闸（`gh`/`glab` 直接 return），再判改文件命令。
- `read` / `search` / `fetch` / MCP 工具 / 未知类型 → 放行。

shell 拦截：重定向 `>`/`>>`/`&>`（`/dev/null` 除外）、`tee`、`rm`/`mv`/`cp`/`install`/`touch`/`mkdir`/`chmod`/`chown`/`ln`/`truncate`/`dd`、`sed -i`、`perl -i`、`patch`、`git apply/commit/checkout/switch/reset/clean/merge/rebase/cherry-pick/stash`、`npm install/ci/uninstall`、pnpm/yarn add/install/remove、pip install/uninstall、cargo add/install、go get/install、make/cmake/gradle/mvn、docker build、vim/nano/emacs。

放行：`git status/diff/log/show`、`ls/find/rg/grep/cat/head/tail/sed -n/wc/pwd`、`npm test`、`npm run typecheck`、`node --test`、`tsc --noEmit`、go/cargo/pytest。

拒绝文案按角色区分，shell 补命令种类；中英文。

自动放行配合：沿用 held 标记 + `gateInFlight`，D 对 `gh`/`glab` 让行；新增 `server/permission-gates.ts` 做链式 helper。

### 3.6 E 票门对齐

`runDispatch` 在 `planDispatch` 之前逐条预筛：
- 无 `requirementKey` → `no-requirement`（不进计划、不占并发）。
- 有票 → 读需求（按 repoKey+number 缓存）；读失败 → `requirement-unreadable`；未定稿 → `requirement-not-finalized`；链条闸保持 `ticket-failed`。

`DispatchRejection`、RPC `dispatchOutcomeSchema` 枚举同步扩充。

`shared/dispatch-form.ts` 需求票号必填；`DispatchPanel.tsx` 与 `panelText.tsx` 文案更新。

## 4. 分阶段实施

| 阶段 | 内容 | 验证 |
|---|---|---|
| 0 | 三个纯判定模块 + 单测 | typecheck + 新测试 |
| 1 | B 交接工具、outbox、relay、delivery 回调、契约/提示词 | 新测试 + 全量 |
| 2 | A 入口门（MCP 两个入口 + RPC），扩充原因枚举，改夹具 | 新测试 + 全量 |
| 3 | E 票门对齐 + 面板表单必填 | 新测试 + 全量 |
| 4 | C 创建门 | 新测试 + 回归岗位闸 |
| 5 | D 执行门 + 权限闸链式 helper | 新测试 + 回归票闸 |
| 6 | README/OVERVIEW/dispatch-flow/GLOSSARY；按 AGENTS.md 跑 typecheck/test → `/code-doc-drift` → `/code-review` | 全绿 + 审查无 CRITICAL/HIGH |

每阶段一个逻辑提交（提交前需用户同意）；回滚按阶段，不用 `git checkout .`。

## 5. 测试矩阵要点

每道门至少两条：「拦住」与「不误拦」。

- A：主/进度/无调用者/普通子会话被拒；派单窗口、主=派单、RPC 无调用者放行。
- B：非主窗口/无票/空任务/主=派单被拒；正常交接、重复幂等、忙时排队、后绑定补送、投递失败留 pending。
- C：主/进度窗口子会话归档；派单窗口、执行会话、角色窗口、无父会话、主=派单放行。
- D：角色窗口 write/edit/改文件 shell 被拒；只读、MCP 工具、执行窗口写、`gh` 只由票闸拒一次、配置读不出放行。
- E：无票/未定稿/读不出被拒；定稿+链条通过正常；面板空票号当场拒。

## 6. 风险

- 主窗口不能再直接改代码（用户已确认要全套硬门）。
- 派单窗口不能写文件/改配置（配置走面板）。
- shell 分类有假阴/假阳；D 是护栏不是沙箱，未知命令放行并留日志。
- 交接至少一次投递：消息带 handoffId，靠 id 去重。
- 自定义角色提示词不会被覆盖；硬门不依赖提示词。
- `hooks.ts` 继续膨胀：新模块独立，hooks 只加注册。

## 7. 已拍板（2026-11-05）

1. 面板人工派单（不传 `callerAgentId`）：**放行**，按人工操作处理并返回一条 warning。
2. `kind=manager` 的岗位卡：**不能直接派单**，与普通员工一样走协调请求，由派单窗口统一派。
3. 「主窗口临时改代码」：**不设例外**；主窗口只能交接，或由用户在面板里换窗口。

## 8. 实施前置

- 用户确认本计划后才动代码。
- 若要留下需求与实施票，先走 `/to-spec` → `/to-tickets`；不要直接跳过票面开工。
- 每个阶段的提交都需要用户单独同意，不自动提交、不推送。
