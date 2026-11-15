import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { patchProviderConfig, saveProfile } from "../server/orchestration.ts";
import { routeCodexSiteProvider } from "../server/hooks.ts";
import {
  deletedProviderEntries,
  markProviderEntryDeleted,
  setTombstoneStatePathForTest,
} from "../server/provider-tombstones.ts";

let tombstoneDir;
test.beforeEach(async () => {
  tombstoneDir = await mkdtemp(join(tmpdir(), "deck-write-tombstones-"));
  setTombstoneStatePathForTest(join(tombstoneDir, "state.json"));
});
test.afterEach(async () => {
  setTombstoneStatePathForTest(null);
  await rm(tombstoneDir, { recursive: true, force: true });
});

/**
 * 改宿主配置的两个写口：注入配置与客户端档案。
 *
 * 这里每一条都在钉同一个教训——宿主对数组是**整表替换**、对 env 落盘时整块替换：
 * 少带一样东西，就是一次不可逆的删除。所以断言一律是「原来的还在」，不只是「新的进去了」。
 */

/** 内存里存一份「线上形状」的配置；`get` 返回深拷贝，`patch` 按宿主的行为深合并。 */
function fakePaseo(initial, options = {}) {
  let current = structuredClone(initial);
  const patches = [];
  return {
    patches,
    get config() {
      return {
        get: async () => {
          if (patches.length && options.readBackError) throw new Error("模拟写后读回失败");
          return { config: structuredClone(current) };
        },
        patch: async (patch) => {
          patches.push(structuredClone(patch));
          if (options.patchError) throw new Error("模拟宿主拒绝写入");
          if (!options.ignorePatch) current = merge(current, structuredClone(patch));
          options.afterPatch?.(current);
          return { config: structuredClone(current) };
        },
      };
    },
    /** 直接看「磁盘上」剩下什么，用来断言没有被抹掉的键。 */
    disk: () => structuredClone(current),
  };
}

