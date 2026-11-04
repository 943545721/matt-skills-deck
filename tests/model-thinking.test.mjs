import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_MODEL_THINKING,
  normalizeModelThinking,
  normalizeOrchestration,
  planDispatch,
  resolveRouteTarget,
  resolveThinkingOptionId,
  withResolvedThinking,
} from "../shared/orchestration.ts";
import { orchestrationSettingsSchema } from "../shared/orchestration-rpc.ts";
import { orchestrationSaveHandler } from "../server/rpc/orchestration.ts";
import { configuredModelsByProvider } from "../server/provider-entry.ts";
import { orchestrationFileOf, readOrchestration } from "../server/orchestration-store.ts";

/**
 * 客户端卡片上「每个模型带自己的思考档位」的合成口径。
 *
 * 三条分支一条都不能错，错了不会报错，只会悄悄换一个模型档位跑：
 * 1. 档案 / 路由里显式写了档位 → 用它；
 * 2. 没写 → 用卡片上同 provider + model 的默认档；
 * 3. 都没有 → 不传，由宿主用模型自己的默认。
 *
 * 另一条是「默认表与模型清单脱钩」：模型被删掉后，残留的默认档不许再传出去。
 */

const defaults = [
  { provider: "claude", model: "sonnet", thinkingOptionId: "high" },
  { provider: "codex", model: "gpt-5", thinkingOptionId: "xhigh" },
];

test("默认档表：显式档位优先，默认表不覆盖它", () => {
  const explicit = { provider: "claude", model: "sonnet", thinkingOptionId: "low" };
  assert.equal(resolveThinkingOptionId(explicit, { modelThinking: defaults }), "low");
});

test("默认档表：没有显式档位时用同 provider + model 的默认档", () => {
  assert.equal(
    resolveThinkingOptionId({ provider: "claude", model: "sonnet" }, { modelThinking: defaults }),
    "high",
  );
  assert.equal(
    resolveThinkingOptionId({ provider: "codex", model: "gpt-5" }, { modelThinking: defaults }),
    "xhigh",
  );
});

test("默认档表：模型 / 客户端对不上、没选模型、空表都不传档位", () => {
  for (const target of [
    { provider: "claude", model: "opus" },
    { provider: "codex", model: "sonnet" },
    { provider: "claude" },
    { provider: "claude", model: "   " },
  ]) {
    assert.equal(
      resolveThinkingOptionId(target, { modelThinking: defaults }),
      undefined,
      `${JSON.stringify(target)} 不该拿到档位`,
    );
  }
  assert.equal(resolveThinkingOptionId({ provider: "claude", model: "sonnet" }), undefined);
  assert.equal(
    resolveThinkingOptionId({ provider: "claude", model: "sonnet" }, { modelThinking: [] }),
    undefined,
    "清掉默认档后立刻回到「不传」",
  );
});

test("默认档表：模型被从清单里删掉后，残留条目不再往外传", () => {
  const context = { modelThinking: defaults, modelsByProvider: { claude: ["sonnet", "haiku"] } };
  assert.equal(resolveThinkingOptionId({ provider: "claude", model: "sonnet" }, context), "high");

  const removed = { modelThinking: defaults, modelsByProvider: { claude: ["haiku"] } };
  assert.equal(
    resolveThinkingOptionId({ provider: "claude", model: "sonnet" }, removed),
    undefined,
    "模型已经不在清单里，默认档不许继续生效",
  );
  // 清单里没有这个客户端 = 不判（宿主内置模型的情形），默认档照旧。
  const unknown = { modelThinking: defaults, modelsByProvider: { codex: ["gpt-5"] } };
  assert.equal(resolveThinkingOptionId({ provider: "claude", model: "sonnet" }, unknown), "high");

  // 清单被清空（模型全删了）也是「表过态」：空数组不等于「不判」。
  const emptied = { modelThinking: defaults, modelsByProvider: { claude: [] } };
  assert.equal(
    resolveThinkingOptionId({ provider: "claude", model: "sonnet" }, emptied),
    undefined,
    "清单清空后残留条目一律失效",
  );
});

