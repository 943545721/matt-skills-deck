import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerHooks, resetStaffTerritoryGateForTest } from "../server/hooks.ts";
import { resetDeliveryQueueForTest } from "../server/delivery.ts";
import { listLogs, resetLogs } from "../server/logs.ts";

/**
 * C 创建门：主窗口 / 需求窗口 / 进度窗口不能直接开执行会话。
 *
 * 这道闸在 `agent.created` 里、名册早退之前：空名册的工作区也要受约束。
 * 后台事件的失败方向是放行——读不出配置、分不清工作区都不该误杀正常会话。
 */

const SETTINGS = {
  version: 1,
  updatedAt: "2026-11-05T00:00:00.000Z",
  workspaceId: "ws-1",
  roles: [{
    workspaceId: "ws-1",
    mainAgentId: "main-1",
    requirementAgentId: "requirement-1",
    dispatcherAgentId: "dispatch-1",
    progressAgentId: "progress-1",
  }],
  routing: [],
  maxDepth: 3,
  maxChildrenPerDispatch: 4,
  reportOnFinish: true,
};

async function makeWorkspace(t, settings = SETTINGS, name = "ws-1") {
  const dir = await mkdtemp(join(tmpdir(), "deck-window-create-"));
  t.after(() => {
    rm(dir, { recursive: true, force: true });
    resetDeliveryQueueForTest();
    resetStaffTerritoryGateForTest();
    resetLogs();
  });
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    typeof settings === "string" ? settings : JSON.stringify(settings),
    "utf8",
  );
  return dir;
}

function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    server: {
      before() {},
      on(name, handler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
    },
  };
}

function fakePaseo() {
  const archived = [];
  const sent = [];
  return {
    archived,
    sent,
    config: { get: async () => ({ config: {} }) },
    agents: {
      list: async () => ({ entries: [] }),
      ref: (agentId) => ({
        archive: async () => {
          archived.push(agentId);
        },
        send: async (text) => {
          sent.push({ agentId, text });
        },
        refresh: async () => undefined,
      }),
    },
  };
}

async function fireCreated(dir, agent, paseo) {
  const { handlers, server } = fakeServer();
  registerHooks(server);
  const list = handlers.get("agent.created") ?? [];
  assert.ok(list.length >= 1, "agent.created 必须有处理函数");
  await Promise.all(list.map((handler) => handler({ agent }, { paseo, signal: new AbortController().signal })));
}

const child = (dir, overrides = {}) => ({
  id: "child-1",
  cwd: dir,
  workspaceId: "ws-1",
  parentAgentId: "main-1",
  ...overrides,
});

test("主窗口开执行会话：归档，并通知主窗口走派单", async (t) => {
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir), paseo);
  assert.deepEqual(paseo.archived, ["child-1"]);
  assert.equal(paseo.sent.length, 1);
  assert.equal(paseo.sent[0].agentId, "main-1");
  assert.match(paseo.sent[0].text, /已归档/);
  assert.match(paseo.sent[0].text, /派单窗口/);
});

test("需求窗口开执行会话：同样归档，并说明只建需求票", async (t) => {
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir, { parentAgentId: "requirement-1" }), paseo);
  assert.deepEqual(paseo.archived, ["child-1"]);
  assert.match(paseo.sent[0].text, /需求窗口只建需求票/);
});

test("进度窗口开执行会话：同样归档", async (t) => {
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir, { parentAgentId: "progress-1" }), paseo);
  assert.deepEqual(paseo.archived, ["child-1"]);
  assert.match(paseo.sent[0].text, /进度窗口只旁听/);
});

test("父会话不在任何角色槽位：放行，但留一条 warn", async (t) => {
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir, { parentAgentId: "worker-1" }), paseo);
  assert.deepEqual(paseo.archived, []);
  assert.ok(
    listLogs().some((entry) => entry.level === "warn" && /认不出父会话/.test(entry.message)),
    "认不出父会话要留 warn，不能静默放行",
  );
});

test("派单窗口、执行会话、无父会话：都放行", async (t) => {
  const dir = await makeWorkspace(t);
  for (const agent of [
    child(dir, { parentAgentId: "dispatch-1" }),
    child(dir, { parentAgentId: "worker-1" }),
    child(dir, { parentAgentId: null }),
  ]) {
    const paseo = fakePaseo();
    await fireCreated(dir, agent, paseo);
    assert.deepEqual(paseo.archived, [], JSON.stringify(agent));
  }
});

test("新会话自己就是角色窗口：有父会话也不归档", async (t) => {
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir, { id: "progress-1", parentAgentId: "main-1" }), paseo);
  assert.deepEqual(paseo.archived, []);
});

test("主窗口与派单窗口是同一个会话：按派单窗口放行", async (t) => {
  const settings = {
    ...SETTINGS,
    roles: [{ workspaceId: "ws-1", mainAgentId: "main-1", dispatcherAgentId: "main-1" }],
  };
  const dir = await makeWorkspace(t, settings);
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir, { parentAgentId: "main-1" }), paseo);
  assert.deepEqual(paseo.archived, []);
});

test("编排文件读不出来：放行，不误杀", async (t) => {
  const dir = await makeWorkspace(t, "{broken");
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir), paseo);
  assert.deepEqual(paseo.archived, []);
});

test("会话没带 workspaceId 且有多条绑定：分不清就放行", async (t) => {
  const settings = {
    ...SETTINGS,
    roles: [
      { workspaceId: "ws-1", mainAgentId: "main-1", dispatcherAgentId: "dispatch-1" },
      { workspaceId: "ws-2", mainAgentId: "main-2", dispatcherAgentId: "dispatch-2" },
    ],
  };
  const dir = await makeWorkspace(t, settings);
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir, { workspaceId: null }), paseo);
  assert.deepEqual(paseo.archived, []);
});

test("会话没带 workspaceId 但只有一条绑定：按那条判定", async (t) => {
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  await fireCreated(dir, child(dir, { workspaceId: null }), paseo);
  assert.deepEqual(paseo.archived, ["child-1"]);
});
