import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import {
  mapGitlabRepo,
  mapGithubRepo,
  mapLocalRepo,
  readRepoInfo,
} from "../server/tracker/repo-info.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";

/**
 * 仓库详情的三种后端映射。
 *
 * 这里的输入故意留空字段：远端缺字段时必须给 null（界面据此隐藏），
 * 不能补 0——「0 个 Star」和「没读到 Star」是两件事。
 */

const AT = "2026-10-27T10:00:00.000Z";

test("GitHub 回包：可见性、语言、计数、许可、主题逐项映射", () => {
  const detail = mapGithubRepo(
    {
      full_name: "acme/deck",
      html_url: "https://github.com/acme/deck",
      description: "A deck of issues",
      visibility: "public",
      private: false,
      default_branch: "main",
      language: "TypeScript",
      stargazers_count: 12,
      forks_count: 3,
      open_issues_count: 7,
      pushed_at: "2026-10-26T04:05:06Z",
      created_at: "2025-01-02T03:04:05Z",
      license: { spdx_id: "MIT", name: "MIT License" },
      topics: ["paseo", "issues", ""],
    },
    "acme/deck",
    AT,
  );

  assert.equal(detail.host, "github");
  assert.equal(detail.fullName, "acme/deck");
  assert.equal(detail.visibility, "public");
  assert.equal(detail.language, "TypeScript");
  assert.equal(detail.stars, 12);
  assert.equal(detail.forks, 3);
  assert.equal(detail.openIssues, 7);
  assert.equal(detail.defaultBranch, "main");
  assert.equal(detail.license, "MIT");
  // 空字符串主题必须被过滤，否则界面上会出现一个空逗号。
  assert.deepEqual(detail.topics, ["paseo", "issues"]);
  assert.equal(detail.localDir, null);
});

test("GitHub 回包：缺字段给 null，不补 0；private=true 兜底成私有", () => {
  const detail = mapGithubRepo({ full_name: "acme/deck", private: true }, "acme/deck", AT);
  assert.equal(detail.visibility, "private");
  assert.equal(detail.description, null);
  assert.equal(detail.language, null);
  assert.equal(detail.stars, null);
  assert.equal(detail.forks, null);
  assert.equal(detail.openIssues, null);
  assert.equal(detail.license, null);
  assert.deepEqual(detail.topics, []);
});

test("GitLab 回包：用 path_with_namespace、star_count、tag_list 兜底主题", () => {
  const detail = mapGitlabRepo(
    {
      path_with_namespace: "group/sub/deck",
      web_url: "https://gitlab.com/group/sub/deck",
      description: "GitLab deck",
      visibility: "internal",
      default_branch: "trunk",
      star_count: 5,
      forks_count: 1,
      open_issues_count: 2,
      last_activity_at: "2026-10-25T00:00:00Z",
      created_at: "2024-05-01T00:00:00Z",
      tag_list: ["paseo"],
      license: { name: "Apache-2.0" },
    },
    "group/sub/deck",
    AT,
  );
  assert.equal(detail.host, "gitlab");
  assert.equal(detail.fullName, "group/sub/deck");
  assert.equal(detail.visibility, "internal");
  assert.equal(detail.defaultBranch, "trunk");
  assert.equal(detail.language, null);
  assert.deepEqual(detail.topics, ["paseo"]);
  assert.equal(detail.license, "Apache-2.0");
});

test("本地后端：不伪造远端字段，只给目录与 .deck 里的实际数量", () => {
  const detail = mapLocalRepo("/work/deck", "deck", 3, 5, AT);
  assert.equal(detail.host, "local");
  assert.equal(detail.fullName, "deck");
  assert.equal(detail.url, null);
  assert.equal(detail.visibility, "unknown");
  assert.equal(detail.localDir, path.resolve("/work/deck"));
  assert.equal(detail.localIssueCount, 3);
  assert.equal(detail.localLabelCount, 5);
  assert.equal(detail.stars, null);
});

test("真实调用：gh api repos/<owner>/<name>，并把 JSON 映射出来", async () => {
  if (spawnSync("git", ["--version"]).status !== 0) return;
  const repo = mkdtempSync(path.join(tmpdir(), "deck-info-repo-"));
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/deck.git"]).status, 0);

  const gh = fakeGh(
    `printf '%s\\n' '{"full_name":"acme/deck","visibility":"private","default_branch":"main","stargazers_count":9,"forks_count":1,"open_issues_count":4,"license":{"spdx_id":"MIT"},"topics":["paseo"]}'`,
  );
  try {
    const result = await readRepoInfo(repo);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.repo.fullName, "acme/deck");
    assert.equal(result.repo.visibility, "private");
    assert.equal(result.repo.stars, 9);
    assert.equal(result.repo.openIssues, 4);
    assert.deepEqual(gh.calls(), ["api"]);
  } finally {
    gh.restore();
  }
});

test("远端 404：归成 not-found，而不是含混的 gh-failed", async () => {
  if (spawnSync("git", ["--version"]).status !== 0) return;
  const repo = mkdtempSync(path.join(tmpdir(), "deck-info-404-"));
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/gone.git"]).status, 0);

  const gh = fakeGh(`echo "gh: Not Found (HTTP 404)" >&2\nexit 1`);
  try {
    const result = await readRepoInfo(repo);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-found");
    assert.match(result.detail, /acme\/gone/);
  } finally {
    gh.restore();
  }
});

test("本地后端：读 .deck 里的票与标签数量", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-info-local-"));
  mkdirSync(path.join(dir, ".deck", "issues"), { recursive: true });
  writeFileSync(path.join(dir, ".deck", "issues", "1.md"), "# one\n");
  writeFileSync(path.join(dir, ".deck", "issues", "2.md"), "# two\n");
  writeFileSync(path.join(dir, ".deck", "issues", "1.comments.json"), "[]\n");
  writeFileSync(path.join(dir, ".deck", "labels.json"), JSON.stringify([{ name: "bug", color: "ff0000" }]));

  setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "local" });
  try {
    const result = await readRepoInfo(dir);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.repo.host, "local");
    assert.equal(result.repo.localIssueCount, 2);
    assert.equal(result.repo.localLabelCount, 1);
    assert.equal(result.repo.localDir, path.resolve(dir));
  } finally {
    setSettingsForTest(DEFAULT_SETTINGS);
  }
});
