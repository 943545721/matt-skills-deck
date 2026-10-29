/**
 * 刷新策略：注意力、降档、失败退避与额度分账。
 *
 * 行为照 DSH 的 refresh kernel 搬，但不搬它的房间/票据模型：
 * Paseo 面板只有一个定时器，`planRefresh` 每次给出「下一次该等多久」。
 *
 * 三条硬约束（来自 DSH admission-policy）：
 * - 降档顺序固定：先牺牲探测灵敏度，再停后台对账，最后才动写入的即时性；
 *   实际上任何档位都不牺牲写入——写是用户刚点下的动作，不能等。
 * - 红档只停读，不停写。
 * - GraphQL 点数与 REST 请求是两本账，不能拿一边的余额判断另一边。
 *
 * 本文件必须保持纯逻辑：客户端定时器与测试都 import 它，不能出现宿主或 node: 依赖。
 */

// ---------------------------------------------------------------------------
// 一、常量（DSH time-config / host-budget 的原值）
// ---------------------------------------------------------------------------

export const REFRESH_TIMING = {
  /** 正在看：5 秒探一次。 */
  activeMs: 5_000,
  /** 面板仍可见但已失焦：再探 15 秒，然后收拢。 */
  lingerMs: 15_000,
  /** 失焦后注意力保留 30 秒。 */
  activeLingerMs: 30_000,
  /** 注意力心跳：正在看的窗口靠它续期。 */
  heartbeatMs: 20_000,
  /** 超过 90 秒没有任何注意力信号就收拢。 */
  attentionExpiryMs: 90_000,
  /** 黄档探测间隔：2 分钟。 */
  yellowMs: 120_000,
  /** 后台对账：10 分钟。 */
  reconcileMs: 600_000,
  /** 数据超过 5 分钟算黄、超过 30 分钟算红（只影响显示，不直接停轮询）。 */
  freshnessYellowMs: 300_000,
  freshnessRedMs: 1_800_000,
  /** 失败退避：8 秒 → 30 秒 → 2 分钟 → 5 分钟。 */
  backoffMs: [8_000, 30_000, 120_000, 300_000],
} as const;

export const BUDGET = {
  /** 插件最多拿宿主剩余额度的 35%。 */
  pluginShareOfRemaining: 0.35,
  /** 但一小时内不超过 1750 个请求。 */
  pluginHourlyCap: 1750,
  /** 插件额度里 70% 给读。 */
  readShare: 0.7,
  /** 30% 留给写；读不许把这块花掉。 */
  writeReserveShare: 0.3,
  /** 已用比例 < 60% 为绿档。 */
  tierGreenBelow: 0.6,
  /** 已用比例 >= 85% 为红档。 */
  tierRedAt: 0.85,
  /** 同时保持活跃的工作区上限。 */
  maxActiveWorkspaces: 2,
} as const;

// ---------------------------------------------------------------------------
// 二、额度分账
// ---------------------------------------------------------------------------

export type BudgetTier = "green" | "yellow" | "red";
export type QuotaBucket = "graphql" | "rest";

/**
 * 插件一小时能花多少请求。
 *
 * DSH 公式：`floor(min(宿主剩余 * 35%, 1750))`。
 * 宿主剩余未知时返回 0，调用方据此不要把「不知道」当成「还有很多」。
 */
export function pluginHourlyAllowance(hostRemaining: number): number {
  if (!Number.isFinite(hostRemaining) || hostRemaining <= 0) return 0;
  return Math.floor(Math.min(hostRemaining * BUDGET.pluginShareOfRemaining, BUDGET.pluginHourlyCap));
}

export interface SplitAllowance {
  /** 插件总额度。 */
  total: number;
  /** 读份额（向下取整）。 */
  read: number;
  /** 写预留（向下取整）；不是 total - read，两步取整的零头不挪给写。 */
  write: number;
}

/** 把插件额度拆成读/写两本账。 */
export function splitAllowance(total: number): SplitAllowance {
  const safe = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  return {
    total: safe,
    read: Math.floor(safe * BUDGET.readShare),
    write: Math.floor(safe * BUDGET.writeReserveShare),
  };
}

/**
 * 档位：已用比例 < 60% 绿，< 85% 黄，>= 85% 红。
 * 额度为 0 或数字不可信时按红档：没有证据说明还能读，就别继续读。
 */
export function tierFor(used: number, allowance: number): BudgetTier {
  if (!Number.isFinite(allowance) || allowance <= 0) return "red";
  const usedSafe = Number.isFinite(used) && used > 0 ? used : 0;
  const ratio = usedSafe / allowance;
  if (ratio >= BUDGET.tierRedAt) return "red";
  if (ratio >= BUDGET.tierGreenBelow) return "yellow";
  return "green";
}

