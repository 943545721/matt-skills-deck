import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../server/mcp/tools.ts";
import { readIdentityGaps } from "../server/identity-presence.ts";
import { createLocalIssue, getLocalIssue, replaceLocalLabels } from "../server/tracker/local.ts";
import { listPendingWindowNotes } from "../server/window-note-store.ts";

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
  // 派单闸要读需求票的 `deck:定稿`：每个工作区先放一张 #1，测试只关心这一批任务。
  const requirement = await createLocalIssue(dir, {
    title: "需求 #1",
    body: "## 需求\n\n测试用需求。",
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(requirement.ok, true);
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
// 派单入口现在校验调用者：默认把测试当成绑定的派单窗口。要测别的身份时，用例自己设、自己还原。
process.env.PASEO_AGENT_ID = "dispatch-1";

const runToolRaw = async (name, args, workspaceDir) => {
  const tool = findTool(name);
  assert.ok(tool, `${name} 必须注册`);
  const result = await tool.run(args, { workspaceDir });
  return { isError: result.isError, body: JSON.parse(result.text), raw: result.text };
};

/**
 * 现有派单用例默认挂到 #1 需求下；「无票不给计划」那条用 `runToolRaw` 绕开这层默认值。
 */
const runTool = async (name, args, workspaceDir) => {
  const withRequirement =
    name === "deck_dispatch_plan" && args && Array.isArray(args.tasks)
      ? { ...args, tasks: args.tasks.map((task) => ({ requirementKey: 1, ...task })) }
      : args;
  return runToolRaw(name, withRequirement, workspaceDir);
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

test("deck_dispatch_plan：MCP 派单也吃卡片默认档；模型删掉后不再带", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    modelThinking: [{ provider: "claude", model: "sonnet", thinkingOptionId: "high" }],
  });
  // MCP 进程从 `<PASEO_HOME>/config.json` 读宿主配置；这份文件不在工作区里。
  const home = await mkdtemp(join(tmpdir(), "deck-mcp-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  });

  const args = { tasks: [{ key: "t1", prompt: "写单测", difficulty: "normal" }], depth: 1 };
  const first = await runTool("deck_dispatch_plan", args, dir);
  assert.equal(first.isError, false, first.raw);
  assert.equal(
    first.body.tasks[0].thinkingOptionId,
    "high",
    "MCP 派单与 RPC 派单走同一份默认档",
  );
  // 计划里算了档位，hint 还得让外部调用方知道要把它交给宿主；
  // 只写 providerSpec / labels / prompt 的话，照 hint 做的调用方会把档位丢掉。
  assert.match(first.body.hint, /config\.thinkingOptionId/, "hint 要说明把档位传给宿主 create_agent");
  assert.match(first.body.hint, /config\.modeId/, "modeId 同样要交给宿主");

  // 宿主配置里这个客户端的模型清单被清空：残留默认档不许再传出去。
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ agents: { providers: { claude: { additionalModels: [] } } } }),
    "utf8",
  );
  const second = await runTool("deck_dispatch_plan", args, dir);
  assert.equal(second.isError, false, second.raw);
  assert.equal(second.body.tasks[0].thinkingOptionId, null, "模型删掉后不再带档位");
});

test("deck_dispatch_plan：没配派单窗口时整次拒绝，并给出可执行的下一步", async (t) => {
  // 角色在、派单窗口没选：没有人有资格派单，连计划都不该出。
  const dir = await workspace(t, { ...baseSettings, roles: [{ workspaceId: "ws1", mainAgentId: "main-1" }] });
  const { isError, body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "no-dispatcher");
  assert.match(body.detail, /派单窗口/);
});

