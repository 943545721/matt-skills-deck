import assert from "node:assert/strict";
import test from "node:test";
import {
  thinkingDefaultOf,
  withModelThinking,
} from "../client/deck/surfaces/orchestration/modelThinking.ts";
import { MAX_MODEL_THINKING } from "../shared/model-thinking.ts";

/**
 * 客户端卡片上「每个模型自己的默认思考档位」这张表的读写。
 *
 * 规则必须钉住的是不可变与清除语义：卡片把整表发回设置保存，原地改数组会让
 * 界面上那份快照跟着变，保存失败时看起来像已经存上了；清除只要残留一条，
 * 派单就还会带上一个用户以为已经删掉的档位。
 */

const defaults = [
  { provider: "claude", model: "group/site8083", thinkingOptionId: "high" },
  { provider: "claude", model: "auto/gpt-6-astra", thinkingOptionId: "low" },
];

test("按 provider + model 查默认档；比较前先 trim", () => {
  assert.equal(thinkingDefaultOf(defaults, "claude", "group/site8083"), "high");
  assert.equal(thinkingDefaultOf(defaults, " claude ", " group/site8083 "), "high");
  assert.equal(thinkingDefaultOf(defaults, "claude", "not-configured"), null);
  assert.equal(thinkingDefaultOf(defaults, "codex", "group/site8083"), null);
  assert.equal(thinkingDefaultOf(defaults, "", "group/site8083"), null);
  assert.equal(thinkingDefaultOf(defaults, "claude", ""), null);
  // 空白 id 等于没配：认不出就不该在行上印一个空档位。
  assert.equal(
    thinkingDefaultOf([{ provider: "claude", model: "m", thinkingOptionId: "  " }], "claude", "m"),
    null,
  );
});

test("设一个新模型的默认档：追加到末尾，返回新数组，不动入参", () => {
  const before = JSON.parse(JSON.stringify(defaults));
  const next = withModelThinking(defaults, "codex", "gpt-6", " medium ");

  assert.notEqual(next, defaults);
  assert.deepEqual(defaults, before, "入参不得被原地修改");
  assert.deepEqual(next, [...defaults, { provider: "codex", model: "gpt-6", thinkingOptionId: "medium" }]);
});

test("改已有模型的默认档：旧的一条被移除，本次设置的那条追加在末尾", () => {
  const next = withModelThinking(defaults, "claude", "group/site8083", "max");
  assert.deepEqual(next, [
    defaults[1],
    { provider: "claude", model: "group/site8083", thinkingOptionId: "max" },
  ]);
  assert.equal(thinkingDefaultOf(defaults, "claude", "group/site8083"), "high", "旧表保持原样");
});

test("清除：null / 空串 / 纯空白都移除那一条，其余保留", () => {
  for (const value of [null, "", "   "]) {
    const next = withModelThinking(defaults, "claude", "group/site8083", value);
    assert.equal(thinkingDefaultOf(next, "claude", "group/site8083"), null);
    assert.equal(thinkingDefaultOf(next, "claude", "auto/gpt-6-astra"), "low");
  }
});

test("清一个本来就没有的条目：不新增，仍返回新数组", () => {
  const next = withModelThinking(defaults, "claude", "never-set", null);
  assert.deepEqual(next, defaults);
  assert.notEqual(next, defaults);
});

test("provider / model 为空时不写进表里", () => {
  assert.deepEqual(withModelThinking(defaults, "", "m", "high"), defaults);
  assert.deepEqual(withModelThinking(defaults, "claude", "  ", "high"), defaults);
});

test("写入口与设置归一同一套去重：同键只留这次设置的那条", () => {
  const messy = [
    { provider: " claude ", model: "m", thinkingOptionId: "low" },
    { provider: "claude", model: "m", thinkingOptionId: "high" },
    { provider: "codex", model: "g", thinkingOptionId: "x" },
  ];
  const next = withModelThinking(messy, "claude", " m ", "max");
  assert.deepEqual(next, [
    { provider: "codex", model: "g", thinkingOptionId: "x" },
    { provider: "claude", model: "m", thinkingOptionId: "max" },
  ]);
});

test("条数用 shared 的 MAX_MODEL_THINKING 封顶，刚设的那条必须保留", () => {
  const full = Array.from({ length: MAX_MODEL_THINKING }, (_, index) => ({
    provider: "claude",
    model: `m-${index}`,
    thinkingOptionId: "low",
  }));
  const next = withModelThinking(full, "codex", "new", "high");

  assert.equal(next.length, MAX_MODEL_THINKING);
  assert.equal(thinkingDefaultOf(next, "codex", "new"), "high");
  assert.equal(thinkingDefaultOf(next, "claude", "m-0"), null, "腾位时丢的是表头最旧的一条");
  assert.equal(thinkingDefaultOf(next, "claude", `m-${MAX_MODEL_THINKING - 1}`), "low");
});
