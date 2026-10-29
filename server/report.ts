import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
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
 * 四条原则：
 * 1. 有回传件（`deck_handoff` 写的 `.deck/handoffs/<id>.json`）就按回传件说，那是子会话的自述；
 * 2. 没有回传件才退回读时间线尾部——这是兜底，不是主路径，且要明说「没写回传件」；
 * 3. 上一级收不到时改送「主沟通窗口」（角色里指定的那个），并把绕道这件事写进正文；
 * 4. 连主沟通窗口都发不出去就当失败：日志留原因，结果里如实返回，不粉饰。
 *
 * 发送用 `activeTurnBehavior: "steer"` 而不是默认值：默认会打断父会话正在进行的回合，
 * 一份回传不该把主窗口说到一半的话切断。
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
      await paseo.agents.ref(parentAgentId).send(text, { activeTurnBehavior: "steer" });
      if (key) this.remember(key);
      if (usable) this.rememberHandoff(input.agent.id, usable.createdAt);
      record("info", SCOPE, `子会话 ${input.agent.id} 已回传到 ${parentAgentId}（来源：${report.source}）`);
      return { ok: true, reported: true, parentAgentId, source: report.source, text };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 上一级可能已经被归档：链条断在这里的话，用户就永远看不到这一支的结论。
      // 所以退一步直接送到主沟通窗口（角色里指定过的那个），并在正文里写明这是绕道。
      const mainAgentId = await mainAgentFor(input.agent.cwd, input.agent.workspaceId);
      if (mainAgentId && mainAgentId !== parentAgentId) {
        try {
          await paseo.agents.ref(mainAgentId).send(
            `${text}\n\n（注：上一级 ${parentAgentId} 收不到这条回传（${detail}），已直接送到主沟通窗口。）`,
            { activeTurnBehavior: "steer" },
          );
          if (key) this.remember(key);
          if (usable) this.rememberHandoff(input.agent.id, usable.createdAt);
          record("warn", SCOPE, `回传到 ${parentAgentId} 失败（${detail}），已改送主沟通窗口 ${mainAgentId}`);
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
}

/**
 * 这个工作区指定的主沟通窗口。
 *
 * 只在「上一级不可达」时用作兜底投递：主沟通窗口是整条链的终点，
 * 把它配了却不用，等于那项配置只是块装饰。
 */
export async function mainAgentFor(workspaceDir: string, workspaceId: string | null): Promise<string | null> {
  const id = workspaceId?.trim();
  if (!id) return null;
  const stored = await readOrchestration(workspaceDir);
  // 读失败 / 坏文件时角色是空的：兜底投递会静默失效。日志里留一条，别让人以为是「没配主沟通窗口」。
  if (stored.readFailed || stored.corrupt) {
    record("warn", SCOPE, `读不出编排设置（${stored.detail ?? "未知原因"}）：这次没法用主沟通窗口兜底`);
  }
  const role = stored.settings.roles.find((item) => item.workspaceId === id);
  return role?.mainAgentId?.trim() || null;
}

/** 读这个工作区的「结束即回传」开关；读不到按开启处理（用户要的默认行为就是会回传）。 */
export async function reportEnabledFor(workspaceDir: string): Promise<boolean> {
  const stored = await readOrchestration(workspaceDir);
  return stored.settings.reportOnFinish;
}
