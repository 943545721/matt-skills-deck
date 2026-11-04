import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("paseo-plugin.json"));

test("package.json 与 shared/version.ts 的版本号一致", () => {
  const match = read("shared/version.ts").match(/PLUGIN_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(match, "shared/version.ts 里找不到 PLUGIN_VERSION 常量");
  assert.equal(
    match[1],
    pkg.version,
    "两处版本号不一致：改版本时必须同时改 package.json 与 shared/version.ts",
  );
});

/**
 * 版本比较：`0.14.0` 这类三段数字，按数字逐段比，不按字符串比
 * （字符串比会把 `0.9.0` 排到 `0.14.0` 后面）。
 */
function compare(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** 只认 `>=A <B` 这种两段写法：写了别的形式就抛，不悄悄当成「没约束」。 */
function insideRange(range, version) {
  const clauses = range.trim().split(/\s+/);
  const lower = clauses.find((clause) => clause.startsWith(">="));
  const upper = clauses.find((clause) => clause.startsWith("<"));
  if (!lower || !upper || clauses.length !== 2) throw new Error(`看不懂的版本约束：${range}`);
  return compare(version, lower.slice(2)) >= 0 && compare(version, upper.slice(1)) < 0;
}

/**
 * 为什么是 0.13–0.15 这一段：0.14 与 0.13 的客户端 SDK 逐字节相同，服务端只是新增了
 * `defineAgentTool` 与几处只读字段；0.15 于 2026-11-04 逐文件比对过（`@getpaseo/plugin`
 * 0.13.0 对 0.15.0 的 `dist/**.d.ts`）：
 *
 * - **客户端契约逐字节相同**（`dist/client` 无一处差异）——面板不出现的那个风险点不在客户端；
 * - 服务端只动 `lifecycle.d.ts` / `provider.d.ts` / `index.d.ts`：钩子事件改成
 *   `agent.create.before` 这种两段写法，但我们用的四个旧名（`agent.create`、
 *   `agent.created`、`agent.permission_requested`、`agent.turn_ended`）**全部留在
 *   `legacyEvents` / `legacyRequests` 别名表里**，载荷字段逐个相同。
 *
 * 0.16 之后仍未比对，所以上限停在 0.16。写错这个范围的表现是面板整个不出现、
 * 宿主只报一行「requires Paseo …」——2026-11-04 就这么踩过一次（App 0.15.0 被拦）。
 */
test("manifest 的 paseo 版本约束覆盖 0.13 / 0.14 / 0.15 三条线，且不越过 0.16", () => {
  const range = manifest.requirements?.paseo;
  assert.ok(typeof range === "string" && range.length > 0, "requirements.paseo 缺失时会被 0.8+ 拒绝安装");
  for (const version of ["0.13.0", "0.13.2", "0.14.0", "0.15.0"]) {
    assert.ok(insideRange(range, version), `当前约束 ${range} 装不上 Paseo ${version}`);
  }
  for (const version of ["0.12.9", "0.16.0"]) {
    assert.ok(!insideRange(range, version), `当前约束 ${range} 不该接受 Paseo ${version}`);
  }
});

test("manifest 的 id 不与包名冲突", () => {
  assert.equal(manifest.id, pkg.name, "manifest id 与 package.json name 应保持一致，避免安装后找错目录");
});
