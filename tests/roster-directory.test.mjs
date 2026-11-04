import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECK_STAFF_LABEL,
  MAX_STAFF_CARDS,
  normalizeOrchestration,
  planDispatch,
  withWorkspaceRoles,
  workspaceRolesOf,
} from "../shared/orchestration.ts";
import { normalizeStaffCards, rosterOf, withDirectoryRoster } from "../shared/staff.ts";

/**
 * 名册按**目录**归属，不按 workspaceId。
 *
 * 钉的是这一组真实故障：
 * 1. 同一目录在宿主里有好几个 workspaceId（每次重开一个），卡跟着 id 分桶 →
 *    「换个工作区打开，岗位页空了」；
 * 2. 写的时候只清当前 id 不清旧的 → 删掉的卡下次一合并又复活；
 * 3. 成员表把同一目录的每个 id 都列一遍 → 同一批人重复出现几十行。
 */

const cards = (list) => normalizeStaffCards(list);

const settingsOf = (roles) => normalizeOrchestration({ roles });

/** 派单要一条能解析出 provider/model 的路由：默认路由只有客户端、没有模型。 */
const routing = [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }];

const twoIdsSameDir = () =>
  settingsOf([
    { workspaceId: "wks_new", dispatcherAgentId: "d-new" },
    { workspaceId: "wks_old", dispatcherAgentId: "d-old", staff: cards([{ id: "web", name: "前端" }]) },
  ]);

test("同一目录的旧 workspaceId 的卡也要读出来：换工作区打开不会人全没了", () => {
  const settings = twoIdsSameDir();
  assert.deepEqual(
    rosterOf(settings).map((card) => card.id),
    ["web"],
    "wks_new 自己没有 staff，也要拿到 wks_old 里那份名册",
  );
  // 槽位仍按 id：新 id 那条的派单窗口就是新 id 自己的。
  assert.equal(workspaceRolesOf(settings, "wks_new")?.dispatcherAgentId, "d-new");
  assert.equal(workspaceRolesOf(settings, "wks_new")?.staff?.[0]?.id, "web");
  assert.equal(workspaceRolesOf(settings, "wks_old")?.dispatcherAgentId, "d-old");
});

test("全文件都没有这个 id、也没有卡：workspaceRolesOf 回 null，不造一条空绑定", () => {
  assert.equal(workspaceRolesOf(settingsOf([]), "wks_x"), null);
  const onlyCards = settingsOf([{ workspaceId: "wks_old", staff: cards([{ id: "web", name: "前端" }]) }]);
  // 卡在，但不是这个 id 绑的：仍要能取到人（名册属于目录），槽位保持为空。
  const roles = workspaceRolesOf(onlyCards, "wks_new");
  assert.equal(roles?.workspaceId, "wks_new");
  assert.equal(roles?.staff?.length, 1);
  assert.equal(roles?.dispatcherAgentId, undefined);
});

test("合并按 id 去重，同 id 以后来的为准，顺序按第一次出现", () => {
  const settings = settingsOf([
    {
      workspaceId: "w1",
      staff: cards([
        { id: "web", name: "旧名字" },
        { id: "api", name: "后端" },
      ]),
    },
    { workspaceId: "w2", staff: cards([{ id: "web", name: "新名字" }]) },
  ]);
  const roster = rosterOf(settings);
  assert.deepEqual(
    roster.map((card) => `${card.id}:${card.name}`),
    ["web:新名字", "api:后端"],
    "同 id 取后面的版本，位置留在第一次出现处",
  );
});

test("合并封顶 MAX_STAFF_CARDS：两个条目各 20 张也不会读成 40 张", () => {
  const many = (prefix) =>
    cards(Array.from({ length: 20 }, (_, index) => ({ id: `${prefix}${index}`, name: `${prefix}${index}` })));
  const settings = settingsOf([
    { workspaceId: "w1", staff: many("a") },
    { workspaceId: "w2", staff: many("b") },
  ]);
  assert.equal(rosterOf(settings).length, MAX_STAFF_CARDS);
});

