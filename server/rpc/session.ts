import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  sessionHandoffRpc,
  sessionHandoffsListRpc,
  sessionHandoffReadRpc,
  sessionLedgerRpc,
  sessionSendRpc,
} from "../../shared/session-rpc.ts";
import type { LedgerScopeOptions } from "../ledger.ts";
import { readLedger, sendToAgent, writeHandoff } from "../session.ts";
import { listHandoffs, readHandoff } from "../ledger.ts";

/**
 * 会话桥的 RPC 出口。
 *
 * 会话来自宿主，不是插件自己的对象：执行层（`server/session.ts`）已经把所有失败
 * 收敛成结果联合，这里只做输入整形与字段搬运，不再吞一次异常。
 */

type ScopeInput = { cwd?: string; agentId?: string | null } | undefined;

/** RPC 只接受 cwd / agentId；`homeDir` 由服务端环境决定，不从线上传。 */
function ledgerScopeOf(input: ScopeInput): LedgerScopeOptions {
  if (!input) return {};
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    // 显式 null 有语义：强制按工作区作用域，不能当成「没传」。
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
  };
}

export async function sessionSendHandler(
  input: RpcInput<typeof sessionSendRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof sessionSendRpc>> {
  return sendToAgent(context.paseo, {
    plan: input.plan,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
    ...(input.queueTimeoutMs !== undefined ? { queueTimeoutMs: input.queueTimeoutMs } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.ticket ? { ticket: input.ticket } : {}),
    ...(input.ledger !== undefined
      ? { ledger: input.ledger === false ? false : ledgerScopeOf(input.ledger) }
      : {}),
    ...(input.verifyCommands !== undefined ? { verifyCommands: input.verifyCommands } : {}),
  });
}

export async function sessionLedgerHandler(
  input: RpcInput<typeof sessionLedgerRpc>,
): Promise<RpcOutput<typeof sessionLedgerRpc>> {
  return readLedger(ledgerScopeOf(input));
}

/** 交接文档默认落盘；`save: false` 时只渲染，供界面预览或复制。 */
export async function sessionHandoffHandler(
  input: RpcInput<typeof sessionHandoffRpc>,
): Promise<RpcOutput<typeof sessionHandoffRpc>> {
  return writeHandoff({
    handoff: input.handoff,
    ledger: input.save === false ? false : ledgerScopeOf(input),
  });
}

export async function sessionHandoffsListHandler(
  input: RpcInput<typeof sessionHandoffsListRpc>,
): Promise<RpcOutput<typeof sessionHandoffsListRpc>> {
  const result = await listHandoffs(ledgerScopeOf(input));
  if (!result.ok) return { ok: false, reason: result.reason === "scope-missing" ? "scope-missing" : "read-failed", detail: result.detail };
  return { ok: true, files: result.files };
}

export async function sessionHandoffReadHandler(
  input: RpcInput<typeof sessionHandoffReadRpc>,
): Promise<RpcOutput<typeof sessionHandoffReadRpc>> {
  const result = await readHandoff(input.name, ledgerScopeOf(input));
  if (!result.ok) return { ok: false, reason: result.reason === "scope-missing" ? "scope-missing" : result.reason === "not-found" ? "not-found" : "read-failed", detail: result.detail };
  return { ok: true, name: result.name, path: result.path, markdown: result.markdown };
}
