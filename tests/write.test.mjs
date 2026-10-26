import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createIssue, dedupeLabels, postComment, replaceLabels } from "../server/tracker/write.ts";

/**
 * 这些用例都在「发命令之前」就返回，所以不需要 gh、也不会碰到网络：
 * 校验分支本身就是要保证的行为——不合法的输入绝不该变成一条发给 GitHub 的写命令。
 */

test("标签去重：保留首次出现的顺序，丢掉空白与重复", () => {
  assert.deepEqual(dedupeLabels(["bug", " bug ", "", "bug", "needs-triage"]), ["bug", "needs-triage"]);
  assert.deepEqual(dedupeLabels([]), []);
});

test("评论：空内容与非法票号在本地就拒绝，返回 invalid", async () => {
  const empty = await postComment("acme", "deck", 1, "   \n");
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "invalid");

  const badNumber = await postComment("acme", "deck", 0, "hi");
  assert.equal(badNumber.ok, false);
  assert.equal(badNumber.reason, "invalid");
});

test("建票：标题空或过长在本地就拒绝", async () => {
  const empty = await createIssue("acme", "deck", { title: "   ", body: "", labels: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "invalid");

  const long = await createIssue("acme", "deck", { title: "x".repeat(257), body: "", labels: [] });
  assert.equal(long.ok, false);
  assert.equal(long.reason, "invalid");
});

test("改标签：非法票号在本地就拒绝", async () => {
  const result = await replaceLabels("acme", "deck", -1, ["bug"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

/** 假 gh：每次调用记一行「子命令|第二参数」，脚本体由调用方给（决定这次失败成什么样）。 */
function fakeGh(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-gh-"));
  const bin = path.join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" >> "$GH_LOG"\n${body}\n`, "utf8");
  chmodSync(bin, 0o755);
  const log = path.join(dir, "gh.log");
  const previousPath = process.env.PATH;
  const previousLog = process.env.GH_LOG;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  process.env.GH_LOG = log;
  return {
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((entry) => entry.split("|")[0])
        : [],
    restore: () => {
      process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = previousLog;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("评论：REST 失败但拿不到 HTTP 状态码时不再回落 CLI，避免写出重复评论", async () => {
  const gh = fakeGh('echo "error connecting to api.github.com" >&2\nexit 1');
  try {
    const result = await postComment("acme", "deck", 7, "一条评论");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "gh-failed");
    // 关键：没有第二次调用——第一次可能已经在服务端写成功了。
    assert.deepEqual(gh.calls(), ["api"]);
    assert.match(result.detail, /可能已经写进/);
  } finally {
    gh.restore();
  }
});

test("评论：REST 明确被拒（HTTP 404）时才回落 CLI，并如实回报成功", async () => {
  const gh = fakeGh('case "$1" in\n  api) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;\n  *) echo "created"; exit 0 ;;\nesac');
  try {
    const result = await postComment("acme", "deck", 7, "一条评论");
    assert.equal(result.ok, true);
    assert.equal(result.comment.body, "一条评论");
    assert.deepEqual(gh.calls(), ["api", "issue"]);
  } finally {
    gh.restore();
  }
});
