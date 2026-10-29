# 计划：父目录工作区识别子目录仓库

日期：2026-10-27
状态：已完成（2026-10-27）

## 目标

当一个工作区目录本身不是 git 仓库、但它的**直接子目录**里有仓库时，任务板能识别并使用这些仓库，
而不是一律回落成「本地 .deck」。

典型场景：`/www/wwwroot/game.kxhyapp.com` 是放多个项目的容器目录，下面有
`kxhyapp.com`、`kxhyapp.com-saas`、`paseo-matt-skills-deck`、`mattpocock-skills` 四个仓库。

## 非目标

- 不做递归扫描（只下一层），避免进 `node_modules` 或 `vendor` 里翻仓库。
- 不改版本管理页：它仍以工作区目录跑 `git`。父目录工作区的「版本」页仍会显示不是仓库。
- 不把子仓库的 `.deck/` 当本地后端数据目录；本地后端仍落在工作区根目录。
- 不猜「哪个子仓库最重要」。多个候选时必须由你选。

## 现状（实测）

- 仓库识别统一走 `server/rpc/repo-gate.ts:resolveRepo(workspaceDir)` →
  `server/tracker/remote.ts:readRemoteUrl` → `git -C <workspaceDir> remote`，只看根目录。
- 根目录没有远端且设置是 `auto` 时，`server/tracker/backend.ts` 回落成本地 `.deck`。
- 所以容器工作区显示「本地 .deck / 0 张票」，行为与代码一致。

## 方案

### 1. 解析顺序（新的 `resolveWorkspaceRepo`）

1. 工作区根目录有可识别的远端 → 用根目录（现有行为）。
2. 根目录是仓库但读不到远端 → 看选定项 / 子目录候选（同第 3 步）。
3. 根目录不是仓库：
   a. `.paseo-deck.json` 里有有效 `repoDir` → 用该子目录；
   b. 直接子目录里**恰好一个** GitHub / GitLab 仓库 → 自动用它；
   c. 多个 → 仍回落本地 `.deck`，但任务板顶栏出现选择条，让你选一个；
   d. 零个 → 本地 `.deck`（现有行为）。

显式选择优先于根目录：你自己选的子仓库不会被根目录后来加上的远端顶掉。
界面会显示「已选择仓库 X · 用工作区根目录」的清除入口。

### 2. 选择存在哪里

工作区根目录的 `.paseo-deck.json`：

```json
{ "repoDir": "kxhyapp.com" }
```

- 单段目录名，拒绝 `/`、`\`、`.`、`..`；`realpath` 后必须仍在工作区内（防符号链接逃逸）。
- 文件不存在 / JSON 坏了 / 目录没了 → 当作未选择，回落扫描，不报致命错误。
- 清除选择 = 删除该文件。
- 这个文件会出现在 git status 里；README 建议加进 `.gitignore`。不自动改你的 `.gitignore`。

### 3. 新增两个只读/写入 RPC（`shared/repo.ts`）

```ts
deck.repo.candidates  { workspaceDir }
  → { ok: true, rootIsRepo, selected, candidates: [{ name, path, host, owner, name, webUrl }] }
  | { ok: false, reason, detail }

deck.repo.select      { workspaceDir, repoDir: string | null }
  → { ok: true, selected: string | null }
  | { ok: false, reason: "invalid-selection" | "write-failed", detail }
```

只有 GitHub / GitLab 子仓库进候选；无远端的子目录不算（无法读票）。

### 4. 任务板界面（`BoardView.tsx`）

- `candidates` 与 `repo-info` 分开取，缓存 60 秒。
- 多个候选且未选择时，在仓库身份块下面加一行：
  `这个工作区下有 4 个仓库 · 选择任务板要用的仓库：[kxhyapp.com] [kxhyapp.com-saas] [paseo-matt-skills-deck] [mattpocock-skills]`
- 已选择时显示：`仓库来自子目录 kxhyapp.com` + `用工作区根目录`（清除）。
- 选择成功后让 `["deck"]` 开头的查询失效，票面、详情、候选一起刷新。
- 新增中英文案（`repoCandidatesNotice`、`repoCandidateClear`、`repoSelectedFrom`、`repoSelectFailed`）。

### 5. 安全边界

- 只读 `readdir` 一层，跳过点开头目录（`.git`、`.worktrees`、`.claude`）。
- 子目录最多扫 30 个，避免大目录拖慢面板。
- 所有 `git` 调用仍带 `-C` 且路径必须落在工作区内（复用现有 `workspaceProblem` 口径）。
- 写文件失败（权限、只读挂载）如实回报，不静默当作已选择。

## 阶段

1. `shared/repo.ts` 加候选类型与两个 RPC 契约。
2. `server/tracker/workspace-repo.ts`：`readSelection` / `writeSelection` / `listChildRepos` /
   `resolveWorkspaceRepo`；`repo-gate.ts` 改调它。
3. `server/rpc/repo.ts` 两个 handler + `register.ts` 注册。
4. `client/deck/BoardView.tsx` 选择条 + `messages.ts` 中英文案。
5. 测试：选择校验（路径穿越、绝对路径、非仓库目录、符号链接逃逸）、扫描（只认直接子目录、
   跳过无远端与点目录）、解析优先级（选择 > 根目录、唯一子仓库自动、多个不猜）。
6. 文档：README / OVERVIEW 双语一句说明、PROGRESS 记录、`docs/port-diff.md` 不需要动。

## 验收

- `npm run typecheck` 两套无输出；`node --test` 全绿（当前 191 条 + 新增约 10 条）。
- 在本机容器工作区实测：
  - 未选择时 `deck.repo.candidates` 返回 4 个候选；
  - 选择 `kxhyapp.com` 后，任务板显示 `GitHub · 943545721/kxhyapp.com` 与仓库详情；
  - 删除 `.paseo-deck.json` 后回到选择条。
- `paseo plugin reload` 后 running、日志无错。
- 界面渲染仍需你在 Paseo 里看一眼。

## 风险

- 多了一个工作区文件，可能被误提交 → README 说明，文件名以点开头。
- 扫描会执行最多 30 次 `git remote`（每个子目录两次调用），首次可能多花几十毫秒；
  只在根目录不是仓库时发生，结果缓存 60 秒。
- 版本管理页与任务板可能指向不同仓库（任务板用子仓库，版本页仍用工作区根目录）——
  本次不统一，作为已知限制记录。

## 落地结果

- 新增 `server/tracker/workspace-repo.ts`、`shared/repo.ts` 两个 RPC、`server/rpc/repo.ts` 两个 handler、
  `tests/workspace-repo.test.mjs` 8 条；`repo-gate.ts` 改为委托，所有读写路径（含 MCP 工具）共用。
- 选择优先级按「显式选择 > 根目录 > 唯一子目录自动」实现；多个且未选择时如实报「N 个仓库，未选定」。
- 两套 typecheck 干净；`node --test` 199/199；本机容器工作区只读实测列出 4 个真实候选；
  reload 后 running、日志干净。
- 未在真实容器目录写选择文件（留待用户点击），界面渲染未截图。
