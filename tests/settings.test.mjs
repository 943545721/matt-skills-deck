import assert from "node:assert/strict";
import test from "node:test";
import { APPEARANCES, deckSettings } from "../shared/settings.ts";

/**
 * 现有安装里存的是加外观字段之前的文档（version 1、没有 appearance）。
 * schema 必须能直接把旧值补成 auto，否则升级后设置页会整页读不出来。
 */
test("旧设置缺 appearance 时补成 auto，已有字段保持不变", async () => {
  const parsed = await deckSettings.schema.parseAsync({
    backend: "github",
    refreshSeconds: 30,
    debugLogging: false,
  });
  assert.deepEqual(parsed, {
    backend: "github",
    refreshSeconds: 30,
    debugLogging: false,
    appearance: "auto",
  });
});

test("appearance 只接受 auto / dark / light / classic", async () => {
  assert.deepEqual([...APPEARANCES], ["auto", "dark", "light", "classic"]);
  for (const appearance of APPEARANCES) {
    const parsed = await deckSettings.schema.parseAsync({ appearance });
    assert.equal(parsed.appearance, appearance);
  }
  await assert.rejects(() => deckSettings.schema.parseAsync({ appearance: "sepia" }));
});
