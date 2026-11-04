import type { PluginBeforeRequests, PluginHookAgent, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest, AgentPermissionRequestKind } from "@getpaseo/protocol/agent-types";
import { existsSync } from "node:fs";
import path from "node:path";
import { CODEX_SITE_PROVIDER, providerId } from "../shared/orchestration.ts";
import { codexSiteUsable } from "./orchestration.ts";
import { resolveOwner } from "../shared/staff-guard.ts";
import { record } from "./logs.ts";
import { MCP_SERVER_NAME, PREAPPROVED_TOOL_NAMES } from "./mcp/tools.ts";
import { pluginRoot } from "./paths.ts";
import { TurnReporter, reportEnabledFor } from "./report.ts";
import { getSettings } from "./settings.ts";
import { providersRawOf, readDaemonConfig } from "./orchestration.ts";
import { readOrchestration } from "./orchestration-store.ts";
import { decideStaffGate, decideWorkerDispatch, staffGateApplies } from "./staff-gates.ts";
import { DECK_STAFF_LABEL, rosterOf } from "../shared/staff.ts";
import type { StaffCard } from "../shared/staff.ts";
import {
  appendLineageRecord,
  consumeCoordinationApproval,
  findUsableApproval,
  normalizeCoordinationPath,
  readCoordination,
  requestCoordination,
} from "./staff-territory.ts";
import { rememberStaffSession, staffIdOfSession } from "./staff-sessions.ts";
import type { TargetFailure, WorkspaceTargets } from "./tracker/targets.ts";
import { resolveWorkspaceTargets } from "./tracker/targets.ts";

/**
 * 生命周期钩子：把 deck_* 工具挂到 Agent 身上。
 *
 * 为什么走 `before agent.create` 而不是让用户手写 MCP 配置：装插件就该能用。
 * 哪些工作区值得注入见 `shouldInjectDeckTools`：有 GitHub / GitLab 远端时一定有票可读；
 * 本地后端只有工作区里已经存在 `.deck/` 或 `.scratch/`（或用户在设置里明确选了 local）才注入，
 * 否则每个空目录都会多出十几个工具，白白占着上下文和权限面板。
 *
 * 只读工具进 preapproved（Agent 可以自己读票），写工具不进（改票面必须经用户确认）。
 *
 * 客户端连预授权都不接受时（cursor 等），只能退到「每次确认」；设置里的
 * `autoAllowPermissions` 是那条路的出口，语义与边界见 `shouldAutoAllowPermission`。
 */

type AgentCreateRequest = PluginBeforeRequests["agent.create"];

/** 一条预授权：与宿主 `toolPolicy.preapproved` 的元素同形，不从宿主类型里再抄一份。 */
type ToolPolicyGrant = NonNullable<NonNullable<AgentCreateRequest["config"]["toolPolicy"]>["preapproved"]>[number];

const SCOPE = "mcp";

/**
 * 哪些客户端能「精确预授权 MCP 工具」（每次调用不用再问人）。
 *
 * 宿主的插件 API 没暴露这个能力（`providers.snapshot()` 里没有该字段），只能照着内置表
 * `@getpaseo/server` 的 `PROVIDER_CONTRACTS`（内核版本 0.2 时代的 dist 里
 * `provider-registry.js`）写死三家。名单外的客户端**只要**请求里带 `toolPolicy`，
 * 宿主就把整条创建拒掉：
 * `Provider 'cursor' cannot preapprove exact MCP tools for unattended execution; select Claude, Codex, or OpenCode`
 *
 * 已知的不对称：宿主那边另有两类也算支持——插件注册的 provider，以及 `extends: claude/codex`
 * 派生的自定义 provider。前者插件侧认不出来，统一按「不支持」处理，代价是这些客户端下只读的
 * `deck_*` 工具每次要用户点一次确认（降级，不是失败，日志里有记录）。后者只有本插件自己造的
 * `deck-codex` 能认（见下），别家的派生 provider 同样按不支持处理。
 * 反过来的方向才危险：宿主将来若把某家从表里划掉，我们仍会给它带 `toolPolicy`，
 * 那条会话就会被整条拒绝——升级宿主后若出现该报错，先对这张表。
 *
 * 别和 `shared/session.ts` 的 `SLASH_PROVIDERS` 合并：成员碰巧一样，含义是另外一件事。
 */
const EXACT_MCP_PREAPPROVAL_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);

/*
 * 站点启用后 Codex 会话走的派生 provider（`providers.deck-codex`，`extends: "codex"`）。
 * 常量在 `shared/orchestration.ts`：写配置、读配置、这里路由三处必须同一个名字。
 * 它继承 codex 的契约，精确预授权同样可用。
 */

export function supportsExactMcpPreapproval(providerSpec: string): boolean {
  const provider = providerId(providerSpec);
  return provider === CODEX_SITE_PROVIDER || (provider !== "" && EXACT_MCP_PREAPPROVAL_PROVIDERS.has(provider));
}

/**
 * 路由失败必须让创建停下：这时继续放行就等于用 `~/.codex/config.toml` 里的旧地址
 * 悄悄开会话，正是这次要堵的那条路。
 */
export class CodexSiteRouteError extends Error {}

