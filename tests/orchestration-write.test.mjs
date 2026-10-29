import assert from "node:assert/strict";
import test from "node:test";
import { patchProviderConfig, saveProfile } from "../server/orchestration.ts";

/**
 * 改宿主配置的两个写口：注入配置与客户端档案。
 *
 * 这里每一条都在钉同一个教训——宿主对数组是**整表替换**、对 env 落盘时整块替换：
 * 少带一样东西，就是一次不可逆的删除。所以断言一律是「原来的还在」，不只是「新的进去了」。
 */

/** 内存里存一份「线上形状」的配置；`get` 返回深拷贝，`patch` 按宿主的行为深合并。 */
function fakePaseo(initial) {
  let current = structuredClone(initial);
  const patches = [];
  return {
    patches,
    get config() {
      return {
        get: async () => ({ config: structuredClone(current) }),
        patch: async (patch) => {
          patches.push(structuredClone(patch));
          current = merge(current, patch);
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
  const paseo = fakePaseo({
    providers: {
      codex: { models: [{ id: "gpt-a", label: "GPT A", isDefault: true }, { id: "gpt-b", label: "GPT B" }] },
    },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", models: ["gpt-a"] });
  assert.equal(result.ok, true);
  const disk = paseo.disk().providers.codex;
  assert.deepEqual(disk.models, [{ id: "gpt-a", label: "GPT A", isDefault: true }], "保留宿主自己的字段");
  assert.equal(disk.additionalModels, undefined, "不能顺手往另一把键上写");
  assert.ok(!result.warnings.some((line) => line.includes("内置模型删不掉")), "替换模式不该报追加模式的限制");
});

test("模型清单：替换模式下清空要拒绝，否则这个客户端一个模型都不剩", async () => {
  const paseo = fakePaseo({
    providers: { codex: { models: [{ id: "gpt-a", label: "GPT A" }] } },
  });
  const result = await patchProviderConfig(paseo, { provider: "codex", models: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(paseo.patches.length, 0);
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
