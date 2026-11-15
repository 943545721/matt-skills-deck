import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  clearProviderEntryDeleted,
  deletedProviderEntries,
  markProviderEntryDeleted,
  setTombstoneStatePathForTest,
} from "../server/provider-tombstones.ts";

let tombstoneDir;
let statePath;
test.beforeEach(() => {
  tombstoneDir = mkdtempSync(path.join(tmpdir(), "deck-tombstones-"));
  statePath = path.join(tombstoneDir, "state.json");
  setTombstoneStatePathForTest(statePath);
});
test.afterEach(() => {
  setTombstoneStatePathForTest(null);
  rmSync(tombstoneDir, { recursive: true, force: true });
});

const malformedStates = [
  ["缺少 deletedProviderEntries", JSON.stringify({ version: 1 })],
  ["deletedProviderEntries 不是数组", JSON.stringify({ version: 1, deletedProviderEntries: "codex" })],
  ["数组含非字符串 id", JSON.stringify({ version: 1, deletedProviderEntries: ["codex", 7] })],
  ["数组含空白 id", JSON.stringify({ version: 1, deletedProviderEntries: ["codex", " "] })],
];

for (const [description, contents] of malformedStates) {
  test(`合法 JSON 但${description}：读失败且 mark/clear 不覆写文件`, () => {
    writeFileSync(statePath, contents, "utf8");

    const read = deletedProviderEntries();
    const marked = markProviderEntryDeleted("new-entry");
    const cleared = clearProviderEntryDeleted("codex");

    assert.equal(read.ok, false);
    assert.ok(!read.ok && read.detail, "损坏状态应给出结构错误详情");
    assert.deepEqual(marked, read, "不能在损坏状态上添加墓碑，应保留读取失败详情");
    assert.deepEqual(cleared, read, "不能从损坏状态上清墓碑，应保留读取失败详情");
    assert.equal(readFileSync(statePath, "utf8"), contents, "损坏文件必须逐字节保留");
  });
}

test("状态文件不存在时按空墓碑集合读取", () => {
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: [] });
});

test("合法的空 deletedProviderEntries 数组可正常读取和更新", () => {
  const contents = '{"version":1,"deletedProviderEntries":[]}';
  writeFileSync(statePath, contents, "utf8");

  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: [] });
  assert.deepEqual(markProviderEntryDeleted("codex"), { ok: true });
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: ["codex"] });
  assert.deepEqual(clearProviderEntryDeleted("codex"), { ok: true });
  assert.deepEqual(deletedProviderEntries(), { ok: true, ids: [] });
});

for (const [action, ids, run] of [
  ["mark", [], () => markProviderEntryDeleted("codex")],
  ["clear", ["codex"], () => clearProviderEntryDeleted("codex")],
]) {
  test(`${action} 写入与临时文件清理都失败时保留最初原因与旧状态`, (t) => {
    const contents = JSON.stringify({ version: 1, deletedProviderEntries: ids });
    writeFileSync(statePath, contents, "utf8");
    const secret = "synthetic-state-error-secret-e14c9";
    const originalWrite = fs.writeFileSync;
    const originalRemove = fs.rmSync;
    const isTemp = (target) => String(target).startsWith(`${statePath}.`) && String(target).endsWith(".tmp");
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    t.mock.method(fs, "writeFileSync", (target, ...args) => {
      if (isTemp(target)) throw Object.assign(new Error(secret), { code: "ENOSPC" });
      return originalWrite(target, ...args);
    });
    t.mock.method(fs, "rmSync", (target, ...args) => {
      if (isTemp(target)) throw Object.assign(new Error(secret), { code: "EACCES" });
      return originalRemove(target, ...args);
    });
    syncBuiltinESMExports();

    let result;
    assert.doesNotThrow(() => { result = run(); });
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes(statePath));
    assert.match(result.detail, /写入.*ENOSPC/);
    assert.match(result.detail, /清理.*EACCES/);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(readFileSync(statePath, "utf8"), contents);
  });
}

for (const [action, ids, expectedIds, run] of [
  ["mark", ["claude", "deck-codex"], ["claude", "deck-codex", "codex"], () => markProviderEntryDeleted("codex")],
  ["clear", ["claude", "codex", "deck-codex"], ["claude", "deck-codex"], () => clearProviderEntryDeleted("codex")],
]) {
  test(`${action} 临时文件重命名被拒时保留旧删除记录且不直接写回旧文件`, (t) => {
    const contents = `${JSON.stringify({ version: 1, deletedProviderEntries: ids }, null, 2)}\r\n`;
    writeFileSync(statePath, contents, "utf8");
    const previous = readFileSync(statePath);
    const secret = "synthetic-rename-state-secret-61ba4";
    const originalRename = fs.renameSync;
    const originalWrite = fs.writeFileSync;
    let stagedIds;
    let directWriteAttempted = false;
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    t.mock.method(fs, "renameSync", (source, target, ...args) => {
      if (path.resolve(String(target)) === statePath) {
        assert.equal(path.dirname(path.resolve(String(source))), tombstoneDir);
        stagedIds = JSON.parse(readFileSync(source, "utf8")).deletedProviderEntries;
        throw Object.assign(new Error(secret), { code: "EACCES" });
      }
      return originalRename(source, target, ...args);
    });
    t.mock.method(fs, "writeFileSync", (target, ...args) => {
      if (path.resolve(String(target)) === statePath) directWriteAttempted = true;
      return originalWrite(target, ...args);
    });
    syncBuiltinESMExports();

    const result = run();

    assert.deepEqual(stagedIds, expectedIds, "临时文件应包含本次操作预期的新状态");
    assert.deepEqual(result, { ok: false, detail: `写入删除记录 ${statePath} 失败（EACCES）` });
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.deepEqual(readFileSync(statePath), previous, "重命名失败必须逐字节保留旧删除记录");
    assert.deepEqual(deletedProviderEntries(), { ok: true, ids });
    assert.equal(directWriteAttempted, false, "不能降级为直接写入旧文件，否则可能截断旧删除记录");
  });
}

test("删除记录的坏 JSON 不把解析器原文带到结果中", () => {
  const secret = "synthetic-state-json-secret-3b5a7";
  const contents = `${secret} {`;
  writeFileSync(statePath, contents, "utf8");

  const result = deletedProviderEntries();

  assert.equal(result.ok, false);
  assert.equal(result.detail, `${statePath} 不是合法 JSON，请修正文件格式后重试`);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(readFileSync(statePath, "utf8"), contents);
});
