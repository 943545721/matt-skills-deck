import assert from "node:assert/strict";
import test from "node:test";
import {
  decideRoleChild,
  judgeDispatchCaller,
  judgeHandoffCaller,
  judgeRequirementTicketWriter,
  judgeTicketCreator,
  roleOfAgent,
  rolesOfAgent,
  windowSlotsOf,
} from "../shared/window-gates.ts";

/**
 * 三道路径门共用同一把尺子：A 派单入口、B 主窗口交接、C 创建子会话。
 * 每条用例都成对写「该拦」与「不该误拦」——这些门会卡住真实会话，误拦比漏拦更难查。
 */

const MAIN = "main-1";
const REQUIREMENT = "requirement-1";
const DISPATCHER = "dispatcher-1";
const PROGRESS = "progress-1";
const WORKER = "worker-1";

const slots = windowSlotsOf({
  mainAgentId: MAIN,
  requirementAgentId: REQUIREMENT,
  dispatcherAgentId: DISPATCHER,
  progressAgentId: PROGRESS,
});

test("槽位：空串按没配处理", () => {
  assert.deepEqual(
    windowSlotsOf({ mainAgentId: "", requirementAgentId: " ", dispatcherAgentId: "  ", progressAgentId: "p" }),
    {
      mainAgentId: null,
      requirementAgentId: null,
      dispatcherAgentId: null,
      progressAgentId: "p",
    },
  );
  assert.deepEqual(windowSlotsOf(null), {
    mainAgentId: null,
    requirementAgentId: null,
    dispatcherAgentId: null,
    progressAgentId: null,
  });
});

test("槽位：同一个会话可以同时占多个角色，派单优先", () => {
  const both = windowSlotsOf({ mainAgentId: MAIN, dispatcherAgentId: MAIN });
  assert.deepEqual(rolesOfAgent(both, MAIN), ["main", "dispatcher"]);
  assert.equal(roleOfAgent(both, MAIN), "dispatcher");
  assert.deepEqual(rolesOfAgent(slots, WORKER), []);
  assert.equal(roleOfAgent(slots, null), null);
});

test("槽位：需求窗口与主窗口是同一个会话时，单值判定取需求窗口（更具体的那条职责）", () => {
  const both = windowSlotsOf({ mainAgentId: MAIN, requirementAgentId: MAIN });
  assert.deepEqual(rolesOfAgent(both, MAIN), ["main", "requirement"]);
  assert.equal(roleOfAgent(both, MAIN), "requirement");
});

/* ------------------------------------------------------------------ A 派单入口 */

test("A：只有绑定的派单窗口能派单", () => {
  const verdict = judgeDispatchCaller({ callerAgentId: DISPATCHER, slots });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.dispatcherAgentId, DISPATCHER);
});

test("A：主窗口、需求窗口、进度窗口、其他会话分别被点名拒绝", () => {
  assert.equal(judgeDispatchCaller({ callerAgentId: MAIN, slots }).reason, "main-cannot-dispatch");
  assert.equal(judgeDispatchCaller({ callerAgentId: REQUIREMENT, slots }).reason, "requirement-cannot-dispatch");
  assert.equal(judgeDispatchCaller({ callerAgentId: PROGRESS, slots }).reason, "progress-cannot-dispatch");
  assert.equal(judgeDispatchCaller({ callerAgentId: WORKER, slots }).reason, "caller-not-dispatcher");
});

test("A：身份不明、工作区不明、没有绑定都拒，且失败方向是拒绝", () => {
  assert.equal(judgeDispatchCaller({ callerAgentId: "", slots }).reason, "caller-unknown");
  assert.equal(judgeDispatchCaller({ callerAgentId: null, slots }).reason, "caller-unknown");
  assert.equal(judgeDispatchCaller({ callerAgentId: DISPATCHER, slots, workspaceAmbiguous: true }).reason, "workspace-ambiguous");
  assert.equal(judgeDispatchCaller({ callerAgentId: DISPATCHER, slots: null }).reason, "no-workspace");
  assert.equal(judgeDispatchCaller({ callerAgentId: DISPATCHER, slots: windowSlotsOf({ mainAgentId: MAIN }) }).reason, "no-dispatcher");
});

test("A：主窗口与派单窗口是同一个会话时按派单窗口放行", () => {
  const both = windowSlotsOf({ mainAgentId: MAIN, dispatcherAgentId: MAIN });
  const verdict = judgeDispatchCaller({ callerAgentId: MAIN, slots: both });
  assert.equal(verdict.ok, true);
});

