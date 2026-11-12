import assert from "node:assert/strict";
import test from "node:test";
import {
  planRequirementSplit,
  REQUIREMENT_FINAL_LABEL,
  RESEARCH_LABEL,
} from "../shared/requirement-split.ts";

/**
 * 需求 → 每区一张票的计划层。
 *
 * 重点不在「能不能拼出正文」，而在几道分流：
 * - 没 `deck:定稿` 一张都不铺；
 * - 「待核」只出研究票，不出工作票；
 * - 「要动」但没核的人 / 区里没员工 → 只拒那一区，且不回落；
 * - 跨工作区各成一批，各带自己的派单窗口；
 * - 确认开关只改 `requiresConfirmation`，不改票面计划。
 */

const worker = (id, paths) => ({
  id,
  name: id,
  kind: "worker",
  ...(paths === undefined ? {} : { paths }),
});

const manager = (id, paths) => ({
  id,
  name: id,
  kind: "manager",
  ...(paths === undefined ? {} : { paths }),
});

const requirement = (patch = {}) => ({
  number: 7,
  body: "六节都谈完了",
  labels: ["requirement", REQUIREMENT_FINAL_LABEL],
  ...patch,
});

const workspace = (patch = {}) => ({
  workspaceId: "ws1",
  name: "主工作区",
  roster: [worker("w-server", ["server"])],
  dispatcherAgentId: "dispatch-1",
  ...patch,
});

const row = (patch = {}) => ({
  area: "server",
  pathPrefix: "server",
  // 依据不再是可省略的装饰：拆票层现在会拒绝「没有依据的结论」。
  basis: "server/app.ts:1",
  conclusion: "要动",
  reviewer: "server 的经理（2026-11-03）",
  ...patch,
});

test("没打 deck:定稿：拒绝，并提示先谈完六节、核完影响面", () => {
  const result = planRequirementSplit({
    requirement: requirement({ labels: ["requirement"] }),
    impact: [row()],
    workspaces: [workspace()],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-finalized");
  assert.match(result.detail, /先把六节谈完、影响面核完，再点定稿/);
});

test("定稿了但影响面为空：全局拒绝", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [],
    workspaces: [workspace()],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty-impact");
});

test("待核的区：只出研究票，不出工作票、不进批次", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "apps/h5", pathPrefix: "apps/h5", conclusion: "待核", reviewer: "" })],
    workspaces: [workspace()],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.batches, []);
  assert.equal(result.research.length, 1);

  const research = result.research[0];
  assert.equal(research.parentNumber, 7);
  assert.deepEqual(research.labels, [RESEARCH_LABEL]);
  assert.match(research.body, /Refs: #7/);
  assert.equal(research.area, "apps/h5");
});

test("要动但核的人为空：拒绝这一区并点名，其它区照常出票", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [
      row({ area: "server", pathPrefix: "server" }),
      row({ area: "web", pathPrefix: "web", reviewer: "  " }),
    ],
    workspaces: [
      workspace({ roster: [worker("w-server", ["server"]), worker("w-web", ["web"])] }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].area, "web");
  assert.equal(result.rejected[0].reason, "missing-reviewer");

  assert.equal(result.batches.length, 1);
  assert.deepEqual(
    result.batches[0].tickets.map((ticket) => ticket.area),
    ["server"],
  );
});

test("区里没有员工卡覆盖：明确拒绝，不回落成经理", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "server", pathPrefix: "server" })],
    // 只有一张经理卡，没有员工：经理自己管这片，但工作票不派给经理。
    workspaces: [workspace({ roster: [manager("m-server", ["server"])] })],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.batches, []);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].area, "server");
  assert.equal(result.rejected[0].reason, "no-worker");
  assert.match(result.rejected[0].detail, /不回落/);
});

test("区里没有员工卡覆盖：员工在别的区也不算，不跨区借人", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "server", pathPrefix: "server" })],
    workspaces: [workspace({ roster: [manager("m-root"), worker("w-web", ["web"])] })],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.batches, []);
  assert.equal(result.rejected[0].reason, "no-worker");
});

