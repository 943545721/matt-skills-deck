import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mirrorCodexSiteModels } from "../server/codex-adopt.ts";
import { cleanupProviderSource } from "../server/provider-cleanup.ts";
import {
  deletedProviderEntries,
  markProviderEntryDeleted,
  setTombstoneStatePathForTest,
} from "../server/provider-tombstones.ts";

/**
 * 指定清理注入源：只删勾选的键，别的字段一个不能丢。
 *
 * 宿主对 provider 的补丁是深合并，删键只能「摘掉整条 + 写回干净形状」；这个测试里的
 * 假宿主照这个顺序执行。断言一律是「原来的还在」，不只是「选中的没了」。
 */

let tombstoneDir;
test.beforeEach(() => {
  tombstoneDir = mkdtempSync(path.join(tmpdir(), "deck-tombstone-"));
  setTombstoneStatePathForTest(path.join(tombstoneDir, "state.json"));
});
test.afterEach(() => {
  setTombstoneStatePathForTest(null);
  rmSync(tombstoneDir, { recursive: true, force: true });
});

function fakePaseo(initial, options = {}) {
  let current = structuredClone(initial);
  const patches = [];
  let reads = 0;
  return {
    patches,
    get reads() {
      return reads;
    },
    config: {
      get: async () => {
        reads += 1;
        if (options.readErrorAt === reads) throw new Error("模拟配置读回失败");
        return { config: structuredClone(current) };
      },
      patch: async (patch) => {
        patches.push(structuredClone(patch));
        if (options.patchError === "before-write" && patches.length === 1) {
          throw new Error("模拟 patch 写入前失败");
        }
        if (options.ignorePatch) return { config: structuredClone(current) };
        if (Array.isArray(patch.removeProviders)) {
          for (const id of patch.removeProviders) delete current.providers[id];
        }
        if (patch.providers) {
          for (const [id, entry] of Object.entries(patch.providers)) {
            current.providers[id] = structuredClone(entry);
          }
        }
        if (options.afterPatch) options.afterPatch(current);
        if (options.patchError === "after-write" && patches.length === 1) {
          throw new Error("模拟 patch 响应丢失");
        }
        return { config: structuredClone(current) };
      },
    },
    disk: () => structuredClone(current),
  };
}

const baseConfig = () => ({
  providers: {
    "deck-codex": {
      extends: "codex",
      enabled: true,
      label: "Codex 站点",
      env: {
        OPENAI_BASE_URL: "http://192.168.1.2:3425",
        OPENAI_API_KEY: "sk-test-1234",
        EXTRA_FLAG: "1",
      },
      models: [{ id: "gpt-5", label: "GPT-5" }],
      additionalModels: [],
    },
    codex: { additionalModels: [], label: "Codex" },
    claude: { env: { ANTHROPIC_API_KEY: "sk-ant-1234" } },
    copilot: { env: { GITHUB_TOKEN: "gh-token" } },
  },
});

const cleanupFailureConfig = () => ({
  providers: {
    codex: { additionalModels: [], label: "Codex" },
    "deck-codex": {
      extends: "codex",
      enabled: true,
      label: "保留的站点",
      env: { OPENAI_BASE_URL: "https://provider.invalid/v1", EXTRA_FLAG: "keep" },
      models: [{ id: "regression-model", label: "Regression model" }],
    },
    claude: { label: "保留的客户端", env: { EXTRA_FLAG: "keep" } },
  },
});

const removeCodex = {
  provider: "codex",
  cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
};

test("patch 已删 codex 但响应丢失：保留墓碑，后续镜像不能重建", async () => {
  const initial = cleanupFailureConfig();
  const paseo = fakePaseo(initial, { patchError: "after-write" });

  const result = await cleanupProviderSource(paseo, structuredClone(removeCodex));
  const afterCleanup = paseo.disk();
  const tombstones = deletedProviderEntries();
  const mirrored = await mirrorCodexSiteModels(paseo, afterCleanup);
  const { codex: _removed, ...untouched } = initial.providers;

  assert.equal(result.ok, true, "读回已确认完成删除，应返回成功");
  assert.ok(result.warnings?.some((warning) => /响应失败.*读回/.test(warning)), "界面必须收到响应异常的告警");
  assert.deepEqual(afterCleanup, { ...initial, providers: untouched }, "只删除选中的 codex");
  assert.deepEqual(
    { tombstones, mirrored, config: paseo.disk(), patches: paseo.patches.length },
    {
      tombstones: { ok: true, ids: ["codex"] },
      mirrored: { ok: true, mirrored: false },
      config: afterCleanup,
      patches: 1,
    },
    "响应丢失不能撤销墓碑，也不能让镜像重新写回 codex",
  );
});

