import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TurnReporter,
  mainAgentFor,
  progressAgentFor,
  readTailText,
  renderTurnReport,
  reportEnabledFor,
} from "../server/report.ts";
import { writeChildHandoff } from "../server/handoff-store.ts";

/**
 * 向上回传的护栏。
 *
 * 这条链路是整个编排里唯一「错了也看不出来」的地方：报告没送到，子会话照样显示完成。
 * 所以这里逐条钉住三件事——按回传件说话、发送必须带 steer、失败不许当成功。
 */

const agent = (patch = {}) => ({
  id: "agent-child",
  workspaceId: "ws1",
  parentAgentId: "agent-parent",
  provider: "claude",
  cwd: "/tmp/does-not-matter",
  title: "子任务",
  ...patch,
});

const completed = { kind: "completed" };
const failed = { kind: "failed", error: { message: "测试挂了" } };
const canceled = { kind: "canceled", reason: "用户取消" };

const seq = (texts) => ({
  entries: texts.map((text) => ({ item: { type: "assistant_message", text } })),
});

/** 只实现回传用到的两处：`agents.ref(id).send` 与 `timeline.refetch`。 */
function fakePaseo(options = {}) {
  const sent = [];
  const payload = options.timeline ?? { entries: [] };
  return {
    sent,
    agents: {
      ref(id) {
        return {
          send: async (text, sendOptions) => {
            if (options.sendError) throw new Error(options.sendError);
            // 抄送用：只让某个会话发送失败，主投递照常成功。
            const perAgent = options.sendErrorFor?.(id);
            if (perAgent) throw new Error(perAgent);
            sent.push({ id, text, options: sendOptions });
          },
          timeline: { refetch: async () => payload },
        };
      },
    },
  };
}

async function handoffDir(t, agentId, payload) {
  const dir = await mkdtemp(join(tmpdir(), "deck-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  const written = await writeChildHandoff(dir, {
    agentId,
    status: payload.status ?? "completed",
    summary: payload.summary,
    ...(payload.done ? { done: payload.done } : {}),
    ...(payload.ticketKey ? { ticketKey: payload.ticketKey } : {}),
    ...(payload.difficulty ? { difficulty: payload.difficulty } : {}),
  });
  assert.equal(written.ok, true);
  return dir;
}

test("回传正文：有回传件就按回传件说，摘要、已完成、票号、难度都在里面", () => {
  const report = renderTurnReport({
    child: { id: "agent-child", title: "整理票面", provider: "claude" },
    outcome: completed,
    handoff: {
      agentId: "agent-child",
      status: "completed",
      summary: "三段整理完毕",
      done: ["拆出标题", "补复现步骤"],
      nextSteps: ["让测试跑一遍"],
      files: ["docs/port-diff.md"],
      ticketKey: "42",
      difficulty: "normal",
      createdAt: "2026-10-29T00:00:00.000Z",
    },
    tail: "这段不该出现",
  });
  assert.equal(report.source, "handoff");
  assert.match(report.text, /整理票面/);
  assert.match(report.text, /状态：completed · 票 42 · 难度 normal/);
  assert.match(report.text, /摘要：三段整理完毕/);
  assert.match(report.text, /- 拆出标题/);
  assert.match(report.text, /下一步：/);
  assert.match(report.text, /`docs\/port-diff.md`/);
  assert.match(report.text, /回合结果：已完成/);
  // 有回传件时不再搬时间线全文
  assert.doesNotMatch(report.text, /这段不该出现/);
});

test("回传正文：没回传件就退回时间线，并且明说「没调用 deck_handoff」", () => {
  const report = renderTurnReport({
    child: { id: "agent-child", title: null, provider: "codex" },
    outcome: failed,
    handoff: null,
    tail: "最后一段输出",
  });
  assert.equal(report.source, "timeline");
  assert.match(report.text, /agent-child（codex）/);
  assert.match(report.text, /没有调用 `deck_handoff`/);
  assert.match(report.text, /回合结果：失败：测试挂了/);
  assert.match(report.text, /最后一段输出/);
});

test("回传正文：连时间线都没有时如实说「需要人工确认」，不编一个结论", () => {
  const report = renderTurnReport({
    child: { id: "agent-child", title: "子任务", provider: "claude" },
    outcome: canceled,
    handoff: null,
    tail: null,
  });
  assert.equal(report.source, "outcome");
  assert.match(report.text, /回合结果：已取消：用户取消/);
  assert.match(report.text, /需要人工确认/);
});

