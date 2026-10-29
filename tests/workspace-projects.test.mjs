import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_CONFIG_FILE,
  PROJECT_OWNERS,
  isLegacyConfig,
  isSafeProjectDir,
  parseWorkspaceConfigText,
  parseWorkspaceConfigValue,
  projectByKey,
} from "../shared/workspace-projects.ts";

/**
 * `.paseo-deck.json` v2 的解析口径。
 *
 * 这里只测「文本 → 清单」这一层：没有文件系统、没有 git。核心是三条：
 * v1 必须照旧能读（且不写回）、坏配置必须明确报错而不是静默变成「没有项目」、
 * 目录与仓库字段不许越界。
 */

const v2 = (projects, extra = {}) => ({ version: 2, projects, ...extra });
const project = (over = {}) => ({ key: "api", dir: "mall-api", ...over });

const ok = (value) => {
  const parsed = parseWorkspaceConfigValue(value);
  assert.equal(parsed.ok, true, `本该通过：${parsed.detail}`);
  return parsed.config;
};

const fail = (value, reason) => {
  const parsed = parseWorkspaceConfigValue(value);
  assert.equal(parsed.ok, false, "本该被拒");
  assert.equal(parsed.reason, reason, `失败原因不对：${parsed.detail}`);
  assert.ok(parsed.detail.length > 0, "失败必须带可读原因");
  return parsed;
};

test("配置文件名与角色集合是钉住的常量", () => {
  assert.equal(PROJECT_CONFIG_FILE, ".paseo-deck.json");
  assert.deepEqual(PROJECT_OWNERS, ["backend", "frontend", "miniapp", "license", "ops"]);
});

test("v1 只有 repoDir：读成一个单项目，版本仍是 1（不假装是 v2）", () => {
  const config = ok({ repoDir: "mall-api" });
  assert.equal(config.version, 1);
  assert.equal(isLegacyConfig(config), true);
  assert.deepEqual(config.projects, [
    { key: "mall-api", dir: "mall-api", repo: null, owner: null, areas: [], skillsMode: null },
  ]);
  assert.deepEqual(config.warnings, []);
});

test("v1 的 repoDir 仍按单段目录名把关，多段与越界一律拒绝", () => {
  fail({ repoDir: "apps/api" }, "bad-project");
  fail({ repoDir: "../etc" }, "bad-project");
  fail({ repoDir: "/abs/path" }, "bad-project");
});

test("v2 正常清单：字段按声明落位，缺省项是 null / 空数组", () => {
  const config = ok(
    v2([
      { key: "api", dir: "mall-api", repo: "943545721/mall-api", owner: "backend", areas: ["api", "auth"] },
      { key: "admin-web", dir: "apps/admin-web", repo: "acme/admin-web", owner: "frontend", skillsMode: "unified" },
      { key: "notes", dir: "notes" },
    ]),
  );
  assert.equal(config.version, 2);
  assert.equal(isLegacyConfig(config), false);
  assert.deepEqual(config.projects[0], {
    key: "api",
    dir: "mall-api",
    repo: "943545721/mall-api",
    owner: "backend",
    areas: ["api", "auth"],
    skillsMode: null,
  });
  assert.equal(config.projects[1].dir, "apps/admin-web", "多段相对路径要允许");
  assert.equal(config.projects[1].skillsMode, "unified");
  assert.deepEqual(config.projects[2], {
    key: "notes",
    dir: "notes",
    repo: null,
    owner: null,
    areas: [],
    skillsMode: null,
  });
});

test("v2 不写 version 也当 2；显式写别的版本要报错", () => {
  assert.equal(ok({ projects: [project()] }).version, 2);
  fail(v2([project()], { version: 3 }), "bad-shape");
  fail({ version: 2 }, "bad-shape");
});

test("项目键：重复、非法、空都拒绝", () => {
  fail(v2([project({ key: "api" }), project({ key: "api", dir: "mall-api-2" })]), "duplicate-key");
  fail(v2([project({ key: "API" })]), "bad-project");
  fail(v2([project({ key: "-api" })]), "bad-project");
  fail(v2([project({ key: "" })]), "bad-project");
  fail(v2([project({ key: "a".repeat(65) })]), "bad-project");
});

test("目录必须落在工作区内：绝对路径、..、反斜杠、盘符都不收", () => {
  for (const dir of ["/etc", "../x", "a/../../b", "a\\b", "C:/x", "", "."]) {
    fail(v2([project({ dir })]), "bad-project");
  }
  for (const dir of ["mall-api", "apps/admin-web", "a/b/c"]) {
    assert.equal(isSafeProjectDir(dir), true, dir);
  }
});

test("repo 要写成 owner/name（GitLab 的子组允许三段），owner 只认五个角色", () => {
  fail(v2([project({ repo: "mall-api" })]), "bad-project");
  fail(v2([project({ repo: "a/b/c/d" })]), "bad-project");
  ok(v2([project({ repo: "group/sub/name" })]));
  fail(v2([project({ owner: "dba" })]), "bad-project");
  ok(v2([project({ owner: "ops" })]));
});

test("skillsMode 只认 unified / per-project", () => {
  ok(v2([project({ skillsMode: "per-project" })]));
  fail(v2([project({ skillsMode: "统一" })]), "bad-project");
});

test("areas 是模块键：非数组只告警，非法项跳过并说明，重复去掉", () => {
  const warned = ok(v2([project({ areas: "api" })]));
  assert.deepEqual(warned.projects[0].areas, []);
  assert.match(warned.warnings[0], /areas/);

  const mixed = ok(v2([project({ areas: ["api", "api", "Admin Web", 7, "auth"] })]));
  assert.deepEqual(mixed.projects[0].areas, ["api", "auth"]);
  // 「Admin Web」和数字 7 各算一处：坏掉的项跳过，但要说出来。
  assert.equal(mixed.warnings.length, 2);
  for (const warning of mixed.warnings) assert.match(warning, /模块键/);
});

test("projects 是空数组：能读，但给出告警（界面会按单仓库模式回退）", () => {
  const config = ok(v2([]));
  assert.deepEqual(config.projects, []);
  assert.equal(config.warnings.length, 1);
});

test("projects 不是数组、条目不是对象：报 bad-shape / bad-project", () => {
  fail(v2("api"), "bad-shape");
  fail(v2([null]), "bad-project");
  fail(v2([["api"]]), "bad-project");
});

test("认不出的形状与坏 JSON：原因分得开，界面才能说清是哪一种", () => {
  fail(null, "bad-shape");
  fail([], "bad-shape");
  fail({}, "bad-shape");
  fail({ whatever: 1 }, "bad-shape");

  const broken = parseWorkspaceConfigText("{ repoDir: ");
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "bad-json");
  assert.match(broken.detail, /JSON/);

  const good = parseWorkspaceConfigText('{"repoDir":"mall-api"}');
  assert.equal(good.ok, true);
  assert.equal(good.config.projects[0].dir, "mall-api");
});

test("projectByKey：命中给项目，未命中给 null", () => {
  const config = ok(v2([project({ key: "api" }), project({ key: "web", dir: "web" })]));
  assert.equal(projectByKey(config, "web")?.dir, "web");
  assert.equal(projectByKey(config, "missing"), null);
});
