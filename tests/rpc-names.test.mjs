import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 插件 RPC 的方法名必须是 `^[a-z][a-z0-9._-]*$`。
 *
 * 这条规则不在我们的类型里：宿主在加载插件时校验，写错一个驼峰（`providerInstall`）
 * 得到的是 `Invalid plugin RPC method`，插件直接 `failed`，而 `tsc` 与单测全绿。
 * 所以拿一遍仓库里所有 `defineRpc` 的名字来对照。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHARED = path.join(ROOT, "shared");
const PATTERN = /^[a-z][a-z0-9._-]*$/;

function looksLikeRpc(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.name === "string" &&
    "input" in value &&
    "output" in value
  );
}

async function collectRpcNames() {
  const files = (await readdir(SHARED)).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
  const found = [];
  for (const file of files) {
    const module = await import(path.join(SHARED, file));
    for (const [exportName, value] of Object.entries(module)) {
      if (looksLikeRpc(value)) found.push({ file, exportName, name: value.name });
    }
  }
  return found;
}

test("所有插件 RPC 方法名都是宿主接受的形式（小写、无空格）", async () => {
  const rpcs = await collectRpcNames();
  assert.ok(rpcs.length > 20, `只扫到 ${rpcs.length} 个 RPC，扫描逻辑可能没生效`);
  const bad = rpcs.filter((rpc) => !PATTERN.test(rpc.name));
  assert.deepEqual(
    bad.map((rpc) => `${rpc.file}#${rpc.exportName} → ${rpc.name}`),
    [],
    "这些名字会被宿主拒绝加载",
  );
});

test("插件 RPC 方法名不重复", async () => {
  const rpcs = await collectRpcNames();
  const seen = new Map();
  for (const rpc of rpcs) {
    const previous = seen.get(rpc.name);
    assert.equal(previous, undefined, `${rpc.name} 在 ${previous} 与 ${rpc.file} 里重复定义`);
    seen.set(rpc.name, rpc.file);
  }
});
