# 一键扫岗：扫一遍代码，提出岗位候选，由人采纳

## 目标

「岗位」页上一个按钮：起一个扫描会话，把工作区里每个项目的真实结构读一遍，
按 `project-survey` 技能的口径产出**岗位候选**（名字 / 身份 / 领地 / 职责 / 依据路径），
写进 `.deck/staff-scan.json`；面板读回来列成待采纳的卡，人逐张或一键采纳才进名册。

## 非目标

- 不改 `.paseo-deck.json`、不建标签、不动路由与档案（那是 `project-survey` / 路由页的事）。
- 不自动采纳、不覆盖已有卡；采纳只追加，id 现场生成。
- 不起员工会话：扫岗只写名册，起会话仍走「建窗口 / 派单」。

## 用户已定的两点

1. 先出清单，人再采纳（不直接写名册）。
2. 扫描跑在新开的扫描会话里（normal 档路由），不占当前窗口。

## 数据形状

`.deck/staff-scan.json`（扫描会话写，服务端只读）：

```json
{
  "at": "2026-11-04T06:00:00.000Z",
  "candidates": [
    { "name": "前端", "kind": "worker", "duty": "…", "paths": ["src/web"], "evidence": ["src/web/app.tsx", "package.json"] }
  ]
}
```

校验口径（服务端，纯函数）：

- `name` 空 / 超 `MAX_STAFF_NAME_CHARS` → 丢掉该条并记 warning；
- `kind` 不认识 → `worker`（与 `StaffCard` 缺省一致）；
- `paths` 走 `normalizeStaffPath`、去重、封顶 `MAX_STAFF_PATHS`；**声称的路径在盘上不存在 → 整条丢掉**并报出，没人该拿到一个编出来的领地；
- `duty` 截断到 `MAX_STAFF_DUTY_CHARS`；
- `evidence` 只作展示，原样带出（截断）；
- 条数封顶 `MAX_STAFF_CANDIDATES`（12）；同名同领地重复的合并。

## 落点

| 文件 | 变动 |
|---|---|
| `shared/staff-scan.ts` | 新：候选类型、`STAFF_SCAN_FILE`、纯校验 `parseStaffScan` |
| `shared/staff-scan-rpc.ts` | 新：`deck.orchestration.staff-scan`（起）与 `.read`（读候选）两条契约 |
| `server/staff-scan.ts` | 新：目录清点、简报拼装、起会话、读候选 |
| `server/rpc/orchestration.ts` | 加两个 handler（路由解析复用窗口那套） |
| `server/rpc/register.ts` | 注册两条 |
| `client/.../StaffScan.tsx` | 新：「一键扫岗」按钮、扫描中轮询、候选清单、逐张/全部采纳 |
| `client/.../StaffPanel.tsx` | 挂上 `StaffScan`，新增 `workspaceId` / `workspaceDir` 入参 |
| `client/.../OrchestrationView.tsx` | 把上面两个入参传下去 |
| `client/deck/panel/panelText.tsx` | 新增中英文案 |
| `tests/staff-scan.test.mjs` | 校验与简报的测试 |

## 扫描会话

- 客户端/模型：`resolveRoute(settings, "normal")` → `resolveRouteTarget` → `providerSpec`，
  与「建窗口」完全同一条路；失败原样报 `route-unavailable`。
- systemPrompt：只提规矩——只提案不改配置、每条带依据路径、路径相对工作区、不编目录。
- prompt：确定性清点（顶层目录两层、manifests、CI、部署、现有名册）+ 输出 schema + 文件路径，
  并要求先读 `.claude/skills/project-survey/SKILL.md`（存在才读）。
- 建会话成功之后再删旧候选文件：建失败时不该把上一轮的结果弄没。
- 会话 `ledger: false`、`labels: { deck.scan: "staff" }`，标题「扫岗：…」。

## 阶段

1. shared 契约 + 纯校验 + 测试（先红）。
2. server：清点与简报、起会话、读候选；RPC + 注册。
3. 客户端：按钮 → 轮询 → 候选清单 → 采纳写名册。
4. 文案、`/code-review`、bundle 校验、`paseo plugin reload`。

## 风险

- 扫描会话写坏 JSON / 不写文件：`read` 回报 `invalid` / `missing`，界面说清「没结果」，不猜。
- 轮询没有终点：超过 10 分钟停轮询，留「再读一次」按钮。
- 采纳时 id 撞：`newStaffId(taken)` 现场生成，不按名字归一。

## 状态（2026-11-04）

- 阶段 1–3 已落地：`shared/staff-scan.ts`、`shared/staff-scan-rpc.ts`、`server/staff-scan.ts` + `server/staff-scan-brief.ts`、
  `client/.../StaffScan.tsx`、`client/.../scan-model.ts`，`StaffPanel` / `OrchestrationView` 已接。
- 测试：`tests/staff-scan.test.mjs` 21 条（解析 13 + 采纳 5 + 清点/简报 3），全库 1569 条通过。
- 实机验证：两条 RPC 已注册；`staff-scan.read` 真调用过（无文件 → `missing`；放一份含「编的领地」的临时文件 →
  真候选保留、编的那条被丢掉并给出原因；临时文件已删）。
- **未做**：没在真实工作区点过「扫一遍代码」——起扫描会话要花一次会话，留给人自己点。
- 用量那块仍未实现（插件里没有取 token 用量的数据通路）。
