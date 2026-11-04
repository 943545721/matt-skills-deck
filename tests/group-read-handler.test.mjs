import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { groupReadHandler } from "../server/rpc/group.ts";
import { appendGroup } from "../server/group-store.ts";
import { writeOrchestration } from "../server/orchestration-store.ts";

const ws = () => mkdtemp(path.join(os.tmpdir(), "deck-group-read-"));

function contextOf(list) {
  return { paseo: { agents: { list } } };
}

test("群成员按 deck.group 标签读入（含归档），消息按 oldest→newest 返回", async () => {
  const dir = await ws();
  const listed = {
    entries: [
      {
        agent: {
          id: "a1",
          title: "前端 · 登录页",
          status: "running",
          labels: { "deck.group": "w1", "deck.staff": "staff-aaaaaa" },
        },
      },
      {
        agent: {
          id: "a2",
          title: "旧会话",
          status: "closed",
          archivedAt: "2026-01-01T00:00:00Z",
          labels: { "deck.group": "w1", "deck.staff": "staff-bbbbbb" },
        },
      },
    ],
  };
  await appendGroup(dir, "w1", { at: "2026-01-01T00:00:00Z", from: "你", agentId: "", kind: "user", text: "开工" }, { now: "2026-01-02T00:00:00Z" });

  const read = await groupReadHandler(
    { workspaceId: "w1", workspaceDir: dir },
    contextOf(async () => listed),
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.members.map((member) => [member.agentId, member.staffId, member.archived]), [
    ["a1", "staff-aaaaaa", false],
    ["a2", "staff-bbbbbb", true],
  ]);
  assert.deepEqual(read.records.map((record) => record.text), ["开工"]);
});

test("宿主列表失败时仍回群记录，并给 warning（不是 Unknown RPC / 崩掉）", async () => {
  const dir = await ws();
  const read = await groupReadHandler(
    { workspaceId: "w1", workspaceDir: dir },
    contextOf(async () => {
      throw new Error("宿主不可达");
    }),
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.members, []);
  assert.match(read.warnings.join("\n"), /宿主不可达/);
});

test("成员表按工作区分组，当前区在前；两边的群记录按时间并成一份", async () => {
  const dirA = await ws();
  const dirB = await ws();
  const roles = (workspaceId, staff) => ({
    roles: [{ workspaceId, staff }],
    routing: [],
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  assert.equal(
    (await writeOrchestration(dirA, roles("w-a", [{ id: "staff-aaaaaa", name: "前端", kind: "worker" }]), { workspaceId: "w-a" })).ok,
    true,
  );
  assert.equal(
    (await writeOrchestration(dirB, roles("w-b", [{ id: "staff-bbbbbb", name: "后端", kind: "manager" }]), { workspaceId: "w-b" })).ok,
    true,
  );
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const later = new Date().toISOString();
  await appendGroup(dirB, "w-b", { at: earlier, from: "你", agentId: "", kind: "user", text: "乙先说" });
  await appendGroup(dirA, "w-a", { at: later, from: "你", agentId: "", kind: "user", text: "甲后说" });

  const read = await groupReadHandler(
    { workspaceId: "w-a", workspaceDir: dirA },
    {
      paseo: {
        agents: { list: async () => ({ entries: [] }) },
        workspaces: {
          list: async () => ({
            entries: [
              { id: "w-b", workspaceDirectory: dirB, name: "乙" },
              { id: "w-a", workspaceDirectory: dirA, name: "甲" },
            ],
          }),
        },
      },
    },
  );

  assert.equal(read.ok, true);
  assert.deepEqual(
    read.rosters.map((roster) => [roster.workspaceId, roster.current, roster.staff.map((person) => [person.name, person.kind])]),
    [
      ["w-a", true, [["前端", "worker"]]],
      ["w-b", false, [["后端", "manager"]]],
    ],
  );
  assert.deepEqual(
    read.records.map((record) => [record.text, record.workspaceName]),
    [
      ["乙先说", "乙"],
      ["甲后说", "甲"],
    ],
  );
});

test("工作区参数缺失时明确拒绝", async () => {
  const dir = await ws();
  const read = await groupReadHandler({ workspaceId: " ", workspaceDir: dir }, contextOf(async () => ({ entries: [] })));
  assert.equal(read.ok, false);
  assert.equal(read.reason, "invalid-workspace");
});
