import assert from "node:assert/strict";
import test from "node:test";
import { roleSlotsFor } from "../server/role-window.ts";

/**
 * 后台事件只带 workspaceId：按 id 精确匹配才认身份。
 * 匹配不到 = 这个工作区没配窗口（放行）；分不清是哪片（空 id + 多条绑定）才报歧义。
 */

function settings(roles) {
  return { roles, routing: [], maxDepth: 3, maxChildrenPerDispatch: 4, reportOnFinish: true };
}

test("按 workspaceId 精确匹配；不串到别的工作区", () => {
  const two = settings([
    { workspaceId: "ws-1", mainAgentId: "main-1", dispatcherAgentId: "d-1" },
    { workspaceId: "ws-2", mainAgentId: "main-2", dispatcherAgentId: "d-2" },
  ]);
  assert.equal(roleSlotsFor(two, "ws-2").slots.dispatcherAgentId, "d-2");
  assert.equal(roleSlotsFor(two, "ws-2").slots.mainAgentId, "main-2");
});

test("工作区没有角色绑定：空槽位，不是错误", () => {
  const lookup = roleSlotsFor(settings([{ workspaceId: "ws-1", mainAgentId: "main-1" }]), "ws-9");
  assert.equal(lookup.ok, true);
  assert.deepEqual(lookup.slots, {
    mainAgentId: null,
    requirementAgentId: null,
    dispatcherAgentId: null,
    progressAgentId: null,
  });
});

test("空 workspaceId：唯一绑定可用，零条也是空槽位", () => {
  const one = settings([{ workspaceId: "ws-1", dispatcherAgentId: "d-1" }]);
  assert.equal(roleSlotsFor(one, null).slots.dispatcherAgentId, "d-1");
  assert.equal(roleSlotsFor(one, "").slots.dispatcherAgentId, "d-1");
  assert.equal(roleSlotsFor(settings([]), null).ok, true);
});

test("空 workspaceId + 多条绑定：报歧义，不猜", () => {
  const two = settings([
    { workspaceId: "ws-1", mainAgentId: "main-1" },
    { workspaceId: "ws-2", mainAgentId: "main-2" },
  ]);
  const lookup = roleSlotsFor(two, undefined);
  assert.equal(lookup.ok, false);
  assert.equal(lookup.reason, "workspace-ambiguous");
});

test("同一个工作区多条绑定：同样报歧义", () => {
  const duplicate = settings([
    { workspaceId: "ws-1", dispatcherAgentId: "d-1" },
    { workspaceId: "ws-1", dispatcherAgentId: "d-2" },
  ]);
  const lookup = roleSlotsFor(duplicate, "ws-1");
  assert.equal(lookup.ok, false);
});

test("空串槽位按「没配」处理", () => {
  const lookup = roleSlotsFor(settings([{ workspaceId: "ws-1", mainAgentId: "  ", dispatcherAgentId: "d-1" }]), "ws-1");
  assert.equal(lookup.slots.mainAgentId, null);
  assert.equal(lookup.slots.dispatcherAgentId, "d-1");
});
