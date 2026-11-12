import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerExecutionGate } from "../server/execution-gate.ts";

/**
 * D 执行门：主 / 需求 / 派单 / 进度窗口不改文件。
 *
 * 每道门都要有两条用例：「拦住」与「不误拦」。这里尤其要钉住执行窗口、
 * 只读命令、gh 票闸让行与配置读不出来时的放行。
 */

const SETTINGS = {
  version: 1,
  updatedAt: "2026-11-05T00:00:00.000Z",
  workspaceId: "ws-1",
  roles: [{
    workspaceId: "ws-1",
    mainAgentId: "main-1",
    requirementAgentId: "requirement-1",
    dispatcherAgentId: "dispatch-1",
    progressAgentId: "progress-1",
  }],
  routing: [],
  maxDepth: 3,
  maxChildrenPerDispatch: 4,
  reportOnFinish: true,
};

async function makeWorkspace(t, settings = SETTINGS) {
  const dir = await mkdtemp(join(tmpdir(), "deck-execution-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    typeof settings === "string" ? settings : JSON.stringify(settings),
    "utf8",
  );
  return dir;
}

async function fire(dir, agent, request) {
  const denied = [];
  const handlers = [];
  const held = new Set();
  const inFlight = new Map();
  const server = {
    on(name, handler) {
      if (name === "agent.permission_requested") handlers.push(handler);
    },
  };
  registerExecutionGate(server, {
    permissionKey: (agentId, requestId) => `${agentId}\u0000${requestId}`,
    heldForUserConfirmation: held,
    gateInFlight: inFlight,
  });
  assert.equal(handlers.length, 1);
  const paseo = {
    agents: {
      ref: (agentId) => ({
        respondToPermission: async ({ requestId, response }) => {
          denied.push({ agentId, requestId, response });
        },
      }),
    },
  };
  await handlers[0](
    { agent: { cwd: dir, workspaceId: "ws-1", ...agent }, request },
    { paseo, signal: new AbortController().signal },
  );
  return { denied, held, inFlight };
}

const write = (id) => ({ type: "write", filePath: `/repo/${id}.ts` });
const edit = () => ({ type: "edit", filePath: "/repo/a.ts" });
const shell = (command) => ({ type: "shell", command });

test("主窗口 write / edit：拒绝，并留下「已拦」标记", async (t) => {
  const dir = await makeWorkspace(t);
  for (const detail of [write("a"), edit()]) {
    const { denied, held } = await fire(dir, { id: "main-1" }, { id: "r1", kind: "tool", detail });
    assert.equal(denied.length, 1);
    assert.equal(denied[0].response.behavior, "deny");
    assert.match(denied[0].response.message, /主窗口不改文件/);
    assert.ok(held.has("main-1\u0000r1"), "拦下后不能让自动放行翻回来");
  }
});

test("需求窗口写文件同样拒：它只建需求票，不改文件", async (t) => {
  const dir = await makeWorkspace(t);
  const { denied, held } = await fire(dir, { id: "requirement-1" }, { id: "r1", kind: "tool", detail: write("a") });
  assert.equal(denied.length, 1);
  assert.equal(denied[0].response.behavior, "deny");
  assert.match(denied[0].response.message, /需求窗口只建需求票/);
  assert.ok(held.has("requirement-1\u0000r1"), "拦下后不能让自动放行翻回来");
});

test("派单窗口改文件的 shell：拒绝，文案补一句命令种类", async (t) => {
  const dir = await makeWorkspace(t);
  const { denied } = await fire(dir, { id: "dispatch-1" }, { id: "r1", kind: "tool", detail: shell("rm -rf build") });
  assert.equal(denied.length, 1);
  assert.match(denied[0].response.message, /派单窗口只拆活/);
  assert.match(denied[0].response.message, /这条命令会改文件/);
});

test("进度窗口写文件同样拒；重定向与 tee 也算改文件", async (t) => {
  const dir = await makeWorkspace(t);
  const progress = await fire(dir, { id: "progress-1" }, { id: "r1", kind: "tool", detail: write("x") });
  assert.equal(progress.denied.length, 1);
  assert.match(progress.denied[0].response.message, /进度窗口只旁听/);

  for (const command of ["echo x > out.txt", "cat a | tee b", "sed -i 's/a/b/' x.ts"]) {
    const { denied } = await fire(dir, { id: "main-1" }, { id: "r2", kind: "tool", detail: shell(command) });
    assert.equal(denied.length, 1, command);
  }
});

test("执行窗口、只读命令、跑测试：都不拦，也不留标记", async (t) => {
  const dir = await makeWorkspace(t);
  for (const command of ["ls", "git status", "git diff HEAD", "npm test", "npm run typecheck", "rg TODO src"]) {
    const { denied, held } = await fire(dir, { id: "main-1" }, { id: "r9", kind: "tool", detail: shell(command) });
    assert.equal(denied.length, 0, command);
    assert.equal(held.size, 0, command);
  }
  const read = await fire(dir, { id: "main-1" }, { id: "r9", kind: "tool", detail: { type: "read", filePath: "/repo/a.ts" } });
  assert.equal(read.denied.length, 0);

  const worker = await fire(dir, { id: "worker-1" }, { id: "r9", kind: "tool", detail: write("a") });
  assert.equal(worker.denied.length, 0, "执行窗口本来就该干活");
  assert.equal(worker.held.size, 0);
});

test("gh 改票命令让给票闸：执行门不出手", async (t) => {
  const dir = await makeWorkspace(t);
  const { denied, held } = await fire(
    dir,
    { id: "main-1" },
    { id: "r1", kind: "tool", detail: shell("gh issue create --title x --body y") },
  );
  assert.equal(denied.length, 0);
  assert.equal(held.size, 0);
});

test("配置读不出来 / 工作区分不清：放行 + 不留标记", async (t) => {
  const broken = await makeWorkspace(t, "{broken");
  const first = await fire(broken, { id: "main-1" }, { id: "r1", kind: "tool", detail: write("a") });
  assert.equal(first.denied.length, 0);
  assert.equal(first.held.size, 0);

  const two = {
    ...SETTINGS,
    roles: [
      { workspaceId: "ws-1", mainAgentId: "main-1" },
      { workspaceId: "ws-2", mainAgentId: "main-2" },
    ],
  };
  const dir = await makeWorkspace(t, two);
  const second = await fire(dir, { id: "main-1", workspaceId: null }, { id: "r1", kind: "tool", detail: write("a") });
  assert.equal(second.denied.length, 0);
  assert.equal(second.held.size, 0);
});

test("没有 detail 的请求不碰：自动放行自己处理", async (t) => {
  const dir = await makeWorkspace(t);
  const { denied, held } = await fire(dir, { id: "main-1" }, { id: "r1", kind: "other" });
  assert.equal(denied.length, 0);
  assert.equal(held.size, 0);
});
