import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWindowNoteRelay } from "../server/window-note-relay.ts";
import {
  MAX_WINDOW_NOTE_ATTEMPTS,
  listPendingWindowNotes,
  windowNoteBoxDirOf,
  writeWindowNote,
} from "../server/window-note-store.ts";
import { WINDOW_NOTE_VERSION, windowNoteId } from "../shared/window-note.ts";

/**
 * 条子 relay：派单窗口被拒之后，插件自己把话递给需求窗口。
 * 用例只关心三件事：递给绑定的人、没绑就留着、送达才搬家。
 */

async function workspace(t, settings) {
  const dir = await mkdtemp(join(tmpdir(), "deck-window-note-relay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  if (settings) await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings), "utf8");
  return dir;
}

function settings(overrides = {}) {
  return {
    version: 1,
    updatedAt: "2026-11-06T00:00:00.000Z",
    workspaceId: "ws1",
    roles: [
      { workspaceId: "ws1", mainAgentId: "main-1", requirementAgentId: "requirement-1", dispatcherAgentId: "dispatch-1" },
    ],
    routing: [],
    maxDepth: 3,
    maxChildrenPerDispatch: 2,
    reportOnFinish: true,
    ...overrides,
  };
}

function note(overrides = {}) {
  const createdAt = "2026-11-06T05:00:00.000Z";
  return {
    version: WINDOW_NOTE_VERSION,
    noteId: windowNoteId({ reason: "bad-impact", detail: "表头不对", requirementKey: 60, at: createdAt }),
    createdAt,
    workspaceId: "ws1",
    fromAgentId: "dispatch-1",
    toRole: "requirement",
    requirementKey: 60,
    reason: "bad-impact",
    detail: "影响面表头第 2 列应该是「依据」，这里是「仓库」。",
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

async function fire(handlers, event, agent) {
  const list = handlers.get(event) ?? [];
  assert.ok(list.length > 0, `${event} 必须注册`);
  await Promise.all(list.map((handler) => handler({ agent }, context)));
}

async function waitFor(check, label) {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等不到：${label}`);
}

/** 反复敲事件，直到条子的 attempts 累计到 `target`（或它已经搬出 pending）。 */
async function pumpUntil(handlers, dir, target) {
  for (let index = 0; index < 200; index += 1) {
    const pending = await listPendingWindowNotes(dir);
    if (pending.length === 0 || pending[0].attempts >= target) return;
    await fire(handlers, "agent.turn_ended", { cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等不到：第 ${target} 次失败被记下`);
}

function relayWith(deliveries, onDrop, extra = {}) {
  const { handlers, server } = fakeServer();
  registerWindowNoteRelay(server, {
    // 默认把最小重试间隔关掉：这些用例要的是「每一次事件都真的去投一次」。
    retryDelayMs: 0,
    ...extra,
    deliver: async (_paseo, agentId, text, options) => {
      deliveries.push({ agentId, text });
      if (onDrop) options.onDropped?.(onDrop);
      else options.onDelivered?.();
    },
  });
  return handlers;
}

test("回合结束：条子送进绑定的需求窗口，送达后移到 sent/", async (t) => {
  const dir = await workspace(t, settings());
  const pending = note();
  await writeWindowNote(dir, pending);
  const deliveries = [];
  const handlers = relayWith(deliveries);

  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => (await listPendingWindowNotes(dir)).length === 0, "条子被移出 pending");

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].agentId, "requirement-1", "收件人是需求窗口，不是派单窗口");
  assert.match(deliveries[0].text, /#60/);
  assert.match(deliveries[0].text, /影响面表头第 2 列/);
  await readFile(join(windowNoteBoxDirOf(dir, "sent"), `${pending.noteId}.json`), "utf8");
});

test("没绑需求窗口：条子留在 pending，绑上之后由建会话补送", async (t) => {
  const dir = await workspace(t, settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "dispatch-1" }] }));
  await writeWindowNote(dir, note());
  const deliveries = [];
  const handlers = relayWith(deliveries);

  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(deliveries.length, 0);
  assert.equal((await listPendingWindowNotes(dir)).length, 1, "没有收件人时不能把条子丢掉");

  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify(settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1", requirementAgentId: "requirement-2", dispatcherAgentId: "dispatch-1" }] })),
    "utf8",
  );
  await fire(handlers, "agent.created", { cwd: dir });
  await waitFor(async () => (await listPendingWindowNotes(dir)).length === 0, "绑定后补送");
  assert.equal(deliveries[0].agentId, "requirement-2");
});

