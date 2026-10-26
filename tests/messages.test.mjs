import assert from "node:assert/strict";
import test from "node:test";
import { en, zh } from "../client/deck/messages.ts";

/**
 * locales 的键与占位符必须一致。
 *
 * `defineTranslations` 只在插件客户端模块加载时校验，一旦不一致整块面板就白了；
 * 而那一步跑在 Paseo 里，不在测试里。所以这里复刻同一条规则，把失败前移到 CI：
 * 键少一条、占位符差一个，测试先红。
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
