import assert from "node:assert/strict";
import test from "node:test";
import { mapSkeletonBody, parseMapBody } from "../server/tracker/map-body.ts";

/**
 * 项目地图骨架。
 *
 * 骨架的唯一价值是「生成的东西能被自己读回来」，所以这里不走断言字符串的捷径：
 * 生成 → `parseMapBody` → 检查五个区块都落到了该去的地方。
 */

const project = { key: "admin-web", dir: "apps/admin-web" };

test("骨架能被读回来：五个区块都在，空区块不算空", () => {
  const body = mapSkeletonBody({ destination: "把管理端的下单链路梳理清楚", areas: ["orders", "users"], project });
  const map = parseMapBody(body);

  assert.equal(map.destination, "把管理端的下单链路梳理清楚");
  assert.match(map.notes, /只覆盖 admin-web（apps\/admin-web）/);
  assert.deepEqual(map.decisions.map((item) => item.title), ["area:orders", "area:users"]);
  assert.equal(map.fog.length, 2);
  assert.match(map.outOfScope.join(" "), /跨项目聚合/);
});

test("按模块分组：每个 area 都有自己的决策位与雾", () => {
  const map = parseMapBody(mapSkeletonBody({ destination: "x", areas: ["api", "auth", "billing"], project }));
  assert.deepEqual(map.decisions.map((item) => item.title), ["area:api", "area:auth", "area:billing"]);
  // 解析层保留列表符号（与源仓库同口径），这里按「去符号后的键」比。
  assert.deepEqual(map.fog.map((line) => line.replace(/^-\s*/, "").split("：")[0]), ["api", "auth", "billing"]);
});

test("没有配置 areas 时归到未分组，而不是生成空图", () => {
  const map = parseMapBody(mapSkeletonBody({ destination: "", areas: [], project: null }));
  assert.deepEqual(map.decisions.map((item) => item.title), ["area:未分组"]);
  assert.equal(map.destination, "待写：这条路线最终要到达的那件事。");
  assert.match(map.notes, /未在配置里登记/);
});

test("跨项目引用与「不做聚合」写进正文，人说清楚了自己在哪张图", () => {
  const body = mapSkeletonBody({ destination: "x", areas: ["api"], project });
  assert.match(body, /Blocked by: owner\/repo#12/);
  assert.match(body, /项目键#12/);
  assert.match(body, /不做跨项目聚合/);
  // 只有这五个二级标题：骨架不该顺手加出别的区块，读的人会以为那是新的约定。
  assert.equal(body.match(/^## /gm).length, 5);
});
