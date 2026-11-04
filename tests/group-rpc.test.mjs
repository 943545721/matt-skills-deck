import assert from "node:assert/strict";
import test from "node:test";
import {
  DECK_GROUP_LABEL,
  parseGroupMentions,
  planGroupSend,
} from "../shared/group-rpc.ts";

const cards = [
  { id: "staff-aaaaaa", name: "前端" },
  { id: "staff-bbbbbb", name: "后端" },
];

const final = { number: 12, finalized: true };

test("不带 @ 的消息发给主窗口，不收票", () => {
  const plan = planGroupSend({ text: "帮我看下构建", staff: cards, mainAgentId: "main-1", requirement: null });
  assert.equal(plan.ok, true);
  assert.equal(plan.phase, "send");
  assert.deepEqual(plan.targets.map((target) => target.toMain), [true]);
  assert.equal(plan.targets[0].ticketTitle, "帮我看下构建");
});

test("主窗口没绑时明确拒绝，不偷偷改发给派单窗口", () => {
  const plan = planGroupSend({ text: "帮我看下构建", staff: cards, mainAgentId: null, requirement: final });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-main");
});

test("@名字 先建票：票带 Refs 与岗位，正文留原话", () => {
  const plan = planGroupSend({ text: "@前端 把登录页的间距改一下", staff: cards, mainAgentId: "main-1", requirement: final });
  assert.equal(plan.ok, true);
  assert.equal(plan.phase, "send");
  assert.equal(plan.targets.length, 1);
  const [target] = plan.targets;
  assert.equal(target.staffId, "staff-aaaaaa");
  assert.equal(target.toMain, false);
  assert.match(target.ticketBody, /Refs: #12/);
  assert.match(target.ticketBody, /群派给：前端（staff-aaaaaa）/);
  assert.match(target.ticketBody, /@前端 把登录页的间距改一下/);
});

test("@id 同样命中；重复提到同一个人只派一次", () => {
  const plan = planGroupSend({
    text: "@staff-bbbbbb 改接口 @后端 顺手补测试",
    staff: cards,
    mainAgentId: "main-1",
    requirement: final,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].staffId, "staff-bbbbbb");
});

test("名册上没有的人：整句拒绝并列出已有岗位", () => {
  const plan = planGroupSend({ text: "@运维 重启一下", staff: cards, mainAgentId: "main-1", requirement: final });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "unknown-staff");
  assert.match(plan.detail, /前端/);
});

