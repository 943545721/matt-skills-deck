import type { PaseoAgentCreateOptions, PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import { renderHandoff, type SessionSendPlan } from "../shared/session.ts";
import { applyWorkRouteEvent, type WorkRouteTicket } from "../shared/work-route.ts";
import {
  readWorkRouteLedger,
  saveHandoff,
  updateWorkRouteLedger,
  type HandoffReadResult,
  type LedgerReadResult,
  type LedgerScopeOptions,
  type LedgerUpdateResult,
} from "./ledger.ts";

/**
 * 会话桥的服务端执行层。
 *
 * 这里不注册 RPC：主线程把 `createAgent` / `sendToAgent` / `readLedger` 接到自己的
 * RPC 和 hooks 上即可。所有函数都返回可解释的结果联合，不把异常抛给调用方，
 * 也不把「部分成功」写成「成功」。
 */

export type SessionErrorKind =
  | "unauthenticated"
  | "repo"
  | "permission"
  | "timeout"
  | "not-found"
  | "invalid-input"
  | "unknown";

const ERROR_PATTERNS: ReadonlyArray<{ kind: SessionErrorKind; pattern: RegExp }> = [
  { kind: "timeout", pattern: /timeout|timed out|deadline|ETIMEDOUT|ESOCKETTIMEDOUT/i },
  {
    kind: "unauthenticated",
    pattern:
      /unauthori[sz]ed|unauthenticated|not logged in|login required|authentication|invalid (?:api )?(?:key|token)|credential|\b401\b/i,
  },
  { kind: "permission", pattern: /forbidden|permission|not allowed|denied|EACCES|EPERM|\b403\b/i },
  {
    kind: "not-found",
    pattern: /(?:agent|session).*(?:not found|unknown|missing|does not exist|no such)|no such agent/i,
  },
  {
    kind: "repo",
    pattern:
      /(?:repo(?:sitory)?|workspace|directory|cwd).*(?:not found|missing|invalid|no such|does not exist|not exist)|not a git repository|ENOENT|\b404\b/i,
  },
];

export function sessionErrorDetail(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 把宿主/提供方的报错分成四类主因（未登录、仓库、权限、超时），其余归到 unknown。 */
export function classifySessionError(error: unknown): SessionErrorKind {
  const text = sessionErrorDetail(error);
  for (const rule of ERROR_PATTERNS) {
    if (rule.pattern.test(text)) return rule.kind;
  }
  return "unknown";
}

/** 创建快照的最小结构；宿主实际对象字段更多，多的字段这里用不到。 */
export interface CreationSnapshotView {
  phase: "accepted" | "workspace_ready" | "agent_ready" | "prompt_started" | "completed" | "failed";
  agentId?: string | null;
  error?: string | null;
  errorCode?: string;
  failedStage?: string;
  outcomeUnknown?: boolean;
}

export interface SessionFailure {
  kind: SessionErrorKind;
  detail: string;
  /** 快照停在哪个阶段；没有快照时为 null。 */
  phase: string | null;
  /** 已经建出来的 agent；构建失败的请求里也可能有值。 */
  agentId: string | null;
  /** 宿主自己说结果不确定时照实转告，不替它猜。 */
  outcomeUnknown: boolean;
}

/** 台账写入是附带动作：失败不回滚会话，但必须让调用方看见。 */
export interface LedgerNote {
  ok: boolean;
  skipped: boolean;
  detail?: string;
}

function ledgerFailed(result: LedgerUpdateResult): LedgerNote {
  return result.ok ? { ok: true, skipped: false } : { ok: false, skipped: false, detail: `${result.reason}: ${result.detail}` };
}

function snapshotFailure(snapshot: CreationSnapshotView | null): SessionFailure | null {
  if (!snapshot) return null;
  const failed = snapshot.phase === "failed" || Boolean(snapshot.error);
  if (!failed) return null;
  const detail = snapshot.error?.trim()
    ? snapshot.error
    : `创建快照停在 ${snapshot.phase} 阶段，宿主没有给出错误文本`;
  return {
    kind: classifySessionError(`${snapshot.errorCode ?? ""} ${detail}`),
    detail,
    phase: snapshot.phase,
    agentId: snapshot.agentId ?? null,
    outcomeUnknown: snapshot.outcomeUnknown === true,
  };
}

export interface CreateAgentInput {
  cwd: string;
  /** `claude` / `codex` / `opencode`，或 `provider/model`。 */
  provider: string;
  prompt?: string;
  title?: string;
  idempotencyKey?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /**
   * 父会话 id。传了它宿主会写 `paseo.parent-agent-id`、把子会话挂到父工作区，
   * 并在 `agent.turn_ended` 里把 `parentAgentId` 交给插件——回传链条靠这一步接上。
   */
  parentAgentId?: string;
  /** 有票时顺手记进工作路线台账。 */
  ticket?: WorkRouteTicket;
  /** `false` 关闭台账写入；对象用于覆盖数据目录。 */
  ledger?: LedgerScopeOptions | false;
}

export type CreateAgentResult =
  | {
      ok: true;
      agentId: string;
      title: string | null;
      /** true 表示 agent 建出来了，但首个回合或工作区准备失败。 */
      partial: boolean;
      failure: SessionFailure | null;
      ledger: LedgerNote;
    }
  | { ok: false; failure: SessionFailure };

async function recordTicket(
  agentId: string,
  ticket: WorkRouteTicket | undefined,
  options: LedgerScopeOptions | false | undefined,
): Promise<LedgerNote> {
  if (!ticket || options === false) return { ok: true, skipped: true };
  // 显式 null 表示「强制按工作区」：`??` 会把 null 当成缺省，把新会话的票记进 agent 台账。
  const scope: LedgerScopeOptions = {
    ...(options ?? {}),
    agentId: options && options.agentId !== undefined ? options.agentId : agentId,
  };
  const result = await updateWorkRouteLedger(
    (ledger) =>
      applyWorkRouteEvent(ledger, { kind: "attach", ticket, agentId, at: new Date().toISOString() }),
    scope,
  );
  return ledgerFailed(result);
}

/**
 * 新建 agent。
 *
 * 宿主的 `agents.create` 在「agent 已建、首个提示词失败」时仍可能返回 handle，
 * 所以创建快照要一路收着：最后一条快照是 failed 或有 error，就按部分成功返回，
 * 不能让界面显示「已创建并开始工作」。
 */
export async function createAgent(paseo: PaseoApi, input: CreateAgentInput): Promise<CreateAgentResult> {
  const provider = input.provider.trim();
  if (!provider || !input.cwd.trim()) {
    return {
      ok: false,
      failure: {
        kind: "invalid-input",
        detail: "新建会话需要 provider 与工作区目录",
        phase: null,
        agentId: null,
        outcomeUnknown: false,
      },
    };
  }
  let lastSnapshot: CreationSnapshotView | null = null;
  const title = input.title?.trim();
  const options: PaseoAgentCreateOptions = {
    config: {
      provider,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
      ...(input.featureValues ? { featureValues: input.featureValues } : {}),
    },
    cwd: input.cwd,
    onEvent: (snapshot: CreationSnapshotView) => {
      lastSnapshot = snapshot;
    },
    ...(input.prompt?.trim() ? { prompt: input.prompt } : {}),
    ...(title ? { title } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(input.parentAgentId ? { parent: input.parentAgentId } : {}),
  };

  let handle: PaseoAgentHandle;
  try {
    handle = await paseo.agents.create(options);
  } catch (error) {
    const snapshot = lastSnapshot as CreationSnapshotView | null;
    const detail = sessionErrorDetail(error);
    return {
      ok: false,
      failure: {
        kind: classifySessionError(error),
        detail,
        phase: snapshot?.phase ?? null,
        agentId: snapshot?.agentId ?? null,
        outcomeUnknown: snapshot?.outcomeUnknown === true,
      },
    };
  }

  // 回调里的赋值 TS 看不到，显式标注一次，避免把快照窄化成 null。
  const snapshot = lastSnapshot as CreationSnapshotView | null;
  const agentId = handle?.id?.trim();
  if (!agentId) {
    return {
      ok: false,
      failure: {
        kind: "unknown",
        detail: "宿主返回的创建结果没有 agent id",
        phase: snapshot?.phase ?? null,
        agentId: null,
        outcomeUnknown: true,
      },
    };
  }
  const failure = snapshotFailure(snapshot);
  const ledger = await recordTicket(agentId, input.ticket, input.ledger);
  return { ok: true, agentId, title: title || null, partial: failure !== null, failure, ledger };
}

export interface SendToAgentInput {
  plan: SessionSendPlan;
  /** 新建会话时必填；`provider/model` 里的第一段是提供方。 */
  provider?: string;
  modeId?: string;
  thinkingOptionId?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /** 忙碌时用户已经点过确认。 */
  confirmed?: boolean;
  /** queue 模式等待当前回合结束的上限，缺省 10 分钟。 */
  queueTimeoutMs?: number;
  messageId?: string;
  ticket?: WorkRouteTicket;
  ledger?: LedgerScopeOptions | false;
  /** 发送前用 `handle.commands()` 核实技能是否存在；缺省 true。 */
  verifyCommands?: boolean;
}

const DEFAULT_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;

export type SendToAgentResult =
  | { ok: true; target: "copy"; prompt: string; title: string | null }
  | {
      ok: true;
      target: "current" | "new";
      agentId: string;
      partial: boolean;
      failure: SessionFailure | null;
      /** queue 模式是否真的等过当前回合。 */
      waited: boolean;
      /** true / false：核实过；null：没核实（新建会话或提供方不回答）。 */
      skillAvailable: boolean | null;
      ledger: LedgerNote;
    }
  | {
      ok: false;
      reason: SessionErrorKind | "confirmation-required" | "busy" | "invalid-target";
      detail: string;
      agentId: string | null;
    };

function isBusy(handle: PaseoAgentHandle): boolean {
  return handle.activeTurn !== null || handle.status === "running";
}

/** 命令清单只用于降级判断：提供方答不上来（error 非空）时不阻断发送。 */
async function skillAvailable(handle: PaseoAgentHandle, skill: string): Promise<boolean | null> {
  try {
    const result = await handle.commands();
    if (result.error) return null;
    const wanted = skill.toLowerCase();
    return result.commands.some((command) => command.name.replace(/^\//, "").toLowerCase() === wanted);
  } catch {
    return null;
  }
}

interface CurrentSendOutcome {
  ok: boolean;
  waited: boolean;
  skillAvailable: boolean | null;
  reason?: SessionErrorKind | "confirmation-required" | "busy";
  detail?: string;
}

async function sendToCurrent(handle: PaseoAgentHandle, input: SendToAgentInput): Promise<CurrentSendOutcome> {
  const plan = input.plan;
  try {
    const refreshed = await handle.refresh();
    if (!refreshed || !handle.current()) {
      return { ok: false, waited: false, skillAvailable: null, reason: "not-found", detail: "目标会话不存在或已归档" };
    }
  } catch (error) {
    return {
      ok: false,
      waited: false,
      skillAvailable: null,
      reason: classifySessionError(error),
      detail: sessionErrorDetail(error),
    };
  }

  let busy = isBusy(handle);
  let waited = false;
  // 先确认再排队：客户端快照可能比服务端旧，所以这里只信 refresh 后的真实状态。
  // 只要服务端看到忙，就必须由用户显式确认；queue 也不能绕过。
  if (busy && input.confirmed !== true) {
    return {
      ok: false,
      waited: false,
      skillAvailable: null,
      reason: "confirmation-required",
      detail: "会话正忙：需要用户确认后才能发送",
    };
  }
  if (busy && plan.sendMode === "queue") {
    try {
      const finish = await handle.waitForFinish(input.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
      // waitForFinish 正常返回 timeout / permission 时回合并没有真正结束，
      // 不能只看 handle 快照：快照在 timeout 分支可能还是等待前的旧值。
      waited = true;
      busy = isBusy(handle) || finish.status === "timeout" || finish.status === "permission";
    } catch (error) {
      return {
        ok: false,
        waited: false,
        skillAvailable: null,
        reason: classifySessionError(error),
        detail: `排队等待当前回合时出错：${sessionErrorDetail(error)}`,
      };
    }
    if (busy) {
      // SDK 的 `send` 只有 interrupt / steer，没有 queue：等不到结束就发，等同于打断。
      // 所以这里宁可返回 busy，也不发——「不默认打断」优先于「一定发出去」。
      return {
        ok: false,
        waited,
        skillAvailable: null,
        reason: "busy",
        detail: "等待超时，当前回合仍在运行；未发送，也没有打断它",
      };
    }
  }

  let prompt = plan.prompt;
  let available: boolean | null = null;
  if (input.verifyCommands !== false && plan.skill && plan.prompt.startsWith("/")) {
    available = await skillAvailable(handle, plan.skill);
    if (available === false) prompt = plan.plainPrompt ?? prompt;
  }

  // 收窄「检查后、发送前」的竞态：如果等待/核实命令期间另一个客户端刚启动了回合，
  // queue 绝不能在这个窗口里被当成可打断的发送，宁可不发。
  if (plan.sendMode === "queue") {
    try {
      const refreshed = await handle.refresh();
      if (!refreshed || !handle.current()) {
        return { ok: false, waited, skillAvailable: available, reason: "not-found", detail: "目标会话不存在或已归档" };
      }
      if (isBusy(handle)) {
        return {
          ok: false,
          waited,
          skillAvailable: available,
          reason: "busy",
          detail: "发送前会话又开始了新回合；未发送，也没有打断它",
        };
      }
    } catch (error) {
      return {
        ok: false,
        waited,
        skillAvailable: available,
        reason: classifySessionError(error),
        detail: `发送前刷新会话状态失败：${sessionErrorDetail(error)}`,
      };
    }
  }

  // queue 且已确认空闲时不传 activeTurnBehavior；只有用户显式选了 interrupt / steer 才传。
  // 残余竞态：检查后、send 前若刚好有新回合启动，宿主会对省略项按自己的默认处理；
  // 这里不做补偿，交给界面在发送后刷新状态。
  const options =
    plan.sendMode === "queue"
      ? input.messageId
        ? { messageId: input.messageId }
        : undefined
      : {
          activeTurnBehavior: plan.sendMode,
          ...(input.messageId ? { messageId: input.messageId } : {}),
        };
  try {
    await handle.send(prompt, options);
    return { ok: true, waited, skillAvailable: available };
  } catch (error) {
    return {
      ok: false,
      waited,
      skillAvailable: available,
      reason: classifySessionError(error),
      detail: sessionErrorDetail(error),
    };
  }
}

/**
 * 执行发送计划。
 *
 * - `copy`：只回提示词，不碰任何会话。
 * - `current`：先刷新状态；忙碌且 queue 时等当前回合结束再发，等不到就报 busy。
 * - `new`：走 `createAgent`，把首个提示词随创建一起发出。
 *
 * 无论哪条路径，台账写入失败都只作为附注返回，不把已经发生的发送说成失败。
 */
export async function sendToAgent(paseo: PaseoApi, input: SendToAgentInput): Promise<SendToAgentResult> {
  const plan = input.plan;
  if (plan.target.kind === "copy") {
    return { ok: true, target: "copy", prompt: plan.prompt, title: plan.title ?? null };
  }

  if (plan.target.kind === "new") {
    const provider = input.provider?.trim() ?? "";
    if (!provider || !plan.target.cwd.trim()) {
      return { ok: false, reason: "invalid-target", detail: "新建会话需要 provider 与工作区目录", agentId: null };
    }
    const created = await createAgent(paseo, {
      cwd: plan.target.cwd,
      provider,
      prompt: plan.prompt,
      ...(plan.title ? { title: plan.title } : {}),
      ...(plan.idempotencyKey ? { idempotencyKey: plan.idempotencyKey } : {}),
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.ticket ? { ticket: input.ticket } : {}),
      ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
    });
    if (!created.ok) {
      return {
        ok: false,
        reason: created.failure.kind,
        detail: created.failure.detail,
        agentId: created.failure.agentId,
      };
    }
    return {
      ok: true,
      target: "new",
      agentId: created.agentId,
      partial: created.partial,
      failure: created.failure,
      waited: false,
      // 新建时首个提示词随创建进入，没有会话可核实技能清单。
      skillAvailable: null,
      ledger: created.ledger,
    };
  }

  let handle: PaseoAgentHandle;
  try {
    handle = paseo.agents.ref(plan.target.agentId);
  } catch (error) {
    return {
      ok: false,
      reason: classifySessionError(error),
      detail: sessionErrorDetail(error),
      agentId: plan.target.agentId,
    };
  }
  const outcome = await sendToCurrent(handle, input);
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason ?? "unknown",
      detail: outcome.detail ?? "发送失败",
      agentId: plan.target.agentId,
    };
  }
  const ledger = await recordTicket(plan.target.agentId, input.ticket, input.ledger);
  return {
    ok: true,
    target: "current",
    agentId: plan.target.agentId,
    partial: false,
    failure: null,
    waited: outcome.waited,
    skillAvailable: outcome.skillAvailable,
    ledger,
  };
}

/** 读取工作路线台账；`server/session.ts` 对外只暴露这一个读入口。 */
export async function readLedger(options: LedgerScopeOptions = {}): Promise<LedgerReadResult> {
  return readWorkRouteLedger(options);
}

export interface WriteHandoffInput {
  /** 交给 `renderHandoff` 的原始数据；类型错误由渲染层拒绝。 */
  handoff: unknown;
  /** `false` 只渲染不落盘；对象用于覆盖数据目录。 */
  ledger?: LedgerScopeOptions | false;
}

export type WriteHandoffResult =
  | { ok: true; markdown: string; saved: false; path: null; name: null }
  | { ok: true; markdown: string; saved: true; path: string; name: string }
  | { ok: false; reason: "invalid-handoff" | "scope-missing" | "write-failed"; detail: string };

function handoffTitleOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const title = (input as { title?: unknown }).title;
  return typeof title === "string" ? title : undefined;
}

/**
 * 渲染并保存交接文档。
 *
 * 渲染失败（输入连对象都不是）明确报 invalid-handoff；保存失败时仍返回 Markdown，
 * 让用户至少能复制内容，而不是白跑一次。
 */
export async function writeHandoff(input: WriteHandoffInput): Promise<WriteHandoffResult> {
  let markdown: string;
  try {
    markdown = renderHandoff(input.handoff);
  } catch (error) {
    return { ok: false, reason: "invalid-handoff", detail: sessionErrorDetail(error) };
  }
  if (input.ledger === false) {
    return { ok: true, markdown, saved: false, path: null, name: null };
  }
  const saved = await saveHandoff(markdown, {
    ...(input.ledger ?? {}),
    title: handoffTitleOf(input.handoff),
  });
  if (!saved.ok) return { ok: false, reason: saved.reason, detail: saved.detail };
  return { ok: true, markdown, saved: true, path: saved.path, name: saved.name };
}

export type { HandoffReadResult, LedgerReadResult, LedgerUpdateResult };
