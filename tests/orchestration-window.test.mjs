import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { orchestrationWindowRpc } from "../shared/orchestration-rpc.ts";
import { DEFAULT_ROLE_PROMPTS } from "../shared/orchestration.ts";
import { orchestrationWindowHandler } from "../server/rpc/orchestration.ts";
import { orchestrationFileOf, readOrchestration, writeOrchestration } from "../server/orchestration-store.ts";

/**
 * 「按角色建固定窗口」的执行层（`deck.orchestration.window`）。
 *
 * 这里最容易错的有三处，各用一条用例钉住：
 * - 建窗口**不带首条 prompt**（窗口停在 idle，等用户开口）；
 * - `recreate` 缺省为假，不能顺手把用户原来的窗口归档掉；
 * - 槽位写回只能改对应那一个，别的槽位与用户改过的提示词都得留着。
 */

const WS = "ws-1";

const ROUTING = [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }];

function settingsWith(roleOverrides = {}) {
  return {
    roles: [
      {
        workspaceId: WS,
        mainAgentId: "old-main",
        dispatcherAgentId: "old-dispatcher",
        prompts: { main: "只谈方案" },
        ...roleOverrides,
      },
    ],
    routing: ROUTING,
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  };
}

async function workspaceWith(settings) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-window-"));
  const written = await writeOrchestration(dir, settings, { workspaceId: WS });
  assert.equal(written.ok, true);
  return dir;
}

/** 只够跑通建窗口的假宿主：配置可读、建会话可注入结果、旧会话可归档。 */
function fakePaseo({ id = "agent-new", snapshots = [], createError, archiveError, onCreate } = {}) {
  const created = [];
  const archived = [];
  /** 会话落进哪条工作区：窗口必须走句柄，否则宿主会按目录再登记一条同名工作区。 */
  const createdIn = [];
  /** 谁先谁后：重建时「先建新的、再归档旧的」靠它钉住。 */
  const order = [];
  const create = async (options) => {
    order.push("create");
    created.push(options);
    for (const snapshot of snapshots) options.onEvent?.(snapshot);
    if (createError) throw createError;
    await onCreate?.();
    return { id };
  };
  const paseo = {
    config: { get: async () => ({ config: {} }) },
    agents: {
      create,
      ref: (agentId) => ({
        archive: async () => {
          order.push("archive");
          archived.push(agentId);
          if (archiveError) throw archiveError;
          return { archivedAt: new Date().toISOString() };
        },
      }),
    },
    workspaces: {
      ref: (workspaceId) => ({
        id: workspaceId,
        agents: {
          create: async (options) => {
            createdIn.push(workspaceId);
            return create(options);
          },
        },
      }),
    },
  };
  return { paseo, created, createdIn, archived, order };
}

const contextOf = (paseo) => ({ paseo });

test("窗口契约：role 只认 main / dispatcher / progress", () => {
  for (const role of ["main", "dispatcher", "progress"]) {
    const parsed = orchestrationWindowRpc.input.safeParse({ workspaceDir: "/repo", workspaceId: WS, role });
    assert.equal(parsed.success, true, `${role} 应该被接受`);
  }
  for (const role of ["Main", "worker", "dispatch", "", "main "]) {
    const parsed = orchestrationWindowRpc.input.safeParse({ workspaceDir: "/repo", workspaceId: WS, role });
    assert.equal(parsed.success, false, `${JSON.stringify(role)} 不该被接受`);
  }
});

test("建窗口：跟 normal 档路由走，带身份提示词，但不传首条 prompt", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo();
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, true);
  assert.equal(result.agentId, "agent-new");
  assert.equal(result.title, "主窗口");
  assert.equal(result.previousAgentId, "old-main");

  assert.equal(fake.created.length, 1);
  const options = fake.created[0];
  // 目录由工作区句柄带来，不再塞进 options：带 cwd 的裸创建会让宿主按目录再开一条工作区。
  assert.deepEqual(fake.createdIn, [WS], "窗口落进传进来的那条工作区");
  assert.equal(options.cwd, undefined, "句柄路径不再传 cwd");
  assert.equal(options.config.provider, "claude/sonnet", "客户端/模型取 normal 档路由");
  assert.equal(options.config.systemPrompt, "只谈方案", "用户改过的身份提示词优先");
  assert.equal(options.title, "主窗口");
  assert.deepEqual(options.labels, { "deck.role": "main", "deck.role.window": "1" });
  assert.equal(options.prompt, undefined, "窗口建出来停在 idle，不带首条提示词");
  assert.equal(options.parent, undefined, "固定窗口不挂父会话");
});

test("建窗口：用户没改过提示词时回落到该语言的默认值", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo();
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "dispatcher", lang: "en" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, true);
  assert.equal(result.title, "派单窗口", "标题固定中文，只有提示词跟语言");
  assert.equal(fake.created[0].config.systemPrompt, DEFAULT_ROLE_PROMPTS.dispatcher.en);
});

test("建窗口：recreate 缺省为假，不归档旧会话", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo();
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, true);
  assert.equal(result.previousAgentId, "old-main");
  assert.deepEqual(fake.archived, [], "没说要重建就不该归档任何会话");
});

test("建窗口：recreate=true 先建好新的，再归档旧的", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo({ id: "agent-rebuilt" });
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main", recreate: true },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fake.order, ["create", "archive"], "建成功之前不能动旧窗口");
  assert.deepEqual(fake.archived, ["old-main"]);
  assert.equal(result.agentId, "agent-rebuilt");
  assert.equal(result.previousAgentId, "old-main");
  assert.equal(fake.created.length, 1);
});