test("重名岗位给候选，不替人猜", () => {
  const plan = planGroupSend({
    text: "@前端 改一下",
    staff: [
      { id: "staff-aaaaaa", name: "前端" },
      { id: "staff-cccccc", name: "前端" },
    ],
    mainAgentId: "main-1",
    requirement: final,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "ambiguous-staff");
  assert.deepEqual(plan.candidates?.map((item) => item.staffId).sort(), ["staff-aaaaaa", "staff-cccccc"]);
});

test("群派活必须先有已定稿的需求票", () => {
  const missing = planGroupSend({ text: "@前端 改一下", staff: cards, mainAgentId: "main-1", requirement: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "no-requirement");

  const draft = planGroupSend({ text: "@前端 改一下", staff: cards, mainAgentId: "main-1", requirement: { number: 9, finalized: false } });
  assert.equal(draft.ok, false);
  assert.equal(draft.reason, "requirement-not-final");
  assert.match(draft.detail, /#9/);
});

test("主窗口路径不要求需求票（只有派活才要）", () => {
  const plan = planGroupSend({ text: "聊聊这个方案", staff: cards, mainAgentId: "main-1", requirement: { number: 9, finalized: false } });
  assert.equal(plan.ok, true);
  assert.equal(plan.phase, "send");
});

test("@全部 没有确认时只出清单，一张票也不预建", () => {
  const plan = planGroupSend({ text: "@全部 把各自的测试补齐", staff: cards, mainAgentId: "main-1", requirement: final });
  assert.equal(plan.ok, true);
  assert.equal(plan.phase, "preview");
  assert.deepEqual(plan.targets.map((target) => target.staffId), ["staff-aaaaaa", "staff-bbbbbb"]);
});

test("@全部 确认后才进入可发送状态", () => {
  const plan = planGroupSend({ text: "@全部 把各自的测试补齐", staff: cards, mainAgentId: "main-1", requirement: final, confirmAll: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.phase, "send");
  assert.equal(plan.targets.length, 2);
});

test("@全部 遇到空名册：明确拒绝", () => {
  const plan = planGroupSend({ text: "@全部 上", staff: [], mainAgentId: "main-1", requirement: final, confirmAll: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-staff-on-roster");
});

test("@全部 和具体岗位混写：拒绝，让人二选一", () => {
  const plan = planGroupSend({ text: "@全部 @前端 上", staff: cards, mainAgentId: "main-1", requirement: final, confirmAll: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "mixed-all");
});

test("空消息拒绝", () => {
  const plan = planGroupSend({ text: "   ", staff: cards, mainAgentId: "main-1", requirement: final });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "empty");
});

test("解析 @：中文标点断词、@全部 识别、重复 token 只留一次", () => {
  assert.deepEqual(
    parseGroupMentions("@前端，改一下；@后端：补测试 @前端").map((mention) => mention.token),
    ["前端", "后端"],
  );
  assert.equal(parseGroupMentions("@全部 上")[0].all, true);
  assert.equal(parseGroupMentions("@all 上")[0].all, true);
});

test("超长原话收进票标题时截断，正文保留完整原话", () => {
  const text = `@前端 ${"很长的需求".repeat(50)}`;
  const plan = planGroupSend({ text, staff: cards, mainAgentId: "main-1", requirement: final });
  assert.equal(plan.ok, true);
  assert.ok(plan.targets[0].ticketTitle.length <= 200);
  assert.match(plan.targets[0].ticketBody, /很长的需求/);
});

test("群标签常量固定", () => {
  assert.equal(DECK_GROUP_LABEL, "deck.group");
});

/* ---------------------------- 点名册选人：一个群只有一份名册，不存在「哪个区的那张」 */

test("点了 staffId：正文没有 @ 也派给这张卡，名字保持原样", () => {
  const plan = planGroupSend({
    text: "把间距改一下",
    staff: cards,
    staffId: "staff-aaaaaa",
    mainAgentId: null,
    requirement: final,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.phase, "send");
  assert.deepEqual(plan.targets.map((target) => [target.staffId, target.name]), [["staff-aaaaaa", "前端"]]);
});

test("点的 id 不在本群名册上：拒绝并列出本群的人，不猜是别处那张卡", () => {
  const plan = planGroupSend({
    text: "把间距改一下",
    staff: cards,
    staffId: "staff-cccccc",
    mainAgentId: "main-1",
    requirement: final,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "unknown-staff");
  assert.match(plan.detail, /前端/);
});

test("本群名册上重名：列出候选让人点，不自动加后缀", () => {
  const plan = planGroupSend({
    text: "@前端 改一下",
    staff: [
      { id: "staff-aaaaaa", name: "前端" },
      { id: "staff-bbbbbb", name: "前端" },
    ],
    mainAgentId: "main-1",
    requirement: final,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "ambiguous-staff");
  assert.deepEqual(
    plan.candidates.map((item) => item.staffId),
    ["staff-aaaaaa", "staff-bbbbbb"],
  );
  assert.equal(plan.candidates.some((item) => item.name.includes("-")), false);
});

test("点名和正文的 @ 撞在一起：点选优先，正文的 @ 只是那句话", () => {
  const plan = planGroupSend({
    text: "@后端 顺手看一下",
    staff: cards,
    staffId: "staff-aaaaaa",
    mainAgentId: null,
    requirement: final,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.targets.map((target) => target.staffId), ["staff-aaaaaa"]);
});

test("@全部 只铺本群名册，不带上别的项目的人", () => {
  const plan = planGroupSend({
    text: "@全部 今天先修登录页",
    staff: cards,
    mainAgentId: "main-1",
    requirement: final,
    confirmAll: true,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.targets.map((target) => target.staffId),
    ["staff-aaaaaa", "staff-bbbbbb"],
  );
});