/**
 * 只拿到「剩余比例」时反推档位。
 * `null` 表示剩余未知：返回 null，调用方按绿档处理，因为无法证明它已经用完。
 */
export function tierFromRemainingRatio(remaining: number | null): BudgetTier | null {
  if (remaining === null || !Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "red";
  return tierFor(1 - Math.min(remaining, 1), 1);
}

export interface BucketInput {
  bucket: QuotaBucket;
  kind: "read" | "write";
  /** 这次请求的单价：GraphQL 是点数，REST 是请求数。 */
  cost: number;
  /** 该桶的剩余额度；`null` = 未知。 */
  remaining: number | null;
  /** 该桶本轮已用；与 allowance 一起算档位。 */
  used: number;
  /** 该桶本轮额度。 */
  allowance: number;
}

export interface BucketDecision {
  bucket: QuotaBucket;
  allowed: boolean;
  reason: string;
  /** 放行后的剩余；未知时保持 null。 */
  remainingAfter: number | null;
}

/**
 * 单个桶的准入。
 *
 * 两本账各调一次，互不影响：GraphQL 点数用完只停 GraphQL，
 * REST 仍可写；反过来也一样。未知余额一律放行（与 DSH「不把未知当零」一致），
 * 但调用方要把未知显示出来，不能假装它是充足。
 */
export function admitBucket(input: BucketInput): BucketDecision {
  const cost = Number.isFinite(input.cost) && input.cost > 0 ? input.cost : 0;
  const base = { bucket: input.bucket, remainingAfter: input.remaining };
  if (cost === 0) return { ...base, allowed: true, reason: "free" };
  if (input.remaining === null || !Number.isFinite(input.remaining)) {
    return { ...base, allowed: true, reason: "unknown" };
  }
  const remaining = input.remaining;
  if (remaining <= 0) return { ...base, allowed: false, reason: "exhausted" };
  if (input.kind === "write") {
    const after = remaining - cost;
    return after >= 0
      ? { ...base, allowed: true, reason: "write", remainingAfter: after }
      : { ...base, allowed: false, reason: "over-write", remainingAfter: after };
  }
  const tier = tierFor(input.used, input.allowance);
  if (tier === "red") return { ...base, allowed: false, reason: "tier-red" };
  if (tier === "yellow" && input.allowance > 0) {
    const reserve = input.allowance * BUDGET.writeReserveShare;
    if (remaining - cost < reserve) return { ...base, allowed: false, reason: "write-reserve" };
  }
  const after = remaining - cost;
  return after >= 0
    ? { ...base, allowed: true, reason: tier === "yellow" ? "read-yellow" : "read", remainingAfter: after }
    : { ...base, allowed: false, reason: "over-read", remainingAfter: after };
}

// ---------------------------------------------------------------------------
// 三、失败退避与写事件
// ---------------------------------------------------------------------------

/** 连续失败 n 次后应等多久；0 次返回 0，超过表长按最后一档。 */
export function backoffDelayMs(failures: number, table: readonly number[] = REFRESH_TIMING.backoffMs): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  if (table.length === 0) return 0;
  // 第 1 次失败用第 1 档，因此索引从 failures-1 开始。
  const index = Math.min(Math.floor(failures) - 1, table.length - 1);
  return table[Math.max(0, index)] ?? 0;
}

/**
 * 失败计数推进：只要这一轮有进展（哪怕只回来一部分）就清零。
 * DSH 的规则是「有进展即重置」，不是「连续成功才重置」。
 */
export function nextFailureCount(previous: number, progressed: boolean): number {
  if (progressed) return 0;
  const safe = Number.isFinite(previous) && previous > 0 ? Math.floor(previous) : 0;
  return Math.min(safe + 1, 1_000);
}

/** 写事件是否还没被一次成功读取覆盖：写比上次成功更晚，说明界面上的数据已经旧了。 */
export function writeEventPending(
  lastWriteAt: number | null | undefined,
  lastSuccessAt: number | null | undefined,
): boolean {
  if (typeof lastWriteAt !== "number" || !Number.isFinite(lastWriteAt)) return false;
  if (typeof lastSuccessAt !== "number" || !Number.isFinite(lastSuccessAt)) return true;
  return lastWriteAt > lastSuccessAt;
}

