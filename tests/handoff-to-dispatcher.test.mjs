import assert from "node:assert/strict";
import test from "node:test";
import {
  handoffFromDisk,
  handoffIdOf,
  planHandoff,
  renderHandoffMessage,
} from "../shared/handoff-to-dispatcher.ts";

/**
 * 交接件是主窗口与派单窗口之间唯一的凭据：幂等锚错了会重复派单，
 * 校验松了会落一份不知道给谁的件。用例钉住形状、幂等与消息内容。
 */

const base = {
  workspaceId: "wks_1",
  requirementKey: 38,
  summary: "把岗位领地校验补齐",
  tasks: [
    { title: "派单闸", prompt: "在派单前拦住缺领地的卡", acceptance: "缺领地时拒绝并列出名字", staff: "backend-1" },
    { prompt: "补测试", repoKey: "o/r", map: "map-3" },
  ],
  constraints: "不要改归属算法",
};

const build = (overrides = {}) =>
  planHandoff({ ...base, ...overrides }, { callerAgentId: "main-1", workspaceId: "wks_1", at: "2026-11-05T00:00:00.000Z" });

test("合法交接：拼出可直接落盘的投递件", () => {
  const built = build();
  assert.equal(built.ok, true);
  const envelope = built.envelope;
  assert.equal(envelope.version, 1);
  assert.equal(envelope.mainAgentId, "main-1");
  assert.equal(envelope.workspaceId, "wks_1");
  assert.equal(envelope.requirementKey, 38);
  assert.equal(envelope.createdAt, "2026-11-05T00:00:00.000Z");
  assert.equal(envelope.attempts, 0);
  assert.equal(envelope.lang, "zh");
  assert.equal(envelope.tasks.length, 2);
  assert.equal(envelope.tasks[0].staff, "backend-1");
  assert.equal(envelope.tasks[1].map, "map-3");
  assert.match(envelope.handoffId, /^[0-9a-f]{16}$/);
});

test("幂等：同样内容同一个 id，改了任务内容就是新的一份", () => {
  assert.equal(build().envelope.handoffId, build().envelope.handoffId);
  const changed = build({ tasks: [{ prompt: "换一件事" }] }).envelope.handoffId;
  assert.notEqual(changed, build().envelope.handoffId);
  assert.equal(
    handoffIdOf({ mainAgentId: "main-1", workspaceId: "wks_1", requirementKey: 38, summary: "x", tasks: [] }),
    handoffIdOf({ mainAgentId: "main-1", workspaceId: "wks_1", requirementKey: 38, summary: "x", tasks: [] }),
  );
});

test("拒绝：没有身份、没有票号、空概要、空任务、坏任务", () => {
  assert.equal(planHandoff(base, {}).reason, "caller-unknown");
  assert.equal(build({ requirementKey: 0 }).reason, "no-requirement");
  assert.equal(build({ requirementKey: "38" }).reason, "no-requirement");
  assert.equal(build({ summary: "  " }).reason, "invalid-handoff");
  assert.equal(build({ tasks: [] }).reason, "invalid-handoff");
  assert.equal(build({ tasks: [{ prompt: "" }] }).reason, "invalid-handoff");
  assert.equal(build({ tasks: [{ prompt: "x", staff: "Backend One" }] }).reason, "invalid-handoff");
});

test("工作区：入参优先，其次上下文；都没有就拒", () => {
  const fromContext = planHandoff({ ...base, workspaceId: undefined }, { callerAgentId: "main-1", workspaceId: "wks_ctx" });
  assert.equal(fromContext.ok, true);
  assert.equal(fromContext.envelope.workspaceId, "wks_ctx");
  const none = planHandoff({ ...base, workspaceId: undefined }, { callerAgentId: "main-1" });
  assert.equal(none.reason, "invalid-handoff");
});

test("读回：合法件往返一致，坏件返回 null", () => {
  const envelope = build().envelope;
  const round = handoffFromDisk(JSON.parse(JSON.stringify(envelope)));
  assert.deepEqual(round, envelope);
  assert.equal(handoffFromDisk({ version: 2 }), null);
  assert.equal(handoffFromDisk({ ...envelope, handoffId: "" }), null);
  assert.equal(handoffFromDisk({ ...envelope, requirementKey: 0 }), null);
  assert.equal(handoffFromDisk(null), null);
  // 坏任务被丢掉，好任务留下：一件坏活不该堵住整份交接。
  const partial = handoffFromDisk({ ...envelope, tasks: [{ prompt: "ok" }, { prompt: "" }] });
  assert.equal(partial.tasks.length, 1);
});

test("消息：带幂等锚、需求票号、任务、验收与派单指令", () => {
  const message = renderHandoffMessage(build().envelope);
  assert.match(message, /【主窗口交接】/);
  assert.match(message, new RegExp(`handoffId: ${build().envelope.handoffId}`));
  assert.match(message, /需求：#38/);
  assert.match(message, /把岗位领地校验补齐/);
  assert.match(message, /验收：缺领地时拒绝并列出名字/);
  assert.match(message, /岗位：backend-1/);
  assert.match(message, /约束：不要改归属算法/);
  assert.match(message, /deck_dispatch_plan/);
  assert.match(message, /deck:定稿/);
  assert.match(message, /deck_handoff/);
});

test("消息：英文交接用英文，需求票带仓库时写成 repo#n", () => {
  const envelope = build({ lang: "en", requirementRepoKey: "o/r" }).envelope;
  const message = renderHandoffMessage(envelope);
  assert.match(message, /Handoff from the main window/);
  assert.match(message, /Requirement: o\/r#38/);
  assert.match(message, /Acceptance: 缺领地时拒绝并列出名字/);
  assert.match(message, /Staff: backend-1/);
  assert.match(message, /deck_dispatch_plan/);
  assert.doesNotMatch(message, /【主窗口交接】/);
});
