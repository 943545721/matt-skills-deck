import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DECK_CHILD_LABEL,
  DECK_DIFFICULTY_LABEL,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  PARENT_AGENT_ID_LABEL,
  buildAgentTree,
  buildChildLabels,
  buildDispatchPreamble,
  countTree,
  difficultyFromLabels,
  normalizeOrchestration,
  parseProviderSpec,
  planDispatch,
  providerSpec,
  resolveRoute,
  resolveRouteTarget,
  routeFromOf,
  withRoutingRule,
  withWorkspaceRoles,
} from "../shared/orchestration.ts";
import {
  buildDispatchPreamble as preambleAgain,
} from "../shared/orchestration.ts";
import { orchestrationFileOf, readOrchestration, writeOrchestration } from "../server/orchestration-store.ts";

/**
 * 编排口径的护栏。
 *
 * 这里守的是四条一旦漂移就会静默出错的东西：
 * 难度标签的解析、路由解析（不偷偷回落）、派单计划的逐条拒绝、会话树的成环与孤儿处理。
 */

const profile = (id, provider, model) => ({ id, name: id, provider, ...(model ? { model } : {}) });

const routing = [
  { difficulty: "trivial", target: { provider: "claude", model: "haiku" } },
  { difficulty: "normal", profileId: "daily" },
  { difficulty: "hard", target: { provider: "claude", model: "opus" } },
  { difficulty: "critical", profileId: "careful" },
];

const profiles = [profile("daily", "claude", "sonnet"), profile("careful", "codex", "gpt-5")];

test("provider spec：provider/model 与裸 provider 互转", () => {
  assert.deepEqual(parseProviderSpec("claude/sonnet"), { provider: "claude", model: "sonnet" });
  assert.deepEqual(parseProviderSpec("codex"), { provider: "codex" });
  assert.equal(providerSpec({ provider: "claude", model: "sonnet" }), "claude/sonnet");
  assert.equal(providerSpec({ provider: "codex" }), "codex");
});

test("难度标签：从子会话标签里读出难度，认不出就是 null", () => {
  assert.equal(difficultyFromLabels(["difficulty:hard"]), "hard");
  assert.equal(difficultyFromLabels(["deck:difficulty:critical"]), "critical");
  assert.equal(difficultyFromLabels(["wayfinder:task", "difficulty/trivial"]), "trivial");
  assert.equal(difficultyFromLabels(["difficulty:huge"]), null);
  assert.equal(difficultyFromLabels([]), null);
  assert.equal(difficultyFromLabels(undefined), null);
});

test("路由：配了的档位取配的那条，没配的回落到 normal，一档都没有就用默认目标", () => {
  assert.equal(resolveRoute({ routing }, "hard").difficulty, "hard");
  assert.equal(resolveRoute({ routing }, "critical").difficulty, "critical");
  // trivial 没配时回落到 normal（normal 配了）
  assert.equal(resolveRoute({ routing: routing.filter((r) => r.difficulty === "normal") }, "trivial").difficulty, "normal");
  // 一档都没配时保留请求的难度，用默认目标，而不是偷偷改成 normal
  const empty = resolveRoute({ routing: [] }, "hard");
  assert.equal(empty.difficulty, "hard");
  assert.ok(empty.target, "没有配置时应落到默认目标");
});

test("借用路由必须被标出来：配了就空，借了 normal 就说 normal，一档都没配说 default", () => {
  assert.deepEqual(routeFromOf(routing, "hard"), {});
  assert.deepEqual(routeFromOf(routing, "trivial"), {});
  // trivial 没配、normal 配了 → 借 normal
  const onlyNormal = routing.filter((r) => r.difficulty === "normal");
  assert.deepEqual(routeFromOf(onlyNormal, "trivial"), { routeFrom: "normal" });
  // 一档都没配 → 内置默认目标
  assert.deepEqual(routeFromOf([], "critical"), { routeFrom: "default" });
});

