import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendGroup,
  groupFileOf,
  MAX_GROUP_TEXT_CHARS,
  pruneGroup,
  readGroup,
} from "../server/group-store.ts";

const ws = () => mkdtemp(path.join(os.tmpdir(), "deck-group-"));

test("workspaceId 里不安全字符进不了目录名", () => {
  assert.equal(groupFileOf("/w", "wks/1 中文"), path.join("/w", ".deck", "group", "wks_1___.jsonl"));
  assert.equal(groupFileOf("/w", "   "), path.join("/w", ".deck", "group", "default.jsonl"));
});

test("追加后按从旧到新读回；坏行只丢一行", async () => {
  const dir = await ws();
  const now = "2026-01-01T00:05:00Z";
  const a = await appendGroup(dir, "w1", { at: "2026-01-01T00:00:00Z", from: "我", agentId: "a1", kind: "user", text: "开工" }, { now });
  const b = await appendGroup(dir, "w1", { at: "2026-01-01T00:01:00Z", from: "前端", agentId: "a2", kind: "staff", text: "收到" }, { now });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const file = groupFileOf(dir, "w1");
  await writeFile(file, `${await readFile(file, "utf8")}{坏行\n`, "utf8");
  const read = await readGroup(dir, "w1");
  assert.deepEqual(read.records.map((record) => record.text), ["开工", "收到"]);
  assert.equal(read.skipped, 1);
});

test("没有文件时是空群，不是错误", async () => {
  const dir = await ws();
  assert.deepEqual(await readGroup(dir, "nobody"), { records: [], skipped: 0 });
});

test("超过保留行数时裁旧行并留一条 system 标记", async () => {
  const dir = await ws();
  for (let index = 0; index < 3; index += 1) {
    const result = await appendGroup(
      dir,
      "w1",
      { at: `2026-01-01T00:0${index}:00Z`, from: "我", agentId: "a", kind: "user", text: `第${index}条` },
      { maxRows: 2, now: "2026-01-01T00:10:00Z" },
    );
    assert.equal(result.ok, true);
  }
  const read = await readGroup(dir, "w1");
  assert.equal(read.records[0]?.kind, "system");
  assert.match(read.records[0]?.text ?? "", /裁剪/);
  assert.deepEqual(read.records.slice(1).map((record) => record.text), ["第1条", "第2条"]);
});

test("超过 90 天的行在下次写入时被裁掉", async () => {
  const dir = await ws();
  // 直接落一行旧记录（append 会当场执行保留策略，测不到「下次写入时裁」）。
  const file = groupFileOf(dir, "w1");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ at: "2025-01-01T00:00:00Z", from: "我", agentId: "a", kind: "user", text: "去年" })}\n`,
    "utf8",
  );
  await appendGroup(
    dir,
    "w1",
    { at: "2026-04-01T00:00:00Z", from: "我", agentId: "a", kind: "user", text: "现在" },
    { now: "2026-04-01T00:00:00Z" },
  );
  const read = await readGroup(dir, "w1");
  assert.equal(read.records.some((record) => record.text === "去年"), false);
  assert.equal(read.records.some((record) => record.text === "现在"), true);
});

test("空消息不写；超长摘要按上限截断", async () => {
  const dir = await ws();
  const empty = await appendGroup(dir, "w1", { at: "2026-01-01T00:00:00Z", from: "我", agentId: "a", kind: "user", text: "  " });
  assert.equal(empty.ok, false);
  const long = await appendGroup(dir, "w1", {
    at: "2026-01-01T00:00:00Z",
    from: "我",
    agentId: "a",
    kind: "user",
    text: "x".repeat(MAX_GROUP_TEXT_CHARS + 50),
  }, { now: "2026-01-02T00:00:00Z" });
  assert.equal(long.ok, true);
  const read = await readGroup(dir, "w1");
  assert.equal(read.records[0]?.text.length, MAX_GROUP_TEXT_CHARS);
});

test("pruneGroup 不修改入参数组", () => {
  const records = [
    { at: "2026-01-01T00:00:00Z", from: "我", agentId: "a", kind: "user", text: "1" },
    { at: "2026-01-02T00:00:00Z", from: "我", agentId: "a", kind: "user", text: "2" },
  ];
  const frozen = Object.freeze(records.map((record) => Object.freeze(record)));
  const result = pruneGroup(frozen, { maxRows: 1, now: "2026-01-03T00:00:00Z" });
  assert.equal(result.trimmed, true);
  assert.equal(records.length, 2);
});
