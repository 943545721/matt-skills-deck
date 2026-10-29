import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  applyWorkRouteEvent,
  emptyWorkRouteLedger,
  parseWorkRouteLedger,
  pruneWorkRouteLedger,
  serializeWorkRouteLedger,
} from "../shared/work-route.ts";
import {
  listHandoffs,
  readHandoff,
  readWorkRouteLedger,
  resolveLedgerScope,
  saveHandoff,
  updateWorkRouteLedger,
} from "../server/ledger.ts";

const roots = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "deck-ledger-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function withAgentEnv(value, fn) {
  const previous = process.env.PASEO_AGENT_ID;
  if (value === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  }
}

let sequence = 0;

function makeEntry(overrides = {}) {
  sequence += 1;
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();
  const repoKey = overrides.repoKey ?? "o/r";
  const number = overrides.number ?? sequence;
  return {
    ticketKey: `${repoKey}#${number}`,
    repoKey,
    number,
    title: overrides.title ?? `ticket ${number}`,
    url: overrides.url ?? null,
    status: overrides.status ?? "attached",
    agentId: overrides.agentId ?? "agent-1",
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
    note: overrides.note ?? null,
  };
}

function seedLedger(root, agentId, ledger) {
  const scope = resolveLedgerScope({ homeDir: root, agentId });
  mkdirSync(path.dirname(scope.file), { recursive: true });
  writeFileSync(scope.file, serializeWorkRouteLedger(ledger), "utf8");
  return scope;
}

const attach = (number, at) => (ledger) =>
  applyWorkRouteEvent(ledger, {
    kind: "attach",
    ticket: { repoKey: "o/r", number, title: `ticket ${number}` },
    agentId: "agent-1",
    at,
  });

// ---------------------------------------------------------------------------
// 作用域
// ---------------------------------------------------------------------------

test("有 agent id 时按 agent 分文件", () => {
  const root = tempRoot();
  const scope = resolveLedgerScope({ homeDir: root, agentId: "agent-abc" });
  assert.equal(scope.kind, "agent");
  assert.match(scope.file, /agents\/agent-abc-[0-9a-f]+\.json$/);
  assert.match(scope.handoffDir, /handoffs\/agent-agent-abc-[0-9a-f]+$/);
});

test("PASEO_AGENT_ID 环境变量作为缺省作用域", async () => {
  const root = tempRoot();
  await withAgentEnv("env-agent", async () => {
    const scope = resolveLedgerScope({ homeDir: root, cwd: "/ws" });
    assert.equal(scope.kind, "agent");
    assert.match(scope.file, /env-agent-/);
  });
});

test("没有 agent 时按工作区分，且同一目录稳定", async () => {
  const root = tempRoot();
  await withAgentEnv(undefined, () => {
    const one = resolveLedgerScope({ homeDir: root, cwd: "/ws/one" });
    const again = resolveLedgerScope({ homeDir: root, cwd: "/ws/one" });
    const two = resolveLedgerScope({ homeDir: root, cwd: "/ws/two" });
    assert.equal(one.kind, "workspace");
    assert.equal(one.file, again.file);
    assert.notEqual(one.file, two.file);
    assert.match(one.file, /workspaces\/one-[0-9a-f]+\.json$/);
  });
});

test("既没有 agent 也没有工作区时拒绝猜测", async () => {
  const root = tempRoot();
  await withAgentEnv(undefined, async () => {
    assert.throws(() => resolveLedgerScope({ homeDir: root }), /无法决定台账作用域/);
    const read = await readWorkRouteLedger({ homeDir: root });
    assert.equal(read.ok, false);
    assert.equal(read.reason, "scope-missing");
  });
});

test("不同 agent 的台账互不影响", async () => {
  const root = tempRoot();
  const first = await updateWorkRouteLedger(attach(1, new Date().toISOString()), {
    homeDir: root,
    agentId: "agent-a",
  });
  assert.equal(first.ok, true);
  const second = await readWorkRouteLedger({ homeDir: root, agentId: "agent-b" });
  assert.equal(second.ok, true);
  assert.equal(second.ledger.entries.length, 0);
});

// ---------------------------------------------------------------------------
// 读写与原子写
// ---------------------------------------------------------------------------

