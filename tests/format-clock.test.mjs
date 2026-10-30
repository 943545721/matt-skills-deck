import assert from "node:assert/strict";
import { test } from "node:test";
import { clockText } from "../client/deck/format.ts";

/**
 * 列表里那一列时间。
 *
 * 这一格写错不会报错，只会让人读错事实（「今早改的」看成「十天前」），
 * 所以三档粒度各钉一条：同一天、今年内跨天、跨年。
 */

const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute).toISOString();

test("同一天只写时分：扫的是「今天动没动」", () => {
  const now = new Date(2026, 9, 30, 23, 0).getTime();
  assert.equal(clockText(at(2026, 10, 30, 14, 5), now), "14:05");
});

test("今年内跨天带月日，不写年份", () => {
  const now = new Date(2026, 9, 30, 12, 0).getTime();
  assert.equal(clockText(at(2026, 10, 18, 16, 50), now), "10-18 16:50");
});

test("跨年带年份：老票只写月日会被读成今年", () => {
  const now = new Date(2026, 0, 3, 9, 0).getTime();
  assert.equal(clockText(at(2025, 12, 28, 16, 50), now), "2025-12-28 16:50");
});

test("解析不了回空串：这一格留空，不编一个时间", () => {
  assert.equal(clockText("", Date.now()), "");
  assert.equal(clockText("not-a-date", Date.now()), "");
});

test("workRoute 那条时间与板子共用同一份实现", async () => {
  const { workRouteClock } = await import("../client/deck/surfaces/workRoute.ts");
  assert.equal(workRouteClock, clockText, "两处对同一时刻不能有两种写法");
});
