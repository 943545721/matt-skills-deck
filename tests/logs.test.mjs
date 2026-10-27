import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { listLogs, record, resetLogs } from "../server/logs.ts";
import { setSettingsForTest } from "../server/settings.ts";

const settings = (debugLogging) => setSettingsForTest({ backend: "auto", refreshSeconds: 60, debugLogging });

afterEach(() => {
  resetLogs();
  settings(true);
});

test("日志：最新在前，limit 只截最近 N 条", () => {
  resetLogs();
  settings(true);
  record("info", "a", "一");
  record("warn", "b", "二");
  record("error", "c", "三");
  assert.deepEqual(listLogs().map((entry) => entry.message), ["三", "二", "一"]);
  assert.deepEqual(listLogs(2).map((entry) => entry.message), ["三", "二"]);
  assert.equal(listLogs(0).length, 1, "limit 下限收敛为 1，不会返回空数组");
});

test("日志：关掉调试后不再累积，已有记录仍在（用户还能导出再清空）", () => {
  resetLogs();
  settings(true);
  record("info", "a", "保留");
  settings(false);
  record("info", "b", "不该出现");
  assert.deepEqual(listLogs().map((entry) => entry.message), ["保留"]);
});

test("日志：环形缓冲最多 200 条，溢出从最旧的开始丢", () => {
  resetLogs();
  settings(true);
  for (let index = 0; index < 205; index += 1) record("info", "loop", `第 ${index} 条`);
  const entries = listLogs(200);
  assert.equal(entries.length, 200);
  assert.equal(entries[0].message, "第 204 条");
  assert.equal(entries[199].message, "第 5 条");
});

test("日志：清空后长度归零，下一条从头开始", () => {
  resetLogs();
  settings(true);
  record("info", "a", "一");
  assert.equal(listLogs().length, 1);
  resetLogs();
  assert.equal(listLogs().length, 0);
  record("info", "a", "二");
  assert.deepEqual(listLogs().map((entry) => entry.message), ["二"]);
});