function envText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 注入器本体是纯函数：给定配置就回新配置，便于单测，也保证不原地改请求。 */
export function routeCodexSiteProvider(
  request: AgentCreateRequest,
  providers: Record<string, { extends?: string; enabled?: boolean; env?: Record<string, string> }>,
): AgentCreateRequest {
  const [rawProvider, ...modelParts] = request.config.provider.split("/");
  // 与调用方同一条归一规则（`providerId`）：`Codex/x` 这类写法也要认出来。
  if (providerId(rawProvider) !== "codex") return request;
  const codex = providers[CODEX_SITE_PROVIDER];
  // 派生条目「能用」= 继承 codex、没被停用、还有地址（与面板读路径同一条判据）。
  if (codexSiteUsable(codex)) {
    return {
      ...request,
      config: { ...request.config, provider: [CODEX_SITE_PROVIDER, ...modelParts].join("/") },
    };
  }
  // 走到这里说明没有可用的站点。内建 codex 上仍配着自定义地址 = 旧式注入留下的状态：
  // 那个地址宿主根本不读（它只认派生条目），会话会照旧走 `~/.codex/config.toml`。
  // 这时放行等于把用户的抱怨原样送回给他，只能拦下并说清怎么修。
  const stale = envText(providers.codex?.env?.OPENAI_BASE_URL);
  if (stale) {
    throw new CodexSiteRouteError(
      `Codex 接入地址（${stale}）尚未绑定到会话 provider，继续建会话会退回 ~/.codex/config.toml 里的地址。` +
        "请在编排面板的 Codex 行把这条地址存成站点并启用——凭证可以留空，会沿用现有配置里的那一把——然后再建会话",
    );
  }
  // 派生条目在、但没继承 codex：这不是插件写出来的形状，别拿它开会话。
  if (codex && codex.extends !== "codex") {
    throw new CodexSiteRouteError("Codex 站点派生 provider 配置不完整；请在编排面板重新启用站点后再建会话");
  }
  // 其余两种情况都按普通 Codex 放行：
  // - `enabled: false`（在 Paseo 自己的 provider 设置里停用这条派生 provider）→ 站点没生效，回到原生 Codex；
  // - 派生条目没有地址（历史残留 / 手改过 config.json）→ 拿不出地址，当没配。
  // 两种都要求内建 codex 也没有旧地址，否则上面那条已经拦下了。
  return request;
}

/**
 * 该给这条创建请求算一次 provider 路由吗——要，且只有 Codex 走这条路。
 *
 * 读不到宿主配置时**拒绝**而不是放行：读不到就等于不知道该用哪条地址，放行会退回
 * `~/.codex/config.toml` 里的旧地址（正是这次要堵的那条路）。宁可让用户重试一次。
 */
async function routeProviderIfCodex(
  request: AgentCreateRequest,
  paseo: PluginHookContext["paseo"],
): Promise<AgentCreateRequest> {
  if (providerId(request.config.provider) !== "codex") return request;
  const config = await readDaemonConfig(paseo);
  if (!config) {
    throw new CodexSiteRouteError(
      "读不到宿主配置，没法确认 Codex 该走哪条接入地址（daemon 可能刚重启）：请重试一次；若一直如此，先到编排面板看 Codex 站点是否还在",
    );
  }
  return routeCodexSiteProvider(request, providersRawOf(config));
}

export function injectDeckTools(
  request: AgentCreateRequest,
  input: { entry: string; workspaceDir: string },
): AgentCreateRequest {
  const config = request.config;
  // name 不能叫 "paseo"（保留名），其余随便；固定成插件 id 让用户在权限面板里一眼认出。
  const mcpServers = {
    ...(config.mcpServers ?? {}),
    [MCP_SERVER_NAME]: {
      type: "stdio" as const,
      // 用当前进程的可执行文件跑同一个 Node：它此刻正在执行本插件的 TypeScript，
      // 因此一定能跑 `server/mcp/main.ts`（Node 22.18+ 默认剥离类型），不必另找解释器。
      command: process.execPath,
      args: [input.entry, "--workspace", input.workspaceDir],
      // 这些工具是插件的核心能力，不许被工具检索折叠掉，否则 Agent 根本不知道它们存在。
      alwaysLoad: true,
    },
  };
  // 客户端不接受精确预授权时，`toolPolicy` 原样留着（通常就是没有）：写进去宿主会拒绝整条创建。
  // 用户自己带的那份不删——不替人决定；代价是那种客户端下仍会被宿主拒（已知残留，
  // 解法在用户那边：换客户端，或去掉自带的 policy）。
  const toolPolicy = supportsExactMcpPreapproval(config.provider)
    ? { preapproved: withDeckGrants(config.toolPolicy?.preapproved ?? []) }
    : config.toolPolicy;
  return { ...request, config: { ...config, mcpServers, ...(toolPolicy ? { toolPolicy } : {}) } };
}

/** 在已有预授权后面补上本插件的只读工具，已有的不重复追加。 */
function withDeckGrants(existing: ReadonlyArray<ToolPolicyGrant>): ToolPolicyGrant[] {
  const seen = new Set(existing.map((ref) => `${ref.server}/${ref.tool}`));
  const ours = PREAPPROVED_TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: MCP_SERVER_NAME, tool }));
  return [...existing, ...ours.filter((ref) => !seen.has(`${ref.server}/${ref.tool}`))];
}

