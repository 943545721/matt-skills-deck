import test from "node:test";
import assert from "node:assert/strict";

import {
  BUDGET,
  REFRESH_TIMING,
  admitBucket,
  backoffDelayMs,
  createAttentionState,
  freshnessLevel,
  nextFailureCount,
  planAttention,
  planRefresh,
  pluginHourlyAllowance,
  reconcileDue,
  reportAttention,
  splitAllowance,
  tierFor,
  tierFromRemainingRatio,
  writeEventPending,
} from "../shared/refresh.ts";

const NOW = 1_800_000_000_000;
const T0 = NOW - 60_000;

/** 绿档、可见、聚焦的基线。用对象展开覆盖单项，避免每个用例写十行。 */
function base(overrides = {}) {
  return {
    visible: true,
    focused: true,
    lastSuccessAt: T0,
    failures: 0,
    remaining: 0.9,
    reserveRatio: BUDGET.writeReserveShare,
    nowMs: NOW,
    ...overrides,
  };
}

test("常量与 DSH 原值一致", () => {
  assert.equal(REFRESH_TIMING.activeMs, 5000);
  assert.equal(REFRESH_TIMING.lingerMs, 15000);
  assert.equal(REFRESH_TIMING.yellowMs, 120000);
  assert.equal(REFRESH_TIMING.reconcileMs, 600000);
  assert.deepEqual([...REFRESH_TIMING.backoffMs], [8000, 30000, 120000, 300000]);
  assert.equal(BUDGET.pluginShareOfRemaining, 0.35);
  assert.equal(BUDGET.pluginHourlyCap, 1750);
  assert.equal(BUDGET.writeReserveShare, 0.3);
  assert.equal(BUDGET.tierGreenBelow, 0.6);
  assert.equal(BUDGET.tierRedAt, 0.85);
});

test("隐藏时停止轮询，但额度足够时写仍放行", () => {
  const decision = planRefresh(base({ visible: false }));
  assert.equal(decision.delayMs, -1);
  assert.equal(decision.reason, "hidden");
  assert.equal(decision.allowWrite, true);
});

test("可见且聚焦走 5 秒活跃探测", () => {
  const decision = planRefresh(base());
  assert.equal(decision.delayMs, 5000);
  assert.equal(decision.reason, "probe");
  assert.equal(decision.allowWrite, true);
});

test("可见但失焦降为 15 秒慢探", () => {
  const decision = planRefresh(base({ focused: false }));
  assert.equal(decision.delayMs, 15000);
  assert.equal(decision.reason, "unfocused");
});

test("黄档放慢到 120 秒，并且不再对账", () => {
  const decision = planRefresh(
    base({ remaining: 0.35, lastReconcileAt: NOW - REFRESH_TIMING.reconcileMs - 1 }),
  );
  assert.equal(decision.delayMs, 120000);
  assert.equal(decision.reason, "probe-yellow");
  // 对账本应到期，但黄档先牺牲它。
  assert.notEqual(decision.reason, "reconcile");
});

test("红档停止自动读取，仍不拦写", () => {
  const decision = planRefresh(base({ remaining: 0.1 }));
  assert.equal(decision.delayMs, -1);
  assert.equal(decision.reason, "tier-red");
  assert.equal(decision.allowWrite, true);
});

test("额度耗尽时读写都停", () => {
  const decision = planRefresh(base({ remaining: 0 }));
  assert.equal(decision.delayMs, -1);
  assert.equal(decision.reason, "quota-exhausted");
  assert.equal(decision.allowWrite, false);
});

test("额度未知不当作零：照常探测并允许写", () => {
  const decision = planRefresh(base({ remaining: null }));
  assert.equal(decision.delayMs, 5000);
  assert.equal(decision.reason, "probe");
  assert.equal(decision.allowWrite, true);
});

test("剩余贴住写预留下沿时停读、保写", () => {
  // 剩余 0.3 = 预留本身，任何读都会花到预留。
  const decision = planRefresh(base({ remaining: 0.3 }));
  assert.equal(decision.delayMs, -1);
  assert.equal(decision.reason, "write-reserve");
  assert.equal(decision.allowWrite, true);
});

