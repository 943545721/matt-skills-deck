import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECK_SUGGEST_KIND,
  DECK_TIMELINE_VERSION,
  DECK_WORK_ROUTE_KIND,
  baseToolName,
  transformToolCall,
} from "../client/deck/timeline/transformer.ts";

const items = [
  { intro: "先诊断", prompt: "/diagnose #12", reason: "先把失败点定位清楚", priority: 6 },
  { intro: "再修复", prompt: "/fix #12", reason: "诊断完可以直接动手", priority: 9 },
  { intro: "补测试", prompt: "/tdd #12", reason: "防止回归" },
];

const toolCall = (overrides = {}) => ({
  type: "tool_call",
  name: "suggest_next_steps",
  status: "completed",
  callId: "call-1",
  detail: { type: "unknown", input: { items }, output: "{}" },
  ...overrides,
});

test("工具名前缀剥掉后能认出 suggest_next_steps 与旧名别名", () => {
  assert.equal(baseToolName("mcp__deck__suggest_next_steps"), "suggest_next_steps");
  assert.equal(baseToolName("suggest_next_steps"), "suggest_next_steps");
  assert.equal(baseToolName("deck.issue.suggest_next_steps"), "suggest_next_steps");
  assert.equal(baseToolName("deck_issues_list"), "deck_issue_list");
  assert.equal(baseToolName("deck_map"), "deck_map_snapshot");
});

test("完成的建议调用换成气泡，按 priority 排序并截断到四条", () => {
  const result = transformToolCall(toolCall(), "complete");
  assert.ok(result);
  assert.equal(result.items.length, 1);
  const [row] = result.items;
  assert.equal(row.type, "plugin");
  assert.equal(row.kind, DECK_SUGGEST_KIND);
  assert.equal(row.version, DECK_TIMELINE_VERSION);
  assert.equal(row.id, undefined);
  assert.deepEqual(row.data.items.map((item) => item.intro), ["再修复", "先诊断", "补测试"]);
  assert.deepEqual(row.data.items.map((item) => item.priority), [9, 6, undefined]);
});

test("建议参数被序列化成 JSON 字符串时仍能解析", () => {
  const result = transformToolCall(
    toolCall({ detail: { type: "unknown", input: JSON.stringify({ items }) } }),
    "complete",
  );
  assert.ok(result);
  assert.equal(result.items[0].data.items.length, 3);
});

test("运行中、失败、取消的调用保留原始工具行", () => {
  assert.equal(transformToolCall(toolCall({ status: "running" }), "streaming"), undefined);
  assert.equal(transformToolCall(toolCall({ status: "running" }), "complete"), undefined);
  assert.equal(transformToolCall(toolCall({ status: "failed" }), "complete"), undefined);
  assert.equal(transformToolCall(toolCall({ status: "canceled" }), "complete"), undefined);
});

test("少于两条建议整次不转换，交给原始工具行说明错误", () => {
  const one = { items: [{ intro: "只有一条", prompt: "x", reason: "y" }] };
  assert.equal(transformToolCall(toolCall({ detail: { type: "unknown", input: one } }), "complete"), undefined);
});

test("malformed 输入不抛异常", () => {
  const bad = [
    toolCall({ detail: { type: "unknown", input: null } }),
    toolCall({ detail: { type: "unknown", input: "{not json" } }),
    toolCall({ detail: { type: "unknown", input: [1, 2, 3] } }),
    toolCall({ detail: { type: "unknown", input: { items: [{ intro: 1 }] } } }),
    toolCall({ name: "suggest_next_steps", detail: { type: "plain_text", text: "x" } }),
  ];
  for (const call of bad) {
    assert.doesNotThrow(() => transformToolCall(call, "complete"));
    assert.equal(transformToolCall(call, "complete"), undefined);
  }
});

test("无关工具不转换", () => {
  assert.equal(transformToolCall(toolCall({ name: "deck_issue_list" }), "complete"), undefined);
  assert.equal(transformToolCall(toolCall({ name: "Read" }), "complete"), undefined);
});

const reportCall = (input = { key: "12", note: "正在改解析器", workRouteDetail: "core" }, output = { ok: true, number: 12 }) =>
  toolCall({
    name: "mcp__deck__deck_issue_report",
    detail: { type: "unknown", input, output: JSON.stringify(output) },
  });

test("成功上报换成工作路线卡，保留 key / 备注 / 仓库", () => {
  const result = transformToolCall(reportCall({ key: "#12", note: " 正在改解析器 ", repo: "acme/app" }), "complete");
  assert.ok(result);
  const [row] = result.items;
  assert.equal(row.kind, DECK_WORK_ROUTE_KIND);
  assert.equal(row.version, DECK_TIMELINE_VERSION);
  assert.deepEqual(row.data, {
    key: "12",
    action: "report",
    note: "正在改解析器",
    repoKey: "acme/app",
  });
});

test("撤销上报标成 release；未成功或写失败保留原始行", () => {
  const release = transformToolCall(reportCall({ key: 7, release: true }), "complete");
  assert.equal(release.items[0].data.action, "release");

  const failed = transformToolCall(reportCall({ key: 7 }, { ok: false, reason: "invalid" }), "complete");
  assert.equal(failed, undefined);
  const plain = transformToolCall(toolCall({ name: "deck_issue_report", detail: { type: "unknown", input: { key: 7 }, output: "not json" } }), "complete");
  assert.equal(plain, undefined);
  const missingKey = transformToolCall(reportCall({ key: "" }), "complete");
  assert.equal(missingKey, undefined);
});

test("上报工具只认完成态；流式阶段不提前换卡", () => {
  const call = reportCall();
  assert.equal(transformToolCall({ ...call, status: "running" }, "streaming"), undefined);
  assert.equal(transformToolCall({ ...call, status: "failed" }, "complete"), undefined);
});
