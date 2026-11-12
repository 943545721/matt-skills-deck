import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { windowSlotsOf, type WindowSlots } from "../shared/window-gates.ts";
import { renderWindowNote, type WindowNoteEnvelope } from "../shared/window-note.ts";
import { workspaceRolesOf } from "../shared/orchestration.ts";
import { deliverMessage } from "./delivery.ts";
import { readOrchestration } from "./orchestration-store.ts";
import {
  isWindowNotePending,
  listPendingWindowNotes,
  moveWindowNote,
  recordWindowNoteAttempt,
} from "./window-note-store.ts";
import { messageOf } from "./outbox-fs.ts";
import { record } from "./logs.ts";

/**
 * 条子投递员：把派单窗口甩出来的「票写坏了」递给该改票的窗口。
 *
 * 触发点与交接件一致：`agent.turn_ended` 与 `agent.created`——派单窗口被拒这一轮就结束了，
 * 需求窗口后来才建出来时 `agent.created` 补送。
 *
 * 每次投递前重新解析当前绑定，不信条子里的旧 id：用户可能已经换了窗口。
 * 投递失败不丢件：记一次 attempts 留在 pending，等下一次事件再送。
 */

const SCOPE = "window.note";

/** 角色 → 槽位字段。写成表是为了加角色时只改一处。 */
const ROLE_SLOT: Readonly<Record<WindowNoteEnvelope["toRole"], keyof WindowSlots>> = Object.freeze({
  requirement: "requirementAgentId",
});

/**
 * 同一个条子两次投递之间的最小间隔。
 *
 * 重试是按事件计次的（回合结束、建会话），而一个工作区里事件可以几秒来一次；
 * 不设间隔的话，需求窗口短暂离线几秒就能把这五次烧光，条子直接进 failed/。
 * 加了间隔，五次上限至少横跨几分钟——那才是「绑了但一直没开」该有的节奏。
 */
export const WINDOW_NOTE_RETRY_MS = 60_000;

export interface WindowNoteRelayDeps {
  /** 仅供测试：换一个投递函数。 */
  deliver?: typeof deliverMessage;
  /** 仅供测试：改最小重试间隔（默认 {@link WINDOW_NOTE_RETRY_MS}）。 */
  retryDelayMs?: number;
}

