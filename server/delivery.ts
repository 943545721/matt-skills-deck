import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { record } from "./logs.ts";

/** 日志分类：消息排队与补送。 */
const SCOPE = "delivery";

/** 一个窗口最多积压多少条；超了丢最早的，并发日志。 */
const MAX_PER_AGENT = 50;

/** 排上队之后的兜底重试：turn_ended 事件没等到（比如在入队前刚结束），也不至于永远卡着。 */
const RETRY_MS = 2_000;

/** 补送失败最多试几次；每次之间隔一个 RETRY_MS。 */
const MAX_ATTEMPTS = 3;

export interface DeliverOptions {
  /** 送出前再问一次「这条还值得送吗」；返回 false 就丢掉（例如那条权限请求已经被点掉了）。 */
  stillRelevant?: () => boolean;
  /** 真正送到目标窗口之后调用；入队不算送达。 */
  onDelivered?: () => void;
  /** 这条永远不会送了（失效、队列溢出、窗口关掉、重试用完）时调用，带一句原因。 */
  onDropped?: (reason: string) => void;
}

interface QueueItem {
  paseo: PaseoApi;
  text: string;
  stillRelevant?: () => boolean;
  onDelivered?: () => void;
  onDropped?: (reason: string) => void;
  /** 补送失败后重试的次数；用完就丢并留日志。 */
  attempts: number;
}