test("建窗口：成功后只写回对应槽位，其它槽位与提示词都留着", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo({ id: "agent-progress" });
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "progress" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, true);
  const stored = await readOrchestration(dir);
  const role = stored.settings.roles.find((item) => item.workspaceId === WS);
  assert.equal(role.progressAgentId, "agent-progress");
  assert.equal(role.mainAgentId, "old-main", "别的槽位不能被顺手清掉");
  assert.equal(role.dispatcherAgentId, "old-dispatcher");
  assert.equal(role.prompts.main, "只谈方案", "用户改过的提示词不能被抹掉");
});

test("建窗口：归档失败只记警告，不阻断新建", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo({ id: "agent-fresh", archiveError: new Error("agent not found") });
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main", recreate: true },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, true, "归档失败不能把「新窗口已建好」说成失败");
  assert.equal(result.agentId, "agent-fresh");
  assert.equal(fake.created.length, 1);

  const stored = await readOrchestration(dir);
  const role = stored.settings.roles.find((item) => item.workspaceId === WS);
  assert.equal(role.mainAgentId, "agent-fresh", "归档失败也照样写回新槽位");
});

test("建窗口：宿主拒绝无提示词的创建时报 create-failed，不偷偷补一句", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo({ createError: new Error("prompt is required") });
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-failed");
  assert.match(result.detail, /prompt is required/);
  assert.equal(fake.created[0].prompt, undefined, "失败路径也不能补提示词");
});

test("重建时新建失败：旧窗口原样留着，不能把用户唯一的窗口一起弄没", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo({ createError: new Error("provider down") });
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main", recreate: true },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "create-failed");
  assert.deepEqual(fake.archived, [], "新窗口没建出来就不该归档旧的");
  const stored = await readOrchestration(dir);
  const role = stored.settings.roles.find((item) => item.workspaceId === WS);
  assert.equal(role.mainAgentId, "old-main", "槽位也还指向旧窗口");
});

test("建窗口：宿主用 failed 快照拒绝时不能报成功，槽位也不写", async () => {
  const dir = await workspaceWith(settingsWith());
  const fake = fakePaseo({
    id: "agent-bad",
    snapshots: [{ phase: "failed", agentId: "agent-bad", error: "prompt is required" }],
  });
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, false, "失败快照不能当成建窗成功");
  assert.equal(result.reason, "create-failed");
  assert.match(result.detail, /prompt is required/);

  const stored = await readOrchestration(dir);
  const role = stored.settings.roles.find((item) => item.workspaceId === WS);
  assert.equal(role.mainAgentId, "old-main", "失败的窗口不能写进槽位");
});

test("建窗口：编排文件坏了时报 settings-corrupt，不拿默认值建窗口", async () => {
  const dir = await workspaceWith(settingsWith());
  await writeFile(orchestrationFileOf(dir), "{ 坏掉的 json", "utf8");
  const fake = fakePaseo();
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "settings-corrupt");
  assert.equal(fake.created.length, 0);
});

test("建窗口：编排文件读不出来时报 settings-unreadable，不拿默认值建窗口", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-window-unreadable-"));
  // 把编排文件做成目录：readFile 报 EISDIR，走「读失败」而不是「没配过」。
  await mkdir(path.join(dir, ".deck", "orchestration.json"), { recursive: true });
  const fake = fakePaseo();
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "settings-unreadable");
  assert.equal(fake.created.length, 0);
});

test("建窗口：新窗口建好但槽位写不回去时报 write-failed，detail 带新 id", async () => {
  const dir = await workspaceWith(settingsWith());
  const file = orchestrationFileOf(dir);
  const fake = fakePaseo({
    onCreate: async () => {
      // 建会话成功后把目标路径换成目录：写入的 rename 会失败。
      await rm(file);
      await mkdir(file);
    },
  });
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "write-failed");
  assert.match(result.detail, /agent-new/, "新会话是真的建出来了，要让人能找回它");
});

test("建窗口：workspaceId 或目录为空时报 invalid-workspace", async () => {
  const fake = fakePaseo();
  for (const input of [
    { workspaceDir: "   ", workspaceId: WS, role: "main" },
    { workspaceDir: "/repo", workspaceId: "  ", role: "main" },
  ]) {
    const result = await orchestrationWindowHandler(input, contextOf(fake.paseo));
    assert.equal(result.reason, "invalid-workspace");
  }
  assert.equal(fake.created.length, 0);
});

test("建窗口：normal 档路由坏掉时报 route-unavailable，一个会话都不建", async () => {
  const dir = await workspaceWith({
    ...settingsWith(),
    routing: [{ difficulty: "normal", profileId: "deleted-profile" }],
  });
  const fake = fakePaseo();
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main" },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "route-unavailable");
  assert.equal(fake.created.length, 0);
});

test("建窗口：路由只写了客户端没写模型时，建会话之前就拦住", async () => {
  // 这就是那条「Expected config.provider in "provider/model" format」：宿主在建会话
  // 那一刻才拒绝，而重建已经把旧窗口处理过了。现在必须在动任何窗口之前报出来。
  const dir = await workspaceWith({
    ...settingsWith(),
    routing: [{ difficulty: "normal", target: { provider: "claude" } }],
  });
  const fake = fakePaseo();
  const result = await orchestrationWindowHandler(
    { workspaceDir: dir, workspaceId: WS, role: "main", recreate: true },
    contextOf(fake.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "route-unavailable");
  assert.match(result.detail, /模型/);
  assert.equal(fake.created.length, 0);
  assert.deepEqual(fake.archived, [], "报错时旧窗口必须还在");
});
