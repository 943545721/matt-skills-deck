# 计划：多仓库合板（任务标仓库 + 写入路由）

日期：2026-10-27
状态：已实施（2026-10-27，P16；落地记录见 `PROGRESS.md`）
前置：P15 已能识别容器工作区的子目录仓库

## 目标

一个容器工作区（父目录下多个仓库）里，任务板同时列出所有候选仓库的票：

- 每张票带仓库标记 `owner/name #12`，详情里给出本地代码目录与远端地址；
- 可按仓库筛选；新建票时选择目标仓库；
- 评论 / 改标签 / 关票 / 接手都写回票所属的仓库；
- 复制给 Agent 的提示词和 MCP 回包都带上仓库 + 本地目录；
- 单个仓库工作区行为保持不变。

## 非目标

- 不解析正文里的跨仓库引用（`owner/repo#12`）；阻塞关系仍按仓库内编号。
- 地图仍是单仓库地图：地图正文里的编号是仓库内编号，跨仓库没有语义。
- 本地 `.deck` 不参与合板：一个工作区只有一个 `.deck`；没有远端候选时仍走本地单板。
- 标签配色仍是单仓库编辑（用当前筛选的仓库），不做跨仓库合并配色。
- 不做远端仓库的子目录递归发现（沿用 P15 的一层扫描）。

## 身份模型

```text
RepoKey = owner/name        （GitLab 允许 group/sub/name）
ItemKey = RepoKey#number    （issue 与 PR 共用编号空间，再加 kind 区分）
```

- 票号不再全局唯一，所有「按编号」的入口都必须带仓库：
  详情、评论、标签、接管、关票、地图、当前票绑定。
- 界面展示：卡片徽标 `owner/name`，详情标题旁 `owner/name #12`。
- 当前票绑定从裸 `number` 改成 `{ repoKey, number, kind }`；`useTabState` 的 schema 版本变化，
  旧状态解析失败时清空绑定（不猜是哪个仓库的同号票）。

## 服务端

### 1. 目标解析（`server/tracker/workspace-repo.ts`）

新增：

```ts
export interface RepoTarget {
  key: string;          // owner/name
  host: "github" | "gitlab";
  owner: string;
  name: string;
  webUrl: string;
  dir: string;          // 本地代码目录（绝对路径）
  readOnly: boolean;    // GitLab 只读
}

export async function resolveWorkspaceTargets(workspaceDir): Promise<
  { ok: true; targets: RepoTarget[]; localFallback?: RepoOut } | GateFailure
>;
```

规则：

1. 设置 `backend=local` → 不聚合，返回本地单板。
2. 根目录是仓库 → 只有根目录一个目标（普通工作区行为不变）。
3. 根目录不是仓库 → 直接子目录里所有 GitHub / GitLab 仓库；没有则回落本地。
4. `.paseo-deck.json` 的 `repoDir` 不再限制范围，只作为**默认筛选 / 新建票默认目标**。
5. 设置显式指定 `github` / `gitlab` → 只保留对应宿主的目标；没有匹配则报配置错误。

### 2. 读路径（`server/tracker/read.ts`）

- `readBoard(workspaceDir, { repoKey?, ... })`：
  - 目标 = 全部或指定仓库；并发读取（上限 4 个并发），单个失败不影响其他。
  - 合并票面，按 `updatedAt` / `createdAt` / `number` / `title` 排序；同号不同仓库不冲突。
  - 返回新增 `repos: RepoSummary[]` 与 `failures: { repoKey, reason, detail }[]`。
  - `totalCount` = 各仓库 total 之和；`hasMore` = 任一仓库还有更多；
    `rateLimit` = 剩余额度最小的一份；`source` 全部一致时取该值，否则 `mixed`。
- `readIssue(workspaceDir, repoKey, number, kind)`：先校验 repoKey 属于目标集合，再读对应后端。
- `resolveWritableTarget(workspaceDir, repoKey?)`：写路径的唯一闸门。
  - 省略 `repoKey` 且只有一个目标 → 用它；多个目标 → `invalid`，列出可用仓库。
  - GitLab 目标 → `unsupported-host`（只读），与现有话术一致。

### 3. RPC 契约（`shared/issues.ts`、`shared/map.ts`）

- `issueSummary` 增加 `repoKey`；列表顶层增加 `repos` 与 `failures`；`source` 增加 `mixed`。
- `issuesDetail` / `comment` / `labels.replace` / `assign` / `state` / `create` 的 input 增加
  `repoKey?: string`（`create` 在多个目标时必填）。
- `map` 的 input 增加 `repoKey?: string`；返回的路线票仍按同一仓库。
- 兼容：单仓库工作区不传 `repoKey` 时行为与现在一致。