test("deck_dispatch_plan：工作区里根本没有编排文件时，入口就拒并指到面板", async (t) => {
  const dir = await workspace(t, null);
  const { isError, body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.equal(isError, true);
  // 连角色都没有：这是「没有工作区角色」，不是「没选派单窗口」。
  assert.equal(body.reason, "no-workspace");
  assert.match(body.detail, /角色绑定/);
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

test("deck_dispatch_plan：主窗口不能派单，入口直接拒并指向交接工具", async (t) => {
  const dir = await workspace(t, baseSettings);
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "main-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 0 }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "main-cannot-dispatch");
  assert.match(body.detail, /deck_handoff_to_dispatcher/);
});

test("deck_dispatch_plan：其他会话不能派单；无身份同样拒", async (t) => {
  const dir = await workspace(t, baseSettings);
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "child-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const other = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.equal(other.isError, true);
  assert.equal(other.body.reason, "caller-not-dispatcher");

  delete process.env.PASEO_AGENT_ID;
  const anonymous = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.equal(anonymous.isError, true);
  assert.equal(anonymous.body.reason, "caller-unknown");
  // 身份缺失要留下可见痕迹：面板靠它点名「这个窗口该重开」，而不是让用户只看到一次工具报错。
  const [gap] = await readIdentityGaps(dir);
  assert.equal(gap.lastTool, "deck_dispatch_plan");
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
  const [gap] = await readIdentityGaps(dir);
  assert.equal(gap.lastTool, "deck_handoff", "被拒这件事要留痕，面板才能提示缺身份的窗口");
});

test("deck_handoff：没有 summary 就拒绝，不写空回传件", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { isError, body } = await runTool("deck_handoff", { done: ["x"] }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "invalid");
});

test("deck_dispatch_plan：名册非空却没写派给谁、也没写区域 → 拒绝，不猜一个人", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [{ id: "frontend", name: "前端", duty: "只改前端" }],
      },
    ],
  });
  const { body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.equal(body.tasks.length, 0);
  assert.equal(body.rejected[0].reason, "region-required");
  assert.match(body.rejected[0].detail, /region/);
});

test("deck_dispatch_plan：不写 staff、只写 region → 归属算法选卡", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [
          { id: "frontend", name: "前端", duty: "只改前端", paths: ["web"] },
          { id: "backend", name: "后端", duty: "只改后端", paths: ["server"] },
        ],
      },
    ],
  });
  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p", region: { pathPrefix: "server/api" } }], depth: 1 },
    dir,
  );
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].staffId, "backend");
});

test("deck_dispatch_plan：显式 staff 优先于 region，不按区域改派", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [
          { id: "frontend", name: "前端", duty: "只改前端", paths: ["web"] },
          { id: "backend", name: "后端", duty: "只改后端", paths: ["server"] },
        ],
      },
    ],
  });
  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p", staff: "frontend", region: { pathPrefix: "server/api" } }], depth: 1 },
    dir,
  );
  assert.equal(body.tasks[0].staffId, "frontend");
});

test("deck_dispatch_plan：region 没有任何卡覆盖 → 拒绝，不回落", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [{ id: "frontend", name: "前端", duty: "只改前端", paths: ["web"] }],
      },
    ],
  });
  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p", region: { pathPrefix: "server/api" } }], depth: 1 },
    dir,
  );
  assert.equal(body.tasks.length, 0);
  assert.equal(body.rejected[0].reason, "region-unowned");
});

test("deck_dispatch_plan：写了名册里没有的 staff → unknown-staff", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [{ id: "frontend", name: "前端", duty: "只改前端" }],
      },
    ],
  });
  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p", staff: "ghost" }], depth: 1 },
    dir,
  );
  assert.equal(body.tasks.length, 0);
  assert.equal(body.rejected[0].reason, "unknown-staff");
});

test("deck_dispatch_plan：派到卡上时，systemPrompt 与岗位名一起给出，票面也写明岗位", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [{ id: "frontend", name: "前端", duty: "只改前端，别碰后端" }],
      },
    ],
  });
  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p", staff: "frontend" }], depth: 1 },
    dir,
  );
  const [task] = body.tasks;
  assert.equal(task.staffId, "frontend");
  assert.equal(task.staffName, "前端");
  assert.equal(task.systemPrompt, "只改前端，别碰后端");
  assert.equal(task.labels["deck.staff"], "frontend");
  assert.match(task.ticket.body, /岗位：前端/);
});

test("deck_dispatch_plan：没有名册的旧工作区，输出里不该多出字段", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  const [task] = body.tasks;
  assert.equal(task.staffId, null);
  assert.equal(task.systemPrompt, null);
  assert.equal("deck.staff" in task.labels, false);
  assert.equal(task.ticket.body.includes("岗位："), false);
});

