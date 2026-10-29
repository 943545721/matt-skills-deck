import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readWorkspaceConfig, writeSelection } from "../server/tracker/workspace-repo.ts";
import { listWorkspaceProjects, resolveWorkspaceTargets } from "../server/tracker/targets.ts";

/**
 * `.paseo-deck.json` v2 落到服务端之后的读路径。
 *
 * 重点是三条：清单说了算（不再靠扫目录猜）、坏配置要带着原因回退、
 * v1 的文件读完还是原样（不悄悄改写成 v2）。
 */

const hasGit = spawnSync("git", ["--version"]).status === 0;

function tmp(prefix = "deck-config-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeRepo(dir, url) {
  mkdirSync(dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
  assert.equal(spawnSync("git", ["-C", dir, "remote", "add", "origin", url]).status, 0);
}

const writeConfig = (root, value) =>
  writeFileSync(
    path.join(root, ".paseo-deck.json"),
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );

test("v2 清单决定目标：多段目录也算，没远端的项目只报原因不进目标", { skip: !hasGit }, async () => {
  const root = tmp();
  makeRepo(path.join(root, "apps", "admin-web"), "https://github.com/acme/admin-web.git");
  makeRepo(path.join(root, "mall-api"), "https://github.com/acme/mall-api.git");
  mkdirSync(path.join(root, "notes"), { recursive: true });

  writeConfig(root, {
    version: 2,
    projects: [
      { key: "api", dir: "mall-api", owner: "backend" },
      { key: "admin-web", dir: "apps/admin-web", owner: "frontend" },
      { key: "notes", dir: "notes", owner: "ops" },
      { key: "gone", dir: "gone", owner: "ops" },
    ],
  });

  const resolved = await resolveWorkspaceTargets(root);
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.kind, "repos");
  assert.deepEqual(
    resolved.targets.map((target) => target.key),
    ["acme/mall-api", "acme/admin-web"],
  );
  // 目标目录必须是真实存在的那个目录（多段路径拼对了）。
  assert.equal(resolved.targets[1].dir, path.join(root, "apps", "admin-web"));

  const listing = await listWorkspaceProjects(root);
  assert.equal(listing.ok, true);
  assert.equal(listing.kind, "v2");
  assert.equal(listing.error, null);
  const notes = listing.projects.find((project) => project.key === "notes");
  assert.equal(notes.exists, true);
  assert.equal(notes.resolved, null);
  assert.match(notes.problem, /不是可读的 git 仓库/);
  const gone = listing.projects.find((project) => project.key === "gone");
  assert.equal(gone.exists, false);
  assert.match(gone.problem, /不存在/);
});

test("清单漏写的仓库会被点出来（drift），但不影响读取", { skip: !hasGit }, async () => {
  const root = tmp();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");
  makeRepo(path.join(root, "beta"), "https://github.com/acme/beta.git");
  writeConfig(root, { version: 2, projects: [{ key: "alpha", dir: "alpha" }] });

  const listing = await listWorkspaceProjects(root);
  assert.equal(listing.drift.length, 1);
  assert.match(listing.drift[0], /beta/);

  const resolved = await resolveWorkspaceTargets(root);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.targets.map((target) => target.key), ["acme/alpha"], "清单说了算，不自动补 beta");
});

test("配置坏掉：回退到原来的自动识别，同时把可读原因留给界面", { skip: !hasGit }, async () => {
  const root = tmp();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");
  writeConfig(root, "{ 坏掉");

  const read = await readWorkspaceConfig(root);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "bad-json");
  assert.match(read.detail, /JSON/);

  const listing = await listWorkspaceProjects(root);
  assert.equal(listing.kind, "none");
  assert.equal(listing.error.reason, "bad-json");
  assert.deepEqual(listing.projects, []);

  const resolved = await resolveWorkspaceTargets(root);
  assert.equal(resolved.ok, true, "坏了也要能用：回到扫目录");
  assert.deepEqual(resolved.targets.map((target) => target.key), ["acme/alpha"]);
});

test("没有配置文件：kind none、error 为 null（没配不是错）", { skip: !hasGit }, async () => {
  const root = tmp();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");
  const listing = await listWorkspaceProjects(root);
  assert.equal(listing.kind, "none");
  assert.equal(listing.error, null);
  assert.equal((await readWorkspaceConfig(root)).reason, "missing");
});

test("v1 照旧能读，而且读完不改写文件", { skip: !hasGit }, async () => {
  const root = tmp();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");
  const original = '{\n  "repoDir": "alpha"\n}\n';
  writeConfig(root, original);

  const read = await readWorkspaceConfig(root);
  assert.equal(read.ok, true);
  assert.equal(read.config.version, 1);
  assert.equal(read.config.projects[0].dir, "alpha");
  assert.equal(readFileSync(path.join(root, ".paseo-deck.json"), "utf8"), original, "读路径不许回写");
});

test("v2 工作区里不许用「默认仓库」把清单覆盖掉", { skip: !hasGit }, async () => {
  const root = tmp();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");
  const config = { version: 2, projects: [{ key: "alpha", dir: "alpha" }] };
  writeConfig(root, config);

  const refused = await writeSelection(root, "alpha");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "invalid-selection");
  assert.match(refused.detail, /v2/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".paseo-deck.json"), "utf8")), config);
});

test("显式设了后端但清单里没有对得上的项目：报错并列出每个项目的原因", { skip: !hasGit }, async () => {
  const root = tmp();
  mkdirSync(path.join(root, "notes"), { recursive: true });
  writeConfig(root, { version: 2, projects: [{ key: "notes", dir: "notes" }] });

  const resolved = await resolveWorkspaceTargets(root);
  // auto 下回落自动识别（这里没有任何仓库 → 本地 .deck），不该判死。
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
});
