import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../server/mcp/tools.ts";

/**
 * 两个新工具的入口层。
 *
 * 纯函数测过之后仍会出错的，就是「工具忘了传某个字段」「上下文没接上」这类：
 * Agent 真正摸到的是这一层，所以这里走 `findTool(...).run(...)` 而不是直接调纯函数。
 */

async function workspace(t, settings) {
  const dir = await mkdtemp(join(tmpdir(), "deck-mcp-orch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  if (settings) {
    await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings), "utf8");
  }
  return dir;
}

const baseSettings = {
  version: 1,
  updatedAt: "2026-10-29T00:00:00.000Z",
  workspaceId: "ws1",
  roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "dispatch-1" }],
  routing: [
    { difficulty: "normal", target: { provider: "claude", model: "sonnet" } },
    { difficulty: "hard", target: { provider: "codex", model: "gpt-5" } },
  ],
  maxDepth: 3,
  maxChildrenPerDispatch: 2,
  reportOnFinish: true,
};

/**
 * `PASEO_AGENT_ID` 在 Paseo 进程里是有值的：测试若跟着环境走，「谁在派单」就会随机器变化。
 * 统一清掉，需要它的用例自己设、自己还原。
 */
delete process.env.PASEO_AGENT_ID;

const runTool = async (name, args, workspaceDir) => {
  const tool = findTool(name);
  assert.ok(tool, `${name} 必须注册`);
  const result = await tool.run(args, { workspaceDir });
  return { isError: result.isError, body: JSON.parse(result.text), raw: result.text };
};

test("deck_dispatch_plan：按难度给出客户端、标签和带抬头的提示词", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { isError, body } = await runTool(
    "deck_dispatch_plan",
    {
      tasks: [
        { key: "t1", title: "整理票面", prompt: "整理成三段", difficulty: "hard" },
        { key: "t2", prompt: "写单测", difficulty: "normal" },
      ],
      depth: 1,
    },
    dir,
  );
  assert.equal(isError, false);
  assert.equal(body.ok, true);
  assert.equal(body.dispatcherAgentId, "dispatch-1");
  assert.equal(body.nextDepth, 2);
  assert.equal(body.tasks.length, 2);

  const [hard, normal] = body.tasks;
  assert.equal(hard.provider, "codex");
  assert.equal(hard.model, "gpt-5");
  assert.equal(normal.provider, "claude");
  assert.equal(normal.model, "sonnet");

  // 标签原样交给宿主的 create_agent：父会话 id 与难度都在里面
  assert.equal(normal.labels["paseo.parent-agent-id"], "dispatch-1");
  assert.equal(normal.labels["deck.difficulty"], "normal");
  assert.equal(normal.labels["deck.ticket"], "t2");
  assert.match(normal.idempotencyKey, /^deck-dispatch-[0-9a-f]{8}$/);

  // 提示词抬头必须让子会话知道自己该调 deck_handoff
  assert.match(hard.prompt, /deck_handoff/);
  assert.match(hard.prompt, /dispatch-1/);
  assert.match(hard.prompt, /整理成三段/);
});

test("deck_dispatch_plan：没配派单窗口时逐条拒绝，并给出可执行的下一步", async (t) => {
  // 角色在、派单窗口没选：这一条走的是 no-dispatcher
  const dir = await workspace(t, { ...baseSettings, roles: [{ workspaceId: "ws1", mainAgentId: "main-1" }] });
  const { isError, body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.equal(isError, false, "拒绝是正常结果，不是工具错误");
  assert.equal(body.ok, true);
  assert.equal(body.tasks.length, 0);
  assert.equal(body.rejected[0].reason, "no-dispatcher");
  assert.match(body.rejected[0].detail, /派单窗口/);
});

test("deck_dispatch_plan：工作区里根本没有编排文件时，除了拒绝还要提示先去配", async (t) => {
  const dir = await workspace(t, null);
  const { body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.equal(body.tasks.length, 0);
  // 连角色都没有：这条是「没绑定工作区」，不是「没选派单窗口」
  assert.equal(body.rejected[0].reason, "unknown-workspace");
  assert.match(body.rejected[0].detail, /角色绑定/);
  assert.ok(body.warnings.some((line) => line.includes("还没有编排设置")));
});

test("deck_dispatch_plan：超过单次上限的条目被拒，其余照发", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { body } = await runTool(
    "deck_dispatch_plan",
    {
      tasks: [
        { key: "a", prompt: "1" },
        { key: "b", prompt: "2" },
        { key: "c", prompt: "3" },
      ],
      depth: 1,
    },
    dir,
  );
  assert.deepEqual(
    body.tasks.map((task) => task.key),
    ["a", "b"],
  );
  assert.equal(body.rejected[0].key, "c");
  assert.equal(body.rejected[0].reason, "too-many-children");
});

test("deck_dispatch_plan：借用路由的档位在 warnings 里点名，不乱降到别处", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "x", prompt: "p", difficulty: "critical" }], depth: 1 },
    dir,
  );
  const task = body.tasks[0];
  assert.equal(task.difficulty, "critical", "难度本身不改写");
  assert.equal(task.routeFrom, "normal");
  assert.ok(body.warnings.some((line) => line.includes("critical") && line.includes("借用")));
});

