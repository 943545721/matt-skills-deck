import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAttachmentSnapshot, parseDeckSlash } from "../shared/slash.ts";

test("/deck 空参数给出 help，不猜命令", () => {
  assert.deepEqual(parseDeckSlash(""), { kind: "help" });
  assert.deepEqual(parseDeckSlash("   \t\n "), { kind: "help" });
});

test("命令都解析成对应的判别式", () => {
  assert.deepEqual(parseDeckSlash("status"), { kind: "status" });
  assert.deepEqual(parseDeckSlash("next"), { kind: "next" });
  assert.deepEqual(parseDeckSlash("handoff"), { kind: "handoff" });
  assert.deepEqual(parseDeckSlash("fixate"), { kind: "fixate" });
  assert.deepEqual(parseDeckSlash("new"), { kind: "new" });
  assert.deepEqual(parseDeckSlash("help"), { kind: "help" });
  assert.deepEqual(parseDeckSlash("attach 12"), { kind: "attach", number: 12 });
});

test("命令名大小写不敏感，前后空白忽略", () => {
  assert.deepEqual(parseDeckSlash("  STATUS "), { kind: "status" });
  assert.deepEqual(parseDeckSlash("Attach   #7"), { kind: "attach", number: 7 });
});

test("attach 接受 # 前缀，且只收一个正整数", () => {
  assert.deepEqual(parseDeckSlash("attach #1"), { kind: "attach", number: 1 });
  assert.deepEqual(parseDeckSlash("attach 0009"), { kind: "attach", number: 9 });
  assert.equal(parseDeckSlash("attach").kind, "error");
  assert.equal(parseDeckSlash("attach").code, "missing-number");
  assert.equal(parseDeckSlash("attach 1 2").code, "extra-args");
  for (const bad of ["0", "-1", "1.5", "abc", "#", "#x", "12px"]) {
    const parsed = parseDeckSlash(`attach ${bad}`);
    assert.equal(parsed.kind, "error", bad);
    assert.equal(parsed.code, "invalid-number", bad);
  }
  const huge = parseDeckSlash(`attach ${"9".repeat(30)}`);
  assert.equal(huge.kind, "error");
  assert.equal(huge.code, "invalid-number");
});

test("无参命令带多余参数直接报错", () => {
  for (const name of ["status", "next", "handoff", "fixate", "new", "help"]) {
    const parsed = parseDeckSlash(`${name} now`);
    assert.equal(parsed.kind, "error", name);
    assert.equal(parsed.code, "extra-args", name);
  }
});

test("未知命令报错并带上命令表，不静默当成 help", () => {
  const parsed = parseDeckSlash("nope");
  assert.equal(parsed.kind, "error");
  assert.equal(parsed.code, "unknown-command");
  assert.match(parsed.message, /status/);
  assert.match(parsed.message, /help/);
});

test("票面快照带号、标题、正文、标签、评论与回链", () => {
  const snapshot = buildAttachmentSnapshot({
    number: 42,
    title: "  修复登录失败  ",
    body: "第一行\n第二行",
    url: "https://github.com/acme/app/issues/42",
    repoKey: "acme/app",
    state: "OPEN",
    labels: ["bug", { name: "wayfinder:task" }],
    assignees: ["alice"],
    comments: [
      { author: "bob", createdAt: "2026-10-28T01:00:00Z", body: "复现了" },
      { author: "carol", body: "在修" },
    ],
  });
  assert.equal(snapshot.id, "acme/app#42");
  assert.equal(snapshot.identifier, "#42");
  assert.equal(snapshot.title, "#42 修复登录失败");
  assert.equal(snapshot.url, "https://github.com/acme/app/issues/42");
  assert.equal(snapshot.resourceType, "issue");
  assert.equal(snapshot.subtitle, "acme/app · OPEN");
  assert.match(snapshot.text, /^#42 修复登录失败/);
  assert.match(snapshot.text, /repo: acme\/app · state: OPEN · labels: bug, wayfinder:task · assignees: alice/);
  assert.match(snapshot.text, /url: https:\/\/github\.com\/acme\/app\/issues\/42/);
  assert.match(snapshot.text, /第一行\n第二行/);
  assert.match(snapshot.text, /- bob \(2026-10-28T01:00:00Z\): 复现了/);
  assert.match(snapshot.text, /- carol: 在修/);
});

test("没有网页地址的本地票用 data URL 承载快照，不造假链接", () => {
  const snapshot = buildAttachmentSnapshot({ number: 3, title: "Local", url: "  " });
  assert.ok(snapshot.url.startsWith("data:text/markdown;charset=utf-8,"));
  assert.ok(decodeURIComponent(snapshot.url.split(",")[1]).includes("#3 Local"));
  assert.equal(snapshot.subtitle, undefined);
  assert.ok(!("subtitle" in snapshot));
});

test("非法 URL 同样退回 data URL，评论没带全时如实说明", () => {
  const snapshot = buildAttachmentSnapshot({
    number: 5,
    title: "Weird",
    url: "not a url",
    comments: [{ author: "a", body: "one" }],
    commentCount: 4,
  });
  assert.ok(snapshot.url.startsWith("data:"));
  assert.match(snapshot.text, /\(3 more comments were not included in this snapshot\)/);
  assert.match(snapshot.text, /\(ticket has no body\)/);
});