test("读成本计入预留判断", () => {
  const decision = planRefresh(base({ remaining: 0.36, readCostRatio: 0.1 }));
  assert.equal(decision.reason, "write-reserve");
  assert.equal(decision.delayMs, -1);
});

test("失败退避按 8/30/120/300 秒推进并封顶", () => {
  const delays = [1, 2, 3, 4, 5, 99].map(
    (failures) => planRefresh(base({ failures })).delayMs,
  );
  assert.deepEqual(delays, [8000, 30000, 120000, 300000, 300000, 300000]);
  assert.equal(backoffDelayMs(0), 0);
  assert.equal(backoffDelayMs(-3), 0);
  assert.equal(backoffDelayMs(1, [100, 200]), 100);
  assert.equal(backoffDelayMs(9, [100, 200]), 200);
  assert.equal(backoffDelayMs(1, []), 0);
});

test("失败退避优先于写后刷新", () => {
  const decision = planRefresh(base({ failures: 2, lastWriteAt: NOW - 1000 }));
  assert.equal(decision.reason, "backoff");
  assert.equal(decision.delayMs, 30000);
});

test("写事件触发立即刷新，成功后回到正常探测", () => {
  const pending = planRefresh(base({ lastWriteAt: NOW - 1000, lastSuccessAt: T0 }));
  assert.equal(pending.delayMs, 0);
  assert.equal(pending.reason, "write");

  // 写后刷新已经成功：成功时间晚于写时间，事件被覆盖。
  const settled = planRefresh(base({ lastWriteAt: NOW - 2000, lastSuccessAt: NOW - 1000 }));
  assert.equal(settled.delayMs, 5000);
  assert.equal(settled.reason, "probe");
});

test("写事件判定是纯比较，缺一边时不误报", () => {
  assert.equal(writeEventPending(null, T0), false);
  assert.equal(writeEventPending(undefined, T0), false);
  assert.equal(writeEventPending(T0 + 1, null), true);
  assert.equal(writeEventPending(T0, T0), false);
  assert.equal(writeEventPending(T0 + 1, T0), true);
});

test("首读立即执行", () => {
  const decision = planRefresh(base({ lastSuccessAt: null, lastWriteAt: null }));
  assert.equal(decision.delayMs, 0);
  assert.equal(decision.reason, "initial");
  assert.equal(decision.allowWrite, true);
});

test("对账 10 分钟到期时立即执行，未到期照常探测", () => {
  const due = planRefresh(base({ lastReconcileAt: NOW - REFRESH_TIMING.reconcileMs }));
  assert.equal(due.delayMs, 0);
  assert.equal(due.reason, "reconcile");

  const notDue = planRefresh(base({ lastReconcileAt: NOW - REFRESH_TIMING.reconcileMs + 1 }));
  assert.equal(notDue.reason, "probe");

  assert.equal(reconcileDue(null, NOW - 600_000, NOW), true);
  assert.equal(reconcileDue(null, NOW - 599_999, NOW), false);
  assert.equal(reconcileDue(null, null, NOW), false);
});

test("失败计数只在有进展时清零", () => {
  assert.equal(nextFailureCount(0, false), 1);
  assert.equal(nextFailureCount(3, false), 4);
  assert.equal(nextFailureCount(3, true), 0);
  assert.equal(nextFailureCount(-5, false), 1);
});

test("新鲜度阈值：5 分钟黄、30 分钟红", () => {
  assert.equal(freshnessLevel(0), "fresh");
  assert.equal(freshnessLevel(300_000), "fresh");
  assert.equal(freshnessLevel(300_001), "yellow");
  assert.equal(freshnessLevel(1_800_000), "yellow");
  assert.equal(freshnessLevel(1_800_001), "red");
  assert.equal(freshnessLevel(-20), "fresh");
});

