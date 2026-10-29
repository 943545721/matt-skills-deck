import assert from "node:assert/strict";
import test from "node:test";
import { creationOutcome, creationRoute } from "../client/deck/session/creation.ts";

test("有 workspaceId 时绑工作区，并去掉首尾空白", () => {
  assert.deepEqual(creationRoute({ workspaceId: " wks_1 ", workspaceDir: "/repo" }), {
    kind: "workspace",
    workspaceId: "wks_1",
  });
});

test("没有 workspaceId 时才退回 cwd", () => {
  assert.deepEqual(creationRoute({ workspaceId: "", workspaceDir: " /repo " }), {
    kind: "cwd",
    cwd: "/repo",
  });
  assert.deepEqual(creationRoute({ workspaceDir: "/repo" }), { kind: "cwd", cwd: "/repo" });
});

test("两者都缺失或只有空白时拒绝创建", () => {
  assert.deepEqual(creationRoute({}), { kind: "blocked" });
  assert.deepEqual(creationRoute({ workspaceId: "   ", workspaceDir: "  " }), { kind: "blocked" });
});

test("accepted 阶段预分配的 agentId 不算会话已创建", () => {
  const outcome = creationOutcome({ phase: "accepted", agentId: "preallocated" });
  assert.equal(outcome.agentId, "");
  assert.equal(outcome.failed, false);
});

test("只有快照带 agent.id 才认作已创建，并去掉首尾空白", () => {
  assert.equal(creationOutcome({ phase: "agent_ready", agentId: "preallocated", agent: { id: " a1 " } }).agentId, "a1");
  assert.equal(creationOutcome({ phase: "completed", agent: { id: "a2" } }).agentId, "a2");
  assert.equal(creationOutcome({ phase: "completed", agent: {} }).agentId, "");
  assert.equal(creationOutcome(null).agentId, "");
});

test("agent 阶段失败如实给出失败与结果不确定，不伪造会话 id", () => {
  const known = creationOutcome({ phase: "failed", agentId: "preallocated", error: "spawn failed", outcomeUnknown: false });
  assert.deepEqual(known, {
    agentId: "",
    failed: true,
    outcomeUnknown: false,
    detail: "spawn failed",
  });
  const unknown = creationOutcome({ phase: "failed", agentId: "preallocated", error: "agent_request_outcome_unknown", outcomeUnknown: true });
  assert.equal(unknown.agentId, "");
  assert.equal(unknown.failed, true);
  assert.equal(unknown.outcomeUnknown, true);
});

test("失败快照里已经有真实 agent 时，仍按已创建处理（首个回合失败不等于会话不存在）", () => {
  const partial = creationOutcome({ phase: "failed", agent: { id: "a3" }, error: "prompt failed", outcomeUnknown: true });
  assert.equal(partial.agentId, "a3");
  assert.equal(partial.failed, true);
  assert.equal(partial.outcomeUnknown, true);
});