test("回传正文：时间线尾部过长会截断，不把父会话刷满", () => {
  const report = renderTurnReport({
    child: { id: "c", title: null, provider: "claude" },
    outcome: completed,
    handoff: null,
    tail: "x".repeat(5000),
  });
  assert.ok(report.text.length < 5000 + 500, "应该截断");
  assert.match(report.text, /…$/m);
});

test("时间线尾部只取最后一条非空助手消息", async () => {
  const paseo = fakePaseo({
    timeline: seq(["第一条", "", "  ", "最后一条"]) ,
  });
  // 空的助手消息不算可用输出
  assert.equal(await readTailText(paseo, "agent-child"), "最后一条");

  const onlyTool = fakePaseo({
    timeline: { entries: [{ item: { type: "tool_call", text: "ls" } }, { item: { type: "assistant_message", text: "  " } }] },
  });
  assert.equal(await readTailText(onlyTool, "agent-child"), null);
});

test("时间线读失败返回 null，不把「读不到」当成「没输出」抛出去", async () => {
  const broken = { agents: { ref() { throw new Error("没有这个会话"); } } };
  assert.equal(await readTailText(broken, "gone"), null);
});

test("回传用 steer：不打断父会话正在说的那一回合", async (t) => {
  const paseo = fakePaseo();
  const dir = await handoffDir(t, "agent-child", { summary: "做完了", done: ["一件事"] });
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.reported, true);
  assert.equal(result.source, "handoff");
  assert.equal(paseo.sent.length, 1);
  assert.equal(paseo.sent[0].id, "agent-parent");
  assert.deepEqual(paseo.sent[0].options, { activeTurnBehavior: "steer" });
});

test("没有父会话就什么都不发（主窗口自己的回合结束不该回传给自己）", async () => {
  const paseo = fakePaseo();
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ parentAgentId: null }),
    outcome: completed,
  });
  assert.deepEqual(result, { ok: true, reported: false, reason: "no-parent" });
  assert.equal(paseo.sent.length, 0);
});

test("开关关掉就不回传", async () => {
  const paseo = fakePaseo();
  const result = await new TurnReporter().report(paseo, {
    agent: agent(),
    outcome: completed,
    reportOnFinish: false,
  });
  assert.deepEqual(result, { ok: true, reported: false, reason: "disabled" });
  assert.equal(paseo.sent.length, 0);
});

test("同一个回合重放只上报一次，不同回合照报", async (t) => {
  const paseo = fakePaseo();
  const dir = await handoffDir(t, "agent-child", { summary: "做完了" });
  const reporter = new TurnReporter();
  const first = await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-1" });
  const replay = await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-1" });
  const next = await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-2" });
  assert.equal(first.reported, true);
  assert.deepEqual(replay, { ok: true, reported: false, reason: "already-reported" });
  assert.equal(next.reported, true);
  assert.equal(paseo.sent.length, 2);
});

test("发送失败如实返回 send-failed，不假装回传成功", async (t) => {
  const paseo = fakePaseo({ sendError: "父会话已归档" });
  const dir = await handoffDir(t, "agent-child", { summary: "做完了" });
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "send-failed");
  assert.equal(result.parentAgentId, "agent-parent");
  assert.match(result.detail, /父会话已归档/);
});

/** 工作区里配好「主沟通窗口」，用来验证上一级不可达时的改送。 */
async function withMain(t, mainAgentId) {
  const dir = await handoffDir(t, "agent-child", { summary: "做完了" });
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-10-29T00:00:00.000Z",
      roles: [{ workspaceId: "ws1", mainAgentId, dispatcherAgentId: "agent-parent" }],
      routing: [],
      maxDepth: 3,
      maxChildrenPerDispatch: 4,
      reportOnFinish: true,
    }),
    "utf8",
  );
  return dir;
}

