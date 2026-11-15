import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  adoptLegacyCodexAddress,
  ensureCodexAddressEffective,
  forgetAdoptFailures,
  forgetMirrorFailures,
  mirrorCodexSiteModels,
  pruneRedundantCodexEnv,
  resetAdoptAttemptsForTest,
} from "../server/codex-adopt.ts";
import { legacyCodexAddressOf, modelObjectsOf } from "../server/provider-entry.ts";
import { listLogs, resetLogs } from "../server/logs.ts";
import {
  markProviderEntryDeleted,
  setTombstoneStatePathForTest,
} from "../server/provider-tombstones.ts";
import { CODEX_SITE_PROVIDER } from "../shared/orchestration.ts";

/**
 * 旧式 Codex 注入的自愈。
 *
 * 背景：Codex 适配器只把 `extends: "codex"` 的派生条目当成本次会话的 provider 配置，
 * 内建 `codex` 上的 `OPENAI_BASE_URL` 写了也没人读。早先的注入正是写在内建条目上的，
 * 于是「卡片上地址填好了、会话却走 ~/.codex/config.toml」——用户没有理由去理解这两层，
 * 插件该做的是把配置改成生效的形状，而不是让他再点一遍。
 *
 * 这里钉住四件事：搬什么（整个 env + 凭证补成 OPENAI_API_KEY + 模型清单）、
 * 什么时候不搬（派生条目已在 = 用户明确状态）、搬不动要报（宿主不接受派生 provider），
 * 以及同一条地址只试一次（不在每次读状态时反复写盘）。
 */

const CREDENTIAL = "sk-legacy-value-9f2c";

// 「补不进去」的记忆是模块级的：每个用例从干净的起点开始，免得上一个用例的失败影响下一个。
let tombstoneDir;
test.beforeEach(() => {
  forgetMirrorFailures();
  tombstoneDir = mkdtempSync(path.join(tmpdir(), "deck-tombstone-"));
  setTombstoneStatePathForTest(path.join(tombstoneDir, "state.json"));
});
test.afterEach(() => {
  setTombstoneStatePathForTest(null);
  rmSync(tombstoneDir, { recursive: true, force: true });
});

/** 一份可变的假宿主：patch 直接写进 config.get 返回的那份配置。 */
function fakePaseo(config, options = {}) {
  const state = { config, patches: [] };
  return {
    state,
    paseo: {
      config: {
        get: async () => ({ config: state.config }),
        patch: async (input) => {
          state.patches.push(input);
          if (options.patchThrows) throw new Error("config write refused");
          if (options.ignorePatch) return { ok: true };
          const providers = { ...(state.config.providers ?? {}) };
          // 宿主的口径：先按 removeProviders 整条摘掉，再合并同一补丁里的 providers。
          for (const id of input.removeProviders ?? []) delete providers[id];
          for (const [id, entry] of Object.entries(input.providers ?? {})) {
            providers[id] = { ...(providers[id] ?? {}), ...entry };
          }
          state.config = { ...state.config, providers };
          return { ok: true };
        },
      },
    },
  };
}

const legacyConfig = () => ({
  providers: {
    codex: {
      env: { OPENAI_BASE_URL: "http://127.0.0.1:3425/", SUB2API_API_KEY: CREDENTIAL },
      additionalModels: [{ id: "group/site8083", label: "site8083" }],
    },
  },
});

const providersOf = (config) => config.providers;

