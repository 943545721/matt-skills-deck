import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import {
  classifyGlabError,
  getGitLabIssue,
  listGitLabIssues,
  listGitLabLabels,
  mapGitLabIssues,
} from "../server/tracker/gitlab.ts";

/**
 * GitLab 只读后端：编号、状态、标签、系统便签这四处最容易和 GitHub 的假设串味。
 * 用假 glab 直接验参数与映射，避免把「glab 没装」当成代码错误。
 */

const sandboxes = [];
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function sandbox(prefix = "deck-glab-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function fakeGlab(body) {
  const dir = sandbox();
  const bin = path.join(dir, "glab");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(bin, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ""}`;
  return {
    restore: () => {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const issuePayload = (iid, extra = {}) => ({
  iid,
  title: `issue ${iid}`,
  state: "opened",
  web_url: `https://gitlab.com/acme/deck/-/issues/${iid}`,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  description: "body",
  labels: ["bug"],
  assignees: [{ username: "alice" }],
  ...extra,
});

test("映射：opened/closed、标签与指派都按 GitLab 的字段读，不套 GitHub 的 iid/state", () => {
  const mapped = mapGitLabIssues([
    issuePayload(7),
    issuePayload(8, { state: "closed", labels: ["wayfinder:map"] }),
    { title: "没有 iid，跳过" },
  ]);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].number, 7);
  assert.equal(mapped[0].state, "OPEN");
  assert.deepEqual(mapped[0].assignees, ["alice"]);
  assert.equal(mapped[1].state, "CLOSED");
  assert.equal(mapped[1].isMap, true);
  // GitLab 没有阻塞边：不能凭空把别的票算成阻塞。
  assert.deepEqual(mapped[0].blockedBy, []);
});

test("列票：state=opened/closed/all 下推给 glab，合并视图直接空（MR 编号不与 issue 共用）", async () => {
  const gh = fakeGlab(`printf '%s\\n' '${JSON.stringify([issuePayload(1)])}'`);
  try {
    const open = await listGitLabIssues("acme", "deck");
    assert.equal(open.ok, true);
    assert.equal(open.source, "gitlab");
    assert.equal(open.issues.length, 1);

    const merged = await listGitLabIssues("acme", "deck", { view: "merged" });
    assert.equal(merged.ok, true);
    assert.equal(merged.issues.length, 0);
  } finally {
    gh.restore();
  }
});

test("详情的系统便签不混进评论：人写的才留下", async () => {
  const payload = JSON.stringify(issuePayload(3));
  const notes = JSON.stringify([
    { author: { username: "alice" }, created_at: "2026-10-01T00:00:00Z", body: "人写的", system: false },
    { author: { username: "alice" }, created_at: "2026-10-02T00:00:00Z", body: "added label bug", system: true },
  ]);
  const gh = fakeGlab(
    `case "$*" in\n  *"/notes"*) printf '%s\\n' '${notes}' ;;\n  *) printf '%s\\n' '${payload}' ;;\nesac`,
  );
  try {
    const detail = await getGitLabIssue("acme", "deck", 3);
    assert.equal(detail.ok, true);
    assert.equal(detail.issue.body, "body");
    assert.deepEqual(detail.comments.map((comment) => comment.body), ["人写的"]);
  } finally {
    gh.restore();
  }
});

test("标签：GitLab 的 # 前缀被去掉并转小写，颜色口径与 GitHub 一致", async () => {
  const labels = JSON.stringify([{ name: "bug", color: "#FF0000", description: "缺陷" }]);
  const gh = fakeGlab(`printf '%s\\n' '${labels}'`);
  try {
    const result = await listGitLabLabels("acme", "deck");
    assert.equal(result.ok, true);
    assert.deepEqual(result.labels, [{ name: "bug", color: "ff0000", description: "缺陷" }]);
  } finally {
    gh.restore();
  }
});

test("失败分类：没装 glab 与没登录分开，不把网络错误说成登录问题", () => {
  assert.equal(classifyGlabError({ code: "ENOENT" }).reason, "glab-missing");
  assert.equal(classifyGlabError({ code: 1, stderr: "Please run glab auth login first" }).reason, "glab-unauth");
  assert.equal(classifyGlabError({ code: 1, stderr: "connection reset by peer" }).reason, "glab-failed");
});

test("写路径：GitLab 后端明确只读，不会让界面以为写成功了", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const { resolveWritableBackend } = await import("../server/tracker/backend.ts");
  const ws = sandbox("deck-glab-ws-");
  spawnSync("git", ["init", "-q", ws]);
  spawnSync("git", ["-C", ws, "remote", "add", "origin", "https://gitlab.com/acme/deck.git"]);
  const backend = await resolveWritableBackend(ws, "评论");
  assert.equal(backend.ok, false);
  assert.equal(backend.reason, "unsupported-host");
  assert.match(backend.detail, /只读/);
});
