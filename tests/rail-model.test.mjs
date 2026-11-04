import assert from "node:assert/strict";
import test from "node:test";
import {
  clipLines,
  railRowsOf,
  routeStatusKey,
  ticketsOfAgent,
} from "../client/deck/surfaces/orchestration/rail-model.ts";

/**
 * 群页右栏的行是「点谁就把话派给谁」的依据：合并规则错了不会报错，
 * 只会把话派给别人的会话。这里钉住的是合并与筛选，不是画法。
 */

/** 本群名册：一个群只有一份（一个目录一份），没有「哪个工作区的那张」。 */
const roster = (overrides) => ({ staff: [], ...overrides });

const person = (staffId, name, kind = "worker") => ({ staffId, name, kind });

const member = (overrides) => ({
  agentId: "agent-1",
  staffId: "staff-a",
  title: "",
  status: "idle",
  archived: false,
  ...overrides,
});

test("名册是主表：会话状态贴上去，没起会话的人也在", () => {
  const rows = railRowsOf({
    roster: roster({ staff: [person("staff-a", "秘书", "manager"), person("staff-b", "前端")] }),
    members: [member({ agentId: "agent-9", status: "running" })],
  });
  assert.equal(rows.length, 2);
  const byId = new Map(rows.map((row) => [row.staffId, row]));
  assert.equal(byId.get("staff-a").agentId, "agent-9");
  assert.equal(byId.get("staff-a").status, "running");
  assert.equal(byId.get("staff-b").agentId, null);
  assert.equal(byId.get("staff-b").status, null);
  assert.equal(byId.get("staff-a").kind, "manager");
});

test("同一个人的旧会话归档了：留没归档的那条", () => {
  const rows = railRowsOf({
    roster: roster({ staff: [person("staff-a", "秘书")] }),
    members: [
      member({ agentId: "agent-old", status: "closed", archived: true }),
      member({ agentId: "agent-new", status: "running" }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, "agent-new");
  assert.equal(rows[0].archived, false);
});

test("没挂岗位标签的会话不顶替任何人", () => {
  const rows = railRowsOf({
    roster: roster({ staff: [person("staff-a", "秘书")] }),
    members: [member({ agentId: "agent-x", staffId: "" })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, null);
});

test("名册外的会话不造行：这些群只列本目录名册上的人", () => {
  const rows = railRowsOf({
    roster: roster({ staff: [person("staff-a", "秘书")] }),
    members: [member({ agentId: "agent-1" }), member({ agentId: "agent-2", staffId: "staff-other" })],
  });
  assert.deepEqual(rows.map((row) => [row.staffId, row.agentId]), [["staff-a", "agent-1"]]);
});

test("保持名册自己的顺序，不按人名重排", () => {
  const rows = railRowsOf({
    roster: roster({ staff: [person("s-c", "阿丙"), person("s-b", "阿乙"), person("s-a", "阿丁")] }),
    members: [],
  });
  // 按人名或字典序重排会把人在设置里排好的顺序打乱。
  assert.deepEqual(rows.map((row) => row.staffId), ["s-c", "s-b", "s-a"]);
});

test("名册读失败时没有行：`detail` 是失败，不是「没人」", () => {
  const rows = railRowsOf({
    roster: roster({ staff: [], detail: "gh 没登录" }),
    members: [],
  });
  assert.deepEqual(rows, []);
});

const ticket = (overrides) => ({
  ticketKey: "o/r#12",
  repoKey: "o/r",
  number: 12,
  title: "修登录",
  status: "in-progress",
  agentId: "agent-1",
  updatedAt: "2026-11-01T10:00:00.000Z",
  ...overrides,
});

test("执行进度只列这个人手上还在的票，做完与放回的不算进度", () => {
  const entries = [
    ticket({ ticketKey: "o/r#12" }),
    ticket({ ticketKey: "o/r#13", number: 13, status: "done" }),
    ticket({ ticketKey: "o/r#14", number: 14, status: "released" }),
    ticket({ ticketKey: "o/r#15", number: 15, agentId: "agent-2" }),
  ];
  const lines = ticketsOfAgent(entries, "agent-1");
  assert.deepEqual(lines.map((line) => line.number), [12]);
});

test("执行进度按最近动过排：新的在上面", () => {
  const entries = [
    ticket({ ticketKey: "o/r#12", updatedAt: "2026-10-01T00:00:00.000Z" }),
    ticket({ ticketKey: "o/r#13", number: 13, updatedAt: "2026-11-03T00:00:00.000Z" }),
  ];
  assert.deepEqual(ticketsOfAgent(entries, "agent-1").map((line) => line.number), [13, 12]);
});

test("会话还没起：不猜谁的票，直接给空表", () => {
  assert.deepEqual(ticketsOfAgent([ticket()], null), []);
});

test("台账四个状态各有自己的文案，不落回同一个词", () => {
  const keys = ["attached", "in-progress", "done", "released"].map((status) => routeStatusKey(status));
  assert.equal(new Set(keys).size, 4);
  assert.deepEqual(keys, [
    "group.route.attached",
    "group.route.inProgress",
    "group.route.done",
    "group.route.released",
  ]);
});

test("交接文档超行数就截断，并且说出被截断了", () => {
  const short = clipLines("第一行\n第二行", 2);
  assert.deepEqual(short, { text: "第一行\n第二行", clipped: false });
  const long = clipLines("1\n2\n3\n4", 2);
  assert.deepEqual(long, { text: "1\n2", clipped: true });
  // Windows 换行不能把「行数」算错。
  assert.deepEqual(clipLines("a\r\nb\r\nc", 2), { text: "a\nb", clipped: true });
});