test("A：同一个会话同时是需求与主窗口时，按需求窗口回答", () => {
  const both = windowSlotsOf({ mainAgentId: MAIN, requirementAgentId: MAIN, dispatcherAgentId: DISPATCHER });
  assert.equal(judgeDispatchCaller({ callerAgentId: MAIN, slots: both }).reason, "requirement-cannot-dispatch");
});

/* ------------------------------------------------------------------ B 交接 */

test("B：只有主窗口能交接，且必须有派单窗口", () => {
  assert.deepEqual(judgeHandoffCaller({ callerAgentId: MAIN, slots }), {
    ok: true,
    mainAgentId: MAIN,
    dispatcherAgentId: DISPATCHER,
  });
  assert.equal(judgeHandoffCaller({ callerAgentId: WORKER, slots }).reason, "caller-not-main");
  assert.equal(judgeHandoffCaller({ callerAgentId: DISPATCHER, slots }).reason, "caller-not-main");
  assert.equal(judgeHandoffCaller({ callerAgentId: "", slots }).reason, "caller-unknown");
  assert.equal(judgeHandoffCaller({ callerAgentId: MAIN, slots: windowSlotsOf({ dispatcherAgentId: DISPATCHER }) }).reason, "no-main");
  assert.equal(judgeHandoffCaller({ callerAgentId: MAIN, slots: windowSlotsOf({ mainAgentId: MAIN }) }).reason, "no-dispatcher");
});

test("B：主=派单时不需要交接，直接说清楚", () => {
  const both = windowSlotsOf({ mainAgentId: MAIN, dispatcherAgentId: MAIN });
  const verdict = judgeHandoffCaller({ callerAgentId: MAIN, slots: both });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "dispatcher-is-main");
});

/* ------------------------------------------------------------------ C 创建子会话 */

test("C：主窗口、需求窗口、进度窗口直接开的子会话要归档", () => {
  assert.equal(decideRoleChild({ parentAgentId: MAIN, parentRoles: ["main"] }).archive, true);
  assert.equal(decideRoleChild({ parentAgentId: MAIN, parentRoles: ["main"] }).reason, "main-cannot-create");
  const requirement = decideRoleChild({ parentAgentId: REQUIREMENT, parentRoles: ["requirement"] });
  assert.equal(requirement.archive, true);
  assert.equal(requirement.reason, "requirement-cannot-create");
  assert.match(requirement.notice, /需求窗口/);
  const progress = decideRoleChild({ parentAgentId: PROGRESS, parentRoles: ["progress"] });
  assert.equal(progress.archive, true);
  assert.equal(progress.reason, "progress-cannot-create");
  assert.match(progress.notice, /进度窗口/);
});

test("C：派单窗口、执行会话、角色窗口、无父会话都放行", () => {
  assert.equal(decideRoleChild({ parentAgentId: DISPATCHER, parentRoles: ["dispatcher"] }).archive, false);
  assert.equal(decideRoleChild({ parentAgentId: WORKER, parentRoles: [] }).archive, false);
  assert.equal(decideRoleChild({ parentAgentId: null, parentRoles: [] }).archive, false);
  assert.equal(decideRoleChild({ parentAgentId: "   ", parentRoles: ["main"] }).archive, false);
  // 新会话本身就是角色窗口：重建时可能带着父会话，不能反手把它归档。
  assert.equal(decideRoleChild({ parentAgentId: MAIN, parentRoles: ["main"], childIsRoleWindow: true }).archive, false);
});

test("C：主=派单时按派单窗口放行，不拆整条链的上游", () => {
  assert.equal(decideRoleChild({ parentAgentId: MAIN, parentRoles: ["main", "dispatcher"] }).archive, false);
});

test("C：需求=主窗口时按需求窗口归档，原因与派单门同一顺序", () => {
  const verdict = decideRoleChild({ parentAgentId: MAIN, parentRoles: ["main", "requirement"] });
  assert.equal(verdict.archive, true);
  assert.equal(verdict.reason, "requirement-cannot-create");
});

/* ------------------------------------------------------------------ D 需求票写入 */

const REQUIREMENT_TICKET = { currentIsRequirement: true, nextIsRequirement: true };
const WORK_TICKET = { currentIsRequirement: false, nextIsRequirement: false };

