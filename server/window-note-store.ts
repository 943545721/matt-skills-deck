import path from "node:path";
import { DECK_DIR } from "../shared/local-layout.ts";
import {
  TICKET_FAULT_REASONS,
  WINDOW_NOTE_ROLES,
  WINDOW_NOTE_VERSION,
  type WindowNoteEnvelope,
} from "../shared/window-note.ts";
import { messageOf, moveOutboxFile, outboxFileExists, readOutboxBox, writeJsonAtomic } from "./outbox-fs.ts";
import { record } from "./logs.ts";

/**
 * 窗口条子的 outbox：`<工作区>/.deck/window-notes/<box>/<noteId>.json`。
 *
 * 与 `dispatch-handoffs` 同一个理由：MCP 工具进程没有宿主连接，写不了消息；
 * 条子先落盘，relay 在事件里按当前绑定送进需求窗口。
 *
 * 三个箱子：`pending/` 还没送到；`sent/` 已送达；
 * `failed/` 重试到上限仍送不出去，或压根没有可投的收件人（收件人就是发件人）。
 */

const SCOPE = "window.note";
const LABEL = "条子";
const META = Object.freeze({ scope: SCOPE, label: LABEL });

export const WINDOW_NOTE_DIR = "window-notes";

/** 重试到这个次数还不成，就移进 failed/，并留一条日志等人看。与交接件同一口径。 */
export const MAX_WINDOW_NOTE_ATTEMPTS = 5;

export type WindowNoteBox = "pending" | "sent" | "failed";

const BOXES: readonly WindowNoteBox[] = Object.freeze(["pending", "sent", "failed"]);

export function windowNoteRootOf(workspaceDir: string): string {
  return path.join(workspaceDir, DECK_DIR, WINDOW_NOTE_DIR);
}

export function windowNoteBoxDirOf(workspaceDir: string, box: WindowNoteBox): string {
  return path.join(windowNoteRootOf(workspaceDir), box);
}

/** noteId 会拼进文件名：只认我们自己生成的 16 位十六进制，杜绝 `../`。 */
function safeNoteId(value: string): string | null {
  return /^[0-9a-f]{16}$/.test(value) ? value : null;
}

export function windowNotePathOf(workspaceDir: string, box: WindowNoteBox, noteId: string): string | null {
  const id = safeNoteId(noteId);
  return id ? path.join(windowNoteBoxDirOf(workspaceDir, box), `${id}.json`) : null;
}

/**
 * 读盘回来的东西一律当外部输入：字段不对就整份丢掉，不猜。
 *
 * `workspaceId` / `createdAt` / `reason` / `detail` 都是空的就当坏件：
 * 空 `workspaceId` 的条子永远找不到收件人，只会一直躺在 pending 里刷日志。
 */
export function windowNoteFromDisk(raw: unknown): WindowNoteEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== WINDOW_NOTE_VERSION) return null;
  const text = (key: string): string => (typeof value[key] === "string" ? (value[key] as string).trim() : "");
  const noteId = text("noteId");
  const role = text("toRole");
  if (!safeNoteId(noteId)) return null;
  if (!(WINDOW_NOTE_ROLES as readonly string[]).includes(role)) return null;
  const workspaceId = text("workspaceId");
  const createdAt = text("createdAt");
  const reason = text("reason");
  const detail = text("detail");
  // 原因必须还是那几种「票面写坏」：其余原因递过去只会让需求窗口白跑一趟。
  if (!workspaceId || !createdAt || !detail || !TICKET_FAULT_REASONS.includes(reason)) return null;
  const requirementKey = value.requirementKey;
  if (requirementKey !== null && !(typeof requirementKey === "number" && Number.isInteger(requirementKey) && requirementKey >= 0)) {
    return null;
  }
  const attempts = value.attempts;
  if (attempts !== undefined && !(typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0)) {
    return null;
  }
  return Object.freeze({
    version: WINDOW_NOTE_VERSION,
    noteId,
    createdAt,
    workspaceId,
    fromAgentId: text("fromAgentId"),
    toRole: role as WindowNoteEnvelope["toRole"],
    requirementKey: requirementKey as number | null,
    reason,
    detail,
    attempts: typeof attempts === "number" ? attempts : 0,
    lastAttemptAt: text("lastAttemptAt"),
    lastAttemptReceiver: text("lastAttemptReceiver"),
  });
}

