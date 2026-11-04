import assert from "node:assert/strict";
import { test } from "node:test";
import { groupRows, parentKeys, rowKeyOf } from "../client/deck/board/groupRows.ts";

/**
 * 板子的「地图 → 子票」分组。
 *
 * 这一层只做三件事：认出谁是子票、把子票挂到父票下面、折叠时把子票收起来。
 * 所以测的也是这三件——尤其是「父票不在这一屏时子票不能消失」那条：
 * 那种错在界面上看起来只是「票少了」，没人会想到是分组写错了。
 */

const issue = (number, extra = {}) => ({
  repoKey: "o/r",
  number,
  title: `票 ${number}`,
  state: "OPEN",
  isMap: false,
  labels: [],
  assignees: [],
  blockedBy: [],
  readiness: "ready",
  ...extra,
});
const keys = (rows) => rows.map((row) => `${row.depth}:${row.item.number}`);

test("父票在屏上：子票缩进挂在它下面，父行带张数", () => {
  const rows = groupRows([issue(2, { isMap: true }), issue(3, { parentKey: "2" }), issue(4, { parentKey: "2" })], new Set());
  assert.deepEqual(keys(rows), ["0:2", "1:3", "1:4"]);
  assert.equal(rows[0].childCount, 2);
  assert.equal(rows[0].expanded, true, "默认展开：折叠是用户点出来的状态，不是默认");
});

test("折叠后子票不出现在行里，但父行还说得出有几张", () => {
  const rows = groupRows([issue(2), issue(3, { parentKey: "2" })], new Set(["o/r#2"]));
  assert.deepEqual(keys(rows), ["0:2"]);
  assert.equal(rows[0].childCount, 1);
  assert.equal(rows[0].expanded, false);
});

test("父票被筛掉时子票留在顶层：不能因为分组把票弄丢", () => {
  // 筛「未关闭」后父票可能不在了，子票还在——这时它必须自己占一行。
  const rows = groupRows([issue(3, { parentKey: "2" })], new Set());
  assert.deepEqual(keys(rows), ["0:3"]);
  assert.equal(rows[0].childCount, undefined);
});

test("parentKey 带仓库时按整键匹配，不跨仓库串号", () => {
  const rows = groupRows(
    [
      { ...issue(2), repoKey: "a/one" },
      { ...issue(3, { parentKey: "b/two#2" }), repoKey: "b/two" },
      { ...issue(4, { parentKey: "2" }), repoKey: "b/two" },
    ],
    new Set(),
  );
  // a/one#2 不该吃到 b/two#3：票号只在仓库内唯一。
  assert.deepEqual(
    rows.map((row) => `${row.depth}:${row.item.repoKey}#${row.item.number}`),
    ["0:a/one#2", "0:b/two#3", "0:b/two#4"],
  );
});

test("三层就是三层：需求 → 地图 → 票，逐层缩进", () => {
  const rows = groupRows(
    [issue(19), issue(2, { isMap: true, parentKey: "19" }), issue(3, { parentKey: "2" })],
    new Set(),
  );
  assert.deepEqual(keys(rows), ["0:19", "1:2", "2:3"]);
  assert.equal(rows[0].childCount, 1);
  assert.equal(rows[1].childCount, 1);
});

test("折叠中间那层，叶子跟着收起，父行仍说得出张数", () => {
  const rows = groupRows(
    [issue(19), issue(2, { isMap: true, parentKey: "19" }), issue(3, { parentKey: "2" })],
    new Set(["o/r#2"]),
  );
  assert.deepEqual(keys(rows), ["0:19", "1:2"]);
  assert.equal(rows[1].expanded, false);
});

test("层数没有死上限：四层照样缩进，不会把票吞掉", () => {
  const rows = groupRows(
    [
      issue(1),
      issue(2, { parentKey: "1" }),
      issue(3, { parentKey: "2" }),
      issue(4, { parentKey: "3" }),
    ],
    new Set(),
  );
  assert.deepEqual(keys(rows), ["0:1", "1:2", "2:3", "3:4"]);
});

test("自己挂自己、互相挂成环：一行都不吞，只是不缩进", () => {
  const rows = groupRows([issue(5, { parentKey: "5" }), issue(6, { parentKey: "7" }), issue(7, { parentKey: "6" })], new Set());
  assert.equal(rows.length, 3, "三张票都要还在屏上");
  assert.deepEqual(
    rows.map((row) => row.item.number).sort(),
    [5, 6, 7],
  );
});

test("顶层顺序不变：服务端排好的顺序不因为分组被打乱", () => {
  const rows = groupRows([issue(9), issue(2), issue(3, { parentKey: "2" })], new Set());
  assert.deepEqual(keys(rows), ["0:9", "0:2", "1:3"]);
});

test("parentKeys：只报这一屏上真的有子票的父票", () => {
  assert.deepEqual(parentKeys([issue(2), issue(3, { parentKey: "2" }), issue(4, { parentKey: "99" })]), [
    rowKeyOf({ repoKey: "o/r", number: 2 }),
  ]);
  assert.deepEqual(parentKeys([]), []);
});