test("deck_dispatch_plan：空名册照旧派，但计划里带一条「还没建名册」的警告", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.equal(body.tasks.length, 1);
  assert.ok(
    body.warnings.some((line) => line.includes("还没建岗位名册")),
    "空名册不拒绝，但必须说出来：否则人会以为自己在按人派活",
  );
});

test("deck_dispatch_plan：有名册时不再带那条警告", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [{ id: "frontend", name: "前端" }],
      },
    ],
  });
  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p", staff: "frontend" }], depth: 1 },
    dir,
  );
  assert.equal(body.warnings.some((line) => line.includes("还没建岗位名册")), false);
});

test("deck_dispatch_plan：票面抬头写明工作区", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { body } = await runTool("deck_dispatch_plan", { tasks: [{ key: "t1", prompt: "p" }], depth: 1 }, dir);
  assert.match(body.tasks[0].ticket.body, /- 工作区：`ws1`/);
});

test("deck_staff_request：员工要人落进与越界请求同一个收件箱", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [
          { id: "frontend", name: "前端", paths: ["web"] },
          { id: "backend", name: "后端", paths: ["server"] },
        ],
      },
    ],
  });
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "employee-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool(
    "deck_staff_request",
    {
      task: "把登录接口的验证码校验补上",
      why: "这块归后端，前端改不了",
      staff: "backend",
      region: { pathPrefix: "server/api" },
      fromStaff: "frontend",
    },
    dir,
  );
  assert.equal(isError, false);
  assert.equal(body.ok, true);
  assert.equal(body.kind, "staffing");
  assert.equal(body.state, "pending");
  assert.equal(body.toStaff, "backend");
  assert.deepEqual(body.paths, ["server/api"]);

  const lines = (await readFile(join(dir, ".deck", "coordination.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "staffing");
  assert.equal(lines[0].workspaceId, "ws1");
  assert.equal(lines[0].fromStaff, "frontend");
  assert.equal(lines[0].toStaff, "backend");
  assert.equal(lines[0].sessionAgentId, "employee-1");
  assert.equal(lines[0].taskSummary, "把登录接口的验证码校验补上");
  assert.equal(lines[0].need, "这块归后端，前端改不了");
  assert.deepEqual(lines[0].paths, ["server/api"]);
});

test("deck_staff_request：名册里没有建议的卡 → 拒绝，不写收件箱", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [{ id: "frontend", name: "前端" }],
      },
    ],
  });
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "employee-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool(
    "deck_staff_request",
    { task: "要人", why: "忙不过来", staff: "ghost" },
    dir,
  );
  assert.equal(isError, true);
  assert.equal(body.reason, "unknown-staff");
  await assert.rejects(readFile(join(dir, ".deck", "coordination.jsonl"), "utf8"), /ENOENT/);
});

test("deck_staff_request：台账说是别人，就不能拿那张卡的名义发请求", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        dispatcherAgentId: "dispatch-1",
        staff: [
          { id: "frontend", name: "前端" },
          { id: "backend", name: "后端" },
        ],
      },
    ],
  });
  await writeFile(
    join(dir, ".deck", "staff-sessions.jsonl"),
    `${JSON.stringify({ agentId: "agent-real-1", staffId: "backend" })}\n`,
    "utf8",
  );
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "agent-real-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool(
    "deck_staff_request",
    { task: "要人", why: "忙不过来", fromStaff: "frontend" },
    dir,
  );
  assert.equal(isError, true);
  assert.equal(body.reason, "unknown-staff");
  await assert.rejects(readFile(join(dir, ".deck", "coordination.jsonl"), "utf8"), /ENOENT/);
});

