import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveOrchestration } from "../server/orchestration.ts";
import { readOrchestration, writeOrchestration } from "../server/orchestration-store.ts";
import {
  describeStaffTerritoryProblems,
  staffTerritoryProblems,
} from "../shared/staff.ts";

/**
 * 名册保存时的领地校验。
 *
 * 守三件事：新增 / 改过的卡必须填真实存在的领地；`.` 表示整片、不碰文件系统；
 * 没动过的老卡不连累一次与它无关的保存（老卡由派单闸拦，不在这里越权）。
 */

const card = (id, name, paths, extra = {}) => ({
  id,
  name,
  ...(paths === undefined ? {} : { paths }),
  ...extra,
});

async function makeWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-staff-territory-save-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "index.ts"), "", "utf8");
  return dir;
}

const settings = (staff, extra = {}) => ({
  roles: [{ workspaceId: "ws-1", staff }],
  routing: [],
  ...extra,
});

test("纯函数：空领地、`.`、不存在的路径逐条说清楚", () => {
  const existing = new Set(["src"]);
  const problems = staffTerritoryProblems(
    [
      card("empty", "空领地"),
      card("whole", "整片", ["."]),
      card("gone", "走丢的", ["src", "nope"]),
    ],
    (relative) => existing.has(relative),
  );
  assert.deepEqual(problems, [
    { kind: "missing", id: "empty", name: "空领地" },
    { kind: "not-found", id: "gone", name: "走丢的", path: "nope" },
  ]);

  const text = describeStaffTerritoryProblems(problems);
  assert.match(text, /空领地/);
  assert.match(text, /走丢的/);
  assert.match(text, /nope/);
});

test("纯函数：`.` 是整片，不去问文件系统", () => {
  const asked = [];
  const problems = staffTerritoryProblems([card("whole", "整片", ["."])], (relative) => {
    asked.push(relative);
    return false;
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(asked, [], "整片不该被当成一条目录去 stat");
});

test("纯函数：paths 缺失与归一后全空都算没配领地", () => {
  const problems = staffTerritoryProblems(
    [card("missing", "缺省"), card("blank", "空白", ["  ", "/"])],
    () => true,
  );
  assert.deepEqual(
    problems.map((item) => item.id),
    ["missing", "blank"],
  );
});

test("保存：新增卡没填领地 → 拒绝，并点出是哪张卡", async (t) => {
  const dir = await makeWorkspace(t);
  const result = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([card("backend", "后端", undefined)]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.match(result.detail, /后端/);
  assert.match(result.detail, /backend/);
  assert.match(result.detail, /领地/);
});

test("保存：`.` 通过（整片不需要磁盘上真有这个目录）", async (t) => {
  const dir = await makeWorkspace(t);
  const result = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([card("whole", "整片", ["."])]),
  });
  assert.equal(result.ok, true);
  const stored = await readOrchestration(dir);
  assert.deepEqual(stored.settings.roles[0].staff[0].paths, ["."]);
});

test("保存：领地里有不存在的路径 → 拒绝，并指出那一条", async (t) => {
  const dir = await makeWorkspace(t);
  const result = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([card("backend", "后端", ["src", "server/api"])]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.match(result.detail, /server\/api/);
  assert.match(result.detail, /后端/);
});

test("保存：真实存在的目录和文件都接受，保存后读回一致", async (t) => {
  const dir = await makeWorkspace(t);
  const result = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([
      card("backend", "后端", ["src"]),
      card("readme", "文档", ["src/index.ts"]),
    ]),
  });
  assert.equal(result.ok, true);
  const stored = await readOrchestration(dir);
  assert.deepEqual(
    stored.settings.roles[0].staff.map((item) => item.id),
    ["backend", "readme"],
  );
});

test("保存：逃出工作区的领地路径不算存在", async (t) => {
  const dir = await makeWorkspace(t);
  const result = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([card("out", "越界", ["../outside"])]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.match(result.detail, /\.\.\/outside/);
});

test("保存：没动过的老卡缺领地，不挡只改路由的保存", async (t) => {
  const dir = await makeWorkspace(t);
  await writeOrchestration(
    dir,
    settings([card("legacy", "老卡", undefined)]),
    { workspaceId: "ws-1" },
  );

  const result = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([card("legacy", "老卡", undefined)], {
      routing: [{ difficulty: "hard", target: { provider: "claude" } }],
      maxDepth: 5,
    }),
  });
  assert.equal(result.ok, true, "老卡没动，保存别的设置不该被它拦住");
  assert.equal((await readOrchestration(dir)).settings.maxDepth, 5);
});

test("保存：只校验改动过的卡——改别的卡照常成功，改到老卡才拦", async (t) => {
  const dir = await makeWorkspace(t);
  await writeOrchestration(
    dir,
    settings([card("legacy", "老卡", undefined), card("backend", "后端", ["src"])]),
    { workspaceId: "ws-1" },
  );

  // 改合规那张卡的并发：老卡仍未动，保存成功。
  const touchOther = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([
      card("legacy", "老卡", undefined),
      card("backend", "后端", ["src"], { maxConcurrent: 2 }),
    ]),
  });
  assert.equal(touchOther.ok, true);

  // 一旦动到老卡本身（改了名字），它就必须补上领地。
  const touchLegacy = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([
      card("legacy", "老卡改名", undefined),
      card("backend", "后端", ["src"], { maxConcurrent: 2 }),
    ]),
  });
  assert.equal(touchLegacy.ok, false);
  assert.equal(touchLegacy.reason, "invalid");
  assert.match(touchLegacy.detail, /老卡改名/);
});

test("保存：新加的卡即使旁边有缺领地的老卡也按新卡校验", async (t) => {
  const dir = await makeWorkspace(t);
  await writeOrchestration(
    dir,
    settings([card("legacy", "老卡", undefined)]),
    { workspaceId: "ws-1" },
  );

  const result = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: settings([card("legacy", "老卡", undefined), card("fresh", "新卡", undefined)]),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /新卡/);
  assert.doesNotMatch(result.detail, /老卡/, "没动过的老卡不在这次校验里");
});
