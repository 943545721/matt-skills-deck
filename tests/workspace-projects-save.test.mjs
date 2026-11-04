import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configFingerprintOf, saveProjectList } from "../server/workspace/config-write.ts";
import { skillProjectsOf } from "../server/skills/workspace.ts";
import { listWorkspaceProjects } from "../server/tracker/targets.ts";
import { PROJECT_CONFIG_FILE, parseWorkspaceConfigText } from "../shared/workspace-projects.ts";

/**
 * 项目清单的写入路径。
 *
 * 这份文件是任务板、标签页、技能矩阵三处共用的依据，写坏一次三处一起失去依据。
 * 所以这里钉的是**边界**：校验不过一个字节都不写、旧文件先备份、写回不丢别人的字段、
 * 别人改过就拒绝保存、写完还能按读路径解析回来。
 */

async function workspace(files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-projects-save-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return dir;
}

const configOf = async (dir) => JSON.parse(await readFile(path.join(dir, PROJECT_CONFIG_FILE), "utf8"));

/** 工作区里的备份文件（排掉临时文件与配置本身）。 */
const backupsOf = async (dir) =>
  (await readdir(dir)).filter((name) => name.startsWith(`${PROJECT_CONFIG_FILE}.bak.`)).toSorted();

const ROWS = [
  { key: "api", dir: "mall-api", skillsMode: "unified" },
  { key: "admin", dir: "apps/admin-web", skillsMode: null },
];

test("校验：键名不合法、绝对路径、越界目录、重复键与重复目录各自报对原因，且一个字都没写", async () => {
  const dir = await workspace();
  const before = await readdir(dir);

  const bad = [
    [{ key: "Bad Key", dir: "a", skillsMode: null }, /项目键/],
    [{ key: "api", dir: "/etc/passwd", skillsMode: null }, /相对路径/],
    [{ key: "api", dir: "../outside", skillsMode: null }, /相对路径/],
    [{ key: "api", dir: "a", skillsMode: "sometimes" }, /skillsMode/],
  ];
  for (const [row, pattern] of bad) {
    const result = await saveProjectList(dir, [row]);
    assert.equal(result.ok, false, `${row.key}/${row.dir} 应该被拒`);
    assert.equal(result.reason, "invalid");
    assert.match(result.detail, pattern);
  }

  const duplicated = await saveProjectList(dir, [
    { key: "api", dir: "a", skillsMode: null },
    { key: "api", dir: "b", skillsMode: null },
  ]);
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.detail, /项目键重复/);

  const sameDir = await saveProjectList(dir, [
    { key: "api", dir: "a", skillsMode: null },
    { key: "web", dir: "a", skillsMode: null },
  ]);
  assert.equal(sameDir.ok, false);
  assert.match(sameDir.detail, /项目目录重复/);

  assert.deepEqual(await readdir(dir), before, "校验失败时目录里多一个文件都不行");
});

test("v1 升 v2：顶层未知字段与旧项目的 areas 都留着，旧文件先备份", async () => {
  const legacy = {
    repoDir: "mall-api",
    coordination: { shape: "container" },
    somethingElse: 42,
    projects: [{ key: "api", dir: "mall-api", areas: ["orders"], owner: "backend", deprecatedAreas: ["old"] }],
  };
  const dir = await workspace({ [PROJECT_CONFIG_FILE]: `${JSON.stringify(legacy, null, 2)}\n` });

  const result = await saveProjectList(dir, ROWS);
  assert.equal(result.ok, true, result.ok ? "" : result.detail);
  assert.equal(result.path, path.join(dir, PROJECT_CONFIG_FILE));
  assert.ok(result.backup, "旧文件必须落一份备份");
  assert.equal(await readFile(result.backup, "utf8"), `${JSON.stringify(legacy, null, 2)}\n`);

  const written = await configOf(dir);
  assert.equal(written.version, 2);
  assert.equal(written.repoDir, "mall-api", "v1 的 repoDir 不该被删掉");
  assert.deepEqual(written.coordination, { shape: "container" });
  assert.equal(written.somethingElse, 42);
  assert.deepEqual(
    written.projects[0],
    {
      key: "api",
      dir: "mall-api",
      skillsMode: "unified",
      areas: ["orders"],
      owner: "backend",
      deprecatedAreas: ["old"],
    },
    "同一个项目键那几行：编辑器不认识的字段原样搬过来",
  );
  assert.deepEqual(written.projects[1], { key: "admin", dir: "apps/admin-web", skillsMode: null });
});

