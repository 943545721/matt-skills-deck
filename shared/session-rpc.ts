import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 会话桥的 RPC 契约。
 *
 * 发送计划本身由 `shared/session.ts` 的纯函数在客户端算好，这里只固定「送进服务端执行」
 * 与「读台账 / 写交接」的线上形状。服务端不重新解释计划里的提示词，
 * 但会重新校验结构——客户端传来的 plan 仍然只是输入，不是可信执行指令。
 *
 * 刻意不接受 `homeDir` / `env`：前者能把台账读写引到任意目录，后者会替 Agent 改环境。
 * 作用域只允许工作区目录与 agent id，数据目录交给服务端按自身环境解析。
 */

const promptAction = z.enum(["diagnose", "fix", "research", "discuss", "prototype", "supplement", "execute", "fixate", "takeover", "handoff", "new-requirement", "discuss-wayfinder", "discuss-grill", "bug", "custom"]);
const promptLang = z.enum(["en", "zh"]);
const sendMode = z.enum(["queue", "interrupt", "steer"]);
const sessionErrorKind = z.enum([
  "unauthenticated",
  "repo",
  "permission",
  "timeout",
  "not-found",
  "invalid-input",
  "unknown",
]);
const sendFailureReason = z.enum([
  "unauthenticated",
  "repo",
  "permission",
  "timeout",
  "not-found",
  "invalid-input",
  "unknown",
  "confirmation-required",
  "busy",
  "invalid-target",
]);

export const promptActionContextSchema = z.object({
  lang: promptLang,
  repoKey: z.string().max(300).optional(),
  number: z.number().int().positive().optional(),
  title: z.string().max(2000).optional(),
  url: z.string().max(2000).optional(),
  provider: z.string().max(120).optional(),
  notes: z.string().max(20_000).optional(),
});

export const sessionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current"), agentId: z.string().min(1).max(300) }),
  z.object({ kind: z.literal("new"), cwd: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal("copy") }),
]);

export const sessionSendPlanSchema = z.object({
  target: sessionTargetSchema,
  prompt: z.string().min(1).max(100_000),
  title: z.string().max(500).optional(),
  sendMode,
  requiresConfirmation: z.boolean(),
  skill: z.string().max(120).optional(),
  plainPrompt: z.string().max(100_000).optional(),
  idempotencyKey: z.string().max(200).optional(),
});

const ledgerScopeSchema = z.object({
  cwd: z.string().min(1).max(4096).optional(),
  agentId: z.string().min(1).max(300).nullable().optional(),
});

const workRouteTicketSchema = z.object({
  repoKey: z.string().max(300).nullable(),
  number: z.number().int().positive(),
  title: z.string().max(2000),
  url: z.string().max(2000).nullable().optional(),
});

const sessionFailureSchema = z.object({
  kind: sessionErrorKind,
  detail: z.string(),
  phase: z.string().nullable(),
  agentId: z.string().nullable(),
  outcomeUnknown: z.boolean(),
});

const ledgerNoteSchema = z.object({
  ok: z.boolean(),
  skipped: z.boolean(),
  detail: z.string().optional(),
});

export const sessionSendRpc = defineRpc({
  name: "deck.session.send",
  input: z.object({
    plan: sessionSendPlanSchema,
    /** 只在 `target.kind === "new"` 时需要。 */
    provider: z.string().min(1).max(120).optional(),
    /**
     * 只在 `target.kind === "new"` 时需要：新会话落进哪条工作区。
     * 不传就按 `cwd` 建，宿主会为同一目录再登记一条同名工作区。
     */
    workspaceId: z.string().max(200).optional(),
    modeId: z.string().max(200).optional(),
    thinkingOptionId: z.string().max(200).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    /** 忙碌时用户已确认。 */
    confirmed: z.boolean().optional(),
    queueTimeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
    messageId: z.string().max(200).optional(),
    ticket: workRouteTicketSchema.optional(),
    ledger: z.union([ledgerScopeSchema, z.literal(false)]).optional(),
    verifyCommands: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      target: z.literal("copy"),
      prompt: z.string(),
      title: z.string().nullable(),
    }),
    z.object({
      ok: z.literal(true),
      target: z.enum(["current", "new"]),
      agentId: z.string(),
      partial: z.boolean(),
      failure: sessionFailureSchema.nullable(),
      waited: z.boolean(),
      skillAvailable: z.boolean().nullable(),
      ledger: ledgerNoteSchema,
    }),
    z.object({
      ok: z.literal(false),
      reason: sendFailureReason,
      detail: z.string(),
      agentId: z.string().nullable(),
    }),
  ]),
});

const ledgerScopeSchemaOut = z.object({
  kind: z.enum(["agent", "workspace"]),
  id: z.string(),
  file: z.string(),
  handoffDir: z.string(),
});

const workRouteEntrySchema = z.object({
  ticketKey: z.string(),
  repoKey: z.string().nullable(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().nullable(),
  status: z.enum(["attached", "in-progress", "done", "released"]),
  agentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  note: z.string().nullable(),
});

export const sessionLedgerRpc = defineRpc({
  name: "deck.session.ledger",
  input: ledgerScopeSchema,
  output: z.union([
    z.object({
      ok: z.literal(true),
      scope: ledgerScopeSchemaOut,
      ledger: z.object({
        version: z.literal(1),
        updatedAt: z.string(),
        entries: z.array(workRouteEntrySchema),
      }),
      recovered: z.boolean(),
      dropped: z.number().int().nonnegative(),
      corruptPath: z.string().nullable(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["scope-missing", "read-failed"]),
      detail: z.string(),
    }),
  ]),
});

export const sessionHandoffRpc = defineRpc({
  name: "deck.session.handoff",
  input: z.object({
    handoff: z.unknown(),
    /** `false` 只渲染 Markdown，不落盘。 */
    save: z.boolean().optional(),
    cwd: z.string().min(1).max(4096).optional(),
    agentId: z.string().min(1).max(300).nullable().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      markdown: z.string(),
      saved: z.literal(false),
      path: z.null(),
      name: z.null(),
    }),
    z.object({
      ok: z.literal(true),
      markdown: z.string(),
      saved: z.literal(true),
      path: z.string(),
      name: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid-handoff", "scope-missing", "write-failed"]),
      detail: z.string(),
    }),
  ]),
});

export const sessionHandoffsListRpc = defineRpc({
  name: "deck.session.handoffs.list",
  input: ledgerScopeSchema,
  output: z.object({ ok: z.literal(true), files: z.array(z.object({ name: z.string(), path: z.string(), modifiedAt: z.string(), size: z.number() })) }).or(
    z.object({ ok: z.literal(false), reason: z.enum(["scope-missing", "read-failed"]), detail: z.string() }),
  ),
});

export const sessionHandoffReadRpc = defineRpc({
  name: "deck.session.handoffs.read",
  input: ledgerScopeSchema.extend({ name: z.string().min(1).max(300) }),
  output: z.object({ ok: z.literal(true), name: z.string(), path: z.string(), markdown: z.string() }).or(
    z.object({ ok: z.literal(false), reason: z.enum(["scope-missing", "read-failed", "not-found", "invalid-name"]), detail: z.string() }),
  ),
});

export { promptAction, promptActionContextSchema as promptContextSchema, sendMode };
