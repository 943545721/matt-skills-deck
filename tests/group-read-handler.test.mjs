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

test("群成员按目录标签读：换 id 打开还是同一个群，改了格式之前建的会话也还在", async () => {
  const dir = await ws();
  const agent = (id, group, staffId) => ({
    agent: { id, title: "", status: "idle", labels: { "deck.group": group, "deck.staff": staffId } },
  });
  const all = [
    agent("a-dir", path.resolve(dir), "staff-aaaaaa"),
    // 改格式之前建的会话，标签写的是当时的 workspaceId（就是这次打开的这个 id）。
    agent("a-legacy", "w-new", "staff-aaaaaa"),
    // 别的目录的群：标签值不是这个目录，一条都不能进来。
    agent("a-elsewhere", "/somewhere/else", "staff-bbbbbb"),
  ];
  const asked = [];
  const context = {
    paseo: {
      agents: {
        list: async (options) => {
          const key = options.filter.labels["deck.group"];
          asked.push(key);
          return { entries: all.filter((entry) => entry.agent.labels["deck.group"] === key) };
        },
      },
    },
  };

  const read = await groupReadHandler({ workspaceId: "w-new", workspaceDir: dir }, context);

  assert.equal(read.ok, true);
  assert.deepEqual(
    read.members.map((member) => member.agentId).sort(),
    ["a-dir", "a-legacy"],
    "目录标签 + 旧 id 标签都要读，别的目录的会话不能混进来",
  );
  assert.deepEqual(asked.sort(), ["w-new", path.resolve(dir)].sort());
});

test("目录写成带尾斜杠：群 key 还是同一个目录，不会算成两个群", async () => {
  const dir = await ws();
  const asked = [];
  const context = {
    paseo: {
      agents: {
        list: async (options) => {
          asked.push(options.filter.labels["deck.group"]);
          return { entries: [] };
        },
      },
    },
  };

  await groupReadHandler({ workspaceId: "w-new", workspaceDir: `${dir}/` }, context);

  assert.equal(asked[0], path.resolve(dir), "带尾斜杠也要落到同一个 key");
  assert.notEqual(asked[0], `${dir}/`, "key 不能是原样的字符串：读写两边必须算出同一个值");
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

test("一个项目一个群：只读本目录的名册与对话，别的目录的人与话都不进来", async () => {
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

  const read = await groupReadHandler({ workspaceId: "w-a", workspaceDir: dirA }, contextOf(async () => ({ entries: [] })));

  assert.equal(read.ok, true);
  assert.deepEqual(
    read.roster.staff.map((person) => [person.name, person.kind]),
    [["前端", "worker"]],
    "名册只有本目录这一份：右栏列的是本群的人，没有别的项目的人可点",
  );
  assert.deepEqual(
    read.records.map((record) => record.text),
    ["甲后说"],
    "乙那边的「乙先说」属于另一个项目，不能出现在甲的群里",
  );
});

test("同一目录换了个 workspaceId 打开：两个 id 的群记录都要在，按时间排", async () => {
  const dir = await ws();
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const later = new Date().toISOString();
  await appendGroup(dir, "w-old", { at: earlier, from: "你", agentId: "", kind: "user", text: "昨天那句" });
  await appendGroup(dir, "w-new", { at: later, from: "你", agentId: "", kind: "user", text: "今天这句" });

  const read = await groupReadHandler({ workspaceId: "w-new", workspaceDir: dir }, contextOf(async () => ({ entries: [] })));

  assert.equal(read.ok, true);
  assert.deepEqual(read.records.map((record) => record.text), ["昨天那句", "今天这句"]);
});

test("工作区参数缺失时明确拒绝", async () => {
  const dir = await ws();
  const read = await groupReadHandler({ workspaceId: " ", workspaceDir: dir }, contextOf(async () => ({ entries: [] })));
  assert.equal(read.ok, false);
  assert.equal(read.reason, "invalid-workspace");
});