/** 对账是否到期；没记过对账时退回上次成功时间，避免首次加载后又立刻对账。 */
export function reconcileDue(
  lastReconcileAt: number | null | undefined,
  lastSuccessAt: number | null | undefined,
  nowMs: number,
  intervalMs: number = REFRESH_TIMING.reconcileMs,
): boolean {
  if (!Number.isFinite(nowMs) || intervalMs <= 0) return false;
  const base = typeof lastReconcileAt === "number" ? lastReconcileAt : lastSuccessAt;
  if (typeof base !== "number" || !Number.isFinite(base)) return false;
  return nowMs - base >= intervalMs;
}

/** 数据新鲜度：只用于界面显示「上次更新」的颜色，不直接决定轮询。 */
export function freshnessLevel(
  ageMs: number,
  yellowMs: number = REFRESH_TIMING.freshnessYellowMs,
  redMs: number = REFRESH_TIMING.freshnessRedMs,
): "fresh" | "yellow" | "red" {
  const age = Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0;
  if (age > redMs) return "red";
  if (age > yellowMs) return "yellow";
  return "fresh";
}

// ---------------------------------------------------------------------------
// 四、注意力
// ---------------------------------------------------------------------------

export type AttentionSignalKind =
  | "focus"
  | "panel-open"
  | "session-switch"
  | "heartbeat"
  | "window-blur"
  | "panel-hidden";

export interface AttentionState {
  /** 面板是否打开。 */
  visible: boolean;
  /** 窗口是否聚焦。 */
  focused: boolean;
  /** 最后一次人类信号或心跳的时间。 */
  lastSignalAt: number;
}

export interface AttentionPlan {
  /** 是否还需要自动刷新。 */
  active: boolean;
  /** 探测间隔；收拢时为 null。 */
  intervalMs: number | null;
  /** 原因代号，日志和界面提示共用。 */
  reason: string;
  /** 下一次注意力心跳该等多久；收拢时为 null。 */
  heartbeatMs: number | null;
}

export function createAttentionState(): AttentionState {
  return { visible: false, focused: false, lastSignalAt: 0 };
}

/**
 * 记录一个注意力信号。
 *
 * 只有人类信号（聚焦、打开面板、切会话）和「可见时的心跳」推进 `lastSignalAt`；
 * 失焦、隐藏立即改写可见性。心跳不能把已经收拢的面板重新唤醒——
 * 后台心跳不是人，不该制造注意力。
 */
export function reportAttention(
  state: AttentionState,
  signal: AttentionSignalKind,
  nowMs: number,
): AttentionState {
  const at = Number.isFinite(nowMs) ? nowMs : 0;
  if (signal === "panel-hidden") return { ...state, visible: false, focused: false };
  if (signal === "window-blur") {
    if (!state.visible) return state;
    return { ...state, focused: false, lastSignalAt: at };
  }
  if (signal === "heartbeat") {
    // 失焦后心跳不再续期：否则「保留 30 秒再收拢」永远不会发生。
    if (!state.visible || !state.focused) return state;
    return { ...state, lastSignalAt: at };
  }
  return { ...state, visible: true, focused: true, lastSignalAt: at };
}

/** 面板可见但没聚焦、且还在注意力保留期内 → 用 15 秒慢探。 */
export function planAttention(
  state: AttentionState,
  nowMs: number,
  limits: { activeMs?: number; lingerMs?: number; activeLingerMs?: number; expiryMs?: number; heartbeatMs?: number } = {},
): AttentionPlan {
  const activeMs = limits.activeMs ?? REFRESH_TIMING.activeMs;
  const lingerMs = limits.lingerMs ?? REFRESH_TIMING.lingerMs;
  const activeLingerMs = limits.activeLingerMs ?? REFRESH_TIMING.activeLingerMs;
  const expiryMs = limits.expiryMs ?? REFRESH_TIMING.attentionExpiryMs;
  const heartbeatMs = limits.heartbeatMs ?? REFRESH_TIMING.heartbeatMs;
  if (!state.visible) return { active: false, intervalMs: null, reason: "hidden", heartbeatMs: null };
  const age = Number.isFinite(nowMs) ? Math.max(0, nowMs - state.lastSignalAt) : 0;
  if (age > expiryMs) return { active: false, intervalMs: null, reason: "expired", heartbeatMs: null };
  if (state.focused) return { active: true, intervalMs: activeMs, reason: "active", heartbeatMs };
  if (age <= activeLingerMs) return { active: true, intervalMs: lingerMs, reason: "linger", heartbeatMs };
  return { active: false, intervalMs: null, reason: "expired", heartbeatMs: null };
}

// ---------------------------------------------------------------------------
// 五、刷新裁决
// ---------------------------------------------------------------------------

