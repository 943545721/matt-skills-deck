import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrchestrationState } from "../server/orchestration.ts";
import { isListedClient, isSupportedClient, SUPPORTED_CLIENTS, SUPPORTED_CLIENTS_LABEL } from "../shared/orchestration.ts";

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

test("编排状态：Codex 站点启用后，codex 那一行显示派生条目的地址，且不把派生条目单列、不漏出 extends", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const withSite = fakePaseo({
    config: {
      get: async () => ({
        config: {
          providers: {
            codex: { models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }] },
            "deck-codex": {
              extends: "codex",
              label: "Deck Codex",
              enabled: true,
              env: { OPENAI_BASE_URL: "https://api.example.test/v1", OPENAI_API_KEY: "cred-x" },
            },
          },
        },
      }),
    },
    providers: {
      snapshot: async () => ({
        entries: [
          { provider: "codex", label: "Codex", enabled: true, status: "ready", models: [{ id: "gpt-5-codex" }] },
          { provider: "deck-codex", label: "Deck Codex", enabled: true, status: "ready", models: [{ id: "gpt-5-codex" }] },
        ],
      }),
    },
  });
  const state = await readOrchestrationState(withSite, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.deepEqual(
    state.providers.map((row) => row.id),
    ["codex"],
    "派生 provider 是插件的实现细节，不能让人以为多了一家客户端",
  );
  const codex = state.providers[0];
  assert.equal(codex.baseUrl, "https://api.example.test/v1", "界面要显示真正生效的那份地址");
  assert.equal(codex.extends, null, "「基于 codex」不该印在 codex 自己身上");
  assert.equal(codex.label, "Codex", "显示名还是宿主快照里的内建名字");
});

test("客户端列表：只列插件能注入的两家，其余家不出现", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const many = fakePaseo({
    providers: {
      snapshot: async () => ({
        entries: [
          { provider: "claude", label: "Claude", enabled: true, status: "ready", models: [{ id: "sonnet" }] },
          { provider: "codex", label: "Codex", enabled: true, status: "ready", models: [{ id: "gpt-5-codex" }] },
          // OpenCode 只有前缀约定、没有实证：同样不算支持，不列。
          { provider: "opencode", label: "OpenCode", enabled: true, status: "ready", models: [{ id: "gpt-5" }] },
          // 宿主会把装了没装的客户端都报出来：插件注不进去的家不该出现在列表里。
          { provider: "cursor", label: "Cursor", enabled: true, status: "ready", models: [] },
          { provider: "copilot", label: "Copilot", enabled: false, status: "missing", models: [] },
          { provider: "pi", label: "Pi", enabled: false, status: "missing", models: [] },
        ],
      }),
    },
  });
  const state = await readOrchestrationState(many, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.deepEqual(state.providers.map((row) => row.id), ["claude", "codex"]);
  // 支持范围本身也钉住：改动这个常量等于改界面口径，得有意识地改。
  assert.deepEqual([...SUPPORTED_CLIENTS], ["claude", "codex"]);
  assert.equal(isSupportedClient(" Claude "), true);
  assert.equal(isSupportedClient("cursor"), false);
  assert.equal(isSupportedClient("opencode"), false, "只有前缀约定、没有实证，不算支持");
  assert.equal(isSupportedClient(""), false);
  // 派生 provider 不算一家客户端：列表与模型选择器都是这个判断。
  assert.equal(isListedClient("deck-codex"), false);
  assert.equal(isListedClient(" Codex "), true);
  assert.equal(SUPPORTED_CLIENTS_LABEL, "Claude / Codex", "告警里印的写法要和客户端页一致");
  // 不逐家报「XX 已隐藏」：七八家都报会让页面顶部常驻噪音，口径写在客户端页的说明行里。
  assert.equal(state.warnings.some((line) => line.includes("已隐藏")), false);
});

