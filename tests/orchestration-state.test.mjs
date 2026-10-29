import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrchestrationState } from "../server/orchestration.ts";

/**
 * 编排页的数据来源：`deck.orchestration.state` 背后的组装逻辑。
 *
 * 这一层最容易出的两种错都在这里钉住：
 * 1. env 明文漏到线上（只许掩码出门）；
 * 2. 「这档没配路由」被静默算成「已经配好了」——所以 routeFrom 必须如实出现在行上。
 */

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "deck-orch-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  return dir;
}

const settings = (patch = {}) => ({
  version: 1,
  updatedAt: "2026-10-29T00:00:00.000Z",
  workspaceId: "ws1",
  roles: [{ workspaceId: "ws1", mainAgentId: "main-1", dispatcherAgentId: "dispatch-1" }],
  routing: [
    { difficulty: "normal", target: { provider: "claude", model: "sonnet" } },
  ],
  maxDepth: 3,
  maxChildrenPerDispatch: 4,
  reportOnFinish: true,
  ...patch,
});

/**
 * 宿主的**线上**形状：`config.get().config` 把档案与 providers 摊在根级
 * （磁盘上的 `config.json` 才是 `daemon.agentProfiles` / `agents.providers`）。
 * 这份 fake 故意用线上形状，读代码若只认磁盘形状，下面的用例会当场变空。
 */
function fakePaseo(overrides = {}) {
  return {
    config: {
      get: async () => ({
        config: {
          agentProfiles: [
            { id: "daily", name: "日常", provider: "claude", model: "sonnet", icon: "☀️", color: "#ff0" },
          ],
          providers: {
            claude: {
              env: { ANTHROPIC_API_KEY: "sk-ant-very-secret-value-1234", ANTHROPIC_BASE_URL: "https://example.test" },
              additionalModels: [{ id: "haiku-x", label: "Haiku X" }],
              enabled: true,
            },
          },
        },
      }),
    },
    providers: {
      snapshot: async () => ({
        entries: [{ provider: "claude", label: "Claude", enabled: true, status: "ready", models: [{ id: "sonnet" }, { id: "opus" }] }],
      }),
    },
    agents: {
      list: async () => ({
        entries: [
          { agent: { id: "main-1", workspaceId: "ws1", cwd: "/w", title: "主沟通", provider: "claude", model: "sonnet", status: "idle", labels: {} } },
          {
            agent: {
              id: "dispatch-1",
              workspaceId: "ws1",
              cwd: "/w",
              title: "派单窗口",
              provider: "claude",
              model: "sonnet",
              status: "idle",
              labels: {},
            },
          },
          {
            agent: {
              id: "child-1",
              workspaceId: "ws1",
              cwd: "/w",
              title: "子任务",
              provider: "codex",
              model: "gpt-5",
              status: "working",
              labels: { "paseo.parent-agent-id": "dispatch-1", "deck.difficulty": "hard" },
            },
          },
        ],
      }),
    },
    ...overrides,
  };
}

test("编排状态：数据来自根级 providers / agentProfiles（线上形状）", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.equal(state.profiles.length, 1);
  const claude = state.providers.find((row) => row.id === "claude");
  assert.ok(claude);
  assert.deepEqual(claude.configModels, ["haiku-x"]);
  assert.equal(claude.modelsKey, "additionalModels");
  assert.equal(claude.env.length, 2, "注入的键必须读得出来");
});

test("编排状态：磁盘形状（daemon.agentProfiles / agents.providers）也认，换版本不至于显示为空", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const disk = fakePaseo({
    config: {
      get: async () => ({
        config: {
          daemon: { agentProfiles: [{ id: "daily", name: "日常", provider: "claude" }] },
          agents: { providers: { claude: { env: { ANTHROPIC_API_KEY: "sk-ant-123456789" } } } },
        },
      }),
    },
  });
  const state = await readOrchestrationState(disk, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.equal(state.profiles.length, 1);
  assert.equal(state.providers.find((row) => row.id === "claude")?.env.length, 1);
});

test("编排状态：读到了配置但两处都空时明确告警，不让用户以为注入丢了", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const empty = fakePaseo({ config: { get: async () => ({ config: {} }) } });
  const state = await readOrchestrationState(empty, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.ok(state.warnings.some((line) => line.includes("既没有客户端档案也没有 providers")));
});

test("编排状态：env 只出掩码，短值也不还原", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  const claude = state.providers.find((provider) => provider.id === "claude");
  assert.ok(claude);
  const key = claude.env.find((item) => item.key === "ANTHROPIC_API_KEY");
  assert.equal(key.hasValue, true);
  assert.equal(key.masked, true);
  assert.match(key.display, /^••••/);
  assert.doesNotMatch(key.display, /very-secret/);
  // base url 也走同一套掩码，不因为「不是 key」就明文放行
  const base = claude.env.find((item) => item.key === "ANTHROPIC_BASE_URL");
  assert.equal(base.masked, true);
  assert.doesNotMatch(base.display, /example\.test/);
  assert.deepEqual(claude.configModels, ["haiku-x"]);
  assert.deepEqual(claude.models, ["sonnet", "opus"]);
});

test("编排状态：没配的难度行必须带 routeFrom，并进 warnings", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  const byDifficulty = Object.fromEntries(state.routing.map((row) => [row.difficulty, row]));
  assert.equal(byDifficulty.normal.routeFrom, undefined);
  assert.equal(byDifficulty.hard.routeFrom, "normal");
  // critical 也没有单独配置，同样借 normal
  assert.equal(byDifficulty.critical.routeFrom, "normal");
  assert.ok(state.warnings.some((line) => line.includes("hard") && line.includes("借用")));
});

test("编排状态：一档路由都没有时，四档都标 default 且明说用内置默认目标", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings({ routing: [] })), "utf8");
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  for (const row of state.routing) {
    assert.equal(row.routeFrom, "default");
    assert.equal(row.resolved.ok, true, "内置默认目标必须能解析出客户端");
  }
  assert.ok(state.warnings.some((line) => line.includes("内置默认目标")));
});

test("编排状态：会话树按父会话串起来，子会话带难度与票号", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  const root = state.tree.find((node) => node.agentId === "dispatch-1");
  assert.ok(root, "派单窗口应该是树根");
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].agentId, "child-1");
  assert.equal(root.children[0].difficulty, "hard");
});

test("编排状态：没指定派单窗口时照样返回数据，但明说派单会被拒绝", async (t) => {
  const dir = await workspace(t);
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify(settings({ roles: [{ workspaceId: "ws1", mainAgentId: "main-1" }] })),
    "utf8",
  );
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.ok(state.warnings.some((line) => line.includes("还没有指定派单窗口")));
});

test("编排状态：会话列表读失败明确报 agents-failed，不返回半块空树", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const paseo = fakePaseo({ agents: { list: async () => { throw new Error("daemon 掉线"); } } });
  const state = await readOrchestrationState(paseo, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, false);
  assert.equal(state.reason, "agents-failed");
  assert.match(state.detail, /daemon 掉线/);
});

test("编排状态：客户端目录读失败只是警告，不挡住角色与路由", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const paseo = fakePaseo({ providers: { snapshot: async () => { throw new Error("provider 目录坏了"); } } });
  const state = await readOrchestrationState(paseo, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.deepEqual(state.providers, []);
  assert.ok(state.warnings.some((line) => line.includes("客户端目录读取失败")));
});

test("编排状态：空工作区参数直接拒绝", async () => {
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "  ", workspaceDir: "/w" });
  assert.equal(state.ok, false);
  assert.equal(state.reason, "invalid-workspace");
});
