import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createLocalIssue,
  getLocalIssue,
  listLocalIssues,
  listLocalLabels,
  localAssignUnsupported,
  parseLocalIssue,
  postLocalComment,
  replaceLocalLabels,
  resetLocalColorCacheForTest,
  setLocalIssueState,
  setLocalLabelColors,
} from "../server/tracker/local.ts";

/**
 * 本地后端的核心不变量：写入的每一个字节都能被自己读回来。
 * 这些用例都直接落在临时目录里的 `.deck/`，不碰网络、不碰 gh。
 */

const sandboxes = [];

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-local-"));
  sandboxes.push(dir);
  resetLocalColorCacheForTest();
  return dir;
}

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

test("本地建票：编号从 1 起、正文与标签原样读回", async () => {
  const ws = workspace();
  const first = await createLocalIssue(ws, { title: "第一张", body: "## 正文\n内容", labels: ["bug", "bug"] });
  assert.equal(first.ok, true);
  assert.equal(first.number, 1);
  assert.deepEqual(first.labels, ["bug"]);

  const second = await createLocalIssue(ws, { title: "第二张", body: "", labels: [] });
  assert.equal(second.number, 2);

  const board = await listLocalIssues(ws);
  assert.equal(board.ok, true);
  assert.equal(board.totalCount, 2);
  assert.equal(board.source, "local");
  assert.deepEqual(board.issues.map((issue) => issue.number).sort(), [1, 2]);

  const detail = await getLocalIssue(ws, 1);
  assert.equal(detail.ok, true);
  assert.equal(detail.issue.title, "第一张");
  assert.equal(detail.issue.body, "## 正文\n内容");
  assert.deepEqual(detail.issue.labels.map((label) => label.name), ["bug"]);
});

test("本地评论与状态：写进去之后列表/详情看到的是新状态", async () => {
  const ws = workspace();
  await createLocalIssue(ws, { title: "待办", body: "", labels: [] });

  const commented = await postLocalComment(ws, 1, "先记一笔");
  assert.equal(commented.ok, true);
  assert.equal(commented.comment.author, "local");

  const detail = await getLocalIssue(ws, 1);
  assert.equal(detail.ok, true);
  assert.deepEqual(detail.comments.map((comment) => comment.body), ["先记一笔"]);

  const closed = await setLocalIssueState(ws, 1, "closed");
  assert.deepEqual(closed, { ok: true, state: "CLOSED" });
  const open = await listLocalIssues(ws, { view: "open" });
  assert.equal(open.ok, true);
  assert.equal(open.totalCount, 0);
  const closedView = await listLocalIssues(ws, { view: "closed" });
  assert.equal(closedView.ok, true);
  assert.equal(closedView.totalCount, 1);
});

test("本地标签：整体替换不丢原有标签，改色后读回的颜色确实变了", async () => {
  const ws = workspace();
  await createLocalIssue(ws, { title: "带标签", body: "", labels: ["bug", "docs"] });

  const replaced = await replaceLocalLabels(ws, 1, ["docs", "wayfinder:map"]);
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.labels.map((label) => label.name), ["docs", "wayfinder:map"]);

  const colored = await setLocalLabelColors(ws, [{ name: "docs", color: "#AABBCC" }]);
  assert.equal(colored.ok, true);
  assert.deepEqual(colored.verified, [{ name: "docs", color: "aabbcc" }]);
  assert.deepEqual(colored.mismatched, []);
  assert.equal(colored.readbackFailed, false);

  const labels = await listLocalLabels(ws);
  assert.equal(labels.ok, true);
  assert.equal(labels.labels.find((label) => label.name === "docs").color, "aabbcc");
  // 票里用到但目录里没有的标签也要出现，否则界面会显示一张没有标签的票。
  assert.ok(labels.labels.some((label) => label.name === "wayfinder:map"));
});

test("本地阻塞关系：被打开的票阻塞时算 blocked，阻塞票关掉后回到 ready", async () => {
  const ws = workspace();
  await createLocalIssue(ws, { title: "阻塞者", body: "", labels: [] });
  await createLocalIssue(ws, { title: "被阻塞", body: "", labels: [] });

  const dir = path.join(ws, ".deck", "issues");
  const file = path.join(dir, "2.md");
  const text = readFileSync(file, "utf8").replace("blockedBy: []", "blockedBy: [1]");
  writeFileSync(file, text, "utf8");

  // 与 GitHub 路径一致：列表只负责状态窗口，ready/blocked 由统一的 filterBoard 再筛。
  const open = await listLocalIssues(ws, { view: "open" });
  assert.equal(open.ok, true);
  assert.deepEqual(open.issues.find((issue) => issue.number === 2).readiness, "blocked");

  await setLocalIssueState(ws, 1, "closed");
  const afterClose = await listLocalIssues(ws, { view: "open" });
  assert.equal(afterClose.ok, true);
  assert.deepEqual(afterClose.issues.map((issue) => issue.number), [2]);
  assert.equal(afterClose.issues[0].readiness, "ready");
});

test("本地解析：没有 frontmatter 的笔记不会被当成票", () => {
  assert.equal(parseLocalIssue("随手记的两句话\n", 3), null);
  const parsed = parseLocalIssue("---\nnumber: 3\ntitle: 手写\nstate: CLOSED\nlabels: bug, docs\n---\n正文\n", 3);
  assert.ok(parsed);
  assert.equal(parsed.title, "手写");
  assert.equal(parsed.state, "CLOSED");
  assert.deepEqual(parsed.labels, ["bug", "docs"]);
  assert.equal(parsed.body, "正文\n");
});

test("本地没有登录账号：指派明确说不支持，不写假名字", () => {
  const failure = localAssignUnsupported();
  assert.equal(failure.ok, false);
  assert.equal(failure.reason, "invalid");
  assert.match(failure.detail, /assignees/);
});

test("本地访问不存在的票回报 not-found，而不是建一张空票", async () => {
  const ws = workspace();
  const detail = await getLocalIssue(ws, 9);
  assert.equal(detail.ok, false);
  assert.equal(detail.reason, "not-found");
  assert.equal((await listLocalIssues(ws)).totalCount, 0);
});
