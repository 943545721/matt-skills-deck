import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDispatchHandoffRelay } from "../server/dispatch-handoff-relay.ts";
import { registerDeliveryQueue, resetDeliveryQueueForTest } from "../server/delivery.ts";
import {
  handoffBoxDirOf,
  listPendingHandoffs,
  writePendingHandoff,
} from "../server/dispatch-handoff-store.ts";

/**
 * relay 是 outbox 的出口：每次投递前重新解析派单窗口，送达才搬家。
 * 用例覆盖「送出去」「没绑窗口先留着」「换窗口按新的送」「送不到计数」。
 */

async function workspace(t, settings) {
  const dir = await mkdtemp(join(tmpdir(), "deck-handoff-relay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  if (settings) await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings), "utf8");
  return dir;
}

function settings(overrides = {}) {
  return {
    version: 1,
    updatedAt: "2026-11-05T00:00:00.000Z",
    workspaceId: "ws1",
    roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "dispatch-1" }],
    routing: [],
    maxDepth: 3,
    maxChildrenPerDispatch: 2,
    reportOnFinish: true,
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    version: 1,
    handoffId: "0123456789abcdef",
    createdAt: "2026-11-05T00:00:00.000Z",
    workspaceId: "ws1",
    mainAgentId: "main-1",
    requirementKey: 38,
    summary: "补岗位领地",
    tasks: [{ prompt: "改派单闸" }],
    lang: "zh",
    attempts: 0,
    ...overrides,
  };
}

function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    server: {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    },
  };
}

const context = { paseo: { agents: {} } };

async function fire(handlers, event, agent, eventContext = context) {
  const list = handlers.get(event) ?? [];
  assert.ok(list.length > 0, `${event} 必须注册`);
  await Promise.all(list.map((handler) => handler({ agent }, eventContext)));
}