test("deck_dispatch_plan：入参不合法时是工具错误，并说清哪一步错了", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { isError, body } = await runTool("deck_dispatch_plan", { tasks: [] }, dir);
  assert.equal(isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "invalid");
});

test("deck_dispatch_plan：depth 必填，缺省不按第 0 层猜", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { isError, body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }] }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "invalid");
});

test("deck_dispatch_plan：真正在派单的是当前会话时，标签按它写并说清和绑定不一致", async (t) => {
  const dir = await workspace(t, baseSettings);
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "main-9";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 0 }, dir);
  assert.equal(body.tasks[0].labels["paseo.parent-agent-id"], "main-9");
  assert.match(body.tasks[0].prompt, /main-9/);
  assert.ok(body.warnings.some((line) => line.includes("main-9") && line.includes("dispatch-1")));
});

test("deck_dispatch_plan：编排文件坏掉时直接报错，不拿默认值编出「先加一条角色」", async (t) => {
  const dir = await workspace(t, null);
  await writeFile(join(dir, ".deck", "orchestration.json"), "{ 这不是 JSON", "utf8");
  const { isError, body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p" }], workspaceId: "ws1", depth: 1 },
    dir,
  );
  assert.equal(isError, true);
  assert.equal(body.reason, "settings-corrupt");
  assert.match(body.detail, /解析失败/);
});

test("deck_dispatch_plan：编排文件读不出来（不是没配过）时报 settings-unreadable", async (t) => {
  const dir = await workspace(t, null);
  // 把文件位置做成目录：readFile 报 EISDIR，不是 ENOENT
  await mkdir(join(dir, ".deck", "orchestration.json"), { recursive: true });
  const { isError, body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p" }], workspaceId: "ws1", depth: 1 },
    dir,
  );
  assert.equal(isError, true);
  assert.equal(body.reason, "settings-unreadable");
});

test("deck_handoff：子会话写回传件，路径落在工作区 .deck/handoffs 下", async (t) => {
  const dir = await workspace(t, baseSettings);
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "child-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool(
    "deck_handoff",
    {
      summary: "三段整理完毕",
      done: ["拆标题", "补复现"],
      nextSteps: ["让测试跑一遍"],
      files: ["docs/port-diff.md"],
      ticketKey: "42",
      difficulty: "hard",
    },
    dir,
  );
  assert.equal(isError, false);
  assert.equal(body.ok, true);
  assert.equal(body.agentId, "child-1");
  assert.match(body.path, /\.deck\/handoffs\/child-1\.json$/);
  assert.match(body.markdown, /三段整理完毕/);

  const stored = JSON.parse(await readFile(body.path, "utf8"));
  assert.equal(stored.status, "completed");
  assert.deepEqual(stored.done, ["拆标题", "补复现"]);
  assert.equal(stored.difficulty, "hard");
});

test("deck_handoff：不接受 agentId 入参，替别人写回传件这条路根本不存在", async (t) => {
  const dir = await workspace(t, baseSettings);
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "child-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool("deck_handoff", { summary: "冒名", agentId: "child-2" }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "invalid", "多出来的 agentId 直接被参数校验挡掉");
});

test("deck_handoff：没有 PASEO_AGENT_ID 就失败，不拿别人的 id 顶上", async (t) => {
  const dir = await workspace(t, baseSettings);
  const previous = process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_AGENT_ID;
  t.after(() => {
    if (previous !== undefined) process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool("deck_handoff", { summary: "无名氏" }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "no-agent-id");
});

test("deck_handoff：没有 summary 就拒绝，不写空回传件", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { isError, body } = await runTool("deck_handoff", { done: ["x"] }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "invalid");
});