test("注意力：聚焦活跃 5 秒，失焦保留 30 秒慢探，之后收拢", () => {
  let state = createAttentionState();
  assert.equal(planAttention(state, NOW).reason, "hidden");

  state = reportAttention(state, "panel-open", NOW);
  const active = planAttention(state, NOW + 1000);
  assert.equal(active.active, true);
  assert.equal(active.intervalMs, 5000);
  assert.equal(active.reason, "active");
  assert.equal(active.heartbeatMs, 20000);

  state = reportAttention(state, "window-blur", NOW + 2000);
  const linger = planAttention(state, NOW + 3000);
  assert.equal(linger.intervalMs, 15000);
  assert.equal(linger.reason, "linger");
  assert.equal(linger.active, true);

  // 失焦后超过 30 秒保留期 → 收拢。
  const collapsed = planAttention(state, NOW + 2000 + 30_001);
  assert.equal(collapsed.active, false);
  assert.equal(collapsed.intervalMs, null);
  assert.equal(collapsed.reason, "expired");
});

test("注意力：心跳只续期可见面板，隐藏后不复活", () => {
  let state = reportAttention(createAttentionState(), "focus", NOW);
  state = reportAttention(state, "heartbeat", NOW + 20_000);
  assert.equal(state.visible, true);
  assert.equal(state.lastSignalAt, NOW + 20_000);
  assert.equal(planAttention(state, NOW + 21_000).reason, "active");

  state = reportAttention(state, "panel-hidden", NOW + 22_000);
  const hidden = planAttention(state, NOW + 23_000);
  assert.equal(hidden.active, false);
  assert.equal(hidden.reason, "hidden");

  const afterHeartbeat = reportAttention(state, "heartbeat", NOW + 40_000);
  assert.equal(afterHeartbeat.visible, false);
  assert.equal(planAttention(afterHeartbeat, NOW + 41_000).reason, "hidden");
});

test("注意力：失焦后的心跳不续期，30 秒保留期照常结束", () => {
  let state = reportAttention(createAttentionState(), "focus", NOW);
  state = reportAttention(state, "window-blur", NOW + 1000);
  const blurredAt = state.lastSignalAt;
  const heartbeats = [NOW + 21_000, NOW + 41_000].reduce(
    (current, at) => reportAttention(current, "heartbeat", at),
    state,
  );
  assert.equal(heartbeats.lastSignalAt, blurredAt);
  assert.equal(planAttention(heartbeats, NOW + 31_001).reason, "expired");
});

test("注意力：90 秒无任何信号即过期", () => {
  const state = reportAttention(createAttentionState(), "session-switch", NOW);
  assert.equal(planAttention(state, NOW + 90_000).active, true);
  assert.equal(planAttention(state, NOW + 90_001).active, false);
});

test("插件额度 = min(宿主剩余 35%, 1750)", () => {
  assert.equal(pluginHourlyAllowance(5000), 1750);
  assert.equal(pluginHourlyAllowance(10_000), 1750);
  assert.equal(pluginHourlyAllowance(1000), 350);
  assert.equal(pluginHourlyAllowance(0), 0);
  assert.equal(pluginHourlyAllowance(-1), 0);
  assert.equal(pluginHourlyAllowance(Number.NaN), 0);
});

test("读写分账：70% 读、30% 写预留", () => {
  assert.deepEqual(splitAllowance(1750), { total: 1750, read: 1225, write: 525 });
  assert.deepEqual(splitAllowance(1000), { total: 1000, read: 700, write: 300 });
  assert.deepEqual(splitAllowance(0), { total: 0, read: 0, write: 0 });
  assert.deepEqual(splitAllowance(-10), { total: 0, read: 0, write: 0 });
});

test("档位阈值 60% / 85%，额度为零按红档", () => {
  assert.equal(tierFor(0, 100), "green");
  assert.equal(tierFor(59, 100), "green");
  assert.equal(tierFor(60, 100), "yellow");
  assert.equal(tierFor(84, 100), "yellow");
  assert.equal(tierFor(85, 100), "red");
  assert.equal(tierFor(100, 100), "red");
  assert.equal(tierFor(0, 0), "red");
  assert.equal(tierFromRemainingRatio(0.9), "green");
  assert.equal(tierFromRemainingRatio(0.35), "yellow");
  assert.equal(tierFromRemainingRatio(0.1), "red");
  assert.equal(tierFromRemainingRatio(0), "red");
  assert.equal(tierFromRemainingRatio(null), null);
});