function merge(target, patch) {
  if (!patch || typeof patch !== "object") return patch;
  const out = Array.isArray(target) ? [...target] : { ...(target ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = merge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const baseConfig = () => ({
  providers: {
    claude: {
      env: { ANTHROPIC_API_KEY: "sk-ant-existing-key-9999", EXISTING_FLAG: "1" },
      additionalModels: [
        { id: "opus-x", label: "Opus X", isDefault: false },
        { id: "sonnet-x", label: "Sonnet X", isDefault: true, description: "日常" },
      ],
    },
  },
  agentProfiles: [
    { id: "daily", name: "日常", provider: "claude", icon: "☀️", color: "#ff0", featureValues: { fast: true } },
  ],
});

test("注入 env：提交时带上已有的全部键，落盘不会只剩新的那个", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await patchProviderConfig(paseo, { provider: "claude", env: { ANTHROPIC_BASE_URL: "https://x.test" } });
  assert.equal(result.ok, true);

  const env = paseo.disk().providers.claude.env;
  assert.equal(env.ANTHROPIC_BASE_URL, "https://x.test", "新键写进去了");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-existing-key-9999", "原有的键不能被整块替换掉");
  assert.equal(env.EXISTING_FLAG, "1");
  assert.ok(result.warnings.some((line) => line.includes("已有的") && line.includes("键")), "要把「一并带上」说出来");
});

test("注入 env：这个客户端还没配过 env 时照写新键（首次注入不能被当成读失败）", async () => {
  const paseo = fakePaseo({});
  const result = await patchProviderConfig(paseo, { provider: "claude", env: { ANTHROPIC_API_KEY: "sk-new" } });
  assert.equal(result.ok, true);
  assert.deepEqual(paseo.disk().providers.claude.env, { ANTHROPIC_API_KEY: "sk-new" });
});

test("注入 env：配置根本读不到时拒绝写入，不拿「只有新键」的补丁去整块替换", async () => {
  const paseo = {
    config: {
      get: async () => {
        throw new Error("daemon 未连接");
      },
      patch: async () => {
        throw new Error("不该被调用");
      },
    },
  };
  const result = await patchProviderConfig(paseo, { provider: "claude", env: { ANTHROPIC_API_KEY: "sk-new" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-failed");
  assert.match(result.detail, /读不到 daemon 配置/);
});

test("注入 env：现有 env 不是键值表时拒绝，不把原值冲掉", async () => {
  const paseo = fakePaseo({ providers: { claude: { env: ["ANTHROPIC_API_KEY=sk"] } } });
  const result = await patchProviderConfig(paseo, { provider: "claude", env: { NEW_KEY: "1" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-failed");
  assert.equal(paseo.patches.length, 0);
});

test("模型清单：替换语义，保留既有条目的 label / isDefault / description，新条目自带 label", async () => {
  const paseo = fakePaseo(baseConfig());
  // 传完整清单：留下 sonnet-x 并新增 haiku-x，未列出的 opus-x 就该被删掉。
  const result = await patchProviderConfig(paseo, { provider: "claude", models: ["sonnet-x", "haiku-x"] });
  assert.equal(result.ok, true);

  const models = paseo.disk().providers.claude.additionalModels;
  assert.deepEqual(models, [
    { id: "sonnet-x", label: "Sonnet X", isDefault: true, description: "日常" },
    { id: "haiku-x", label: "haiku-x" },
  ]);
  assert.ok(result.warnings.some((line) => line.includes("additionalModels")), "追回模式要说明内置删不掉");
});

test("模型清单：重复 id 不产生重复条目，顺序按提交的来", async () => {
  const paseo = fakePaseo(baseConfig());
  await patchProviderConfig(paseo, { provider: "claude", models: ["sonnet-x", "new-y", "new-y", "sonnet-x"] });
  const ids = paseo.disk().providers.claude.additionalModels.map((item) => item.id);
  assert.deepEqual(ids, ["sonnet-x", "new-y"]);
});

test("模型清单：客户端用的是 `models`（替换内置）时写回 `models`，不写到不生效的 additionalModels", async () => {
  // 用 claude 当样本：Codex 现在一律写派生条目，那把键的选择另有用例锁（见文件末尾）。
  const paseo = fakePaseo({
    providers: {
      claude: { models: [{ id: "gpt-a", label: "GPT A", isDefault: true }, { id: "gpt-b", label: "GPT B" }] },
    },
  });
  const result = await patchProviderConfig(paseo, { provider: "claude", models: ["gpt-a"] });
  assert.equal(result.ok, true);
  const disk = paseo.disk().providers.claude;
  assert.deepEqual(disk.models, [{ id: "gpt-a", label: "GPT A", isDefault: true }], "保留宿主自己的字段");
  assert.equal(disk.additionalModels, undefined, "不能顺手往另一把键上写");
  assert.ok(!result.warnings.some((line) => line.includes("内置模型删不掉")), "替换模式不该报追加模式的限制");
});

test("模型清单：替换模式下清空要拒绝，否则这个客户端一个模型都不剩", async () => {
  const paseo = fakePaseo({
    providers: { claude: { models: [{ id: "gpt-a", label: "GPT A" }] } },
  });
  const result = await patchProviderConfig(paseo, { provider: "claude", models: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(paseo.patches.length, 0);
});

test("Claude 保存模型：当前模型的接口窗口写进 env", async () => {
  const config = baseConfig();
  config.providers.claude.env.ANTHROPIC_MODEL = "current";
  const paseo = fakePaseo(config);
  const result = await patchProviderConfig(paseo, {
    provider: "claude",
    models: ["small", "current"],
    modelDefinitions: [
      { id: "small", label: "Small", contextWindowMaxTokens: 64000 },
      { id: "current", label: "Current", contextWindowMaxTokens: 96000 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "96000");
  assert.ok(result.applied.includes("env.CLAUDE_CODE_MAX_CONTEXT_TOKENS"));
  assert.equal(paseo.disk().providers.claude.env.ANTHROPIC_API_KEY, "sk-ant-existing-key-9999");
  assert.deepEqual(paseo.patches[0].providers.claude.env, {
    ANTHROPIC_API_KEY: "sk-ant-existing-key-9999",
    EXISTING_FLAG: "1",
    ANTHROPIC_MODEL: "current",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "96000",
  }, "env 落盘整块替换，实际提交的补丁必须带齐原键");
  assert.equal(result.warnings.some((line) => line.includes("CLAUDE_CODE_MAX_CONTEXT_TOKENS") && line.includes("已有的")), false, "新同步的键不能算成用户原有的键");
  assert.equal(result.warnings.some((line) => line.includes("CLAUDE_CODE_MAX_CONTEXT_TOKENS") && line.includes("读回不一致")), false);
});

test("Claude 保存模型：宿主没存下同步的窗口时读回要告警", async () => {
  const config = baseConfig();
  const paseo = {
    config: {
      get: async () => ({ config: structuredClone(config) }),
      patch: async () => ({ ok: true }),
    },
  };
  const result = await patchProviderConfig(paseo, {
    provider: "claude",
    models: ["current"],
    modelDefinitions: [{ id: "current", label: "Current", contextWindowMaxTokens: 96000 }],
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((line) => line.includes("CLAUDE_CODE_MAX_CONTEXT_TOKENS") && line.includes("读回不一致")));
});

test("Claude 保存模型：当前模型没窗口时取最小值；没有窗口时保留用户写的 env", async () => {
  const config = baseConfig();
  config.providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "user-written";
  const paseo = fakePaseo(config);
  await patchProviderConfig(paseo, {
    provider: "claude",
    models: ["large", "small"],
    modelDefinitions: [
      { id: "large", label: "Large", contextWindowMaxTokens: 256000 },
      { id: "small", label: "Small", contextWindowMaxTokens: 32000 },
    ],
  });
  assert.equal(paseo.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "32000");

  await patchProviderConfig(paseo, { provider: "claude", models: ["no-window"], modelDefinitions: [{ id: "no-window", label: "No window" }] });
  assert.equal(paseo.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "32000", "没窗口不能删除旧值");

  const manual = fakePaseo(baseConfig());
  await patchProviderConfig(manual, {
    provider: "claude",
    models: ["no-window"],
    modelDefinitions: [{ id: "no-window", label: "No window" }],
  });
  assert.equal(manual.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "没窗口不能新增");
});

test("Claude 保存注入：只换 ANTHROPIC_MODEL 也同步对应窗口", async () => {
  const config = baseConfig();
  config.providers.claude.env.ANTHROPIC_MODEL = "large";
  config.providers.claude.additionalModels = [
    { id: "large", label: "Large", contextWindowMaxTokens: 256000 },
    { id: "small", label: "Small", contextWindowMaxTokens: 48000 },
  ];
  const paseo = fakePaseo(config);
  const result = await patchProviderConfig(paseo, { provider: "claude", env: { ANTHROPIC_MODEL: "small" } });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "48000");
});

test("Claude 保存注入：没有窗口的模型不新增 env", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await patchProviderConfig(paseo, { provider: "claude", env: { ANTHROPIC_MODEL: "sonnet-x" } });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(result.applied.includes("env.CLAUDE_CODE_MAX_CONTEXT_TOKENS"), false);
});

test("写入口：插件不支持的客户端一律拒绝，不落一份没人读的配置", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await patchProviderConfig(paseo, {
    provider: "cursor",
    env: { OPENAI_BASE_URL: "https://cursor.example.test/v1" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.match(result.detail, /只支持 Claude \/ Codex/);
  assert.equal(paseo.patches.length, 0, "拒绝就是一笔都不写");
});

test("档案：改一个字段时，宿主原有的 icon / color / featureValues 一个都不能丢", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await saveProfile(paseo, {
    profile: { id: "daily", name: "日常", provider: "claude", model: "sonnet" },
  });
  assert.equal(result.ok, true);

  const stored = paseo.disk().agentProfiles[0];
  assert.equal(stored.model, "sonnet", "这次改的字段生效");
  assert.equal(stored.icon, "☀️");
  assert.equal(stored.color, "#ff0");
  assert.deepEqual(stored.featureValues, { fast: true });
});

test("档案：新增一条不会覆盖已有的那条", async () => {
  const paseo = fakePaseo(baseConfig());
  await saveProfile(paseo, { profile: { name: "重活", provider: "codex", model: "gpt-5" } });
  const stored = paseo.disk().agentProfiles;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].id, "daily");
  assert.equal(stored[1].name, "重活");
  assert.ok(stored[1].id, "新档案必须有 id");
});

test("档案：写后读回丢了条目就报错，不返回「成功」", async () => {
  // 宿主写进去但读不出来（比如形状又变了）：这正是会清空配置的那种情况。
  let current = baseConfig();
  const paseo = {
    config: {
      get: async () => ({ config: structuredClone(current) }),
      patch: async () => {
        current = { agentProfiles: [] }; // 写是「成功」的，但档案全没了
        return { config: structuredClone(current) };
      },
    },
  };
  const result = await saveProfile(paseo, { profile: { id: "daily", name: "日常", provider: "claude" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-failed");
  assert.match(result.detail, /读回少了这些档案：daily/);
});

test("档案：写后读不到配置时如实说「没法核对」，不把成功的写入报成失败", async () => {
  let calls = 0;
  const paseo = {
    config: {
      get: async () => {
        calls += 1;
        if (calls === 1) return { config: baseConfig() };
        throw new Error("读超时");
      },
      patch: async () => ({}),
    },
  };
  const result = await saveProfile(paseo, { profile: { id: "daily", name: "日常", provider: "claude", model: "sonnet" } });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((line) => line.includes("无法核对")), "要把「核对不了」说出来");
});

test("档案：删不存在的 id 报 not-found，且不改写任何东西", async () => {
  const paseo = fakePaseo(baseConfig());
  const result = await saveProfile(paseo, { removeId: "ghost" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-found");
  assert.equal(paseo.patches.length, 0);
});

test("注入 env：现有 env 是 null 或字符串时也拒绝，不把原值冲掉", async () => {
  for (const bad of [null, "ANTHROPIC_API_KEY=sk"]) {
    const paseo = fakePaseo({ providers: { claude: { env: bad } } });
    const result = await patchProviderConfig(paseo, { provider: "claude", env: { NEW_KEY: "1" } });
    assert.equal(result.ok, false, `env=${JSON.stringify(bad)} 应被拒`);
    assert.equal(result.reason, "config-failed");
    assert.equal(paseo.patches.length, 0);
  }
});

test("档案：成功删除一条，剩下的照旧，不误报「被整表替换」", async () => {
  const paseo = fakePaseo({
    agentProfiles: [
      { id: "daily", name: "日常", provider: "claude" },
      { id: "heavy", name: "重活", provider: "codex" },
    ],
  });
  const result = await saveProfile(paseo, { removeId: "daily" });
  assert.equal(result.ok, true);
  assert.deepEqual(
    paseo.disk().agentProfiles.map((item) => item.id),
    ["heavy"],
  );
  assert.deepEqual(result.profiles.map((item) => item.id), ["heavy"]);
});

test("档案：宿主带着一条畸形条目（缺 provider）时，保存正常进行且不误报丢档案", async () => {
  const paseo = fakePaseo({
    agentProfiles: [
      { id: "broken" }, // 宿主里就有的坏条目：会被 profilesOf 跳过
      { id: "daily", name: "日常", provider: "claude" },
    ],
  });
  const result = await saveProfile(paseo, { profile: { id: "daily", name: "日常", provider: "claude", model: "sonnet" } });
  assert.equal(result.ok, true, "条数会变（2 → 读回 1 条可用），不能因此报错");
  assert.deepEqual(result.profiles.map((item) => item.id), ["daily"]);
});

/* --------------------------- Codex 启用过站点之后：写哪儿、读哪儿 */

const codexSiteConfig = () => ({
  providers: {
    codex: { label: "Codex", models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }] },
    "deck-codex": {
      extends: "codex",
      label: "Deck Codex",
      enabled: true,
      models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
      env: { OPENAI_BASE_URL: "https://api.example.test/v1", OPENAI_API_KEY: "cred-old" },
    },
  },
});

test("重新保存 Codex 卡片：清掉内建与派生两条删除记录，保留其它客户端的记录", async () => {
  for (const id of ["codex", "deck-codex", "claude"]) assert.deepEqual(markProviderEntryDeleted(id), { ok: true });
  const paseo = fakePaseo(codexSiteConfig());
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_API_KEY: "cred-new" } });
  assert.equal(result.ok, true);
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["claude"] });
});

for (const [scenario, options, input] of [
  ["宿主拒绝补丁", { patchError: true }, { env: { OPENAI_API_KEY: "cred-new" } }],
  ["写后读回失败", { readBackError: true }, { env: { OPENAI_API_KEY: "cred-new" } }],
  ["宿主忽略 env", { ignorePatch: true }, { env: { OPENAI_API_KEY: "cred-new" } }],
  ["宿主没存显示名", { ignorePatch: true }, { label: "主力 Codex" }],
  ["宿主忽略停用", { ignorePatch: true }, { enabled: false }],
  ["宿主漏写模型", { ignorePatch: true }, { models: ["gpt-new"] }],
  ["宿主丢掉写入条目", { afterPatch: (config) => { delete config.providers["deck-codex"]; } }, { env: { OPENAI_API_KEY: "cred-new" } }],
  ["宿主丢掉镜像模型", { afterPatch: (config) => { config.providers.codex.models = []; } }, { models: ["gpt-new"] }],
  ["宿主残留取消的模型", { afterPatch: (config) => { config.providers["deck-codex"].models.push({ id: "gpt-stale", label: "stale" }); } }, { models: ["gpt-new"] }],
]) {
  test(`重新保存 Codex 卡片：${scenario}时保留已有删除记录`, async () => {
    for (const id of ["codex", "deck-codex", "claude"]) assert.deepEqual(markProviderEntryDeleted(id), { ok: true });
    const paseo = fakePaseo(codexSiteConfig(), options);
    const result = await patchProviderConfig(paseo, { provider: "codex", ...input });
    assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex", "deck-codex", "claude"] });
    if (result.ok) assert.match(result.warnings.join("\n"), /删除记录.*保留|保留.*删除记录/);
  });
}

test("重新保存 Codex 卡片：恢复校验覆盖创建派生条目时隐式继承的模型", async () => {
  for (const id of ["codex", "deck-codex", "claude"]) assert.deepEqual(markProviderEntryDeleted(id), { ok: true });
  const paseo = fakePaseo({
    providers: { codex: { models: [{ id: "gpt-inherited", label: "Inherited", isDefault: true }] } },
  }, {
    afterPatch: (config) => { config.providers["deck-codex"].models = []; },
  });
  const result = await patchProviderConfig(paseo, {
    provider: "codex",
    env: { OPENAI_BASE_URL: "https://api.example.test/v1" },
  });
  assert.equal(paseo.disk().providers["deck-codex"].env.OPENAI_BASE_URL, "https://api.example.test/v1");
  assert.deepEqual(paseo.disk().providers["deck-codex"].models, [], "只丢了隐式继承的模型，地址已经落地");
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex", "deck-codex", "claude"] });
  if (result.ok) assert.match(result.warnings.join("\n"), /删除记录.*保留|保留.*删除记录/);
});

test("重新保存 Codex 卡片：恢复校验覆盖补丁中一并保留的 env 键", async () => {
  for (const id of ["codex", "deck-codex", "claude"]) assert.deepEqual(markProviderEntryDeleted(id), { ok: true });
  const config = codexSiteConfig();
  config.providers["deck-codex"].env.EXTRA_FLAG = "keep";
  const paseo = fakePaseo(config, {
    afterPatch: (stored) => { delete stored.providers["deck-codex"].env.EXTRA_FLAG; },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_API_KEY: "cred-new" } });
  assert.equal(paseo.patches[0].providers["deck-codex"].env.EXTRA_FLAG, "keep");
  assert.equal(paseo.disk().providers["deck-codex"].env.OPENAI_API_KEY, "cred-new", "显式提交的键已落地");
  assert.equal(paseo.disk().providers["deck-codex"].env.EXTRA_FLAG, undefined);
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex", "deck-codex", "claude"] });
  if (result.ok) assert.match(result.warnings.join("\n"), /删除记录.*保留|保留.*删除记录/);
});

test("重新保存 Codex 卡片：删除记录读不出时保留配置写入并反馈警告", async () => {
  setTombstoneStatePathForTest(tombstoneDir);
  const paseo = fakePaseo(codexSiteConfig());
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_API_KEY: "cred-new" } });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers["deck-codex"].env.OPENAI_API_KEY, "cred-new");
  const warning = result.warnings.filter((line) => line.includes("删除记录")).join("\n");
  assert.match(warning, /codex/);
  assert.match(warning, /deck-codex/);
  assert.match(warning, /失败|未能|无法/);
});

test("Codex 站点生效后注入 env：落到派生条目上，内建条目一个字不动", async () => {
  const paseo = fakePaseo(codexSiteConfig());
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_API_KEY: "cred-new" } });
  assert.equal(result.ok, true);
  // 地址必须一起带上：宿主落盘时 env 是整块替换，少带就等于把地址删了。
  assert.deepEqual(paseo.disk().providers["deck-codex"].env, {
    OPENAI_BASE_URL: "https://api.example.test/v1",
    OPENAI_API_KEY: "cred-new",
  });
  assert.equal(paseo.disk().providers.codex.env, undefined, "写到内建 codex 上等于改了个不生效的地方");
  assert.deepEqual(result.warnings.filter((line) => line.includes("读回不一致")), []);
});

