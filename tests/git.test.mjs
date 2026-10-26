import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "../server/git/check.ts";
import { pathsProblem } from "../server/git/exec.ts";
import { parseStatus } from "../server/git/status.ts";
import { consumeTicket, issueTicket, resetTickets } from "../server/git/tickets.ts";

const base = {
  branch: "main",
  upstream: "origin/main",
  upstreamGone: false,
  stagedCount: 0,
  hasIntentToAdd: false,
  remotes: ["origin"],
};

test("status 解析：分支、领先落后、暂存与未跟踪文件", () => {
  const stdout = [
    "# branch.oid 1234567890abcdef",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 aaaa bbbb src/a.ts",
    "1 .M N... 100644 100644 100644 aaaa bbbb src/b.ts",
    "? src/new.ts",
  ].join("\0");

  const screen = parseStatus(stdout);
  assert.equal(screen.headOid, "1234567890abcdef");
  assert.deepEqual(screen.branch, { name: "main", upstream: "origin/main", upstreamGone: false, ahead: 2, behind: 1 });
  assert.equal(screen.clean, false);
  assert.deepEqual(
    screen.files.map((file) => [file.path, file.code, file.staged]),
    [
      ["src/a.ts", "M.", true],
      ["src/b.ts", ".M", false],
      ["src/new.ts", "??", false],
    ],
  );
});

test("status 解析：重命名条目跳过紧跟的原路径，不产生幽灵文件", () => {
  const stdout = ["# branch.head main", "2 R. N... 100644 100644 100644 aaaa bbbb R100 new.ts", "old.ts", "? other.ts"].join("\0");
  const screen = parseStatus(stdout);
  assert.deepEqual(
    screen.files.map((file) => file.path),
    ["new.ts", "other.ts"],
  );
});

test("status 解析：干净仓库 + 分离 HEAD", () => {
  const screen = parseStatus(["# branch.oid abc", "# branch.head (detached)"].join("\0"));
  assert.equal(screen.clean, true);
  assert.equal(screen.branch.name, "");
  assert.equal(screen.headOid, "abc");
});

test("判定：没有暂存就挡提交，i-t-a 给更具体的理由", () => {
  assert.deepEqual(judge({ ...base, op: "commit" }), { verdict: "block", reasons: ["nothing-staged"] });
  assert.deepEqual(judge({ ...base, op: "commit", hasIntentToAdd: true }), {
    verdict: "block",
    reasons: ["intent-to-add"],
  });
  assert.equal(judge({ ...base, op: "commit", stagedCount: 3 }).verdict, "allow");
});

test("判定：拉取要求有上游；推送在无上游时走 set-upstream", () => {
  assert.deepEqual(judge({ ...base, op: "pull", upstream: "" }), { verdict: "block", reasons: ["no-upstream"] });
  assert.deepEqual(judge({ ...base, op: "pull", upstreamGone: true }), { verdict: "block", reasons: ["no-upstream"] });

  const first = judge({ ...base, op: "push", upstream: "" });
  assert.deepEqual(first, { verdict: "allow", plan: { remote: "origin", branch: "main", setUpstream: true } });

  const normal = judge({ ...base, op: "push" });
  assert.deepEqual(normal, { verdict: "allow", plan: { remote: "origin", branch: "main", setUpstream: false } });
});

test("判定：多远端要人选，选了不存在的远端也要人选", () => {
  const many = { ...base, op: "push", remotes: ["origin", "upstream"] };
  assert.deepEqual(judge(many), { verdict: "need-choice", candidates: ["origin", "upstream"] });
  assert.deepEqual(judge({ ...many, requestedRemote: "nope" }), {
    verdict: "need-choice",
    candidates: ["origin", "upstream"],
  });
  assert.equal(judge({ ...many, requestedRemote: "upstream" }).verdict, "allow");
  assert.deepEqual(judge({ ...base, op: "fetch", remotes: [] }), { verdict: "block", reasons: ["no-remote"] });
});

test("判定：分离 HEAD 挡住一切写操作", () => {
  for (const op of ["commit", "pull", "push", "fetch"]) {
    const result = judge({ ...base, op, branch: "", stagedCount: op === "commit" ? 1 : 0 });
    assert.deepEqual(result, { verdict: "block", reasons: ["detached-head"] }, op);
  }
});

test("票据：一次有效，重复用同一张票会被拒", () => {
  resetTickets();
  const ticket = issueTicket({
    op: "commit",
    workspaceDir: "/tmp/ws",
    headOid: "abc",
    indexFingerprint: "1:2",
    plan: { remote: "", branch: "main", setUpstream: false },
  });

  const first = consumeTicket(ticket.id, "commit", "/tmp/ws");
  assert.equal(first.ok, true);

  const second = consumeTicket(ticket.id, "commit", "/tmp/ws");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "ticket-expired");
});

test("票据：操作类型、工作区不符、过期都拒绝", () => {
  resetTickets();
  const now = 1_000_000;
  const ticket = issueTicket(
    { op: "push", workspaceDir: "/tmp/ws", headOid: "abc", indexFingerprint: "", plan: { remote: "origin", branch: "main", setUpstream: false } },
    now,
  );

  assert.equal(consumeTicket(ticket.id, "commit", "/tmp/ws", now).ok, false);
  assert.equal(consumeTicket(ticket.id, "push", "/tmp/other", now).ok, false);
  assert.equal(consumeTicket(ticket.id, "push", "/tmp/ws", now + 120_000).ok, false);
});

test("路径校验：拒绝空、绝对路径、选项形式", () => {
  assert.equal(pathsProblem([])?.reason, "invalid");
  assert.equal(pathsProblem(["-f"])?.reason, "invalid");
  assert.equal(pathsProblem(["/etc/passwd"])?.reason, "invalid");
  assert.equal(pathsProblem(["src/a.ts"]), null);
});