test("空台账返回空列表而不是错误", async () => {
  const root = tempRoot();
  const result = await readWorkRouteLedger({ homeDir: root, agentId: "agent-1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ledger.entries, []);
  assert.equal(result.recovered, false);
  assert.equal(result.dropped, 0);
});

test("attach 原子落盘，回读一致且没有临时文件", async () => {
  const root = tempRoot();
  const at = "2026-10-28T00:00:00.000Z";
  const result = await updateWorkRouteLedger(attach(1, at), { homeDir: root, agentId: "agent-1" });
  assert.equal(result.ok, true);
  assert.equal(result.ledger.entries.length, 1);
  assert.equal(result.ledger.entries[0].status, "attached");
  assert.ok(existsSync(result.scope.file));
  const names = readdirSync(path.dirname(result.scope.file));
  assert.equal(names.some((name) => name.endsWith(".tmp")), false);

  const read = await readWorkRouteLedger({ homeDir: root, agentId: "agent-1" });
  assert.equal(read.ok, true);
  assert.equal(read.ledger.entries[0].ticketKey, "o/r#1");
  assert.equal(read.ledger.entries[0].title, "ticket 1");
});

test("并发写入不丢条", async () => {
  const root = tempRoot();
  const base = Date.parse("2026-10-28T00:00:00.000Z");
  const writes = Array.from({ length: 16 }, (_, index) =>
    updateWorkRouteLedger(attach(index + 1, new Date(base + index * 1000).toISOString()), {
      homeDir: root,
      agentId: "agent-1",
    }),
  );
  const results = await Promise.all(writes);
  assert.equal(results.every((result) => result.ok), true);

  const read = await readWorkRouteLedger({ homeDir: root, agentId: "agent-1" });
  assert.equal(read.ok, true);
  assert.equal(read.ledger.entries.length, 16);
  assert.deepEqual(
    read.ledger.entries.map((entry) => entry.number).sort((left, right) => left - right),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
});

test("修改函数抛错时不写文件", async () => {
  const root = tempRoot();
  const first = await updateWorkRouteLedger(attach(1, new Date().toISOString()), {
    homeDir: root,
    agentId: "agent-1",
  });
  assert.equal(first.ok, true);
  const before = readFileSync(first.scope.file, "utf8");

  const failed = await updateWorkRouteLedger(
    () => {
      throw new Error("boom");
    },
    { homeDir: root, agentId: "agent-1" },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "write-failed");
  assert.equal(readFileSync(first.scope.file, "utf8"), before);
});

test("读取失败（路径不是文件）如实返回 read-failed", async () => {
  const root = tempRoot();
  const scope = resolveLedgerScope({ homeDir: root, agentId: "agent-1" });
  mkdirSync(scope.file, { recursive: true });
  const read = await readWorkRouteLedger({ homeDir: root, agentId: "agent-1" });
  assert.equal(read.ok, false);
  assert.equal(read.reason, "read-failed");
});

// ---------------------------------------------------------------------------
// 损坏恢复与容错解析
// ---------------------------------------------------------------------------

test("坏 JSON 改名留档，从空台账恢复", async () => {
  const root = tempRoot();
  const scope = resolveLedgerScope({ homeDir: root, agentId: "agent-1" });
  mkdirSync(path.dirname(scope.file), { recursive: true });
  writeFileSync(scope.file, "{ this is not json", "utf8");

  const read = await readWorkRouteLedger({ homeDir: root, agentId: "agent-1" });
  assert.equal(read.ok, true);
  assert.equal(read.recovered, true);
  assert.equal(read.ledger.entries.length, 0);
  assert.ok(read.corruptPath && existsSync(read.corruptPath));
  assert.equal(existsSync(scope.file), false);

  const updated = await updateWorkRouteLedger(attach(2, new Date().toISOString()), {
    homeDir: root,
    agentId: "agent-1",
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.ledger.entries.length, 1);
});

test("单条坏记录被丢弃并计数，其余保留", () => {
  const good = makeEntry({ number: 1 });
  const text = JSON.stringify({
    version: 1,
    updatedAt: "2026-10-28T00:00:00.000Z",
    entries: [good, { ticketKey: "o/r#2", status: "unknown", number: 2 }, null, { number: 3 }],
  });
  const parsed = parseWorkRouteLedger(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ledger.entries.length, 1);
  assert.equal(parsed.dropped, 3);
});

test("整体结构不对判为 not-ledger", () => {
  assert.equal(parseWorkRouteLedger("[]").reason, "not-ledger");
  assert.equal(parseWorkRouteLedger('{"version":2,"entries":[]}').reason, "not-ledger");
  assert.equal(parseWorkRouteLedger("nope").reason, "not-json");
});

// ---------------------------------------------------------------------------
// 保留期与上限
// ---------------------------------------------------------------------------

test("保留期只清收尾记录，活跃票据保留", () => {
  const now = Date.parse("2026-10-28T00:00:00.000Z");
  const old = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(now - 1000).toISOString();
  const ledger = {
    version: 1,
    updatedAt: fresh,
    entries: [
      makeEntry({ number: 1, status: "done", updatedAt: old }),
      makeEntry({ number: 2, status: "attached", updatedAt: old }),
      makeEntry({ number: 3, status: "done", updatedAt: fresh }),
    ],
  };
  const pruned = pruneWorkRouteLedger(ledger, { now, maxAgeDays: 30 });
  assert.deepEqual(
    pruned.entries.map((entry) => entry.number).sort((left, right) => left - right),
    [2, 3],
  );
});

test("超过条目上限时先删最旧的收尾记录", () => {
  const now = Date.parse("2026-10-28T00:00:00.000Z");
  const entries = Array.from({ length: 12 }, (_, index) =>
    makeEntry({
      number: index + 1,
      status: index < 2 ? "attached" : "done",
      updatedAt: new Date(now - index * 1000).toISOString(),
    }),
  );
  const pruned = pruneWorkRouteLedger({ version: 1, updatedAt: entries[0].updatedAt, entries }, { now, maxEntries: 5 });
  assert.equal(pruned.entries.length, 5);
  assert.equal(pruned.entries.filter((entry) => entry.status === "attached").length, 2);
});

test("落盘时执行保留策略", async () => {
  const root = tempRoot();
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  seedLedger(root, "agent-1", {
    version: 1,
    updatedAt: old,
    entries: [makeEntry({ number: 1, status: "done", updatedAt: old }), makeEntry({ number: 2, status: "attached", updatedAt: old })],
  });

  const result = await updateWorkRouteLedger(attach(3, new Date().toISOString()), {
    homeDir: root,
    agentId: "agent-1",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ledger.entries.map((entry) => entry.number).sort((left, right) => left - right),
    [2, 3],
  );
});

test("空台账的时间戳与版本可序列化后读回", () => {
  const now = "2026-10-28T00:00:00.000Z";
  const parsed = parseWorkRouteLedger(serializeWorkRouteLedger(emptyWorkRouteLedger(now)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ledger.updatedAt, now);
  assert.deepEqual(parsed.ledger.entries, []);
});

// ---------------------------------------------------------------------------
// Handoff 文件
// ---------------------------------------------------------------------------

test("保存、列出、读取 handoff", async () => {
  const root = tempRoot();
  const saved = await saveHandoff("# Handoff\n\nbody\n", {
    homeDir: root,
    agentId: "agent-1",
    title: "诊断 #1",
    now: new Date("2026-10-28T01:02:03Z"),
  });
  assert.equal(saved.ok, true);
  assert.match(saved.name, /^\d{8}-\d{6}-/);
  assert.ok(existsSync(saved.path));

  const listed = await listHandoffs({ homeDir: root, agentId: "agent-1" });
  assert.equal(listed.ok, true);
  assert.equal(listed.files.length, 1);
  assert.equal(listed.files[0].name, saved.name);

  const read = await readHandoff(saved.name, { homeDir: root, agentId: "agent-1" });
  assert.equal(read.ok, true);
  assert.equal(read.markdown, "# Handoff\n\nbody\n");
});

test("同秒不同内容并存，同内容覆盖为同一文件", async () => {
  const root = tempRoot();
  const now = new Date("2026-10-28T01:02:03Z");
  const first = await saveHandoff("a\n", { homeDir: root, agentId: "agent-1", now });
  const second = await saveHandoff("b\n", { homeDir: root, agentId: "agent-1", now });
  const again = await saveHandoff("a\n", { homeDir: root, agentId: "agent-1", now });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(again.ok, true);
  assert.notEqual(first.name, second.name);
  assert.equal(first.name, again.name);

  const listed = await listHandoffs({ homeDir: root, agentId: "agent-1" });
  assert.equal(listed.files.length, 2);
});

test("handoff 只接受目录内的 .md 文件名", async () => {
  const root = tempRoot();
  for (const name of ["../evil.md", "sub/x.md", "/abs/x.md", "x.txt", ""]) {
    const result = await readHandoff(name, { homeDir: root, agentId: "agent-1" });
    assert.equal(result.ok, false, name);
    assert.equal(result.reason, "invalid-name", name);
  }
  const missing = await readHandoff("missing.md", { homeDir: root, agentId: "agent-1" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "not-found");
});

test("handoff 按作用域隔离", async () => {
  const root = tempRoot();
  await saveHandoff("agent a\n", { homeDir: root, agentId: "agent-a" });
  const other = await listHandoffs({ homeDir: root, agentId: "agent-b" });
  assert.equal(other.ok, true);
  assert.equal(other.files.length, 0);
});

test("保存时清掉超过保留期的 handoff", async () => {
  const root = tempRoot();
  const first = await saveHandoff("old\n", { homeDir: root, agentId: "agent-1" });
  assert.equal(first.ok, true);
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(first.path, old, old);

  const fresh = await saveHandoff("new\n", { homeDir: root, agentId: "agent-1" });
  assert.equal(fresh.ok, true);
  assert.equal(existsSync(first.path), false);
  assert.equal(existsSync(fresh.path), true);
});

test("handoff 最多保留 50 份", async () => {
  const root = tempRoot();
  const scope = resolveLedgerScope({ homeDir: root, agentId: "agent-1" });
  mkdirSync(scope.handoffDir, { recursive: true });
  const older = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (let index = 0; index < 55; index += 1) {
    const file = path.join(scope.handoffDir, `20260101-000000-old-${index}.md`);
    writeFileSync(file, "old\n", "utf8");
    utimesSync(file, older, older);
  }
  const saved = await saveHandoff("new\n", { homeDir: root, agentId: "agent-1" });
  assert.equal(saved.ok, true);

  const listed = await listHandoffs({ homeDir: root, agentId: "agent-1", limit: 100 });
  assert.equal(listed.ok, true);
  assert.equal(listed.files.length, 50);
  assert.equal(listed.files.some((file) => file.name === saved.name), true);
});
