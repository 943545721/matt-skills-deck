import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  modelWindowCachePath,
  readModelWindowCache,
  saveFetchedModelWindows,
} from "../server/model-window-cache.ts";

/**
 * 窗口缓存的落盘那一层。
 *
 * 钉三件事：
 * - 失败要有告警，不能「返回成功但什么都没记住」；
 * - 同一工作区的写入串行化，两个 provider 并发拉取时不许互相盖掉；
 * - 只存在工作区里，没有工作区就不假装存下了。
 */

async function cacheDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "deck-window-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("文件还不存在是正常情况：空缓存、不告警", async (t) => {
  const dir = await cacheDir(t);
  const read = await readModelWindowCache(dir);
  assert.deepEqual(read.cache.providers, {});
  assert.equal(read.warning, null, "第一次跑还没有这份文件，不该吓用户");
});

test("没有工作区目录：不写，但要回一句告警", async () => {
  // 静默返回 null 的话，调用方看到的是「获取成功」，之后保存却悄悄丢窗口。
  const warning = await saveFetchedModelWindows({
    workspaceDir: undefined,
    provider: "claude",
    baseUrl: "https://api.example.test",
    models: [{ id: "m", contextWindowMaxTokens: 128000 }],
  });
  assert.ok(warning && warning.includes("没有工作区目录"));
});

test("地址不成形：不写，也要回告警", async (t) => {
  const dir = await cacheDir(t);
  const warning = await saveFetchedModelWindows({
    workspaceDir: dir,
    provider: "claude",
    baseUrl: "不是地址",
    models: [{ id: "m", contextWindowMaxTokens: 128000 }],
  });
  assert.ok(warning && warning.includes("地址不成形"));
  assert.equal((await readModelWindowCache(dir)).warning, null, "什么都没写，就不该留下坏文件");
});

test("JSON 坏掉要告警，并且这次按没有缓存处理", async (t) => {
  const dir = await cacheDir(t);
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(modelWindowCachePath(dir), "{ 这不是 JSON", "utf8");
  const read = await readModelWindowCache(dir);
  assert.deepEqual(read.cache.providers, {});
  assert.ok(read.warning && read.warning.includes("格式不对"));
});

test("形状不认识也要告警：文件读得动、但不是插件写的", async (t) => {
  const dir = await cacheDir(t);
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(modelWindowCachePath(dir), JSON.stringify({ version: 99, providers: {} }), "utf8");
  const read = await readModelWindowCache(dir);
  assert.deepEqual(read.cache.providers, {});
  assert.ok(read.warning && read.warning.includes("不是插件写的形状"));
});

test("两个 provider 并发保存：后写的不能把前一个盖掉", async (t) => {
  const dir = await cacheDir(t);
  await Promise.all([
    saveFetchedModelWindows({
      workspaceDir: dir,
      provider: "claude",
      baseUrl: "https://a.example.test",
      models: [{ id: "m1", contextWindowMaxTokens: 128000 }],
    }),
    saveFetchedModelWindows({
      workspaceDir: dir,
      provider: "codex",
      baseUrl: "https://b.example.test",
      models: [{ id: "m2", contextWindowMaxTokens: 272000 }],
    }),
  ]);
  const onDisk = JSON.parse(await readFile(modelWindowCachePath(dir), "utf8"));
  assert.deepEqual(Object.keys(onDisk.providers).sort(), ["claude", "codex"]);
  assert.equal(onDisk.providers.claude.models[0].contextWindowMaxTokens, 128000);
  assert.equal(onDisk.providers.codex.models[0].contextWindowMaxTokens, 272000);
});