export type WriteWindowNoteResult =
  | { readonly ok: true; readonly path: string; readonly box: WindowNoteBox; readonly duplicate: boolean }
  | { readonly ok: false; readonly detail: string };

/** 同一个 noteId 已经在任何一个箱子里就算重复：重试不该让需求窗口收到一摞一样的条子。 */
export async function writeWindowNote(workspaceDir: string, envelope: WindowNoteEnvelope): Promise<WriteWindowNoteResult> {
  const file = windowNotePathOf(workspaceDir, "pending", envelope.noteId);
  if (!file) return { ok: false, detail: `noteId 不能用作文件名：${envelope.noteId}` };
  try {
    for (const box of BOXES) {
      const existing = windowNotePathOf(workspaceDir, box, envelope.noteId);
      if (existing && (await outboxFileExists(existing))) {
        // 箱子名一起回报：调用方要根据「已送达」「已失败」「还在排队」说不同的话。
        return { ok: true, path: existing, box, duplicate: true };
      }
    }
    await writeJsonAtomic(file, envelope);
    return { ok: true, path: file, box: "pending", duplicate: false };
  } catch (error) {
    // 去重判断本身读不了盘时也要如实报失败：静默当成「没写过」会重复落盘、重复投递。
    return { ok: false, detail: messageOf(error) };
  }
}

/** drain 拿到的是快照，投递前拿实时状态再确认一次。 */
export async function isWindowNotePending(workspaceDir: string, noteId: string): Promise<boolean> {
  const file = windowNotePathOf(workspaceDir, "pending", noteId);
  return file ? outboxFileExists(file) : false;
}

/** 读 pending/ 里的全部条子；坏件跳过并留日志，不让一份手改坏的文件堵死队列。 */
export async function listPendingWindowNotes(workspaceDir: string): Promise<WindowNoteEnvelope[]> {
  return readOutboxBox(
    windowNoteBoxDirOf(workspaceDir, "pending"),
    windowNoteFromDisk,
    (envelope) => envelope.noteId,
    (envelope) => envelope.createdAt,
    META,
  );
}

/** 移箱子：先写目标再删源，中途崩了最多多一份，不会丢。 */
export async function moveWindowNote(
  workspaceDir: string,
  envelope: WindowNoteEnvelope,
  to: "sent" | "failed",
  reason?: string,
): Promise<void> {
  if (to === "failed" && reason) record("warn", SCOPE, `条子 ${envelope.noteId} 移入 failed：${reason}`);
  await moveOutboxFile(
    windowNotePathOf(workspaceDir, "pending", envelope.noteId),
    windowNotePathOf(workspaceDir, to, envelope.noteId),
    envelope,
    envelope.noteId,
    to,
    META,
  );
}

/**
 * 投递失败一次：累计 attempts 后写回 pending/。
 *
 * 需求窗口绑了但这一会儿没开，是常态而不是终局——一次失败就丢会把条子永久弄丢，
 * 人也再不会知道票坏在哪。到上限才移进 failed/，留一行日志。
 */
export async function recordWindowNoteAttempt(
  workspaceDir: string,
  envelope: WindowNoteEnvelope,
  reason: string,
  receiver: string,
): Promise<void> {
  const next: WindowNoteEnvelope = Object.freeze({
    ...envelope,
    attempts: envelope.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    // 记下是投给谁失败的：换了个窗口就是新路子，间隔不该拦住它。
    lastAttemptReceiver: receiver,
  });
  if (next.attempts >= MAX_WINDOW_NOTE_ATTEMPTS) {
    await moveWindowNote(workspaceDir, next, "failed", `${MAX_WINDOW_NOTE_ATTEMPTS} 次投递都没成功：${reason}`);
    return;
  }
  const file = windowNotePathOf(workspaceDir, "pending", envelope.noteId);
  if (!file) return;
  try {
    await writeJsonAtomic(file, next);
  } catch (error) {
    record("warn", SCOPE, `条子 ${envelope.noteId} 记投递次数失败：${messageOf(error)}`);
  }
}