test("D：需求窗口能写需求票，但不能建 / 改工作票", () => {
  assert.deepEqual(
    judgeRequirementTicketWriter({ callerAgentId: REQUIREMENT, slots, ...REQUIREMENT_TICKET }),
    { ok: true },
  );
  const verdict = judgeRequirementTicketWriter({ callerAgentId: REQUIREMENT, slots, ...WORK_TICKET });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "requirement-cannot-write-work");
});

test("D：主 / 派单 / 进度 / 其他会话都不能写需求票", () => {
  for (const caller of [MAIN, DISPATCHER, PROGRESS, WORKER]) {
    const verdict = judgeRequirementTicketWriter({ callerAgentId: caller, slots, ...REQUIREMENT_TICKET });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "requirement-window-only");
  }
  // 工作票不受影响：派单窗口本来就要建工作票。
  assert.equal(
    judgeRequirementTicketWriter({ callerAgentId: DISPATCHER, slots, ...WORK_TICKET }).ok,
    true,
  );
});

test("D：给工作票加 requirement 标签等于改需求票，非需求窗口被拒", () => {
  for (const caller of [MAIN, DISPATCHER, PROGRESS, WORKER]) {
    const verdict = judgeRequirementTicketWriter({
      callerAgentId: caller,
      slots,
      currentIsRequirement: false,
      nextIsRequirement: true,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "requirement-window-only");
  }
});

test("D：没绑定需求窗口、或身份不明时放行，不把建票整条路锁死", () => {
  const noRequirement = windowSlotsOf({ mainAgentId: MAIN, dispatcherAgentId: DISPATCHER });
  assert.equal(
    judgeRequirementTicketWriter({ callerAgentId: MAIN, slots: noRequirement, ...REQUIREMENT_TICKET }).ok,
    true,
  );
  assert.equal(
    judgeRequirementTicketWriter({ callerAgentId: "", slots, ...REQUIREMENT_TICKET }).ok,
    true,
  );
});

test("D：需求窗口同时是派单窗口时，按派单窗口放行工作票", () => {
  const both = windowSlotsOf({ requirementAgentId: REQUIREMENT, dispatcherAgentId: REQUIREMENT });
  assert.equal(
    judgeRequirementTicketWriter({ callerAgentId: REQUIREMENT, slots: both, ...WORK_TICKET }).ok,
    true,
  );
  assert.equal(
    judgeRequirementTicketWriter({ callerAgentId: REQUIREMENT, slots: both, ...REQUIREMENT_TICKET }).ok,
    true,
  );
});

test("D：需求窗口把需求票改成工作票要被拒（删 requirement 标签也不行）", () => {
  const verdict = judgeRequirementTicketWriter({
    callerAgentId: REQUIREMENT,
    slots,
    currentIsRequirement: true,
    nextIsRequirement: false,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "requirement-cannot-write-work");
});

test("D：需求窗口把工作票改成需求票同样算写工作票，纯需求窗口被拒", () => {
  const verdict = judgeRequirementTicketWriter({
    callerAgentId: REQUIREMENT,
    slots,
    currentIsRequirement: false,
    nextIsRequirement: true,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "requirement-cannot-write-work");
});

test("D：没绑定需求窗口时，删标签也不拦——这道闸本来就没生效", () => {
  const noRequirement = windowSlotsOf({ mainAgentId: MAIN });
  assert.equal(
    judgeRequirementTicketWriter({
      callerAgentId: MAIN,
      slots: noRequirement,
      currentIsRequirement: true,
      nextIsRequirement: false,
    }).ok,
    true,
  );
});

test("建票闸：主窗口与进度窗口不建票，派单 / 需求 / 执行会话不受影响", () => {
  assert.equal(judgeTicketCreator({ callerAgentId: MAIN, slots }).reason, "main-cannot-create-tickets");
  assert.equal(judgeTicketCreator({ callerAgentId: PROGRESS, slots }).reason, "progress-cannot-create-tickets");
  assert.equal(judgeTicketCreator({ callerAgentId: DISPATCHER, slots }).ok, true);
  assert.equal(judgeTicketCreator({ callerAgentId: REQUIREMENT, slots }).ok, true);
  assert.equal(judgeTicketCreator({ callerAgentId: WORKER, slots }).ok, true);
  assert.equal(judgeTicketCreator({ callerAgentId: "", slots }).ok, true);
  // 主=派单时按派单窗口放行：它要建工作票。
  const both = windowSlotsOf({ mainAgentId: MAIN, dispatcherAgentId: MAIN });
  assert.equal(judgeTicketCreator({ callerAgentId: MAIN, slots: both }).ok, true);
});
