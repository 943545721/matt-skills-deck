import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeOrchestration } from "../server/orchestration-store.ts";
import { runDispatch } from "../server/orchestration.ts";
import {
  DECK_MAP_LABEL,
  MAX_MAP_CONCURRENCY,
  normalizeMapBudgets,
  normalizeMapRef,
  planDispatch,
} from "../shared/orchestration.ts";

/**
 * 地图并发预算：一张地图同一时刻最多几个子会话。
 *
 * 两处分头钉住：
 * - 纯函数层（`planDispatch`）只管「已经开着的 + 这一批已放行的」够不够用；
 * - 执行层（`runDispatch`）负责去宿主数「已经开着几个」，数不出来要说出来，不能装作拦住了。
 */

const ROLES = [{ workspaceId: "ws-1", dispatcherAgentId: "disp-1" }];
const ROUTING = [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }];
const PROFILES = [];

const plan = (overrides = {}) =>
  planDispatch({
    workspaceId: "ws-1",
    roles: ROLES,
    routing: ROUTING,
    profiles: PROFILES,
    tasks: [],
    maxDepth: 3,
    maxChildrenPerDispatch: 6,
    depth: 1,
    dispatchId: "d-1",
    ...overrides,
  });

const task = (key, extra = {}) => ({ key, prompt: `做 ${key}`, ...extra });

/* ---------------------------------------------------------------- 归一 */

test("地图引用只认三种写法，比较按小写", () => {
  assert.equal(normalizeMapRef("#2"), "#2");
  assert.equal(normalizeMapRef("acme/Mall-Web#12"), "acme/mall-web#12");
  assert.equal(normalizeMapRef("web#3"), "web#3");
  // 写错的不能被「修」成一条指向不存在地图的预算：那会让人以为配好了。
  assert.equal(normalizeMapRef("acme/mall-web"), null);
  assert.equal(normalizeMapRef("#0"), null);
  assert.equal(normalizeMapRef("#"), null);
  assert.equal(normalizeMapRef(""), null);
  assert.equal(normalizeMapRef(2), null);
});

test("预算归一：坏条目丢掉、同一张图只留第一条、并发夹到 1..上限", () => {
  const budgets = normalizeMapBudgets([
    { map: "#2", concurrency: 3 },
    { map: "#2", concurrency: 9 },
    { map: "写错了", concurrency: 2 },
    { map: "acme/web#5", concurrency: 0 },
    { map: "acme/web#6", concurrency: 99 },
    { map: "acme/web#7", concurrency: "3" },
    null,
    { concurrency: 2 },
  ]);
  assert.deepEqual(budgets, [
    { map: "#2", concurrency: 3 },
    { map: "acme/web#5", concurrency: 1 },
    { map: "acme/web#6", concurrency: MAX_MAP_CONCURRENCY },
  ]);
  assert.deepEqual(normalizeMapBudgets(undefined), []);
  assert.deepEqual(normalizeMapBudgets("不是数组"), []);
});

/* ---------------------------------------------------------------- 纯函数层 */

test("没配预算的地图不受限：与接这个功能之前一模一样", () => {
  const result = plan({
    mapBudgets: [{ map: "#2", concurrency: 1 }],
    tasks: [task("t1", { map: "#9" }), task("t2", { map: "#9" })],
  });
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.rejected, []);
});

