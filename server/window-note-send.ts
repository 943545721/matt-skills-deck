import {
  WINDOW_NOTE_VERSION,
  isTicketFault,
  windowNoteId,
  type WindowNoteEnvelope,
} from "../shared/window-note.ts";
import { writeWindowNote } from "./window-note-store.ts";

/**
 * 「票写坏了」这类拒绝发生时，把原因写成一张条子交给 relay。
 *
 * 两个入口共用：MCP 的 `deck_requirement_dispatch`（派单窗口）与面板的按区派单（RPC）。
 * 不管谁触发的，该改票的都是同一个需求窗口——这条通道正是为了省掉「人当消息总线」。
 */

/**
 * 条子最终落在哪个状态。
 *
 * 「排进队列」与「已送达」是两件事：落进 pending/ 只说明 relay 会去送，
 * 所以回执里不能写成已经送到——需求窗口说不定还没绑、还没开。
 */
export type RequirementNoteOutcome =
  | { readonly status: "queued" | "already-queued" | "already-sent" | "already-failed" | "skipped" }
  | { readonly status: "failed"; readonly detail: string };

/**
 * 派单被拒、错在票面时，把原因递给需求窗口。
 *
 * 递不出去要如实说出来：那种时候只能回到人传话，不能让人以为已经自动通知过了。
 */
export async function noteRequirementWindow(input: {
  readonly workspaceDir: string;
  readonly workspaceId: string;
  readonly fromAgentId: string;
  readonly requirementKey: number;
  readonly reason: string;
  readonly detail: string;
}): Promise<RequirementNoteOutcome> {
  if (!isTicketFault(input.reason)) return { status: "skipped" };
  // 空 workspaceId 解不出角色绑定，写出来的条子永远找不到收件人：不如当场说递不了。
  if (!input.workspaceId.trim()) return { status: "skipped" };
  const createdAt = new Date().toISOString();
  const envelope: WindowNoteEnvelope = Object.freeze({
    version: WINDOW_NOTE_VERSION,
    noteId: windowNoteId({
      reason: input.reason,
      detail: input.detail,
      requirementKey: input.requirementKey,
      at: createdAt,
    }),
    createdAt,
    workspaceId: input.workspaceId.trim(),
    fromAgentId: input.fromAgentId,
    toRole: "requirement",
    requirementKey: input.requirementKey,
    reason: input.reason,
    detail: input.detail,
    attempts: 0,
    lastAttemptAt: "",
    lastAttemptReceiver: "",
  });
  const written = await writeWindowNote(input.workspaceDir, envelope);
  if (!written.ok) return { status: "failed", detail: written.detail };
  if (!written.duplicate) return { status: "queued" };
  // 重复也要看清是「还排着队」还是「早就送过 / 送失败了」：三种说法差很多。
  if (written.box === "sent") return { status: "already-sent" };
  if (written.box === "failed") return { status: "already-failed" };
  return { status: "already-queued" };
}

/** 拒绝理由后面补一句条子的去向：递到了用户就不用管，没递到就要明说要人转述。 */
export function requirementNoteSuffix(outcome: RequirementNoteOutcome): string {
  switch (outcome.status) {
    case "queued":
      return "\n\n已把这条原因写成一张窗口条子放进队列（`.deck/window-notes/pending/`），"
        + "relay 会按当前绑定投进需求窗口，它收到后直接用 deck_issue_patch 改票。"
        + "需求窗口还没绑定时，条子会留在队列里等绑定。";
    case "already-queued":
      return "\n\n同样的原因已经排进条子队列、还没送到需求窗口，这次没重复写。";
    case "already-sent":
      return "\n\n同样的原因之前已经经条子送进过需求窗口，这次没重复递。";
    case "already-failed":
      return "\n\n同样的条子之前投递失败过（在 `.deck/window-notes/failed/` 里），这次没重复写："
        + "需求窗口可能一直没开——需要人看一眼，或者在需求窗口里让 agent 直接改票。";
    case "failed":
      return `\n\n自动递给需求窗口没成功：${outcome.detail}。这次只能请人转述。`;
    default:
      return "";
  }
}