test("票面：父票挂回需求，正文带 Refs: #7，建议岗位是该区员工", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ repoKey: "server" })],
    workspaces: [workspace()],
  });

  assert.equal(result.ok, true);
  const ticket = result.batches[0].tickets[0];
  assert.equal(ticket.parentNumber, 7);
  assert.match(ticket.body, /Refs: #7/);
  assert.equal(ticket.workspaceId, "ws1");
  assert.equal(ticket.area, "server");
  assert.equal(ticket.repoKey, "server");
  assert.equal(ticket.staff.id, "w-server");
  assert.equal(ticket.staff.kind, "worker");
});

test("跨两个工作区：拆成两批，各带自己的派单窗口与名册", () => {
  const wsOne = workspace({
    workspaceId: "ws-app",
    name: "app",
    dispatcherAgentId: "dispatch-app",
    roster: [worker("w-app", ["server"])],
  });
  const wsTwo = workspace({
    workspaceId: "ws-saas",
    name: "saas",
    dispatcherAgentId: "dispatch-saas",
    roster: [worker("w-saas", ["src"])],
  });

  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [
      row({ area: "app/server", workspaceId: "ws-app", pathPrefix: "server" }),
      row({ area: "saas/src", workspaceId: "ws-saas", pathPrefix: "src" }),
    ],
    workspaces: [wsOne, wsTwo],
  });

  assert.equal(result.ok, true);
  assert.equal(result.batches.length, 2);

  const byId = new Map(result.batches.map((batch) => [batch.workspaceId, batch]));
  assert.equal(byId.get("ws-app").dispatcherAgentId, "dispatch-app");
  assert.equal(byId.get("ws-saas").dispatcherAgentId, "dispatch-saas");
  assert.equal(byId.get("ws-app").tickets[0].staff.id, "w-app");
  assert.equal(byId.get("ws-saas").tickets[0].staff.id, "w-saas");
  assert.equal(byId.get("ws-app").tickets[0].parentNumber, 7);
  assert.equal(byId.get("ws-saas").tickets[0].parentNumber, 7);
});

test("单工作区时，行不写 workspaceId 也落得进去", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ workspaceId: undefined })],
    workspaces: [workspace()],
  });

  assert.equal(result.ok, true);
  assert.equal(result.batches[0].workspaceId, "ws1");
});

test("多工作区时对不上工作区：拒绝这一行，不猜", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "unknown", workspaceId: "nope", pathPrefix: "" })],
    workspaces: [
      workspace({ workspaceId: "ws1", roster: [worker("w1", ["server"])] }),
      workspace({ workspaceId: "ws2", roster: [worker("w2", ["server"])] }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "unknown-workspace");
});

test("多仓库工作区：repoKey 推不出来就拒绝这一区", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "整个工作区", pathPrefix: "", repoKey: "" })],
    workspaces: [
      workspace({
        repos: ["api", "web"],
        // 没有 paths 的员工是整片：能找到人，但路径推不出该落哪个仓库。
        roster: [worker("w-any")],
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.batches, []);
  assert.equal(result.rejected[0].reason, "missing-repo-key");
});

test("多仓库工作区：repoKey 由路径 / 经理领地带出", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "api", pathPrefix: "api", repoKey: "" })],
    workspaces: [
      workspace({
        repos: ["api", "web"],
        roster: [worker("w-api", ["api"]), worker("w-web", ["web"])],
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.batches[0].tickets[0].repoKey, "api");
  assert.equal(result.batches[0].tickets[0].staff.id, "w-api");
});

test("多仓库工作区：仓库键带 owner 前缀时，相对路径与带前缀路径都能落 repoKey 并命中员工", () => {
  const repos = ["943545721/kxhyapp.com", "943545721/kxhyapp.com-saas"];
  const roster = [
    worker("staff-fmmr0g", ["kxhyapp.com-saas/src"]),
    worker("staff-client", ["kxhyapp.com/apps/admin-web"]),
  ];
  for (const area of [
    "kxhyapp.com-saas/src/Service",
    "943545721/kxhyapp.com-saas/src/Service",
  ]) {
    const result = planRequirementSplit({
      requirement: requirement(),
      impact: [row({ area, pathPrefix: area, repoKey: "" })],
      workspaces: [workspace({ repos, roster })],
    });
    assert.equal(result.rejected.length, 0, `${area} 不该被拒：${JSON.stringify(result.rejected)}`);
    const ticket = result.batches[0].tickets[0];
    assert.equal(ticket.repoKey, "943545721/kxhyapp.com-saas", area);
    assert.equal(ticket.staff.id, "staff-fmmr0g", area);
  }
});

