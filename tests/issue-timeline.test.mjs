import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIssueTimeline, firstLine, isTicketOf } from "../client/deck/panel/issueTimeline.ts";

/**
 * 票面的时间线。
 *
 * 这一列拼的是两份数据（远端票面 + 本机台账），错法都很安静：
 * 多出一行重复的「最近变动」、把别的票的会话算进来、把没变过的状态说成「刚变更」。
 * 所以每条口径各钉一条。
 */

const at = (day, hour, minute) => new Date(2026, 9, day, hour, minute).toISOString();
const comment = (author, createdAt, body = "内容") => ({ author, createdAt, body });
const session = (extra = {}) => ({
  ticketKey: "o/r#2",
  repoKey: "o/r",
  number: 2,
  title: "票",
  url: null,
  status: "attached",
  agentId: "agent-123456789",
  createdAt: at(18, 10, 0),
  updatedAt: at(18, 10, 0),
  note: null,
  ...extra,
});
// 按本机时间写期望值：ISO 串里是 UTC，直接切字符串会在非 UTC 机器上差几个小时。
const shape = (events) =>
  events.map((event) => {
    const when = new Date(event.at);
    return `${event.kind}@${when.getDate()}T${String(when.getHours()).padStart(2, "0")}`;
  });

test("建票 + 评论 + 最近变动：倒序排，最近的在上", () => {
  const events = buildIssueTimeline({
    createdAt: at(10, 9, 0),
    updatedAt: at(28, 15, 30),
    comments: [comment("alice", at(15, 12, 0)), comment("bob", at(20, 8, 0))],
  });
  assert.deepEqual(shape(events), ["updated@28T15", "comment@20T08", "comment@15T12", "created@10T09"]);
});

test("发评论把 updatedAt 顶到同一秒：不重复出一行「最近变动」", () => {
  const events = buildIssueTimeline({
    createdAt: at(10, 9, 0),
    updatedAt: at(20, 8, 0),
    comments: [comment("bob", at(20, 8, 0))],
  });
  assert.equal(events.filter((event) => event.kind === "updated").length, 0);
  assert.equal(events.length, 2, "建票 + 评论，没有第三条");
});

test("台账一条：接手一行，之后动过再加一行当前状态", () => {
  const events = buildIssueTimeline({
    createdAt: at(10, 9, 0),
    updatedAt: at(10, 9, 0),
    comments: [],
    sessions: [session({ status: "done", updatedAt: at(18, 17, 40) })],
  });
  const rows = events.filter((event) => event.kind === "session");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "done", "最近的一行写当前状态");
  assert.equal(rows[1].status, "attached", "更早的一行是接手");
  // 建票与 updatedAt 同一秒 → 不多写一行「最近变动」。
  assert.equal(events.filter((event) => event.kind === "updated").length, 0);
});

test("台账没动过：只出一行接手，不编一次状态变更", () => {
  const events = buildIssueTimeline({
    createdAt: at(10, 9, 0),
    updatedAt: at(10, 9, 0),
    comments: [],
    sessions: [session({ status: "in-progress" })],
  });
  assert.equal(events.filter((event) => event.kind === "session").length, 1);
});

test("时间解析不了的行直接丢掉，不占位也不乱排", () => {
  const events = buildIssueTimeline({
    createdAt: at(10, 9, 0),
    updatedAt: "not-a-date",
    comments: [comment("alice", "not-a-date", "坏行"), comment("bob", at(12, 9, 0))],
  });
  assert.deepEqual(shape(events), ["comment@12T09", "created@10T09"]);
});

test("关票时刻：远端给了才出一行，没给就不出现", () => {
  const closed = buildIssueTimeline({
    createdAt: at(10, 9, 0),
    updatedAt: at(22, 10, 0),
    closedAt: at(22, 9, 30),
    comments: [],
  });
  assert.deepEqual(shape(closed), ["updated@22T10", "closed@22T09", "created@10T09"]);

  const local = buildIssueTimeline({ createdAt: at(10, 9, 0), updatedAt: at(10, 9, 0), closedAt: null, comments: [] });
  assert.equal(local.filter((event) => event.kind === "closed").length, 0, "本地后端没有关票时刻，不编一行");
});

test("谁的票：整键相等才算，本地台账缺仓库时按 local 认", () => {
  assert.equal(isTicketOf({ repoKey: "o/r", number: 2 }, { repoKey: "o/r", number: 2 }), true);
  assert.equal(isTicketOf({ repoKey: "o/other", number: 2 }, { repoKey: "o/r", number: 2 }), false);
  assert.equal(isTicketOf({ repoKey: "o/r", number: 3 }, { repoKey: "o/r", number: 2 }), false);
  assert.equal(isTicketOf({ repoKey: null, number: 2 }, { repoKey: "local", number: 2 }), true);
  assert.equal(isTicketOf({ repoKey: null, number: 2 }, { repoKey: "o/r", number: 2 }), false);
});

test("评论摘要只取第一行，超长截断", () => {
  assert.equal(firstLine("\n\n  第一条  \n第二条"), "第一条");
  assert.equal(firstLine("很长很长".repeat(20)).endsWith("…"), true);
  assert.equal(firstLine(""), "");
});
