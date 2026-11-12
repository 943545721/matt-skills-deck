import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY_RUNTIME_SUBDIR,
  announcePresence,
  noteIdentityRefusal,
  readIdentityGaps,
} from "../server/identity-presence.ts";

/**
 * 「MCP 进程没拿到会话身份」的痕迹与回收。
 *
 * 这些痕迹是面板上那条告警的唯一来源：写不出来 = 用户继续看到「工具莫名失败」，
 * 回收不掉 = 关掉的窗口永远挂在告警里。两侧都按行为测，不碰内部文件格式之外的实现细节。
 */

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "deck-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const dirOf = (dir) => join(dir, IDENTITY_RUNTIME_SUBDIR);
const fileOf = (dir, pid) => join(dirOf(dir), `${pid}.json`);

test("没有会话身份时落盘，有身份时一份文件都不写", async (t) => {
  const dir = await workspace(t);
  const now = new Date("2026-11-06T10:00:00.000Z");

  assert.equal(await announcePresence(dir, { agentId: "", pid: 101, now }), true);
  assert.equal(await announcePresence(dir, { agentId: "agent-1", pid: 202, now }), false);

  const stored = JSON.parse(await readFile(fileOf(dir, 101), "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.pid, 101);
  assert.equal(stored.since, now.toISOString());
  assert.equal(stored.lastTool, null);

  const gaps = await readIdentityGaps(dir, { now, isAlive: () => true });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].pid, 101);
  assert.equal(gaps[0].lastTool, null);
});

test("被拒后更新「最近一次」，但保留这个窗口最初的打开时间", async (t) => {
  const dir = await workspace(t);
  const opened = new Date("2026-11-06T10:00:00.000Z");
  const refused = new Date("2026-11-06T10:05:00.000Z");

  await announcePresence(dir, { agentId: "", pid: 303, now: opened });
  await noteIdentityRefusal(dir, "deck_handoff", { agentId: "", pid: 303, now: refused });

  const [gap] = await readIdentityGaps(dir, { now: refused, isAlive: () => true });
  assert.equal(gap.since, opened.toISOString(), "窗口从打开起就没身份，不是最近一次报错才算");
  assert.equal(gap.lastTool, "deck_handoff");
  assert.equal(gap.lastAt, refused.toISOString());
});

test("没先落盘就被拒也留得下痕迹（工具先于启动痕迹被调用）", async (t) => {
  const dir = await workspace(t);
  const at = new Date("2026-11-06T10:00:00.000Z");
  await noteIdentityRefusal(dir, "deck_staff_request", { agentId: "", pid: 404, now: at });
  const [gap] = await readIdentityGaps(dir, { now: at, isAlive: () => true });
  assert.equal(gap.pid, 404);
  assert.equal(gap.lastTool, "deck_staff_request");
  assert.equal(gap.since, at.toISOString());
});

test("有身份的进程被拒时不落盘：那不该算成缺口", async (t) => {
  const dir = await workspace(t);
  assert.equal(
    await noteIdentityRefusal(dir, "deck_handoff", { agentId: "agent-1", pid: 505 }),
    false,
  );
  assert.deepEqual(await readIdentityGaps(dir, { isAlive: () => true }), []);
});

test("窗口关了（进程没了）痕迹当场回收", async (t) => {
  const dir = await workspace(t);
  await announcePresence(dir, { agentId: "", pid: 606 });
  assert.deepEqual(await readIdentityGaps(dir, { isAlive: () => false }), []);
  assert.deepEqual(await readdir(dirOf(dir)), [], "进程没了的文件要删掉，不能一直堆着");
});

test("坏文件直接清掉，不影响同目录其它缺口", async (t) => {
  const dir = await workspace(t);
  await mkdir(dirOf(dir), { recursive: true });
  await writeFile(fileOf(dir, 707), "{不是 JSON", "utf8");
  await announcePresence(dir, { agentId: "", pid: 808 });

  const gaps = await readIdentityGaps(dir, { isAlive: () => true });
  assert.deepEqual(gaps.map((gap) => gap.pid), [808]);
  await assert.rejects(readFile(fileOf(dir, 707), "utf8"), /ENOENT/);
});

test("从没留过痕的工作区读到空列表，不报错", async (t) => {
  const dir = await workspace(t);
  assert.deepEqual(await readIdentityGaps(dir), []);
});

test("太老的痕迹按陈旧处理：pid 会被复用，不敢再信", async (t) => {
  const dir = await workspace(t);
  await announcePresence(dir, { agentId: "", pid: 909, now: new Date("2026-01-01T00:00:00.000Z") });
  const gaps = await readIdentityGaps(dir, {
    now: new Date("2026-03-01T00:00:00.000Z"),
    isAlive: () => true,
  });
  assert.deepEqual(gaps, []);
  await assert.rejects(readFile(fileOf(dir, 909), "utf8"), /ENOENT/);
});

test("多条缺口按打开时间倒序，且只报前若干条", async (t) => {
  const dir = await workspace(t);
  const base = Date.parse("2026-11-06T00:00:00.000Z");
  for (let index = 0; index < 3; index += 1) {
    await announcePresence(dir, {
      agentId: "",
      pid: 1000 + index,
      now: new Date(base + index * 60_000),
    });
  }
  const gaps = await readIdentityGaps(dir, { isAlive: () => true, limit: 2 });
  assert.deepEqual(gaps.map((gap) => gap.pid), [1002, 1001]);
});