test("patch 未写入且读回原条目完整：撤销本次新墓碑，配置不变", async () => {
  const initial = cleanupFailureConfig();
  const paseo = fakePaseo(initial, { patchError: "before-write" });

  const result = await cleanupProviderSource(paseo, structuredClone(removeCodex));

  assert.equal(result.ok, false);
  assert.match(result.reason, /^(config|verify)-failed$/);
  assert.ok(result.detail, "写入失败应给出说明");
  assert.equal(paseo.patches.length, 1);
  assert.equal(paseo.reads, 3, "必须在 patch 异常后成功读回确认条目未变");
  assert.deepEqual(paseo.disk(), initial, "失败不能改动原条目或其它配置");
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: [] }, "确认完整原条目仍在后撤销新墓碑");
});

test("patch 抛错后读回失败：保留新墓碑以阻止后续重建", async () => {
  const initial = cleanupFailureConfig();
  const paseo = fakePaseo(initial, { patchError: "before-write", readErrorAt: 3 });

  const result = await cleanupProviderSource(paseo, structuredClone(removeCodex));

  assert.equal(result.ok, false);
  assert.match(result.reason, /^(config|verify)-failed$/);
  assert.deepEqual(paseo.disk(), initial, "宿主配置没有被 patch 修改");
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex"] });
});

test("patch 失败回滚不能清除清理前已存在的墓碑", async () => {
  const initial = cleanupFailureConfig();
  assert.deepEqual(markProviderEntryDeleted("codex"), { ok: true });
  const paseo = fakePaseo(initial, { patchError: "before-write" });

  const result = await cleanupProviderSource(paseo, structuredClone(removeCodex));

  assert.equal(result.ok, false);
  assert.deepEqual(paseo.disk(), initial);
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex"] });
});

test("patch 成功但清理后读回失败：墓碑仍保留", async () => {
  const initial = cleanupFailureConfig();
  const paseo = fakePaseo(initial, { readErrorAt: 3 });

  const result = await cleanupProviderSource(paseo, structuredClone(removeCodex));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "verify-failed");
  assert.deepEqual(paseo.disk().providers, {
    "deck-codex": initial.providers["deck-codex"],
    claude: initial.providers.claude,
  });
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex"] });
});

test("按勾选删 env 键：只删选中的，其它字段与模型原样保留", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["EXTRA_FLAG"] }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, [{ entryId: "deck-codex", keys: ["EXTRA_FLAG"], entryRemoved: false }]);
  assert.equal(paseo.patches.length, 1);
  assert.deepEqual(paseo.patches[0].removeProviders, ["deck-codex"]);

  const entry = paseo.disk().providers["deck-codex"];
  assert.equal(entry.env.OPENAI_BASE_URL, "http://192.168.1.2:3425");
  assert.equal(entry.env.OPENAI_API_KEY, "sk-test-1234");
  assert.equal(entry.env.EXTRA_FLAG, undefined);
  assert.equal(entry.label, "Codex 站点");
  assert.equal(entry.extends, "codex");
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.models, [{ id: "gpt-5", label: "GPT-5" }]);
  assert.deepEqual(entry.additionalModels, [], "空数组也要保留，不能被归一成 undefined");
});

test("地址/凭据默认拒绝；allowProtected 后才放行", async () => {
  const blocked = fakePaseo(baseConfig());
  const denied = await cleanupProviderSource(blocked, {
    provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["OPENAI_API_KEY"] }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "protected");
  assert.equal(blocked.patches.length, 0, "没确认前一个字节都不该写");

  const allowed = fakePaseo(baseConfig());
  const result = await cleanupProviderSource(allowed, {
    provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["OPENAI_API_KEY"] }],
    allowProtected: true,
  });
  assert.equal(result.ok, true);
  assert.equal(allowed.disk().providers["deck-codex"].env.OPENAI_API_KEY, undefined);
  assert.equal(allowed.disk().providers["deck-codex"].env.OPENAI_BASE_URL, "http://192.168.1.2:3425");
});

