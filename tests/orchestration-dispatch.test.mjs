import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { orchestrationFileOf, writeOrchestration } from "../server/orchestration-store.ts";
import { runDispatch } from "../server/orchestration.ts";

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
  return {
    created,
    config: {
      get: async () => ({ config: structuredClone(config) }),
      patch: async () => ({ config }),
    },
    agents: {
      create: async (options) => {
        created.push(options);
        return { id: `child-${created.length}` };
      },
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

test("派单：这个工作区一条角色都没有时，原因报 unknown-workspace（不是「没选派单窗口」）", async () => {
  const dir = await workspaceWith({ roles: [], routing: ROUTING, maxDepth: 3, maxChildrenPerDispatch: 4, reportOnFinish: true });
  const result = await runDispatch(fakePaseo(), { workspaceId: "ws-1", workspaceDir: dir, tasks: TASKS, depth: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-workspace");
  assert.match(result.detail, /加一条工作区角色/);
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

test("派单：成功路径按路由落到 provider/model，标签里的父会话是实际调用者", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", dispatcherAgentId: "dispatch-1" }],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [{ key: "t1", prompt: "做点事", difficulty: "normal" }],
    depth: 1,
    callerAgentId: "main-9",
  });
  assert.equal(result.ok, true);
  assert.equal(result.dispatcherAgentId, "main-9", "放行看绑定，标签看真实调用者");
  assert.equal(paseo.created.length, 1);
  const options = paseo.created[0];
  assert.equal(options.config.provider, "claude/sonnet");
  assert.equal(options.parent, "main-9");
  assert.equal(options.labels["paseo.parent-agent-id"], "main-9");
  assert.equal(options.labels["deck.difficulty"], "normal");
  assert.match(options.prompt, /第 1 层/);
});

test("派单：一条不合格不影响其它条，逐条带原因返回", async () => {
  const dir = await workspaceWith({
    roles: [{ workspaceId: "ws-1", dispatcherAgentId: "dispatch-1" }],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  });
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [
      { key: "ok", prompt: "干活" },
      { key: "empty", prompt: "  " },
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
