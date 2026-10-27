import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
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

test("评论：没登录时请求根本没发出去，报 gh-unauth 且不回落 CLI", async () => {
  const gh = fakeGh('echo "To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4');
  try {
    const result = await postComment("acme", "deck", 7, "一条评论");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "gh-unauth");
    // 不能落进「可能已经写进去了」那段：命令被 gh 在本地拦下，云端不会有重复评论。
    assert.doesNotMatch(result.detail, /可能已经写进/);
    assert.deepEqual(gh.calls(), ["api"]);
  } finally {
    gh.restore();
  }
});

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

test("评论：网关返回 502/504 不算「确定被拒」，不当成没写进去", async () => {
  for (const status of ["502", "504", "408"]) {
    const gh = fakeGh(`echo "gh: Server Error (HTTP ${status})" >&2\nexit 1`);
    try {
      const result = await postComment("acme", "deck", 7, "一条评论");
      assert.equal(result.ok, false, `HTTP ${status} 不该回落`);
      assert.deepEqual(gh.calls(), ["api"], `HTTP ${status} 仍然回落了 CLI`);
      assert.match(result.detail, /可能已经写进/);
    } finally {
      gh.restore();
    }
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