test("送不出去先留在队列里重试，累计到上限才进 failed/ 并留日志", async (t) => {
  const dir = await workspace(t, settings());
  const pending = note();
  await writeWindowNote(dir, pending);
  const handlers = relayWith([], "需求窗口不在线");

  // 第一下失败：只记一次 attempts，条子还在 pending——需求窗口只是这一会儿没开，
  // 一次送不到就丢，等于让人再也不会知道票坏在哪。
  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => (await listPendingWindowNotes(dir))[0]?.attempts === 1, "记下一次投递失败");
  assert.equal((await listPendingWindowNotes(dir))[0].noteId, pending.noteId);

  // 再失败几次就到上限：此时才搬进 failed/。
  // 每轮都「看一眼计数、再敲一次事件」：上一轮还没从投递队列里退出来的话，
  // 那一下会被 inFlight 挡掉，于是这一轮就该再敲——真实环境里下一次回合也会这样补上。
  for (let target = 2; target <= MAX_WINDOW_NOTE_ATTEMPTS; target += 1) {
    await pumpUntil(handlers, dir, target);
  }
  await waitFor(async () => (await listPendingWindowNotes(dir)).length === 0, "条子被移出 pending");
  await readFile(join(windowNoteBoxDirOf(dir, "failed"), `${pending.noteId}.json`), "utf8");
});

test("收件人就是发件人：不自己发给自己，条子进 failed/", async (t) => {
  const dir = await workspace(t, settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1", requirementAgentId: "dispatch-1", dispatcherAgentId: "dispatch-1" }] }));
  await writeWindowNote(dir, note());
  const deliveries = [];
  const handlers = relayWith(deliveries);

  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => (await listPendingWindowNotes(dir)).length === 0, "条子被移出 pending");
  assert.equal(deliveries.length, 0);
});

test("重试留最小间隔：事件来得再密，也不会几秒就把五次烧光", async (t) => {
  const dir = await workspace(t, settings());
  await writeWindowNote(dir, note());
  const handlers = relayWith([], "需求窗口不在线", { retryDelayMs: 60_000 });

  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => (await listPendingWindowNotes(dir))[0]?.attempts === 1, "第一次失败记下");

  // 紧接着连续几个事件：都该被间隔挡住，条子还在 pending、计数不再涨。
  for (let index = 0; index < 3; index += 1) {
    await fire(handlers, "agent.turn_ended", { cwd: dir });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const still = await listPendingWindowNotes(dir);
  assert.equal(still.length, 1);
  assert.equal(still[0].attempts, 1, "间隔之内的重试不算次数");
  assert.ok(still[0].lastAttemptAt.length > 0, "失败时刻要落盘，否则下次就没法判间隔");
  assert.equal(still[0].lastAttemptReceiver, "requirement-1", "失败记的是投给哪个窗口，间隔只压同一路");
});

test("换绑到新窗口不受旧间隔按住：刚失败过的条子照样立刻补送", async (t) => {
  const dir = await workspace(t, settings());
  await writeWindowNote(dir, note());
  const deliveries = [];
  const { handlers, server } = fakeServer();
  registerWindowNoteRelay(server, {
    retryDelayMs: 60_000,
    deliver: async (_paseo, agentId, text, options) => {
      // 需求窗口当时没开：每次投递都失败，直到换成另一个窗口。
      if (agentId === "requirement-1") options.onDropped?.("需求窗口不在线");
      else {
        deliveries.push({ agentId, text });
        options.onDelivered?.();
      }
    },
  });

  await fire(handlers, "agent.turn_ended", { cwd: dir });
  await waitFor(async () => (await listPendingWindowNotes(dir))[0]?.attempts === 1, "第一次失败记下");
  assert.equal(deliveries.length, 0);

  // 10 秒后建出新窗口并绑上：这不是「同一个收件人重试」，间隔不该把这次补送吞掉。
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify(settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1", requirementAgentId: "requirement-2", dispatcherAgentId: "dispatch-1" }] })),
    "utf8",
  );
  await fire(handlers, "agent.created", { cwd: dir });
  await waitFor(async () => (await listPendingWindowNotes(dir)).length === 0, "换绑后立刻补送");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].agentId, "requirement-2");
});
