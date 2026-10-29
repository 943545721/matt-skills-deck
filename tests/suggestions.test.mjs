import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SUGGEST_DEFINITION,
  SUGGEST_LIMITS,
  SUGGEST_TOOL_NAME,
  clipSuggestionText,
  normalizeSuggestions,
} from "../shared/suggestions.ts";

/**
 * `suggest_next_steps` 是纯校验/排序函数：不碰网络、不写盘，所以直接喂参数断言。
 * 这里的数字全部来自 DSH 冻结契约（2~4 条、10/500/200、0~10）。
 */

const valid = (overrides = {}) => ({
  intro: "收口地图",
  prompt: "/to-tickets 把地图拆成可执行的票",
  reason: "路线还空着，拆完才能开工",
  ...overrides,
});

test("常量：与 DSH 冻结值一致", () => {
  assert.deepEqual(SUGGEST_LIMITS, {
    minItems: 2,
    maxItems: 4,
    introMax: 10,
    promptMax: 500,
    reasonMax: 200,
    priorityMin: 0,
    priorityMax: 10,
  });
  assert.equal(SUGGEST_TOOL_NAME, "suggest_next_steps");
  assert.equal(SUGGEST_DEFINITION.name, SUGGEST_TOOL_NAME);
});

test("接受 2~4 条：trim 前后空白，缺 priority 的不补默认值", () => {
  const result = normalizeSuggestions({
    items: [valid({ intro: "  收口地图  " }), valid({ intro: "补测试", reason: "没有回归保护" })],
  });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].intro, "收口地图");
  assert.equal("priority" in result.items[0], false);
});

test("少于 2 条、items 不是数组、参数不是对象：整次拒绝", () => {
  for (const input of [undefined, null, [], {}, { items: "x" }, { items: [valid()] }]) {
    const result = normalizeSuggestions(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(typeof result.error, "string");
  }
});

test("任意一条缺 intro / prompt / reason（trim 后为空）：整次拒绝，不返回半份清单", () => {
  const cases = [
    [[valid(), valid({ intro: "   " })], /第 2 条/],
    [[valid({ prompt: "" }), valid()], /第 1 条/],
    [[valid(), valid({ reason: "\n\t" })], /第 2 条/],
    [[valid(), null], /第 2 条/],
    [[valid(), "not-an-object"], /第 2 条/],
  ];
  for (const [items, expected] of cases) {
    const result = normalizeSuggestions({ items });
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
  }
});

test("超长字段按 Unicode 码点截断并补省略号：intro 10、prompt 500、reason 200", () => {
  const longIntro = "一二三四五六七八九十十一";
  const longPrompt = "x".repeat(501);
  const longReason = "理".repeat(201);
  const result = normalizeSuggestions({ items: [valid({ intro: longIntro, prompt: longPrompt, reason: longReason }), valid()] });
  assert.equal(result.ok, true);
  assert.equal(Array.from(result.items[0].intro).length, SUGGEST_LIMITS.introMax);
  assert.match(result.items[0].intro, /…$/);
  assert.equal(Array.from(result.items[0].prompt).length, SUGGEST_LIMITS.promptMax);
  assert.equal(Array.from(result.items[0].reason).length, SUGGEST_LIMITS.reasonMax);
});

test("截断不会切坏代理对：10 个 emoji 的简介截成 9 个 emoji + 省略号", () => {
  const intro = "😀".repeat(11);
  const result = normalizeSuggestions({ items: [valid({ intro }), valid()] });
  assert.equal(result.ok, true);
  const clipped = result.items[0].intro;
  assert.equal(Array.from(clipped).length, 10);
  assert.equal(clipped.endsWith("…"), true);
  // 每个码点都必须是完整字符：没有半个代理对。
  for (const char of Array.from(clipped.slice(0, -1))) {
    assert.equal(char, "😀");
  }
  assert.deepEqual(clipSuggestionText("😀".repeat(3), 3), { text: "😀😀😀", clipped: false });
});

test("priority 归一：钳到 0~10、保留一位小数；非数字当没打分", () => {
  const result = normalizeSuggestions({
    items: [
      valid({ intro: "下限", priority: -5 }),
      valid({ intro: "上限", priority: 12 }),
      valid({ intro: "四舍五入", priority: 9.46 }),
      valid({ intro: "字符串", priority: "7" }),
    ],
  });
  assert.equal(result.ok, true);
  // 排序后：10、9.5、0，再是没打分的。
  assert.deepEqual(result.items.map((item) => item.priority), [10, 9.5, 0, undefined]);

  const nan = normalizeSuggestions({ items: [valid({ priority: Number.NaN }), valid({ priority: Number.POSITIVE_INFINITY })] });
  assert.equal(nan.ok, true);
  assert.deepEqual(nan.items.map((item) => item.priority), [undefined, undefined]);
});

test("排序：priority 降序、并列保持原序、没打分的排最后", () => {
  const result = normalizeSuggestions({
    items: [
      valid({ intro: "A", priority: 3 }),
      valid({ intro: "B", priority: 9 }),
      valid({ intro: "C" }),
      valid({ intro: "D", priority: 7 }),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.intro), ["B", "D", "A", "C"]);

  const ties = normalizeSuggestions({
    items: [
      valid({ intro: "先", priority: 7 }),
      valid({ intro: "后", priority: 7 }),
      valid({ intro: "低", priority: 3 }),
      valid({ intro: "没分" }),
    ],
  });
  assert.equal(ties.ok, true);
  assert.deepEqual(ties.items.map((item) => item.intro), ["先", "后", "低", "没分"]);
});

test("多于 4 条：先按优先级排序再截断，截掉的永远是分最低或没打分的", () => {
  const result = normalizeSuggestions({
    items: [
      valid({ intro: "低", priority: 1 }),
      valid({ intro: "最高", priority: 9 }),
      valid({ intro: "没分" }),
      valid({ intro: "次高", priority: 8 }),
      valid({ intro: "中", priority: 5 }),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 4);
  assert.deepEqual(result.items.map((item) => item.intro), ["最高", "次高", "中", "低"]);
});

test("工具定义：items 必填，条目必填 intro / prompt / reason，不允许额外键", () => {
  const parameters = SUGGEST_DEFINITION.parameters;
  assert.deepEqual(parameters.required, ["items"]);
  assert.equal(parameters.additionalProperties, false);
  const item = parameters.properties.items.items;
  assert.deepEqual(item.required, ["intro", "prompt", "reason"]);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(Object.keys(item.properties).sort(), ["intro", "priority", "prompt", "reason"]);
  // 注册表只接受受支持的 JSON Schema 子集：条数约束写在说明里，由 normalizeSuggestions 保证。
  assert.equal(parameters.properties.items.minItems, undefined);
  assert.equal(parameters.properties.items.maxItems, undefined);
});
