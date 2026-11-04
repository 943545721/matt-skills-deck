import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ROLE_PROMPTS,
  FIXED_ROLES,
  MAX_ROLE_PROMPT_CHARS,
  agentIdOf,
  normalizeOrchestration,
  rolePromptFor,
  withWorkspaceRoles,
} from "../shared/orchestration.ts";
import { promptPatchFor, withRoles } from "../client/deck/surfaces/orchestration/types.ts";

const workspaceId = "ws-1";

test("三个固定窗口各有中英两份默认提示词", () => {
  for (const role of FIXED_ROLES) {
    assert.ok(DEFAULT_ROLE_PROMPTS[role].zh.trim().length > 0, `${role} 缺中文默认值`);
    assert.ok(DEFAULT_ROLE_PROMPTS[role].en.trim().length > 0, `${role} 缺英文默认值`);
  }
  // 主窗口那条必须把「不改代码」写出来：这是本轮要解决的问题，不能被改写冲掉。
  assert.match(DEFAULT_ROLE_PROMPTS.main.zh, /不改代码/);
  assert.match(DEFAULT_ROLE_PROMPTS.main.en, /Do not edit code/);
});

test("用户改过的提示词覆盖默认值，没改的回落到默认值", () => {
  const roles = { workspaceId, prompts: { main: "只谈方案" } };
  assert.equal(rolePromptFor(roles, "main", "zh"), "只谈方案");
  assert.equal(rolePromptFor(roles, "dispatcher", "zh"), DEFAULT_ROLE_PROMPTS.dispatcher.zh);
  assert.equal(rolePromptFor(roles, "dispatcher", "en"), DEFAULT_ROLE_PROMPTS.dispatcher.en);
});

test("没有绑定、提示词为空白时一律回默认值", () => {
  assert.equal(rolePromptFor(null, "progress", "zh"), DEFAULT_ROLE_PROMPTS.progress.zh);
  assert.equal(rolePromptFor({ workspaceId, prompts: { progress: "   " } }, "progress", "zh"), DEFAULT_ROLE_PROMPTS.progress.zh);
});

test("槽位取值走同一个入口，空的回 null", () => {
  const roles = { workspaceId, mainAgentId: " a ", progressAgentId: "" };
  assert.equal(agentIdOf(roles, "main"), "a");
  assert.equal(agentIdOf(roles, "dispatcher"), null);
  assert.equal(agentIdOf(roles, "progress"), null);
  assert.equal(agentIdOf(null, "main"), null);
});

test("归一化保留进度窗口与提示词，超长的被截断", () => {
  const settings = normalizeOrchestration({
    roles: [
      {
        workspaceId,
        mainAgentId: "m",
        progressAgentId: "p",
        prompts: { main: "x".repeat(MAX_ROLE_PROMPT_CHARS + 50), progress: "只收进度", nonsense: "丢掉" },
      },
    ],
  });
  const role = settings.roles[0];
  assert.equal(role.mainAgentId, "m");
  assert.equal(role.progressAgentId, "p");
  assert.equal(role.prompts.main.length, MAX_ROLE_PROMPT_CHARS);
  assert.equal(role.prompts.progress, "只收进度");
  assert.equal("nonsense" in role.prompts, false);
});

test("保存一次不会把进度窗口与提示词抹掉", () => {
  const before = normalizeOrchestration({
    roles: [{ workspaceId, mainAgentId: "m", progressAgentId: "p", prompts: { main: "只谈方案" } }],
  });
  const after = withWorkspaceRoles(before, {
    workspaceId,
    mainAgentId: "m",
    progressAgentId: "p",
    prompts: { main: "只谈方案" },
  });
  const role = after.roles.find((item) => item.workspaceId === workspaceId);
  assert.equal(role.progressAgentId, "p");
  assert.equal(role.prompts.main, "只谈方案");
});

test("三个槽位都空且没有提示词时，整条角色被删掉", () => {
  const before = normalizeOrchestration({ roles: [{ workspaceId, mainAgentId: "m" }] });
  const after = withWorkspaceRoles(before, { workspaceId });
  assert.equal(after.roles.length, 0);
});

test("清掉最后一段自定义提示词后，旧文本不会复活", () => {
  const before = normalizeOrchestration({
    roles: [{ workspaceId, mainAgentId: "m", prompts: { main: "只谈方案" } }],
  });
  const after = withRoles(before, workspaceId, { prompts: { main: null } });
  const role = after.roles.find((item) => item.workspaceId === workspaceId);
  assert.equal(role.prompts, undefined, "恢复默认要真的落盘，不能把旧 prompts 带回去");
  assert.equal(role.mainAgentId, "m", "其它槽位不受影响");
});

test("补丁里没提交的提示词段原样保留", () => {
  const before = normalizeOrchestration({
    roles: [{ workspaceId, prompts: { main: "只谈方案", dispatcher: "只派活" } }],
  });
  const after = withRoles(before, workspaceId, { prompts: { dispatcher: null } });
  const role = after.roles.find((item) => item.workspaceId === workspaceId);
  assert.deepEqual(role.prompts, { main: "只谈方案" });
});

test("提示词保存判断：与当前语言默认值相同视为没改", () => {
  const custom = { workspaceId, prompts: { main: "只谈方案" } };
  const fallback = DEFAULT_ROLE_PROMPTS.main.zh;
  assert.equal(promptPatchFor("main", fallback, undefined, "zh"), null, "没自定义过就不落盘");
  assert.deepEqual(
    promptPatchFor("main", fallback, custom, "zh"),
    { prompts: { main: null } },
    "改回默认值要删掉自定义段",
  );
  assert.equal(promptPatchFor("main", "只谈方案", custom, "zh"), null, "与当前自定义值相同不重复写");
  assert.deepEqual(promptPatchFor("main", "换成这段", custom, "zh"), { prompts: { main: "换成这段" } });
});

test("提示词保存判断：空文本只清自定义，超长一律拒绝", () => {
  const custom = { workspaceId, prompts: { main: "只谈方案" } };
  assert.deepEqual(promptPatchFor("main", "  ", custom, "zh"), { prompts: { main: null } });
  assert.equal(promptPatchFor("main", "", undefined, "zh"), null);
  assert.equal(promptPatchFor("main", "x".repeat(MAX_ROLE_PROMPT_CHARS + 1), custom, "zh"), null);
});
