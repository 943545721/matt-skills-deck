import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addModelId,
  configuredModelIds,
  envDisplayOf,
  filterModelIds,
  isModelEnvKey,
  isPlainModelValue,
  maskValue,
  modelListKeyOf,
  removeModelId,
} from "../shared/provider-models.ts";

/**
 * 「我们这条接口提供哪些模型」与「哪个值该明文显示」。
 *
 * 清单只收配置里声明的那些——客户端自带的型号（claude-opus-* / sonnet / haiku）不进清单，
 * 它们不是这条链路的东西。写回要分清 `models`（替换内置）与 `additionalModels`（追加内置），
 * 写错等于没生效或把内置列表清空。
 *
 * 掩码那条边界也不能反过来：模型名不是机密，但 `sk-` 开头的哪怕挂在 `*_MODEL` 上也得遮。
 */

test("模型键识别：只认 ANTHROPIC_ 前缀下的 *_MODEL", () => {
  assert.equal(isModelEnvKey("ANTHROPIC_MODEL"), true);
  assert.equal(isModelEnvKey("ANTHROPIC_DEFAULT_OPUS_MODEL"), true);
  assert.equal(isModelEnvKey("ANTHROPIC_SMALL_FAST_MODEL"), true);
  assert.equal(isModelEnvKey("anthropic_default_haiku_model"), true, "大小写不敏感");
  assert.equal(isModelEnvKey("ANTHROPIC_BASE_URL"), false);
  assert.equal(isModelEnvKey("ANTHROPIC_AUTH_TOKEN"), false);
  assert.equal(isModelEnvKey("OPENAI_MODEL"), false, "别的厂商的模型键不归这条管");
});

test("明文放行：只有「模型键 + 值像模型 id」才直出", () => {
  const known = ["deepseek-v4.1-flash", "claude-opus-4-8[1m]"];
  assert.equal(isPlainModelValue("ANTHROPIC_MODEL", "deepseek-v4.1-flash", known), true);
  assert.equal(isPlainModelValue("ANTHROPIC_DEFAULT_HAIKU_MODEL", "claude-opus-4-8[1m]", known), true);
  // 不在宿主列表里但形状对：可能是刚换的代理模型，宿主还没刷新到。
  assert.equal(isPlainModelValue("ANTHROPIC_MODEL", "glm-5.3-flash", known), true);
  // 带空格的自由文本不像模型 id，宁可遮住。
  assert.equal(isPlainModelValue("ANTHROPIC_MODEL", "my custom model", known), false);
  // 凭据形状一律不放行，哪怕键名是模型键。
  assert.equal(isPlainModelValue("ANTHROPIC_MODEL", "sk-ant-api03-abcdef", known), false);
  assert.equal(isPlainModelValue("ANTHROPIC_AUTH_TOKEN", "deepseek-v4.1-flash", known), false, "非模型键不走这条");
  assert.equal(isPlainModelValue("ANTHROPIC_BASE_URL", "https://example.test", known), false);
});

test("掩码：短值全遮（尾四位就是全文的不算掩码）", () => {
  assert.equal(maskValue(""), "");
  assert.equal(maskValue("abc"), "••••");
  assert.equal(maskValue("12345678"), "••••", "8 位以内不给尾四位");
  assert.equal(maskValue("sk-ant-existing-key-9999"), "••••9999");
});

test("envDisplayOf：模型键明文、凭据键掩码、空值空串", () => {
  const models = ["deepseek-v4.1-flash"];
  const model = envDisplayOf("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4.1-flash", models);
  assert.deepEqual(model, { display: "deepseek-v4.1-flash", masked: false });
  const key = envDisplayOf("ANTHROPIC_AUTH_TOKEN", "sk-ant-very-secret-1234", models);
  assert.equal(key.masked, true);
  assert.doesNotMatch(key.display, /very-secret/);
  assert.deepEqual(envDisplayOf("ANTHROPIC_MODEL", "  ", models), { display: "", masked: false });
});

test("写回目标：现存 `models` 优先，其次 additionalModels，都没有按追加", () => {
  assert.equal(modelListKeyOf({ models: [{ id: "a", label: "A" }] }), "models");
  assert.equal(modelListKeyOf({ additionalModels: [{ id: "b", label: "B" }] }), "additionalModels");
  assert.equal(modelListKeyOf({}), "additionalModels", "默认是不容易毁数据的追加");
  assert.equal(modelListKeyOf({ models: [] }), "additionalModels", "空数组不算用这把键");
  assert.equal(modelListKeyOf(null), "additionalModels");
});

test("清单读取：两种条目形状（字符串 / 对象）都读得出来，空白与无 id 的丢掉", () => {
  assert.deepEqual(
    configuredModelIds({ models: ["a", { id: "b" }, "  c  ", { label: "没 id" }] }, "models"),
    ["a", "b", "c"],
  );
  assert.deepEqual(configuredModelIds({}, "models"), []);
  assert.deepEqual(configuredModelIds(null, "additionalModels"), []);
});

test("加模型：去重、去首尾空白，不改入参", () => {
  const base = ["deepseek-v4.1-flash"];
  assert.deepEqual(addModelId(base, "glm-5.3-flash"), ["deepseek-v4.1-flash", "glm-5.3-flash"]);
  assert.deepEqual(addModelId(base, "  glm-5.3-flash  "), ["deepseek-v4.1-flash", "glm-5.3-flash"], "先 trim 再判重");
  assert.deepEqual(addModelId(base, "deepseek-v4.1-flash"), ["deepseek-v4.1-flash"], "已有就不重复");
  assert.deepEqual(addModelId(base, "   "), ["deepseek-v4.1-flash"]);
  assert.deepEqual(base, ["deepseek-v4.1-flash"], "入参不能被改");
});

test("删模型：只删指定的那个，不在清单里也不报错", () => {
  const base = ["a", "b", "c"];
  assert.deepEqual(removeModelId(base, "b"), ["a", "c"]);
  assert.deepEqual(removeModelId(base, "zzz"), ["a", "b", "c"]);
  assert.deepEqual(base, ["a", "b", "c"]);
});

test("筛清单：大小写不敏感，空关键词原样返回一份新数组", () => {
  const base = ["DeepSeek-V4.1-Flash", "glm-5.3-flash"];
  assert.deepEqual(filterModelIds(base, "deepseek"), ["DeepSeek-V4.1-Flash"]);
  assert.deepEqual(filterModelIds(base, "GLM"), ["glm-5.3-flash"]);
  assert.deepEqual(filterModelIds(base, "  "), base);
  assert.notEqual(filterModelIds(base, ""), base, "返回新数组，调用方改它不影响原清单");
  assert.deepEqual(filterModelIds(base, "zzz"), []);
});