test("Codex 站点生效后改名：显示名写回 codex 自己那条，派生条目上的 label 不顶用", async () => {
  const paseo = fakePaseo(codexSiteConfig());
  const result = await patchProviderConfig(paseo, { provider: "codex", label: "主力 Codex" });
  assert.equal(result.ok, true);
  // 面板卡片的名字取自宿主快照里 `codex` 那条的 label：写错地方就是「改了没反应」。
  assert.equal(paseo.disk().providers.codex.label, "主力 Codex");
  assert.equal(paseo.disk().providers["deck-codex"].label, "Deck Codex", "派生条目的 label 是插件自己的标识");
  assert.deepEqual(result.warnings.filter((line) => line.includes("显示名")), []);
});

test("Codex 站点生效后改名 + 改 env：一次补丁分落两条，互不覆盖", async () => {
  const paseo = fakePaseo(codexSiteConfig());
  await patchProviderConfig(paseo, {
    provider: "codex",
    label: "主力 Codex",
    env: { OPENAI_API_KEY: "cred-new" },
  });
  assert.equal(paseo.disk().providers.codex.label, "主力 Codex");
  assert.equal(paseo.disk().providers["deck-codex"].env.OPENAI_API_KEY, "cred-new");
  assert.equal(paseo.disk().providers["deck-codex"].label, "Deck Codex");
});

