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
    skillsMode: "per-project",
    autoAllowPermissions: false,
  });
});

/**
 * 旧文档里没有「自动放行」这个字段：补默认值时必须补成**关**。
 * 这是会替用户点头的开关，升级时被悄悄打开等于替他签了字。
 */
test("缺 autoAllowPermissions 时补成关，只有明确写 true 才开", async () => {
  assert.equal((await deckSettings.schema.parseAsync({})).autoAllowPermissions, false);
  assert.equal((await deckSettings.schema.parseAsync({ autoAllowPermissions: true })).autoAllowPermissions, true);
  await assert.rejects(() => deckSettings.schema.parseAsync({ autoAllowPermissions: "yes" }));
});

/**
 * 老用户升级后不能因为新增的模式字段被改成「统一模式」——
 * 统一模式会清空技能目录，默认值必须是「只补缺失」。
 */
test("缺 skillsMode 时补成 per-project，只认 unified / per-project", async () => {
  assert.equal((await deckSettings.schema.parseAsync({})).skillsMode, "per-project");
  for (const skillsMode of ["unified", "per-project"]) {
    assert.equal((await deckSettings.schema.parseAsync({ skillsMode })).skillsMode, skillsMode);
  }
  await assert.rejects(() => deckSettings.schema.parseAsync({ skillsMode: "mirror" }));
});

test("appearance 只接受 auto / dark / light / classic", async () => {
  assert.deepEqual([...APPEARANCES], ["auto", "dark", "light", "classic"]);
  for (const appearance of APPEARANCES) {
    const parsed = await deckSettings.schema.parseAsync({ appearance });
    assert.equal(parsed.appearance, appearance);
  }
  await assert.rejects(() => deckSettings.schema.parseAsync({ appearance: "sepia" }));
});