## 客户端

### 任务板（`BoardView.tsx`）

- 仓库筛选条：`全部` + 每个 `owner/name`（数量可放在标签里）；默认选中 `.paseo-deck.json` 的仓库。
- 卡片的仓库徽标：只有一个仓库时不显示（避免噪音），多仓库时显示短名 `name`，详情显示全名。
- 状态行补一句 `N 个仓库`；单个仓库失败时在列表顶部给一行「owner/name 读取失败：…」，其余票照常显示。
- 新建按钮：多仓库时先选仓库（弹窗里的选择器），单仓库时不显示选择器。
- 当前票 chip 显示 `repo#number`。
- `useTabState`：`current` 改成对象；旧值无法解析时清空。

### 详情 / 地图 / 新建

- `IssueModal` 接收 `repoKey`，所有写 RPC 带上它；显示仓库全名、本地目录、打开仓库。
- 五种动作提示词增加：

  ```text
  仓库：owner/name
  本地代码：/www/.../子目录
  远端：https://github.com/owner/name
  ```

- `MapModal` 接收 `repoKey`；块内跳转沿用同一仓库。
- `NewIssueModal` 增加仓库选择器（多仓库时必选），提交带 `repoKey`。

### MCP（`server/mcp/tools.ts`）

- `deck_issues_list`：聚合列表；每条票带 `repo`；可选 `repo` 过滤。
- `deck_issue_get` / `deck_map` / `deck_next_steps`：增加可选 `repo`；多个目标且未传时
  返回 `invalid` 并列出可用仓库（不猜）。
- 写工具（comment / create / report / labels / state / assign / map_plan_create）：增加 `repo`，
  同样多目标必填；写回对应仓库。
- `deck_probe`：列出每个仓库的 key、本地目录、是否只读。
- 预授权名单不变（参数变多，工具名不变）。

## 分阶段

1. **服务端身份与读取**：`RepoTarget`、`resolveWorkspaceTargets`、`readBoard` 聚合、
   `readIssue(repoKey)`、`resolveWritableTarget`；契约加字段。先让类型通过。
2. **读 RPC 与客户端列表**：详情 / 列表带 `repoKey`；筛选条、徽标、部分失败行；
   当前票绑定改对象。
3. **写入路由**：评论、标签、状态、接手、新建、地图新建全部带 `repoKey`；
   GitLab 只读拦截；多目标缺 `repoKey` 明确报错。
4. **MCP 与提示词**：工具参数、回包、probe；五种提示词加仓库与本地目录。
5. **测试与文档**：新增/更新用例；README / OVERVIEW / PROGRESS / port-diff。

## 测试

- 聚合：两个仓库同号票并存；排序跨仓库稳定；totalCount / hasMore / counts 口径。
- 部分失败：一个仓库 gh 失败，另一个仍返回，`failures` 精确。
- 身份：详情 / 写入按 repoKey 路由；repoKey 不属于目标集合时拒绝。
- 写入：多目标缺 repoKey → `invalid`；GitLab → 只读；单目标省略 → 正常。
- 本地后端：不参与聚合，行为不变。
- MCP：列表带 repo；get 缺 repo 且多目标时报错；写工具参数校验。
- 地图：同一仓库内解析不变；repoKey 路由正确。

## 风险

- **额度与延迟**：N 个仓库 = N 次查询；并发上限 4，结果按仓库缓存由前端查询控制。
  仓库多时首屏会变慢，状态行必须说清「本次窗口」。
- **撞号**：所有入口都改成 ItemKey；漏一处就会出现「在 A 仓库关掉了 B 仓库的同号票」。
  用类型系统兜底：凡是需要 `number` 的写路径都要求 `repoKey`。
- **旧绑定**：`current` 结构变化会清空一次当前票；这是有意的，不猜同号票。
- **行为变化**：容器工作区从「选一个仓库」变成「默认全部」；`.paseo-deck.json` 降级为默认筛选 /
  新建默认目标。需要更新 P15 的文案与测试。
- **本地 `.deck` 被排除**：容器里同时有 `.deck` 和远端仓库时，只显示远端；需要在 UI 说明。

## 验收

- 两套 `tsc --noEmit` 无输出；`node --test` 全绿（现有 199 条 + 新增约 15 条）。
- 本机容器工作区实测：聚合列表能读出 4 个仓库（当前都是 0 票），筛选与徽标正常；
  新建 / 评论在临时仓库或真实仓库上按 repoKey 路由（真实写入需你确认后再做）。
- `paseo plugin reload` 后 running、日志无错。
- 界面渲染与窄屏换行仍需你在 Paseo 里看一眼。
