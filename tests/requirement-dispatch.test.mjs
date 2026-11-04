import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  planRequirementDispatch,
  requirementWorkspacesOf,
  runRequirementDispatch,
} from "../server/requirement-dispatch.ts";
import { getLocalIssue } from "../server/tracker/local.ts";

/**
 * 需求 → 每区一张票 + 每区一批派单。
 *
 * 这里只测计划层（不连宿主、不建票）：确认开关两边的票面必须逐字相同，
 * 跨工作区各用各的名册 / 派单窗口，缺行或依据为空时点名拒绝。
 */

const requirementBody = (...rows) =>
  [
    "## 影响面",
    "| 区 / 仓库 | 依据 | 结论 | 核的人 | 链条（没有就留空） |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");

const requirement = (patch = {}) => ({
  number: 7,
  body: requirementBody(
    "| app | app/server.ts:1 | 要动 | app 的经理（2026-11-03） | |",
    "| saas | src/client.ts:1 | 要动 | saas 的经理（2026-11-03） | |",
  ),
  labels: ["requirement", "deck:定稿"],
  ...patch,
});

function settings(workspaceId, dispatcherAgentId, staff, extra = {}) {
  return {
    version: 1,
    updatedAt: "2026-11-03T00:00:00.000Z",
    workspaceId,
    roles: [{ workspaceId, mainAgentId: `main-${workspaceId}`, dispatcherAgentId, staff }],
    routing: [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }],
    maxDepth: 3,
    maxChildrenPerDispatch: 5,
    reportOnFinish: true,
    ...extra,
  };
}