/** 插件安装目录下的 MCP 进程入口。 */
export function mcpEntryPath(root: string): string {
  return path.join(root, "server", "mcp", "main.ts");
}

/** 当前进程的 `process.features`（Node 的类型能力标志就在里面）。 */
export function runtimeFeatures(): unknown {
  return (process as { features?: unknown }).features;
}

/**
 * 当前 Node 能不能直接跑 `.ts`。
 *
 * 22.18+ 默认剥离类型（`process.features.typescript === "strip"`）。更老的版本挂上去只会得到
 * 「server failed to start」——而且每个新会话都会重演，所以宁可明确跳过并说明原因。
 *
 * 参数显式传入（而不是默认读 `process.features`），测试才能确定性地覆盖两种能力。
 */
export function typescriptSupported(features: unknown): boolean {
  const value = (features as { typescript?: unknown } | undefined)?.typescript;
  return value === "strip" || value === "transform";
}

/**
 * 注入前的前置检查：返回该跳过并记录的原因，`null` 表示可以注入。
 *
 * 纯函数便于单测：这两条一旦漏掉，用户看到的是「装了插件但 Agent 没有工具」，日志里却什么都没有。
 */
export function injectionProblem(input: { entry: string; entryPresent: boolean; typescript: boolean }): string | null {
  if (!input.typescript) return "当前 Node 不支持直接运行 TypeScript（需要 22.18+），跳过 deck 工具注入";
  if (!input.entryPresent) return `找不到 MCP 入口文件，跳过 deck 工具注入：${input.entry}`;
  return null;
}

/** 注入判定的纯函数：有远端仓库（一个或多个）就注入；本地后端只在已有 `.deck/` / `.scratch/` 时注入。 */
export function shouldInjectDeckTools(targets: WorkspaceTargets | TargetFailure, localBoard: boolean): boolean {
  if (!targets.ok) return false;
  if (targets.kind === "repos") return targets.targets.length > 0;
  return localBoard;
}

/** 本地后端是否在这个工作区里成立（用户明确选了 local，或工作区里已有 `.deck/` / `.scratch/`）。 */
function localBoardPresent(workspaceDir: string): boolean {
  return (
    getSettings().backend === "local" ||
    existsSync(path.join(workspaceDir, ".deck")) ||
    existsSync(path.join(workspaceDir, ".scratch"))
  );
}

/**
 * 一次把「这个工作区要不要 deck 工具」判到底。
 *
 * 注入（`agent.create`）与自动放行（`agent.permission_requested`）问的是同一个问题，
 * 两处都走这里，免得哪天只改了一边（一边装了工具、另一边却不肯替它点头）。
 */
async function deckWorkspaceState(
  workspaceDir: string,
): Promise<{ targets: WorkspaceTargets | TargetFailure; deck: boolean }> {
  const targets = await resolveWorkspaceTargets(workspaceDir);
  return { targets, deck: shouldInjectDeckTools(targets, localBoardPresent(workspaceDir)) };
}

/**
 * 自动放行只管这两类请求。
 *
 * `tool` 是正常的工具调用确认；`other` 是不带身份的那一类——cursor 这类 ACP 客户端
 * 的请求实测只有 `name: "other"`、`description: "-"`，deck 工具和改文件、跑命令长一个样，
 * 所以「只放行 deck 工具」在这里做不到，只能整个会话一律点头（开关默认关，开了就是接受这点）。
 *
 * plan / question / mode 不碰：那是让 Agent 替用户定方案、答问题、换模式，
 * 不属于「工具放行」，自动同意等于替人做决定。
 */
const AUTO_ALLOW_KINDS: ReadonlySet<AgentPermissionRequestKind> = new Set(["tool", "other"]);

/** 判定是否自动同意一条权限请求。纯函数，便于把边界钉在测试里。 */
export function shouldAutoAllowPermission(input: {
  /** 设置里 `autoAllowPermissions` 的当前值，由调用方读出来传进来。 */
  enabled: boolean;
  /** 这个会话所在工作区是不是装过 deck 工具的那种（见 `shouldInjectDeckTools`）。 */
  deckWorkspace: boolean;
  kind: AgentPermissionRequestKind;
}): boolean {
  if (!input.enabled) return false;
  // 只在装过 deck 工具的工作区里动手：别的工作区里放行的不是我们的工具，凭什么替人点。
  if (!input.deckWorkspace) return false;
  return AUTO_ALLOW_KINDS.has(input.kind);
}

/**
 * 目录 → 是否 deck 工作区，判一次缓存一会儿。
 *
 * 每次权限请求都跑一遍 `deckWorkspaceState`（要起 git）太重；一分钟内判定不会变。
 * 键里带上后端：同一个目录在 auto / local / github 下答案不同，少了这一段，
 * 用户切完后端要等缓存过期才生效。条目数就是用户开过的工作区数，几十的量级，不设上限。
 */
const DECK_WORKSPACE_TTL_MS = 60_000;
const deckWorkspaceCache = new Map<string, { at: number; deck: boolean }>();

