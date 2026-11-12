import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { agentIdOf, type WorkspaceRoles } from "../shared/orchestration.ts";
import { deliverMessage } from "./delivery.ts";
import { readChildHandoff, type ChildHandoffRecord } from "./handoff-store.ts";
import { record } from "./logs.ts";
import { readOrchestration } from "./orchestration-store.ts";

/**
 * 子会话收尾时的向上回传。
 *
 * 为什么插件要自己做这一层：宿主的 `create_agent` 只会「干完了通知一声」，
 * 它不会把子会话的结论送回父会话的对话里。而用户要的是「一级一级往主窗口回」——
 * 每一层都得把下一层的成果整理成人能直接读的一段字，再交给上一级。
 *
 * 五条原则：
 * 1. 有回传件（`deck_handoff` 写的 `.deck/handoffs/<id>.json`）就按回传件说，那是子会话的自述；
 * 2. 没有回传件才退回读时间线尾部——这是兜底，不是主路径，且要明说「没写回传件」；
 * 3. 主投给上一级（派它的那个窗口），再抄一份更短的「进度」给进度窗口——进度只汇总在进度窗口，
 *    不再往主窗口抄一遍，免得同一结论在三个窗口里各说一遍；
 * 4. 上一级收不到时改送「主沟通窗口」（角色里指定的那个），并把绕道这件事写进正文；
 * 5. 连主沟通窗口都发不出去就当失败：日志留原因，结果里如实返回，不粉饰。
 *
 * 发送统一走 `deliverMessage`：目标窗口在忙就排队，等它这一轮结束再送，
 * 不把消息插进正在进行的回合（`steer` 只在确认空闲后、查不到忙闲时兜底，
 * 或未注册投递队列时使用）。
 */

const SCOPE = "report";
const TAIL_LIMIT = 20;
const MAX_TAIL_CHARS = 4000;
const MAX_SEEN_TURNS = 1000;

export interface TurnEndInput {
  agent: PluginHookAgent;
  outcome: PluginTurnOutcome;
  /** 由调用方按工作区读好的开关；缺省视为开启。 */
  reportOnFinish?: boolean;
}

export type TurnEndResult =
  | { ok: true; reported: false; reason: "no-parent" | "disabled" | "already-reported" }
  | {
      ok: true;
      reported: true;
      parentAgentId: string;
      source: "handoff" | "timeline" | "outcome";
      text: string;
      /** 上一级收不到，改送主沟通窗口时为 true。 */
      rerouted?: true;
    }
  | { ok: false; reason: "send-failed"; parentAgentId: string; detail: string };

function outcomeLine(outcome: PluginTurnOutcome): string {
  if (outcome.kind === "completed") return "已完成";
  if (outcome.kind === "failed") return `失败：${outcome.error.message}`;
  return `已取消：${outcome.reason}`;
}

function bullets(items: readonly string[], empty: string): string[] {
  return items.length ? items.map((item) => `- ${item}`) : [`- ${empty}`];
}

/** 回传件的正文：父会话读到这几行就能决定下一步，不必再翻子会话的时间线。 */
export function renderTurnReport(input: {
  child: { id: string; title: string | null; provider: string };
  outcome: PluginTurnOutcome;
  handoff: ChildHandoffRecord | null;
  tail: string | null;
}): { text: string; source: "handoff" | "timeline" | "outcome" } {
  const head = `【子会话回传】${input.child.title?.trim() || input.child.id}（${input.child.provider}）`;
  if (input.handoff) {
    const handoff = input.handoff;
    const lines = [
      head,
      `状态：${handoff.status}${handoff.ticketKey ? ` · 票 ${handoff.ticketKey}` : ""}${handoff.difficulty ? ` · 难度 ${handoff.difficulty}` : ""}`,
      `摘要：${handoff.summary || "（未填）"}`,
      "已完成：",
      ...bullets(handoff.done ?? [], "（未填）"),
    ];
    if ((handoff.nextSteps ?? []).length) lines.push("下一步：", ...bullets(handoff.nextSteps ?? [], ""));
    if ((handoff.blocking ?? []).length) lines.push("风险/阻塞：", ...bullets(handoff.blocking ?? [], ""));
    if ((handoff.files ?? []).length) lines.push("涉及文件：", ...bullets((handoff.files ?? []).map((file) => `\`${file}\``), ""));
    lines.push(`回合结果：${outcomeLine(input.outcome)}`);
    return { text: lines.join("\n"), source: "handoff" };
  }
  if (input.tail) {
    return {
      text: [
        head,
        `回合结果：${outcomeLine(input.outcome)}`,
        "这段子会话没有调用 `deck_handoff`，下面是它最后一段输出（可能不完整）：",
        input.tail.length > MAX_TAIL_CHARS ? `${input.tail.slice(0, MAX_TAIL_CHARS)}…` : input.tail,
      ].join("\n"),
      source: "timeline",
    };
  }
  return {
    text: [head, `回合结果：${outcomeLine(input.outcome)}`, "没有回传件，也没有读到可用的输出：需要人工确认这一支做了什么。"].join("\n"),
    source: "outcome",
  };
}

