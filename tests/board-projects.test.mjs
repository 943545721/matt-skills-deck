import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableFacets,
  filterByFacets,
  issueAreas,
  issueRoles,
  projectRepoKey,
  projectRows,
} from "../client/deck/board/projectRows.ts";

/**
 * 任务板的项目条与 area / role 筛选（纯计算）。
 *
 * 这里钉住三件事：项目条上的数字与列表同源、项目与仓库键的对应不能瞎猜、
 * 筛选项只从配置来——任何一处改成「从标签反推」，筛出来的结果就会随窗口变化。
 */

const project = (overrides = {}) => ({
  key: "api",
  dir: "mall-api",
  repo: "acme/mall-api",
  owner: "backend",
  areas: ["orders", "auth"],
  resolved: { owner: "acme", name: "mall-api" },
  problem: null,
  ...overrides,
});

const issue = (repoKey, number, extra = {}) => ({
  repoKey,
  number,
  state: "OPEN",
  readiness: "ready",
  labels: [],
  ...extra,
});

test("项目 → 仓库键：resolved 优先，其次按目录、按名字兜底，猜不出来给 null", () => {
  const repos = [
    { key: "acme/mall-api", name: "mall-api", dir: "/ws/mall-api" },
    { key: "acme/mall-web", name: "mall-web", dir: "/ws/apps/admin-web" },
  ];
  assert.equal(projectRepoKey(project(), repos), "acme/mall-api");
  // RPC 只给 owner/name，也要能拼出来。
  assert.equal(projectRepoKey(project({ resolved: { owner: "acme", name: "mall-web" } }), repos), "acme/mall-web");
  assert.equal(
    projectRepoKey(project({ resolved: null, dir: "apps/admin-web", repo: null }), repos),
    "acme/mall-web",
    "目录对得上就用它",
  );
  assert.equal(projectRepoKey(project({ resolved: null, repo: null, dir: "nope" }), repos), null);
});

test("项目条：数字只数当前窗口里的票，且与列表同源", () => {
  const rows = projectRows(
    [
      project(),
      project({
        key: "web",
        dir: "apps/admin-web",
        repo: "acme/mall-web",
        owner: "frontend",
        areas: ["orders"],
        resolved: { owner: "acme", name: "mall-web" },
      }),
    ],
    [
      issue("acme/mall-api", 1, { readiness: "ready" }),
      issue("acme/mall-api", 2, { readiness: "blocked" }),
      issue("acme/mall-api", 3, { state: "CLOSED", readiness: "closed" }),
      issue("acme/mall-web", 4, { readiness: "claimed" }),
    ],
    [
      { key: "acme/mall-api", name: "mall-api", dir: "/ws/mall-api" },
      { key: "acme/mall-web", name: "mall-web", dir: "/ws/apps/admin-web" },
    ],
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.open, row.closed, row.ready, row.blocked]),
    [
      ["api", 2, 1, 1, 1],
      ["web", 1, 0, 0, 0],
    ],
  );
  assert.equal(rows[0].owner, "backend");
});

test("项目条：目录读不出来的项目照常出一行，并带着原因", () => {
  const rows = projectRows([project({ resolved: null, repo: null, problem: "目录不存在：mall-api" })], [], []);
  assert.equal(rows.length, 1, "少一行会被当成项目没了");
  assert.equal(rows[0].repoKey, null);
  assert.equal(rows[0].open, 0);
  assert.match(rows[0].problem, /目录不存在/);
});

test("筛选项只来自配置：去重、排序，不掺标签", () => {
  const facets = availableFacets([
    project({ areas: ["orders", "auth"] }),
    project({ key: "web", areas: ["orders", "pc-web"], owner: "frontend" }),
  ]);
  assert.deepEqual(facets.areas, ["auth", "orders", "pc-web"]);
  assert.deepEqual(facets.roles, ["backend", "frontend"]);
});

test("area / role 叠加筛选：两维是与关系，空字符串那一维不筛", () => {
  const rows = [
    issue("a/b", 1, { labels: [{ name: "area:pc-web", color: "000000" }, { name: "role:frontend", color: "000000" }] }),
    issue("a/b", 2, { labels: [{ name: "area:pc-api", color: "000000" }, { name: "role:frontend", color: "000000" }] }),
    issue("a/b", 3, { labels: [] }),
  ];
  assert.deepEqual(
    filterByFacets(rows, { area: "pc-web", role: "" }).map((item) => item.number),
    [1],
  );
  assert.deepEqual(
    filterByFacets(rows, { area: "", role: "frontend" }).map((item) => item.number),
    [1, 2],
  );
  assert.deepEqual(
    filterByFacets(rows, { area: "pc-web", role: "backend" }).map((item) => item.number),
    [],
  );
  assert.equal(filterByFacets(rows, { area: "", role: "" }).length, 3);
});

test("area / role 徽标从标签里取，前缀不混进来", () => {
  const item = {
    labels: [
      { name: "area:orders", color: "000000" },
      { name: "area:auth", color: "000000" },
      { name: "role:backend", color: "000000" },
      { name: "bug", color: "000000" },
    ],
  };
  assert.deepEqual(issueAreas(item), ["orders", "auth"]);
  assert.deepEqual(issueRoles(item), ["backend"]);
});