async function workspace(t, workspaceId, name, dispatcherAgentId, staff, repoNames, extra) {
  const dir = await mkdtemp(join(tmpdir(), `deck-req-dispatch-${workspaceId}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify(settings(workspaceId, dispatcherAgentId, staff, extra)),
    "utf8",
  );
  return { workspaceId, workspaceDir: dir, name, repos: repoNames, dispatcherAgentId };
}

/** 只够跑通「建票 + 建会话」的假宿主。 */
function fakePaseo() {
  const created = [];
  return {
    created,
    config: { get: async () => ({ config: {} }) },
    agents: {
      list: async () => ({ entries: [] }),
      create: async (options) => {
        created.push(options);
        return { id: `child-${created.length}` };
      },
    },
    workspaces: {
      ref: (workspaceId) => ({
        id: workspaceId,
        agents: {
          create: async (options) => {
            created.push(options);
            return { id: `child-${created.length}` };
          },
        },
      }),
    },
  };
}

async function twoWorkspaces(t) {
  return [
    await workspace(t, "ws-app", "app", "dispatch-app", [{ id: "w-app", name: "应用", kind: "worker", duty: "改应用" }], ["app"]),
    await workspace(t, "ws-saas", "saas", "dispatch-saas", [{ id: "w-saas", name: "SaaS", kind: "worker", duty: "改 SaaS" }], ["saas"]),
  ];
}

test("按影响面拆成每区一批：各用自己工作区的名册与派单窗口", async (t) => {
  const result = await planRequirementDispatch({
    // 需求票在 app 仓库；saas 那批的子票不能拿自己的仓库冒充需求的仓库。
    requirement: requirement({ repoKey: "app" }),
    workspaces: await twoWorkspaces(t),
  });
  assert.equal(result.ok, true);
  assert.equal(result.batches.length, 2);

  const [app, saas] = result.batches;
  assert.equal(app.workspaceId, "ws-app");
  assert.equal(app.dispatcherAgentId, "dispatch-app");
  assert.equal(app.entries.length, 1);
  assert.equal(app.entries[0].ticket.staff.id, "w-app");
  assert.equal(app.entries[0].task.staffId, "w-app");
  assert.equal(app.entries[0].task.requirementKey, 7);
  assert.equal(app.entries[0].task.requirementRepoKey, "app");
  assert.equal(app.entries[0].task.repoKey, "app");

  assert.equal(saas.workspaceId, "ws-saas");
  assert.equal(saas.dispatcherAgentId, "dispatch-saas");
  assert.equal(saas.entries[0].ticket.staff.id, "w-saas");
  assert.equal(saas.entries[0].task.repoKey, "saas");
  assert.equal(saas.entries[0].task.requirementRepoKey, "app");
});

test("需求批次预览与执行同判：模型从宿主清单删掉后预览也不再显示默认档", async (t) => {
  // 预览（planRequirementDispatch）与执行（runDispatch）必须按同一份宿主配置裁默认档，
  // 否则模型删掉后清单上还写着默认档，点确认却一个也不带。
  const modelThinking = [{ provider: "claude", model: "sonnet", thinkingOptionId: "high" }];
  const workspaces = [
    await workspace(t, "ws-app", "app", "dispatch-app", [{ id: "w-app", name: "应用", kind: "worker", duty: "改应用" }], ["app"], { modelThinking }),
    await workspace(t, "ws-saas", "saas", "dispatch-saas", [{ id: "w-saas", name: "SaaS", kind: "worker", duty: "改 SaaS" }], ["saas"], { modelThinking }),
  ];

  const live = await planRequirementDispatch({
    requirement: requirement({ repoKey: "app" }),
    workspaces,
    daemonConfig: { agents: { providers: { claude: { additionalModels: [{ id: "sonnet" }] } } } },
  });
  assert.equal(live.ok, true, JSON.stringify(live));
  assert.equal(live.batches.length, 2, "两个区各一批；批数退化时下面的循环会空跑");
  for (const batch of live.batches) {
    assert.equal(batch.entries[0].task.target.thinkingOptionId, "high", `${batch.workspaceId} 的模型还在清单里`);
  }

  const removed = await planRequirementDispatch({
    requirement: requirement({ repoKey: "app" }),
    workspaces,
    daemonConfig: { agents: { providers: { claude: { additionalModels: [] } } } },
  });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  for (const batch of removed.batches) {
    assert.equal(
      "thinkingOptionId" in batch.entries[0].task.target,
      false,
      `${batch.workspaceId} 的模型已从清单删掉，预览不该再显示默认档`,
    );
  }
});

test("票面父挂回需求：父票号与 Refs 都指向需求", async (t) => {
  const result = await planRequirementDispatch({
    requirement: requirement(),
    workspaces: await twoWorkspaces(t),
  });
  assert.equal(result.ok, true);
  for (const batch of result.batches) {
    for (const entry of batch.entries) {
      assert.equal(entry.ticket.parentNumber, 7);
      assert.match(entry.ticket.body, /Refs: #7/);
    }
  }
});

test("确认开关只决定先说还是直接铺，票面计划完全相同", async (t) => {
  const workspaces = await twoWorkspaces(t);
  const listed = await planRequirementDispatch({ requirement: requirement(), workspaces, confirmRequirementSplit: true });
  const direct = await planRequirementDispatch({ requirement: requirement(), workspaces, confirmRequirementSplit: false });
  assert.equal(listed.ok, true);
  assert.equal(direct.ok, true);
  assert.equal(listed.requiresConfirmation, true);
  assert.equal(direct.requiresConfirmation, false);
  assert.deepEqual(
    listed.batches.map((batch) => batch.entries.map((entry) => entry.ticket.body)),
    direct.batches.map((batch) => batch.entries.map((entry) => entry.ticket.body)),
  );
  assert.deepEqual(listed.batches.map((batch) => batch.dispatchId), direct.batches.map((batch) => batch.dispatchId));
});

test("跨区但正文没有影响面表 → 拒绝并说清要补哪一节", async (t) => {
  const result = await planRequirementDispatch({
    requirement: requirement({ body: "六节都谈完了" }),
    workspaces: await twoWorkspaces(t),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-impact");
  assert.match(result.detail, /影响面/);
});

test("某区依据为空 → 只拒那一个区，另一个区照常出计划", async (t) => {
  const result = await planRequirementDispatch({
    requirement: requirement({
      body: requirementBody(
        "| app | app/server.ts:1 | 要动 | app 的经理（2026-11-03） | |",
        "| saas |  | 要动 | saas 的经理（2026-11-03） | |",
      ),
    }),
    workspaces: await twoWorkspaces(t),
  });
  assert.equal(result.ok, true);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].area, "saas");
  assert.equal(result.rejected[0].reason, "empty-basis");
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].workspaceId, "ws-app");
});

test("某区坏行只拦那一区：执行时别的区照常建票开会话", async (t) => {
  // 本地 .deck 只认 local 仓库键：不给仓库覆盖，让后端自己解析成 local。
  const workspaces = (await twoWorkspaces(t)).map((workspace) => ({ ...workspace, repos: [] }));
  const paseo = fakePaseo();
  const result = await runRequirementDispatch(paseo, {
    requirement: requirement({
      body: requirementBody(
        "| app | app/server.ts:1 | 要动 | app 的经理（2026-11-03） | |",
        "| saas |  | 要动 | saas 的经理（2026-11-03） | |",
      ),
    }),
    workspaces,
    confirmRequirementSplit: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.plan.rejected.length, 1);
  assert.equal(result.plan.rejected[0].area, "saas");
  // 坏行不该拿整张需求复检，把 app 这一批也一起拦掉。
  assert.deepEqual(result.batches.map((batch) => batch.workspaceId), ["ws-app"]);
  assert.deepEqual(result.batches[0].blocked, []);
  assert.equal(paseo.created.length, 1);
  assert.equal((await getLocalIssue(workspaces[0].workspaceDir, 1)).ok, true);
  assert.equal((await getLocalIssue(workspaces[1].workspaceDir, 1)).ok, false);
});

test("需求没定稿 → 一张都不拆", async (t) => {
  const result = await planRequirementDispatch({
    requirement: requirement({ labels: ["requirement"] }),
    workspaces: await twoWorkspaces(t),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-finalized");
});

test("拿不到需求票号 → 不给计划", async (t) => {
  const result = await planRequirementDispatch({
    requirement: requirement({ number: Number.NaN }),
    workspaces: await twoWorkspaces(t),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-requirement");
});

test("工作区没指派单窗口 → 拒绝并点名那个工作区", async (t) => {
  const bad = await workspace(t, "ws-empty", "empty", "", [{ id: "w-empty", name: "空窗口", kind: "worker", duty: "x" }], ["empty"]);
  const result = await planRequirementDispatch({
    requirement: requirement({
      body: requirementBody("| empty | src/x.ts:1 | 要动 | 经理 | |"),
    }),
    workspaces: [bad],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-dispatcher");
  assert.match(result.detail, /ws-empty/);
});

test("跨区少了一个区的行 → 拒绝并点名，不悄悄跳过那一区", async (t) => {
  const result = await planRequirementDispatch({
    requirement: requirement({
      body: requirementBody("| app | app/server.ts:1 | 要动 | app 的经理（2026-11-03） | |"),
    }),
    workspaces: await twoWorkspaces(t),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-impact");
  assert.match(result.detail, /saas/);
});

test("「待核」的区只建研究票，不派单也不开会话", async (t) => {
  // 研究票在本地 .deck 布局里建：不给仓库覆盖，让后端自己解析成 local。
  const workspaces = (await twoWorkspaces(t)).map((workspace) => ({ ...workspace, repos: [] }));
  const result = await runRequirementDispatch(
    {},
    {
      requirement: requirement({
        body: requirementBody(
          "| app | app/server.ts:1 | 待核 | app 的经理（2026-11-03） | |",
          "| saas | src/client.ts:1 | 待核 | saas 的经理（2026-11-03） | |",
        ),
      }),
      workspaces,
      confirmRequirementSplit: false,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.batches.length, 0);
  assert.equal(result.research.length, 2);
  assert.equal(result.research.every((item) => item.ok), true);
  assert.equal(result.created, true);

  // 两个工作区各有自己的票号空间：各自都从 #1 开始。
  assert.deepEqual(result.research.map((item) => item.number), [1, 1]);
  for (const workspace of workspaces) {
    const first = await getLocalIssue(workspace.workspaceDir, 1);
    assert.equal(first.ok, true);
    assert.match(first.issue.title, /待核/);
    assert.ok(first.issue.labels.some((label) => label.name === "wayfinder:research"));
  }
});

test("确认前零写入；确认后才建票并开会话", async (t) => {
  const workspaceDir = await workspace(
    t,
    "ws-app",
    "app",
    "dispatch-app",
    [{ id: "w-app", name: "应用", kind: "worker", duty: "改应用" }],
    [],
  );
  const input = {
    requirement: requirement({
      body: requirementBody("| 整个工作区 | app/server.ts:1 | 要动 | 经理（2026-11-03） | |"),
    }),
    workspaces: [workspaceDir],
  };

  const listed = await runRequirementDispatch(fakePaseo(), { ...input, confirmRequirementSplit: true });
  assert.equal(listed.ok, true);
  assert.equal(listed.requiresConfirmation, true);
  assert.equal(listed.created, false);
  assert.equal((await getLocalIssue(workspaceDir.workspaceDir, 1)).ok, false, "清单阶段一个字节都不写");

  const paseo = fakePaseo();
  const laid = await runRequirementDispatch(paseo, { ...input, confirmRequirementSplit: false });
  assert.equal(laid.ok, true);
  assert.equal(laid.requiresConfirmation, false);
  assert.equal(laid.created, true);
  assert.equal(paseo.created.length, 1);

  const ticket = await getLocalIssue(workspaceDir.workspaceDir, 1);
  assert.equal(ticket.ok, true);
  assert.match(ticket.issue.body, /需求 #7/);
});

test("requirementWorkspacesOf：跨区批次各用宿主里的真实工作区目录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deck-req-workspaces-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  // 只在本文件里绑了 ws-app；ws-saas 只存在于宿主清单。影响面点名它时仍要选中，
  // 不能因为「本文件没这条角色」就把 saas 并进 app。
  const cfg = settings("ws-app", "dispatch-app", []);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(cfg), "utf8");

  const lookup = await requirementWorkspacesOf({
    workspaceDir: dir,
    workspaceId: "ws-app",
    body: requirementBody(
      "| ws-app | app/server.ts:1 | 要动 | 经理（2026-11-03） | |",
      "| ws-saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | |",
    ),
    workspaceDirs: new Map([
      ["ws-app", "/work/app"],
      ["ws-saas", "/work/saas"],
    ]),
  });
  assert.equal(lookup.ok, true);
  assert.deepEqual(
    lookup.workspaces.map((workspace) => [workspace.workspaceId, workspace.workspaceDir]),
    [
      ["ws-app", "/work/app"],
      ["ws-saas", "/work/saas"],
    ],
  );
});

test("requirementWorkspacesOf：影响面写仓库名也能对回别的工作区，不并回当前区", async (t) => {
  const appDir = await mkdtemp(join(tmpdir(), "deck-req-workspaces-app-"));
  const saasDir = await mkdtemp(join(tmpdir(), "deck-req-workspaces-saas-"));
  t.after(() => rm(appDir, { recursive: true, force: true }));
  t.after(() => rm(saasDir, { recursive: true, force: true }));
  for (const dir of [appDir, saasDir]) await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(
    join(appDir, ".deck", "orchestration.json"),
    JSON.stringify(settings("ws-app", "dispatch-app", [])),
    "utf8",
  );
  // saas 是一个多仓库工作区：仓库键 acme/billing 只写在 workspace 配置里，
  // 影响面第一列只写仓库名 billing，也必须能对回 ws-saas。
  await mkdir(join(saasDir, "billing"), { recursive: true });
  await writeFile(
    join(saasDir, ".paseo-deck.json"),
    JSON.stringify({ version: 2, projects: [{ key: "billing", dir: "billing", repo: "acme/billing" }] }),
    "utf8",
  );

  const lookup = await requirementWorkspacesOf({
    workspaceDir: appDir,
    workspaceId: "ws-app",
    body: requirementBody(
      "| ws-app | app/server.ts:1 | 要动 | 经理（2026-11-03） | |",
      "| billing | src/client.ts:1 | 要动 | 经理（2026-11-03） | |",
    ),
    workspaceDirs: new Map([
      ["ws-app", appDir],
      ["ws-saas", saasDir],
    ]),
  });
  assert.equal(lookup.ok, true);
  assert.deepEqual(
    lookup.workspaces.map((workspace) => workspace.workspaceId),
    ["ws-app", "ws-saas"],
  );
  assert.deepEqual(lookup.unmatchedAreas, []);
});

test("requirementWorkspacesOf：多工作区时区名写错 → 拒绝，不并回当前区", async (t) => {
  const app = await workspace(t, "ws-app", "app", "dispatch-app", [], []);
  const saas = await workspace(t, "ws-saas", "saas", "dispatch-saas", [], []);
  const lookup = await requirementWorkspacesOf({
    workspaceDir: app.workspaceDir,
    workspaceId: "ws-app",
    body: requirementBody("| typo | app/server.ts:1 | 要动 | 经理（2026-11-03） | |"),
    workspaceDirs: new Map([
      ["ws-app", app.workspaceDir],
      ["ws-saas", saas.workspaceDir],
    ]),
  });
  assert.equal(lookup.ok, false);
  assert.equal(lookup.reason, "unknown-workspace");
  assert.match(lookup.detail, /typo/);
});

test("requirementWorkspacesOf：多工作区里「不动」的区名对不上也不拦", async (t) => {
  const app = await workspace(t, "ws-app", "app", "dispatch-app", [], []);
  const saas = await workspace(t, "ws-saas", "saas", "dispatch-saas", [], []);
  const lookup = await requirementWorkspacesOf({
    workspaceDir: app.workspaceDir,
    workspaceId: "ws-app",
    body: requirementBody(
      "| ws-app | app/server.ts:1 | 要动 | 经理（2026-11-03） | |",
      "| legacy | app/old.ts:1 | 不动 | 经理（2026-11-03） | |",
    ),
    workspaceDirs: new Map([
      ["ws-app", app.workspaceDir],
      ["ws-saas", saas.workspaceDir],
    ]),
  });
  assert.equal(lookup.ok, true);
  assert.deepEqual(lookup.workspaces.map((item) => item.workspaceId), ["ws-app"]);
});

test("requirementWorkspacesOf：宿主里找不到跨区目录时拒绝，不落回当前目录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deck-req-workspaces-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  const cfg = settings("ws-app", "dispatch-app", []);
  cfg.roles.push({ workspaceId: "ws-saas", mainAgentId: "main-saas", dispatcherAgentId: "dispatch-saas", staff: [] });
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(cfg), "utf8");

  const lookup = await requirementWorkspacesOf({
    workspaceDir: dir,
    workspaceId: "ws-app",
    body: requirementBody(
      "| ws-app | app/server.ts:1 | 要动 | 经理（2026-11-03） | |",
      "| ws-saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | |",
    ),
    workspaceDirs: new Map([["ws-app", "/work/app"]]),
  });
  assert.equal(lookup.ok, false);
  assert.equal(lookup.reason, "unknown-workspace");
  assert.match(lookup.detail, /ws-saas/);
});
