import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  registerHooks,
  resetDeckWorkspaceCacheForTest,
  resetStaffTerritoryGateForTest,
} from "../server/hooks.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";

/**
 * 票闸 shell 侧的接线：纯函数认得出来还不够，得证明它真的落在
 * `agent.permission_requested` 上、并且发出的是 deny、还不会被后面的自动放行翻掉。
 *
 * 用真实仓库目录（npm test 的工作目录）当「有票的板子」：本仓根上有 `.deck/`，
 * 这也是插件平时判断板子的依据。
 */

const workspace = process.cwd();

function permissionHandlers() {
  const handlers = new Map();
  const server = {
    on(name, handler) {
      const list = handlers.get(`on:${name}`) ?? [];
      list.push(handler);
      handlers.set(`on:${name}`, list);
    },
    before() {},
  };
  registerHooks(server);
  return handlers.get("on:agent.permission_requested") ?? [];
}

/** 宿主替身：记下每一条 respondToPermission 调用。 */
function fakePaseo() {
  const calls = [];
  return {
    calls,
    agents: {
      ref: () => ({
        respondToPermission: async (payload) => {
          calls.push(payload);
        },
      }),
    },
  };
}

const context = (paseo) => ({ paseo, signal: new AbortController().signal });

async function runAll(command, cwd = workspace) {
  const handlers = permissionHandlers();
  const paseo = fakePaseo();
  const payload = {
    agent: { id: "agent-guard-test", cwd },
    request: { id: "req-1", name: "shell", kind: "tool", detail: { type: "shell", command } },
  };
  // 按注册顺序跑一遍，模拟宿主把同一条请求交给每一个处理函数。
  for (const handler of handlers) await handler(payload, context(paseo));
  return paseo.calls;
}

/** 每个用例都从干净的「留给人工」标记与工作区缓存开始。 */
function cleanState(t) {
  resetStaffTerritoryGateForTest();
  resetDeckWorkspaceCacheForTest();
  t.after(() => {
    setSettingsForTest(DEFAULT_SETTINGS);
    resetStaffTerritoryGateForTest();
    resetDeckWorkspaceCacheForTest();
  });
}

test("改票的 gh 命令在有票的板子上真的被 deny", async (t) => {
  cleanState(t);
  const calls = await runAll("gh issue create --title x");
  assert.equal(calls.length, 1, "应当只有票闸回一次话");
  assert.equal(calls[0].response.behavior, "deny");
  assert.match(calls[0].response.message, /deck_issue_create/);
});

test("只读的 gh 命令不拦，也不产生任何回话", async (t) => {
  cleanState(t);
  assert.deepEqual(await runAll("gh issue list"), []);
});

test("没有票的普通目录里不替别人立规矩", async (t) => {
  cleanState(t);
  const dir = await mkdtemp(path.join(tmpdir(), "deck-plain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await runAll("gh issue create --title x", dir), []);
});

test("自动放行打开时，deny 仍然归票闸说了算", async (t) => {
  cleanState(t);
  setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "auto", autoAllowPermissions: true });
  const calls = await runAll("gh issue create --title x");
  assert.equal(calls.length, 1, "自动放行不能把票闸的 deny 再翻成 allow");
  assert.equal(calls[0].response.behavior, "deny");
});