test("派单计划把借用路由挂到每条任务上，方便调用方如实汇报", () => {
  const plan = planDispatch({
    workspaceId: "ws1",
    roles: [{ workspaceId: "ws1", dispatcherAgentId: "agent-dispatch" }],
    routing: [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }],
    profiles: [],
    tasks: [
      { key: "t1", prompt: "p1", difficulty: "normal" },
      { key: "t2", prompt: "p2", difficulty: "critical" },
    ],
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    depth: 0,
    dispatchId: "d1",
  });
  assert.equal(plan.rejected.length, 0);
  const [normalTask, criticalTask] = plan.tasks;
  assert.equal(normalTask.routeFrom, undefined);
  assert.equal(criticalTask.routeFrom, "normal");
  // 难度本身不清洗：借用的是路由，不是难度
  assert.equal(criticalTask.difficulty, "critical");
});

test("路由解析：档案优先，档案丢了不猜替代品", () => {
  const okProfile = resolveRouteTarget({ difficulty: "normal", profileId: "daily" }, profiles);
  assert.equal(okProfile.ok, true);
  assert.deepEqual(okProfile.target, { provider: "claude", model: "sonnet" });
  assert.equal(okProfile.via, "profile");

  const missing = resolveRouteTarget({ difficulty: "normal", profileId: "gone" }, profiles);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "profile-missing");

  const noTarget = resolveRouteTarget({ difficulty: "normal" }, profiles);
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.reason, "no-target");

  const direct = resolveRouteTarget({ difficulty: "hard", target: { provider: "claude", model: "opus" } }, []);
  assert.equal(direct.ok, true);
  assert.equal(direct.via, "target");
});

test("子会话标签：带上父 id、难度、票号与派单批次", () => {
  const labels = buildChildLabels({ dispatcherAgentId: "agent-1", difficulty: "hard", dispatchId: "d1", ticketKey: "42" });
  assert.equal(labels[PARENT_AGENT_ID_LABEL], "agent-1");
  assert.equal(labels[DECK_DIFFICULTY_LABEL], "hard");
  assert.equal(labels[DECK_CHILD_LABEL], "1");
  assert.equal(labels["deck.ticket"], "42");
});

test("派单计划：没有派单窗口时整批拒绝，但每条都给出原因", () => {
  const plan = planDispatch({
    workspaceId: "w1",
    roles: [{ workspaceId: "w1" }],
    routing,
    profiles,
    tasks: [{ key: "1", prompt: "do it" }],
    maxDepth: DEFAULT_MAX_DEPTH,
    maxChildrenPerDispatch: DEFAULT_MAX_CHILDREN,
    depth: 0,
    dispatchId: "d1",
  });
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].reason, "no-dispatcher");
});

test("派单计划：超过层数上限时拒绝", () => {
  const plan = planDispatch({
    workspaceId: "w1",
    roles: [{ workspaceId: "w1", dispatcherAgentId: "agent-1" }],
    routing,
    profiles,
    tasks: [{ key: "1", prompt: "x" }],
    maxDepth: 2,
    maxChildrenPerDispatch: DEFAULT_MAX_CHILDREN,
    depth: 2,
    dispatchId: "d1",
  });
  assert.equal(plan.rejected[0].reason, "depth-exceeded");
});

test("派单计划：逐条校验，一条不合格不影响其它条", () => {
  const plan = planDispatch({
    workspaceId: "w1",
    roles: [{ workspaceId: "w1", dispatcherAgentId: "agent-1" }],
    routing,
    profiles,
    tasks: [
      { key: "1", prompt: "ok" },
      { key: "1", prompt: "dup" },
      { key: "2", prompt: "   " },
      { key: "3", prompt: "ok too", difficulty: "critical" },
    ],
    maxDepth: DEFAULT_MAX_DEPTH,
    maxChildrenPerDispatch: DEFAULT_MAX_CHILDREN,
    depth: 0,
    dispatchId: "d1",
  });
  assert.deepEqual(plan.tasks.map((t) => t.key), ["1", "3"]);
  const reasons = plan.rejected.map((item) => item.reason).sort();
  assert.deepEqual(reasons, ["duplicate-key", "empty-prompt"]);
  // 每条被接受的任务都带到具体客户端与幂等键
  assert.equal(plan.tasks[0].providerSpec, "claude/sonnet");
  assert.equal(plan.tasks[1].providerSpec, "codex/gpt-5");
  for (const task of plan.tasks) assert.match(task.idempotencyKey, /^deck-dispatch-[0-9a-f]{8}$/);
});

