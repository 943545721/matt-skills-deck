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

test("manifest 的 paseo 版本约束落在 0.13 线内", () => {
  const range = manifest.requirements?.paseo;
  assert.ok(typeof range === "string" && range.length > 0, "requirements.paseo 缺失时会被 0.8+ 拒绝安装");
  assert.match(range, />=0\.13\.0\s*<\s*0\.14\.0/, `当前约束 ${range} 不在 0.13 线内，需随 Paseo 升级重定`);
});

test("manifest 的 id 不与包名冲突", () => {
  assert.equal(manifest.id, pkg.name, "manifest id 与 package.json name 应保持一致，避免安装后找错目录");
});