test("deck_staff_request：没有 PASEO_AGENT_ID 不冒充发起人", async (t) => {
  const dir = await workspace(t, baseSettings);
  const previous = process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_AGENT_ID;
  t.after(() => {
    if (previous !== undefined) process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool("deck_staff_request", { task: "要人", why: "忙不过来" }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "no-agent-id");
  const [gap] = await readIdentityGaps(dir);
  assert.equal(gap.lastTool, "deck_staff_request");
});

test("deck_staff_request：缺「为什么」被参数校验挡住", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { isError, body } = await runTool("deck_staff_request", { task: "要人" }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "invalid");
});

test("deck_dispatch_plan：任务没挂需求票 → 不给计划", async (t) => {
  const dir = await workspace(t, baseSettings);
  const { body } = await runToolRaw(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p" }], depth: 1 },
    dir,
  );
  assert.equal(body.tasks.length, 0);
  assert.equal(body.rejected[0].reason, "no-requirement");
  assert.match(body.rejected[0].detail, /无票不干活/);
});

test("deck_dispatch_plan：需求没打 deck:定稿 → 不给计划", async (t) => {
  const dir = await workspace(t, baseSettings);
  await replaceLocalLabels(dir, 1, ["requirement"]);
  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p" }], depth: 1 },
    dir,
  );
  assert.equal(body.tasks.length, 0);
  assert.equal(body.rejected[0].reason, "requirement-not-finalized");
  assert.match(body.rejected[0].detail, /定稿/);
});

test("deck_dispatch_plan：员工卡调用在计划阶段就被拒，并指向 deck_staff_request", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [{
      workspaceId: "ws1",
      mainAgentId: "main-1",
      dispatcherAgentId: "dispatch-1",
      staff: [{ id: "frontend", name: "前端", kind: "worker" }],
    }],
  });
  // 真实宿主里 `PASEO_AGENT_ID` 是会话 id，不是卡 id；靠 agent.created 写的台账反查。
  await writeFile(
    join(dir, ".deck", "staff-sessions.jsonl"),
    `${JSON.stringify({ agentId: "agent-real-1", staffId: "frontend" })}\n`,
    "utf8",
  );
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "agent-real-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { isError, body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p" }], depth: 1 },
    dir,
  );
  assert.equal(isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "staff-cannot-dispatch");
  assert.match(body.detail, /deck_staff_request/);
});

test("deck_dispatch_plan：没有岗位台账的派单窗口按非员工放行，不误杀", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [{
      workspaceId: "ws1",
      mainAgentId: "main-1",
      dispatcherAgentId: "dispatch-1",
      staff: [{ id: "frontend", name: "前端", kind: "worker" }],
    }],
  });
  const previous = process.env.PASEO_AGENT_ID;
  // 绑定派单窗口本人，但台账里没有它的岗位记录：不能因为查不到卡就当成员工拦掉。
  process.env.PASEO_AGENT_ID = "dispatch-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  const { body } = await runTool(
    "deck_dispatch_plan",
    { tasks: [{ key: "t1", prompt: "p", staff: "frontend" }], depth: 1 },
    dir,
  );
  assert.equal(body.ok, true);
  assert.equal(body.tasks.length, 1);
});

const staffSettings = {
  ...baseSettings,
  roles: [{
    workspaceId: "ws1",
    mainAgentId: "main-1",
    dispatcherAgentId: "dispatch-1",
    staff: [{ id: "frontend", name: "前端", kind: "worker", paths: ["."] }],
  }],
};

test("deck_requirement_dispatch：默认只回清单，一个字节都不写", async (t) => {
  const dir = await workspace(t, staffSettings);
  const { isError, body } = await runToolRaw("deck_requirement_dispatch", { requirementNumber: 1 }, dir);
  assert.equal(isError, false);
  assert.equal(body.ok, true);
  assert.equal(body.requiresConfirmation, true);
  assert.equal(body.created, false);
  assert.equal(body.execution, "list");
  assert.equal(body.summary.length, 1);
  assert.equal(body.summary[0].workspaceId, "ws1");
  assert.equal(body.summary[0].staffId, "frontend");
  assert.equal(body.summary[0].provider, "claude");
  assert.equal(body.summary[0].sessions, 1);
  // 需求本身是 #1；计划阶段不该多出 #2。
  assert.equal((await getLocalIssue(dir, 2)).ok, false);
});

test("deck_requirement_dispatch：主窗口不能拆需求，入口直接拒", async (t) => {
  const dir = await workspace(t, staffSettings);
  const previous = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "main-1";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });
  const { isError, body } = await runToolRaw("deck_requirement_dispatch", { requirementNumber: 1 }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "main-cannot-dispatch");

  delete process.env.PASEO_AGENT_ID;
  const anonymous = await runToolRaw("deck_requirement_dispatch", { requirementNumber: 1 }, dir);
  assert.equal(anonymous.isError, true);
  assert.equal(anonymous.body.reason, "caller-unknown");
  const [gap] = await readIdentityGaps(dir);
  assert.equal(gap.lastTool, "deck_requirement_dispatch");
});

