import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshProviderCatalog } from "../server/provider-catalog-refresh.ts";

/**
 * 「刷新宿主模型列表」这条路。
 *
 * 宿主的模型清单是按工作区缓存的：改完接入地址或模型后，选择器还停在旧快照上。
 * 这里钉住四件事：刷新与回读用同一个工作区、宿主没确认刷新就不报成功、
 * 目录读取失败要带警告（不是「0 个模型」）、刷新失败与回读失败分开报。
 */

function fakePaseo(entries, options = {}) {
  const calls = { refresh: [], snapshot: [] };
  const paseo = {
    providers: {
      refresh: async (input) => {
        calls.refresh.push(input);
        if (options.refreshThrows) throw new Error("daemon unreachable");
        // 缺字段模拟旧宿主 / 半截响应：没有明确确认就不算成功。
        return options.omitAcknowledged ? { requestId: "r" } : { requestId: "r", acknowledged: options.acknowledged ?? true };
      },
      snapshot: async (input) => {
        calls.snapshot.push(input);
        if (options.snapshotThrows) throw new Error("snapshot broken");
        return { entries };
      },
    },
  };
  return { paseo, calls };
}

test("刷新与回读用同一个工作区，返回每个客户端的模型 id", async () => {
  const { paseo, calls } = fakePaseo([
    { provider: "claude", status: "ready", models: [{ id: "m1" }, { id: " m2 " }, {}] },
    { provider: "codex", status: "ready", models: [{ id: "x" }] },
  ]);

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers, [
    { id: "claude", models: ["m1", "m2"] },
    { id: "codex", models: ["x"] },
  ]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls.refresh, [{ cwd: "/tmp/ws" }]);
  assert.deepEqual(calls.snapshot, [{ cwd: "/tmp/ws" }]);
});

test("停用的客户端不进摘要：宿主的模型选择器里也没有它", async () => {
  const { paseo } = fakePaseo([
    { provider: "claude", status: "ready", enabled: true, models: [{ id: "m1" }] },
    { provider: "codex", status: "ready", enabled: false, models: [{ id: "x" }] },
  ]);

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers.map((row) => row.id), ["claude"]);
});

test("配置里停用的客户端也不进摘要：与状态页用的是同一套判断", async () => {
  const { paseo } = fakePaseo([
    { provider: "claude", status: "ready", models: [{ id: "m1" }] },
    { provider: "codex", status: "ready", models: [{ id: "x" }] },
  ]);

  const result = await refreshProviderCatalog(paseo, {
    workspaceDir: "/tmp/ws",
    config: { providers: { codex: { enabled: false } } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers.map((row) => row.id), ["claude"]);
});

test("插件不支持的家不进选择器：与客户端列表同一口径", async () => {
  const { paseo } = fakePaseo([
    { provider: "claude", status: "ready", models: [{ id: "m1" }] },
    { provider: "codex", status: "ready", models: [{ id: "x" }] },
    // OpenCode 只有前缀约定、没有实证；Codex 的派生 provider 也不单列。
    { provider: "opencode", status: "ready", models: [{ id: "o1" }] },
    { provider: "deck-codex", status: "ready", models: [{ id: "x" }] },
    { provider: "cursor", status: "ready", models: [{ id: "c1" }] },
    { provider: "copilot", status: "ready", models: [{ id: "p1" }] },
  ]);

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers.map((row) => row.id), ["claude", "codex"]);
  // 静默丢掉会让人以为刷新坏了：只在这条路的日志里记数，界面口径写在客户端页说明行。
  assert.deepEqual(result.warnings, [], "隐藏客户端不该变成每次刷新的告警噪音");
});

test("目录读取失败带警告，不能显示成「0 个模型」了事", async () => {
  const { paseo } = fakePaseo([
    { provider: "claude", status: "error", error: "spawn claude ENOENT", models: [] },
  ]);

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers, [{ id: "claude", models: [] }]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /claude/);
  assert.match(result.warnings[0], /ENOENT/);
});

test("ready 却一个模型也没有时带警告：选择器里会是空的", async () => {
  const { paseo } = fakePaseo([{ provider: "claude", status: "ready", models: [] }]);

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers, [{ id: "claude", models: [] }]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /claude/);
});

test("超过契约上限的模型 id 在服务端截短，不让整包输出校验失败", async () => {
  const long = "m".repeat(300);
  const { paseo } = fakePaseo([{ provider: "claude", status: "ready", models: [{ id: long }] }]);

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, true);
  assert.equal(result.providers[0].models[0].length, 200);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /截短/);
});

test("模型数超过上限时只列前 2000 个并说明", async () => {
  const models = Array.from({ length: 2001 }, (_, index) => ({ id: `m${index}` }));
  const { paseo } = fakePaseo([{ provider: "claude", status: "ready", models }]);

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, true);
  assert.equal(result.providers[0].models.length, 2000);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /2000/);
});

test("宿主没确认刷新时报失败：缺 acknowledged 字段也一样", async () => {
  const { paseo, calls } = fakePaseo([], { omitAcknowledged: true });

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "refresh-failed");
  assert.equal(calls.snapshot.length, 0);
});

test("宿主没确认刷新时不报成功，也不去读旧快照", async () => {
  const { paseo, calls } = fakePaseo([], { acknowledged: false });

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "refresh-failed");
  assert.equal(calls.snapshot.length, 0, "没确认刷新就别拿旧快照冒充新清单");
});

test("刷新抛错时报 refresh-failed，不再去读快照", async () => {
  const { paseo, calls } = fakePaseo([], { refreshThrows: true });

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "refresh-failed");
  assert.match(result.detail, /daemon unreachable/);
  assert.equal(calls.snapshot.length, 0, "刷新都没成，回读没有意义");
});

test("刷新成功但回读抛错时报 snapshot-failed", async () => {
  const { paseo } = fakePaseo([], { snapshotThrows: true });

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "/tmp/ws" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "snapshot-failed");
  assert.match(result.detail, /snapshot broken/);
});

test("没有工作区目录就不碰宿主", async () => {
  const { paseo, calls } = fakePaseo([]);

  const result = await refreshProviderCatalog(paseo, { workspaceDir: "   " });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(calls.refresh.length + calls.snapshot.length, 0);
});