/** 仅供测试：清掉判定缓存，避免用例之间互相喂旧答案。 */
export function resetDeckWorkspaceCacheForTest(): void {
  deckWorkspaceCache.clear();
}

/**
 * 注入此刻能不能真的发生：与 `before agent.create` 里那两条前置检查同源。
 *
 * 判「这个工作区有 deck 工具」不能只看 `shouldInjectDeckTools`：Node 太老或入口缺失时
 * 注入会被跳过，那些工作区里根本没有 deck 工具，自动放行就不该替用户点头。
 */
function canInjectDeckTools(): boolean {
  const entry = mcpEntryPath(pluginRoot());
  return (
    injectionProblem({
      entry,
      entryPresent: existsSync(entry),
      typescript: typescriptSupported(runtimeFeatures()),
    }) === null
  );
}

async function isDeckWorkspace(workspaceDir: string): Promise<boolean> {
  const dir = workspaceDir.trim();
  if (!dir) return false;
  const key = `${getSettings().backend}\u0000${dir}`;
  const now = Date.now();
  const hit = deckWorkspaceCache.get(key);
  if (hit && now - hit.at < DECK_WORKSPACE_TTL_MS) return hit.deck;
  const { deck } = await deckWorkspaceState(dir);
  const usable = deck && canInjectDeckTools();
  deckWorkspaceCache.set(key, { at: now, deck: usable });
  return usable;
}

/** 宿主对「没有标题」的请求给的是这个哨兵值，不是空串（cursor 实测就是 `-`）。 */
const EMPTY_TITLE = "-";

/** 日志里标题截到这么长：够认出是哪一步，又不至于把一整段命令抄进环形日志。 */
const TITLE_LOG_LIMIT = 80;

/** 日志里怎么写出这条请求：只有 kind / name / title，不碰 `input`（可能带命令原文和路径）。 */
function describePermission(request: { kind: string; name: string; title?: string }, detailType?: string): string {
  // shell 的 title 常是命令原文，可能夹着 token / 连接串：这一类的标题不进日志。
  const title = detailType === "shell" ? "" : request.title?.trim();
  const label = title && title !== EMPTY_TITLE ? `「${title.slice(0, TITLE_LOG_LIMIT)}」` : "";
  return `${request.kind}/${request.name}${label}`;
}

/* ---------------------------------------------------------------- 岗位越界闸 */

/**
 * 越界闸「留给用户确认」的请求。闸先注册先跑，只给请求打标记；后面那条自动放行
 * 看到标记就跳过。没有这一步，「没有可判定的文件证据」会被自动放行翻成 allow。
 */
const heldForUserConfirmation = new Set<string>();
/** 正在判定的闸：就算宿主并发分发，自动放行也先等这一次判定落定，不只靠注册顺序。 */
const gateInFlight = new Map<string, Promise<void>>();

function permissionKey(agentId: string, requestId: string): string {
  return `${agentId}\u0000${requestId}`;
}

/** 仅供测试：清掉「留给人工」的标记，避免用例之间互相喂旧答案。 */
export function resetStaffTerritoryGateForTest(): void {
  heldForUserConfirmation.clear();
  gateInFlight.clear();
}

type LabeledHookAgent = PluginHookAgent & { labels?: Record<string, string> };

/** 协调记录里的任务摘要：优先请求标题，其次会话标题，最后退回路径。 */
function taskSummaryFor(request: AgentPermissionRequest, agent: PluginHookAgent, normalizedPath: string): string {
  const title = (request.title ?? "").trim();
  if (title && title !== EMPTY_TITLE) return title.slice(0, 200);
  const agentTitle = (agent.title ?? "").trim();
  if (agentTitle) return agentTitle.slice(0, 200);
  return `改 ${normalizedPath}`;
}

