import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { listLogs, record, recordStartup, resetLogs } from "../server/logs.ts";
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

test("启动行：开关打开时记一条，带版本、Node 与 pid", () => {
  resetLogs();
  settings(true);
  recordStartup({ version: "0.1.0", node: "v22.0.0" });
  const entries = listLogs();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].scope, "plugin");
  assert.match(entries[0].message, /v0\.1\.0/);
  assert.match(entries[0].message, /v22\.0\.0/);
  assert.match(entries[0].message, new RegExp(String(process.pid)));
  assert.match(entries[0].message, /重载即清空/);
});

test("启动行：调试日志关着时不记，空面板由界面解释", () => {
  resetLogs();
  settings(false);
  recordStartup({ version: "0.1.0", node: "v22.0.0" });
  assert.equal(listLogs().length, 0);
});