test("写出来的文件按读路径解析回来一致，指纹跟着内容走", async () => {
  const dir = await workspace();
  const result = await saveProjectList(dir, ROWS);
  assert.equal(result.ok, true);
  const text = await readFile(path.join(dir, PROJECT_CONFIG_FILE), "utf8");
  assert.equal(result.fingerprint, configFingerprintOf(text));

  const parsed = parseWorkspaceConfigText(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.version, 2);
  assert.deepEqual(
    parsed.config.projects.map((project) => ({ key: project.key, dir: project.dir, skillsMode: project.skillsMode })),
    ROWS,
  );
  assert.equal(result.backup, null, "之前没有文件就没有备份");

  const listing = await listWorkspaceProjects(dir);
  assert.equal(listing.kind, "v2");
  assert.equal(listing.fingerprint, result.fingerprint);
  assert.deepEqual(listing.projects.map((row) => row.key), ["api", "admin"]);
});

test("幂等：同样的清单连写两次，正文不变，只是多一份备份", async () => {
  const dir = await workspace();
  const first = await saveProjectList(dir, ROWS, undefined, new Date("2026-10-30T09:00:00Z"));
  assert.equal(first.ok, true);
  const text = await readFile(path.join(dir, PROJECT_CONFIG_FILE), "utf8");

  const second = await saveProjectList(dir, ROWS, first.fingerprint, new Date("2026-10-30T09:00:01Z"));
  assert.equal(second.ok, true);
  assert.equal(await readFile(path.join(dir, PROJECT_CONFIG_FILE), "utf8"), text);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal((await backupsOf(dir)).length, 1, "第二次写之前那份文件进了备份");
});

test("别人改过就拒绝：指纹对不上报 stale，文件原样不动", async () => {
  const dir = await workspace();
  const created = await saveProjectList(dir, ROWS);
  assert.equal(created.ok, true);

  // 另一个窗口在这期间写了一版不同的内容。
  const other = [{ key: "solo", dir: "solo", skillsMode: null }];
  const raced = await saveProjectList(dir, other);
  assert.equal(raced.ok, true);
  const afterRace = await readFile(path.join(dir, PROJECT_CONFIG_FILE), "utf8");

  const stale = await saveProjectList(dir, ROWS, created.fingerprint);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale");
  assert.match(stale.detail, /已经被别处改过/);
  assert.equal(await readFile(path.join(dir, PROJECT_CONFIG_FILE), "utf8"), afterRace, "冲突时不能覆盖");
});

test("目录不存在只警告不拦：项目可能还没 clone 下来", async () => {
  const dir = await workspace();
  await mkdir(path.join(dir, "mall-api"));
  const result = await saveProjectList(dir, ROWS);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /目录还不存在：apps\/admin-web/);
});

test("旧文件不是合法 JSON：允许整份替换，但要说出来并留下备份", async () => {
  const broken = "{ 这不是 JSON";
  const dir = await workspace({ [PROJECT_CONFIG_FILE]: broken });
  const result = await saveProjectList(dir, ROWS);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /不是合法 JSON/);
  assert.ok(result.backup);
  assert.equal(await readFile(result.backup, "utf8"), broken);
  assert.equal((await configOf(dir)).version, 2);

  const listing = await listWorkspaceProjects(dir);
  assert.equal(listing.kind, "v2");
  assert.equal(listing.error, null);
});

test("空清单写得进去，但会警告「会按单仓库回退」", async () => {
  const dir = await workspace();
  const result = await saveProjectList(dir, []);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /清单是空的/);
  assert.deepEqual((await configOf(dir)).projects, []);
});

test("保存后技能矩阵按新清单分格：行数等于项目数，目录指到各项目", async () => {
  const dir = await workspace();
  await mkdir(path.join(dir, "mall-api"));
  await mkdir(path.join(dir, "apps/admin-web"), { recursive: true });
  const saved = await saveProjectList(dir, ROWS);
  assert.equal(saved.ok, true);

  const matrix = await skillProjectsOf(dir);
  assert.deepEqual(
    matrix.projects.map((project) => project.key).toSorted(),
    ["admin", "api"],
    "矩阵的行就是清单里的项目，不是「一行根目录」",
  );
  assert.deepEqual(
    matrix.projects.map((project) => project.dir).toSorted(),
    [path.join(dir, "apps/admin-web"), path.join(dir, "mall-api")].toSorted(),
  );
});

test("同一毫秒里连存三次：备份名带毫秒，前一份备份不被覆盖", async () => {
  const dir = await workspace();
  const at = new Date("2026-10-30T09:00:00.100Z");
  const first = await saveProjectList(dir, ROWS, undefined, at);
  assert.equal(first.ok, true);
  assert.equal(first.backup, null, "第一次没有旧文件");

  const second = await saveProjectList(dir, ROWS, first.fingerprint, at);
  assert.equal(second.ok, true);
  const third = await saveProjectList(dir, ROWS, second.fingerprint, at);
  assert.equal(third.ok, true);

  assert.ok(second.backup && third.backup);
  assert.notEqual(third.backup, second.backup, "同一毫秒两次保存不能共用同一个备份文件");
  assert.equal((await backupsOf(dir)).length, 2);
});
