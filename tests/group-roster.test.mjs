import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readGroupRoster } from "../server/group-roster.ts";
import { writeOrchestration } from "../server/orchestration-store.ts";

/**
 * 本群名册 = **这一个目录**那一份，不多不少。
 *
 * 一个项目一个群：宿主里别的目录是别的项目，它们的名册不属于这个群。
 * 读失败不能显示成「这个群没有人」——那会让人以为卡没了，实际只是文件读不出来。
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

test("只读这个目录的名册：宿主里别的目录的人一条也不列", async (t) => {
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

  const read = await readGroupRoster(dirA);

  assert.deepEqual(read, { staff: [{ staffId: "staff-aaaaaa", name: "前端", kind: "worker" }] });
});

test("同一目录攒了几个 workspaceId：卡合起来，就是这个群的人", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-roster-ids-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stored = await writeOrchestration(
    dir,
    {
      roles: [
        { workspaceId: "wks_new", dispatcherAgentId: "d-new" },
        { workspaceId: "wks_old", staff: [{ id: "staff-cccccc", name: "后端", kind: "manager" }] },
      ],
      routing: [],
      maxDepth: 3,
      maxChildrenPerDispatch: 4,
      reportOnFinish: true,
    },
    { workspaceId: "wks_new" },
  );
  assert.equal(stored.ok, true);

  const read = await readGroupRoster(dir);

  assert.deepEqual(read.staff.map((person) => person.staffId), ["staff-cccccc"]);
});

test("名册文件坏了：staff 为空并写明原因，不说成这个群没有人", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-roster-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".deck"), { recursive: true });
  await writeFile(path.join(dir, ".deck", "orchestration.json"), "{ 这不是 JSON", "utf8");

  const read = await readGroupRoster(dir);

  assert.deepEqual(read.staff, []);
  assert.equal(typeof read.detail, "string");
  assert.notEqual(read.detail, "");
});

test("目录里还没有编排设置：staff 为空，但不是读失败", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-roster-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const read = await readGroupRoster(dir);

  assert.deepEqual(read.staff, []);
  assert.equal(read.detail, undefined);
});