test("空条目整条清；非空条目拒绝", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, [{ entryId: "codex", keys: [], entryRemoved: true }]);
  assert.equal(paseo.disk().providers.codex, undefined);
  const tombstones = deletedProviderEntries();
  assert.equal(tombstones.ok, true);
  assert.ok(tombstones.ok && tombstones.ids.includes("codex"), "整条删要记住，镜像不能重建");

  const blocked = fakePaseo(baseConfig());
  const nonEmpty = await cleanupProviderSource(blocked, {
    provider: "codex",
    cleanups: [{ entryId: "claude", keys: [], removeEntry: true }],
  });
  assert.equal(nonEmpty.ok, false);
  assert.equal(nonEmpty.reason, "invalid");
  assert.equal(blocked.patches.length, 0);

  const nonEmptyConfig = baseConfig();
  nonEmptyConfig.providers.codex.additionalModels = [{ id: "x", label: "x" }];
  const forced = fakePaseo(nonEmptyConfig);
  const allowed = await cleanupProviderSource(forced, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
    allowNonEmpty: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(forced.disk().providers.codex, undefined);

  const both = fakePaseo(baseConfig());
  const mixed = await cleanupProviderSource(both, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: ["X"], removeEntry: true }],
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, "invalid");
  assert.equal(both.patches.length, 0);
});

test("缺条目 / 未知键 / 重复条目都在写之前拒绝", async () => {
  const missing = fakePaseo(baseConfig());
  const missingResult = await cleanupProviderSource(missing, {
    provider: "codex",
    cleanups: [{ entryId: "nope", keys: ["A"] }],
  });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, "not-found");

  const unknownKey = fakePaseo(baseConfig());
  const keyResult = await cleanupProviderSource(unknownKey, {
    provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["NOPE"] }],
  });
  assert.equal(keyResult.ok, false);
  assert.equal(keyResult.reason, "invalid");
  assert.match(keyResult.detail, /NOPE/);

  const duplicate = fakePaseo(baseConfig());
  const duplicateResult = await cleanupProviderSource(duplicate, {
    provider: "codex",
    cleanups: [
      { entryId: "deck-codex", keys: ["EXTRA_FLAG"] },
      { entryId: "deck-codex", keys: ["OPENAI_BASE_URL"] },
    ],
  });
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.reason, "invalid");

  assert.equal(missing.patches.length + unknownKey.patches.length + duplicate.patches.length, 0);
});

test("条目必须属于当前客户端：不能借 cleanup 清别的 provider", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "claude", keys: ["ANTHROPIC_API_KEY"] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.match(result.detail, /不属于 codex/);
  assert.equal(paseo.patches.length, 0);
});

test("空数组与字符串数组原样保留，不被归一改写", async () => {
  const config = baseConfig();
  config.providers.claude.models = ["string-model"];
  config.providers.claude.additionalModels = [];
  const paseo = fakePaseo(config);
  const result = await cleanupProviderSource(paseo, {
    provider: "claude",
    cleanups: [{ entryId: "claude", keys: ["NOT_THERE"] }],
  });
  // 未知键先拒绝；换一个存在的非保护键来验证保留。
  assert.equal(result.ok, false);

  config.providers.claude.env.EXTRA_FLAG = "1";
  const paseo2 = fakePaseo(config);
  const cleaned = await cleanupProviderSource(paseo2, {
    provider: "claude",
    cleanups: [{ entryId: "claude", keys: ["EXTRA_FLAG"] }],
  });
  assert.equal(cleaned.ok, true);
  const entry = paseo2.disk().providers.claude;
  assert.deepEqual(entry.models, ["string-model"]);
  assert.deepEqual(entry.additionalModels, []);
});

test("additionalModels 字符串/缺 label 归一成对象，空数组保留", async () => {
  const config = baseConfig();
  config.providers.claude.env.EXTRA_FLAG = "1";
  config.providers.claude.models = ["string-model"];
  config.providers.claude.additionalModels = ["gpt-5", { id: "no-label" }];
  const paseo = fakePaseo(config);
  const result = await cleanupProviderSource(paseo, {
    provider: "claude",
    cleanups: [{ entryId: "claude", keys: ["EXTRA_FLAG"] }],
  });
  assert.equal(result.ok, true);
  const entry = paseo.disk().providers.claude;
  assert.deepEqual(entry.models, ["string-model"], "models 是 loose 键，原样保留");
  assert.deepEqual(entry.additionalModels, [
    { id: "gpt-5", label: "gpt-5" },
    { id: "no-label", label: "no-label" },
  ]);
});

