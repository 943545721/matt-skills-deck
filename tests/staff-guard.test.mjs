import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ROOT_MANAGER,
  isPathInStaffTerritory,
  normalizeOwnerPath,
  pathWithinPrefix,
  resolveOwner,
} from "../shared/staff-guard.ts";

/**
 * 归属算法：一条路径归哪张卡。
 *
 * 这里钉住的全是「跳过一层也不报错」那类毛病：
 * 员工卡比经理卡更深时不能把经理层整个跳过；`web` 不能吞 `web-admin`；
 * 局部经理名下没有员工时归经理自己，而不是悄悄回落成「随便找一张员工卡」。
 */

const card = (id, kind, paths) => ({
  id,
  name: id,
  kind,
  ...(paths === undefined ? {} : { paths }),
});

const resolve = (path, roster, options = {}) =>
  resolveOwner({ path, roster, rootManager: null, ...options });

test("经理层优先：员工卡路径更深，也不会跳掉局部经理", () => {
  const roster = [
    card("m-saas", "manager", ["saas"]),
    card("w-deep", "worker", ["saas/src/x"]),
  ];
  const result = resolve("saas/src/x/a.ts", roster);

  assert.equal(result.ok, true);
  assert.equal(result.layer, "worker");
  // 员工是在 m-saas 的领地里找到的：经理层没有被跳过。
  assert.equal(result.staff.id, "w-deep");
  assert.equal(result.manager.id, "m-saas");
  assert.equal(result.matchedPrefix, "saas/src/x");
});

test("经理层取最长前缀：嵌套经理里更深的那张接手", () => {
  const roster = [
    card("m-saas", "manager", ["saas"]),
    card("m-saas-src", "manager", ["saas/src"]),
  ];
  const result = resolve("saas/src/x/a.ts", roster);

  assert.equal(result.ok, true);
  assert.equal(result.layer, "manager");
  assert.equal(result.staff.id, "m-saas-src");
  assert.equal(result.manager.id, "m-saas-src");
});

test("前缀吃到 / 边界：web 不吞 web-admin", () => {
  const roster = [card("m-web", "manager", ["web"])];

  const inside = resolve("web/index.ts", roster);
  assert.equal(inside.ok, true);
  assert.equal(inside.staff.id, "m-web");

  const outside = resolve("web-admin/index.ts", roster);
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, "unclaimed");

  assert.equal(pathWithinPrefix("web-admin/index.ts", "web"), false);
  assert.equal(pathWithinPrefix("web/index.ts", "web"), true);
  assert.equal(pathWithinPrefix("web", "web"), true);
});

test("前缀吃到 / 边界：server/api 归 server，不归 ser", () => {
  const roster = [
    card("m-ser", "manager", ["ser"]),
    card("m-server", "manager", ["server"]),
  ];
  const result = resolve("server/api/user.ts", roster);

  assert.equal(result.ok, true);
  assert.equal(result.layer, "manager");
  assert.equal(result.staff.id, "m-server");
  assert.equal(pathWithinPrefix("server-old/x.ts", "server"), false);
});

test("局部经理领地内没有员工：归经理自己，不回落", () => {
  const roster = [
    card("m-server", "manager", ["server"]),
    card("w-web", "worker", ["web"]),
  ];
  const result = resolve("server/api/user.ts", roster);

  assert.equal(result.ok, true);
  assert.equal(result.layer, "manager");
  assert.equal(result.staff.id, "m-server");
});

test("员工卡不在命中经理的领地里时不算它名下", () => {
  const roster = [
    card("m-server", "manager", ["server"]),
    card("w-saas", "worker", ["saas"]),
  ];
  const result = resolve("server/api/user.ts", roster);

  assert.equal(result.ok, true);
  assert.equal(result.layer, "manager");
  assert.equal(result.staff.id, "m-server");
});

test("整片员工（没填 paths）在局部经理领地里也算接得住", () => {
  const roster = [
    card("m-server", "manager", ["server"]),
    card("w-whole", "worker"),
  ];
  const result = resolve("server/api/user.ts", roster);

  assert.equal(result.ok, true);
  assert.equal(result.layer, "worker");
  assert.equal(result.staff.id, "w-whole");
  assert.equal(result.manager.id, "m-server");
});

test("单卡名册就是它：员工卡、经理卡各一例", () => {
  const worker = resolve("app/x.ts", [card("solo-worker", "worker", ["app"])]);
  assert.equal(worker.ok, true);
  assert.equal(worker.layer, "worker");
  assert.equal(worker.staff.id, "solo-worker");

  const manager = resolve("app/x.ts", [card("solo-manager", "manager", ["app"])]);
  assert.equal(manager.ok, true);
  assert.equal(manager.layer, "manager");
  assert.equal(manager.staff.id, "solo-manager");

  // 单卡但路径不在它声明的领地里：没有根经理就是无主，不硬塞给它。
  const outside = resolve("other/x.ts", [card("solo-worker", "worker", ["app"])]);
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, "unclaimed");
});

