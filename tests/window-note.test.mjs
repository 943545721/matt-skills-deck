import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOW_NOTE_VERSION,
  isTicketFault,
  renderWindowNote,
  windowNoteId,
} from "../shared/window-note.ts";
import { noteRequirementWindow, requirementNoteSuffix } from "../server/window-note-send.ts";
import {
  listPendingWindowNotes,
  moveWindowNote,
  windowNoteBoxDirOf,
  windowNoteFromDisk,
  writeWindowNote,
} from "../server/window-note-store.ts";

/**
 * 条子是「别让人当消息总线」的那一环：形状、去重、投递前后的箱子都要可验。
 */

function envelope(overrides = {}) {
  const createdAt = "2026-11-06T05:00:00.000Z";
  return {
    version: WINDOW_NOTE_VERSION,
    noteId: windowNoteId({ reason: "bad-impact", detail: "表头不对", requirementKey: 60, at: createdAt }),
    createdAt,
    workspaceId: "ws1",
    fromAgentId: "dispatch-1",
    toRole: "requirement",
    requirementKey: 60,
    reason: "bad-impact",
    detail: "影响面表头第 2 列应该是「依据」，这里是「仓库」。",
    attempts: 0,
    ...overrides,
  };
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "deck-window-note-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("只有票面写坏的拒绝才值得递条子", () => {
  for (const reason of ["bad-impact", "missing-impact", "empty-impact", "unknown-workspace"]) {
    assert.equal(isTicketFault(reason), true, reason);
  }
  for (const reason of ["caller-unknown", "requirement-not-finalized", "concurrency-limit", "", undefined]) {
    assert.equal(isTicketFault(reason), false, String(reason));
  }
});

test("noteId 同一小时内同一个错只算一张条子，换小时才换 id", () => {
  const base = { reason: "bad-impact", detail: "表头不对", requirementKey: 60 };
  const first = windowNoteId({ ...base, at: "2026-11-06T05:01:00.000Z" });
  const sameHour = windowNoteId({ ...base, at: "2026-11-06T05:59:00.000Z" });
  const nextHour = windowNoteId({ ...base, at: "2026-11-06T06:01:00.000Z" });
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first, sameHour);
  assert.notEqual(first, nextHour);
  assert.notEqual(first, windowNoteId({ ...base, detail: "另一句原因", at: "2026-11-06T05:01:00.000Z" }));
});