test("写：整份名册落到当前 workspaceId，旧 id 那条里的卡被清掉", () => {
  const settings = twoIdsSameDir();
  const next = withDirectoryRoster(settings, "wks_new", cards([{ id: "api", name: "后端" }]));
  assert.deepEqual(
    next.roles.find((role) => role.workspaceId === "wks_new")?.staff?.map((card) => card.id),
    ["api"],
  );
  assert.equal(
    "staff" in (next.roles.find((role) => role.workspaceId === "wks_old") ?? {}),
    false,
    "旧条目只清卡，不留一份迟早会复活",
  );
  // 旧条目的槽位原样保留：清卡不是清历史。
  assert.equal(next.roles.find((role) => role.workspaceId === "wks_old")?.dispatcherAgentId, "d-old");
  assert.deepEqual(rosterOf(next).map((card) => card.id), ["api"], "合并之后也只有这一张");
});

test("删一张卡之后再合并不会复活：清空名册 = 真的空", () => {
  const settings = twoIdsSameDir();
  const emptied = withDirectoryRoster(settings, "wks_new", []);
  assert.deepEqual(rosterOf(emptied), []);
  // 只剩槽位的那条要留着，只剩空壳的那条要丢掉。
  assert.equal(emptied.roles.some((role) => role.workspaceId === "wks_new"), true);
  assert.equal(emptied.roles.find((role) => role.workspaceId === "wks_old")?.dispatcherAgentId, "d-old");
});

test("写：更早的旧条目只剩卡时整条丢掉，不留 {workspaceId} 空壳", () => {
  const settings = settingsOf([
    { workspaceId: "wks_old", staff: cards([{ id: "web", name: "前端" }]) },
    { workspaceId: "wks_new" },
  ]);
  const next = withDirectoryRoster(settings, "wks_new", cards([{ id: "web", name: "前端" }]));
  assert.deepEqual(
    next.roles.map((role) => role.workspaceId),
    ["wks_new"],
  );
});

test("空白 workspaceId：原样返回，不把名册写到一条没有主人名的条目上", () => {
  const settings = twoIdsSameDir();
  assert.equal(withDirectoryRoster(settings, "  ", cards([{ id: "x", name: "x" }])), settings);
});

test("派单看得到同一目录旧 id 上的卡：按 staff 派得出去", () => {
  const settings = twoIdsSameDir();
  const plan = planDispatch({
    workspaceId: "wks_new",
    roles: settings.roles,
    routing,
    profiles: [],
    tasks: [{ key: "#1", prompt: "做事", staff: "web" }],
    maxDepth: 3,
    maxChildrenPerDispatch: 6,
    depth: 1,
    dispatchId: "d1",
  });
  assert.equal(plan.rejected.length, 0, plan.rejected.map((item) => item.detail).join("；"));
  assert.equal(plan.tasks[0].staffId, "web");
  assert.equal(plan.tasks[0].labels[DECK_STAFF_LABEL], "web");
});

test("没写派给谁时也能按领地算出人：旧 id 的卡照样算数", () => {
  const settings = settingsOf([
    { workspaceId: "wks_new", dispatcherAgentId: "d-new" },
    {
      workspaceId: "wks_old",
      staff: cards([{ id: "web", name: "前端", paths: ["src/web"] }]),
    },
  ]);
  const plan = planDispatch({
    workspaceId: "wks_new",
    roles: settings.roles,
    routing,
    profiles: [],
    tasks: [{ key: "#1", prompt: "做事", region: { pathPrefix: "src/web" } }],
    maxDepth: 3,
    maxChildrenPerDispatch: 6,
    depth: 1,
    dispatchId: "d1",
  });
  assert.equal(plan.rejected.length, 0, plan.rejected.map((item) => item.detail).join("；"));
  assert.equal(plan.tasks[0].staffId, "web");
});

test("withWorkspaceRoles 存一次角色绑定不会把名册偷偷搬到别的条目上", () => {
  const settings = twoIdsSameDir();
  const next = withWorkspaceRoles(settings, { workspaceId: "wks_new", dispatcherAgentId: "d-new-2" });
  assert.equal(rosterOf(next).map((card) => card.id).join(","), "web");
  assert.equal(next.roles.find((role) => role.workspaceId === "wks_old")?.staff?.length, 1);
});
