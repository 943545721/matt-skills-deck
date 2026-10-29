# 8 路线夜间冲刺（2026-10-28）

- 开始：01:38 CST
- 目标：8 条线并行移植 DSH 真实代码到 Paseo 0.13，明早交付可加载构建 + 已完成线路 + 测试清单。
- 原则：**不写占位/降级/假数据**。DSH 有实现就按源码逻辑搬；Paseo 宿主确实没有的接口，报告里单列，不发明。

## 0. 并发规则

- 只改自己线路的文件；**不要改别人的文件**。
- 不执行 `git add/commit/push`，不建分支，不改历史。
- 不执行 `npm install`，不改 `package.json` / `tsconfig` / `paseo-plugin.json`。
- 不跑全量 `npm test` / 全量 `npm run typecheck`（其他线正在改，会看到临时错误）；只跑自己的 `node --test tests/<自己的>.test.mjs`。
- 不写 TODO、占位实现、模拟成功。需要别的线路提供函数时，按本文件接口 import，并在报告里列出签名。
- 代码风格与现有仓库一致：中文注释、函数 <50 行、文件 200–400 行（上限 800）。
- 完成后报告：改动文件、导出接口、测试命令/结果、缺口/阻塞、主线程需要接线的地方。

## 1. 线路与文件所有权

| 线 | 负责 | 只允许改 |
|---|---|---|
| L1 | 工具契约 + MCP + 建议校验 | `server/mcp/tools.ts`、新建 `shared/tool-contract.ts`、`shared/suggestions.ts`、`tests/tool-contract.test.mjs`、`tests/suggestions.test.mjs` |
| L2 | GitHub 全量后端 | `server/tracker/github.ts`、新建 `server/tracker/github/*.ts`、新建 `tests/github.test.mjs` |
| L3 | GitLab 读+写 | 新建 `server/tracker/gitlab.ts`、`server/tracker/backend.ts`、`server/tracker/read.ts`、`server/tracker/remote.ts`、新建 `tests/gitlab.test.mjs` |
| L4 | 本地 Markdown + docs/agents 配置 | `server/tracker/local.ts`、新建 `shared/local-layout.ts`、`server/tracker/config.ts`、新建 `tests/local-layout.test.mjs`、`tests/tracker-config.test.mjs` |
| L5 | 会话桥 + 工作路线 + handoff | 新建 `shared/session.ts`、`shared/work-route.ts`、`server/session.ts`、`server/ledger.ts`、`tests/session.test.mjs`、`tests/ledger.test.mjs` |
| L6 | 检查/引导/发布/更新 | 新建 `shared/checks.ts`、`server/checks.ts`、`server/publish.ts`、`server/update.ts`、`tests/checks.test.mjs`、`tests/publish.test.mjs`、`tests/update.test.mjs` |
| L7 | 面板 UI + 刷新策略 | `client/deck/Panel.tsx`、新建 `client/deck/panel/*.tsx`、`client/deck/BoardView.tsx`、新建 `shared/refresh.ts`、`tests/refresh.test.mjs` |
| L8 | 原生座位 + 时间线 + SessionSheet | `index.client.tsx`、新建 `client/deck/surfaces/*`、`client/deck/timeline/*`、`client/deck/session/SessionSheet.tsx`、`shared/slash.ts`、`tests/slash.test.mjs`、`tests/transformer.test.mjs` |
| 主线程 | 集成/文案/RPC 注册/hooks | `client/deck/messages.ts`、`server/rpc/register.ts`、`server/hooks.ts`、`server/mcp` 之外的接线、文档 |

## 2. 共享接口契约（不要改签名；可加可选字段）