test("到并发上限就拒：已经开着的与本批已放行的都算", () => {
  const result = plan({
    mapBudgets: [{ map: "#2", concurrency: 2 }],
    runningByMap: { "#2": 1 },
    tasks: [task("t1"), task("t2"), task("t3")],
    map: "#2",
  });
  assert.deepEqual(
    result.tasks.map((entry) => entry.key),
    ["t1"],
    "已经开着 1 个，上限 2，再放 1 个就到顶",
  );
  assert.equal(result.rejected.length, 2);
  for (const rejected of result.rejected) {
    assert.equal(rejected.reason, "map-budget-exhausted");
    assert.match(rejected.detail, /#2/);
    assert.match(rejected.detail, /同时最多跑 2 个/);
    assert.match(rejected.detail, /已经有 2 个/);
  }
});

test("放行的带上地图标签，被拒的不占名额", () => {
  const result = plan({
    mapBudgets: [{ map: "#2", concurrency: 2 }],
    tasks: [task("t1", { prompt: "" }), task("t2"), task("t3")],
    map: "#2",
  });
  // t1 因为提示词为空被拒（不是预算），不该占掉一个名额：上限 2 的两个名额仍归 t2 与 t3。
  assert.deepEqual(result.tasks.map((entry) => entry.key), ["t2", "t3"]);
  assert.deepEqual(
    result.rejected.map((entry) => [entry.key, entry.reason]),
    [["t1", "empty-prompt"]],
  );
  assert.equal(result.tasks[0]?.labels[DECK_MAP_LABEL], "#2");
  assert.equal(result.tasks[0]?.map, "#2", "回执里也要能看出这条落在哪张图上");
});

test("逐条地图优先于批次地图：一张图一个上限", () => {
  const result = plan({
    mapBudgets: [
      { map: "#2", concurrency: 1 },
      { map: "#7", concurrency: 2 },
    ],
    tasks: [task("t1", { map: "#2" }), task("t2", { map: "#2" }), task("t3", { map: "#7" }), task("t4", { map: "#7" })],
    map: "#7",
  });
  assert.deepEqual(result.tasks.map((entry) => entry.key), ["t1", "t3", "t4"]);
  assert.deepEqual(
    result.rejected.map((entry) => entry.key),
    ["t2"],
  );
});

test("地图写法大小写不敏感：配置写大写，派单写小写也认", () => {
  const result = plan({
    mapBudgets: [{ map: "acme/web#3", concurrency: 1 }],
    tasks: [task("t1", { map: "ACME/Web#3" }), task("t2", { map: "acme/web#3" })],
  });
  assert.deepEqual(result.tasks.map((entry) => entry.key), ["t1"]);
  assert.equal(result.rejected[0]?.reason, "map-budget-exhausted");
});

/* ---------------------------------------------------------------- 执行层 */

/** 假宿主：建会话必成，会话清单由 `agents` 给。 */
function fakePaseo({ agents = [] } = {}) {
  const created = [];
  /** 每条会话落进哪条工作区；`null` 表示走了裸 create。 */
  const createdIn = [];
  const create = async (options) => {
    created.push(options);
    return { id: `child-${created.length}` };
  };
  return {
    created,
    createdIn,
    config: {
      get: async () => ({ config: {} }),
      patch: async () => ({ config: {} }),
    },
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      create: async (options) => {
        createdIn.push(null);
        return create(options);
      },
    },
    // 派单按工作区句柄建会话（裸 cwd 会让宿主再登记一条同名工作区），假宿主也得有这条路径。
    workspaces: {
      ref: (workspaceId) => ({
        id: workspaceId,
        agents: {
          create: async (options) => {
            createdIn.push(workspaceId);
            return create(options);
          },
        },
      }),
    },
  };
}

async function workspaceWith(settings) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-map-budget-"));
  const written = await writeOrchestration(dir, settings, { workspaceId: "ws-1" });
  assert.equal(written.ok, true);
  return dir;
}

const BASE = {
  roles: ROLES,
  routing: ROUTING,
  maxDepth: 3,
  maxChildrenPerDispatch: 6,
  reportOnFinish: true,
};

const child = (id, map, status) => ({
  id,
  workspaceId: "ws-1",
  labels: { "deck.child": "1", [DECK_MAP_LABEL]: map },
  status,
});

test("执行层：宿主上已经开着两个，预算 2 时这次一条也派不出去，并说清为什么", async () => {
  const dir = await workspaceWith({ ...BASE, mapBudgets: [{ map: "#2", concurrency: 2 }] });
  const paseo = fakePaseo({ agents: [child("a", "#2", "running"), child("b", "#2", "idle")] });
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [task("t1")],
    map: "#2",
    depth: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(paseo.created.length, 0, "超了预算就不该建会话");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].reason, "map-budget-exhausted");
  assert.match(result.results[0].detail, /已经有 2 个/);
});

test("执行层：已关闭的子会话不占名额；开着的不带地图标也不占", async () => {
  const dir = await workspaceWith({ ...BASE, mapBudgets: [{ map: "#2", concurrency: 2 }] });
  const paseo = fakePaseo({
    agents: [
      child("a", "#2", "closed"),
      // 接预算之前派出去的：没有 deck.map 标，不知道它替哪张图干活，就不硬算。
      { id: "b", workspaceId: "ws-1", labels: { "deck.child": "1" }, status: "running" },
    ],
  });
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [task("t1")],
    map: "#2",
    depth: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(paseo.created.length, 1);
  // 新建的子会话必须带上地图标，否则下一次派单照样数不到。
  assert.equal(paseo.created[0].labels[DECK_MAP_LABEL], "#2");
  // 落进这条工作区，否则宿主会为同一目录再登记一条同名工作区。
  assert.deepEqual(paseo.createdIn, ["ws-1"]);
});

test("执行层：读不到会话清单时明说「这次只按本批算」，不装作拦住了", async () => {
  const dir = await workspaceWith({ ...BASE, mapBudgets: [{ map: "#2", concurrency: 1 }] });
  const paseo = fakePaseo();
  paseo.agents.list = async () => {
    throw new Error("agents.list 挂了");
  };
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [task("t1")],
    map: "#2",
    depth: 1,
  });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(" "), /只能按本批算/);
  assert.equal(result.results[0].ok, true, "数不到就不拦：拦了等于拿「不知道」当「满了」");
});

test("执行层：配了预算却没说是哪张地图的票，要说出来", async () => {
  const dir = await workspaceWith({ ...BASE, mapBudgets: [{ map: "#2", concurrency: 1 }] });
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [task("t1")],
    depth: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.match(result.warnings.join(" "), /没带 map：这些任务不受预算约束/);
});
