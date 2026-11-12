import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { orchestrationFileOf, writeOrchestration } from "../server/orchestration-store.ts";
import { runDispatch } from "../server/orchestration.ts";
import { createLocalIssue, getLocalIssue } from "../server/tracker/local.ts";
import { orchestrationDispatchRpc } from "../shared/orchestration-rpc.ts";

/**
 * 执行层（`runDispatch`）的失败分类与派单结果。
 *
 * 这些失败原因会一路显示到界面上，所以每一个都得说对：
 * 「没绑过角色」「绑了但没选派单窗口」「编排文件读不出来」是三件不同的事，
 * 报错报成同一个，用户就会去改一条根本不存在的配置。
 */

const ROUTING = [
  {
    difficulty: "normal",
    target: { provider: "claude", model: "sonnet" },
  },
];

/** 只够跑通派单的假宿主：配置可读、建会话必成。 */
function fakePaseo(config = {}) {
  const created = [];
  /** 每条会话落进哪条工作区；与 `created` 一一对应，`null` 表示走了裸 create。 */
  const createdIn = [];
  const create = async (options) => {
    created.push(options);
    return { id: `child-${created.length}` };
  };
  return {
    created,
    createdIn,
    config: {
      get: async () => ({ config: structuredClone(config) }),
      patch: async () => ({ config }),
    },
    agents: {
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
  const dir = await mkdtemp(path.join(tmpdir(), "deck-dispatch-"));
  const written = await writeOrchestration(dir, settings, { workspaceId: "ws-1" });
  assert.equal(written.ok, true);
  return dir;
}

const TASKS = [{ key: "t1", prompt: "做点事" }];

/** 执行层现在也查票门：能派的任务必须先挂一张已定稿的需求。 */
async function finalizedRequirement(dir) {
  const issue = await createLocalIssue(dir, {
    title: "需求：做点事",
    body: "六节谈完了",
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(issue.ok, true);
  return issue.number;
}

test("派单：这个工作区一条角色都没有时，原因报 unknown-workspace（不是「没选派单窗口」）", async () => {
  const dir = await workspaceWith({ roles: [], routing: ROUTING, maxDepth: 3, maxChildrenPerDispatch: 4, reportOnFinish: true });
  const result = await runDispatch(fakePaseo(), { workspaceId: "ws-1", workspaceDir: dir, tasks: TASKS, depth: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-workspace");
  assert.match(result.detail, /加一条工作区角色/);
});

test("派单：带会话身份、工作区一条角色都没有时报 no-workspace", async () => {
  const dir = await workspaceWith({ roles: [], routing: ROUTING, maxDepth: 3, maxChildrenPerDispatch: 4, reportOnFinish: true });
  const result = await runDispatch(fakePaseo(), {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: TASKS,
    depth: 1,
    callerAgentId: "dispatch-9",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-workspace");
  assert.match(result.detail, /没有任何角色绑定/);
});

test("派单：绑了角色但没选派单窗口时报 no-dispatcher", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", mainAgentId: "main-1" }],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const result = await runDispatch(fakePaseo(), { workspaceId: "ws-1", workspaceDir: dir, tasks: TASKS, depth: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-dispatcher");
});

test("派单：编排文件读不出来时报 settings-unreadable，不退回默认值乱派", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-dispatch-unreadable-"));
  await mkdir(orchestrationFileOf(dir), { recursive: true });
  const result = await runDispatch(fakePaseo(), { workspaceId: "ws-1", workspaceDir: dir, tasks: TASKS, depth: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "settings-unreadable");
  assert.match(result.detail, /不是「没配过」/);
});

test("派单：超层拒绝，且不夹到上限硬派", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", dispatcherAgentId: "dispatch-1" }],
    routing: ROUTING,
    maxDepth: 2,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, { workspaceId: "ws-1", workspaceDir: dir, tasks: TASKS, depth: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "depth-exceeded");
  assert.equal(paseo.created.length, 0, "超层一个会话都不能建");
});

test("派单：成功路径按路由落到 provider/model，标签里的父会话是绑定的派单窗口", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", dispatcherAgentId: "dispatch-1" }],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const requirement = await finalizedRequirement(dir);
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [{ key: "t1", prompt: "做点事", difficulty: "normal", requirementKey: requirement }],
    depth: 1,
    callerAgentId: "dispatch-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.dispatcherAgentId, "dispatch-1", "派单窗口本人派单，父会话就是它");
  assert.equal(paseo.created.length, 1);
  const options = paseo.created[0];
  assert.deepEqual(paseo.createdIn, ["ws-1"], "派出去的会话落回这条工作区：裸 cwd 会让宿主再登记一条");
  assert.equal("cwd" in options, false, "句柄路径不传 cwd");
  assert.equal(options.config.provider, "claude/sonnet");
  assert.equal(options.parent, "dispatch-1");
  assert.equal(options.labels["paseo.parent-agent-id"], "dispatch-1");
  assert.equal(options.labels["deck.difficulty"], "normal");
  assert.match(options.prompt, /第 1 层/);
});


test("派单入口：主窗口与其他会话带身份派单被拒；面板人工派单放行并留 warning", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", mainAgentId: "main-9", dispatcherAgentId: "dispatch-1" }],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const task = [{ key: "t1", prompt: "做点事", difficulty: "normal" }];

  const fromMain = await runDispatch(fakePaseo(), {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: task,
    depth: 1,
    callerAgentId: "main-9",
  });
  assert.equal(fromMain.ok, false);
  assert.equal(fromMain.reason, "main-cannot-dispatch");

  const fromOther = await runDispatch(fakePaseo(), {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: task,
    depth: 1,
    callerAgentId: "child-1",
  });
  assert.equal(fromOther.ok, false);
  assert.equal(fromOther.reason, "caller-not-dispatcher");

  // 面板不传 callerAgentId：按人工操作放行，但要说明「这不是会话内派单」。
  const panel = await runDispatch(fakePaseo(), { workspaceId: "ws-1", workspaceDir: dir, tasks: task, depth: 1 });
  assert.equal(panel.ok, true);
  assert.ok(panel.warnings.some((line) => line.includes("人工操作")));
});

test("派单：一条不合格不影响其它条，逐条带原因返回", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", dispatcherAgentId: "dispatch-1" }],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const requirement = await finalizedRequirement(dir);
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [
      { key: "ok", prompt: "干活", requirementKey: requirement },
      { key: "empty", prompt: "  ", requirementKey: requirement },
    ],
    depth: 1,
  });
  assert.equal(result.ok, true);
  const byKey = new Map(result.results.map((item) => [item.key, item]));
  assert.equal(byKey.get("ok").ok, true);
  assert.equal(byKey.get("empty").ok, false);
  assert.equal(byKey.get("empty").reason, "empty-prompt");
  assert.equal(paseo.created.length, 1);
});

