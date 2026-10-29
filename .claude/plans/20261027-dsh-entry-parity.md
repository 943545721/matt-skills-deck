# DSH「新建需求」入口内容对齐（A8 补全）

## 目标

把 DSH 新建入口里**能搬的内容**搬到本插件，同时保留 Paseo 的换面口径：

- DSH：入口浮层 → 探索地图 / 实施地图两张卡 → 新会话预填 `/wayfinder` 或 `/grill-with-docs`；
  另有 `+ bug` → 新会话 + bug 模板；票由 Agent 在会话里建。
- 我们：仍然「先建票，再复制提示词开会话」。不假装能自动创建会话或预填输入框（D1、A7/A8/A12）。

## 非目标

- 不调用 Paseo 创建会话 / 预填输入框（宿主没有这个接口）。
- 不改 IssueModal 已有的五种动作提示词（诊断 / 修复 / 研究 / 接手 / 收尾）。
- 不自动执行 `gh` 以外的网络动作；不在真实仓库写测试数据。

## 改动

### 1. `shared/requirement.ts`

- `buildRequirementBody(mode, notes, lang = "en")`：六节骨架按界面语言出中文 / 英文；默认英文保持旧测试与旧正文不变。
- 新增 bug：
  - `BugFields { actual, expected, reproduce, environment }`
  - `buildBugBody(fields, lang = "en")`：四个字段 + `## 查重记录` 空节（由 Agent 按提示词补全）。
  - `bugLabels({ diagnosed, incomplete })`：`bug`；未诊断加 `needs-triage`；缺项加 `needs-info`。
- 新增技能提示词：
  - `buildRequirementPrompt(mode, { repoKey, number, title, url, lang })`
    - explore → `/wayfinder` +「这张票是种子，不是地图」+ 调查 / 收尾 / 工具
    - implement → `/grill-with-docs` + 调查 / 讨论收尾（写回本票，提醒 `/to-spec`、`/to-tickets`）/ 工具
  - `buildBugPrompt(input)`：另收 `labels` / `labelsFailed`
    - `/wayfinder` + 当前实际标签（失败时要求先 `deck_issue_get` + `deck_issue_labels` 补齐）
    - 澄清 / 调查 / 查重 / 查重记录 / 自查 / 工具
- 工具名按本仓库 `server/mcp/tools.ts` 写实：`deck_issues_list`、`deck_issue_get`、`deck_issue_labels` 等；
  不照抄 DSH 的 `suggest_next_steps` / 状态上报工具。
- 文案与 DSH `config/prompts/ticket-creation.yaml` 对齐；占位符只留仓库、票号、标题、链接（本地后端无链接时省略）。

### 2. `shared/new-issue.ts`

- 把可测的边界抽成纯函数：`writableNewIssueRepos`、`activeNewIssueRepoKey`、`planBugSubmission`。
- 只读仓库过滤、「实际」必填、缺项 `needs-info`、默认仓库回退都由 Node 测试覆盖。

### 3. `client/deck/NewIssueModal.tsx`

- 类型选择改为：
  - 两张需求卡（探索地图 / 实施地图），带 DSH 的「目标大而模糊 / 目标明确清晰」说明与技能链；
  - `普通票` 与 `+ 缺陷` 两个次级按钮；
  - 当前选中态用 accent 边框 + ✓ + `accessibilityState`，不用新的配色。
- bug 模式：
  - 四个字段输入框（实际 / 期望 / 复现步骤 / 环境信息），每个带可见短标签；正文输入框隐藏；
  - `已诊断（不加 needs-triage）` 开关；
  - 「实际」为空时禁止创建；其它字段缺项仍可建，尝试加 `needs-info`。
- 地图开关只在普通票模式显示；需求 / 缺陷提交时强制 `isMap=false`，不会建出空地图。
- 需求模式：保留六节骨架；body 输入作为备注附在最后。
- 创建成功后，若 `创建后复制技能提示词` 开关打开（需求 / bug 模式默认打开），把对应提示词复制到剪贴板；复制失败合成一条 warning，不回滚已建票。
- 建票进行中禁止关闭（backdrop / Escape / Cancel）并禁用所有输入，避免旧请求成功后清掉新草稿。
- `onCreated` 行为不变。

### 4. `client/deck/messages.ts`

- 新增 en/zh 键：类型、两张卡的标题 / 状态 / 说明 / 技能链、四个 bug 字段、已诊断、缺项提示、复制开关与复制结果。
- 保持 `SameShape`：en/zh 键与占位符一一对应。

### 5. 测试

- `tests/requirement.test.mjs`：
  - 旧的四条默认英文用例保持通过；
  - 新增中文六节、bug 正文四节 + 查重记录、bug 标签组合、探索/实施/缺陷提示词形状、标签成功 / 失败、空链接；
  - 「提示词只点名真实注册的 deck_ 工具」：从 `MCP_TOOLS` 取名称集合交叉校验。
- `tests/new-issue.test.mjs`：只读过滤、默认仓库回退、「实际」空白、缺项 `needs-info`、诊断开关。
- 不新增客户端测试设施（仓库没有）；纯决策逻辑放 `shared/new-issue.ts` 用 Node 测试覆盖。

## 验证

1. `npm run typecheck`
2. `npm test`（目标：245 全绿）
3. `compilePlugin`，确认产物含新文案与真实工具名、不含 DSH 的旧工具名
4. `paseo plugin reload`，检查新实例 ready
5. 更新 `PROGRESS.md` 与 `docs/port-diff.md` 的 A8 结论

## 风险 / 回滚

- Modal 内容变长：`Modal.Content` 默认 `scrollable`，窄屏可滚动；若实际溢出，改为显式 ScrollView。
- 剪贴板失败：合成一条 warning，不影响已建票。
- 标签语义：`needs-info` / `needs-triage` 是 DSH 既有标签；远端缺任一标签时整套标签写入失败并走 `labelsFailed`，界面 warning，提示词要求 Agent 先补齐再查重。
- 建票中禁止关闭：请求一直不返回时 45 秒后提供「仍要关闭（票可能已建）」出口；当前 RPC 没有中止接口，宁可明确提示也不假装取消成功。迟到成功必须无条件切任务板让票可见，但不重置用户重开的草稿；keep 时把当前草稿的目标仓库钉回，避免板子筛选偷偷改掉提交目标。失败原因不能证明「没建」（超时 / 5xx / 通道异常）时保留「可能已建」警告，不说「可以重新提交」。
- 回滚：只改 `shared/requirement.ts`、`shared/new-issue.ts`、`NewIssueModal.tsx`、`messages.ts` 与测试，可整体撤回。