test("GraphQL 点数与 REST 请求分账，互不拖累", () => {
  // GraphQL 点数耗尽，只停 GraphQL 读。
  const graphql = admitBucket({
    bucket: "graphql",
    kind: "read",
    cost: 1,
    remaining: 0,
    used: 700,
    allowance: 700,
  });
  assert.equal(graphql.bucket, "graphql");
  assert.equal(graphql.allowed, false);
  assert.equal(graphql.reason, "exhausted");

  // 同一时刻 REST 仍有余额，写照常放行。
  const rest = admitBucket({
    bucket: "rest",
    kind: "write",
    cost: 1,
    remaining: 40,
    used: 700,
    allowance: 900,
  });
  assert.equal(rest.bucket, "rest");
  assert.equal(rest.allowed, true);
  assert.equal(rest.remainingAfter, 39);
});

test("单桶准入：未知余额放行、红档停读、写不占读档限制", () => {
  const unknown = admitBucket({
    bucket: "rest",
    kind: "read",
    cost: 1,
    remaining: null,
    used: 0,
    allowance: 100,
  });
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.reason, "unknown");

  const redRead = admitBucket({
    bucket: "rest",
    kind: "read",
    cost: 1,
    remaining: 10,
    used: 90,
    allowance: 100,
  });
  assert.equal(redRead.allowed, false);
  assert.equal(redRead.reason, "tier-red");

  const redWrite = admitBucket({
    bucket: "rest",
    kind: "write",
    cost: 1,
    remaining: 10,
    used: 90,
    allowance: 100,
  });
  assert.equal(redWrite.allowed, true);
  assert.equal(redWrite.reason, "write");
});

test("单桶准入：黄档读不许花进写预留", () => {
  const denied = admitBucket({
    bucket: "rest",
    kind: "read",
    cost: 2,
    remaining: 31,
    used: 70,
    allowance: 100,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "write-reserve");

  const allowed = admitBucket({
    bucket: "rest",
    kind: "read",
    cost: 2,
    remaining: 40,
    used: 70,
    allowance: 100,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "read-yellow");
  assert.equal(allowed.remainingAfter, 38);
});

test("单桶准入：免费请求与写超额", () => {
  const free = admitBucket({
    bucket: "graphql",
    kind: "read",
    cost: 0,
    remaining: 0,
    used: 100,
    allowance: 100,
  });
  assert.equal(free.allowed, true);
  assert.equal(free.reason, "free");

  const overWrite = admitBucket({
    bucket: "rest",
    kind: "write",
    cost: 5,
    remaining: 2,
    used: 98,
    allowance: 100,
  });
  assert.equal(overWrite.allowed, false);
  assert.equal(overWrite.reason, "over-write");
  assert.equal(overWrite.remainingAfter, -3);
});

test("自定义间隔与退避表可注入，默认值不变", () => {
  const decision = planRefresh(
    base({ activeIntervalMs: 1000, yellowIntervalMs: 2000, lingerIntervalMs: 3000, backoffMs: [11] }),
  );
  assert.equal(decision.delayMs, 1000);
  assert.equal(planRefresh(base({ remaining: 0.35, yellowIntervalMs: 2000 })).delayMs, 2000);
  assert.equal(planRefresh(base({ focused: false, lingerIntervalMs: 3000 })).delayMs, 3000);
  assert.equal(planRefresh(base({ failures: 9, backoffMs: [11] })).delayMs, 11);
  assert.equal(planRefresh(base()).delayMs, 5000);
});

test("服务端给的档位优先于按剩余比例反推", () => {
  // 剩余比例看起来是绿档，但服务端明确说黄档：按黄档走。
  const decision = planRefresh(base({ remaining: 0.9, tier: "yellow" }));
  assert.equal(decision.delayMs, 120000);
  assert.equal(decision.reason, "probe-yellow");

  const red = planRefresh(base({ remaining: 0.9, tier: "red" }));
  assert.equal(red.delayMs, -1);
  assert.equal(red.reason, "tier-red");
});