test("条子说清被拒在哪、该谁改、以及「不是人转述的」", () => {
  const text = renderWindowNote(envelope());
  assert.match(text, /#60/);
  assert.match(text, /影响面表头第 2 列/);
  assert.match(text, /deck_issue_patch/);
  assert.match(text, /用户没有复制粘贴/);

  const english = renderWindowNote(envelope(), "en");
  assert.match(english, /#60/);
  assert.match(english, /nobody relayed it by hand/);
});

test("落盘 → 读回 → 搬家：条子只在 pending 里等一次", async (t) => {
  const dir = await workspace(t);
  const note = envelope();

  const written = await writeWindowNote(dir, note);
  assert.equal(written.ok, true);
  assert.equal(written.duplicate, false);

  // 同一个 noteId 再写一次：重试不该让需求窗口收到一摞一样的条子。
  const again = await writeWindowNote(dir, note);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  // 重复时回报「在哪只箱子里」：调用方要靠它区分「还排着队」与「已经送过 / 送失败过」。
  assert.equal(again.box, "pending");

  const pending = await listPendingWindowNotes(dir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requirementKey, 60);
  assert.equal(pending[0].toRole, "requirement");

  await moveWindowNote(dir, note, "sent");
  assert.deepEqual(await listPendingWindowNotes(dir), []);
  const sent = await readFile(join(windowNoteBoxDirOf(dir, "sent"), `${note.noteId}.json`), "utf8");
  assert.equal(JSON.parse(sent).noteId, note.noteId);

  // 送出去之后再触发同一个错：回报的是「已送过」，不能再说成还排着队。
  const afterSent = await writeWindowNote(dir, note);
  assert.equal(afterSent.duplicate, true);
  assert.equal(afterSent.box, "sent");
});

test("坏条子跳过、不堵队列；没有 pending 目录当作空", async (t) => {
  const dir = await workspace(t);
  assert.deepEqual(await listPendingWindowNotes(dir), []);

  const box = windowNoteBoxDirOf(dir, "pending");
  await mkdir(box, { recursive: true });
  await writeFile(join(box, "0123456789abcdef.json"), "{不是 JSON", "utf8");
  await writeFile(join(box, "fedcba9876543210.json"), JSON.stringify({ version: 1, noteId: "..", toRole: "requirement" }), "utf8");
  const good = envelope();
  await writeWindowNote(dir, good);

  const pending = await listPendingWindowNotes(dir);
  assert.deepEqual(pending.map((item) => item.noteId), [good.noteId]);
});

test("读盘时把外部字段当外部输入：版本、id、角色不对一律不收", () => {
  const base = envelope();
  assert.ok(windowNoteFromDisk(JSON.parse(JSON.stringify(base))) !== null);
  assert.equal(windowNoteFromDisk({ ...base, version: 2 }), null);
  assert.equal(windowNoteFromDisk({ ...base, noteId: "../../etc/passwd" }), null);
  assert.equal(windowNoteFromDisk({ ...base, toRole: "main" }), null);
  assert.equal(windowNoteFromDisk({ ...base, requirementKey: "60" }), null);
  assert.equal(windowNoteFromDisk(null), null);
});

test("读盘时缺了收件人信息或原因不对的条子不收：空 workspaceId 永远找不到人，只能一直躺在队列里", () => {
  const base = envelope();
  assert.equal(windowNoteFromDisk({ ...base, workspaceId: "" }), null);
  assert.equal(windowNoteFromDisk({ ...base, workspaceId: "   " }), null);
  assert.equal(windowNoteFromDisk({ ...base, createdAt: "" }), null);
  assert.equal(windowNoteFromDisk({ ...base, detail: "" }), null);
  // 原因必须还是那四种「票面写坏」：别的拒绝递给需求窗口只是白跑一趟。
  assert.equal(windowNoteFromDisk({ ...base, reason: "requirement-not-finalized" }), null);
  // attempts 是内部计数：缺了当 0，给了个负数 / 非数字就是坏件。
  assert.equal(windowNoteFromDisk({ ...base, attempts: undefined })?.attempts, 0);
  assert.equal(windowNoteFromDisk({ ...base, attempts: -1 }), null);
  assert.equal(windowNoteFromDisk({ ...base, attempts: "3" }), null);
});

test("回执分四种去向：入队不等于送达，送过 / 失败过也要说清", async (t) => {
  const dir = await workspace(t);
  const input = {
    workspaceDir: dir,
    workspaceId: "ws1",
    fromAgentId: "dispatch-1",
    requirementKey: 60,
    reason: "bad-impact",
    detail: "影响面表头第 2 列应该是「依据」。",
  };

  const first = await noteRequirementWindow(input);
  assert.equal(first.status, "queued");
  assert.match(requirementNoteSuffix(first), /放进队列/);
  assert.doesNotMatch(requirementNoteSuffix(first), /已经递给需求窗口|已经送到需求窗口/, "只入队不能说成已送达");

  const again = await noteRequirementWindow(input);
  assert.equal(again.status, "already-queued");
  assert.match(requirementNoteSuffix(again), /还没送到/);

  const [pending] = await listPendingWindowNotes(dir);
  await moveWindowNote(dir, pending, "sent");
  const afterSent = await noteRequirementWindow(input);
  assert.equal(afterSent.status, "already-sent");
  assert.match(requirementNoteSuffix(afterSent), /送进过需求窗口/);

  // 换一句话就是另一张条子（id 按内容算）：把它做成投递失败的，再触发一次要说「之前失败过」。
  const other = { ...input, detail: "影响面表里「要动」那行没写核的人。" };
  assert.equal((await noteRequirementWindow(other)).status, "queued");
  const [second] = await listPendingWindowNotes(dir);
  await moveWindowNote(dir, second, "failed", "需求窗口不在线");
  const failedAgain = await noteRequirementWindow(other);
  assert.equal(failedAgain.status, "already-failed");
  assert.match(requirementNoteSuffix(failedAgain), /failed/);

  // 不是票面问题的拒绝不递；解不出收件人的工作区也不递。
  assert.equal((await noteRequirementWindow({ ...input, reason: "requirement-not-finalized", detail: "还没定稿" })).status, "skipped");
  assert.equal((await noteRequirementWindow({ ...input, workspaceId: "   ", detail: "另一个错" })).status, "skipped");
});
