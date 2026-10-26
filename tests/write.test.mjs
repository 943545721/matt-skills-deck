import assert from "node:assert/strict";
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
