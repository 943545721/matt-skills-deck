import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveRepo } from "../server/rpc/repo-gate.ts";
import { mapCommentNodes, mapIssueNodes } from "../server/tracker/github.ts";
import { sortIssues } from "../server/tracker/order.ts";
import { parseRemoteUrl, readRemoteUrl } from "../server/tracker/remote.ts";

test("远端地址：GitHub 的常见四种写法都认", () => {
  const expected = { host: "github", owner: "acme", name: "deck" };
  for (const url of [
    "https://github.com/acme/deck.git",
    "https://github.com/acme/deck",
    "git@github.com:acme/deck.git",
    "ssh://git@github.com:22/acme/deck.git",
    "git://github.com/acme/deck",
    "  https://github.com/acme/deck.git\n",
  ]) {
    assert.deepEqual(parseRemoteUrl(url), expected, url);
  }
});

test("远端地址：GitLab 子组保留在 owner 里", () => {
  assert.deepEqual(parseRemoteUrl("git@gitlab.com:group/sub/deck.git"), {
    host: "gitlab",
    owner: "group/sub",
    name: "deck",
  });
});

test("远端地址：认不出来就返回 null，不猜", () => {
  for (const url of ["", "   ", "not a url", "https://github.com/acme", "/local/path/repo.git"]) {
    assert.equal(parseRemoteUrl(url), null, url);
  }
  assert.equal(parseRemoteUrl("https://git.example.com/acme/deck.git")?.host, "other");
});

test("票面映射：缺字段、空标签、null 指派都不炸", () => {
  const issues = mapIssueNodes([
    {
      number: 7,
      title: "地图",
      state: "OPEN",
      url: "https://github.com/acme/deck/issues/7",
      updatedAt: "2026-10-01T00:00:00Z",
      labels: { nodes: [{ name: "wayfinder:map", color: "8b5cf6" }, { name: "bug" }] },
      assignees: { nodes: [{ login: "octocat" }, { login: null }] },
    },
    { number: "8", state: "CLOSED", labels: null, assignees: null },
    { number: null },
  ]);

  assert.equal(issues.length, 2);
  assert.equal(issues[0].isMap, true);
  assert.deepEqual(issues[0].labels, [
    { name: "wayfinder:map", color: "8b5cf6" },
    { name: "bug", color: "cccccc" },
  ]);
  assert.deepEqual(issues[0].assignees, ["octocat"]);
  assert.equal(issues[0].state, "OPEN");

  assert.equal(issues[1].number, 8);
  assert.equal(issues[1].state, "CLOSED");
  assert.equal(issues[1].title, "#8");
  assert.deepEqual(issues[1].labels, []);
  assert.equal(issues[1].isMap, false);
});

test("评论映射：作者被删号时退回 ghost", () => {
  assert.deepEqual(mapCommentNodes([{ author: null, createdAt: "2026-10-01T00:00:00Z", body: "hi" }]), [
    { author: "ghost", createdAt: "2026-10-01T00:00:00Z", body: "hi" },
  ]);
  assert.deepEqual(mapCommentNodes(undefined), []);
});

test("排序：地图优先 → 未关闭优先 → 最近更新优先，且不改入参", () => {
  const base = { labels: [], assignees: [], url: "", isMap: false };
  const input = [
    { ...base, number: 1, title: "a", state: "CLOSED", updatedAt: "2026-10-03T00:00:00Z" },
    { ...base, number: 2, title: "b", state: "OPEN", updatedAt: "2026-10-01T00:00:00Z", isMap: true },
    { ...base, number: 3, title: "c", state: "OPEN", updatedAt: "2026-10-02T00:00:00Z" },
  ];
  const snapshot = input.map((issue) => issue.number);

  assert.deepEqual(
    sortIssues(input).map((issue) => issue.number),
    [2, 3, 1],
  );
  assert.deepEqual(
    input.map((issue) => issue.number),
    snapshot,
  );
});

/**
 * 读远端失败的三种原因必须分得开：它们的下手处不同（关联远端 / 换目录 / 装 git），
 * 混成一句「没有仓库」会让人往错的方向排查。
 */
test("读远端失败：不是 git 仓库、没有远端、没有 git 命令，三种原因各自报清楚", async () => {
  const plain = mkdtempSync(path.join(tmpdir(), "deck-plain-"));
  const notRepo = await readRemoteUrl(plain);
  assert.equal(notRepo.ok, false);
  assert.equal(notRepo.reason, "not-a-repo");
  const gate = await resolveRepo(plain);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "no-repo");
  assert.match(gate.detail, /不是可读的 git 仓库/);

  if (spawnSync("git", ["--version"]).status === 0) {
    const repo = mkdtempSync(path.join(tmpdir(), "deck-repo-"));
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    const noRemote = await readRemoteUrl(repo);
    assert.equal(noRemote.ok, false);
    assert.equal(noRemote.reason, "no-remote");
  }

  // PATH 里没有 git：三种失败里最容易误报成「没有远端」的一种。
  const previousPath = process.env.PATH;
  process.env.PATH = mkdtempSync(path.join(tmpdir(), "deck-nogit-"));
  try {
    const missing = await readRemoteUrl(plain);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "git-missing");
    const missingGate = await resolveRepo(plain);
    assert.equal(missingGate.ok, false);
    assert.match(missingGate.detail, /git/);
  } finally {
    process.env.PATH = previousPath;
  }
});
