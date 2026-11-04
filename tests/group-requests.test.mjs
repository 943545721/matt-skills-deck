import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  groupRequestFileOf,
  readGroupRequest,
  rememberGroupRequest,
} from "../server/group-requests.ts";

const ws = () => mkdtemp(path.join(os.tmpdir(), "deck-group-requests-"));

test("没记过的 requestId 回 null", async () => {
  const dir = await ws();
  assert.deepEqual(await readGroupRequest(dir, "w1", "req-1"), { ok: true, hit: null });
});

test("记下后能按 requestId 读回票号与会话，重试据此回放", async () => {
  const dir = await ws();
  const result = {
    requestId: "req-1",
    at: "2026-11-03T10:00:00.000Z",
    deliveries: [
      { staffId: "staff-a", name: "前端", agentId: "agent-1", ticketNumber: 12 },
      { staffId: "staff-b", name: "后端", agentId: null, ticketNumber: null, detail: "客户端档案不存在" },
    ],
    warnings: ["1 个目标没派出去"],
  };
  assert.deepEqual(await rememberGroupRequest(dir, "w1", result), { ok: true });
  const read = await readGroupRequest(dir, "w1", "req-1");
  assert.equal(read.ok, true);
  const stored = read.hit;
  assert.equal(stored.requestId, "req-1");
  assert.equal(stored.deliveries[0].ticketNumber, 12);
  assert.equal(stored.deliveries[1].detail, "客户端档案不存在");
  assert.deepEqual(stored.warnings, ["1 个目标没派出去"]);
  assert.deepEqual(await readGroupRequest(dir, "w1", "req-2"), { ok: true, hit: null });
});

test("同一 requestId 写了多行时以最后一行结果为准", async () => {
  const dir = await ws();
  await rememberGroupRequest(dir, "w1", {
    requestId: "req-1",
    at: "2026-11-03T10:00:00.000Z",
    deliveries: [{ staffId: null, name: "主窗口", agentId: "main-1", ticketNumber: null }],
    warnings: [],
  });
  await rememberGroupRequest(dir, "w1", {
    requestId: "req-1",
    at: "2026-11-03T10:05:00.000Z",
    deliveries: [{ staffId: null, name: "主窗口", agentId: "main-2", ticketNumber: null }],
    warnings: [],
  });
  const read = await readGroupRequest(dir, "w1", "req-1");
  assert.equal(read.ok, true);
  assert.equal(read.hit.deliveries[0].agentId, "main-2");
});

test("坏行被跳过，不挡住同一文件里的好记录", async () => {
  const dir = await ws();
  const file = groupRequestFileOf(dir, "w1");
  await rememberGroupRequest(dir, "w1", {
    requestId: "req-1",
    at: "2026-11-03T10:00:00.000Z",
    deliveries: [],
    warnings: [],
  });
  await appendFile(file, "{ 这不是 JSON\n", "utf8");
  const read = await readGroupRequest(dir, "w1", "req-1");
  assert.equal(read.ok, true);
  assert.equal(read.hit.requestId, "req-1");
});

test("读失败不是「没派过」：除 ENOENT 外的错误必须报出来", async () => {
  const dir = await ws();
  // 把记录文件的位置做成目录：readFile 会报 EISDIR，不是 ENOENT。
  await mkdir(groupRequestFileOf(dir, "w1"), { recursive: true });
  const read = await readGroupRequest(dir, "w1", "req-1");
  assert.equal(read.ok, false);
  assert.match(read.detail, /EISDIR|illegal operation/i);
});

test("工作区 id 里的路径分隔符不会逃出 .deck/group", async () => {
  const file = groupRequestFileOf("/tmp/ws", "../../etc/passwd");
  const groupDir = path.resolve("/tmp/ws", ".deck", "group");
  assert.equal(path.dirname(path.resolve(file)), groupDir, "文件名里不能带目录跳转");
  assert.ok(path.resolve(file).startsWith(`${groupDir}${path.sep}`), "解析后必须仍在群目录里");
  assert.ok(file.endsWith(".requests.jsonl"));
});