test("只有一张卡填了 paths：匹配时它赢过没填 paths 的卡", () => {
  const roster = [
    card("w-whole", "worker"),
    card("w-web", "worker", ["web"]),
  ];
  const result = resolveOwner({ path: "web/x.ts", roster });
  assert.equal(result.ok, true);
  assert.equal(result.staff.id, "w-web");

  // 不在 web 下时，整片那张卡接手。
  const other = resolveOwner({ path: "docs/x.ts", roster });
  assert.equal(other.ok, true);
  assert.equal(other.staff.id, "w-whole");
});

test("无主路径交给确认；默认根经理存在时整片归根经理", () => {
  const roster = [card("w-web", "worker", ["web"])];

  const noRoot = resolve("docs/x.md", roster);
  assert.equal(noRoot.ok, false);
  assert.equal(noRoot.reason, "unclaimed");
  assert.match(noRoot.detail, /docs\/x\.md/);

  const withRoot = resolveOwner({ path: "docs/x.md", roster });
  assert.equal(withRoot.ok, true);
  assert.equal(withRoot.layer, "manager");
  assert.equal(withRoot.staff, DEFAULT_ROOT_MANAGER);
});

test("没有根经理、也没有经理卡：员工自己声明的领地仍然算数", () => {
  const roster = [
    card("w-web", "worker", ["web"]),
    card("w-api", "worker", ["api"]),
  ];

  const hit = resolveOwner({ path: "web/x.ts", roster, rootManager: null });
  assert.equal(hit.ok, true);
  assert.equal(hit.layer, "worker");
  assert.equal(hit.staff.id, "w-web");
  assert.equal(hit.manager, null);

  const miss = resolveOwner({ path: "docs/x.md", roster, rootManager: null });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, "unclaimed");
});

test("不属于任何工作区：roster 为空是另一种拒绝", () => {
  const none = resolveOwner({ path: "server/x.ts", roster: null });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "no-workspace");

  const empty = resolveOwner({ path: "server/x.ts", roster: [], rootManager: null });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "unclaimed");

  const emptyWithRoot = resolveOwner({ path: "server/x.ts", roster: [] });
  assert.equal(emptyWithRoot.ok, true);
  assert.equal(emptyWithRoot.staff, DEFAULT_ROOT_MANAGER);
});

test("isPathInStaffTerritory 与归属算法同一把尺子", () => {
  const server = card("w-server", "worker", ["server"]);
  assert.equal(isPathInStaffTerritory(server, "server/api/user.ts"), true);
  assert.equal(isPathInStaffTerritory(server, "server"), true);
  assert.equal(isPathInStaffTerritory(server, "server-old/user.ts"), false);
  assert.equal(isPathInStaffTerritory(server, "web/user.ts"), false);

  const whole = card("w-whole", "worker");
  assert.equal(isPathInStaffTerritory(whole, "anywhere/at/all.ts"), true);
});

test("领地重叠时，带名册的领地判断与派单归属一致", () => {
  const roster = [
    card("m-deep", "manager", ["saas/src"]),
    card("w-wide", "worker", ["saas"]),
  ];

  // 不带名册：只看这张卡自己声明了什么，`w-wide` 确实声明了 `saas`。
  assert.equal(isPathInStaffTerritory(roster[1], "saas/src/a.ts"), true);

  // 带名册：归属先算经理层，`m-deep` 拿下这片；越界拦截不能把 `w-wide` 放进去。
  const context = { roster, rootManager: null };
  assert.equal(isPathInStaffTerritory(roster[1], "saas/src/a.ts", context), false);
  assert.equal(isPathInStaffTerritory(roster[0], "saas/src/a.ts", context), true);
});

test("路径归一化：反斜杠、前导 /、. 与 ..", () => {
  assert.equal(normalizeOwnerPath("\\server\\api\\user.ts"), "server/api/user.ts");
  assert.equal(normalizeOwnerPath("/server/./api/../api/user.ts"), "server/api/user.ts");
  assert.equal(pathWithinPrefix("./server/api/../api/user.ts", "server/api"), true);
  // 越出工作区根的 `..` 不折回内部，否则越界路径会被误判成在领地内。
  assert.equal(normalizeOwnerPath("../../saas/x.ts"), "../../saas/x.ts");
  assert.equal(pathWithinPrefix("../../saas/x.ts", "saas"), false);
});

test("不改入参", () => {
  const roster = Object.freeze([
    Object.freeze(card("m", "manager", Object.freeze(["saas"]))),
    Object.freeze(card("w", "worker", Object.freeze(["saas/src"]))),
  ]);
  const before = JSON.stringify(roster);
  const result = resolveOwner({ path: "saas/src/a.ts", roster, rootManager: null });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(roster), before);
});