/**
 * 发给进度窗口的抄送正文。
 *
 * 进度窗口是旁听者，不是回传链的一环：它只要「谁、哪张票、最后什么结论」这几样，
 * 把整份回传原样再粘一遍只会让它和上一级各收到一份噪音。
 */
function renderProgressCopy(input: {
  child: { id: string; title: string | null };
  outcome: PluginTurnOutcome;
  handoff: ChildHandoffRecord | null;
}): string {
  const title = input.child.title?.trim() || input.child.id;
  const ticket = input.handoff?.ticketKey?.trim();
  const summary = input.handoff?.summary?.trim();
  const lines = [
    `【进度】${title}${ticket ? ` · 票 ${ticket}` : ""}`,
    `回合结果：${outcomeLine(input.outcome)}`,
  ];
  if (summary) lines.push(`结论：${summary}`);
  return lines.join("\n");
}

/** 从时间线尾部挑出最后一条助手消息；拿不到就返回 null。 */
export async function readTailText(paseo: PaseoApi, agentId: string): Promise<string | null> {
  try {
    const handle = paseo.agents.ref(agentId);
    const payload = (await handle.timeline.refetch({ direction: "tail", limit: TAIL_LIMIT })) as unknown;
    const entries = (payload as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) return null;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const item = (entries[index] as { item?: { type?: unknown; text?: unknown } } | null)?.item;
      if (item?.type === "assistant_message" && typeof item.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
    }
    return null;
  } catch (error) {
    record("warn", SCOPE, `读子会话时间线失败（${agentId}）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 收尾钩子的执行体。
 *
 * `reported` 状态记在内存里，用来挡住「同一个回合重复上报」：宿主的 turn_ended 在重连或
 * 重放时可能再来一次，重复的汇报会把父会话的对话刷成一串同样的字。
 * 只挡同一 turnId；**没有 turnId 时不去重**——固定键会让这个会话之后的每一回合都永久静默，
 * 而「重复送一次」比「再也送不到」轻得多。
 *
 * 但**发失败的那一次不算报过**：标记只在 `send` 成功后落下。否则一次网络抖动就把这个回合
 * 永久标成已上报，用户再也收不到它——「没送到」比「重复送一次」糟得多。
 * 在飞的重放（两次 turn_ended 几乎同时到）用 `inFlight` 占位挡住，失败时释放。
 */
export class TurnReporter {
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<string>();
  /** 每个会话上一次**真正报出去**的回传件时间：用来识别「上一回合的旧结论」。 */
  private readonly handoffAt = new Map<string, string>();

  /** 只留最近 N 个回合：daemon 长跑时这份去重表不该无限长。 */
  private remember(key: string): void {
    this.seen.add(key);
    while (this.seen.size > MAX_SEEN_TURNS) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  private rememberHandoff(agentId: string, createdAt: string): void {
    this.handoffAt.set(agentId, createdAt);
    while (this.handoffAt.size > MAX_SEEN_TURNS) {
      const oldest = this.handoffAt.keys().next().value;
      if (oldest === undefined) break;
      this.handoffAt.delete(oldest);
    }
  }

  async report(paseo: PaseoApi, input: TurnEndInput & { turnId?: string | null }): Promise<TurnEndResult> {
    const parentAgentId = input.agent.parentAgentId?.trim() ?? "";
    if (!parentAgentId) return { ok: true, reported: false, reason: "no-parent" };
    if (input.reportOnFinish === false) return { ok: true, reported: false, reason: "disabled" };
    const key = input.turnId ? `${input.agent.id}:${input.turnId}` : null;
    if (key && (this.seen.has(key) || this.inFlight.has(key))) {
      return { ok: true, reported: false, reason: "already-reported" };
    }
    if (key) this.inFlight.add(key);
    try {
      return await this.deliver(paseo, input, parentAgentId, key);
    } finally {
      if (key) this.inFlight.delete(key);
    }
  }

  private async deliver(
    paseo: PaseoApi,
    input: TurnEndInput,
    parentAgentId: string,
    key: string | null,
  ): Promise<TurnEndResult> {
    const handoff = await readChildHandoff(input.agent.cwd, input.agent.id);
    // 回传件是上一回合写的（时间不比上次报出去的更新）就不算数：否则用户多问一句，
    // 父窗口会收到一份「看起来是最新、其实是旧结论」的回传。
    const lastAt = this.handoffAt.get(input.agent.id);
    const stale = Boolean(handoff && lastAt && handoff.createdAt <= lastAt);
    const usable = stale ? null : handoff;
    // 有回传件就不再读时间线：父会话要的是结论，不是把子会话的全文再搬一遍。
    const tail = usable ? null : await readTailText(paseo, input.agent.id);
    const report = renderTurnReport({
      child: { id: input.agent.id, title: input.agent.title, provider: input.agent.provider },
      outcome: input.outcome,
      handoff: usable,
      tail,
    });
    const text =
      stale && handoff
        ? `${report.text}\n\n（注：这个会话上一次的回传件（${handoff.createdAt}）不是本回合写的，所以上面按本回合的时间线说话。）`
        : report.text;
    try {
      // 目标窗口正在跑活时先排队，跑完这一轮再送（见 `server/delivery.ts`）。
      await deliverMessage(paseo, parentAgentId, text);
      if (key) this.remember(key);
      if (usable) this.rememberHandoff(input.agent.id, usable.createdAt);
      record("info", SCOPE, `子会话 ${input.agent.id} 已回传到 ${parentAgentId}（来源：${report.source}）`);
      // 主投递已经成功：抄送是旁路，成败都不该改变上面的结果。
      await this.copyToProgressWindow(paseo, input, parentAgentId, usable);
      return { ok: true, reported: true, parentAgentId, source: report.source, text };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 上一级可能已经被归档：链条断在这里的话，用户就永远看不到这一支的结论。
      // 所以退一步直接送到主沟通窗口（角色里指定过的那个），并在正文里写明这是绕道。
      const mainAgentId = await mainAgentFor(input.agent.cwd, input.agent.workspaceId);
      if (mainAgentId && mainAgentId !== parentAgentId) {
        try {
          await deliverMessage(
            paseo,
            mainAgentId,
            `${text}\n\n（注：上一级 ${parentAgentId} 收不到这条回传（${detail}），已直接送到主沟通窗口。）`,
          );
          if (key) this.remember(key);
          if (usable) this.rememberHandoff(input.agent.id, usable.createdAt);
          record("warn", SCOPE, `回传到 ${parentAgentId} 失败（${detail}），已改送主沟通窗口 ${mainAgentId}`);
          // 绕道也是一次成功投递：进度窗口仍应收一份，别因为上一级不可达就漏掉旁听。
          await this.copyToProgressWindow(paseo, input, mainAgentId, usable);
          return { ok: true, reported: true, parentAgentId: mainAgentId, source: report.source, text, rerouted: true };
        } catch (fallbackError) {
          const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          record("warn", SCOPE, `改送主沟通窗口 ${mainAgentId} 也失败：${fallbackDetail}`);
        }
      }
      // 发不出去不代表回传件丢了：文件还在 `.deck/handoffs/` 里，日志说清这一点。
      record("warn", SCOPE, `回传到 ${parentAgentId} 失败：${detail}（回传件仍在 .deck/handoffs/）`);
      return { ok: false, reason: "send-failed", parentAgentId, detail };
    }
  }

  /**
   * 主投递成功后，把结论抄给**进度窗口**。
   *
   * 进度只落在进度窗口：执行窗口的每条回合结论都汇总到这里，主窗口不再收
   * 常规副本，免得同一个结论在三个窗口里各说一遍。主窗口仍会在
   * 「上一级收不到、改送主窗口」时收到，那是兜底不是常规抄送。
   *
   * 去重看的是「本次实际收件人」：进度窗口就是上一级时只发一次。
   * 抄送失败只记 warn，不改变主投递的结果。
   */
  private async copyToProgressWindow(
    paseo: PaseoApi,
    input: TurnEndInput,
    recipientAgentId: string,
    handoff: ChildHandoffRecord | null,
  ): Promise<void> {
    let progressAgentId: string | null = null;
    try {
      progressAgentId = await progressAgentFor(input.agent.cwd, input.agent.workspaceId);
    } catch (error) {
      record("warn", SCOPE, `读进度窗口槽位失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!progressAgentId || progressAgentId === recipientAgentId) return;
    try {
      await deliverMessage(
        paseo,
        progressAgentId,
        renderProgressCopy({
          child: { id: input.agent.id, title: input.agent.title },
          outcome: input.outcome,
          handoff,
        }),
      );
      record("info", SCOPE, `子会话 ${input.agent.id} 的结论已抄送进度窗口 ${progressAgentId}`);
    } catch (error) {
      record("warn", SCOPE, `抄送进度窗口 ${progressAgentId} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 读这个工作区的角色槽位；读失败 / 文件坏了留一条日志，别让人以为「没配这个窗口」。
 *
 * `purpose` 只进日志：同一个工作区可能既要用主窗口兜底、又要抄送进度，
 * 所以这里只交槽位，由调用方按角色各取各的 id，不重复读文件。
 */
async function roleSlotFor(
  workspaceDir: string,
  workspaceId: string | null,
  purpose: "main-fallback" | "progress-copy",
): Promise<WorkspaceRoles | null> {
  const id = workspaceId?.trim();
  if (!id) return null;
  const stored = await readOrchestration(workspaceDir);
  if (stored.readFailed || stored.corrupt) {
    const what = purpose === "main-fallback" ? "用主沟通窗口兜底" : "抄送进度窗口";
    record("warn", SCOPE, `读不出编排设置（${stored.detail ?? "未知原因"}）：这次没法${what}`);
  }
  return stored.settings.roles.find((item) => item.workspaceId === id) ?? null;
}

/**
 * 这个工作区指定的主沟通窗口。
 *
 * 只在上一级不可达时兜底用它：常规回传不进主窗口，进度汇总在进度窗口。
 * 主沟通窗口是整条链的终点，把它配了却不用，等于那项配置只是块装饰。
 */
export async function mainAgentFor(workspaceDir: string, workspaceId: string | null): Promise<string | null> {
  return agentIdOf(await roleSlotFor(workspaceDir, workspaceId, "main-fallback"), "main");
}

/**
 * 这个工作区指定的进度窗口。
 *
 * 与 `mainAgentFor` 同源读设置：进度窗口只收抄送，没配就不抄，
 * 不在这里做任何兜底投递。
 */
export async function progressAgentFor(workspaceDir: string, workspaceId: string | null): Promise<string | null> {
  return agentIdOf(await roleSlotFor(workspaceDir, workspaceId, "progress-copy"), "progress");
}

/** 读这个工作区的「结束即回传」开关；读不到按开启处理（用户要的默认行为就是会回传）。 */
export async function reportEnabledFor(workspaceDir: string): Promise<boolean> {
  const stored = await readOrchestration(workspaceDir);
  return stored.settings.reportOnFinish;
}