```ts
// shared/tool-contract.ts (L1)
export const DECK_TOOL_ORDER: readonly string[];
export const TOOL_ALIASES: Readonly<Record<string, string>>;
export function canonicalToolName(name: string): string;

// shared/suggestions.ts (L1)
export interface SuggestedStep { intro: string; prompt: string; reason: string; priority?: number }
export const SUGGEST_LIMITS: {
  minItems: 2; maxItems: 4; introMax: 10; promptMax: 500; reasonMax: 200;
  priorityMin: 0; priorityMax: 10;
};
export function normalizeSuggestions(input: unknown):
  | { ok: true; items: SuggestedStep[] }
  | { ok: false; error: string };

// shared/session.ts (L5)
export type PromptActionKind =
  | "diagnose" | "fix" | "research" | "takeover" | "handoff"
  | "new-requirement" | "bug" | "custom";
export interface PromptActionContext {
  lang: "en" | "zh"; repoKey?: string; number?: number; title?: string;
  url?: string; provider?: string; notes?: string;
}
export function buildActionPrompt(kind: PromptActionKind, ctx: PromptActionContext): string;
export function actionTitle(kind: PromptActionKind, ctx: PromptActionContext): string;
export type SessionTarget =
  | { kind: "current"; agentId: string }
  | { kind: "new"; cwd: string }
  | { kind: "copy" };
export interface SessionSendInput {
  action: PromptActionKind; ctx: PromptActionContext; target: SessionTarget;
  busy?: boolean; sendMode?: "queue" | "interrupt" | "steer";
}
export interface SessionSendPlan {
  target: SessionTarget; prompt: string; title?: string;
  sendMode: "queue" | "interrupt" | "steer"; requiresConfirmation: boolean;
}
export function planSessionSend(input: SessionSendInput): SessionSendPlan;
export function renderHandoff(input: unknown): string; // 内部类型自行定义并导出

// shared/checks.ts (L6)
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";
export interface CheckResult { id: string; status: CheckStatus; detail?: string; action?: unknown }
export interface GuideStep { id: string; title: string; gate?: boolean }
export function guideState(results: ReadonlyMap<string, CheckResult>): {
  current: string | null; done: string[]; blocked: string[];
};

// shared/local-layout.ts (L4)
export interface LocalLayout { root: string; kind: "scratch" | "deck" }
export function planIssuePath(input: {
  layout: LocalLayout;
  kind: "map" | "spec" | "issue" | "map-ticket" | "spec-ticket";
  title: string; number?: number; existing: string[];
}): { path: string; number: number };

// shared/refresh.ts (L7)
export interface RefreshInput {
  visible: boolean; focused: boolean; lastSuccessAt: number | null;
  failures: number; remaining: number | null; reserveRatio: number;
}
export interface RefreshDecision { delayMs: number; allowWrite: boolean; reason: string }
export function planRefresh(input: RefreshInput): RefreshDecision;

// shared/slash.ts (L8)
export type DeckSlashCommand =
  | { kind: "status" } | { kind: "attach"; number: number } | { kind: "next" }
  | { kind: "handoff" } | { kind: "new" } | { kind: "help" }
  | { kind: "error"; message: string };
export function parseDeckSlash(args: string): DeckSlashCommand;
```

## 3. 每线边界与验收

- L1：9 个冻结工具 + `deck_probe` + `suggest_next_steps`；旧名别名；schema 按 DSH；handler 只调用现有 tracker 函数，缺的函数在报告列出。
- L2：GitHub 25 项读/写；预算/限流/权限/304/增量/子票/blocked-by/幂等/preflight；fixture 测试，不跑真实 gh。
- L3：GitLab 25 项读/写；`glab api` 参数数组；未安装/未登录/只读分类；写失败区分“已写入/可能未写入”。
- L4：`.scratch` 布局 + `.deck` 双读；slug/冲突/幂等/原子写；`docs/agents/*` 读取兼容；YAML 受限 codec；不自动写用户仓库。
- L5：prompt/发送计划/台账/handoff；默认 queue，不默认 interrupt；建会话 title ≤60；`PASEO_AGENT_ID` 可用则按 agent，否则 workspace。
- L6：六步引导 + 十项检查；发布命令构造 + dry-run + 二次确认，不执行写入；更新版本比较。
- L7：面板页签/导航栈/KPI/筛选/分页/PR/issue detail/run；刷新策略纯函数。
- L8：pill/header/sidebar/agent panel/command center/`/deck`/附件源/建议气泡/SessionSheet；点击建议只能复制或开会话，不预填。

## 4. 明早交付口径

- 可加载的插件构建（`compilePlugin` 通过）+ 各线真实代码 + 测试结果清单。
- 真实 Paseo UI 点击、真实仓库写、真实 GitHub/GitLab 远端验证，需要用户早上确认；未确认的标“未实测”，不写“已支持”。
- 8 个 Phase 的全量验证不在今夜窗口内；今夜是“8 线并行落地 + 集成”，不是 8 个 Phase 全部验收。
