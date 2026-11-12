import path from "node:path";
import { DECK_DIR } from "../shared/local-layout.ts";
import { handoffFromDisk, type HandoffEnvelope } from "../shared/handoff-to-dispatcher.ts";
import { messageOf, moveOutboxFile, outboxFileExists, readOutboxBox, writeJsonAtomic } from "./outbox-fs.ts";
import { record } from "./logs.ts";

/**
 * 主窗口 → 派单窗口的投递件：`<工作区>/.deck/dispatch-handoffs/<box>/<handoffId>.json`。
 *
 * 为什么落文件而不是直接发消息：MCP 工具进程没有宿主连接，主窗口交接时也拿不到
 * 派单窗口忙不忙。文件先进 outbox，relay 在事件里按当前绑定把件送出去；
 * 派单窗口没配、被关掉、正在跑活，件都留在原地，不会因为一次投递失败就丢了活。
 *
 * 三个箱子：
 *   pending/ 还没送到；sent/ 已送达；failed/ 重试超限或永久没有收件人。
 */

const SCOPE = "dispatch.handoff";
const META = Object.freeze({ scope: SCOPE, label: "交接件" });

export const DISPATCH_HANDOFF_DIR = "dispatch-handoffs";

export type HandoffBox = "pending" | "sent" | "failed";

const BOXES: readonly HandoffBox[] = Object.freeze(["pending", "sent", "failed"]);

/** 重试到这个次数还不成，就移进 failed/，并留一条日志等人看。 */
export const MAX_HANDOFF_ATTEMPTS = 5;

export function handoffRootOf(workspaceDir: string): string {
  return path.join(workspaceDir, DECK_DIR, DISPATCH_HANDOFF_DIR);
}

export function handoffBoxDirOf(workspaceDir: string, box: HandoffBox): string {
  return path.join(handoffRootOf(workspaceDir), box);
}

/** handoffId 会拼进文件名：只接受我们自己生成的 16 位十六进制，杜绝 `../`。 */
function safeHandoffId(value: string): string | null {
  return /^[0-9a-f]{16}$/.test(value) ? value : null;
}

export function handoffPathOf(workspaceDir: string, box: HandoffBox, handoffId: string): string | null {
  const id = safeHandoffId(handoffId);
  return id ? path.join(handoffBoxDirOf(workspaceDir, box), `${id}.json`) : null;
}

export type WriteHandoffResult =
  | { ok: true; path: string; duplicate: boolean }
  | { ok: false; detail: string };

/**
 * 把一份交接件放进 pending/。
 *
 * 同一个 handoffId 已经在任何一个箱子里就当作重复：主窗口重试一次，不该变成两条派单。
 * 已 sent 的也算重复——已经送出去过，更不能再送一遍。
 */
export async function writePendingHandoff(workspaceDir: string, envelope: HandoffEnvelope): Promise<WriteHandoffResult> {
  const file = handoffPathOf(workspaceDir, "pending", envelope.handoffId);
  if (!file) return { ok: false, detail: `handoffId 不能用作文件名：${envelope.handoffId}` };
  try {
    for (const box of BOXES) {
      const existing = handoffPathOf(workspaceDir, box, envelope.handoffId);
      if (existing && (await outboxFileExists(existing))) return { ok: true, path: existing, duplicate: true };
    }
    await writeJsonAtomic(file, envelope);
    return { ok: true, path: file, duplicate: false };
  } catch (error) {
    // 去重判断本身读不了盘时也要如实报失败：静默当成「没写过」会重复落盘、重复派活。
    return { ok: false, detail: messageOf(error) };
  }
}

/** 这份件现在还在 pending/ 吗：drain 拿到的是快照，投递前要拿实时状态再确认一次。 */
export async function isHandoffPending(workspaceDir: string, handoffId: string): Promise<boolean> {
  const file = handoffPathOf(workspaceDir, "pending", handoffId);
  return file ? outboxFileExists(file) : false;
}

/** 读 pending/ 里的全部交接件；坏件跳过并留日志，不让一份手改坏的文件堵死整条队列。 */
export async function listPendingHandoffs(workspaceDir: string): Promise<HandoffEnvelope[]> {
  return readOutboxBox(
    handoffBoxDirOf(workspaceDir, "pending"),
    handoffFromDisk,
    (envelope) => envelope.handoffId,
    (envelope) => envelope.createdAt,
    META,
  );
}

/** 已经送达：写进 sent/ 再从 pending/ 删掉。先写后删，中途崩了最多重复一份，不会丢。 */
export async function markHandoffSent(workspaceDir: string, envelope: HandoffEnvelope): Promise<void> {
  await retire(workspaceDir, envelope, "sent");
}

/** 放弃：写进 failed/ 再从 pending/ 删掉，日志里留下原因。 */
export async function markHandoffFailed(workspaceDir: string, envelope: HandoffEnvelope, reason: string): Promise<void> {
  record("warn", SCOPE, `交接件 ${envelope.handoffId} 移入 failed：${reason}`);
  await retire(workspaceDir, envelope, "failed");
}

async function retire(workspaceDir: string, envelope: HandoffEnvelope, box: "sent" | "failed"): Promise<void> {
  await moveOutboxFile(
    handoffPathOf(workspaceDir, "pending", envelope.handoffId),
    handoffPathOf(workspaceDir, box, envelope.handoffId),
    envelope,
    envelope.handoffId,
    box,
    META,
  );
}

/**
 * 投递失败一次：累计 attempts 后写回 pending/。
 *
 * 超过上限就移进 failed/——无限重试会让一份永远送不出去的件每天刷日志，
 * 也会让它永远排在队列前面。
 */
export async function recordHandoffAttempt(
  workspaceDir: string,
  envelope: HandoffEnvelope,
  reason: string,
): Promise<void> {
  const next: HandoffEnvelope = { ...envelope, attempts: envelope.attempts + 1 };
  if (next.attempts >= MAX_HANDOFF_ATTEMPTS) {
    await markHandoffFailed(workspaceDir, next, `${MAX_HANDOFF_ATTEMPTS} 次投递都没成功：${reason}`);
    return;
  }
  const file = handoffPathOf(workspaceDir, "pending", envelope.handoffId);
  if (!file) return;
  try {
    await writeJsonAtomic(file, next);
  } catch (error) {
    record("warn", SCOPE, `交接件 ${envelope.handoffId} 记投递次数失败：${messageOf(error)}`);
  }
}