test("上一级收不到时改送主沟通窗口，并在正文里写明绕道", async (t) => {
  const dir = await withMain(t, "agent-main");
  const sent = [];
  const paseo = {
    agents: {
      ref(id) {
        return {
          send: async (text, options) => {
            if (id === "agent-parent") throw new Error("父会话已归档");
            sent.push({ id, text, options });
          },
          timeline: { refetch: async () => ({ entries: [] }) },
        };
      },
    },
  };
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.rerouted, true);
  assert.equal(result.parentAgentId, "agent-main");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "agent-main");
  assert.match(sent[0].text, /上一级 agent-parent 收不到这条回传/);
  assert.match(sent[0].text, /父会话已归档/);
  assert.deepEqual(sent[0].options, { activeTurnBehavior: "steer" });
});

test("没配主沟通窗口（或它就是上一级）时不乱投，如实报 send-failed", async (t) => {
  for (const mainAgentId of [null, "agent-parent"]) {
    const dir = mainAgentId ? await withMain(t, mainAgentId) : await handoffDir(t, "agent-child", { summary: "x" });
    const paseo = fakePaseo({ sendError: "父会话忙" });
    const result = await new TurnReporter().report(paseo, {
      agent: agent({ cwd: dir, workspaceId: "ws1" }),
      outcome: completed,
      turnId: `turn-${mainAgentId ?? "none"}`,
    });
    assert.equal(result.ok, false, `主窗口=${mainAgentId} 时不该假装成功`);
    assert.equal(result.reason, "send-failed");
    assert.equal(paseo.sent.length, 0);
  }
});

test("主沟通窗口也发不出去时仍算失败，不吞掉第一次的原因", async (t) => {
  const dir = await withMain(t, "agent-main");
  const paseo = fakePaseo({ sendError: "整台 daemon 都不回话" });
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "send-failed");
  assert.equal(result.parentAgentId, "agent-parent");
  assert.match(result.detail, /daemon/);
});

test("发失败的那个回合不算「已上报」，重放时会重试", async (t) => {
  const dir = await handoffDir(t, "agent-child", { summary: "做完了" });
  const reporter = new TurnReporter();

  const broken = fakePaseo({ sendError: "父会话忙" });
  const first = await reporter.report(broken, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-1" });
  assert.equal(first.ok, false);

  // 同一回合再来一次（宿主重连后的重放）必须真的重试，而不是被去重表挡掉
  const healthy = fakePaseo();
  const retry = await reporter.report(healthy, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-1" });
  assert.equal(retry.reported, true);
  assert.equal(healthy.sent.length, 1);
});

test("「结束即回传」开关默认开启，工作区里明确关掉才关", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deck-report-sw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await reportEnabledFor(dir), true);

  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify({ version: 1, updatedAt: "2026-10-29T00:00:00.000Z", roles: [], routing: [], maxDepth: 2, maxChildrenPerDispatch: 3, reportOnFinish: false }),
    "utf8",
  );
  assert.equal(await reportEnabledFor(dir), false);
});

test("没有 turnId 时不去重：连续两回合都得送出去，不能被固定键永久挡掉", async (t) => {
  const paseo = fakePaseo();
  const dir = await handoffDir(t, "agent-child", { summary: "做完了" });
  const reporter = new TurnReporter();
  const first = await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: null });
  const second = await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: null });
  assert.equal(first.reported, true);
  assert.equal(second.reported, true, "第二回合也必须有回传");
  assert.equal(paseo.sent.length, 2);
});

test("同一回合的两次重放同时进来时只发一次（在飞也占位）", async (t) => {
  const paseo = fakePaseo();
  const dir = await handoffDir(t, "agent-child", { summary: "做完了" });
  const reporter = new TurnReporter();
  const [a, b] = await Promise.all([
    reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-1" }),
    reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-1" }),
  ]);
  assert.equal(paseo.sent.length, 1);
  assert.equal([a, b].filter((result) => result.reported).length, 1);
});

test("上一回合写下的回传件不重复上报：新回合退回时间线，并说明那是旧件", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deck-report-stale-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck", "handoffs"), { recursive: true });
  const handoffFile = join(dir, ".deck", "handoffs", "agent-child.json");
  const record = (createdAt) =>
    JSON.stringify({ version: 1, agentId: "agent-child", status: "completed", summary: "完成了 A", createdAt });
  await writeFile(handoffFile, record("2026-10-29T00:00:00.000Z"), "utf8");

  const paseo = fakePaseo({ timeline: seq(["第二回合的新输出"]) });
  const reporter = new TurnReporter();

  const first = await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-1" });
  assert.equal(first.source, "handoff");

  const second = await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-2" });
  assert.equal(second.source, "timeline", "旧回传件不能再当新结论");
  assert.match(second.text, /第二回合的新输出/);
  assert.match(second.text, /不是本回合写的/);
});

