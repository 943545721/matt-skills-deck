import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeCreateChainGate, judgeDispatchTaskChain } from "../server/chain-gates.ts";
import { findTool } from "../server/mcp/tools.ts";
import { runDispatch } from "../server/orchestration.ts";
import { setIssueStateHandler } from "../server/rpc/issues.ts";
import { createLocalIssue, getLocalIssue, initializeLocalScratch } from "../server/tracker/local.ts";

/**
 * 链条闸真正落到的三条路径：建票、派单（计划 + 执行）、关需求留痕。
 *
 * 判定规则本身在 `tests/contract-chain*.test.mjs` 里逐条钉过；这里只测
 * 「入口有没有调用它、拒绝理由有没有原样回传、坏任务会不会拖累整批」。
 */

const impact = (...rows) => [
  "## 影响面",
  "| 区 / 仓库 | 依据 | 结论 | 核的人 | 链条（没有就留空） |",
  "|---|---|---|---|---|",
  ...rows,
].join("\n");

const runTool = (name, args, context) => findTool(name).run(args, context);

async function tempWorkspace(t, prefix = "deck-chain-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const settings = (workspaceId = "ws-app") => ({
  version: 1,
  updatedAt: "2026-11-03T00:00:00.000Z",
  workspaceId,
  roles: [{
    workspaceId,
    mainAgentId: "main-app",
    dispatcherAgentId: "dispatch-app",
    staff: [{ id: "w-app", name: "应用", kind: "worker", duty: "改应用" }],
  }],
  routing: [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }],
  maxDepth: 3,
  maxChildrenPerDispatch: 5,
  reportOnFinish: true,
});

async function dispatchWorkspace(t) {
  const dir = await tempWorkspace(t, "deck-chain-dispatch-");
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  return dir;
}

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

/** 只回答 #12 的假读票器；`mode` 决定读失败、不存在还是开着。 */
function readerFor12(mode) {
  const calls = [];
  return {
    calls,
    reader: async (ref) => {
      calls.push({ repoKey: ref.repoKey ?? null, number: ref.number });
      // #13 是需求正文里写明的验收票：有主，所以验收闸放行，剩下只看链条。
      if (ref.number === 13) return { exists: true, closed: false, assignees: ["qa"] };
      if (ref.number !== 12) return null;
      if (mode === "unreadable") return null;
      if (mode === "missing") return { exists: false, closed: false, assignees: [] };
      return { exists: true, closed: mode === "closed", assignees: ["dev"] };
    },
  };
}

/* ------------------------------------------------------------ 派单计划闸 */

test("派单计划：等 #12 而对方还开着 → 这条不派；对方关了 → 照常给计划", async (t) => {
  const dir = await dispatchWorkspace(t);
  const requirement = await createLocalIssue(dir, {
    title: "需求：商品卡",
    body: `${impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |")}\n\n验收票 #13`,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(requirement.ok, true);

  const open = readerFor12("open");
  const blocked = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", title: "改卡片", prompt: "改卡片", staff: "w-app", requirementKey: requirement.number }], depth: 1 },
    { workspaceDir: dir, reader: open.reader },
  );
  const blockedBody = JSON.parse(blocked.text);
  assert.equal(blocked.isError, false, blocked.text);
  assert.equal(blockedBody.tasks.length, 0, "被依赖票没关，不能给这条任务计划");
  assert.equal(blockedBody.rejected[0].key, "t1");
  assert.match(blockedBody.rejected[0].detail, /#12/);
  assert.match(blockedBody.rejected[0].detail, /还没关/);

  const closed = readerFor12("closed");
  const planned = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", title: "改卡片", prompt: "改卡片", staff: "w-app", requirementKey: requirement.number }], depth: 1 },
    { workspaceDir: dir, reader: closed.reader },
  );
  const plannedBody = JSON.parse(planned.text);
  assert.equal(plannedBody.tasks.length, 1, planned.text);
  assert.equal(plannedBody.tasks[0].key, "t1");
});

test("派单计划：对方票读不到 → 拒绝，不默认已解除", async (t) => {
  const dir = await dispatchWorkspace(t);
  const requirement = await createLocalIssue(dir, {
    title: "需求：商品卡",
    body: `${impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |")}\n\n验收票 #13`,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(requirement.ok, true);

  const unreadable = readerFor12("unreadable");
  const result = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "改卡片", staff: "w-app", requirementKey: requirement.number }], depth: 1 },
    { workspaceDir: dir, reader: unreadable.reader },
  );
  const body = JSON.parse(result.text);
  assert.equal(body.tasks.length, 0);
  assert.match(body.rejected[0].detail, /#12/);
  assert.match(body.rejected[0].detail, /读不到|还没读/);
});