test("多仓库工作区：仓库键末段重复时不靠猜，仍按最长匹配或拒绝", () => {
  // 两个仓库末段同名（不同 owner）：基名不足以区分，路径只给基名时不能瞎落。
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "app-saas/src", pathPrefix: "app-saas/src", repoKey: "" })],
    workspaces: [
      workspace({
        repos: ["a/app-saas", "b/app-saas"],
        roster: [worker("w-saas", ["app-saas/src"])],
      }),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.batches.length, 0);
  assert.equal(result.rejected[0].reason, "missing-repo-key");
});

test("多仓库工作区：显式 repoKey 优先", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "api", pathPrefix: "api", repoKey: "api" })],
    workspaces: [
      workspace({
        repos: ["api", "web"],
        roster: [worker("w-api", ["api"]), worker("w-web", ["web"])],
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.batches[0].tickets[0].repoKey, "api");
});

test("单仓库工作区：repoKey 自动落那个仓库", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "整个仓库", pathPrefix: "", repoKey: "" })],
    workspaces: [
      workspace({
        repos: ["api"],
        roster: [worker("w-any")],
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.batches[0].tickets[0].repoKey, "api");
});

test("重复的 workspaceId：只出一批，不重复建票", () => {
  const one = workspace({ roster: [worker("w-server", ["server"])] });
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ workspaceId: "ws1" })],
    workspaces: [one, one],
  });

  assert.equal(result.ok, true);
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].tickets.length, 1);
});

test("多工作区：第一列对不上时按仓库名回退", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "首页", repoKey: "web", pathPrefix: "web" })],
    workspaces: [
      workspace({
        workspaceId: "ws-api",
        roster: [worker("w-api", ["api"])],
        repos: ["api"],
      }),
      workspace({
        workspaceId: "ws-web",
        roster: [worker("w-web", ["web"])],
        repos: ["web"],
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].workspaceId, "ws-web");
  assert.equal(result.batches[0].tickets[0].staff.id, "w-web");
});

test("认不出的结论：拒绝这一区并点名", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "server", pathPrefix: "server", conclusion: "考虑一下" })],
    workspaces: [workspace()],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.batches, []);
  assert.equal(result.rejected[0].area, "server");
  assert.equal(result.rejected[0].reason, "bad-conclusion");
});

test("标签是对象、大小写不同也算定稿", () => {
  const result = planRequirementSplit({
    requirement: requirement({ labels: [{ name: "Deck:定稿" }] }),
    impact: [row()],
    workspaces: [workspace()],
  });

  assert.equal(result.ok, true);
  assert.equal(result.batches.length, 1);
});

test("结论「不动」：不建票也不建研究票，留在 skipped 里", () => {
  const result = planRequirementSplit({
    requirement: requirement(),
    impact: [row({ area: "web", pathPrefix: "web", conclusion: "不动" })],
    workspaces: [workspace({ roster: [worker("w-web", ["web"])] })],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.batches, []);
  assert.deepEqual(result.research, []);
  assert.deepEqual(result.skipped, ["web"]);
});

test("确认开关两种取值：票面计划完全相同，只差 requiresConfirmation", () => {
  const base = {
    requirement: requirement(),
    impact: [
      row({ area: "server", pathPrefix: "server" }),
      row({ area: "apps/h5", pathPrefix: "apps/h5", conclusion: "待核", reviewer: "" }),
    ],
    workspaces: [workspace()],
  };

  const gated = planRequirementSplit({ ...base, confirmRequirementSplit: true });
  const direct = planRequirementSplit({ ...base, confirmRequirementSplit: false });
  const omitted = planRequirementSplit(base);

  assert.equal(gated.ok, true);
  assert.equal(direct.ok, true);
  assert.equal(gated.requiresConfirmation, true);
  assert.equal(direct.requiresConfirmation, false);
  assert.equal(omitted.requiresConfirmation, true);

  assert.deepEqual(gated.batches, direct.batches);
  assert.deepEqual(gated.research, direct.research);
  assert.deepEqual(gated.rejected, direct.rejected);
});