async function waitFor(check, label) {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等不到：${label}`);
}

test("回合结束：把件送进绑定的派单窗口，送达后移到 sent/", async (t) => {
  const dir = await workspace(t, settings());
  await writePendingHandoff(dir, envelope());
  const { handlers, server } = fakeServer();
  const deliveries = [];
  registerDispatchHandoffRelay(server, {
    deliver: async (_paseo, agentId, text, options) => {
      deliveries.push({ agentId, text });
      options.onDelivered?.();
    },
  });
  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => (await listPendingHandoffs(dir)).length === 0, "件被移出 pending");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].agentId, "dispatch-1");
  assert.match(deliveries[0].text, /handoffId: 0123456789abcdef/);
  assert.match(deliveries[0].text, /需求：#38/);
  await readFile(join(handoffBoxDirOf(dir, "sent"), "0123456789abcdef.json"), "utf8");
});

test("没有派单窗口：件留在 pending，绑定后补送", async (t) => {
  const dir = await workspace(t, settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1" }] }));
  await writePendingHandoff(dir, envelope());
  const { handlers, server } = fakeServer();
  const deliveries = [];
  registerDispatchHandoffRelay(server, {
    deliver: async (_paseo, agentId, text, options) => {
      deliveries.push({ agentId, text });
      options.onDelivered?.();
    },
  });
  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(deliveries.length, 0);
  assert.equal((await listPendingHandoffs(dir)).length, 1);

  // 用户在面板里绑上派单窗口，下一次建会话补送。
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify(settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "dispatch-2" }] })),
    "utf8",
  );
  await fire(handlers, "agent.created", { cwd: dir });
  await waitFor(async () => (await listPendingHandoffs(dir)).length === 0, "绑定后补送");
  assert.equal(deliveries[0].agentId, "dispatch-2");
});

test("每次投递前重新解析：换了派单窗口不按旧 id 送", async (t) => {
  const dir = await workspace(t, settings());
  await writePendingHandoff(dir, envelope());
  const { handlers, server } = fakeServer();
  const deliveries = [];
  registerDispatchHandoffRelay(server, {
    deliver: async (_paseo, agentId, _text, options) => {
      deliveries.push(agentId);
      options.onDelivered?.();
    },
  });
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify(settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "dispatch-new" }] })),
    "utf8",
  );
  await fire(handlers, "agent.created", { cwd: dir });
  await waitFor(async () => deliveries.length === 1, "投递一次");
  assert.deepEqual(deliveries, ["dispatch-new"]);
});

test("投递失败：件留在 pending 并累计 attempts", async (t) => {
  const dir = await workspace(t, settings());
  await writePendingHandoff(dir, envelope());
  const { handlers, server } = fakeServer();
  registerDispatchHandoffRelay(server, {
    deliver: async (_paseo, _agentId, _text, options) => {
      options.onDropped?.("closed");
    },
  });
  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => {
    const [pending] = await listPendingHandoffs(dir);
    return pending?.attempts === 1;
  }, "attempts 增加");
  assert.equal((await listPendingHandoffs(dir)).length, 1);
});

test("直发失败只记一次 attempts：onDropped 记过，catch 不再重复", async (t) => {
  const dir = await workspace(t, settings());
  await writePendingHandoff(dir, envelope());
  const { handlers, server } = fakeServer();
  registerDispatchHandoffRelay(server, {
    deliver: async (_paseo, _agentId, _text, options) => {
      options.onDropped?.("窗口没了");
      throw new Error("窗口没了");
    },
  });
  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => (await listPendingHandoffs(dir))[0]?.attempts === 1, "attempts 记一次");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await listPendingHandoffs(dir))[0]?.attempts, 1, "同一次失败不能算两回");
});

test("派单窗口与主窗口是同一个会话：没有收件人，移进 failed/", async (t) => {
  const dir = await workspace(t, settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "main-1" }] }));
  await writePendingHandoff(dir, envelope());
  const { handlers, server } = fakeServer();
  registerDispatchHandoffRelay(server, { deliver: async () => assert.fail("不该投递") });
  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => (await listPendingHandoffs(dir)).length === 0, "件被移走");
  await readFile(join(handoffBoxDirOf(dir, "failed"), "0123456789abcdef.json"), "utf8");
});

test("派单窗口在忙：件留在 pending 排队，空下来再送", async (t) => {
  const dir = await workspace(t, settings());
  await writePendingHandoff(dir, envelope());
  const { handlers, server } = fakeServer();
  registerDispatchHandoffRelay(server);
  registerDeliveryQueue(server);
  t.after(() => resetDeliveryQueueForTest());

  const state = { status: "running", sends: [] };
  const paseo = {
    agents: {
      list: async () => ({
        entries: [{ agent: { id: "dispatch-1", status: state.status, attentionReason: null } }],
      }),
      ref: () => ({ send: async (text) => state.sends.push(text) }),
    },
  };
  const eventContext = { paseo };

  // 事件里的 agent 要带 id：投递队列的 turn_ended handler 靠它 flush 对应窗口的队列。
  await fire(handlers, "agent.turn_ended", { cwd: dir, id: "dispatch-1" }, eventContext);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(state.sends, [], "忙的时候不硬塞");
  assert.equal((await listPendingHandoffs(dir)).length, 1);

  state.status = "idle";
  await fire(handlers, "agent.turn_ended", { cwd: dir, id: "dispatch-1" }, eventContext);
  await waitFor(async () => (await listPendingHandoffs(dir)).length === 0, "空下来后送出并移出 pending");
  assert.equal(state.sends.length, 1, "同一份交接件只送一次");
  assert.match(state.sends[0], /handoffId: 0123456789abcdef/);
});

test("编排文件读不出来：不猜窗口，件原样留着", async (t) => {
  const dir = await workspace(t, null);
  await writePendingHandoff(dir, envelope());
  await writeFile(join(dir, ".deck", "orchestration.json"), "{broken", "utf8");
  const { handlers, server } = fakeServer();
  registerDispatchHandoffRelay(server, { deliver: async () => assert.fail("不该投递") });
  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await listPendingHandoffs(dir)).length, 1);
});
