import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerHooks, resetDeckWorkspaceCacheForTest, shouldAutoAllowPermission } from "../server/hooks.ts";
import { listLogs, resetLogs } from "../server/logs.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";

/**
 * 「自动放行权限请求」的边界。
 *
 * 这道闸门替用户点头，所以边界要钉死在测试里：哪类请求放、哪个工作区放、关掉之后一条都不放。
 */

/** 只接 `before` / `on` 的宿主替身：我们要的只是把注册进去的处理函数取出来手动调用。 */
function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    before(name, handler) {
      handlers.set(`before:${name}`, handler);
    },
    on(name, handler) {
      handlers.set(`on:${name}`, handler);
    },
  };
}

/** 记下 `respondToPermission` 的调用；`failure` 用来模拟宿主这边拒掉。 */
function fakePaseo(failure = null) {
  const calls = [];
  return {
    calls,
    agents: {
      ref: (agentId) => ({
        respondToPermission: async (options) => {
          calls.push({ agentId, options });
          if (failure) throw failure;
        },
      }),
    },
  };
}

const context = (paseo) => ({ paseo, signal: new AbortController().signal });

const agent = (cwd) => ({ id: "agent-1", workspaceId: "ws-1", parentAgentId: null, provider: "cursor", cwd, title: null });

const request = (overrides = {}) => ({
  id: "perm-1",
  provider: "cursor",
  name: "other",
  kind: "tool",
  ...overrides,
});

/** 建一个「已装 deck 工具」的目录：后端选 local 且工作区里有 `.deck/`。 */
async function deckWorkspaceDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-perm-"));
  await mkdir(path.join(dir, ".deck"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 建一个什么都没有的目录：既不选 local，也不是仓库，判下来不是 deck 工作区。 */
async function plainDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-plain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 换一份设置跑这个用例，跑完还原默认值并清掉工作区判定缓存（干净的下一次）。 */
function useSettings(t, overrides) {
  setSettingsForTest({ ...DEFAULT_SETTINGS, ...overrides });
  resetDeckWorkspaceCacheForTest();
  t.after(() => {
    setSettingsForTest(DEFAULT_SETTINGS);
    resetDeckWorkspaceCacheForTest();
  });
}

/** 取出注册好的权限处理函数。 */
function permissionHandler() {
  const server = fakeServer();
  registerHooks(server);
  const handler = server.handlers.get("on:agent.permission_requested");
  assert.equal(typeof handler, "function", "必须注册了 agent.permission_requested 的处理函数");
  return handler;
}

test("放行判定：开关关着一条都不放", () => {
  assert.equal(shouldAutoAllowPermission({ enabled: false, deckWorkspace: true, kind: "tool" }), false);
  assert.equal(shouldAutoAllowPermission({ enabled: false, deckWorkspace: true, kind: "other" }), false);
});

test("放行判定：不是 deck 工作区就不动手", () => {
  assert.equal(shouldAutoAllowPermission({ enabled: true, deckWorkspace: false, kind: "tool" }), false);
  assert.equal(shouldAutoAllowPermission({ enabled: true, deckWorkspace: false, kind: "other" }), false);
});

test("放行判定：只认 tool / other，方案、提问、切模式不替用户拍板", () => {
  assert.equal(shouldAutoAllowPermission({ enabled: true, deckWorkspace: true, kind: "tool" }), true);
  assert.equal(shouldAutoAllowPermission({ enabled: true, deckWorkspace: true, kind: "other" }), true);
  for (const kind of ["plan", "question", "mode"]) {
    assert.equal(shouldAutoAllowPermission({ enabled: true, deckWorkspace: true, kind }), false, `${kind} 不该被自动同意`);
  }
});

test("开关关着时，收到的权限请求原样留在用户那里", async (t) => {
  resetLogs();
  useSettings(t, { backend: "local", autoAllowPermissions: false });
  const dir = await deckWorkspaceDir(t);
  const paseo = fakePaseo();
  await permissionHandler()({ agent: agent(dir), request: request() }, context(paseo));
  assert.deepEqual(paseo.calls, [], "关着就不该回任何话");
});

test("开着时，deck 工作区里的工具请求被直接同意，并留下一条日志", async (t) => {
  resetLogs();
  useSettings(t, { backend: "local", autoAllowPermissions: true });
  const dir = await deckWorkspaceDir(t);
  const paseo = fakePaseo();
  await permissionHandler()({ agent: agent(dir), request: request({ kind: "other" }) }, context(paseo));
  assert.equal(paseo.calls.length, 1);
  assert.equal(paseo.calls[0].agentId, "agent-1");
  assert.deepEqual(paseo.calls[0].options, { requestId: "perm-1", response: { behavior: "allow" } });
  assert.ok(
    listLogs().some((entry) => entry.message.includes("已自动放行")),
    "放行要留痕，用户才能回头查它替自己点过什么",
  );
});

test("开着时，方案类请求不自动同意，但日志里说明为什么", async (t) => {
  resetLogs();
  useSettings(t, { backend: "local", autoAllowPermissions: true });
  const dir = await deckWorkspaceDir(t);
  const paseo = fakePaseo();
  await permissionHandler()({ agent: agent(dir), request: request({ kind: "plan" }) }, context(paseo));
  assert.deepEqual(paseo.calls, []);
  const skipped = listLogs().find((entry) => entry.message.includes("未自动放行"));
  assert.ok(skipped, "跳过要留痕");
  // 原因是「这类请求本来就不放行」，不是「工作区没装工具」——两者在日志里不能混成一句话。
  assert.ok(skipped.message.includes("这类请求不自动同意"));
});

test("开着时，没装 deck 工具的工作区不替用户点头", async (t) => {
  resetLogs();
  // auto 后端 + 空目录：既没有远端、也没有 .deck/，判下来不是 deck 工作区。
  useSettings(t, { backend: "auto", autoAllowPermissions: true });
  const dir = await plainDir(t);
  const paseo = fakePaseo();
  await permissionHandler()({ agent: agent(dir), request: request() }, context(paseo));
  assert.deepEqual(paseo.calls, [], "别的工作区里放行的不是 deck 工具，凭什么替人点");
});

test("判定缓存按后端分开：换后端后立刻重判，不等一分钟过期", async (t) => {
  resetLogs();
  useSettings(t, { backend: "local", autoAllowPermissions: true });
  const dir = await deckWorkspaceDir(t);

  const first = fakePaseo();
  await permissionHandler()({ agent: agent(dir), request: request() }, context(first));
  assert.equal(first.calls.length, 1, "local 后端下这个目录是 deck 工作区");

  // 同一个目录、不动缓存，只把后端换成 github：它不是仓库，判定必须立刻变成「不生效」。
  setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "github", autoAllowPermissions: true });
  const second = fakePaseo();
  await permissionHandler()({ agent: agent(dir), request: request() }, context(second));
  assert.deepEqual(second.calls, [], "换了后端还喂旧答案，就等于开关有一分钟不受设置控制");
});

test("宿主那边拒了也不往外抛：请求还在，用户照常点", async (t) => {
  resetLogs();
  useSettings(t, { backend: "local", autoAllowPermissions: true });
  const dir = await deckWorkspaceDir(t);
  const paseo = fakePaseo(new Error("no such agent"));
  await assert.doesNotReject(
    permissionHandler()({ agent: agent(dir), request: request() }, context(paseo)),
  );
  assert.ok(listLogs().some((entry) => entry.level === "warn" && entry.message.includes("自动放行权限请求失败")));
});
