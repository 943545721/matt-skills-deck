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

const here = { workspaceId: "ws-a", workspaceDir: "/a", name: "甲", staff: [] };
const other = {
  workspaceId: "ws-b",
  workspaceDir: "/b",
  name: "乙",
  staff: [{ id: "staff-bbbbbb", name: "前端" }],
};

test("点了 staffId：正文没有 @ 也派给这张卡，名字保持原样", () => {
  const plan = planGroupSend({
    text: "把间距改一下",
    staff: cards,
    staffId: "staff-aaaaaa",
    mainAgentId: null,
    requirement: final,
    workspace: { ...here, staff: cards },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.phase, "send");
  assert.equal(plan.targets[0].staffId, "staff-aaaaaa");
  assert.equal(plan.targets[0].name, "前端");
  assert.equal(plan.scope.workspaceId, "ws-a");
});

test("点了别的工作区的卡：scope 指到那个工作区，不改名字", () => {
  const plan = planGroupSend({
    text: "@前端 改一下",
    staff: [],
    staffId: "staff-bbbbbb",
    mainAgentId: "main-1",
    requirement: final,
    workspace: here,
    otherRosters: [other],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.targets[0].name, "前端");
  assert.equal(plan.scope.workspaceId, "ws-b");
  assert.equal(plan.scope.workspaceDir, "/b");
});

test("两个工作区同名：列出原名让人点，不自动加后缀", () => {
  const plan = planGroupSend({
    text: "@前端 改一下",
    staff: cards,
    mainAgentId: "main-1",
    requirement: final,
    workspace: { ...here, staff: cards },
    otherRosters: [other],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "ambiguous-staff");
  assert.deepEqual(
    plan.candidates.map((item) => item.name),
    ["前端", "前端"],
  );
  assert.deepEqual(
    plan.candidates.map((item) => item.workspaceName),
    ["甲", "乙"],
  );
  assert.equal(plan.candidates.some((item) => item.name.includes("-")), false);
});

test("当前工作区已经有这张卡：别的工作区撞了同一个 id，仍派给点中的这张", () => {
  const plan = planGroupSend({
    text: "把间距改一下",
    staff: [{ id: "staff-aaaaaa", name: "前端甲" }],
    staffId: "staff-aaaaaa",
    mainAgentId: null,
    requirement: final,
    workspace: { ...here, staff: [] },
    otherRosters: [{ ...other, staff: [{ id: "staff-aaaaaa", name: "前端乙" }] }],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.phase, "send");
  assert.equal(plan.targets[0].name, "前端甲");
  assert.equal(plan.scope.workspaceId, "ws-a");
});

test("一句话点到两个工作区：拒绝，并让人点其中一个", () => {
  const plan = planGroupSend({
    text: "@前端 改界面 @后端 改接口",
    staff: [{ id: "staff-aaaaaa", name: "前端" }],
    mainAgentId: "main-1",
    requirement: final,
    workspace: { ...here, staff: [{ id: "staff-aaaaaa", name: "前端" }] },
    otherRosters: [{ workspaceId: "ws-b", workspaceDir: "/b", name: "乙", staff: [{ id: "staff-bbbbbb", name: "后端" }] }],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "cross-workspace");
  assert.deepEqual(plan.candidates.map((item) => item.workspaceId), ["ws-a", "ws-b"]);
});