/* ------------------------------------------------------------ 建票闸 */

test("建票：影响面链条写坏（契约缺摘要 / 权益缺存量升级）→ 拒绝建票", async (t) => {
  const dir = await tempWorkspace(t, "deck-chain-create-");
  assert.equal((await initializeLocalScratch(dir, { name: "unit" })).ok, true);

  const badContract = await createLocalIssue(dir, {
    title: "需求：契约写坏",
    body: impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 契约： |"),
    labels: ["requirement", "deck:定稿"],
    feature: "unit",
  });
  assert.equal(badContract.ok, true);
  const badCapability = await createLocalIssue(dir, {
    title: "需求：权益写坏",
    body: impact("| app | src/server.ts:1 | 要动 | 经理（2026-11-03） | 权益：feature_key=sku |"),
    labels: ["requirement", "deck:定稿"],
    feature: "unit",
  });
  assert.equal(badCapability.ok, true);
  const badFeatureKey = await createLocalIssue(dir, {
    title: "需求：权益缺功能键",
    body: impact("| app | src/server.ts:1 | 要动 | 经理（2026-11-03） | 权益：存量升级=否 |"),
    labels: ["requirement", "deck:定稿"],
    feature: "unit",
  });
  assert.equal(badFeatureKey.ok, true);

  const contract = await runTool(
    "deck_issue_create",
    {
      title: "实施：改卡片",
      kind: "spec-ticket",
      parentKey: "00",
      feature: "unit",
      requirementKey: badContract.number,
    },
    { workspaceDir: dir },
  );
  assert.equal(contract.isError, true);
  assert.match(contract.text, /契约/);
  assert.match(contract.text, /摘要/);

  const capability = await runTool(
    "deck_issue_create",
    {
      title: "实施：改卡片",
      kind: "spec-ticket",
      parentKey: "00",
      feature: "unit",
      requirementKey: badCapability.number,
    },
    { workspaceDir: dir },
  );
  assert.equal(capability.isError, true);
  assert.match(capability.text, /存量升级/);

  const featureKey = await runTool(
    "deck_issue_create",
    {
      title: "实施：改卡片",
      kind: "spec-ticket",
      parentKey: "00",
      feature: "unit",
      requirementKey: badFeatureKey.number,
    },
    { workspaceDir: dir },
  );
  assert.equal(featureKey.isError, true);
  assert.match(featureKey.text, /feature_key/);

  // 拒绝发生在写盘之前：板子上没有这两张实施票。
  const listed = JSON.parse((await runTool("deck_issue_list", {}, { workspaceDir: dir })).text);
  assert.equal(listed.issues.some((issue) => issue.title === "实施：改卡片"), false);
});

test("建票：有链条但没挂已认领的验收票 → 拒绝，并要求先建验收岗位卡", async (t) => {
  const dir = await tempWorkspace(t, "deck-chain-accept-");
  assert.equal((await initializeLocalScratch(dir, { name: "unit" })).ok, true);

  const requirement = await createLocalIssue(dir, {
    title: "需求：商品卡",
    body: impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 契约：商品卡接口 |"),
    labels: ["requirement", "deck:定稿"],
    feature: "unit",
  });
  assert.equal(requirement.ok, true);

  const result = await runTool(
    "deck_issue_create",
    {
      title: "实施：改卡片",
      kind: "spec-ticket",
      parentKey: "00",
      feature: "unit",
      requirementKey: requirement.number,
    },
    { workspaceDir: dir },
  );
  assert.equal(result.isError, true, result.text);
  assert.match(result.text, /先建一张验收岗位卡，或自己认领/);
});