test("派单先建票：会话标签指向真票号，结果里也带着这张票", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", dispatcherAgentId: "dispatch-1" }],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const requirement = await finalizedRequirement(dir);
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [{
      key: "t1",
      prompt: "## 接口层重构\n\n把读路径拆开。",
      difficulty: "hard",
      requirementKey: requirement,
    }],
    depth: 1,
  });
  assert.equal(result.ok, true);
  const outcome = result.results[0];
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const workNumber = outcome.ticket.number;
  // 本地 `.deck` 没有幂等锚：这句话要如实带出来，别让人以为重试不会重复建票。
  assert.match(outcome.ticketNotes.join("\n"), /没有幂等锚/);
  // 会话标签指真票号，不用计划里那个任务键；抬头里也写明票号。
  assert.equal(paseo.created[0].labels["deck.ticket"], `#${workNumber}`);
  assert.match(paseo.created[0].prompt, new RegExp(`票 #${workNumber}`));

  const ticket = await getLocalIssue(dir, workNumber);
  assert.equal(ticket.ok, true);
  assert.equal(ticket.issue.title, "接口层重构");
  assert.deepEqual(
    ticket.issue.labels.map((label) => label.name).toSorted(),
    ["client:claude", "difficulty:hard"],
  );
  assert.match(ticket.issue.body, /执行客户端：`claude`（模型 `sonnet`）/);
});

