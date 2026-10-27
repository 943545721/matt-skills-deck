import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
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

test("改色：空改动直接返回空结果，不读回", async () => {
  const result = await setLabelColors("acme", "deck", []);
  assert.deepEqual(result, {
    ok: true,
    applied: [],
    failed: [],
    verified: [],
    mismatched: [],
    readbackFailed: false,
  });
});

test("改色：写后读回，一致才算 verified，不一致如实进 mismatched", async () => {
  const gh = fakeGh(`case "$2" in
  *labels\\?*) echo '[{"name":"bug","color":"0e8a16"},{"name":"docs","color":"ffffff"}]' ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await setLabelColors("acme", "deck", [
      { name: "bug", color: "0e8a16" },
      { name: "docs", color: "1d76db" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.verified, [{ name: "bug", color: "0e8a16" }]);
    assert.deepEqual(result.mismatched, [{ name: "docs", expected: "1d76db", actual: "ffffff" }]);
    assert.equal(result.readbackFailed, false);
    // 两次 PATCH + 一次读回。
    assert.deepEqual(gh.calls(), ["api", "api", "api"]);
  } finally {
    gh.restore();
  }
});