export interface RefreshInput {
  visible: boolean;
  focused: boolean;
  /** 上次成功读取的时间；null 表示还没读过。 */
  lastSuccessAt: number | null;
  /** 连续失败次数。 */
  failures: number;
  /**
   * 剩余额度比例（0..1）；null 表示未知。
   * 未知时不因为额度停读，但要由界面显示「额度未知」。
   */
  remaining: number | null;
  /** 写预留比例；DSH 为 0.3。读不许把这块花掉。 */
  reserveRatio: number;
  // ---- 可选：不传则用上面的默认值 ----
  nowMs?: number;
  /** 由服务端给的档位；不传则从 remaining 反推。 */
  tier?: BudgetTier;
  /** 最近一次本地写的时间，用来触发写后刷新。 */
  lastWriteAt?: number | null;
  /** 最近一次对账的时间。 */
  lastReconcileAt?: number | null;
  /** 这一次读要花掉的额度比例；默认 0，仅用于「剩余低于预留」的判断。 */
  readCostRatio?: number;
  activeIntervalMs?: number;
  yellowIntervalMs?: number;
  lingerIntervalMs?: number;
  reconcileIntervalMs?: number;
  backoffMs?: readonly number[];
}

export interface RefreshDecision {
  /**
   * 下一次刷新该等多久：
   * - `-1`：停（不可见、红档、额度耗尽或低于写预留）；
   * - `0`：现在就该刷新；
   * - `>0`：等这么多毫秒。
   */
  delayMs: number;
  /** 是否允许发起写请求。写永远优先于读，但额度真的用完时也不放行。 */
  allowWrite: boolean;
  /** 原因代号；界面与日志用同一个词。 */
  reason: string;
}

/** 写权限只看额度是否真的用完；未知额度不拦写。 */
function writeAllowed(remaining: number | null): boolean {
  if (remaining === null || !Number.isFinite(remaining)) return true;
  return remaining > 0;
}

/**
 * 刷新裁决。
 *
 * 顺序（写死，测试按这个顺序断言）：
 * 隐藏 → 额度耗尽 → 红档 → 低于写预留 → 失败退避 → 写事件 → 首读 → 对账 → 探测。
 * 失败退避排在写事件前：写后刷新若连续失败，不能立刻又打一次。
 */
export function planRefresh(input: RefreshInput): RefreshDecision {
  const nowMs = Number.isFinite(input.nowMs) ? (input.nowMs as number) : Date.now();
  const allowWrite = writeAllowed(input.remaining);
  const remaining = input.remaining;
  const reserve = Number.isFinite(input.reserveRatio) ? Math.max(0, input.reserveRatio) : BUDGET.writeReserveShare;

  if (!input.visible) return { delayMs: -1, allowWrite, reason: "hidden" };
  if (remaining !== null && Number.isFinite(remaining) && remaining <= 0) {
    return { delayMs: -1, allowWrite: false, reason: "quota-exhausted" };
  }

  const tier = input.tier ?? tierFromRemainingRatio(remaining) ?? "green";
  if (tier === "red") return { delayMs: -1, allowWrite, reason: "tier-red" };

  const cost = Number.isFinite(input.readCostRatio) ? Math.max(0, input.readCostRatio as number) : 0;
  if (remaining !== null && Number.isFinite(remaining) && remaining - cost <= reserve) {
    return { delayMs: -1, allowWrite, reason: "write-reserve" };
  }

  if (input.failures > 0) {
    return {
      delayMs: backoffDelayMs(input.failures, input.backoffMs ?? REFRESH_TIMING.backoffMs),
      allowWrite,
      reason: "backoff",
    };
  }

  if (writeEventPending(input.lastWriteAt, input.lastSuccessAt)) {
    return { delayMs: 0, allowWrite, reason: "write" };
  }
  if (input.lastSuccessAt === null) return { delayMs: 0, allowWrite, reason: "initial" };

  const reconcileMs = input.reconcileIntervalMs ?? REFRESH_TIMING.reconcileMs;
  // 黄档停对账：DSH 降档时先牺牲后台对账。
  if (tier !== "yellow" && reconcileDue(input.lastReconcileAt, input.lastSuccessAt, nowMs, reconcileMs)) {
    return { delayMs: 0, allowWrite, reason: "reconcile" };
  }

  if (tier === "yellow") {
    return {
      delayMs: input.yellowIntervalMs ?? REFRESH_TIMING.yellowMs,
      allowWrite,
      reason: "probe-yellow",
    };
  }
  if (!input.focused) {
    return {
      delayMs: input.lingerIntervalMs ?? REFRESH_TIMING.lingerMs,
      allowWrite,
      reason: "unfocused",
    };
  }
  return {
    delayMs: input.activeIntervalMs ?? REFRESH_TIMING.activeMs,
    allowWrite,
    reason: "probe",
  };
}