test("Codex 站点生效后改名：宿主没把名字写进去时如实报读回不一致", async () => {
  const stored = codexSiteConfig();
  const paseo = {
    config: {
      // 补丁被收下，但 label 没留下来（宿主不认时的样子）。
      get: async () => ({ config: structuredClone(stored) }),
      patch: async () => ({ config: structuredClone(stored) }),
    },
  };
  const result = await patchProviderConfig(paseo, { provider: "codex", label: "主力 Codex" });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /显示名没有写进去/);
});

test("Codex 还没建派生条目：第一次注入 env 就把它建出来，并把内建条目的模型清单搬过去", async () => {
  const paseo = fakePaseo({
    providers: { codex: { models: [{ id: "gpt-5-codex", label: "GPT-5 Codex", isDefault: true }] } },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } });
  assert.equal(result.ok, true);
  assert.deepEqual(paseo.disk().providers["deck-codex"], {
    // `extends` / `label` 缺一样宿主都不认，所以建条目时一起写上；
    // `enabled` 也一样——建出来却停用着，等于用户填了地址又不生效。
    extends: "codex",
    label: "Deck Codex",
    enabled: true,
    models: [{ id: "gpt-5-codex", label: "GPT-5 Codex", isDefault: true }],
    env: { OPENAI_BASE_URL: "https://api.example.test/v1" },
  });
  assert.deepEqual(paseo.disk().providers.codex, {
    models: [{ id: "gpt-5-codex", label: "GPT-5 Codex", isDefault: true }],
  }, "内建条目一个字都不动");
});

test("Codex 先存凭证、后存地址：凭证要跟着搬进派生条目，别让它留在没人读的条目上", async () => {
  const paseo = fakePaseo({ providers: { codex: {} } });
  const first = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_API_KEY: "cred-x" } });
  assert.equal(first.ok, true);
  assert.deepEqual(paseo.disk().providers.codex.env, { OPENAI_API_KEY: "cred-x" }, "还没地址时凭证先落在内建条目上");

  const second = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } });
  assert.equal(second.ok, true);
  const derived = paseo.disk().providers["deck-codex"];
  assert.equal(derived.env.OPENAI_API_KEY, "cred-x", "先前那把凭证要跟过来，否则卡片上「凭据」会显示没配");
  assert.equal(derived.env.OPENAI_BASE_URL, "https://api.example.test/v1");
  assert.deepEqual(
    Object.keys(derived.env).sort(),
    ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    "只带适配器真读的那两个键，别把内建条目上的其它键也抄过来",
  );
});

test("Codex 换地址：内建条目上那条旧地址不会被抄进派生条目", async () => {
  const paseo = fakePaseo({
    providers: { codex: { env: { OPENAI_BASE_URL: "https://old.example.test/v1", OPENAI_API_KEY: "cred-x", SUB2API_API_KEY: "cred-y" } } },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_BASE_URL: "https://new.example.test/v1" } });
  assert.equal(result.ok, true);
  const derived = paseo.disk().providers["deck-codex"];
  assert.equal(derived.env.OPENAI_BASE_URL, "https://new.example.test/v1", "地址用这次写的");
  assert.equal(derived.env.OPENAI_API_KEY, "cred-x", "凭证照搬");
  assert.equal(derived.env.SUB2API_API_KEY, undefined, "别的键名不跟着搬：适配器不读它们，卡片上只会多一行看不懂的");
});

test("Codex 还没建派生条目：只改模型清单时不建条目，清单落回客户端自己的那一行", async () => {
  const paseo = fakePaseo({
    providers: { codex: { models: [{ id: "gpt-a", label: "GPT A", isDefault: true }, { id: "gpt-b", label: "GPT B" }] } },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", models: ["gpt-a"] });
  assert.equal(result.ok, true);
  const codex = paseo.disk().providers.codex;
  assert.deepEqual(codex.models, [{ id: "gpt-a", label: "GPT A", isDefault: true }], "保留宿主自己的字段");
  assert.equal(codex.additionalModels, undefined, "不能顺手往另一把键上写");
  assert.ok(!result.warnings.some((line) => line.includes("内置模型删不掉")), "替换模式不该报追加模式的限制");
  // 没有地址的派生条目是条死条目：它会让之后每张 Codex 会话都被钩子拦下。
  assert.equal(paseo.disk().providers["deck-codex"], undefined, "没配地址就不该建派生条目");
});

test("Codex 还没建派生条目：只改凭证也不建条目（凭证先落在内建条目上，启用站点时会沿用）", async () => {
  const paseo = fakePaseo({ providers: { codex: { models: [{ id: "gpt-a", label: "GPT A" }] } } });
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_API_KEY: "cred-x" } });
  assert.equal(result.ok, true);
  assert.deepEqual(paseo.disk().providers.codex.env, { OPENAI_API_KEY: "cred-x" });
  assert.equal(paseo.disk().providers["deck-codex"], undefined);
});

test("Codex 还没建派生条目：改完模型之后普通 Codex 会话仍然建得出来", async () => {
  const paseo = fakePaseo({
    providers: { codex: { models: [{ id: "gpt-a", label: "GPT A" }] } },
  });
  await patchProviderConfig(paseo, { provider: "codex", models: ["gpt-a"] });
  // 把落盘后的配置喂给创建钩子里的路由：没有任何站点，就该原样放行。
  const out = routeCodexSiteProvider(
    { config: { provider: "codex/gpt-a", cwd: "/work/deck" } },
    paseo.disk().providers,
  );
  assert.equal(out.config.provider, "codex/gpt-a");
});

test("Codex 只改显示名：不改派生条目，也不谎报「配置没落地」", async () => {
  const paseo = fakePaseo({ providers: { codex: { models: [{ id: "gpt-a", label: "GPT A" }] } } });
  const result = await patchProviderConfig(paseo, { provider: "codex", label: "主力 Codex" });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers.codex.label, "主力 Codex");
  assert.equal(paseo.disk().providers["deck-codex"], undefined, "没写 env / 模型就不该顺手建条目");
  assert.deepEqual(result.warnings.filter((line) => line.includes("读回看不到")), []);
});