test("建票：别的区有链条、本区留空时，不拿别的区的链条要求验收票", async () => {
  const result = await judgeCreateChainGate({
    workspaceDir: "/tmp/chain-area-no-io",
    requirementBody: impact(
      "| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 契约：商品卡接口 |",
      "| app | src/server.ts:1 | 要动 | 经理（2026-11-03） | |",
    ),
    requirementRepoKey: "local",
    targetRepoKey: "local",
    targetArea: "app",
    position: "spec-ticket",
  });
  assert.equal(result.ok, true, result.reason);
});

/* ------------------------------------------------------------ 派单闸的收窄与坏表 */

test("派单闸：别的区有链条、本区留空时不要求验收票（与建票闸同一把尺子）", async () => {
  const body = impact(
    "| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |",
    "| app | src/server.ts:1 | 要动 | 经理（2026-11-03） | |",
  );
  const result = await judgeDispatchTaskChain({
    workspaceDir: "/tmp/chain-area-scope-no-io",
    requirementBody: body,
    requirementRepoKey: "local",
    targetRepoKey: "app",
    title: "改服务",
    prompt: "改服务",
    reader: readerFor12("closed").reader,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.chainCell, "");
});

test("派单闸：影响面表读不出来 → 拒绝，不把坏表当成「没有链条」放行", async (t) => {
  const dir = await dispatchWorkspace(t);
  const requirement = await createLocalIssue(dir, {
    title: "需求：坏表",
    body: "## 影响面\n\n| 区 | 依据 |\n|---|---|\n",
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(requirement.ok, true);
  const paseo = fakePaseo();

  const result = await runDispatch(
    paseo,
    {
      workspaceId: "ws-app",
      workspaceDir: dir,
      dispatchId: "bad-impact",
      depth: 1,
      tasks: [{ key: "t1", prompt: "改卡片", staff: "w-app", requirementKey: requirement.number }],
    },
    { reader: readerFor12("closed").reader },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].detail, /影响面表读不出来/);
  assert.equal(paseo.created.length, 0);
});

/* ------------------------------------------------------------ 关需求留痕 */

test("关需求：验收票还开着 → 正文追加一行；重复关闭不重复追加", async (t) => {
  const dir = await tempWorkspace(t, "deck-chain-close-");
  const requirement = await createLocalIssue(dir, {
    title: "需求：商品卡",
    body: `${impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |")}\n\n验收票 #2`,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(requirement.ok, true);

  const calls = [];
  const options = {
    reader: async (ref) => {
      calls.push({ repoKey: ref.repoKey ?? null, number: ref.number });
      return { exists: true, closed: false, assignees: ["qa"] };
    },
    now: () => new Date("2026-11-03T12:00:00.000Z"),
  };

  const first = await setIssueStateHandler({ workspaceDir: dir, number: requirement.number, state: "closed" }, options);
  assert.equal(first.ok, true);
  const closed = await getLocalIssue(dir, requirement.number);
  assert.equal(closed.ok, true);
  assert.match(closed.issue.body, /验收：未验收（验收票 #2 仍开着，2026-11-03 关闭）/);
  assert.equal(closed.issue.body.split("验收：未验收").length - 1, 1);

  const second = await setIssueStateHandler({ workspaceDir: dir, number: requirement.number, state: "closed" }, options);
  assert.equal(second.ok, true);
  const again = await getLocalIssue(dir, requirement.number);
  assert.equal(again.ok, true);
  assert.equal(again.issue.body.split("验收：未验收").length - 1, 1, "重复关闭不能追加第二行");
  // 两次都读了验收票；读的是正文里写的 #2。
  assert.ok(calls.every((call) => call.number === 2));
});

/* ------------------------------------------------------------ 能力·授权 */

test("派单闸：能力·授权的验收票在授权端没工作票时拒绝，并给出待授权端工作票写法", async () => {
  const base = {
    workspaceDir: "/tmp/chain-capability-no-io",
    requirementBody: impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 权益：feature_key=sku，存量升级=是 |"),
    requirementRepoKey: "local",
    targetRepoKey: "local",
    title: "验收：商品卡",
    prompt: "按验收清单跑一遍",
  };

  // 验收票正文里已经记着「待授权端工作票：…」= 授权端还没有可挂的票。
  const rejected = await judgeDispatchTaskChain({
    ...base,
    prompt: "按验收清单跑一遍\n待授权端工作票：feature_key=sku（对方区还没有工作票）",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /待授权端工作票：feature_key=sku/);

  // 没有这行缺票证据 → 不永久卡住；显式事实为 true 时同样放行。
  const allowed = await judgeDispatchTaskChain(base);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.level, "capability");
  const explicit = await judgeDispatchTaskChain({ ...base, hasWorkTicket: true });
  assert.equal(explicit.ok, true);
});

/* ------------------------------------------------------------ 派单验收票闸 */

function readerWithAcceptance(assignees) {
  return async (ref) => {
    if (ref.number === 12) return { exists: true, closed: true, assignees: ["dev"] };
    if (ref.number === 13) return { exists: true, closed: false, assignees };
    return null;
  };
}

async function chainedRequirement(dir, tail = "\n\n验收票 #13") {
  const created = await createLocalIssue(dir, {
    title: "需求：商品卡",
    body: `${impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |")}${tail}`,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(created.ok, true);
  return created.number;
}

test("执行层：有链条但验收票没主 → 不建这一区的票，拒绝理由说清缺什么", async (t) => {
  const dir = await dispatchWorkspace(t);
  const requirement = await chainedRequirement(dir);
  const paseo = fakePaseo();

  const result = await runDispatch(
    paseo,
    {
      workspaceId: "ws-app",
      workspaceDir: dir,
      dispatchId: "acceptance-missing-owner",
      depth: 1,
      tasks: [{ key: "t1", prompt: "改卡片", staff: "w-app", requirementKey: requirement }],
    },
    { reader: readerWithAcceptance([]) },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].detail, /验收票没有主|没有主的验收票/);
  assert.equal(paseo.created.length, 0, "被拒的任务不能建会话");
});

test("执行层：验收票缺号 → 拒绝；有号且有主 → 照常派", async (t) => {
  const dir = await dispatchWorkspace(t);
  const missingRef = await chainedRequirement(dir, "");
  const paseo = fakePaseo();

  const rejected = await runDispatch(
    paseo,
    {
      workspaceId: "ws-app",
      workspaceDir: dir,
      dispatchId: "acceptance-no-ref",
      depth: 1,
      tasks: [{ key: "t1", prompt: "改卡片", staff: "w-app", requirementKey: missingRef }],
    },
    { reader: readerWithAcceptance(["qa"]) },
  );
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(rejected.results[0].ok, false);
  assert.match(rejected.results[0].detail, /验收票/);

  const withOwner = await chainedRequirement(dir);
  const allowed = await runDispatch(
    paseo,
    {
      workspaceId: "ws-app",
      workspaceDir: dir,
      dispatchId: "acceptance-ok",
      depth: 1,
      tasks: [{ key: "t2", prompt: "改卡片", staff: "w-app", requirementKey: withOwner }],
    },
    { reader: readerWithAcceptance(["qa"]) },
  );
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.results[0].ok, true, allowed.results[0].detail);
  assert.equal(paseo.created.length, 1);
});

/* ------------------------------------------------------------ 执行层再查一次 */

test("执行层：直接走 runDispatch 也拒绝被依赖票没关的任务，其余任务照常", async (t) => {
  const dir = await dispatchWorkspace(t);
  // 两条任务挂不同需求：一条声明了「等 #12」，一条没链条。本地工作区没有多仓库配置，
  // 所以不写 repoKey，链条按需求里唯一那一行判。
  const blockedRequirement = await createLocalIssue(dir, {
    title: "需求：商品卡",
    body: `${impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |")}\n\n验收票 #13`,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(blockedRequirement.ok, true);
  const freeRequirement = await createLocalIssue(dir, {
    title: "需求：后台服务",
    body: impact("| app | src/server.ts:1 | 要动 | 经理（2026-11-03） | |"),
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(freeRequirement.ok, true);

  const open = readerFor12("open");
  const paseo = fakePaseo();
  const result = await runDispatch(
    paseo,
    {
      workspaceId: "ws-app",
      workspaceDir: dir,
      dispatchId: "chain-exec-1",
      depth: 1,
      tasks: [
        { key: "blocked", prompt: "改卡片", staff: "w-app", requirementKey: blockedRequirement.number },
        { key: "free", prompt: "改服务", staff: "w-app", requirementKey: freeRequirement.number },
      ],
    },
    { reader: open.reader },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  const blocked = result.results.find((item) => item.key === "blocked");
  const free = result.results.find((item) => item.key === "free");
  assert.equal(blocked?.ok, false, "被依赖票没关，执行层也要拒绝");
  assert.match(blocked?.detail ?? "", /#12/);
  assert.match(blocked?.detail ?? "", /还没关/);
  assert.equal(free?.ok, true, "同批里没链条的那条不能被拖累");
  // 被拒的那条没有建票、没有开会话。
  assert.equal(paseo.created.length, 1);
});

test("MCP 关需求：正文补一行未验收；没有验收票号时写「没有验收票」", async (t) => {
  const dir = await tempWorkspace(t, "deck-chain-mcp-close-");
  const requirement = await createLocalIssue(dir, {
    title: "需求：商品卡",
    body: `${impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |")}\n\n验收票 #2`,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(requirement.ok, true);
  const context = {
    workspaceDir: dir,
    reader: async () => ({ exists: true, closed: false, assignees: ["qa"] }),
    now: () => new Date("2026-11-03T12:00:00.000Z"),
  };

  const closed = await runTool(
    "deck_issue_patch",
    { key: String(requirement.number), close: true },
    context,
  );
  assert.equal(closed.isError, false, closed.text);
  const after = await getLocalIssue(dir, requirement.number);
  assert.equal(after.ok, true);
  assert.match(after.issue.body, /验收：未验收（验收票 #2 仍开着，2026-11-03 关闭）/);

  const unchainedRef = await createLocalIssue(dir, {
    title: "需求：没有验收票",
    body: impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |"),
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(unchainedRef.ok, true);
  const closedWithout = await runTool(
    "deck_issue_patch",
    { key: String(unchainedRef.number), close: true },
    context,
  );
  assert.equal(closedWithout.isError, false, closedWithout.text);
  const afterWithout = await getLocalIssue(dir, unchainedRef.number);
  assert.equal(afterWithout.ok, true);
  assert.match(afterWithout.issue.body, /验收：未验收（没有验收票，2026-11-03 关闭）/);
});

test("关需求：验收票读不到 → 正文仍记一行「读不到」；普通工作票不写验收痕迹", async (t) => {
  const dir = await tempWorkspace(t, "deck-chain-close-unreadable-");
  const requirement = await createLocalIssue(dir, {
    title: "需求：读不到验收票",
    body: `${impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |")}\n\n验收票 #99`,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(requirement.ok, true);
  const context = {
    workspaceDir: dir,
    reader: async () => null,
    now: () => new Date("2026-11-03T12:00:00.000Z"),
  };

  const closed = await runTool("deck_issue_patch", { key: String(requirement.number), close: true }, context);
  assert.equal(closed.isError, false, closed.text);
  const after = await getLocalIssue(dir, requirement.number);
  assert.equal(after.ok, true);
  assert.match(after.issue.body, /验收：未验收（验收票 #99 读不到，2026-11-03 关闭）/);

  // 普通工作票正文里即使夹带一张带链条的影响面表，关票也不该被写上「未验收」。
  const ordinary = await createLocalIssue(dir, {
    title: "普通工作票",
    body: impact("| saas | src/client.ts:1 | 要动 | 经理（2026-11-03） | 等 #12 |"),
    labels: ["issue"],
  });
  assert.equal(ordinary.ok, true);
  const closedOrdinary = await runTool(
    "deck_issue_patch",
    { key: String(ordinary.number), close: true },
    context,
  );
  assert.equal(closedOrdinary.isError, false, closedOrdinary.text);
  const ordinaryAfter = await getLocalIssue(dir, ordinary.number);
  assert.equal(ordinaryAfter.ok, true);
  assert.doesNotMatch(ordinaryAfter.issue.body, /验收：未验收/);
});