/** 回调由调用方提供，出错不能反过来把投递链带崩。 */
function notify(callback: (() => void) | undefined, what: string, agentId: string): void {
  if (!callback) return;
  try {
    callback();
  } catch (error) {
    record("warn", SCOPE, `${what}回调出错：agent=${agentId}，${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 直发路径的丢弃回调也包一层：抛错不能盖掉真正的发送失败。 */
function notifyOptionsDropped(options: DeliverOptions | undefined, agentId: string, reason: string): void {
  const callback = options?.onDropped;
  notify(callback ? () => callback(reason) : undefined, "丢弃", agentId);
}

function notifyDropped(item: QueueItem, agentId: string, reason: string): void {
  if (!item.onDropped) return;
  try {
    item.onDropped(reason);
  } catch (error) {
    record("warn", SCOPE, `丢弃回调出错：agent=${agentId}，${error instanceof Error ? error.message : String(error)}`);
  }
}

function itemOf(paseo: PaseoApi, text: string, options?: DeliverOptions): QueueItem {
  return {
    paseo,
    text,
    stillRelevant: options?.stillRelevant,
    onDelivered: options?.onDelivered,
    onDropped: options?.onDropped,
    attempts: 0,
  };
}

interface AgentQueue {
  items: QueueItem[];
  timer?: NodeJS.Timeout;
}

interface DeliveryQueue {
  deliver(paseo: PaseoApi, agentId: string, text: string, options?: DeliverOptions): Promise<void>;
  clear(): void;
}

let active: DeliveryQueue | null = null;

export interface DeliveryQueueOptions {
  /** 仅供测试：缩短兜底重试间隔。 */
  retryMs?: number;
}

/** 由 `registerHooks` 调一次；测试里不注册时退回直接发送。 */
export function registerDeliveryQueue(server: PluginServerContext, options?: DeliveryQueueOptions): void {
  active?.clear();
  active = createDeliveryQueue(server, options?.retryMs ?? RETRY_MS);
}

/** 仅供测试：卸掉队列，回到直接发送。 */
export function resetDeliveryQueueForTest(): void {
  active?.clear();
  active = null;
}

/**
 * 往某个窗口送一句话；目标窗口正在跑活时先排队，等它跑完这一轮再送。
 *
 * 为什么不在忙的时候硬塞：宿主的 `steer` 会把消息插进正在进行的回合，主窗口的活会被打断；
 * 用户明确要求「前面的任务在执行就排队」。回传件本身已经落盘，晚一点送不会丢结果。
 *
 * 没注册队列时（单元测试、单独的模块调用）保持原来的直接发送语义。
 */
export async function deliverMessage(
  paseo: PaseoApi,
  agentId: string,
  text: string,
  options?: DeliverOptions,
): Promise<void> {
  if (!active) {
    // 没有队列时也得走同一套回调：调用方（例如交接 relay）靠 onDelivered 才把件移出 pending。
    const onDelivered = options?.onDelivered;
    const onDropped = options?.onDropped;
    try {
      await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notify(onDropped ? () => onDropped(reason) : undefined, "丢弃", agentId);
      throw error;
    }
    notify(onDelivered, "送达", agentId);
    return;
  }
  await active.deliver(paseo, agentId, text, options);
}

function createDeliveryQueue(server: PluginServerContext, retryMs: number): DeliveryQueue {
  const queues = new Map<string, AgentQueue>();
  const flushing = new Set<string>();

  server.on("agent.turn_ended", ({ agent }) => flush(agent.id));
  server.on("agent.closed", ({ agent }) => drop(agent.id));
  server.on("agent.archived", ({ agent }) => drop(agent.id));

  /**
   * 忙 = 正在跑，或卡在初始化 / 等人点确认。
   * 等人确认时也不塞：宿主的发送路径会带上 `clearPendingPermissions`，硬塞会把人家的确认框清掉。
   */
  async function isBusy(paseo: PaseoApi, agentId: string): Promise<boolean> {
    // 我们只找固定的几个角色窗口；把页开大，避免默认分页把目标截掉后误判成空闲。
    const page = await paseo.agents.list({ page: { limit: 200 } });
    const entry = page.entries.find((one) => one.agent.id === agentId);
    if (!entry) return false;
    const { status, attentionReason } = entry.agent;
    // 列表里的 status 没有 "permission"；卡在确认框上的窗口靠 attentionReason 认出来。
    return status === "running" || status === "initializing" || attentionReason === "permission";
  }

  function enqueue(agentId: string, item: QueueItem): void {
    const queue = queues.get(agentId) ?? { items: [] };
    queue.items.push(item);
    if (queue.items.length > MAX_PER_AGENT) {
      const dropped = queue.items.shift();
      if (dropped) notifyDropped(dropped, agentId, "overflow");
      record("warn", SCOPE, `排队超过 ${MAX_PER_AGENT} 条，丢掉最早的一条：agent=${agentId}`);
    }
    queues.set(agentId, queue);
  }

  function schedule(agentId: string): void {
    const queue = queues.get(agentId);
    if (!queue || queue.timer) return;
    queue.timer = setTimeout(() => {
      queue.timer = undefined;
      void flush(agentId);
    }, retryMs);
    queue.timer.unref?.();
  }

  function drop(agentId: string): void {
    const queue = queues.get(agentId);
    if (!queue) return;
    if (queue.timer) clearTimeout(queue.timer);
    queues.delete(agentId);
    for (const item of queue.items) notifyDropped(item, agentId, "closed");
  }

  /** 同一窗口的补送串行跑；忙就停手，等下一轮 turn_ended 或兜底定时器。 */
  async function flush(agentId: string): Promise<void> {
    if (flushing.has(agentId)) return;
    flushing.add(agentId);
    try {
      for (;;) {
        const queue = queues.get(agentId);
        if (!queue || queue.items.length === 0) {
          if (queue?.timer) clearTimeout(queue.timer);
          queues.delete(agentId);
          return;
        }
        const item = queue.items[0];
        if (!item) {
          queues.delete(agentId);
          return;
        }
        if (item.stillRelevant && !item.stillRelevant()) {
          queue.items.shift();
          notifyDropped(item, agentId, "stale");
          record("info", SCOPE, `排队期间这条消息失效，已丢弃：agent=${agentId}`);
          continue;
        }
        let busy: boolean;
        try {
          busy = await isBusy(item.paseo, agentId);
        } catch (error) {
          record(
            "warn",
            SCOPE,
            `查不到目标窗口是否在忙，稍后再试：agent=${agentId}，${error instanceof Error ? error.message : String(error)}`,
          );
          schedule(agentId);
          return;
        }
        // 查忙闲的这几毫秒里窗口可能被归档/关闭；列表已经换了，就不要再往它嘴里塞。
        if (queues.get(agentId) !== queue) return;
        if (busy) {
          schedule(agentId);
          return;
        }
        if (item.stillRelevant && !item.stillRelevant()) {
          queue.items.shift();
          notifyDropped(item, agentId, "stale");
          record("info", SCOPE, `排队期间这条消息失效，已丢弃：agent=${agentId}`);
          continue;
        }
        queue.items.shift();
        try {
          await item.paseo.agents.ref(agentId).send(item.text, { activeTurnBehavior: "steer" });
          notify(item.onDelivered, "送达", agentId);
          record("info", SCOPE, `排队的消息已送出：agent=${agentId}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          item.attempts += 1;
          if (item.attempts >= MAX_ATTEMPTS) {
            notifyDropped(item, agentId, "send-failed");
            record("warn", SCOPE, `排队的消息补送 ${MAX_ATTEMPTS} 次都失败，已放弃：agent=${agentId}，${reason}`);
            continue;
          }
          queue.items.unshift(item);
          record("warn", SCOPE, `排队的消息发送失败，稍后重试（第 ${item.attempts} 次）：agent=${agentId}，${reason}`);
          schedule(agentId);
          return;
        }
      }
    } finally {
      flushing.delete(agentId);
    }
  }

  return {
    async deliver(paseo, agentId, text, options) {
      // 已经有队列就不能插队：先排到队尾，等前面的按顺序送完。
      if (queues.has(agentId)) {
        enqueue(agentId, itemOf(paseo, text, options));
        void flush(agentId);
        return;
      }
      let busy: boolean;
      try {
        busy = await isBusy(paseo, agentId);
      } catch (error) {
        // 查不出忙闲时按原样直接送：宁可可能打断一次，也不要让消息无声地卡住。
        record(
          "warn",
          SCOPE,
          `查不到目标窗口是否在忙，直接发送：agent=${agentId}，${error instanceof Error ? error.message : String(error)}`,
        );
        try {
          await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
          notify(options?.onDelivered, "送达", agentId);
        } catch (error) {
          notifyOptionsDropped(options, agentId, "send-failed");
          throw error;
        }
        return;
      }
      if (queues.has(agentId)) {
        // 查忙闲期间别的消息先排上了队，这条不能越过去。
        enqueue(agentId, itemOf(paseo, text, options));
        void flush(agentId);
        return;
      }
      if (!busy) {
        if (options?.stillRelevant && !options.stillRelevant()) {
          notifyOptionsDropped(options, agentId, "stale");
          return;
        }
        try {
          await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
          notify(options?.onDelivered, "送达", agentId);
        } catch (error) {
          notifyOptionsDropped(options, agentId, "send-failed");
          throw error;
        }
        return;
      }
      enqueue(agentId, itemOf(paseo, text, options));
      record("info", SCOPE, `目标窗口在忙，消息已排队：agent=${agentId}`);
      schedule(agentId);
    },
    clear() {
      for (const queue of queues.values()) {
        if (queue.timer) clearTimeout(queue.timer);
      }
      queues.clear();
    },
  };
}