test("Codex 只认 OPENAI_BASE_URL：别的名字写进来直接拒绝，不静默无效", async () => {
  const paseo = fakePaseo({ providers: { codex: {} } });
  for (const key of ["openai_base_url", "SUB2API_BASE_URL"]) {
    const result = await patchProviderConfig(paseo, { provider: "codex", env: { [key]: "https://a.test/v1" } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid");
    assert.match(result.detail, /只认 OPENAI_BASE_URL/);
  }
  assert.equal(paseo.patches.length, 0, "被拒的请求一次都没写宿主");
});

test("Codex 有派生残条目（没地址）时改模型：写回内建条目，不改那条不生效的", async () => {
  const paseo = fakePaseo({
    providers: {
      codex: { models: [{ id: "gpt-a", label: "GPT A" }, { id: "gpt-b", label: "GPT B" }] },
      // 旧版本残留 / 手改过的形状：继承 codex 但没地址，等于没生效。
      "deck-codex": { extends: "codex", label: "Deck Codex" },
    },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", models: ["gpt-a"] });
  assert.equal(result.ok, true);
  assert.deepEqual(paseo.disk().providers.codex.models, [{ id: "gpt-a", label: "GPT A" }], "写进真正生效的那条");
  assert.deepEqual(paseo.disk().providers["deck-codex"], { extends: "codex", label: "Deck Codex" }, "残条目一个字不动");
});

test("Codex 站点生效时改模型：同一份清单照写到内建条目，换个窗口看到的模型一样", async () => {
  // 宿主的模型选择器是按 provider 条目各显示一份的：卡片上「Codex」那行读内建条目。
  // 只写派生条目，就会出现「这里看得到 gpt-6、换个项目的新窗口就没了」。
  const paseo = fakePaseo(codexSiteConfig());
  const result = await patchProviderConfig(paseo, { provider: "codex", models: ["gpt-5-codex", "auto/gpt-6-astra"] });
  assert.equal(result.ok, true);
  const expected = [
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
    { id: "auto/gpt-6-astra", label: "auto/gpt-6-astra" },
  ];
  assert.deepEqual(paseo.disk().providers["deck-codex"].models, expected, "真正生效的那条");
  assert.deepEqual(paseo.disk().providers.codex.models, expected, "选择器里「Codex」那行读的这条也要一致");
  assert.deepEqual(result.warnings.filter((line) => line.includes("没写进")), []);
});

test("别家客户端带着 OPENAI_BASE_URL 过来：不顺手替它开开关，也不报 Codex 的失败", async () => {
  // `addsAddress` 看的是 env 里有没有 `OPENAI_BASE_URL`，但那只对 Codex 有意义：
  // Claude 带着这个键名过来时，不能把它当成「配了 Codex 站点」。
  const paseo = fakePaseo({ providers: { claude: { env: { ANTHROPIC_BASE_URL: "https://a.test" } } } });
  const result = await patchProviderConfig(paseo, { provider: "claude", env: { OPENAI_BASE_URL: "https://x.test" } });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers.claude.enabled, undefined, "没有替它拨开关");
  assert.deepEqual(result.warnings.filter((line) => line.includes("deck-codex")), []);
});

test("Codex 站点生效时改模型：内建条目用 additionalModels 时照写到它自己那把键上，不删用户自己加的", async () => {
  // `models` 与 `additionalModels` 语义不同（替换内置 / 追加）：搬到另一把上等于写了个不生效的地方。
  // `gpt-x` 是用户自己在 Paseo 设置里给「Codex」那行加的，面板上根本看不见，不能顺手删掉。
  const config = codexSiteConfig();
  config.providers.codex = { label: "Codex", additionalModels: [{ id: "gpt-x", label: "GPT X" }] };
  const paseo = fakePaseo(config);
  const result = await patchProviderConfig(paseo, { provider: "codex", models: ["gpt-5-codex"] });
  assert.equal(result.ok, true);
  assert.deepEqual(paseo.disk().providers.codex.additionalModels, [
    { id: "gpt-x", label: "GPT X" },
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
  ]);
  assert.equal(paseo.disk().providers.codex.models, undefined, "别往另一把键上乱写");
  assert.deepEqual(paseo.disk().providers["deck-codex"].models, [{ id: "gpt-5-codex", label: "GPT-5 Codex" }]);
});

test("Codex 站点生效时取消勾选模型：内建那行跟着删，用户自己加的仍保留", async () => {
  // 面板读的是派生条目：用户在面板里取消的模型（`auto/gpt-6-astra`）是插件自己照写过去的，
  // 该从内建那行一起消失；`gpt-x` 不在派生条目上，是用户自己在 Paseo 设置里加的，留着。
  const config = codexSiteConfig();
  config.providers.codex.models = [
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
    { id: "auto/gpt-6-astra", label: "auto/gpt-6-astra" },
    { id: "gpt-x", label: "GPT X" },
  ];
  config.providers["deck-codex"].models = [
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
    { id: "auto/gpt-6-astra", label: "auto/gpt-6-astra" },
  ];
  const paseo = fakePaseo(config);
  const result = await patchProviderConfig(paseo, { provider: "codex", models: ["gpt-5-codex"] });
  assert.equal(result.ok, true);
  assert.deepEqual(
    paseo.disk().providers.codex.models.map((item) => item.id),
    ["gpt-5-codex", "gpt-x"],
    "取消的模型两行都消失，用户自己加的留着",
  );
});

test("Codex 站点生效时改模型：内建条目没写进去时给一句读回警告", async () => {
  const live = codexSiteConfig();
  const paseo = {
    config: {
      get: async () => ({ config: structuredClone(live) }),
      // 宿主只收下了派生条目那份，内建条目的写入被丢掉。
      patch: async (input) => {
        const next = input.providers?.["deck-codex"]?.models;
        if (next) live.providers["deck-codex"].models = structuredClone(next);
        return { ok: true };
      },
    },
  };
  const result = await patchProviderConfig(paseo, { provider: "codex", models: ["gpt-5-codex", "auto/gpt-6-astra"] });
  assert.equal(result.ok, true);
  assert.ok(
    result.warnings.some((line) => line.includes("没写进 codex 那一条")),
    `要提示选择器可能还是旧清单，实际警告：${result.warnings.join(" / ")}`,
  );
});

test("Codex 保存地址、宿主却没收下派生条目：报失败，不报「保存成功」", async () => {
  // 宿主收下补丁但没落到派生条目上（比如不认识这个 provider）：写盘说成功、建会话照样被拦，
  // 这种假成功必须当场说破，否则用户在「保存成功」和「建不了会话」之间来回打转。
  const paseo = {
    config: {
      get: async () => ({ config: { providers: { codex: {} } } }),
      patch: async () => ({ ok: true }),
    },
  };
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-failed");
  assert.match(result.detail, /没把 deck-codex 存成能用的形状/);
});

test("Codex 清空地址：写进去就算数，不拿「派生条目不可用」报失败", async () => {
  const paseo = fakePaseo({
    providers: { "deck-codex": { extends: "codex", label: "Deck Codex", enabled: true, env: { OPENAI_BASE_URL: "https://api.example.test/v1" } } },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_BASE_URL: "" } });
  assert.equal(result.ok, true, "清空是有意的动作，读回不可用是意料之中");
  assert.equal(paseo.disk().providers["deck-codex"].env.OPENAI_BASE_URL, "");
});

test("Codex 显式停用派生条目：别被「存地址就顺手启用」盖掉", async () => {
  const paseo = fakePaseo({
    providers: { "deck-codex": { extends: "codex", label: "Deck Codex", enabled: true, env: { OPENAI_BASE_URL: "https://old.example.test/v1" } } },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", enabled: false });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers["deck-codex"].enabled, false, "用户明确要关掉它");
});

test("Codex 有派生残条目（没继承 codex、还停用着）时补地址：顺手把它修成可用的形状", async () => {
  const paseo = fakePaseo({
    providers: {
      codex: { models: [{ id: "gpt-a", label: "GPT A" }] },
      "deck-codex": { label: "Deck Codex", enabled: false },
    },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } });
  assert.equal(result.ok, true);
  assert.deepEqual(paseo.disk().providers["deck-codex"], {
    extends: "codex",
    label: "Deck Codex",
    // 用户在这条上存了地址，就是要它生效：残条目的 `enabled: false` 不能跟着留下来，
    // 否则又是「填了地址却不生效」。调用方明确传 `enabled: false` 时才尊重停用。
    enabled: true,
    models: [{ id: "gpt-a", label: "GPT A" }],
    env: { OPENAI_BASE_URL: "https://api.example.test/v1" },
  });
});

/* ------------------------------------------------ 模型窗口 → Codex 模型目录 */

/** 目录读写的假实现：只记下「写了什么、写到哪」，不碰真实 codex 与文件系统。 */
function fakeCatalogDeps() {
  const written = [];
  return {
    written,
    deps: {
      readBundled: async () => ({
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6-Astra",
            context_window: 272000,
            max_context_window: 872000,
            effective_context_window_percent: 95,
            base_instructions: "你是编码 agent",
          },
        ],
      }),
      writeFile: async (target, content) => {
        written.push({ target, content });
      },
      catalogPath: () => "/tmp/codex-home/deck-model-catalog.json",
    },
  };
}

test("Codex 保存模型：接口报的窗口写进模型目录，并把目录指给派生条目", async () => {
  const paseo = fakePaseo(codexSiteConfig());
  const { written, deps } = fakeCatalogDeps();
  const result = await patchProviderConfig(
    paseo,
    {
      provider: "codex",
      models: ["group/site8083"],
      modelDefinitions: [{ id: "group/site8083", label: "codex-gpt模型", contextWindowMaxTokens: 128000 }],
    },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(written.length, 1, "接口报过窗口，就该写一次目录文件");
  const entry = JSON.parse(written[0].content).models.find((item) => item.slug === "group/site8083");
  assert.equal(entry.context_window, 128000, "会话的窗口要按接口走，不是 Codex 的默认 258k");
  // 宿主对 Codex 的 `options` 是 strict 校验（多一把键就抛错、会话建不起来），
  // 所以目录只能走启动命令：把 `-c model_catalog_json=…` 接在派生条目的 command 上。
  assert.deepEqual(
    paseo.disk().providers["deck-codex"].command,
    ["codex", "-c", 'model_catalog_json="/tmp/codex-home/deck-model-catalog.json"'],
    "目录路径要落到真正生效的派生条目的启动命令上",
  );
  assert.ok(result.applied.includes("command"));
});

test("重新保存 Codex 卡片：恢复校验覆盖被宿主吞掉的模型目录 command", async (t) => {
  for (const id of ["codex", "deck-codex", "claude"]) assert.deepEqual(markProviderEntryDeleted(id), { ok: true });
  const dir = await windowWorkspace(t);
  const paseo = fakePaseo(codexSiteConfig(), {
    afterPatch: (config) => { delete config.providers["deck-codex"].command; },
  });
  const { written, deps } = fakeCatalogDeps();
  const result = await patchProviderConfig(paseo, {
    provider: "codex",
    workspaceDir: dir,
    models: ["group/site8083"],
    modelDefinitions: [{ id: "group/site8083", label: "Site model", contextWindowMaxTokens: 128000 }],
  }, { ...deps, catalogPath: () => join(dir, "deck-model-catalog.json") });
  assert.equal(written.length, 1, "目录已生成，只是宿主没保存启动命令");
  assert.equal(JSON.parse(written[0].content).models.find((model) => model.slug === "group/site8083").context_window, 128000);
  assert.deepEqual(paseo.disk().providers["deck-codex"].models.map((model) => model.id), ["group/site8083"]);
  assert.equal(paseo.disk().providers["deck-codex"].command, undefined);
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex", "deck-codex", "claude"] });
  if (result.ok) assert.match(result.warnings.join("\n"), /删除记录.*保留|保留.*删除记录/);
});

test("重新保存 Codex 卡片：恢复校验覆盖裁掉接口窗口且保留其它模型字段的宿主", async (t) => {
  for (const id of ["codex", "deck-codex", "claude"]) assert.deepEqual(markProviderEntryDeleted(id), { ok: true });
  const dir = await windowWorkspace(t);
  const config = codexSiteConfig();
  config.providers["deck-codex"].models = [{
    id: "group/site8083",
    label: "Site model",
    description: "Proxy model",
    isDefault: true,
    thinkingOptions: [{ id: "high", label: "High", description: "More reasoning", isDefault: true }],
    defaultThinkingOptionId: "high",
    contextWindowMaxTokens: 128000,
  }];
  const paseo = fakePaseo(config, {
    afterPatch: (stored) => {
      for (const id of ["codex", "deck-codex"]) {
        for (const model of stored.providers[id].models) {
          delete model.contextWindowMaxTokens;
          delete model.defaultThinkingOptionId;
        }
      }
    },
  });
  const { written, deps } = fakeCatalogDeps();
  const result = await patchProviderConfig(paseo, {
    provider: "codex",
    workspaceDir: dir,
    models: ["group/site8083"],
  }, { ...deps, catalogPath: () => join(dir, "deck-model-catalog.json") });
  assert.deepEqual(paseo.disk().providers["deck-codex"].models, [{
    id: "group/site8083",
    label: "Site model",
    description: "Proxy model",
    isDefault: true,
    thinkingOptions: [{ id: "high", label: "High", description: "More reasoning", isDefault: true }],
  }]);
  assert.deepEqual(paseo.disk().providers.codex.models.map((model) => model.id), ["gpt-5-codex", "group/site8083"]);
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0].content).models.find((model) => model.slug === "group/site8083").context_window, 128000);
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["claude"] });
  assert.ok(result.ok);
});