test("新回合重新写了回传件（时间更新）时，仍然按回传件上报", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deck-report-fresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck", "handoffs"), { recursive: true });
  const handoffFile = join(dir, ".deck", "handoffs", "agent-child.json");
  const record = (createdAt, summary) =>
    JSON.stringify({ version: 1, agentId: "agent-child", status: "completed", summary, createdAt });
  await writeFile(handoffFile, record("2026-10-29T00:00:00.000Z", "完成了 A"), "utf8");

  const paseo = fakePaseo();
  const reporter = new TurnReporter();
  await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-1" });

  await writeFile(handoffFile, record("2026-10-29T01:00:00.000Z", "又完成了 B"), "utf8");
  const second = await reporter.report(paseo, { agent: agent({ cwd: dir }), outcome: completed, turnId: "turn-2" });
  assert.equal(second.source, "handoff");
  assert.match(second.text, /又完成了 B/);
});

/** 工作区里配好任意角色组合，用来验证进度窗口的抄送与去重。 */
async function withRoles(t, role) {
  const dir = await handoffDir(t, "agent-child", { summary: "三段整理完毕", ticketKey: "42" });
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-10-29T00:00:00.000Z",
      roles: [{ workspaceId: "ws1", ...role }],
      routing: [],
      maxDepth: 3,
      maxChildrenPerDispatch: 4,
      reportOnFinish: true,
    }),
    "utf8",
  );
  return dir;
}

test("配了进度窗口时，主投递成功后只抄送一份【进度】，不再往主窗口抄", async (t) => {
  const dir = await withRoles(t, {
    mainAgentId: "agent-main",
    dispatcherAgentId: "agent-parent",
    progressAgentId: "agent-progress",
  });
  const paseo = fakePaseo();
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.reported, true);
  assert.equal(result.parentAgentId, "agent-parent");
  assert.equal(paseo.sent.length, 2, "主投递一次，进度窗口抄一份；主窗口不再收常规抄送");
  assert.equal(paseo.sent[0].id, "agent-parent");
  assert.equal(paseo.sent[1].id, "agent-progress");
  assert.deepEqual(paseo.sent[1].options, { activeTurnBehavior: "steer" });
  assert.match(paseo.sent[1].text, /^【进度】/);
  assert.match(paseo.sent[1].text, /票 42/);
  assert.match(paseo.sent[1].text, /三段整理完毕/);
  // 抄送是摘要，不是把整份回传再抄一遍
  assert.doesNotMatch(paseo.sent[1].text, /【子会话回传】/);
  assert.ok(paseo.sent[1].text.length < paseo.sent[0].text.length);
});

