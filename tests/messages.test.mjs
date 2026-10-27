import assert from "node:assert/strict";
import test from "node:test";
import { defineTranslations } from "@getpaseo/plugin/client";
import { en, zh } from "../client/deck/messages.ts";

/**
 * locales 的键与占位符必须一致。
 *
 * `defineTranslations` 在插件客户端模块加载时校验，一旦不过整块面板就起不来（界面里只显示
 * 「失败」和一行原因）。SDK 本身能在 Node 里 import，所以这里直接调真身，别复刻规则——
 * 之前复刻漏了「保留键」那条，`map.kind.prototype` 一路混到线上，插件在 Paseo 里加载失败。
 */

function flatten(resource, prefix = "") {
  const out = new Map();
  for (const [key, value] of Object.entries(resource)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [childKey, child] of flatten(value, path)) out.set(childKey, child);
  }
  return out;
}

function placeholders(value) {
  return [
    ...new Set([...value.matchAll(/\{\{-?\s*([^},\s]+)(?:[^}]*)}}/g)].map((match) => match[1])),
  ].sort();
}

const english = flatten(en);
const chinese = flatten(zh);

test("资源能通过 SDK 自己的校验（保留键、语言代码、键集合、占位符）", () => {
  assert.doesNotThrow(() => defineTranslations({ resources: { en, zh } }));
});

test("中文与英文的键集合一致", () => {
  const missing = [...english.keys()].filter((key) => !chinese.has(key));
  const extra = [...chinese.keys()].filter((key) => !english.has(key));
  assert.deepEqual(missing, [], `中文缺少：${missing.join(", ")}`);
  assert.deepEqual(extra, [], `中文多出：${extra.join(", ")}`);
});

test("同一条文案在两种语言里的占位符一致", () => {
  const mismatched = [];
  for (const [key, source] of english) {
    const translated = chinese.get(key);
    if (translated === undefined) continue;
    if (placeholders(source).join(",") !== placeholders(translated).join(",")) {
      mismatched.push(`${key}（en: ${placeholders(source).join(",") || "无"} / zh: ${placeholders(translated).join(",") || "无"}）`);
    }
  }
  assert.deepEqual(mismatched, []);
});

test("文案里没有空串，也没有残留的单花括号占位符", () => {
  const bad = [];
  for (const [key, value] of [...english, ...chinese]) {
    if (!value.trim()) bad.push(`${key} 为空`);
    // i18next 用 {{name}}；写成 {name} 会被原样输出，界面上就会出现 {n}。
    if (/(^|[^{])\{[a-zA-Z_][a-zA-Z0-9_]*\}([^}]|$)/.test(value)) bad.push(`${key} 用了单花括号占位符`);
  }
  assert.deepEqual(bad, []);
});