test("派单计划：一次最多派几个的硬限制", () => {
  const plan = planDispatch({
    workspaceId: "w1",
    roles: [{ workspaceId: "w1", dispatcherAgentId: "agent-1" }],
    routing,
    profiles,
    tasks: [
      { key: "1", prompt: "a" },
      { key: "2", prompt: "b" },
    ],
    maxDepth: DEFAULT_MAX_DEPTH,
    maxChildrenPerDispatch: 1,
    depth: 0,
    dispatchId: "d1",
  });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.rejected[0].reason, "too-many-children");
});

test("派单计划：路由不可用时报 route-unavailable，不带病派出", () => {
  const plan = planDispatch({
    workspaceId: "w1",
    roles: [{ workspaceId: "w1", dispatcherAgentId: "agent-1" }],
    routing: [{ difficulty: "normal", profileId: "gone" }],
    profiles,
    tasks: [{ key: "1", prompt: "a" }],
    maxDepth: DEFAULT_MAX_DEPTH,
    maxChildrenPerDispatch: DEFAULT_MAX_CHILDREN,
    depth: 0,
    dispatchId: "d1",
  });
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "route-unavailable");
});

test("派单抬头：点名派单窗口、层数、难度，并要求 deck_handoff", () => {
  const zh = buildDispatchPreamble({ lang: "zh", dispatcherAgentId: "agent-1", difficulty: "hard", depth: 1, ticketKey: "7" });
  assert.match(zh, /agent-1/);
  assert.match(zh, /deck_handoff/);
  assert.match(zh, /第 1 层/);
  assert.match(zh, /hard/);
  assert.equal(zh, preambleAgain({ lang: "zh", dispatcherAgentId: "agent-1", difficulty: "hard", depth: 1, ticketKey: "7" }));

  const en = buildDispatchPreamble({ lang: "en", dispatcherAgentId: "agent-2", difficulty: "normal", depth: 2 });
  assert.match(en, /child session/);
  assert.match(en, /deck_handoff/);
});

test("会话树：父 id 断链的按根显示，成环的边断开", () => {
  const tree = buildAgentTree([
    { agentId: "root", parentAgentId: null, title: "main" },
    { agentId: "a", parentAgentId: "root", labels: { [DECK_DIFFICULTY_LABEL]: "hard", "deck.ticket": "3" } },
    { agentId: "b", parentAgentId: "a" },
    { agentId: "orphan", parentAgentId: "gone" },
    // 成环：x → y → x
    { agentId: "x", parentAgentId: "y" },
    { agentId: "y", parentAgentId: "x" },
  ]);
  const ids = tree.map((node) => node.agentId).sort();
  assert.deepEqual(ids, ["orphan", "root", "x"]);
  const root = tree.find((node) => node.agentId === "root");
  assert.equal(root.children[0].agentId, "a");
  assert.equal(root.children[0].difficulty, "hard");
  assert.equal(root.children[0].ticketKey, "3");
  assert.equal(root.children[0].children[0].agentId, "b");
  assert.equal(countTree(tree).nodes, 6);
  assert.equal(countTree(tree).depth, 3);
});

test("设置归一：坏值不会写进文件", () => {
  const normalized = normalizeOrchestration({
    roles: [{ workspaceId: "w1", mainAgentId: "m" }],
    routing: [{ difficulty: "hard", target: { provider: "claude" } }],
    maxDepth: 99,
    maxChildrenPerDispatch: 0,
    reportOnFinish: "yes",
  });
  assert.equal(normalized.maxDepth, 6);
  assert.equal(normalized.maxChildrenPerDispatch, 1);
  // 只认真正的布尔 true：写成字符串 "yes" 不代表要开启
  assert.equal(normalized.reportOnFinish, false);
  assert.equal(normalized.roles[0].mainAgentId, "m");

  const defaults = normalizeOrchestration(null);
  assert.equal(defaults.maxDepth, DEFAULT_MAX_DEPTH);
  assert.deepEqual(defaults.routing, []);
});

