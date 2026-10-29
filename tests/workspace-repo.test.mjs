import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  isSafeSegment,
  listChildRepos,
  readRepoCandidates,
  readSelection,
  resolveWorkspaceRepo,
  writeSelection,
} from "../server/tracker/workspace-repo.ts";

/**
 * 容器工作区（父目录下放多个仓库）的识别。
 *
 * 这些用例全部落在临时目录：先 `git init` 再 `git remote add`，不碰网络，
 * 也不碰本机任何真实仓库。git 不在 PATH 时整组跳过，而不是假装通过。
 */

const hasGit = spawnSync("git", ["--version"]).status === 0;

function container() {
  return mkdtempSync(path.join(tmpdir(), "deck-container-"));
}

function makeRepo(dir, url) {
  mkdirSync(dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
  assert.equal(spawnSync("git", ["-C", dir, "remote", "add", "origin", url]).status, 0);
}

test("选择值只接受单层目录名：路径分隔符、..、绝对路径一律拒绝", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", "/abs", "x\u0000y", "长".repeat(101)]) {
    assert.equal(isSafeSegment(bad), false, `应拒绝：${JSON.stringify(bad)}`);
  }
  for (const good of ["kxhyapp.com", "repo-1", "子目录"]) {
    assert.equal(isSafeSegment(good), true, `应接受：${good}`);
  }
});

test("扫描只认直接子目录里的 GitHub / GitLab 仓库，跳过普通目录与点目录", { skip: !hasGit }, async () => {
  const root = container();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");
  makeRepo(path.join(root, "beta"), "git@gitlab.com:group/sub/beta.git");
  makeRepo(path.join(root, ".hidden"), "https://github.com/acme/hidden.git");
  mkdirSync(path.join(root, "plain"));
  makeRepo(path.join(root, "nested", "deep"), "https://github.com/acme/deep.git");
  writeFileSync(path.join(root, "file.txt"), "x");

  const list = await listChildRepos(root);
  assert.deepEqual(list.map((item) => item.dir), ["alpha", "beta"]);
  assert.deepEqual(list[0], {
    dir: "alpha",
    host: "github",
    owner: "acme",
    name: "alpha",
    webUrl: "https://github.com/acme/alpha",
  });
  assert.equal(list[1].owner, "group/sub");
  // 只扫一层：nested/deep 不能被当成直接候选。
  assert.equal(list.some((item) => item.dir === "deep"), false);
});

test("选择文件：有效值读出、坏 JSON 与失效目录当作没选", { skip: !hasGit }, async () => {
  const root = container();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");

  assert.equal(await readSelection(root), null);

  writeFileSync(path.join(root, ".paseo-deck.json"), JSON.stringify({ repoDir: "alpha" }));
  assert.equal(await readSelection(root), "alpha");

  writeFileSync(path.join(root, ".paseo-deck.json"), "{not json");
  assert.equal(await readSelection(root), null);

  writeFileSync(path.join(root, ".paseo-deck.json"), JSON.stringify({ repoDir: "gone" }));
  assert.equal(await readSelection(root), null);

  writeFileSync(path.join(root, ".paseo-deck.json"), JSON.stringify({ repoDir: "../escape" }));
  assert.equal(await readSelection(root), null);
});

test("写入与清除选择：只写 .paseo-deck.json，清除即删除", { skip: !hasGit }, async () => {
  const root = container();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");

  const written = await writeSelection(root, "alpha");
  assert.equal(written.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".paseo-deck.json"), "utf8")), { repoDir: "alpha" });

  const cleared = await writeSelection(root, null);
  assert.equal(cleared.ok, true);
  assert.deepEqual(readdirSync(root), ["alpha"]);

  // 文件本来就不存在时清除也算成功：幂等，不拿 ENOENT 报错吓人。
  assert.equal((await writeSelection(root, null)).ok, true);
});

test("写入拒绝非仓库目录与工作区外的符号链接", { skip: !hasGit }, async () => {
  const root = container();
  mkdirSync(path.join(root, "plain"));
  const outside = mkdtempSync(path.join(tmpdir(), "deck-outside-"));
  makeRepo(outside, "https://github.com/acme/outside.git");
  symlinkSync(outside, path.join(root, "escape"));

  for (const bad of ["plain", "escape", "missing"]) {
    const result = await writeSelection(root, bad);
    assert.equal(result.ok, false, `${bad} 不应被接受`);
    assert.equal(result.reason, "invalid-selection");
  }
  // 符号链接目录也不该出现在候选里。
  assert.deepEqual(await listChildRepos(root), []);
});

test("多个子仓库不猜：未选择时报错并说明数量，选择后从子目录解析", { skip: !hasGit }, async () => {
  const root = container();
  makeRepo(path.join(root, "alpha"), "https://github.com/acme/alpha.git");
  makeRepo(path.join(root, "beta"), "https://github.com/acme/beta.git");

  const unresolved = await resolveWorkspaceRepo(root);
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.detail, /2 个仓库/);

  await writeSelection(root, "beta");
  const resolved = await resolveWorkspaceRepo(root);
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.fromSubdir, true);
  assert.deepEqual(resolved.repo, {
    host: "github",
    owner: "acme",
    name: "beta",
    webUrl: "https://github.com/acme/beta",
  });
});

test("唯一子仓库自动使用；根目录是仓库时优先用根目录", { skip: !hasGit }, async () => {
  const only = container();
  makeRepo(path.join(only, "site"), "https://github.com/acme/site.git");
  const auto = await resolveWorkspaceRepo(only);
  assert.equal(auto.ok, true);
  assert.equal(auto.fromSubdir, true);
  assert.equal(auto.ref.name, "site");

  const rootRepo = container();
  makeRepo(rootRepo, "https://github.com/acme/root.git");
  makeRepo(path.join(rootRepo, "child"), "https://github.com/acme/child.git");
  const rootWins = await resolveWorkspaceRepo(rootRepo);
  assert.equal(rootWins.ok, true);
  assert.equal(rootWins.fromSubdir, false);
  assert.equal(rootWins.ref.name, "root");
});

test("候选接口：根目录是仓库时标记 rootIsRepo，并带回当前选择", { skip: !hasGit }, async () => {
  const containerDir = container();
  makeRepo(path.join(containerDir, "alpha"), "https://github.com/acme/alpha.git");
  makeRepo(path.join(containerDir, "beta"), "git@gitlab.com:acme/beta.git");

  const before = await readRepoCandidates(containerDir);
  assert.equal(before.ok, true);
  assert.equal(before.rootIsRepo, false);
  assert.equal(before.selected, null);
  assert.deepEqual(before.candidates.map((item) => item.dir), ["alpha", "beta"]);

  await writeSelection(containerDir, "alpha");
  const after = await readRepoCandidates(containerDir);
  assert.equal(after.ok, true);
  assert.equal(after.selected, "alpha");

  const rootRepo = container();
  makeRepo(rootRepo, "https://github.com/acme/root.git");
  const root = await readRepoCandidates(rootRepo);
  assert.equal(root.ok, true);
  assert.equal(root.rootIsRepo, true);
});
