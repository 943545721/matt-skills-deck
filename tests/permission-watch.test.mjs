import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WAIT_MS, registerPermissionWatch } from "../server/permission-watch.ts";

/**
 * 「子会话在等你确认」：请求弹在子窗口里，用户坐在主窗口时看不见，
 * 会话就卡在那里、连回合结束的回传都没有。等待超时必须往主窗口发一句话；
 * 正常点掉、会话关掉的请求一条都不该发。
 */

const WAIT = 20;

function setup({ main = "agent-main", onSend, mainAgentFor } = {}) {
  const handlers = new Map();
  const sends = [];
  const server = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  registerPermissionWatch(server, {
    waitMs: WAIT,
    mainAgentFor: mainAgentFor ?? (async () => main),
  });
  const paseo = {
    agents: {
      ref: (id) => ({
        send: async (text, options) => {
          sends.push({ id, text, options });
          onSend?.(text);
        },
      }),
    },
  };
  const context = { paseo, signal: new AbortController().signal };
  return {
    sends,
    request(payload) {
      return handlers.get("agent.permission_requested")(payload, context);
    },
    resolve(agent, requestId) {
      return handlers.get("agent.permission_resolved")({ agent, requestId }, context);
    },
    archive(agent) {
      return handlers.get("agent.archived")({ agent, archivedAt: "2026-11-05T00:00:00Z" }, context);
    },
    close(agent) {
      return handlers.get("agent.closed")({ agent }, context);
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const child = {
  id: "agent-child",
  parentAgentId: "agent-dispatch",
  workspaceId: "ws-1",
  cwd: "/repo",
  provider: "claude",
  title: "岗位表单：领地必填",
};

const permission = {
  id: "req-1",
  kind: "tool",
  name: "Write",
  detail: { type: "write", filePath: "client/deck/staff-draft.ts" },
};

test("子会话的确认等久了，主窗口收到一句话", async () => {
  const { sends, request } = setup();
  await request({ agent: child, request: permission });
  assert.equal(sends.length, 0, "刚发出时不该打扰主窗口");

  await sleep(WAIT * 4);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].id, "agent-main");
  assert.match(sends[0].text, /【等你确认】/);
  assert.match(sends[0].text, /岗位表单：领地必填/);
  assert.match(sends[0].text, /Write client\/deck\/staff-draft\.ts/);
});

test("点在等待时长内解决，主窗口一条都不收", async () => {
  const { sends, request, resolve } = setup();
  await request({ agent: child, request: permission });
  resolve(child, permission.id);

  await sleep(WAIT * 4);
  assert.deepEqual(sends, []);
});

test("会话归档或关闭后不再提醒：宿主不会为它发 resolved", async () => {
  for (const end of ["archive", "close"]) {
    const { sends, request, archive, close } = setup();
    await request({ agent: child, request: permission });
    (end === "archive" ? archive : close)(child);

    await sleep(WAIT * 4);
    assert.deepEqual(sends, [], `${end} 之后不该再发【等你确认】`);
  }
});

test("查主窗口的这几毫秒里用户点掉了，就不再发", async () => {
  let resolvedDuringLookup = false;
  const { sends, request, resolve } = setup({
    mainAgentFor: async () => {
      // 模拟「正在读编排配置」时宿主送来了 resolved。
      if (!resolvedDuringLookup) {
        resolvedDuringLookup = true;
        resolve(child, permission.id);
      }
      return "agent-main";
    },
  });

  await request({ agent: child, request: permission });
  await sleep(WAIT * 4);
  assert.deepEqual(sends, []);
});

test("同一条请求被重复上报，只提醒一次", async () => {
  const { sends, request } = setup();
  await request({ agent: child, request: permission });
  await request({ agent: child, request: permission });

  await sleep(WAIT * 4);
  assert.equal(sends.length, 1);
});

test("主窗口自己的确认不提醒，它本来就弹在用户眼前", async () => {
  const { sends, request } = setup();
  await request({ agent: { ...child, id: "agent-main", parentAgentId: null }, request: permission });

  await sleep(WAIT * 4);
  assert.deepEqual(sends, []);
});

test("没配主沟通窗口时不发，也不报错", async () => {
  const { sends, request } = setup({ main: null });
  await request({ agent: child, request: permission });

  await sleep(WAIT * 4);
  assert.deepEqual(sends, []);
});

test("主窗口就是这支会话时不给自己发", async () => {
  const { sends, request } = setup({ main: child.id });
  await request({ agent: child, request: permission });

  await sleep(WAIT * 4);
  assert.deepEqual(sends, []);
});

test("发送失败只记日志，不把插件带崩", async () => {
  const { sends, request } = setup({
    onSend: () => {
      throw new Error("parent gone");
    },
  });
  await request({ agent: child, request: permission });

  await sleep(WAIT * 4);
  assert.equal(sends.length, 1);
});

test("shell 确认只写种类，不回显命令原文", async () => {
  const { sends, request } = setup();
  await request({
    agent: child,
    request: {
      id: "req-2",
      kind: "tool",
      name: "Bash",
      detail: { type: "shell", command: "curl -H 'Authorization: Bearer sk-secret' example.com" },
    },
  });

  await sleep(WAIT * 4);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /tool\/Bash/);
  assert.doesNotMatch(sends[0].text, /sk-secret|curl/);
});

test("默认等待时长是 45 秒", () => {
  assert.equal(DEFAULT_WAIT_MS, 45_000);
});