test("Codex 保存模型：接口没报窗口时不写目录、也不动启动命令（不指一个不存在的文件）", async () => {
  const paseo = fakePaseo(codexSiteConfig());
  const { written, deps } = fakeCatalogDeps();
  const result = await patchProviderConfig(
    paseo,
    { provider: "codex", models: ["gpt-5-codex"] },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(written.length, 0);
  assert.equal(paseo.disk().providers["deck-codex"].command, undefined);
  assert.deepEqual(result.warnings.filter((line) => line.includes("模型目录")), []);
});

test("Codex 保存模型：目录没写成只告警，不把整笔保存判失败", async () => {
  const paseo = fakePaseo(codexSiteConfig());
  const result = await patchProviderConfig(
    paseo,
    {
      provider: "codex",
      models: ["group/site8083"],
      modelDefinitions: [{ id: "group/site8083", label: "组", contextWindowMaxTokens: 128000 }],
    },
    {
      readBundled: async () => {
        throw new Error("spawn codex ENOENT");
      },
    },
  );
  assert.equal(result.ok, true, "模型清单已经存好了，目录写不进不能整笔回滚");
  assert.equal(paseo.disk().providers["deck-codex"].command, undefined);
  assert.ok(
    result.warnings.some((line) => line.includes("Codex 模型目录没写成")),
    "要让用户知道这批模型仍然按默认窗口跑",
  );
});

test("Codex 保存模型：重复保存不会把 `-c` 越叠越多，用户原来的命令前缀保住", async () => {
  const base = codexSiteConfig();
  base.providers["deck-codex"].command = ["/usr/local/bin/codex", "--profile", "site"];
  const paseo = fakePaseo(base);
  const { deps } = fakeCatalogDeps();
  const save = () =>
    patchProviderConfig(
      paseo,
      {
        provider: "codex",
        models: ["group/site8083"],
        modelDefinitions: [{ id: "group/site8083", label: "组", contextWindowMaxTokens: 128000 }],
      },
      deps,
    );
  await save();
  await save();
  const command = paseo.disk().providers["deck-codex"].command;
  assert.deepEqual(command, [
    "/usr/local/bin/codex",
    "--profile",
    "site",
    "-c",
    'model_catalog_json="/tmp/codex-home/deck-model-catalog.json"',
  ]);
});

test("Codex 保存模型：地址还没配时，明确告诉用户窗口暂时用不上", async () => {
  const paseo = fakePaseo({ providers: { codex: { models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }] } } });
  const { deps } = fakeCatalogDeps();
  const result = await patchProviderConfig(
    paseo,
    {
      provider: "codex",
      models: ["group/site8083"],
      modelDefinitions: [{ id: "group/site8083", label: "组", contextWindowMaxTokens: 128000 }],
    },
    deps,
  );
  assert.equal(result.ok, true);
  assert.ok(
    result.warnings.some((line) => line.includes("还没配接入地址")),
    "没地址时清单落在内建那一行，得说明窗口暂时用不上",
  );
});