test("只支持 Claude / Codex：直接调 RPC 也不能清别家", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await cleanupProviderSource(paseo, {
    provider: "copilot",
    cleanups: [{ entryId: "copilot", keys: ["GITHUB_TOKEN"], removeEntry: false }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.match(result.detail, /Claude \/ Codex/);
  assert.equal(paseo.patches.length, 0);
});

test("带 command 的条目不算空条目；明确确认后仍可整条删", async () => {
  const config = baseConfig();
  config.providers.codex.command = ["codex"];
  const paseo = fakePaseo(config);
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.match(result.detail, /明确确认/);
  assert.equal(paseo.patches.length, 0);

  const forced = fakePaseo(config);
  const allowed = await cleanupProviderSource(forced, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
    allowNonEmpty: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(forced.disk().providers.codex, undefined);
});

test("手改坏的非数组字段：清理前拒绝，不静默丢字段", async () => {
  const modelsConfig = baseConfig();
  modelsConfig.providers.claude.env.EXTRA_FLAG = "1";
  modelsConfig.providers.claude.models = "gpt-5";
  const paseo = fakePaseo(modelsConfig);
  const key = await cleanupProviderSource(paseo, {
    provider: "claude",
    cleanups: [{ entryId: "claude", keys: ["EXTRA_FLAG"] }],
  });
  assert.equal(key.ok, false);
  assert.equal(key.reason, "invalid");
  assert.match(key.detail, /models/);
  assert.equal(paseo.patches.length, 0);

  const entryConfig = baseConfig();
  entryConfig.providers.codex.models = "gpt-5";
  const paseo2 = fakePaseo(entryConfig);
  const entry = await cleanupProviderSource(paseo2, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, "invalid");

  const envConfig = baseConfig();
  envConfig.providers.codex.env = "not-an-object";
  const paseo3 = fakePaseo(envConfig);
  const env = await cleanupProviderSource(paseo3, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
  });
  assert.equal(env.ok, false);
  assert.equal(env.reason, "invalid");

  const badItem = baseConfig();
  badItem.providers.claude.env.EXTRA_FLAG = "1";
  badItem.providers.claude.additionalModels = [null];
  const paseo4 = fakePaseo(badItem);
  const item = await cleanupProviderSource(paseo4, {
    provider: "claude",
    cleanups: [{ entryId: "claude", keys: ["EXTRA_FLAG"] }],
  });
  assert.equal(item.ok, false);
  assert.equal(item.reason, "invalid");
  assert.match(item.detail, /additionalModels/);
  assert.equal(paseo4.patches.length, 0);

  const nullModel = baseConfig();
  nullModel.providers.codex.models = [null];
  const paseo5 = fakePaseo(nullModel);
  const remove = await cleanupProviderSource(paseo5, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
  });
  assert.equal(remove.ok, false);
  assert.equal(remove.reason, "invalid");
  assert.equal(paseo5.patches.length, 0);
});

for (const [field, value] of [
  ["models", "gpt-5"],
  ["models", [null]],
  ["additionalModels", [null]],
  ["env", "not-an-object"],
]) {
  test(`明确确认整条删除时，${field} 的坏形状不阻止移除`, async () => {
    const config = baseConfig();
    config.providers.codex[field] = value;
    const paseo = fakePaseo(config);
    const { codex: _removed, ...untouched } = config.providers;

    const result = await cleanupProviderSource(paseo, {
      provider: "codex",
      cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
      allowNonEmpty: true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(paseo.disk(), { ...config, providers: untouched });
    assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex"] });
    assert.deepEqual(paseo.patches, [{ removeProviders: ["codex"] }], "整条移除不需写回坏字段");
  });
}

test("墓碑写不进去：取消删除，不动宿主配置", async () => {
  setTombstoneStatePathForTest(tombstoneDir);
  const paseo = fakePaseo(baseConfig());
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-failed");
  assert.equal(paseo.patches.length, 0, "墓碑没写进去就不该删配置");
  assert.ok(paseo.disk().providers.codex, "条目还在");
});

test("删除记录可读但写入失败：取消删除并返回安全原因", async () => {
  setTombstoneStatePathForTest(path.join(tombstoneDir, "missing-parent", "state.json"));
  const paseo = fakePaseo(baseConfig());
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "codex", keys: [], removeEntry: true }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-failed");
  assert.match(result.detail, /写入.*删除记录.*ENOENT/);
  assert.equal(paseo.patches.length, 0);
  assert.ok(paseo.disk().providers.codex);
});

test("空值的地址/凭据键仍按保护处理", async () => {
  const config = baseConfig();
  config.providers.claude.env.ANTHROPIC_API_KEY = "";
  const paseo = fakePaseo(config);
  const result = await cleanupProviderSource(paseo, {
    provider: "claude",
    cleanups: [{ entryId: "claude", keys: ["ANTHROPIC_API_KEY"] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "protected");
  assert.equal(paseo.patches.length, 0);
});

test("未选内容被宿主丢掉：报 verify-failed，不只核对选中的键", async () => {
  const paseo = fakePaseo(baseConfig(), {
    afterPatch: (current) => {
      delete current.providers["deck-codex"].label;
    },
  });
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["EXTRA_FLAG"] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verify-failed");
  assert.match(result.detail, /label/);
});

test("清理期间配置被改动：config-failed，不用旧快照覆盖", async () => {
  const initial = baseConfig();
  let current = structuredClone(initial);
  let reads = 0;
  const paseo = {
    config: {
      get: async () => {
        reads += 1;
        // 第二次读是 patch 前的快照核对：模拟另一个窗口刚保存了凭据。
        if (reads === 2) current.providers["deck-codex"].env.OPENAI_API_KEY = "sk-changed";
        return { config: structuredClone(current) };
      },
      patch: async () => {
        throw new Error("配置已变，不该再写");
      },
    },
  };
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["EXTRA_FLAG"] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-failed");
  assert.match(result.detail, /改动/);
});

test("写后读回不一致：报 verify-failed，不假装成功", async () => {
  const paseo = fakePaseo(baseConfig(), { ignorePatch: true });
  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["EXTRA_FLAG"] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verify-failed");
  assert.match(result.detail, /EXTRA_FLAG/);
});

function configWithAdditionalModelMetadata() {
  const config = baseConfig();
  return { ...config, providers: { ...config.providers, "deck-codex": {
    ...config.providers["deck-codex"],
    additionalModels: [{
      id: "metadata-model", label: "Metadata model", description: "Preserve the model description",
      isDefault: true,
      thinkingOptions: [{ id: "high", label: "High", description: "Preserve thinking metadata", isDefault: true }],
    }],
  } } };
}

for (const field of ["description", "isDefault", "thinkingOptions"]) {
  test(`只清 EXTRA_FLAG，宿主吞掉追加模型 ${field}：必须报 verify-failed`, async () => {
    const initial = configWithAdditionalModelMetadata();
    const paseo = fakePaseo(initial, {
      afterPatch: (current) => { delete current.providers["deck-codex"].additionalModels[0][field]; },
    });

    const result = await cleanupProviderSource(paseo, {
      provider: "codex",
      cleanups: [{ entryId: "deck-codex", keys: ["EXTRA_FLAG"] }],
    });

    assert.equal(paseo.patches.length, 1, "the cleanup must reach the simulated host patch");
    assert.deepEqual(paseo.patches[0].providers["deck-codex"].additionalModels,
      initial.providers["deck-codex"].additionalModels, "the patch must carry all unselected model metadata");
    assert.equal(Object.hasOwn(paseo.disk().providers["deck-codex"].additionalModels[0], field), false,
      "the simulated host must actually drop the field before readback");
    assert.equal(result.ok, false, "a completed env deletion must not hide loss of unselected model metadata");
    assert.equal(result.reason, "verify-failed");
  });
}

test("只清 EXTRA_FLAG，追加模型元数据完整保留：返回成功且不改其它内容", async () => {
  const initial = configWithAdditionalModelMetadata();
  const paseo = fakePaseo(initial);

  const result = await cleanupProviderSource(paseo, {
    provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["EXTRA_FLAG"] }],
  });

  const { EXTRA_FLAG: _removed, ...preservedEnv } = initial.providers["deck-codex"].env;
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, [{ entryId: "deck-codex", keys: ["EXTRA_FLAG"], entryRemoved: false }]);
  assert.deepEqual(paseo.disk(), { ...initial, providers: { ...initial.providers, "deck-codex": {
    ...initial.providers["deck-codex"], env: preservedEnv,
  } } }, "only the selected env key may change; every model field must survive");
});
