import assert from "node:assert/strict";
import test from "node:test";
import { groupProgressColumns, ticketsOfMap } from "../shared/group-progress.ts";

/**
 * 群进度是纯汇总：一张地图上的票按仓库并排，列头是开了几张、关了几张。
 * 读票不在这里。期望值是这份例子里能手算出来的数。
 */

const map = {
  repoKey: "owner/app",
  issue: { number: 10, title: "登录地图", state: "OPEN" },
  route: [
    { number: 12, title: "改接口", state: "CLOSED" },
    { number: 11, title: "改界面", state: "OPEN" },
  ],
  references: [
    { repo: "owner/api", number: 4, title: "对方契约", state: "UNKNOWN" },
    { repo: "owner/api", number: 3, title: "对方已关", state: "CLOSED" },
    // 地图自己又被引用了一次：同一仓库同一票号只计一次。
    { repo: "owner/app", number: 10, title: "登录地图", state: "OPEN" },
  ],
};

test("地图、路线和跨仓库引用都进汇总，同一张票不重复计", () => {
  const tickets = ticketsOfMap(map);
  assert.deepEqual(
    tickets.map((ticket) => [ticket.repoKey, ticket.number, ticket.state]),
    [
      ["owner/app", 10, "OPEN"],
      ["owner/app", 12, "CLOSED"],
      ["owner/app", 11, "OPEN"],
      ["owner/api", 4, "UNKNOWN"],
      ["owner/api", 3, "CLOSED"],
      ["owner/app", 10, "OPEN"],
    ],
  );
});

test("按仓库分列：列和列内票号都有固定顺序，开、关、读不到分开数", () => {
  const progress = groupProgressColumns(ticketsOfMap(map));
  assert.deepEqual(
    progress.columns.map((column) => column.repoKey),
    ["owner/api", "owner/app"],
  );
  assert.deepEqual(
    progress.columns[0].tickets.map((ticket) => ticket.number),
    [3, 4],
  );
  assert.deepEqual(
    progress.columns[1].tickets.map((ticket) => ticket.number),
    [10, 11, 12],
  );
  assert.deepEqual(
    progress.columns.map((column) => [column.open, column.closed, column.unknown]),
    [
      [0, 1, 1],
      [2, 1, 0],
    ],
  );
  assert.deepEqual([progress.open, progress.closed, progress.unknown], [2, 2, 1]);
});

test("没有票时三列计数都是 0，不造一个空仓库", () => {
  const progress = groupProgressColumns([]);
  assert.deepEqual(progress.columns, []);
  assert.deepEqual([progress.open, progress.closed, progress.unknown], [0, 0, 0]);
});