/* ------------------------- 宿主裁掉窗口之后：从工作区缓存补回来 */

async function windowWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "deck-window-write-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  return dir;
}

async function writeWindowCache(dir, provider, baseUrl, models) {
  await writeFile(
    join(dir, ".deck", "model-windows.json"),
    JSON.stringify({ version: 1, providers: { [provider]: { baseUrl, models } } }),
    "utf8",
  );
}

test("Codex 保存模型：宿主配置里没有窗口时，用工作区缓存重建目录（含原生模型）", async (t) => {
  const dir = await windowWorkspace(t);
  await writeWindowCache(dir, "codex", "https://api.example.test/v1", [
    { id: "group/site8083", contextWindowMaxTokens: 128000 },
    { id: "auto/gpt-6-astra", contextWindowMaxTokens: 128000 },
  ]);
  const paseo = fakePaseo(codexSiteConfig());
  const { written, deps } = fakeCatalogDeps();
  // 模拟「宿主保存过一次、窗口已被裁掉」：这次提交的模型定义只有 id / label。
  const result = await patchProviderConfig(
    paseo,
    {
      provider: "codex",
      workspaceDir: dir,
      models: ["group/site8083", "auto/gpt-6-astra"],
      modelDefinitions: [
        { id: "group/site8083", label: "codex-gpt模型" },
        { id: "auto/gpt-6-astra", label: "auto/gpt-6-astra" },
      ],
    },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(written.length, 1, "缓存里有窗口，就该写目录文件");
  const models = JSON.parse(written[0].content).models;
  assert.equal(models.find((item) => item.slug === "group/site8083")?.context_window, 128000);
  assert.equal(models.find((item) => item.slug === "auto/gpt-6-astra")?.context_window, 128000);
  assert.equal(
    models.find((item) => item.slug === "gpt-6-astra")?.context_window,
    272000,
    "Codex 原生模型照旧按它自己的窗口留在目录里",
  );
});

test("Codex 保存模型：缓存地址与当前接口不一致时不套旧窗口、不写目录", async (t) => {
  const dir = await windowWorkspace(t);
  await writeWindowCache(dir, "codex", "https://old.example.test/v1", [
    { id: "group/site8083", contextWindowMaxTokens: 128000 },
  ]);
  const paseo = fakePaseo(codexSiteConfig());
  const { written, deps } = fakeCatalogDeps();
  const result = await patchProviderConfig(
    paseo,
    {
      provider: "codex",
      workspaceDir: dir,
      models: ["group/site8083"],
      modelDefinitions: [{ id: "group/site8083", label: "codex-gpt模型" }],
    },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(written.length, 0, "换了接口就不能拿旧接口的上限去压缩");
  assert.equal(paseo.disk().providers["deck-codex"].command, undefined);
});

test("Codex 换接口：新地址没有窗口时摘掉旧目录，不让会话继续按旧上限压缩", async (t) => {
  const dir = await windowWorkspace(t);
  const config = codexSiteConfig();
  config.providers["deck-codex"].command = ["codex", "-c", 'model_catalog_json="/old-home/deck-model-catalog.json"'];
  const paseo = fakePaseo(config);
  const { written, deps } = fakeCatalogDeps();
  const result = await patchProviderConfig(
    paseo,
    {
      provider: "codex",
      workspaceDir: dir,
      env: { OPENAI_BASE_URL: "https://new.example.test/v1" },
    },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(written.length, 0, "没有窗口就不写新目录");
  assert.deepEqual(paseo.disk().providers["deck-codex"].command, ["codex"], "旧目录参数要摘掉");
  assert.ok(
    result.warnings.some((line) => line.includes("去掉上一接口的模型目录")),
    "摘掉旧目录要说明原因",
  );
});

test("Codex 换接口：目录这次没写成，旧目录照样要摘掉", async (t) => {
  // 只在「新地址没窗口」时摘，等于承认「写失败」时旧目录继续生效：
  // 新地址上的同名模型会按上一接口的上限压缩，告警却还写着「按内置默认窗口算」。
  const dir = await windowWorkspace(t);
  await writeWindowCache(dir, "codex", "https://new.example.test/v1", [
    { id: "group/site8083", contextWindowMaxTokens: 128000 },
  ]);
  const config = codexSiteConfig();
  config.providers["deck-codex"].command = ["codex", "-c", 'model_catalog_json="/old-home/deck-model-catalog.json"'];
  const paseo = fakePaseo(config);
  const result = await patchProviderConfig(
    paseo,
    {
      provider: "codex",
      workspaceDir: dir,
      env: { OPENAI_BASE_URL: "https://new.example.test/v1" },
      models: ["group/site8083"],
      modelDefinitions: [{ id: "group/site8083", label: "组" }],
    },
    {
      readBundled: async () => {
        throw new Error("spawn codex ENOENT");
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    paseo.disk().providers["deck-codex"].command,
    ["codex"],
    "新地址的目录没写成，上一接口的目录就不能继续挂在启动命令上",
  );
  assert.ok(result.warnings.some((line) => line.includes("去掉上一接口的模型目录")));
  assert.ok(result.warnings.some((line) => line.includes("Codex 模型目录没写成")));
  assert.equal(
    result.warnings.some((line) => line.includes("还没拿到模型窗口")),
    false,
    "缓存里明明有窗口，只是没写成：不能说成「新地址还没窗口」",
  );
});

test("Codex 换接口：新地址有缓存时按新窗口重建目录", async (t) => {
  const dir = await windowWorkspace(t);
  await writeWindowCache(dir, "codex", "https://new.example.test/v1", [
    { id: "gpt-5-codex", contextWindowMaxTokens: 128000 },
  ]);
  const config = codexSiteConfig();
  config.providers["deck-codex"].command = ["codex", "-c", 'model_catalog_json="/old-home/deck-model-catalog.json"'];
  const paseo = fakePaseo(config);
  const { written, deps } = fakeCatalogDeps();
  const result = await patchProviderConfig(
    paseo,
    {
      provider: "codex",
      workspaceDir: dir,
      env: { OPENAI_BASE_URL: "https://new.example.test/v1" },
    },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(written.length, 1);
  const entry = JSON.parse(written[0].content).models.find((model) => model.slug === "gpt-5-codex");
  assert.equal(entry.context_window, 128000);
});

test("Claude 保存注入：配置里没有窗口时，用工作区缓存同步当前模型窗口", async (t) => {
  const dir = await windowWorkspace(t);
  await writeWindowCache(dir, "claude", "https://api.example.test/v1", [
    { id: "current", contextWindowMaxTokens: 128000 },
  ]);
  const config = baseConfig();
  config.providers.claude.env.ANTHROPIC_BASE_URL = "https://api.example.test/v1";
  config.providers.claude.env.ANTHROPIC_MODEL = "current";
  config.providers.claude.additionalModels = [{ id: "current", label: "Current" }];
  const paseo = fakePaseo(config);
  const result = await patchProviderConfig(paseo, {
    provider: "claude",
    workspaceDir: dir,
    env: { EXISTING_FLAG: "2" },
  });
  assert.equal(result.ok, true);
  assert.equal(
    paseo.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    "128000",
    "宿主不返回窗口也要按接口那次数算",
  );
  assert.ok(result.applied.includes("env.CLAUDE_CODE_MAX_CONTEXT_TOKENS"));
});

/** 旧接口上拉到的模型定义，界面上点「保存模型」时会原样带回来。 */
function claudeSiteConfig() {
  return {
    providers: {
      claude: {
        env: {
          ANTHROPIC_BASE_URL: "https://old.example.test/v1",
          ANTHROPIC_AUTH_TOKEN: "tok",
          ANTHROPIC_MODEL: "current",
        },
        additionalModels: [{ id: "current", label: "Current" }],
      },
    },
  };
}

test("换接口的同一笔保存：旧接口带回来的窗口不跟过去，旧上限也一并去掉", async (t) => {
  const dir = await windowWorkspace(t);
  // 只有旧地址的缓存：它不该被拿来给新地址用。
  await writeWindowCache(dir, "claude", "https://old.example.test/v1", [
    { id: "current", contextWindowMaxTokens: 128000 },
  ]);
  const config = claudeSiteConfig();
  // 上一接口写下的上限还留在 env 里。
  config.providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "200000";
  const paseo = fakePaseo(config);
  const result = await patchProviderConfig(paseo, {
    provider: "claude",
    workspaceDir: dir,
    env: { ANTHROPIC_BASE_URL: "https://new.example.test/v1" },
    models: ["current"],
    modelDefinitions: [{ id: "current", label: "Current", contextWindowMaxTokens: 128000 }],
  });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers.claude.additionalModels[0].contextWindowMaxTokens, undefined);
  // 宿主落盘时 env 是整块替换：补丁里不带这个键，旧值才会被清掉。
  const envPatch = paseo.patches.at(-1).providers.claude.env;
  assert.equal(envPatch.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.ok(
    result.warnings.some((line) => line.includes("CLAUDE_CODE_MAX_CONTEXT_TOKENS")),
    "去掉旧上限要说一声，别让用户以为还按 200000 在跑",
  );
});

test("换接口的同一笔保存：新地址有缓存时用新缓存的窗口，不用旧接口那份", async (t) => {
  const dir = await windowWorkspace(t);
  await writeWindowCache(dir, "claude", "https://new.example.test/v1", [
    { id: "current", contextWindowMaxTokens: 96000 },
  ]);
  const paseo = fakePaseo(claudeSiteConfig());
  const result = await patchProviderConfig(paseo, {
    provider: "claude",
    workspaceDir: dir,
    env: { ANTHROPIC_BASE_URL: "https://new.example.test/v1" },
    models: ["current"],
    modelDefinitions: [{ id: "current", label: "Current", contextWindowMaxTokens: 128000 }],
  });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers.claude.additionalModels[0].contextWindowMaxTokens, 96000);
  assert.equal(paseo.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "96000");
});

test("这次拉到的窗口比缓存新：用本次定义，不让旧缓存盖回去", async (t) => {
  const dir = await windowWorkspace(t);
  // 上一次缓存写失败时，文件会停在旧值；这次接口已经报 64000 了。
  await writeWindowCache(dir, "claude", "https://old.example.test/v1", [
    { id: "current", contextWindowMaxTokens: 200000 },
  ]);
  const paseo = fakePaseo(claudeSiteConfig());
  const result = await patchProviderConfig(paseo, {
    provider: "claude",
    workspaceDir: dir,
    models: ["current"],
    modelDefinitions: [{ id: "current", label: "Current", contextWindowMaxTokens: 64000 }],
  });
  assert.equal(result.ok, true);
  assert.equal(paseo.disk().providers.claude.additionalModels[0].contextWindowMaxTokens, 64000);
  assert.equal(paseo.disk().providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "64000");
});

test("地址键不止一个时，按客户端真正读的那把判断换没换接口", async (t) => {
  const dir = await windowWorkspace(t);
  await writeWindowCache(dir, "claude", "https://old.example.test/v1", [
    { id: "current", contextWindowMaxTokens: 128000 },
  ]);
  const config = claudeSiteConfig();
  // 派生/历史配置里可能还有别的地址键，而且排在前面。
  config.providers.claude.env = {
    ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.test",
    ...config.providers.claude.env,
  };
  const paseo = fakePaseo(config);
  const result = await patchProviderConfig(paseo, {
    provider: "claude",
    workspaceDir: dir,
    env: { ANTHROPIC_BASE_URL: "https://new.example.test/v1" },
    models: ["current"],
    modelDefinitions: [{ id: "current", label: "Current", contextWindowMaxTokens: 128000 }],
  });
  assert.equal(result.ok, true);
  assert.equal(
    paseo.disk().providers.claude.additionalModels[0].contextWindowMaxTokens,
    undefined,
    "ANTHROPIC_BASE_URL 变了，旧接口的窗口不能跟过来",
  );
  assert.equal(paseo.patches.at(-1).providers.claude.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test("Claude 保存模型不会被当成 Codex：不出现 Codex 专属的告警", async () => {
  const paseo = fakePaseo(claudeSiteConfig());
  const result = await patchProviderConfig(paseo, {
    provider: "claude",
    models: ["current"],
    modelDefinitions: [{ id: "current", label: "Current", contextWindowMaxTokens: 128000 }],
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.warnings.some((line) => line.includes("Codex")),
    false,
  );
});