test("内建 codex 上的地址搬到派生条目：env、凭证、模型清单一起带过去", async (t) => {
  resetAdoptAttemptsForTest();
  resetLogs();
  t.after(() => resetLogs());
  const config = legacyConfig();
  const { paseo, state } = fakePaseo(config);

  const result = await adoptLegacyCodexAddress(paseo, providersOf(config));

  assert.equal(result.ok, true);
  assert.equal(result.adopted, true);
  // 核对过的那份配置随结果交回：调用方不用再读一次。
  assert.equal(result.config.providers[CODEX_SITE_PROVIDER].env.OPENAI_BASE_URL, "http://127.0.0.1:3425");
  assert.equal(state.patches.length, 1);
  const patch = state.patches[0].providers[CODEX_SITE_PROVIDER];
  assert.equal(patch.extends, "codex");
  assert.equal(patch.enabled, true);
  // 尾部斜杠归一掉：站点比对用的是同一个值，留着会天天「对不上」。
  assert.equal(patch.env.OPENAI_BASE_URL, "http://127.0.0.1:3425");
  // 派生条目只写适配器真读的两个键：地址 + `OPENAI_API_KEY`。
  // 旧键名（这里是 `SUB2API_API_KEY`）不再抄一份过去——同一把钥匙写两个名字，
  // 卡片上就多一行没人读、看不懂的东西。
  assert.equal(patch.env.OPENAI_API_KEY, CREDENTIAL);
  assert.deepEqual(Object.keys(patch.env).sort(), ["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  assert.deepEqual(patch.models, undefined);
  assert.deepEqual(patch.additionalModels, [{ id: "group/site8083", label: "site8083" }]);
  // 搬完要把内建条目上那条没人读的地址清掉：留着它，派生条目哪天被停用就又变回
  // 「卡片说有地址、宿主不读、建会话被拦」；凭证与其它自定义键照留。
  assert.equal(state.config.providers.codex.env.OPENAI_BASE_URL, undefined);
  assert.equal(state.config.providers.codex.env.SUB2API_API_KEY, CREDENTIAL);
});

test("清内建条目那条地址时不连坐：别的键原样带回去（含非字符串值）", async (t) => {
  resetAdoptAttemptsForTest();
  resetLogs();
  t.after(() => resetLogs());
  const config = {
    providers: {
      codex: { env: { OPENAI_BASE_URL: "http://127.0.0.1:3425", SUB2API_API_KEY: CREDENTIAL, DEBUG: 1 } },
    },
  };
  const { paseo, state } = fakePaseo(config);

  await adoptLegacyCodexAddress(paseo, providersOf(config));

  const env = state.patches[0].providers.codex.env;
  assert.equal(env.OPENAI_BASE_URL, undefined, "地址清掉");
  assert.equal(env.SUB2API_API_KEY, CREDENTIAL);
  assert.equal(env.DEBUG, 1, "非字符串值也是用户的配置，不能顺手删掉");
});

test("凭证的值不进日志：日志里只有「搬过」这件事", async (t) => {
  resetAdoptAttemptsForTest();
  resetLogs();
  t.after(() => resetLogs());
  const config = legacyConfig();
  const { paseo } = fakePaseo(config);

  await adoptLegacyCodexAddress(paseo, providersOf(config));

  const text = listLogs().map((entry) => entry.message).join("\n");
  assert.match(text, /已把内建 codex 上的接入地址搬到/);
  assert.equal(text.includes(CREDENTIAL), false, "凭证的值不该出现在日志里");
});

test("派生条目已经在了就不动：停用的站点不会被「自愈」重新打开", async (t) => {
  resetAdoptAttemptsForTest();
  const config = {
    providers: {
      codex: { env: { OPENAI_BASE_URL: "http://127.0.0.1:3425" } },
      [CODEX_SITE_PROVIDER]: { extends: "codex", enabled: false, env: { OPENAI_BASE_URL: "http://other:1" } },
    },
  };
  const { paseo, state } = fakePaseo(config);

  assert.equal(legacyCodexAddressOf(providersOf(config)), null, "派生条目在就不算旧式注入");
  const result = await adoptLegacyCodexAddress(paseo, providersOf(config));

  assert.deepEqual(result, { ok: true, adopted: false });
  assert.equal(state.patches.length, 0);
});

test("内建 codex 上没地址就没什么可搬的：普通 Codex 会话不受影响", async (t) => {
  resetAdoptAttemptsForTest();
  const config = { providers: { codex: { env: { SUB2API_API_KEY: CREDENTIAL } } } };
  const { paseo, state } = fakePaseo(config);

  const result = await adoptLegacyCodexAddress(paseo, providersOf(config));

  assert.deepEqual(result, { ok: true, adopted: false });
  assert.equal(state.patches.length, 0);
});

test("写进去又读回不到可用形状：报失败，不假装成功", async (t) => {
  resetAdoptAttemptsForTest();
  const config = legacyConfig();
  const { paseo, state } = fakePaseo(config, { ignorePatch: true });

  const result = await adoptLegacyCodexAddress(paseo, providersOf(config));

  assert.equal(result.ok, false);
  assert.match(result.detail, /deck-codex/);
  assert.equal(state.patches.length, 1);
});

test("同一条地址只试一次：宿主不收派生 provider 时不会每次读状态都重写配置", async (t) => {
  resetAdoptAttemptsForTest();
  const config = legacyConfig();
  const { paseo, state } = fakePaseo(config, { ignorePatch: true });

  const first = await adoptLegacyCodexAddress(paseo, providersOf(config));
  const second = await adoptLegacyCodexAddress(paseo, providersOf(config));

  assert.equal(first.ok, false);
  // 第二次不重写配置，但失败原因照样返回：调用方该告警还得告警，不能因为「试过了」
  // 就假装这次没问题。
  assert.equal(second.ok, false);
  assert.match(second.detail, /试过接管/);
  assert.equal(state.patches.length, 1, "第二次不该再写一遍");
});

test("写配置抛错时报失败，并把宿主的原因带出来", async (t) => {
  resetAdoptAttemptsForTest();
  const config = legacyConfig();
  const { paseo } = fakePaseo(config, { patchThrows: true });

  const result = await adoptLegacyCodexAddress(paseo, providersOf(config));

  assert.equal(result.ok, false);
  assert.match(result.detail, /config write refused/);
});

test("写完读不回来核对：报「没核对上」，不报「宿主不收派生 provider」，也不记成确定失败", async (t) => {
  resetAdoptAttemptsForTest();
  resetLogs();
  t.after(() => resetLogs());
  const config = legacyConfig();
  const state = { config, patches: [] };
  const paseo = {
    config: {
      // 写前读取成功，写后才掉线，不能依赖写前不可读时回退旧快照。
      get: async () => {
        if (state.patches.length === 0) return { config: structuredClone(state.config) };
        throw new Error("daemon 掉线");
      },
      patch: async (input) => {
        state.patches.push(input);
        // 宿主会收下这份补丁（读回时才掉线），所以这里要真写进去。
        const providers = { ...(state.config.providers ?? {}) };
        for (const [id, entry] of Object.entries(input.providers ?? {})) {
          providers[id] = { ...(providers[id] ?? {}), ...entry };
        }
        state.config = { ...state.config, providers };
        return { ok: true };
      },
    },
  };

  const result = await adoptLegacyCodexAddress(paseo, providersOf(config));

  assert.equal(result.ok, false);
  assert.match(result.detail, /读不到宿主配置核对/);
  assert.equal(/宿主可能不接受派生 provider/.test(result.detail), false, "不能把读失败说成宿主不收派生 provider");
  // 仍读不到新配置时不再写；连接恢复后也不能把先前读回失败记成「确定搬不动」。
  await adoptLegacyCodexAddress(paseo, providersOf(config));
  assert.equal(state.patches.length, 1);
  const recovered = fakePaseo(legacyConfig());
  assert.equal((await adoptLegacyCodexAddress(recovered.paseo, providersOf(config))).ok, true);
  assert.equal(recovered.state.patches.length, 1);
});

test("用户改过配置之后忘了这条地址的失败记录：值得再试一次", async (t) => {
  resetAdoptAttemptsForTest();
  const config = legacyConfig();
  const { paseo, state } = fakePaseo(config, { ignorePatch: true });

  assert.equal((await adoptLegacyCodexAddress(paseo, providersOf(config))).ok, false);
  assert.equal(state.patches.length, 1);

  forgetAdoptFailures("http://127.0.0.1:3425/");
  assert.equal((await adoptLegacyCodexAddress(paseo, providersOf(config))).ok, false);
  assert.equal(state.patches.length, 2, "忘掉之后会重新写一次，而不是直接返回缓存结论");
});

test("ensureCodexAddressEffective：搬成功了就把搬完的配置交回调用方", async (t) => {
  resetAdoptAttemptsForTest();
  const config = legacyConfig();
  const { paseo } = fakePaseo(config);

  const ensured = await ensureCodexAddressEffective(paseo, config);

  assert.equal(ensured.ok, true);
  assert.equal(ensured.adopted, true);
  const providers = ensured.config.providers;
  assert.equal(providers[CODEX_SITE_PROVIDER].env.OPENAI_BASE_URL, "http://127.0.0.1:3425");
  assert.equal(providers.codex.env.OPENAI_BASE_URL, undefined);
});

test("ensureCodexAddressEffective：搬不动与「写进去了但核对不上」分开报", async (t) => {
  resetAdoptAttemptsForTest();
  const failed = await ensureCodexAddressEffective(fakePaseo(legacyConfig(), { ignorePatch: true }).paseo, legacyConfig());
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "adopt-failed");

  resetAdoptAttemptsForTest();
  const config = legacyConfig();
  const state = { config, patches: [] };
  const paseo = {
    config: {
      get: async () => {
        if (state.patches.length === 0) return { config: structuredClone(state.config) };
        throw new Error("daemon 掉线");
      },
      patch: async (input) => {
        state.patches.push(input);
        const providers = { ...(state.config.providers ?? {}) };
        for (const [id, entry] of Object.entries(input.providers ?? {})) {
          providers[id] = { ...(providers[id] ?? {}), ...entry };
        }
        state.config = { ...state.config, providers };
        return { ok: true };
      },
    },
  };
  const unverified = await ensureCodexAddressEffective(paseo, config);
  assert.equal(unverified.ok, false);
  assert.equal(unverified.reason, "unverified");
  assert.match(unverified.detail, /读不到宿主配置核对/);
});

test("模型清单不是一份干净数组时也不抛：手改过 config.json 不能把读路径带崩", () => {
  assert.equal(modelObjectsOf(undefined), undefined);
  assert.equal(modelObjectsOf(/** @type {any} */ ("nope")), undefined);
  assert.deepEqual(modelObjectsOf(/** @type {any} */ ([null, 42, { id: 7 }, "  ", { id: "a" }])), [{ id: "a", label: "a" }]);
});

/* ------------------------- 清理派生条目里重复的凭据键（同一把钥匙的旧名字） */

const siteConfig = (env) => ({
  providers: {
    "deck-codex": { extends: "codex", label: "Deck Codex", enabled: true, env },
  },
});

test("派生条目里同一把钥匙的旧名字：删掉，只留适配器真读的那两个键", async (t) => {
  resetAdoptAttemptsForTest();
  resetLogs();
  t.after(() => resetLogs());
  const config = siteConfig({ OPENAI_BASE_URL: "http://127.0.0.1:3425", OPENAI_API_KEY: CREDENTIAL, SUB2API_API_KEY: CREDENTIAL });
  const { paseo, state } = fakePaseo(config);

  const result = await pruneRedundantCodexEnv(paseo, providersOf(config));

  assert.equal(result.ok, true);
  assert.deepEqual(result.pruned, ["SUB2API_API_KEY"]);
  assert.equal(state.patches.length, 1);
  // 宿主删不掉单个 env 键（补丁是深合并）：整条摘掉再写回干净形状，一个补丁内完成。
  assert.deepEqual(state.patches[0].removeProviders, ["deck-codex"]);
  const written = state.patches[0].providers["deck-codex"];
  assert.deepEqual(Object.keys(written.env).sort(), ["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  assert.equal(written.extends, "codex");
  assert.equal(written.label, "Deck Codex");
  assert.equal(written.enabled, true);
  const text = listLogs().map((entry) => entry.message).join("\n");
  assert.match(text, /删掉重复的凭据键 SUB2API_API_KEY/);
  assert.equal(text.includes(CREDENTIAL), false, "只记键名，不记值");
});

test("值不一样的键不动：那可能是另一套凭证，不是重复", async (t) => {
  resetAdoptAttemptsForTest();
  const config = siteConfig({ OPENAI_BASE_URL: "http://127.0.0.1:3425", OPENAI_API_KEY: CREDENTIAL, SUB2API_API_KEY: "sk-someone-else" });
  const { paseo, state } = fakePaseo(config);

  const result = await pruneRedundantCodexEnv(paseo, providersOf(config));

  assert.deepEqual(result, { ok: true, pruned: [] });
  assert.equal(state.patches.length, 0);
});

test("派生条目被停用时不动它：那是用户明确留下的状态", async (t) => {
  resetAdoptAttemptsForTest();
  const config = {
    providers: {
      "deck-codex": {
        extends: "codex",
        label: "Deck Codex",
        enabled: false,
        env: { OPENAI_BASE_URL: "http://127.0.0.1:3425", OPENAI_API_KEY: CREDENTIAL, SUB2API_API_KEY: CREDENTIAL },
      },
    },
  };
  const { paseo, state } = fakePaseo(config);

  const result = await pruneRedundantCodexEnv(paseo, providersOf(config));

  assert.deepEqual(result, { ok: true, pruned: [] });
  assert.equal(state.patches.length, 0);
});

test("已经干净就什么都不做：不在每次读状态时重写一遍", async (t) => {
  resetAdoptAttemptsForTest();
  const config = siteConfig({ OPENAI_BASE_URL: "http://127.0.0.1:3425", OPENAI_API_KEY: CREDENTIAL });
  const { paseo, state } = fakePaseo(config);

  const result = await pruneRedundantCodexEnv(paseo, providersOf(config));

  assert.deepEqual(result, { ok: true, pruned: [] });
  assert.equal(state.patches.length, 0);
});

test("ensureCodexAddressEffective 顺手清理，并把清理后的配置交回调用方", async (t) => {
  resetAdoptAttemptsForTest();
  const config = siteConfig({ OPENAI_BASE_URL: "http://127.0.0.1:3425", OPENAI_API_KEY: CREDENTIAL, SUB2API_API_KEY: CREDENTIAL });
  const { paseo, state } = fakePaseo(config);

  const ensured = await ensureCodexAddressEffective(paseo, config);

  assert.equal(ensured.ok, true);
  assert.equal(state.patches.length, 1);
  assert.deepEqual(
    Object.keys(ensured.config.providers["deck-codex"].env).sort(),
    ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    "交回的配置里已经没有那条残渣",
  );
});

/* --------------------------------------------- 模型清单：两行看到的是同一份 */

/** 清掉「这次运行补不进去」的记忆（每个用例从干净的起点开始）。 */
const resetMirrorFallback = () => forgetMirrorFailures();

const mirrorConfig = ({ derivedModels, codexModels, derivedExtra = {}, codexExtra = {} } = {}) => ({
  providers: {
    codex: { label: "Codex", models: codexModels, ...codexExtra },
    "deck-codex": {
      extends: "codex",
      label: "Deck Codex",
      enabled: true,
      models: derivedModels,
      env: { OPENAI_BASE_URL: "http://127.0.0.1:3425", OPENAI_API_KEY: CREDENTIAL },
      ...derivedExtra,
    },
  },
});

test("模型清单对不齐：以派生条目为准照写到内建 codex，换个窗口看到的模型一样", async (t) => {
  resetAdoptAttemptsForTest();
  resetLogs();
  t.after(() => resetLogs());
  // 用户报的那个形状：派生条目两个模型，内建那条还只有旧的。
  const config = mirrorConfig({
    derivedModels: [{ id: "group/site8083", label: "site8083" }, { id: "auto/gpt-6-astra", label: "gpt-6-astra" }],
    codexModels: [{ id: "group/site8083", label: "group/site8083" }],
  });
  const { paseo, state } = fakePaseo(config);

  const result = await mirrorCodexSiteModels(paseo, config);

  assert.equal(result.ok, true);
  assert.equal(result.mirrored, true);
  assert.equal(state.patches.length, 1);
  assert.deepEqual(
    state.config.providers.codex.models.map((item) => item.id),
    ["group/site8083", "auto/gpt-6-astra"],
    "选择器里「Codex」那行读的就是这一份",
  );
  assert.deepEqual(
    result.config.providers.codex.models.map((item) => item.id),
    ["group/site8083", "auto/gpt-6-astra"],
    "交回的配置是核对过的那份",
  );
  const text = listLogs().map((entry) => entry.message).join("\n");
  assert.match(text, /内建 codex 缺的 1 个模型补上/);
  assert.ok(!text.includes(CREDENTIAL), "日志里不能出现凭据");
});

test("模型清单已经一致：什么都不做，不在每次读状态时重写配置", async (t) => {
  resetAdoptAttemptsForTest();
  const models = [{ id: "group/site8083", label: "site8083" }];
  const config = mirrorConfig({ derivedModels: models, codexModels: models });
  const { paseo, state } = fakePaseo(config);

  assert.deepEqual(await mirrorCodexSiteModels(paseo, config), { ok: true, mirrored: false });
  assert.equal(state.patches.length, 0);
});

test("模型清单顺序不同不算不一致：别为了顺序写盘", async (t) => {
  resetAdoptAttemptsForTest();
  const config = mirrorConfig({
    derivedModels: [{ id: "b", label: "b" }, { id: "a", label: "a" }],
    codexModels: [{ id: "a", label: "a" }, { id: "b", label: "b" }],
  });
  const { paseo, state } = fakePaseo(config);

  assert.deepEqual(await mirrorCodexSiteModels(paseo, config), { ok: true, mirrored: false });
  assert.equal(state.patches.length, 0);
});

test("派生条目不可用（停用 / 没地址）：不动内建条目的清单", async (t) => {
  resetAdoptAttemptsForTest();
  for (const derivedExtra of [{ enabled: false }, { env: {} }]) {
    const config = mirrorConfig({
      derivedModels: [{ id: "a", label: "a" }],
      codexModels: [{ id: "b", label: "b" }],
      derivedExtra,
    });
    const { paseo, state } = fakePaseo(config);
    assert.deepEqual(await mirrorCodexSiteModels(paseo, config), { ok: true, mirrored: false });
    assert.equal(state.patches.length, 0, "用户明确留下的状态不翻过来");
  }
});

test("内建条目用的是 additionalModels：补到它自己那把键上，不碰 models、不删原有的", async (t) => {
  resetAdoptAttemptsForTest();
  const config = mirrorConfig({
    derivedModels: [{ id: "a", label: "a" }],
    codexModels: undefined,
    codexExtra: { additionalModels: [{ id: "b", label: "b" }] },
  });
  const { paseo, state } = fakePaseo(config);

  const result = await mirrorCodexSiteModels(paseo, config);

  assert.equal(result.ok, true);
  assert.equal(result.mirrored, true);
  // 只补不删：用户自己加在「Codex」那一行的 b 留着，缺的 a 追加在后面。
  assert.deepEqual(state.config.providers.codex.additionalModels.map((item) => item.id), ["b", "a"]);
  assert.equal(state.config.providers.codex.models, undefined);
});

test("宿主没收下照写：报「没对齐」，不静默当成功", async (t) => {
  resetAdoptAttemptsForTest();
  resetMirrorFallback();
  const config = mirrorConfig({
    derivedModels: [{ id: "a", label: "a" }],
    codexModels: [{ id: "b", label: "b" }],
  });
  const { paseo } = fakePaseo(config, { ignorePatch: true });

  const result = await mirrorCodexSiteModels(paseo, config);

  assert.equal(result.ok, false);
  assert.match(result.detail, /读回还缺/);
});

test("wrapper 拿到锁后重读：调用方旧快照不会把已生效的派生条目覆盖回去", async () => {
  resetAdoptAttemptsForTest();
  const state = {
    config: {
      providers: {
        "deck-codex": { extends: "codex", enabled: true, env: { OPENAI_BASE_URL: "http://new" } },
      },
    },
    patches: [],
  };
  const paseo = {
    config: {
      get: async () => ({ config: state.config }),
      patch: async (input) => {
        state.patches.push(input);
        return { ok: true };
      },
    },
  };
  const stale = { codex: { env: { OPENAI_BASE_URL: "http://old" } } };
  const result = await adoptLegacyCodexAddress(paseo, stale);
  assert.equal(result.ok, true);
  assert.equal(result.adopted, false, "当前配置已有 deck-codex，旧快照不该触发搬家");
  assert.equal(state.patches.length, 0, "不该用旧快照写回");
});

for (const [name, run] of [
  ["adopt", (paseo) => adoptLegacyCodexAddress(paseo, providersOf(legacyConfig()))],
  ["prune", (paseo) => pruneRedundantCodexEnv(paseo, providersOf(siteConfig({
    OPENAI_BASE_URL: "https://api.example.test/v1", OPENAI_API_KEY: CREDENTIAL, OLD_API_KEY: CREDENTIAL,
  })))],
  ["mirror", (paseo) => mirrorCodexSiteModels(paseo, mirrorConfig({
    derivedModels: [{ id: "a", label: "a" }], codexModels: undefined,
  }))],
  ["ensure", (paseo) => ensureCodexAddressEffective(paseo, legacyConfig())],
]) {
  test(`${name}：锁内读不到最新配置时拒绝用调用方旧快照写入`, async () => {
    const patches = [];
    const paseo = {
      config: {
        get: async () => { throw new Error("daemon 掉线"); },
        patch: async (patch) => { patches.push(patch); return { ok: true }; },
      },
    };
    const result = await run(paseo);
    assert.equal(patches.length, 0, "读取失败不能把已删除的条目从旧快照写回来");
    assert.equal(result.ok, false);
    assert.match(result.detail, /读不到/);
  });
}

for (const state of ["deleted", "malformed"]) {
  test(`prune 与 ensure 尊重派生条目的删除记录（${state}）`, async () => {
    if (state === "deleted") assert.deepEqual(markProviderEntryDeleted(CODEX_SITE_PROVIDER), { ok: true });
    else writeFileSync(path.join(tombstoneDir, "state.json"), JSON.stringify({ version: 1, deletedProviderEntries: null }));
    const config = siteConfig({
      OPENAI_BASE_URL: "https://api.example.test/v1", OPENAI_API_KEY: CREDENTIAL, OLD_API_KEY: CREDENTIAL,
    });
    const { paseo, state: host } = fakePaseo(config);
    const pruned = await pruneRedundantCodexEnv(paseo, providersOf(config));
    assert.equal(pruned.ok, true);
    assert.deepEqual(pruned.pruned, []);
    const ensured = await ensureCodexAddressEffective(paseo, config);
    assert.equal(ensured.ok, true);
    assert.equal(host.patches.length, 0, "ensure 内部的清理也不能绕过删除记录");
  });
}

for (const value of [{}, { deletedProviderEntries: "codex" }, { deletedProviderEntries: ["codex", null] }]) {
  test(`状态 JSON 字段损坏时不自动重建：${JSON.stringify(value)}`, async () => {
    writeFileSync(path.join(tombstoneDir, "state.json"), JSON.stringify(value));
    const mirror = mirrorConfig({ derivedModels: [{ id: "a", label: "a" }], codexModels: undefined });
    const host = fakePaseo(mirror);
    assert.equal((await mirrorCodexSiteModels(host.paseo, mirror)).mirrored, false);
    assert.equal(host.state.patches.length, 0);
    const legacy = legacyConfig();
    const second = fakePaseo(legacy);
    assert.equal((await adoptLegacyCodexAddress(second.paseo, providersOf(legacy))).adopted, false);
    assert.equal(second.state.patches.length, 0);
  });
}

test("用户删过 deck-codex：adopt 不按内建 codex 的旧地址重建", async () => {
  assert.deepEqual(markProviderEntryDeleted("deck-codex"), { ok: true });
  const config = legacyConfig();
  const { paseo, state } = fakePaseo(config);

  const result = await adoptLegacyCodexAddress(paseo, { codex: config.providers.codex });

  assert.equal(result.ok, true);
  assert.equal(result.adopted, false);
  assert.equal(state.patches.length, 0, "删掉的派生条目不能被旧地址重建");
});

test("墓碑文件坏了：镜像与 adopt 都按「有未确认删除」跳过，不重建", async () => {
  writeFileSync(path.join(tombstoneDir, "state.json"), "{ nope", "utf8");
  const mirror = mirrorConfig({ derivedModels: [{ id: "a", label: "a" }], codexModels: undefined });
  const first = fakePaseo(mirror);
  const mirrored = await mirrorCodexSiteModels(first.paseo, mirror);
  assert.equal(mirrored.ok, true);
  assert.equal(mirrored.mirrored, false);
  assert.equal(first.state.patches.length, 0);

  const legacy = legacyConfig();
  const second = fakePaseo(legacy);
  const adopted = await adoptLegacyCodexAddress(second.paseo, providersOf(legacy));
  assert.equal(adopted.ok, true);
  assert.equal(adopted.adopted, false);
  assert.equal(second.state.patches.length, 0);
});

test("用户整条删过 codex：镜像自愈不重建", async () => {
  assert.deepEqual(markProviderEntryDeleted("codex"), { ok: true });
  const config = mirrorConfig({ derivedModels: [{ id: "a", label: "a" }], codexModels: undefined });
  const { paseo, state } = fakePaseo(config);

  const result = await mirrorCodexSiteModels(paseo, config);

  assert.equal(result.ok, true);
  assert.equal(result.mirrored, false);
  assert.equal(state.patches.length, 0, "用户删掉的条目不能被镜像写回来");
});

test("补不进去只写一次盘：同一份清单再读一次只重复那句原因，不反复改配置", async (t) => {
  resetAdoptAttemptsForTest();
  resetMirrorFallback();
  t.after(() => resetMirrorFallback());
  const config = mirrorConfig({
    derivedModels: [{ id: "a", label: "a" }],
    codexModels: [{ id: "b", label: "b" }],
  });
  const { paseo, state } = fakePaseo(config, { ignorePatch: true });

  assert.equal((await mirrorCodexSiteModels(paseo, config)).ok, false);
  const again = await mirrorCodexSiteModels(paseo, config);

  assert.equal(again.ok, false);
  assert.match(again.detail, /读回还缺/, "第二次照样把原因说清楚");
  assert.equal(state.patches.length, 1, "不在每次读客户端页时都写一遍配置");

  // 用户重新保存模型之后要能再试一次：一次失败不该在整段运行里把他锁死。
  forgetMirrorFailures();
  assert.equal((await mirrorCodexSiteModels(paseo, config)).ok, false);
  assert.equal(state.patches.length, 2);
});
