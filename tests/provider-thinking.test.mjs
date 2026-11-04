import assert from "node:assert/strict";
import test from "node:test";
import { modelIdsOf, modelThinkingOf } from "../server/provider-snapshot-view.ts";
import { thinkingChoicesOf, withModelClearingThinking } from "../client/deck/surfaces/orchestration/types.ts";
import { providerRowSchema } from "../shared/orchestration-rpc.ts";

/**
 * 推理档位的数据链路：宿主快照 → 契约 → 界面。
 *
 * 两条底线在这里钉住：
 * 1. 快照是外部输入，字段缺失或形状不对只许退化成「没有档位」，不许抛错挡住状态页；
 * 2. 档位一律跟着 provider + model 走，取不到就是「没有可选项」，绝不补一个默认档。
 */

test("快照：正常档位原样保留，默认档只在指向已知档位时才带", () => {
  const entry = {
    models: [
      {
        id: " sonnet ",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: " high ", label: "High", description: " 更慢更准 ", isDefault: true },
        ],
        defaultThinkingOptionId: "high",
      },
    ],
  };
  assert.deepEqual(modelIdsOf(entry), ["sonnet"], "取模型 id 的口径不变");
  assert.deepEqual(modelThinkingOf(entry), [
    {
      id: "sonnet",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", description: "更慢更准", isDefault: true },
      ],
      defaultThinkingOptionId: "high",
    },
  ]);
});

test("快照：没有 thinkingOptions / 空数组 = 这个模型没有档位，不出现在列表里", () => {
  const entries = [
    { models: [{ id: "bare" }] },
    { models: [{ id: "empty", thinkingOptions: [] }] },
    { models: [{ id: "wrong", thinkingOptions: "low,high" }] },
    { models: [{ id: "nullish", thinkingOptions: null }] },
  ];
  for (const entry of entries) {
    assert.deepEqual(modelThinkingOf(entry), [], `${JSON.stringify(entry)} 应当退化成没有档位`);
  }
});

test("快照：选项缺 id / 不是对象 / 重复 id 都丢掉，label 缺失退回 id", () => {
  const entry = {
    models: [
      {
        id: "m",
        thinkingOptions: [
          { label: "没有 id" },
          null,
          "high",
          { id: "   ", label: "空白 id" },
          { id: "low" },
          { id: "low", label: "重复的 Low" },
          { id: "high", label: "" },
        ],
      },
    ],
  };
  assert.deepEqual(modelThinkingOf(entry), [
    {
      id: "m",
      thinkingOptions: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
      ],
    },
  ]);
});

test("快照：models 本身不是数组 / 条目是 null 时也不抛错", () => {
  for (const entry of [null, undefined, {}, { models: null }, { models: "sonnet" }, { models: { id: "x" } }]) {
    assert.deepEqual(modelIdsOf(entry), []);
    assert.deepEqual(modelThinkingOf(entry), []);
  }
});

test("快照：字段类型不对时不抛错，退化成没有档位 / 没有默认", () => {
  const entry = {
    models: [
      { id: 42, thinkingOptions: [{ id: "high", label: "High" }] },
      { id: "m", thinkingOptions: [{ id: "high", label: "High", description: 9, isDefault: "yes" }] },
      { id: "dangling", thinkingOptions: [{ id: "low", label: "Low" }], defaultThinkingOptionId: "gone" },
    ],
  };
  assert.deepEqual(modelThinkingOf(entry), [
    { id: "m", thinkingOptions: [{ id: "high", label: "High" }] },
    { id: "dangling", thinkingOptions: [{ id: "low", label: "Low" }] },
  ]);
});

test("契约：老数据没有 modelThinking 也能读，新数据按模型带档位", () => {
  const base = {
    id: "claude",
    label: "Claude",
    enabled: true,
    status: "ready",
    models: ["sonnet"],
    configModels: [],
    modelsKey: "models",
    extends: null,
    baseUrl: null,
    credentialKeys: [],
    env: [],
  };
  assert.deepEqual(providerRowSchema.parse(base).modelThinking, undefined, "可选字段：老快照不报就不报");
  const parsed = providerRowSchema.parse({
    ...base,
    modelThinking: [
      {
        id: "sonnet",
        thinkingOptions: [{ id: "high", label: "High", description: "更快", isDefault: true }],
        defaultThinkingOptionId: "high",
      },
    ],
  });
  assert.deepEqual(parsed.modelThinking, [
    {
      id: "sonnet",
      thinkingOptions: [{ id: "high", label: "High", description: "更快", isDefault: true }],
      defaultThinkingOptionId: "high",
    },
  ]);
});

const providers = [
  {
    id: "claude",
    models: ["sonnet", "haiku", "bare"],
    modelThinking: [
      {
        id: "sonnet",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
        defaultThinkingOptionId: "high",
      },
      { id: "haiku", thinkingOptions: [{ id: "max", label: "Max" }] },
      { id: "bare", thinkingOptions: [] },
    ],
  },
  { id: "codex", models: [] },
];

test("档位：按 provider + model 取宿主报的那一套", () => {
  assert.deepEqual(thinkingChoicesOf("claude", "sonnet", providers), {
    kind: "ok",
    options: [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ],
    defaultOptionId: "high",
  });
});

test("档位：换模型就换一套，不串档", () => {
  assert.deepEqual(thinkingChoicesOf("claude", "haiku", providers), {
    kind: "ok",
    options: [{ id: "max", label: "Max" }],
    // 没写模型级默认、选项也没标 isDefault：就是没有默认，不替用户挑。
    defaultOptionId: null,
  });
});

test("档位：未选模型 / 未选客户端 / 客户端不在清单 → 没有可选项", () => {
  for (const state of [
    thinkingChoicesOf("claude", "", providers),
    thinkingChoicesOf("claude", "   ", providers),
    thinkingChoicesOf("  ", "sonnet", providers),
    thinkingChoicesOf("gemini", "sonnet", providers),
  ]) {
    assert.deepEqual(state, { kind: "none" });
  }
});

test("档位：模型不在清单 / 模型没报档位 → 没有可选项，不给默认档", () => {
  for (const state of [
    thinkingChoicesOf("claude", "opus", providers),
    thinkingChoicesOf("codex", "gpt-5", providers),
    thinkingChoicesOf("claude", "bare", providers),
  ]) {
    assert.deepEqual(state, { kind: "none" });
  }
});

test("档位：模型级默认指向不存在的档位时，退回选项上的 isDefault", () => {
  const dangling = [
    {
      id: "claude",
      models: ["m"],
      modelThinking: [
        {
          id: "m",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ],
          defaultThinkingOptionId: "gone",
        },
      ],
    },
  ];
  assert.equal(thinkingChoicesOf("claude", "m", dangling).defaultOptionId, "high");
});

test("换模型：清掉旧档位；模型没变就原样返回", () => {
  const target = { provider: "claude", model: "sonnet", thinkingOptionId: "high" };
  assert.deepEqual(withModelClearingThinking(target, "haiku"), { provider: "claude", model: "haiku" });
  assert.equal(withModelClearingThinking(target, "sonnet"), target);
  assert.equal(target.thinkingOptionId, "high", "传入的 target 不能被原地改掉");
});

test("换模型：旧数据带空格、归一后同名，不算换模型，档位留着", () => {
  const target = { provider: "claude", model: " sonnet ", thinkingOptionId: "high" };
  assert.equal(withModelClearingThinking(target, "sonnet"), target, "只是空格差异不该清掉用户选的档位");
});
