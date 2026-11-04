import assert from "node:assert/strict";
import test from "node:test";
import { buildGroupContext } from "../server/group-context.ts";

const card = { id: "staff-front", name: "前端", duty: "负责登录页与样式" };

function record(overrides) {
  return { at: "2026-11-03T10:00:00Z", from: "你", agentId: "", kind: "user", text: "", ...overrides };
}

test("顺序：岗位说明 → 相关群消息 → 履历", () => {
  const result = buildGroupContext({
    card,
    records: [record({ text: "@前端 把登录页的按钮改成圆角" })],
    historyText: "## 你在本项目此前做过什么\n- 上次改过登录页",
  });
  assert.equal(result.includedRecords, 1);
  assert.match(result.text, /## 岗位说明\n负责登录页与样式/);
  assert.match(result.text, /@前端 把登录页的按钮改成圆角/);
  assert.ok(result.text.indexOf("此前做过什么") > result.text.indexOf("群里与这个岗位相关"));
});

test("只带 @ 到这位岗位的消息和它自己说过的话", () => {
  const result = buildGroupContext({
    card,
    records: [
      record({ text: "@后端 接口加一个字段" }),
      record({ text: "大家下午三点开会" }),
      record({ text: "@前端 修一下输入框" }),
      record({ at: "2026-11-03T11:00:00Z", from: "前端", kind: "staff", text: "输入框修好了" }),
    ],
  });
  assert.equal(result.includedRecords, 2);
  assert.doesNotMatch(result.text, /接口加一个字段/);
  assert.doesNotMatch(result.text, /三点开会/);
  assert.match(result.text, /修一下输入框/);
  assert.match(result.text, /输入框修好了/);
});

test("预算不够时从最新的往回保留，并留下「更早的没列」", () => {
  const records = Array.from({ length: 12 }, (_, index) =>
    record({
      at: `2026-11-03T10:${String(index).padStart(2, "0")}:00Z`,
      text: `@前端 第 ${index} 件事：${"很长的说明".repeat(8)}`,
    }),
  );
  const result = buildGroupContext({ card: { ...card, duty: "" }, records, maxChars: 200 });
  assert.ok(result.includedRecords > 0);
  assert.ok(result.includedRecords < 5);
  assert.match(result.text, /第 11 件事/);
  assert.match(result.text, /更早的没列/);
});

test("没有任何内容时回空串（调用方据此不写 systemPrompt）", () => {
  const result = buildGroupContext({ card: { ...card, duty: "" }, records: [] });
  assert.equal(result.text, "");
  assert.equal(result.includedRecords, 0);
});

test("前缀更长的是别人：@frontend 不算 @front", () => {
  const result = buildGroupContext({
    card: { id: "staff-fe", name: "front", duty: "" },
    records: [record({ text: "@frontend 改一下样式" })],
  });
  assert.equal(result.includedRecords, 0);
  assert.equal(result.text, "");
});

test("同名岗位按名字匹配大小写不敏感", () => {
  const result = buildGroupContext({
    card: { id: "staff-x", name: "QA", duty: "" },
    records: [record({ text: "@qa 跑一下回归" })],
  });
  assert.equal(result.includedRecords, 1);
});
