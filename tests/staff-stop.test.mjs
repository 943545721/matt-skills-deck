import assert from "node:assert/strict";
import { test } from "node:test";
import { DECK_STAFF_LABEL } from "../shared/staff.ts";
import { stopStaffSessions, STOP_MESSAGE } from "../server/staff-stop.ts";

/**
 * 阀门四：全停。
 *
 * 这一段以前只有 RPC 没有入口，也没有一条单测。现在角色页有了按钮，钉住四件事：
 * 1. 只动「本工作区 + 带岗位标 + 没归档」的会话，别人的会话一根手指都不碰；
 * 2. 三件事都要发生：撤掉的权限、打断在跑的轮次、可选归档；
 * 3. 一个会话失败不影响其它会话停手，失败原因逐条带出来；
 * 4. 输入 / 读清单失败要明确报错，不是「停了 0 个」。
 */

function agent(overrides = {}) {
  return {
    id: "agent-1",
    workspaceId: "ws-1",
    status: "idle",
    archivedAt: null,
    labels: { [DECK_STAFF_LABEL]: "staff-back" },
    pendingPermissions: [],
    ...overrides,
  };
}

/** 宿主替身：把每条会话的三个动作各记一笔；`failOn` 里的 id 会在对应动作上抛错。 */
function fakePaseo(agents, { listError, failOn = {} } = {}) {
  const calls = [];
  return {
    calls,
    agents: {
      list: async (options) => {
        if (listError) throw new Error(listError);
        calls.push({ action: "list", options });
        return { entries: agents.map((item) => ({ agent: item })) };
      },
      ref: (agentId) => ({
        respondToPermission: async ({ requestId, response }) => {
          calls.push({ action: "deny", agentId, requestId, response });
          if (failOn.deny === agentId) throw new Error("权限已经被宿主收走了");
        },
        send: async (message, options) => {
          calls.push({ action: "send", agentId, message, options });
          if (failOn.send === agentId) throw new Error("会话已经结束");
        },
        archive: async () => {
          calls.push({ action: "archive", agentId });
          if (failOn.archive === agentId) throw new Error("归档失败");
        },
      }),
    },
  };
}

const denyCalls = (paseo) => paseo.calls.filter((call) => call.action === "deny");
const sendCalls = (paseo) => paseo.calls.filter((call) => call.action === "send");
const archiveCalls = (paseo) => paseo.calls.filter((call) => call.action === "archive");

test("全停：只动本工作区带岗位标的活会话，撤权限并打断在跑的那一轮", async () => {
  const paseo = fakePaseo([
    agent({ id: "staff-1", status: "running", pendingPermissions: [{ id: "perm-1" }, { id: "perm-2" }] }),
    // 不在本工作区 / 没有岗位标 / 已归档：三种都不该被碰。
    agent({ id: "other-ws", workspaceId: "ws-2", status: "running" }),
    agent({ id: "no-label", labels: {}, status: "running" }),
    agent({ id: "archived", archivedAt: "2026-11-01T00:00:00.000Z", status: "running" }),
  ]);

  const result = await stopStaffSessions(paseo, { workspaceId: "ws-1", workspaceDir: "/tmp/ws-1" });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 1);
  assert.equal(result.denied, 2);
  assert.equal(result.interrupted, 1);
  assert.equal(result.archived, 0);
  assert.deepEqual(result.failures, []);

  assert.deepEqual(paseo.calls[0].options, { filter: { includeArchived: false } });
  assert.deepEqual(
    denyCalls(paseo).map((call) => call.requestId),
    ["perm-1", "perm-2"],
  );
  for (const call of denyCalls(paseo)) {
    assert.deepEqual(call.response, { behavior: "deny", interrupt: true, message: "用户按了全停" });
  }
  assert.equal(sendCalls(paseo).length, 1);
  assert.equal(sendCalls(paseo)[0].message, STOP_MESSAGE);
  // 不打断 = 没有可断的轮次；措辞也得是「打断」而不是「结束会话」。
  assert.deepEqual(sendCalls(paseo)[0].options, { activeTurnBehavior: "interrupt" });
  assert.equal(archiveCalls(paseo).length, 0, "默认不归档，还能接着看它做到哪");
});

test("全停：不在跑的会话不发打断消息，但权限照样撤", async () => {
  const paseo = fakePaseo([
    agent({ id: "idle-1", status: "idle", pendingPermissions: [{ id: "perm-1" }] }),
  ]);
  const result = await stopStaffSessions(paseo, { workspaceId: "ws-1", workspaceDir: "/tmp/ws-1" });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 1);
  assert.equal(result.denied, 1);
  assert.equal(result.interrupted, 0);
  assert.equal(sendCalls(paseo).length, 0);
});

test("全停：archive 为真才归档", async () => {
  const paseo = fakePaseo([agent({ id: "staff-1" }), agent({ id: "staff-2" })]);
  const result = await stopStaffSessions(paseo, {
    workspaceId: "ws-1",
    workspaceDir: "/tmp/ws-1",
    archive: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.archived, 2);
  assert.deepEqual(archiveCalls(paseo).map((call) => call.agentId).sort(), ["staff-1", "staff-2"]);
});

test("全停：一个会话失败不挡其它会话，失败原因逐条带出来", async () => {
  const paseo = fakePaseo(
    [
      agent({ id: "bad-perm", pendingPermissions: [{ id: "perm-1" }] }),
      agent({ id: "bad-send", status: "running" }),
      agent({ id: "bad-archive" }),
      agent({ id: "good", status: "running", pendingPermissions: [{ id: "perm-2" }] }),
    ],
    { failOn: { deny: "bad-perm", send: "bad-send", archive: "bad-archive" } },
  );

  const result = await stopStaffSessions(paseo, {
    workspaceId: "ws-1",
    workspaceDir: "/tmp/ws-1",
    archive: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 4);
  assert.equal(result.denied, 1, "只有 good 那条撤成功了");
  assert.equal(result.interrupted, 1);
  assert.equal(result.archived, 3, "只有 bad-archive 归档失败");
  assert.equal(result.failures.length, 3);
  assert.ok(result.failures.some((line) => line.includes("bad-perm") && line.includes("撤权限失败")));
  assert.ok(result.failures.some((line) => line.includes("bad-send") && line.includes("打断失败")));
  assert.ok(result.failures.some((line) => line.includes("bad-archive") && line.includes("归档失败")));
  // 好的那条仍然被完整停手。
  assert.ok(sendCalls(paseo).some((call) => call.agentId === "good"));
  assert.ok(denyCalls(paseo).some((call) => call.agentId === "good" && call.requestId === "perm-2"));
});

test("全停：空工作区 / 读不到会话清单都明确报错，不当成「停了 0 个」", async () => {
  const empty = await stopStaffSessions(fakePaseo([]), { workspaceId: "  ", workspaceDir: "/tmp/ws-1" });
  assert.deepEqual(empty, { ok: false, reason: "invalid-workspace", detail: "需要工作区 id" });

  const broken = await stopStaffSessions(fakePaseo([], { listError: "daemon 不在" }), {
    workspaceId: "ws-1",
    workspaceDir: "/tmp/ws-1",
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "agents-failed");
  assert.match(broken.detail, /daemon 不在/);
});
