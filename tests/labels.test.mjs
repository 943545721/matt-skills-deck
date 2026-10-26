import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeColor, setLabelColors } from "../server/tracker/labels.ts";

test("颜色归一：带井号、大小写、首尾空白都收成 6 位小写", () => {
  assert.equal(normalizeColor("#9D7CD8"), "9d7cd8");
  assert.equal(normalizeColor(" 9d7cd8 "), "9d7cd8");
  assert.equal(normalizeColor("#ABC"), "");
  assert.equal(normalizeColor("red"), "");
  assert.equal(normalizeColor(""), "");
});

test("改色：非法颜色在本地就拒绝，绝不发请求", async () => {
  const result = await setLabelColors("acme", "deck", [
    { name: "bug", color: "zzzzzz" },
    { name: "  ", color: "0e8a16" },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, []);
  assert.equal(result.failed.length, 2);
});

test("改色：空改动直接返回空结果", async () => {
  const result = await setLabelColors("acme", "deck", []);
  assert.deepEqual(result, { ok: true, applied: [], failed: [] });
});