test("设置合并：改角色/改路由都返回新对象，不动旧的", () => {
  const base = normalizeOrchestration({
    roles: [{ workspaceId: "w1", mainAgentId: "m" }],
    routing: [{ difficulty: "hard", target: { provider: "claude" } }],
  });
  const withRole = withWorkspaceRoles(base, { workspaceId: "w2", dispatcherAgentId: "d" });
  assert.equal(base.roles.length, 1);
  assert.equal(withRole.roles.length, 2);

  const withRoute = withRoutingRule(base, { difficulty: "normal", target: { provider: "codex" } }, "normal");
  assert.equal(base.routing.length, 1);
  assert.deepEqual(withRoute.routing.map((r) => r.difficulty).sort(), ["hard", "normal"]);

  const cleared = withRoutingRule(withRoute, null, "hard");
  assert.deepEqual(cleared.routing.map((r) => r.difficulty), ["normal"]);
  assert.equal(withRoute.routing.length, 2);
});

test("编排文件：读不到用默认值，写进文件的 workspaceId 会保留", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-orch-"));
  const missing = await readOrchestration(dir);
  assert.equal(missing.exists, false);
  assert.equal(missing.workspaceId, null);
  assert.equal(missing.settings.maxDepth, DEFAULT_MAX_DEPTH);

  await writeOrchestration(dir, missing.settings, { workspaceId: "ws-1" });
  const read = await readOrchestration(dir);
  assert.equal(read.workspaceId, "ws-1");
  // 不显式给 id 时沿用文件里的，不被抹掉
  await writeOrchestration(dir, read.settings);
  assert.equal((await readOrchestration(dir)).workspaceId, "ws-1");

  const raw = JSON.parse(await readFile(orchestrationFileOf(dir), "utf8"));
  assert.equal(raw.version, 1);
});

test("编排文件：坏 JSON 回落默认值并标记 corrupt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-orch-"));
  await mkdir(path.dirname(orchestrationFileOf(dir)), { recursive: true });
  await writeFile(orchestrationFileOf(dir), "{ not json", "utf8");
  const read = await readOrchestration(dir);
  assert.equal(read.corrupt, true);
  assert.equal(read.settings.reportOnFinish, true);
});

test("保存编排：文件归属由调用方给，不从角色反推（清空本工作区角色后不会被改成别的工作区）", async () => {
  const { saveOrchestration } = await import("../server/orchestration.ts");
  const dir = await mkdtemp(path.join(tmpdir(), "deck-orch-save-"));
  const base = {
    roles: [
      { workspaceId: "ws-1", mainAgentId: "main-1", dispatcherAgentId: "d-1" },
      { workspaceId: "ws-2", mainAgentId: "main-2", dispatcherAgentId: "d-2" },
    ],
    routing: [],
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  };
  const first = await saveOrchestration({ workspaceDir: dir, workspaceId: "ws-1", settings: base });
  assert.equal(first.ok, true);
  assert.equal((await readOrchestration(dir)).workspaceId, "ws-1");

  // 把 ws-1 的角色清空：只剩 ws-2，若从角色反推，归属会被改写成 ws-2
  const cleared = await saveOrchestration({
    workspaceDir: dir,
    workspaceId: "ws-1",
    settings: { ...base, roles: [base.roles[1]] },
  });
  assert.equal(cleared.ok, true);
  assert.equal((await readOrchestration(dir)).workspaceId, "ws-1", "归属必须还是本工作区");
});

test("难度标签：冒号、等号、斜杠三种写法都认（没有任何代码自动写这些标签，是给人手动打的）", () => {
  for (const label of [
    "deck.difficulty=hard",
    "deck.difficulty:hard",
    "deck:difficulty:hard",
    "difficulty=critical",
    "difficulty:critical",
    "difficulty/hard",
    "Difficulty=TRIVIAL",
  ]) {
    const expected = label.toLowerCase().split(/[:=/]/).pop();
    assert.equal(difficultyFromLabels([label]), expected, `${label} 应能认出难度`);
  }
  assert.equal(difficultyFromLabels(["难度:hard"]), null);
  assert.equal(difficultyFromLabels(["hard"]), null, "不带前缀的裸标签不算");
});

test("编排文件：文件读不出来（不是「没配过」）要单独标出来", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-orch-unreadable-"));
  // 让 orchestration.json 是个目录：readFile 会失败，但错误码不是 ENOENT
  await mkdir(orchestrationFileOf(dir), { recursive: true });
  const read = await readOrchestration(dir);
  assert.equal(read.exists, false);
  assert.equal(read.corrupt, false);
  assert.equal(read.readFailed, true, "权限 / IO 错误不能被当成「还没配过」");
  assert.ok(read.detail, "要带上原因");
});