test("默认档表：认不出的档位 id 原样透传，由宿主去判", () => {
  // 与 #29 的口径一致：插件不维护档位 id 白名单，宿主换了一组 id 时
  // 我们不该把它当成「没配」而悄悄丢掉。
  assert.equal(
    resolveThinkingOptionId({ provider: "claude", model: "sonnet", thinkingOptionId: "future-tier" }, {}),
    "future-tier",
  );
  assert.equal(
    resolveThinkingOptionId(
      { provider: "claude", model: "sonnet" },
      { modelThinking: [{ provider: "claude", model: "sonnet", thinkingOptionId: "future-tier" }] },
    ),
    "future-tier",
  );
});

test("合进目标：返回新对象，不改入参；没档位就不留字段", () => {
  const target = { provider: "claude", model: "sonnet" };
  const next = withResolvedThinking(target, { modelThinking: defaults });
  assert.deepEqual(next, { provider: "claude", model: "sonnet", thinkingOptionId: "high" });
  assert.equal("thinkingOptionId" in target, false, "传入的 target 不能被原地改掉");

  const bare = withResolvedThinking({ provider: "claude", model: "sonnet" }, {});
  assert.deepEqual(bare, { provider: "claude", model: "sonnet" });
  assert.equal(
    withResolvedThinking({ ...target, thinkingOptionId: "low" }, {}).thinkingOptionId,
    "low",
    "没有默认表时，显式档位原样保留",
  );
});

test("路由解析：档案与直选目标都按同一处规则合成档位", () => {
  const profiles = [{ id: "daily", name: "日常", provider: "claude", model: "sonnet" }];

  const viaProfile = resolveRouteTarget({ difficulty: "normal", profileId: "daily" }, profiles, {
    modelThinking: defaults,
  });
  assert.equal(viaProfile.ok, true);
  assert.deepEqual(viaProfile.target, { provider: "claude", model: "sonnet", thinkingOptionId: "high" });

  const direct = resolveRouteTarget(
    { difficulty: "hard", target: { provider: "claude", model: "sonnet", thinkingOptionId: "low" } },
    [],
    { modelThinking: defaults },
  );
  assert.equal(direct.ok, true);
  assert.equal(direct.target.thinkingOptionId, "low", "显式档位优先于默认表");

  const noDefault = resolveRouteTarget(
    { difficulty: "hard", target: { provider: "claude", model: "sonnet" } },
    [],
    { modelThinking: [] },
  );
  assert.equal(noDefault.ok, true);
  assert.equal("thinkingOptionId" in noDefault.target, false);
});

test("派单计划：默认档随目标一起交给建会话那一步", () => {
  const base = {
    workspaceId: "w1",
    roles: [{ workspaceId: "w1", dispatcherAgentId: "d1" }],
    profiles: [],
    tasks: [{ key: "t1", prompt: "做事" }],
    maxDepth: 3,
    maxChildrenPerDispatch: 6,
    depth: 0,
    dispatchId: "dsp-test",
  };
  const routing = [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }];

  const plan = planDispatch({ ...base, routing, thinking: { modelThinking: defaults } });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].target.thinkingOptionId, "high");

  const cleared = planDispatch({ ...base, routing, thinking: { modelThinking: [] } });
  assert.equal("thinkingOptionId" in cleared.tasks[0].target, false, "清掉默认后不再带档位");

  const explicit = planDispatch({
    ...base,
    routing: [{ difficulty: "normal", target: { provider: "claude", model: "sonnet", thinkingOptionId: "low" } }],
    thinking: { modelThinking: defaults },
  });
  assert.equal(explicit.tasks[0].target.thinkingOptionId, "low");
});

test("归一：旧设置没有这段按空表处理，坏条目丢掉，重复的取第一条", () => {
  assert.deepEqual(normalizeOrchestration({}).modelThinking, []);
  assert.deepEqual(normalizeOrchestration(null).modelThinking, []);
  assert.deepEqual(normalizeOrchestration({ modelThinking: "high" }).modelThinking, []);

  assert.deepEqual(
    normalizeModelThinking([
      { provider: " claude ", model: " sonnet ", thinkingOptionId: " high " },
      { provider: "claude", model: "sonnet", thinkingOptionId: "low" },
      { provider: "", model: "sonnet", thinkingOptionId: "low" },
      { provider: "claude", model: "opus" },
      null,
      "high",
    ]),
    [{ provider: "claude", model: "sonnet", thinkingOptionId: "high" }],
  );

  const many = Array.from({ length: MAX_MODEL_THINKING + 5 }, (_, index) => ({
    provider: "claude",
    model: `m${index}`,
    thinkingOptionId: "high",
  }));
  assert.equal(normalizeModelThinking(many).length, MAX_MODEL_THINKING, "整表条数按上限封顶");
});

