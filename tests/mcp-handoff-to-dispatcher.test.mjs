import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../server/mcp/tools.ts";
import { HANDOFF_TOOL_NAME } from "../shared/handoff-to-dispatcher.ts";
import { readIdentityGaps } from "../server/identity-presence.ts";

/**
 * 交接工具的入口层：身份判定、工作区解析、落盘全在这一层接起来。
 * 纯函数测过之后还会错的，正是「工具忘了传 callerAgentId」这类接线问题。
 */

async function workspace(t, settings) {
  const dir = await mkdtemp(join(tmpdir(), "deck-mcp-handoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  if (settings) await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings), "utf8");
  return dir;
}

function settings(overrides = {}) {
  return {
    version: 1,
    updatedAt: "2026-11-05T00:00:00.000Z",
    workspaceId: "ws1",
    roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "dispatch-1" }],
    routing: [],
    maxDepth: 3,
    maxChildrenPerDispatch: 2,
    reportOnFinish: true,
    ...overrides,
  };
}

const args = {
  requirementKey: 38,
  summary: "补岗位领地",
  tasks: [{ title: "派单闸", prompt: "在派单前拦住缺领地的卡", acceptance: "缺领地时拒绝并列出名字" }],
};

async function run(workspaceDir, input = args) {
  const tool = findTool(HANDOFF_TOOL_NAME);
  assert.ok(tool, "交接工具必须注册");
  const result = await tool.run(input, { workspaceDir });
  return { isError: result.isError, body: JSON.parse(result.text) };
}

async function withCaller(t, caller, fn) {
  const previous = process.env.PASEO_AGENT_ID;
  if (caller === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = caller;
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });
  return fn();
}

test("主窗口交接：进 outbox，带 handoffId 与派单窗口", async (t) => {
  const dir = await workspace(t, settings());
  await withCaller(t, "main-1", async () => {
    const { isError, body } = await run(dir);
    assert.equal(isError, false);
    assert.equal(body.ok, true);
    assert.equal(body.dispatcherAgentId, "dispatch-1");
    assert.equal(body.duplicate, false);
    assert.match(body.handoffId, /^[0-9a-f]{16}$/);
    const stored = JSON.parse(await readFile(body.file, "utf8"));
    assert.equal(stored.mainAgentId, "main-1");
    assert.equal(stored.requirementKey, 38);
    assert.equal(stored.tasks[0].acceptance, "缺领地时拒绝并列出名字");

    // 同样的内容再交一次：同一个 id，不重复入队。
    const again = await run(dir);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.handoffId, body.handoffId);
  });
});

test("只有主窗口能交接：派单窗口、员工、无身份都拒", async (t) => {
  const dir = await workspace(t, settings());
  await withCaller(t, "dispatch-1", async () => {
    const { isError, body } = await run(dir);
    assert.equal(isError, true);
    assert.equal(body.reason, "caller-not-main");
  });
  await withCaller(t, "worker-1", async () => {
    assert.equal((await run(dir)).body.reason, "caller-not-main");
  });
  await withCaller(t, undefined, async () => {
    assert.equal((await run(dir)).body.reason, "caller-unknown");
    const [gap] = await readIdentityGaps(dir);
    assert.equal(gap.lastTool, HANDOFF_TOOL_NAME, "缺身份被拒要留痕：面板据此提示该重开哪个窗口");
  });
});

test("没有票号当场拒；票号不是数字也拒", async (t) => {
  const dir = await workspace(t, settings());
  await withCaller(t, "main-1", async () => {
    const missing = await run(dir, { summary: "x", tasks: [{ prompt: "y" }] });
    assert.equal(missing.isError, true);
    assert.equal(missing.body.reason, "invalid");
    const stringKey = await run(dir, { ...args, requirementKey: "38" });
    assert.equal(stringKey.isError, true);
    assert.equal(stringKey.body.reason, "invalid");
  });
});

test("主=派单：不需要交接，直接说清楚", async (t) => {
  const dir = await workspace(t, settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "main-1" }] }));
  await withCaller(t, "main-1", async () => {
    const { isError, body } = await run(dir);
    assert.equal(isError, true);
    assert.equal(body.reason, "dispatcher-is-main");
  });
});

test("没有角色绑定：拒绝并指到面板", async (t) => {
  const dir = await workspace(t, settings({ roles: [] }));
  await withCaller(t, "main-1", async () => {
    const { isError, body } = await run(dir);
    assert.equal(isError, true);
    assert.equal(body.reason, "no-main");
    assert.match(body.detail, /编排/);
  });
});

test("编排文件坏了：不拿默认值交接", async (t) => {
  const dir = await workspace(t, null);
  await writeFile(join(dir, ".deck", "orchestration.json"), "{broken", "utf8");
  await withCaller(t, "main-1", async () => {
    const { isError, body } = await run(dir);
    assert.equal(isError, true);
    assert.equal(body.reason, "settings-corrupt");
  });
});