test("deck_requirement_dispatch：需求没定稿 → 拒绝，也不写票", async (t) => {
  const dir = await workspace(t, staffSettings);
  await replaceLocalLabels(dir, 1, ["requirement"]);
  const { isError, body } = await runToolRaw("deck_requirement_dispatch", { requirementNumber: 1 }, dir);
  assert.equal(isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "not-finalized");
  assert.equal((await getLocalIssue(dir, 2)).ok, false);
});

test("deck_requirement_dispatch：影响面表写坏 → 拒绝，并把原因自动递给需求窗口", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      { workspaceId: "ws1", mainAgentId: "main-1", requirementAgentId: "requirement-1", dispatcherAgentId: "dispatch-1" },
    ],
  });
  const broken = await createLocalIssue(dir, {
    title: "需求：影响面写坏",
    body: [
      "## 影响面",
      "| 区 / 仓库 | 仓库 | 依据 | 结论 | 核验人 |",
      "|---|---|---|---|---|",
      "| kxhyapp.com | acme/deck | 需求票本身 | 要动 | 单区，免核 |",
    ].join("\n"),
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(broken.ok, true);

  const { isError, body } = await runToolRaw("deck_requirement_dispatch", { requirementNumber: broken.number }, dir);
  assert.equal(isError, true);
  assert.equal(body.reason, "bad-impact");
  assert.match(body.detail, /窗口条子放进队列/);
  assert.doesNotMatch(body.detail, /已递给需求窗口/, "只排队不等于已送达");

  const notes = await listPendingWindowNotes(dir);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].toRole, "requirement");
  assert.equal(notes[0].requirementKey, broken.number);
  assert.equal(notes[0].reason, "bad-impact");

  // 同一个错再试一次：条子不重复递，用户不会被同一句话刷屏。
  const again = await runToolRaw("deck_requirement_dispatch", { requirementNumber: broken.number }, dir);
  assert.equal(again.isError, true);
  assert.match(again.body.detail, /已经排进条子队列/);
  assert.equal((await listPendingWindowNotes(dir)).length, 1);
});

