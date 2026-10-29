import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORK_ROUTE_STATUS_KEY,
  readWorkRoute,
  workRouteClock,
  workRouteScopeKey,
} from "../client/deck/surfaces/workRoute.ts";

/**
 * 工作路线读数（DSH `views/shared/workRouteTable.ts` 的移植）：
 * 四态分开说、作用域标清楚、时间只做本机格式化。
 */

const entry = {
  ticketKey: "owner/repo#12",
  repoKey: "owner/repo",
  number: 12,
  title: "修好登录",
  url: "https://example.test/12",
  status: "in-progress",
  agentId: "agent-1",
  createdAt: "2026-10-28T01:00:00.000Z",
  updatedAt: "2026-10-28T02:00:00.000Z",
  note: null,
};

const ledgerResult = (overrides = {}) => ({
  ok: true,
  scope: { kind: "agent", id: "agent-1", file: "/tmp/agent.json", handoffDir: "/tmp/handoffs" },
  ledger: { version: 1, updatedAt: "2026-10-28T02:00:00.000Z", entries: [entry] },
  recovered: false,
  dropped: 0,
  corruptPath: null,
  ...overrides,
});

test("读台账：有记录是 ok，空记录是 empty，两者都带作用域", async () => {
  const calls = [];
  const client = {
    rpc: async (rpc, input) => {
      calls.push({ name: rpc.name, input });
      return ledgerResult();
    },
  };
  const read = await readWorkRoute(client, { cwd: "/repo", agentId: "agent-1" });
  assert.equal(read.state, "ok");
  assert.equal(read.data.scope, "agent");
  assert.equal(read.data.entries[0].ticketKey, "owner/repo#12");
  assert.equal(calls[0].name, "deck.session.ledger");
  assert.deepEqual(calls[0].input, { cwd: "/repo", agentId: "agent-1" });

  const empty = await readWorkRoute(
    { rpc: async () => ledgerResult({ ledger: { version: 1, updatedAt: "2026-10-28T02:00:00.000Z", entries: [] } }) },
    { cwd: "/repo", agentId: null },
  );
  assert.equal(empty.state, "empty");
  assert.equal(empty.data.scope, "agent");
});

test("读台账：显式 null 原样传给服务端（强制工作区作用域）", async () => {
  let seen;
  await readWorkRoute(
    {
      rpc: async (_rpc, input) => {
        seen = input;
        return ledgerResult({ scope: { kind: "workspace", id: "repo-1", file: "/tmp/ws.json", handoffDir: "/tmp/h" } });
      },
    },
    { cwd: "/repo", agentId: null },
  );
  assert.deepEqual(seen, { cwd: "/repo", agentId: null });
});

test("读台账：RPC 失败与抛异常都归到 unreadable，并带出原因", async () => {
  const failed = await readWorkRoute(
    { rpc: async () => ({ ok: false, reason: "scope-missing", detail: "没有 cwd" }) },
    { cwd: "/repo", agentId: null },
  );
  assert.equal(failed.state, "unreadable");
  assert.match(failed.reason, /scope-missing/);
  assert.match(failed.reason, /没有 cwd/);

  const thrown = await readWorkRoute(
    {
      rpc: async () => {
        throw new Error("连接断了");
      },
    },
    { cwd: "/repo", agentId: null },
  );
  assert.equal(thrown.state, "unreadable");
  assert.equal(thrown.reason, "连接断了");

  const noDir = await readWorkRoute({ rpc: async () => assert.fail("不该发请求") }, { cwd: "", agentId: null });
  assert.equal(noDir.state, "unreadable");
  assert.match(noDir.reason, /workspace directory unknown/);
});

test("时间：同一天只写时分，跨天带月日，解析不了回空串", () => {
  const now = new Date(2026, 9, 28, 20, 0, 0).getTime();
  assert.equal(workRouteClock(new Date(2026, 9, 28, 16, 50).toISOString(), now), "16:50");
  assert.equal(workRouteClock(new Date(2026, 9, 18, 16, 50).toISOString(), now), "10-18 16:50");
  assert.equal(workRouteClock("not-a-date", now), "");
});

test("状态与作用域：每个代号都有固定文案键", () => {
  assert.deepEqual(Object.keys(WORK_ROUTE_STATUS_KEY).sort(), [
    "attached",
    "done",
    "in-progress",
    "released",
  ]);
  assert.equal(WORK_ROUTE_STATUS_KEY["in-progress"], "ledger.status.inProgress");
  assert.equal(workRouteScopeKey("agent"), "ledger.scopeAgent");
  assert.equal(workRouteScopeKey("workspace"), "ledger.scopeWorkspace");
});