test("主窗口不再收到常规【汇报】：风险与下一步只留在给上一级的回传里", async (t) => {
  const dir = await withRoles(t, {
    mainAgentId: "agent-main",
    dispatcherAgentId: "agent-parent",
    progressAgentId: "agent-progress",
  });
  const written = await writeChildHandoff(dir, {
    agentId: "agent-child",
    status: "completed",
    summary: "三段整理完毕",
    blocking: ["服务端校验还没落地"],
    nextSteps: ["等 #46 合并"],
  });
  assert.equal(written.ok, true);
  const paseo = fakePaseo();
  await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(paseo.sent.some((item) => item.id === "agent-main"), false, "主窗口不该再收到这条回传的副本");
  // 风险与下一步并没有丢：它们仍在给上一级的那份回传里。
  assert.match(paseo.sent[0].text, /服务端校验还没落地/);
  assert.match(paseo.sent[0].text, /等 #46 合并/);
});

test("进度窗口就是上一级时不重复发", async (t) => {
  const dir = await withRoles(t, {
    dispatcherAgentId: "agent-parent",
    progressAgentId: "agent-parent",
  });
  const paseo = fakePaseo();
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(result.reported, true);
  assert.equal(paseo.sent.length, 1, "同一个会话不该收到两份");
  assert.equal(paseo.sent[0].id, "agent-parent");
});

test("进度窗口就是主窗口时照常抄送：它现在是进度汇总的落点，收【进度】", async (t) => {
  const dir = await withRoles(t, {
    mainAgentId: "agent-progress",
    dispatcherAgentId: "agent-parent",
    progressAgentId: "agent-progress",
  });
  const paseo = fakePaseo();
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(result.reported, true);
  assert.deepEqual(paseo.sent.map((item) => item.id), ["agent-parent", "agent-progress"]);
  assert.match(paseo.sent[1].text, /^【进度】/, "同一个窗口同时是主窗口和进度窗口时，按进度窗口收摘要");
});

test("进度窗口抄送失败不影响主投递，仍返回成功", async (t) => {
  const dir = await withRoles(t, {
    mainAgentId: "agent-main",
    dispatcherAgentId: "agent-parent",
    progressAgentId: "agent-progress",
  });
  const paseo = fakePaseo({
    sendErrorFor: (id) => (id === "agent-progress" ? "进度窗口已归档" : undefined),
  });
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(result.ok, true, "旁听窗口发不出去不能把主投递算成失败");
  assert.equal(result.reported, true);
  assert.equal(result.parentAgentId, "agent-parent");
  assert.deepEqual(paseo.sent.map((item) => item.id), ["agent-parent"]);
});

test("同一回合重放时，主投递与抄送都只发一次", async (t) => {
  const dir = await withRoles(t, {
    mainAgentId: "agent-main",
    dispatcherAgentId: "agent-parent",
    progressAgentId: "agent-progress",
  });
  const paseo = fakePaseo();
  const reporter = new TurnReporter();
  const first = await reporter.report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  const replay = await reporter.report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-1",
  });
  assert.equal(first.reported, true);
  assert.equal(replay.reported, false);
  assert.deepEqual(
    paseo.sent.map((item) => item.id),
    ["agent-parent", "agent-progress"],
    "沿用 same-turnId 去重，重放不再抄送",
  );
});

test("角色槽位取值：主窗口与进度窗口各取各的，没配就是 null", async (t) => {
  const dir = await withRoles(t, {
    mainAgentId: "agent-main",
    dispatcherAgentId: "agent-parent",
    progressAgentId: "agent-progress",
  });
  assert.equal(await mainAgentFor(dir, "ws1"), "agent-main");
  assert.equal(await progressAgentFor(dir, "ws1"), "agent-progress");
  assert.equal(await mainAgentFor(dir, "ws-missing"), null);
  assert.equal(await progressAgentFor(dir, null), null);
});

test("上一级收不到、改送主窗口成功时，进度窗口仍收到一份", async (t) => {
  const dir = await withRoles(t, {
    mainAgentId: "agent-main",
    dispatcherAgentId: "agent-parent",
    progressAgentId: "agent-progress",
  });
  const paseo = fakePaseo({ sendErrorFor: (id) => (id === "agent-parent" ? "上一级已归档" : undefined) });
  const result = await new TurnReporter().report(paseo, {
    agent: agent({ cwd: dir, workspaceId: "ws1" }),
    outcome: completed,
    turnId: "turn-reroute",
  });
  assert.equal(result.ok, true);
  assert.equal(result.rerouted, true);
  assert.deepEqual(
    paseo.sent.map((item) => item.id),
    ["agent-main", "agent-progress"],
    "绕道成功后，旁听的进度窗口不该漏",
  );
});

test("回传件缺 status 或 createdAt 坏掉时按「用不了」处理，退回读时间线", async (t) => {
  for (const [name, payload] of [
    ["缺 status", { version: 1, agentId: "agent-child", summary: "完成了 A", createdAt: "2026-10-29T00:00:00.000Z" }],
    ["createdAt 不是时间", { version: 1, agentId: "agent-child", status: "completed", summary: "完成了 A", createdAt: "昨天" }],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "deck-report-bad-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, ".deck", "handoffs"), { recursive: true });
    await writeFile(join(dir, ".deck", "handoffs", "agent-child.json"), JSON.stringify(payload), "utf8");
    const paseo = fakePaseo({ timeline: seq(["本回合的实际输出"]) });
    const result = await new TurnReporter().report(paseo, {
      agent: agent({ cwd: dir }),
      outcome: completed,
      turnId: `turn-${name}`,
    });
    assert.equal(result.source, "timeline", `${name}：不能拿半份回传件上报`);
    assert.match(result.text, /本回合的实际输出/);
    assert.doesNotMatch(result.text, /状态：undefined/);
  }
});