test("站点表：隐藏的客户端下存着站点时说明站点不会生效，不误报「宿主里没有」", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const home = await mkdtemp(join(tmpdir(), "deck-orch-home-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, "matt-skills-deck"), { recursive: true });
  await writeFile(
    join(home, "matt-skills-deck", "sites.json"),
    JSON.stringify({
      version: 1,
      providers: {
        cursor: [{ id: "legacy", baseUrl: "https://cursor.example.test/v1" }],
        pi: [{ id: "gone", baseUrl: "https://pi.example.test/v1" }],
      },
    }),
    "utf8",
  );
  // 宿主报出 cursor，但没报 pi：两种「不显示」的下一步不一样，得分开说。
  const paseo = fakePaseo({
    providers: {
      snapshot: async () => ({
        entries: [{ provider: "cursor", label: "Cursor", enabled: true, status: "ready", models: [] }],
      }),
    },
  });
  const state = await readOrchestrationState(paseo, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.deepEqual(state.providers, []);
  const hiddenSite = state.warnings.find((line) => line.includes("cursor") && line.includes("条站点"));
  assert.ok(hiddenSite, "隐藏的客户端下存着站点要说出来");
  assert.match(hiddenSite, /插件不支持它/);
  assert.doesNotMatch(hiddenSite, /宿主里没有这个客户端/);
  assert.ok(state.warnings.some((line) => line.includes("pi") && line.includes("宿主里没有这个客户端")));
});

test("客户端列表：宿主报的全是不支持的家时，空列表要说清原因，不能让人去查装好的客户端", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const paseo = fakePaseo({
    providers: {
      snapshot: async () => ({
        entries: [
          { provider: "cursor", label: "Cursor", enabled: true, status: "ready", models: [] },
          { provider: "copilot", label: "Copilot", enabled: false, status: "missing", models: [] },
        ],
      }),
    },
  });
  const state = await readOrchestrationState(paseo, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  assert.deepEqual(state.providers, []);
  const line = state.warnings.find((warning) => warning.includes("没有一家在插件支持范围内"));
  assert.ok(line, "空列表必须说清是「都不支持」而不是「宿主没报」");
  assert.match(line, /cursor/);
  assert.match(line, /copilot/);
});

test("站点表：宿主报的 id 大小写不统一、站点挂在派生 provider 下时，告警各说各的", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings()), "utf8");
  const home = await mkdtemp(join(tmpdir(), "deck-orch-home-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, "matt-skills-deck"), { recursive: true });
  await writeFile(
    join(home, "matt-skills-deck", "sites.json"),
    JSON.stringify({
      version: 1,
      providers: {
        // 宿主那条报的是 `Cursor`，站点表的键是小写：不能被当成「宿主里没有」。
        cursor: [{ id: "legacy", baseUrl: "https://cursor.example.test/v1" }],
        // 派生 provider 不是独立客户端：挂在它下面的站点同样得说清为什么不读。
        "deck-codex": [{ id: "old", baseUrl: "https://api.example.test/v1" }],
      },
    }),
    "utf8",
  );
  const paseo = fakePaseo({
    providers: {
      snapshot: async () => ({
        entries: [{ provider: "Cursor", label: "Cursor", enabled: true, status: "ready", models: [] }],
      }),
    },
  });
  const state = await readOrchestrationState(paseo, { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  const hiddenSite = state.warnings.find((line) => line.includes("cursor") && line.includes("条站点"));
  assert.ok(hiddenSite, "隐藏的客户端下存着站点要说出来");
  assert.match(hiddenSite, /插件不支持它/);
  assert.doesNotMatch(hiddenSite, /宿主里没有这个客户端/);
  const derivedSite = state.warnings.find((line) => line.includes("deck-codex"));
  assert.ok(derivedSite, "派生 provider 下的站点也要说");
  assert.match(derivedSite, /按 codex 读/);
  assert.doesNotMatch(derivedSite, /插件不支持它/);
});

test("路由指向插件不支持的客户端时明确告警：会话建得出来，但注入不了", async (t) => {
  const dir = await workspace(t);
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify(settings({ routing: [{ difficulty: "normal", target: { provider: "cursor", model: "composer" } }] })),
    "utf8",
  );
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  const line = state.warnings.find((warning) => warning.includes("不在插件支持范围内"));
  assert.ok(line, "派给 cursor 的档位要说清注入不了，别让人以为配好了");
  assert.match(line, /cursor/);
  assert.match(line, /注入不了/);

  // 路由里直接写派生 provider：换成另一句话，别让人以为「换个客户端」才对。
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify(settings({ routing: [{ difficulty: "normal", target: { provider: "deck-codex", model: "gpt-5-codex" } }] })),
    "utf8",
  );
  const derived = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  const derivedLine = derived.warnings.find((warning) => warning.includes("派生 provider deck-codex"));
  assert.ok(derivedLine, "写派生 provider 要单独说一句");
  assert.match(derivedLine, /路由里请写 codex/);
  assert.equal(
    derived.warnings.some((warning) => warning.includes("不在插件支持范围内")),
    false,
    "不能把派生 provider 说成「不在支持范围内，换一个客户端」",
  );
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

test("编排状态：一档路由都没有时，四档都标 default 并说明内置默认缺模型发不出去", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify(settings({ routing: [] })), "utf8");
  const state = await readOrchestrationState(fakePaseo(), { workspaceId: "ws1", workspaceDir: dir });
  assert.equal(state.ok, true);
  for (const row of state.routing) {
    assert.equal(row.routeFrom, "default");
    // 内置默认只有客户端没有模型，宿主不认：界面上要如实标成「发不出去」，不能装作可用。
    assert.equal(row.resolved.ok, false);
    assert.equal(row.resolved.reason, "no-model");
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