/** 越界落进收件箱；同一（会话，目标区）的路径合成一条，旧 pending 由 requestCoordination 覆盖。 */
async function recordTerritoryRequest(input: {
  agent: PluginHookAgent;
  fromStaff: string;
  toStaff: string | null;
  normalizedPath: string;
  request: AgentPermissionRequest;
}): Promise<void> {
  const { agent, fromStaff, toStaff, normalizedPath, request } = input;
  if (!agent.workspaceId) {
    record("warn", SCOPE, `越界写没有 workspaceId，协调请求没落盘：agent=${agent.id}，路径 ${normalizedPath}`);
    return;
  }

  try {
    const result = await requestCoordination(agent.cwd, {
      kind: "territory",
      workspaceId: agent.workspaceId,
      fromStaff,
      toStaff,
      sessionAgentId: agent.id,
      taskSummary: taskSummaryFor(request, agent, normalizedPath),
      paths: [normalizedPath],
      mergePendingPaths: true,
    });
    if (!result.ok) {
      record("warn", SCOPE, `落协调请求失败（${normalizedPath} 归 ${toStaff ?? "根经理"}）：${result.detail}`);
    }
  } catch (error) {
    record(
      "warn",
      SCOPE,
      `落协调请求失败（${normalizedPath} 归 ${toStaff ?? "根经理"}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 认出员工会话：标签优先，标签缺失时退回岗位会话台账（事件负载里的 labels 不是稳定字段）。 */
async function staffIdForPermission(agent: PluginHookAgent): Promise<string> {
  const fromLabels = ((agent as LabeledHookAgent).labels?.[DECK_STAFF_LABEL] ?? "").trim();
  if (fromLabels) return fromLabels;
  try {
    return (await staffIdOfSession(agent.cwd, agent.id))?.trim() ?? "";
  } catch (error) {
    record(
      "warn",
      SCOPE,
      `读岗位会话台账失败，本次认不出是不是员工：agent=${agent.id}，${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

/** 没有证据 / 读不出名册时：不自动放行，也不 deny，把请求留给用户。 */
function leavePermissionToUser(agent: PluginHookAgent, request: AgentPermissionRequest, why: string): void {
  // 只有自动放行会碰的那两类请求需要挡一下；plan / question / mode 本来就该人答。
  if (AUTO_ALLOW_KINDS.has(request.kind) && getSettings().autoAllowPermissions) {
    heldForUserConfirmation.add(permissionKey(agent.id, request.id));
  }
  record("warn", SCOPE, `${why}，留给用户确认（${describePermission(request, request.detail?.type)}）：agent=${agent.id}`);
}

type RosterLookup = { readonly ok: true; readonly roster: readonly StaffCard[] } | { readonly ok: false; readonly why: string };
async function rosterForPermission(agent: PluginHookAgent): Promise<RosterLookup> {
  try {
    const read = await readOrchestration(agent.cwd);
    if (read.readFailed || read.corrupt) {
      return {
        ok: false,
        why: `读不出工作区名册（${read.detail ?? (read.corrupt ? "文件损坏" : "IO 失败")}）`,
      };
    }
    // 名册按目录取：同一目录会有好几个 workspaceId，按 id 取会读成一个空名册。
    return { ok: true, roster: rosterOf(read.settings) };
  } catch (error) {
    return { ok: false, why: `读工作区名册失败（${error instanceof Error ? error.message : String(error)}）` };
  }
}

type TerritoryVerdict =
  | { readonly kind: "pass" }
  | { readonly kind: "leave"; readonly why: string }
  | { readonly kind: "outside"; readonly normalized: string; readonly ownerId: string | null; readonly ownerName: string };

/** 只判「归谁管」，不判「该不该改」；用派单同一把尺子，免得两处归属不一致。 */
function territoryVerdict(input: {
  request: AgentPermissionRequest;
  staffId: string;
  roster: readonly StaffCard[];
  workspaceDir: string;
  workspaceId?: string;
}): TerritoryVerdict {
  const { request, staffId, roster, workspaceDir, workspaceId } = input;
  const detail = request.detail;
  const type = detail?.type;

  if (type !== "edit" && type !== "write") {
    // 已知的非写工具（fetch / worktree_setup / sub_agent / ...）不归这道闸管；
    // 只有「看不出来是什么」才不能替用户点头。
    if (type === undefined || type === "unknown") {
      return { kind: "leave", why: "权限请求没有可判定的工具类型（detail 缺失或为 unknown）" };
    }
    return { kind: "pass" };
  }

  const filePath = (detail as { filePath?: unknown }).filePath;
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { kind: "leave", why: "edit / write 请求没有目标路径" };
  }

  const normalized = normalizeCoordinationPath(workspaceDir, filePath);
  if (!normalized) return { kind: "leave", why: "目标路径归一化后为空" };

  const owner = resolveOwner({ path: normalized, roster, workspaceId });
  if (!owner.ok) {
    // 没有卡声明这片：不算「别人的区」，但也不算自己的；不猜，交给确认。
    return { kind: "leave", why: `路径 ${normalized} 没有归属（${owner.detail}）` };
  }
  if (owner.staff.id === staffId) return { kind: "pass" };

  return {
    kind: "outside",
    normalized,
    ownerId: owner.staff.id,
    ownerName: owner.staff.name,
  };
}

/** 用掉（会话，路径）这次批准；读不出记录时按没有批准处理，绝不在读失败时替人放行。 */
async function consumeApprovalIfAny(agent: PluginHookAgent, normalized: string): Promise<boolean> {
  const existing = await readCoordination(agent.cwd);
  if (existing.failed) {
    record(
      "warn",
      SCOPE,
      `读协调记录失败，无法确认有没有「批准这一次」（${normalized}）：${existing.failed}`,
    );
    return false;
  }
  if (!findUsableApproval(existing.records, agent.id, normalized)) return false;

  const consumed = await consumeCoordinationApproval(agent.cwd, agent.id, normalized);
  if (!consumed.ok) {
    record("warn", SCOPE, `「批准这一次」用不掉（${normalized}）：${consumed.detail}`);
    return false;
  }
  return true;
}

type DenyInput = {
  agent: PluginHookAgent; request: AgentPermissionRequest; staffId: string; normalized: string;
  ownerId: string | null; ownerName: string; context: PluginHookContext;
};

async function denyOutOfTerritory(input: DenyInput): Promise<void> {
  const { agent, request, staffId, normalized, ownerId, ownerName, context } = input;
  const ownerLabel = ownerId ?? ownerName;
  const message = `这片归 ${ownerName}${ownerId ? `（${ownerId}）` : ""}，去跟 ${ownerLabel} 协调，别直接改。`;

  try {
    await context.paseo.agents.ref(agent.id).respondToPermission({
      requestId: request.id,
      response: { behavior: "deny", message },
    });
    record(
      "warn",
      SCOPE,
      `越界写已拒绝（${normalized} 归 ${ownerLabel}）：agent=${agent.id}，卡 ${staffId}`,
    );
  } catch (error) {
    // 拒绝没送到宿主时，仍要挡住自动放行：否则同一条请求会被后面的 allow 翻回来。
    if (AUTO_ALLOW_KINDS.has(request.kind) && getSettings().autoAllowPermissions) {
      heldForUserConfirmation.add(permissionKey(agent.id, request.id));
    }
    record(
      "warn",
      SCOPE,
      `越界写拒绝失败（${normalized} 归 ${ownerLabel}）：agent=${agent.id}，${error instanceof Error ? error.message : String(error)}；已挡住自动放行`,
    );
  }

  // 宿主有没有收到 deny 都改变不了「这次越界发生过」：收件箱照样要留一条。
  await recordTerritoryRequest({
    agent,
    fromStaff: staffId,
    toStaff: ownerId,
    normalizedPath: normalized,
    request,
  });
}

/** 员工会话的越界写：拒绝并落一条协调请求；没有证据时既不自动放行也不 deny。 */
async function gateStaffPermission(
  agent: PluginHookAgent,
  request: AgentPermissionRequest,
  context: PluginHookContext,
): Promise<void> {
  const staffId = await staffIdForPermission(agent);
  // 不是员工会话：原样交给后面的处理函数，不改变现有行为。
  if (!staffId) return;

  const type = request.detail?.type;
  // 读与检索永远不拦：越界闸管的是写。
  if (type === "read" || type === "search") return;

  // shell 选择不拦，但要把「这是选择，不是漏了」写进日志。命令内容不进日志：
  // 权限请求里的命令可能带 token / 连接串，日志不是放它的地方。
  if (type === "shell") {
    record("info", SCOPE, `员工会话的 shell 请求选择不拦（不是拦不住）：agent=${agent.id}`);
    return;
  }

  const lookup = await rosterForPermission(agent);
  if (!lookup.ok) {
    leavePermissionToUser(agent, request, lookup.why);
    return;
  }
  const card = lookup.roster.find((item) => item.id === staffId);
  if (!card) {
    leavePermissionToUser(agent, request, `会话标签 ${DECK_STAFF_LABEL}=${staffId} 在名册里找不到对应的卡`);
    return;
  }

  const verdict = territoryVerdict({
    request,
    staffId,
    roster: lookup.roster,
    workspaceDir: agent.cwd,
    workspaceId: agent.workspaceId ?? undefined,
  });
  if (verdict.kind === "pass") return;
  if (verdict.kind === "leave") {
    leavePermissionToUser(agent, request, verdict.why);
    return;
  }

  if (await consumeApprovalIfAny(agent, verdict.normalized)) {
    try {
      await context.paseo.agents.ref(agent.id).respondToPermission({
        requestId: request.id,
        response: { behavior: "allow" },
      });
      record(
        "info",
        SCOPE,
        `按「批准这一次」放行（${verdict.normalized}）：agent=${agent.id}，批准已用掉`,
      );
    } catch (error) {
      if (AUTO_ALLOW_KINDS.has(request.kind) && getSettings().autoAllowPermissions) {
        heldForUserConfirmation.add(permissionKey(agent.id, request.id));
      }
      record(
        "warn",
        SCOPE,
        `「批准这一次」放行失败（${verdict.normalized}）：agent=${agent.id}，${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }

  await denyOutOfTerritory({
    agent,
    request,
    staffId,
    normalized: verdict.normalized,
    ownerId: verdict.ownerId,
    ownerName: verdict.ownerName,
    context,
  });
}

export function registerHooks(server: PluginServerContext): void {
  server.before("agent.create", async ({ request }, context) => {
    // 路由是 try 里的第一句，结果存在 `routed`（初值是原请求）：后面任何一步抛错都
    // 不能把已经算好的 provider 换回原样——那等于退回 `~/.codex/config.toml` 里的旧地址开会话。
    // 路由自己失败（`CodexSiteRouteError`）则整条创建中止，见下面的 catch。
    let routed = request;
    try {
      routed = await routeProviderIfCodex(request, context.paseo);
      const { targets, deck } = await deckWorkspaceState(routed.config.cwd);
      if (!deck) {
        // 不是「出错」，是「这个工作区没有票可读」，所以不注入也不报错，只留一行日志便于排查。
        // 日志带上实际原因（没有远端 / 不是仓库 / 没有 git），别一律写成「没有远端」。
        const why = targets.ok ? "本地后端尚未启用，工作区里也没有 .deck/ 或 .scratch/" : targets.detail;
        record("info", SCOPE, `未注入 deck 工具（${why}）：${routed.config.cwd}`);
        return routed;
      }
      const entry = mcpEntryPath(pluginRoot());
      const problem = injectionProblem({
        entry,
        entryPresent: existsSync(entry),
        typescript: typescriptSupported(runtimeFeatures()),
      });
      if (problem) {
        record("warn", SCOPE, problem);
        // 注入不了工具，但已经算好的 provider 路由要留下：丢掉它等于回到旧地址开会话。
        return routed;
      }
      if (!supportsExactMcpPreapproval(routed.config.provider)) {
        // 降级不是失败：工具照挂，只是每次调用要用户点确认。留一行日志，用户问「怎么老要确认」时有据可查。
        record("info", SCOPE, `客户端 ${routed.config.provider} 不支持精确预授权，deck 工具每次调用都要确认`);
      }
      return injectDeckTools(routed, { entry, workspaceDir: routed.config.cwd });
    } catch (error) {
      // 只有「Codex 站点没接上」这一类要拦：放行就等于用它本来要替换掉的旧地址开会话。
      if (error instanceof CodexSiteRouteError) throw error;
      // 其余（注入失败等）不该拦住用户开会话，日志里留下原因；已经算好的路由要留下。
      record("warn", SCOPE, `注入 deck 工具失败：${error instanceof Error ? error.message : String(error)}`);
      return routed;
    }
  });

  // **越界闸必须注册在「自动放行」之前**：先 deny 掉，后面那条 allow 到达宿主时请求
  // 已经不在了，deny 不会被翻回 allow。顺序是硬条件，不要用配置项绕过。
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    const key = permissionKey(agent.id, request.id);
    const run = (async () => {
      try {
        await gateStaffPermission(agent, request, context);
      } catch (error) {
        // 闸自己出错时既不静默放行，也不卡死会话：标成人工确认，日志留原因。
        if (AUTO_ALLOW_KINDS.has(request.kind) && getSettings().autoAllowPermissions) {
          heldForUserConfirmation.add(key);
        }
        record(
          "warn",
          SCOPE,
          `岗位越界闸判定失败，本次交给用户确认（${describePermission(request, request.detail?.type)}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    gateInFlight.set(key, run);
    try { await run; } finally { gateInFlight.delete(key); }
  });

  // 设置里打开「自动放行」后，替用户点这个确认：客户端不给预授权（cursor 等），
  // 不开这条路的话每调一次 deck 工具都要人点一次。默认关，开关的意义见 `shared/settings.ts`。
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    // 先等闸判完、再消费标记：宿主若并发分发，不能靠「谁先跑」决定 deny 还是 allow。
    await gateInFlight.get(permissionKey(agent.id, request.id));
    const heldForUser = heldForUserConfirmation.delete(permissionKey(agent.id, request.id));
    const enabled = getSettings().autoAllowPermissions;
    if (!enabled) return;
    if (heldForUser) {
      record("info", SCOPE, `权限请求留给用户确认，不自动放行（${describePermission(request, request.detail?.type)}）：${agent.cwd}`);
      return;
    }
    // 判工作区要起 git，所以先看类型：plan / question / mode 永远不放行，没必要为此付这笔钱。
    let deckWorkspace = false;
    if (AUTO_ALLOW_KINDS.has(request.kind)) {
      try {
        deckWorkspace = await isDeckWorkspace(agent.cwd);
      } catch (error) {
        // 判不出来就不放行：宁可多弹一次，也不要在「是不是我们的工作区」都没弄清时替人点头。
        record("warn", SCOPE, `判定是否 deck 工作区失败，本次不自动放行（${describePermission(request, request.detail?.type)}）：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (!shouldAutoAllowPermission({ enabled, deckWorkspace, kind: request.kind })) {
      // 不自动同意也要留痕：用户回头问「为什么还弹」，得能查到是哪种请求、为什么没放。
      // 没判工作区的（类型就不放行）别写「deck 工作区=false」，那是在说另一件事。
      const why = AUTO_ALLOW_KINDS.has(request.kind) ? `deck 工作区=${deckWorkspace}` : "这类请求不自动同意";
      record("info", SCOPE, `未自动放行权限请求（${describePermission(request, request.detail?.type)}，${why}）：${agent.cwd}`);
      return;
    }
    try {
      await context.paseo.agents.ref(agent.id).respondToPermission({
        requestId: request.id,
        response: { behavior: "allow" },
      });
      record("info", SCOPE, `已自动放行权限请求（${describePermission(request, request.detail?.type)}）：${agent.cwd}`);
    } catch (error) {
      // 放行失败不能把会话卡死：请求仍在，用户照常点；日志里留原因。
      record("warn", SCOPE, `自动放行权限请求失败（${describePermission(request, request.detail?.type)}）：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // 岗位单例锁与滚动额度：会话建好之后核一次，超了就归档。
  //
  // 为什么放在这里而不是派单工具里：`deck_dispatch_plan` 跑在 MCP 子进程，
  // `ToolContext` 只有 `workspaceDir`，数不出宿主上已经开着几个；`agent.created`
  // 的事件带完整 `context.paseo`，是唯一「绕不开又能 archive()」的位置。
  server.on("agent.created", async ({ agent }, context) => {
    // 先记「子 → 父」：宿主在父窗口归档时会摘掉父子标签（或不留一行日志），
    // 这条链就断了。记一笔到协调收件箱，链断了也有据可查。
    // 与岗位闸无关，所以放在它前面、也不受它早退影响；写失败只 warn，绝不拦会话。
    if (agent.parentAgentId) {
      try {
        await appendLineageRecord(agent.cwd, {
          workspaceId: agent.workspaceId ?? "",
          childAgentId: agent.id,
          parentAgentId: agent.parentAgentId,
        });
      } catch (error) {
        record("warn", SCOPE, `记「子 → 父」失败（agent=${agent.id}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const read = await readOrchestration(agent.cwd);
      // 读失败时 settings 是默认值（名册为空），staffGateApplies 会直接放行；
      // 这里必须留一条 warn，否则「岗位锁没生效」会像「没配岗位」一样安静。
      if (read.readFailed || read.corrupt) {
        record(
          "warn",
          SCOPE,
          `编排设置读不出来（${read.detail ?? (read.corrupt ? "文件损坏" : "IO 失败")}），岗位单例锁本次跳过：agent=${agent.id}`,
        );
        return;
      }
      // 名册按目录取：同一目录会有好几个 workspaceId，按 id 取会读成一个空名册。
      const roster = rosterOf(read.settings);
      if (!staffGateApplies(roster)) return;

      // 事件载荷上**没有** labels：先 refresh，再把清单拉一遍按 id 找回自己。
      const handle = context.paseo.agents.ref(agent.id);
      await handle.refresh();
      const listed = await context.paseo.agents.list({ filter: { includeArchived: true } });
      const self = listed.entries.find((entry) => entry.agent.id === agent.id)?.agent;
      if (!self) {
        // 读不到标签就不拦：宁可漏一次，也不能因为一次列表没跟上就把会话杀掉。
        record("warn", SCOPE, `岗位闸读不到会话自己的标签，本次不拦：agent=${agent.id}`);
        return;
      }

      // 记下「这个 agent id 是哪张卡开的」：MCP 子进程读不到标签，派单前只能靠这份台账
      // 认调用者。写失败不拦会话——少一条反查记录，比错过一个正常会话轻。
      const sessionStaffId = (self.labels?.[DECK_STAFF_LABEL] ?? "").trim();
      if (sessionStaffId) {
        try {
          await rememberStaffSession(agent.cwd, {
            agentId: agent.id,
            staffId: sessionStaffId,
            workspaceId: agent.workspaceId,
          });
        } catch (error) {
          record(
            "warn",
            SCOPE,
            `记岗位会话台账失败（agent=${agent.id}，卡=${sessionStaffId}）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // 员工不能派活：父会话带 `deck.staff` 且那张卡是员工 → 当场撤掉新会话。
      // 父会话的标签同样不在事件载荷里，只能从刚才那份清单里按 id 找回。
      const parent = agent.parentAgentId
        ? listed.entries.find((entry) => entry.agent.id === agent.parentAgentId)?.agent
        : undefined;
      const workerDispatch = decideWorkerDispatch({
        parentAgentId: agent.parentAgentId ?? null,
        parentLabels: parent?.labels ?? null,
        roster,
      });
      if (workerDispatch.archive) {
        await handle.archive();
        record(
          "warn",
          SCOPE,
          `岗位闸已归档新会话（${workerDispatch.reason}）：${workerDispatch.detail}；agent=${agent.id}`,
        );
        // 拒绝必须给出下一步：告诉员工这条正规通道存在，否则它只会换个写法硬试。
        if (agent.parentAgentId) {
          try {
            await context.paseo.agents
              .ref(agent.parentAgentId)
              .send("你不能派活。需要人手请发 deck_staff_request 给经理：说明要什么、为什么、建议交给谁。");
          } catch (error) {
            record(
              "warn",
              SCOPE,
              `通知员工会话失败（agent=${agent.parentAgentId}），闸已落地，提示没送到：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return;
      }

      const decision = decideStaffGate({
        labels: self.labels ?? {},
        workspaceId: agent.workspaceId,
        selfId: agent.id,
        now: Date.now(),
        roster,
        quota: read.settings.staffSessionQuota,
        sessions: listed.entries.map((entry) => ({
          id: entry.agent.id,
          workspaceId: entry.agent.workspaceId ?? null,
          labels: entry.agent.labels ?? {},
          createdAt: entry.agent.createdAt,
          archivedAt: entry.agent.archivedAt ?? null,
        })),
      });
      if (!decision.archive) return;

      await handle.archive();
      record(
        "warn",
        SCOPE,
        `岗位闸已归档新会话（${decision.reason}）：${decision.detail}；agent=${agent.id}`,
      );
    } catch (error) {
      // 失败方向是放行：一次读盘 / 列表失败不该误杀正常会话。
      record(
        "warn",
        SCOPE,
        `岗位闸判定失败，本次不拦（agent=${agent.id}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // 子会话收尾即回传：用户要的是「一级一级往主窗口回」，这一步不接上，
  // 派出去的活就只剩一句「那个窗口干完了」，成果得靠人一个个点开看。
  const reporter = new TurnReporter();
  server.on("agent.turn_ended", async ({ agent, turnId, outcome }, context) => {
    if (!agent.parentAgentId) return;
    try {
      const enabled = await reportEnabledFor(agent.cwd);
      await reporter.report(context.paseo, { agent, outcome, turnId, reportOnFinish: enabled });
    } catch (error) {
      // 回传失败不能影响会话本身：日志里留原因，回传件仍在 .deck/handoffs/。
      record("warn", SCOPE, `子会话收尾回传异常：${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