test("契约：线上设置带这一项，形状与归一化结果一致", () => {
  const normalized = normalizeOrchestration({ modelThinking: defaults });
  const parsed = orchestrationSettingsSchema.parse(normalized);
  assert.deepEqual(parsed.modelThinking, defaults);
  assert.equal(orchestrationSettingsSchema.safeParse({ ...normalized, modelThinking: [{ provider: "claude" }] }).success, false);
});

test("可选模型表：只收真的写了清单的客户端；Codex 认派生条目", () => {
  const models = configuredModelsByProvider({
    providers: {
      claude: { additionalModels: [{ id: "m1" }, { id: "m2" }] },
      // 没有清单 = 宿主内置模型，不能拿来判「模型被删了」。
      gemini: {},
      // Codex 的模型清单在派生条目上，路由里写的是 codex。
      "deck-codex": {
        extends: "codex",
        enabled: true,
        env: { OPENAI_BASE_URL: "https://codex.example.test" },
        additionalModels: [{ id: "gpt-5" }],
      },
    },
  });
  assert.deepEqual(models, {
    claude: ["m1", "m2"],
    codex: ["gpt-5"],
    "deck-codex": ["gpt-5"],
  });
  assert.deepEqual(configuredModelsByProvider(null), {});
  // 写了一把空清单也算表过态：模型全删了，残留默认档就该失效，不能被当成「不判」。
  assert.deepEqual(configuredModelsByProvider({ providers: { claude: { models: [] } } }), { claude: [] });
  // 两把键都在时按卡片那套读法挑（`models` 非空才用 `models`）：
  // 判「模型在不在」与卡片显示的清单必须是同一个答案，否则卡片上能配的模型会被静默裁掉。
  assert.deepEqual(
    configuredModelsByProvider({ providers: { claude: { models: [], additionalModels: [{ id: "m9" }] } } }),
    { claude: ["m9"] },
  );
});

test("设置读写：旧文件没有默认档能读；保存 handler 能收下这一项并落盘", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-model-thinking-"));
  await mkdir(path.dirname(orchestrationFileOf(dir)), { recursive: true });
  // 旧版本写的文件：没有 modelThinking 这一段。
  await writeFile(
    orchestrationFileOf(dir),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-10-29T00:00:00.000Z",
      workspaceId: "ws1",
      roles: [{ workspaceId: "ws1", dispatcherAgentId: "d1" }],
      routing: [],
      maxDepth: 3,
      maxChildrenPerDispatch: 4,
      reportOnFinish: true,
    }),
    "utf8",
  );
  assert.deepEqual((await readOrchestration(dir)).settings.modelThinking, [], "旧数据按空表处理");

  const saved = await orchestrationSaveHandler({
    workspaceDir: dir,
    workspaceId: "ws1",
    settings: {
      roles: [{ workspaceId: "ws1", dispatcherAgentId: "d1" }],
      routing: [],
      maxDepth: 3,
      maxChildrenPerDispatch: 4,
      reportOnFinish: true,
      modelThinking: defaults,
    },
  });
  assert.equal(saved.ok, true);
  const stored = await readOrchestration(dir);
  assert.deepEqual(stored.settings.modelThinking, defaults, "保存后原样读回来");
  assert.deepEqual(stored.settings.routing, []);

  // 清除：整表里去掉这一条，再保存就是「不传」。
  const removed = await orchestrationSaveHandler({
    workspaceDir: dir,
    workspaceId: "ws1",
    settings: { ...saved.settings, modelThinking: defaults.filter((item) => item.model !== "sonnet") },
  });
  assert.equal(removed.ok, true);
  assert.deepEqual((await readOrchestration(dir)).settings.modelThinking, [defaults[1]]);
});
