import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STAFF_QUOTA_WINDOW_MS,
  decideStaffGate,
  decideWorkerDispatch,
} from "../server/staff-gates.ts";

/**
 * `agent.created` 上的两道岗位闸。
 *
 * 这一组钉的是「失败方向必须是放行」：读不到标签、卡没了、列表少了自己——
 * 都只记 warn 不归档。误杀一个正常会话，比漏拦一次贵得多。
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const card = (overrides = {}) => ({ id: "frontend", name: "前端", maxConcurrent: 1, ...overrides });

function session(overrides = {}) {
  return {
    id: "a1",
    workspaceId: "w1",
    labels: { "deck.staff": "frontend" },
    createdAt: iso(60_000),
    archivedAt: null,
    ...overrides,
  };
}

function decide(overrides = {}) {
  return decideStaffGate({
    labels: { "deck.staff": "frontend" },
    workspaceId: "w1",
    selfId: "self",
    now: NOW,
    roster: [card()],
    quota: 0,
    sessions: [session({ id: "self" })],
    ...overrides,
  });
}

test("不是岗位会话：这道闸根本不管", () => {
  assert.equal(decide({ labels: {} }).archive, false);
  assert.equal(decide({ labels: { "deck.role": "main" } }).archive, false);
});

test("卡被删了：没有上限可依据，放行而不是猜", () => {
  assert.equal(decide({ labels: { "deck.staff": "gone" }, roster: [card()] }).archive, false);
});

test("同一张卡只允许一个：已有同区同卡的会话在跑 → 归档新的", () => {
  const decision = decide({ sessions: [session({ id: "self" }), session({ id: "other" })] });
  assert.equal(decision.archive, true);
  assert.equal(decision.reason, "staff-singleton");
  assert.match(decision.detail, /同时最多 1 个/);
});

test("maxConcurrent=2 时第二个放行、第三个才拦", () => {
  const roster = [card({ maxConcurrent: 2 })];
  assert.equal(decide({ roster, sessions: [session({ id: "self" }), session({ id: "a" })] }).archive, false);
  const third = decide({ roster, sessions: [session({ id: "self" }), session({ id: "a" }), session({ id: "b" })] });
  assert.equal(third.archive, true);
});

test("别的卡、别的工作区、已归档的都不算在跑", () => {
  const decision = decide({
    sessions: [
      session({ id: "self" }),
      session({ id: "other-card", labels: { "deck.staff": "backend" } }),
      session({ id: "other-ws", workspaceId: "w2" }),
      session({ id: "archived", archivedAt: iso(0) }),
    ],
  });
  assert.equal(decision.archive, false);
});

test("额度：6 小时内第 N+1 个被拦，第 N 个放行", () => {
  const quota = 3;
  const other = (id) => session({ id, labels: { "deck.staff": id } });
  const three = [session({ id: "self" }), other("backend"), other("qa")];
  assert.equal(decide({ quota, sessions: three }).archive, false);
  const four = [...three, other("ops")];
  const decision = decide({ quota, sessions: four });
  assert.equal(decision.archive, true);
  assert.equal(decision.reason, "staff-quota");
  assert.match(decision.detail, /额度是 3 个/);
});

test("额度只看 6 小时窗口：更早的不计", () => {
  const old = [
    session({ id: "self" }),
    session({
      id: "a",
      labels: { "deck.staff": "backend" },
      createdAt: iso(STAFF_QUOTA_WINDOW_MS + 1000),
    }),
  ];
  assert.equal(decide({ quota: 1, sessions: old }).archive, false);
});

test("额度 0 = 关掉这道闸，不是「一个都不许开」", () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    session({ id: `s${index}`, labels: { "deck.staff": `card-${index}` } }),
  );
  assert.equal(decide({ quota: 0, sessions: many }).archive, false);
});

test("时间戳坏掉的会话不计入额度（宁可少拦，不可错杀）", () => {
  const broken = [
    session({ id: "self" }),
    session({ id: "bad", labels: { "deck.staff": "backend" }, createdAt: "不是时间" }),
  ];
  assert.equal(decide({ quota: 1, sessions: broken }).archive, false);
});

test("单例锁先于额度判：两条都超时，报的是单例锁", () => {
  const sessions = [session({ id: "self" }), session({ id: "a" }), session({ id: "b" })];
  const decision = decide({ quota: 1, sessions });
  assert.equal(decision.reason, "staff-singleton");
});

// ---------------------------------------------------------------------------
// 员工不能派活（父会话是员工卡 → 归档它派出去的新会话）
// ---------------------------------------------------------------------------

function dispatch(overrides = {}) {
  return decideWorkerDispatch({
    parentAgentId: "parent",
    parentLabels: { "deck.staff": "frontend" },
    roster: [card()],
    ...overrides,
  });
}

test("父会话是员工卡：新会话被归档，理由里带 deck_staff_request", () => {
  const decision = dispatch();
  assert.equal(decision.archive, true);
  assert.equal(decision.reason, "staff-worker-dispatch");
  assert.match(decision.detail, /deck_staff_request/);
});

test("父会话是经理卡：经理本来就要派活，放行", () => {
  assert.equal(
    dispatch({ roster: [card({ kind: "manager" })] }).archive,
    false,
  );
});

test("人从面板手工建（没有父会话）：不拦", () => {
  assert.equal(dispatch({ parentAgentId: null }).archive, false);
});

test("父会话标签读不出来 / 没有岗位标 / 卡已删：一律放行（失败方向是放行）", () => {
  assert.equal(dispatch({ parentLabels: null }).archive, false);
  assert.equal(dispatch({ parentLabels: {} }).archive, false);
  assert.equal(dispatch({ parentLabels: { "deck.staff": "gone" } }).archive, false);
});
