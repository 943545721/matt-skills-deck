import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_HANDOFF_ATTEMPTS,
  handoffBoxDirOf,
  listPendingHandoffs,
  markHandoffFailed,
  markHandoffSent,
  recordHandoffAttempt,
  writePendingHandoff,
} from "../server/dispatch-handoff-store.ts";

/**
 * outbox 是交接的唯一事实来源：写重了会派两遍，写丢了整批活就没了。
 * 用例钉住幂等、读回、搬家与重试上限。
 */

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "deck-handoff-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function envelope(overrides = {}) {
  return {
    version: 1,
    handoffId: "0123456789abcdef",
    createdAt: "2026-11-05T00:00:00.000Z",
    workspaceId: "ws1",
    mainAgentId: "main-1",
    requirementKey: 38,
    summary: "补岗位领地",
    tasks: [{ prompt: "改派单闸" }],
    lang: "zh",
    attempts: 0,
    ...overrides,
  };
}

test("写入 pending：原子落盘、读回一致", async (t) => {
  const dir = await workspace(t);
  const written = await writePendingHandoff(dir, envelope());
  assert.equal(written.ok, true);
  assert.equal(written.duplicate, false);
  assert.match(written.path, /dispatch-handoffs\/pending\/0123456789abcdef\.json$/);
  const pending = await listPendingHandoffs(dir);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0], envelope());
});

test("幂等：同 id 不重复入队，已 sent / failed 的也算重复", async (t) => {
  const dir = await workspace(t);
  await writePendingHandoff(dir, envelope());
  const again = await writePendingHandoff(dir, envelope({ summary: "改了措辞但 id 相同" }));
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal((await listPendingHandoffs(dir)).length, 1);

  await markHandoffSent(dir, envelope());
  const afterSent = await writePendingHandoff(dir, envelope());
  assert.equal(afterSent.duplicate, true);
  assert.equal((await listPendingHandoffs(dir)).length, 0);
});

test("非法 handoffId 不落盘", async (t) => {
  const dir = await workspace(t);
  const written = await writePendingHandoff(dir, envelope({ handoffId: "../../etc/passwd" }));
  assert.equal(written.ok, false);
});

test("坏件跳过，不影响好件", async (t) => {
  const dir = await workspace(t);
  await writePendingHandoff(dir, envelope());
  await mkdir(handoffBoxDirOf(dir, "pending"), { recursive: true });
  await writeFile(join(handoffBoxDirOf(dir, "pending"), "ffffffffffffffff.json"), "{not json", "utf8");
  const pending = await listPendingHandoffs(dir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].handoffId, "0123456789abcdef");
});

test("送达 / 放弃：先写目标箱，再清 pending", async (t) => {
  const dir = await workspace(t);
  await writePendingHandoff(dir, envelope());
  await markHandoffSent(dir, envelope({ attempts: 1 }));
  assert.equal((await listPendingHandoffs(dir)).length, 0);
  const sent = await readFile(join(handoffBoxDirOf(dir, "sent"), "0123456789abcdef.json"), "utf8");
  assert.equal(JSON.parse(sent).attempts, 1);

  await writePendingHandoff(dir, envelope({ handoffId: "fedcba9876543210" }));
  await markHandoffFailed(dir, envelope({ handoffId: "fedcba9876543210" }), "没有收件人");
  assert.equal((await listPendingHandoffs(dir)).length, 0);
  await stat(join(handoffBoxDirOf(dir, "failed"), "fedcba9876543210.json"));
});

test("重试计数：未到上限留在 pending，到了上限移进 failed", async (t) => {
  const dir = await workspace(t);
  await writePendingHandoff(dir, envelope());
  for (let attempt = 1; attempt < MAX_HANDOFF_ATTEMPTS; attempt += 1) {
    const [current] = await listPendingHandoffs(dir);
    await recordHandoffAttempt(dir, current, "窗口关了");
    const [pending] = await listPendingHandoffs(dir);
    assert.equal(pending.attempts, attempt);
  }
  const [last] = await listPendingHandoffs(dir);
  await recordHandoffAttempt(dir, last, "窗口关了");
  assert.equal((await listPendingHandoffs(dir)).length, 0);
  const failed = JSON.parse(await readFile(join(handoffBoxDirOf(dir, "failed"), "0123456789abcdef.json"), "utf8"));
  assert.equal(failed.attempts, MAX_HANDOFF_ATTEMPTS);
});