test("需求票写闸：只有绑定的需求窗口能建 / 改需求票，它也不碰工作票", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      { workspaceId: "ws1", mainAgentId: "main-1", requirementAgentId: "requirement-1", dispatcherAgentId: "dispatch-1" },
    ],
  });
  const previous = process.env.PASEO_AGENT_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });

  // 主窗口建需求票：拒；建工作票：也拒。
  process.env.PASEO_AGENT_ID = "main-1";
  const denied = await runToolRaw("deck_issue_create", { title: "主窗口建的需求", labels: ["requirement"] }, dir);
  assert.equal(denied.isError, true);
  assert.equal(denied.body.reason, "requirement-window-only");
  const mainWork = await runToolRaw("deck_issue_create", { title: "主窗口建的工作票", requirementKey: 1 }, dir);
  assert.equal(mainWork.isError, true);
  assert.equal(mainWork.body.reason, "main-cannot-create-tickets");

  // 需求窗口建需求票：放行。
  process.env.PASEO_AGENT_ID = "requirement-1";
  const created = await runToolRaw("deck_issue_create", { title: "需求窗口建的需求", labels: ["requirement"] }, dir);
  assert.equal(created.isError, false, created.raw);
  const requirementNumber = created.body.number;

  // 需求窗口建工作票：拒。
  const work = await runToolRaw("deck_issue_create", { title: "需求窗口建的工作票", requirementKey: 1 }, dir);
  assert.equal(work.isError, true);
  assert.equal(work.body.reason, "requirement-cannot-write-work");

  // 派单窗口建工作票：放行；改需求票：拒。
  process.env.PASEO_AGENT_ID = "dispatch-1";
  const workTicket = await runToolRaw("deck_issue_create", { title: "派单窗口建的工作票", requirementKey: 1 }, dir);
  assert.equal(workTicket.isError, false, workTicket.raw);
  const patchByDispatcher = await runToolRaw("deck_issue_patch", { number: requirementNumber, title: "派单窗口改需求" }, dir);
  assert.equal(patchByDispatcher.isError, true);
  assert.equal(patchByDispatcher.body.reason, "requirement-window-only");
  const relabelByDispatcher = await runToolRaw(
    "deck_issue_labels",
    { number: requirementNumber, labels: ["requirement", "area:server"] },
    dir,
  );
  assert.equal(relabelByDispatcher.isError, true);
  assert.equal(relabelByDispatcher.body.reason, "requirement-window-only");
  // 给工作票加 requirement 标签：写入后变成需求票，同样拒。
  const escalate = await runToolRaw(
    "deck_issue_patch",
    { number: workTicket.body.number, addLabels: ["requirement"] },
    dir,
  );
  assert.equal(escalate.isError, true);
  assert.equal(escalate.body.reason, "requirement-window-only");
  const escalateLabels = await runToolRaw(
    "deck_issue_labels",
    { number: workTicket.body.number, labels: ["requirement"] },
    dir,
  );
  assert.equal(escalateLabels.isError, true);
  assert.equal(escalateLabels.body.reason, "requirement-window-only");

  // 需求窗口改需求票：放行；改工作票：拒。
  process.env.PASEO_AGENT_ID = "requirement-1";
  const allowed = await runToolRaw("deck_issue_patch", { number: requirementNumber, title: "需求票新标题" }, dir);
  assert.equal(allowed.isError, false, allowed.raw);
  const workPatch = await runToolRaw("deck_issue_patch", { number: workTicket.body.number, title: "需求窗口改工作票" }, dir);
  assert.equal(workPatch.isError, true);
  assert.equal(workPatch.body.reason, "requirement-cannot-write-work");
  const relabelWork = await runToolRaw(
    "deck_issue_labels",
    { number: workTicket.body.number, labels: ["requirement"] },
    dir,
  );
  assert.equal(relabelWork.isError, true);
  assert.equal(relabelWork.body.reason, "requirement-cannot-write-work");
  // 把自己的需求票删成工作票：也拒。
  const stripRequirement = await runToolRaw(
    "deck_issue_patch",
    { number: requirementNumber, removeLabels: ["requirement"] },
    dir,
  );
  assert.equal(stripRequirement.isError, true);
  assert.equal(stripRequirement.body.reason, "requirement-cannot-write-work");
});

test("需求票写闸：建地图也过同一道闸，主 / 需求 / 进度窗口建不了", async (t) => {
  const dir = await workspace(t, {
    ...baseSettings,
    roles: [
      {
        workspaceId: "ws1",
        mainAgentId: "main-1",
        requirementAgentId: "requirement-1",
        dispatcherAgentId: "dispatch-1",
        progressAgentId: "progress-1",
      },
    ],
  });
  const previous = process.env.PASEO_AGENT_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previous;
  });
  const plan = { title: "地图", destination: "跑通地图", tickets: [{ title: "第一张", kind: "task" }] };

  // 主窗口 / 进度窗口不建票：地图与路线票也不行，不能从第二条建票入口绕过去。
  process.env.PASEO_AGENT_ID = "main-1";
  const mainPlan = await runToolRaw("deck_map_plan_create", plan, dir);
  assert.equal(mainPlan.isError, true);
  assert.equal(mainPlan.body.reason, "main-cannot-create-tickets");
  process.env.PASEO_AGENT_ID = "progress-1";
  const progressPlan = await runToolRaw("deck_map_plan_create", plan, dir);
  assert.equal(progressPlan.isError, true);
  assert.equal(progressPlan.body.reason, "progress-cannot-create-tickets");

  // 需求窗口只建需求票：地图票与路线票都算工作票。
  process.env.PASEO_AGENT_ID = "requirement-1";
  const requirementPlan = await runToolRaw("deck_map_plan_create", plan, dir);
  assert.equal(requirementPlan.isError, true);
  assert.equal(requirementPlan.body.reason, "requirement-cannot-write-work");

  // 派单窗口建地图：放行（没有被这道闸误伤）。
  process.env.PASEO_AGENT_ID = "dispatch-1";
  const dispatcherPlan = await runToolRaw("deck_map_plan_create", plan, dir);
  assert.equal(dispatcherPlan.isError, false, dispatcherPlan.raw);
  assert.equal(dispatcherPlan.body.tickets.length, 1);
});