export function registerWindowNoteRelay(server: PluginServerContext, deps: WindowNoteRelayDeps = {}): void {
  const deliver = deps.deliver ?? deliverMessage;
  const retryDelayMs = deps.retryDelayMs ?? WINDOW_NOTE_RETRY_MS;
  /** 同一个工作区的两次 drain 串行跑，避免同一张条子被两个事件同时送一遍。 */
  const chains = new Map<string, Promise<void>>();
  const inFlight = new Set<string>();
  const warnedNoReceiver = new Set<string>();

  function schedule(workspaceDir: string, paseo: PaseoApi): void {
    const previous = chains.get(workspaceDir) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => drain(workspaceDir, paseo))
      .catch((error: unknown) => {
        record("warn", SCOPE, `投递条子失败：${workspaceDir}，${messageOf(error)}`);
      })
      .finally(() => {
        if (chains.get(workspaceDir) === next) chains.delete(workspaceDir);
      });
    chains.set(workspaceDir, next);
  }

  server.on("agent.turn_ended", ({ agent }, context) => {
    if (agent.cwd) schedule(agent.cwd, context.paseo);
  });

  // 需求窗口可能是被拒之后才建出来 / 才绑定的；建会话时补一次。
  server.on("agent.created", ({ agent }, context) => {
    if (agent.cwd) schedule(agent.cwd, context.paseo);
  });

  async function drain(workspaceDir: string, paseo: PaseoApi): Promise<void> {
    const pending = await listPendingWindowNotes(workspaceDir);
    if (pending.length === 0) return;
    const read = await readOrchestration(workspaceDir);
    if (read.readFailed || read.corrupt) {
      record("warn", SCOPE, `编排设置读不出来，条子先留在 pending：${workspaceDir}`);
      return;
    }
    // 「还没有收件人」的提醒只留当前真在队列里的那几张：noteId 按小时换，
    // 不清理的话一天下来这张表只涨不消。
    const liveKeys = new Set(pending.map((envelope) => `${workspaceDir}\u0000${envelope.noteId}`));
    for (const key of warnedNoReceiver) {
      if (key.startsWith(`${workspaceDir}\u0000`) && !liveKeys.has(key)) warnedNoReceiver.delete(key);
    }
    for (const envelope of pending) {
      const key = `${workspaceDir}\u0000${envelope.noteId}`;
      if (inFlight.has(key)) continue;
      // pending 是 drain 开始时读的快照：这期间可能已经送走了，按快照再送一遍就是重复。
      if (!(await isWindowNotePending(workspaceDir, envelope.noteId))) continue;
      const roles = workspaceRolesOf(read.settings, envelope.workspaceId);
      const receiver = windowSlotsOf(roles)[ROLE_SLOT[envelope.toRole]] ?? "";
      if (!receiver) {
        if (!warnedNoReceiver.has(key)) {
          warnedNoReceiver.add(key);
          record("info", SCOPE, `条子 ${envelope.noteId} 还没有收件人：这个工作区没配${envelope.toRole}窗口，先留在 pending`);
        }
        continue;
      }
      warnedNoReceiver.delete(key);
      if (receiver === envelope.fromAgentId) {
        await moveWindowNote(workspaceDir, envelope, "failed", "收件人就是发件人：没有可投递的窗口");
        continue;
      }
      // 上一次投给「这个」窗口失败还没隔够最小间隔：这次事件只是路过，别把重试次数白白烧掉。
      // 换成别的窗口（新建出来的、或重新绑定的）不在此列——那是条新路子，不能一起按住。
      if (tooSoon(envelope, receiver)) continue;
      inFlight.add(key);
      // await：同一个窗口要多张条子时按队列顺序送，别让它们并发出手打乱先后。
      await send(workspaceDir, paseo, receiver, envelope, key);
    }
  }

  /**
   * 上次投给同一个收件人失败、离现在还不到最小间隔，就跳过：重试要有节奏，不能几秒烧光。
   *
   * 只对「同一个收件人」生效：需求窗口当时没开才失败的，等它新建出来或换绑之后，
   * 那条 path 是第一次走，一上来就按旧间隔压住会把这次补送吞掉。
   */
  function tooSoon(envelope: WindowNoteEnvelope, receiver: string): boolean {
    if (!envelope.lastAttemptAt || retryDelayMs <= 0) return false;
    if (envelope.lastAttemptReceiver && envelope.lastAttemptReceiver !== receiver) return false;
    const last = Date.parse(envelope.lastAttemptAt);
    if (Number.isNaN(last)) return false;
    return Date.now() - last < retryDelayMs;
  }

  /**
   * 送一张条子，并把它搬进对应的箱子。
   *
   * `deliver` 可能先回调（onDelivered / onDropped）再把错误抛出来；这两种情况都算
   * 「这一轮已经有结论」，catch 里不能再记一次账，否则同一次失败算两回 attempts。
   */
  async function send(
    workspaceDir: string,
    paseo: PaseoApi,
    receiver: string,
    envelope: WindowNoteEnvelope,
    key: string,
  ): Promise<void> {
    let settled = false;
    const after = (work: Promise<void>): void => {
      void work
        .catch((error: unknown) => {
          record("warn", SCOPE, `条子 ${envelope.noteId} 换箱子失败：${messageOf(error)}`);
        })
        .finally(() => inFlight.delete(key));
    };
    try {
      await deliver(paseo, receiver, renderWindowNote(envelope), {
        // 先搬文件再放开 inFlight：反过来的话，下一次 drain 会在文件还没移走的空档里再送一遍。
        onDelivered: () => {
          settled = true;
          after(moveWindowNote(workspaceDir, envelope, "sent"));
        },
        onDropped: (reason) => {
          settled = true;
          after(recordWindowNoteAttempt(workspaceDir, envelope, reason, receiver));
        },
      });
    } catch (error) {
      if (!settled) await recordWindowNoteAttempt(workspaceDir, envelope, messageOf(error), receiver);
      inFlight.delete(key);
    }
  }
}