test("票建不出来就不派：这条任务回 ticket-failed，会话一个都没建", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", dispatcherAgentId: "dispatch-1" }],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const requirement = await finalizedRequirement(dir);
  // 下一张票的目标路径先被一个目录占住：需求票仍读得出来，但工作票写不进去，
  // 模拟「建票后端坏了」而不把票门也一起弄坏。
  await mkdir(path.join(dir, ".deck", "issues", `${requirement + 1}.md`), { recursive: true });
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [{ key: "t1", prompt: "干点事", requirementKey: requirement }],
    depth: 1,
  });
  assert.equal(result.ok, true, "一条任务失败不该让整批崩掉");
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].reason, "ticket-failed");
  assert.equal(paseo.created.length, 0, "没有票就不建会话");
});

/* ---------------------------------------------------- 归属：region / staff 的优先级 */

const { planDispatch } = await import("../shared/orchestration.ts");

const CARD = (id, kind, paths) => ({ id, name: id, kind, duty: id, ...(paths ? { paths } : {}) });

function planInput(overrides = {}) {
  return {
    workspaceId: "ws-1",
    roles: [
      {
        workspaceId: "ws-1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [
          CARD("m-server", "manager", ["server"]),
          CARD("w-api", "worker", ["server/api"]),
          CARD("w-web", "worker", ["web"]),
        ],
      },
    ],
    routing: ROUTING,
    profiles: [],
    tasks: [{ key: "t1", prompt: "做点事", region: { pathPrefix: "server/api/user.ts" } }],
    maxDepth: 3,
    maxChildrenPerDispatch: 5,
    depth: 0,
    dispatchId: "dsp-test",
    ...overrides,
  };
}

test("名册非空、没写 staff、只给 region：按归属选卡", () => {
  const plan = planDispatch(planInput());
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].staffId, "w-api");
});

test("员工卡再深也跳不过经理层：先命中经理，再在经理领地里找员工", () => {
  // 员工在 server/api，经理在 server；路径落在 server/api → 经理层先算，再落到员工。
  const plan = planDispatch(planInput());
  assert.equal(plan.tasks[0].staffId, "w-api");
  // 同一经理领地内没有员工覆盖的地方：交给经理自己，不跨区借 w-web。
  const managerOwn = planDispatch(planInput({ tasks: [{ key: "t1", prompt: "p", region: { pathPrefix: "server/other" } }] }));
  assert.equal(managerOwn.tasks[0].staffId, "m-server");
});

test("显式 staff 优先于 region：不按区域改派", () => {
  const plan = planDispatch(planInput({
    tasks: [{ key: "t1", prompt: "p", staff: "w-web", region: { pathPrefix: "server/api" } }],
  }));
  assert.equal(plan.tasks[0].staffId, "w-web");
});

test("名册非空、staff 与 region 都没写：region-required，不猜人", () => {
  const plan = planDispatch(planInput({ tasks: [{ key: "t1", prompt: "p" }] }));
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "region-required");
});

test("region 没有任何卡覆盖：region-unowned，不回落成根经理", () => {
  const plan = planDispatch(planInput({ tasks: [{ key: "t1", prompt: "p", region: { pathPrefix: "unknown/dir" } }] }));
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "region-unowned");
});

test("写了名册里没有的 staff：unknown-staff", () => {
  const plan = planDispatch(planInput({ tasks: [{ key: "t1", prompt: "p", staff: "ghost" }] }));
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "unknown-staff");
});

/* ------------------------------------------------------- RPC 输入契约 */

test("RPC 派单任务带 requirementKey / requirementRepoKey：zod 不许把它们剥掉", () => {
  // 剥掉这两位，执行层的链条 / 验收票闸就永远看不到需求，直接走 RPC 等于绕过检查。
  const parsed = orchestrationDispatchRpc.input.safeParse({
    workspaceId: "ws-app",
    workspaceDir: "/repo",
    depth: 1,
    tasks: [
      {
        key: "t1",
        prompt: "改卡片",
        requirementKey: 12,
        requirementRepoKey: "acme/web",
      },
    ],
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed));
  assert.equal(parsed.data.tasks[0].requirementKey, 12);
  assert.equal(parsed.data.tasks[0].requirementRepoKey, "acme/web");
});
