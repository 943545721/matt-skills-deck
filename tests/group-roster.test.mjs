import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readGroupRosters, workspacesFromList } from "../server/group-roster.ts";
import { writeOrchestration } from "../server/orchestration-store.ts";

/**
 * 群成员表要按工作区列出名册。
 * 列失败、文件读失败都不能显示成「这个区没有人」。
 */

function roles(workspaceId, staff) {
  return {
    roles: [{ workspaceId, staff }],
    routing: [],
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  };
}

test("工作区列表只留有 id 和目录的行，重名 id 留第一条", () => {
  const listed = workspacesFromList({
    entries: [
      { id: " ", workspaceDirectory: "/skip" },
      { id: "a", name: "甲", workspaceDirectory: "/a" },
      { id: "a", name: "重复", workspaceDirectory: "/a2" },
      { id: "b", projectRootPath: "/b", projectDisplayName: "乙" },
      { id: "c" },
      null,
    ],
  });
  assert.deepEqual(listed, [
    { id: "a", dir: "/a", name: "甲" },
    { id: "b", dir: "/b", name: "乙" },
  ]);
});

test("没有名字时用目录最后一段，认不出的列表是空的", () => {
  assert.deepEqual(workspacesFromList(null), []);
  assert.deepEqual(workspacesFromList({ entries: "nope" }), []);
  assert.deepEqual(workspacesFromList({ entries: [{ id: "c", workspaceDirectory: "/work/丙区" }] }), [
    { id: "c", dir: "/work/丙区", name: "丙区" },
  ]);
});

test("当前工作区排在第一，每个区带自己的名册", async (t) => {
  const dirA = await mkdtemp(path.join(tmpdir(), "deck-roster-a-"));
  const dirB = await mkdtemp(path.join(tmpdir(), "deck-roster-b-"));
  t.after(() => Promise.all([rm(dirA, { recursive: true, force: true }), rm(dirB, { recursive: true, force: true })]));
  assert.equal(
    (await writeOrchestration(dirA, roles("w-a", [{ id: "staff-aaaaaa", name: "前端", kind: "worker" }]), { workspaceId: "w-a" })).ok,
    true,
  );
  assert.equal(
    (await writeOrchestration(dirB, roles("w-b", [{ id: "staff-bbbbbb", name: "后端", kind: "manager" }]), { workspaceId: "w-b" })).ok,
    true,
  );

  const read = await readGroupRosters(
    {
      workspaces: {
        list: async () => ({
          entries: [
            { id: "w-b", workspaceDirectory: dirB, name: "乙" },
            { id: "w-a", workspaceDirectory: dirA, name: "甲" },
          ],
        }),
      },
    },
    { workspaceId: "w-a", workspaceDir: dirA },
  );

  assert.deepEqual(read.warnings, []);
  assert.deepEqual(
    read.rosters.map((roster) => [roster.name, roster.current, roster.staff.map((person) => [person.staffId, person.kind])]),
    [
      ["甲", true, [["staff-aaaaaa", "worker"]]],
      ["乙", false, [["staff-bbbbbb", "manager"]]],
    ],
  );
});

test("名册文件坏了：staff 为空并写明原因，不说成这个区没有人", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-roster-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".deck"), { recursive: true });
  await writeFile(path.join(dir, ".deck", "orchestration.json"), "{ 这不是 JSON", "utf8");

  const read = await readGroupRosters(
    { workspaces: { list: async () => ({ entries: [{ id: "w-a", workspaceDirectory: dir, name: "甲" }] }) } },
    { workspaceId: "w-a", workspaceDir: dir },
  );

  assert.equal(read.rosters.length, 1);
  assert.deepEqual(read.rosters[0].staff, []);
  assert.equal(typeof read.rosters[0].detail, "string");
  assert.notEqual(read.rosters[0].detail, "");
});

test("列工作区失败：只留当前区，并在 warnings 里说明", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-roster-list-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const read = await readGroupRosters(
    { workspaces: { list: async () => { throw new Error("宿主不可达"); } } },
    { workspaceId: "w-a", workspaceDir: dir },
  );

  assert.deepEqual(read.rosters.map((roster) => roster.workspaceId), ["w-a"]);
  assert.match(read.warnings.join("\n"), /宿主不可达/);
});

test("当前区不在宿主列表里时补上，不把人从成员表里弄丢", async () => {
  const read = await readGroupRosters(
    { workspaces: { list: async () => ({ entries: [{ id: "w-b", workspaceDirectory: "/missing-b", name: "乙" }] }) } },
    { workspaceId: "w-a", workspaceDir: "/missing-a" },
  );
  assert.deepEqual(read.rosters.map((roster) => [roster.workspaceId, roster.current]), [
    ["w-a", true],
    ["w-b", false],
  ]);
});
