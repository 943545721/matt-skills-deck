import assert from "node:assert/strict";
import { test } from "node:test";
import {
  injectDeckTools,
  registerHooks,
  routeCodexSiteProvider,
  injectionProblem,
  mcpEntryPath,
  runtimeFeatures,
  shouldInjectDeckTools,
  supportsExactMcpPreapproval,
  typescriptSupported,
} from "../server/hooks.ts";
import { MCP_SERVER_NAME, MCP_TOOLS, PREAPPROVED_TOOL_NAMES } from "../server/mcp/tools.ts";

/** 注入器是纯函数：不碰 daemon、不碰文件，所以可以直接拿一份配置试。 */

const request = (provider = "claude/sonnet") => ({
  config: {
    provider,
    cwd: "/work/deck",
  },
});

test("Codex 站点路由：创建请求明确选择派生 provider 并保留模型", () => {
  const input = request("codex/gpt-5-codex");
  const out = routeCodexSiteProvider(input, {
    "deck-codex": { extends: "codex", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } },
  });
  assert.equal(out.config.provider, "deck-codex/gpt-5-codex");
  assert.equal(input.config.provider, "codex/gpt-5-codex", "不能原地改宿主请求");
});

test("Codex 站点路由：站点未启用时拒绝，不静默回到 ~/.codex 配置", () => {
  assert.equal(
    routeCodexSiteProvider(request("codex/gpt-5-codex"), {}).config.provider,
    "codex/gpt-5-codex",
    "没有自定义站点时保留普通 Codex 会话",
  );
  assert.throws(
    () => routeCodexSiteProvider(request("codex/gpt-5-codex"), {
      codex: { env: { OPENAI_BASE_URL: "https://legacy.example.test/v1" } },
    }),
    (error) => {
      assert.match(error.message, /尚未绑定到会话 provider/);
      // 报错要能直接照着做：把那条地址带出来，用户照抄进站点即可。
      assert.match(error.message, /https:\/\/legacy\.example\.test\/v1/);
      assert.match(error.message, /凭证可以留空/);
      return true;
    },
  );
  // 派生条目被停用、内建条目却还配着旧地址：放行就会退回那个地址，拦下。
  assert.throws(
    () =>
      routeCodexSiteProvider(request("codex/gpt-5-codex"), {
        codex: { env: { OPENAI_BASE_URL: "https://legacy.example.test/v1" } },
        "deck-codex": { extends: "codex", enabled: false, env: { OPENAI_BASE_URL: "https://api.example.test/v1" } },
      }),
    /尚未绑定到会话 provider/,
  );
});

test("Codex 站点路由：派生条目没继承 codex 才算配置不完整；缺地址的残条目按普通 Codex 放行", () => {
  // 没继承 codex：不是插件写出来的形状，别拿它开会话。
  assert.throws(
    () =>
      routeCodexSiteProvider(request("codex/gpt-5-codex"), {
        "deck-codex": { extends: "claude", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } },
      }),
    /派生 provider 配置不完整/,
  );
  // 缺地址 / 地址不是字符串 / 被停用：都拿不出可用地址，当没配站点，普通 Codex 照常建。
  for (const leftover of [
    { "deck-codex": { extends: "codex", env: {} } },
    { "deck-codex": { extends: "codex", env: { OPENAI_BASE_URL: 42 } } },
    { "deck-codex": { extends: "codex", enabled: false, env: { OPENAI_BASE_URL: "https://api.example.test/v1" } } },
  ]) {
    assert.equal(
      routeCodexSiteProvider(request("codex/gpt-5-codex"), leftover).config.provider,
      "codex/gpt-5-codex",
      "残条目不该拦住普通 Codex 会话",
    );
  }
});

test("Codex 站点路由：只有客户端、没有模型段时也要改写", () => {
  const out = routeCodexSiteProvider(request("codex"), {
    "deck-codex": { extends: "codex", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } },
  });
  assert.equal(out.config.provider, "deck-codex");
});

test("Codex 站点路由：大小写与空白按同一条归一规则认出来", () => {
  const out = routeCodexSiteProvider(request(" Codex /gpt-5-codex"), {
    "deck-codex": { extends: "codex", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } },
  });
  assert.equal(out.config.provider, "deck-codex/gpt-5-codex");
});

/* --------------------------------------------- agent.create 钩子：两段接起来 */

/** 只收 before/on 注册的假宿主，够把钩子拿出来直接调。 */
function fakeServer() {
  const handlers = {};
  return {
    handlers,
    before: (name, fn) => {
      handlers[name] = fn;
      return () => {};
    },
    on: () => () => {},
  };
}

const hookContext = (get) => ({ paseo: { config: { get } }, signal: new AbortController().signal });

test("agent.create 钩子：启用过 Codex 站点，真实创建请求改走派生 provider", async () => {
  const server = fakeServer();
  registerHooks(server);
  const out = await server.handlers["agent.create"](
    { request: { config: { provider: "codex/gpt-5-codex", cwd: "/work/deck" } } },
    hookContext(async () => ({
      config: {
        providers: {
          "deck-codex": { extends: "codex", env: { OPENAI_BASE_URL: "https://api.example.test/v1" } },
        },
      },
    })),
  );
  assert.equal(out.config.provider, "deck-codex/gpt-5-codex", "钩子读到的配置要真的把 provider 换掉");
});

test("agent.create 钩子：读不到配置时拒绝创建 Codex 会话，不静默退回 ~/.codex 的地址", async () => {
  const server = fakeServer();
  registerHooks(server);
  await assert.rejects(
    server.handlers["agent.create"](
      { request: { config: { provider: "codex/gpt-5-codex", cwd: "/work/deck" } } },
      hookContext(async () => {
        throw new Error("read timeout");
      }),
    ),
    /读不到宿主配置，没法确认 Codex 该走哪条接入地址/,
  );
});

test("agent.create 钩子：非 Codex 客户端读不到配置也照常创建", async () => {
  const server = fakeServer();
  registerHooks(server);
  const out = await server.handlers["agent.create"](
    { request: { config: { provider: "claude/sonnet", cwd: "/work/elsewhere" } } },
    hookContext(async () => {
      throw new Error("read timeout");
    }),
  );
  assert.equal(out.config.provider, "claude/sonnet");
});

test("预授权能力：只有宿主实现 applyToolPolicy 的三家能带 toolPolicy", () => {
  for (const provider of ["claude/sonnet", "codex", "opencode/gpt-5", "deck-codex/gpt-5-codex", "Deck-Codex"]) {
    assert.equal(supportsExactMcpPreapproval(provider), true, `${provider} 应该支持精确预授权`);
  }
  // cursor 这类客户端带 toolPolicy 会被宿主整条拒绝（tool_policy_unsupported），必须按不支持处理。
  for (const provider of ["cursor", "cursor/composer", "copilot", "", "  "]) {
    assert.equal(supportsExactMcpPreapproval(provider), false, `"${provider}" 不该被当成支持`);
  }
});

test("注入：客户端不接受精确预授权时只挂服务，不写 toolPolicy", () => {
  const out = injectDeckTools(request("cursor/composer"), { entry: "/e/main.ts", workspaceDir: "/work/deck" });
  assert.equal(out.config.mcpServers[MCP_SERVER_NAME].alwaysLoad, true, "工具仍然要挂上，只是每次要用户确认");
  assert.equal(out.config.toolPolicy, undefined, "带上 toolPolicy 宿主会拒绝整条创建");
});

test("注入：客户端不接受预授权时，其它 MCP 服务照原样保留", () => {
  const out = injectDeckTools(
    {
      config: {
        provider: "cursor/composer",
        cwd: "/work/deck",
        mcpServers: { other: { type: "stdio", command: "other-mcp" } },
      },
    },
    { entry: "/e/main.ts", workspaceDir: "/work/deck" },
  );
  assert.deepEqual(Object.keys(out.config.mcpServers).sort(), [MCP_SERVER_NAME, "other"].sort());
  assert.equal(out.config.mcpServers.other.command, "other-mcp");
});

test("注入：客户端不接受预授权时，用户自己带的那份 toolPolicy 不删也不加", () => {
  // 已知残留：这种客户端下宿主仍会拒这条请求。删掉用户的东西不属于这里能替人决定的范围。
  const mine = [{ kind: "mcp", server: "other", tool: "read_thing" }];
  const out = injectDeckTools(
    { config: { provider: "cursor/composer", cwd: "/work/deck", toolPolicy: { preapproved: mine } } },
    { entry: "/e/main.ts", workspaceDir: "/work/deck" },
  );
  assert.deepEqual(out.config.toolPolicy.preapproved, mine);
});

test("注入：挂上 stdio 服务、把工作区作为启动参数，且不改 cwd", () => {
  const input = request();
  const out = injectDeckTools(input, { entry: "/plugins/deck/server/mcp/main.ts", workspaceDir: "/work/deck" });
  const server = out.config.mcpServers[MCP_SERVER_NAME];
  assert.equal(server.type, "stdio");
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, ["/plugins/deck/server/mcp/main.ts", "--workspace", "/work/deck"]);
  assert.equal(server.alwaysLoad, true);
  assert.equal(out.config.cwd, "/work/deck");
  // 原请求不被就地修改（不可变优先）。
  assert.equal(input.config.mcpServers, undefined);
});

test("注入：只把只读工具放进 preapproved，写工具一个都不放", () => {
  const out = injectDeckTools(request(), { entry: "/e/main.ts", workspaceDir: "/work/deck" });
  const preapproved = out.config.toolPolicy.preapproved;
  assert.deepEqual(
    preapproved.map((ref) => ref.tool).sort(),
    [...PREAPPROVED_TOOL_NAMES].sort(),
  );
  assert.ok(preapproved.every((ref) => ref.kind === "mcp" && ref.server === MCP_SERVER_NAME));

  const writeTools = [
    "deck_issue_comment",
    "deck_issue_create",
    "deck_issue_labels",
    "deck_issue_patch",
    "deck_issue_report",
    "deck_map_link",
    "deck_map_plan_create",
  ];
  for (const tool of writeTools) {
    assert.ok(!preapproved.some((ref) => ref.tool === tool), `${tool} 不该被预授权`);
  }
  // 白名单里的每个名字都必须真的存在，否则 Claude 侧的 allowedTools 会静默匹配不上。
  for (const name of PREAPPROVED_TOOL_NAMES) {
    assert.ok(MCP_TOOLS.some((tool) => tool.name === name), `${name} 不在工具表里`);
  }
});

test("注入：保留别处已有的 MCP 服务与预授权，不重复追加自己", () => {
  const existing = {
    config: {
      provider: "claude/sonnet",
      cwd: "/work/deck",
      mcpServers: { other: { type: "stdio", command: "other-mcp" } },
      toolPolicy: { preapproved: [{ kind: "mcp", server: "other", tool: "read_thing" }] },
    },
  };
  const once = injectDeckTools(existing, { entry: "/e/main.ts", workspaceDir: "/work/deck" });
  const twice = injectDeckTools(once, { entry: "/e/main.ts", workspaceDir: "/work/deck" });
  assert.deepEqual(Object.keys(twice.config.mcpServers).sort(), [MCP_SERVER_NAME, "other"].sort());
  assert.equal(twice.config.mcpServers.other.command, "other-mcp");
  assert.equal(twice.config.toolPolicy.preapproved.length, 1 + PREAPPROVED_TOOL_NAMES.length);
});

test("注入判定：有远端仓库（含多仓库工作区）就注入；本地后端只在已有 .deck/ 或用户明确选 local 时注入", () => {
  const target = { key: "acme/deck", host: "github", owner: "acme", name: "deck", webUrl: "https://github.com/acme/deck", dir: "/work/deck", readOnly: false, ref: { host: "github", owner: "acme", name: "deck" } };
  const local = { ok: true, kind: "local", workspaceDir: "/work/deck", repo: { host: "local", owner: "", name: "deck", webUrl: null } };
  assert.equal(shouldInjectDeckTools({ ok: true, kind: "repos", targets: [target], defaultKey: null }, false), true);
  assert.equal(
    shouldInjectDeckTools(
      { ok: true, kind: "repos", targets: [target, { ...target, key: "acme/other", dir: "/work/other" }], defaultKey: null },
      false,
    ),
    true,
  );
  assert.equal(shouldInjectDeckTools(local, false), false);
  assert.equal(shouldInjectDeckTools(local, true), true);
  assert.equal(shouldInjectDeckTools({ ok: false, reason: "no-repo", detail: "x" }, true), false);
});

test("入口路径固定在插件目录下的 server/mcp/main.ts", () => {
  assert.equal(mcpEntryPath("/plugins/deck"), "/plugins/deck/server/mcp/main.ts");
});

test("注入前置检查：Node 太老或入口缺失都要跳过，并说清是哪一个原因", () => {
  assert.match(
    injectionProblem({ entry: "/e/main.ts", entryPresent: true, typescript: false }) ?? "",
    /22\.18/,
  );
  assert.match(
    injectionProblem({ entry: "/e/main.ts", entryPresent: false, typescript: true }) ?? "",
    /\/e\/main\.ts/,
  );
  assert.equal(injectionProblem({ entry: "/e/main.ts", entryPresent: true, typescript: true }), null);
});

test("Node 类型剥离能力判定：只认 strip / transform", () => {
  assert.equal(typescriptSupported({ typescript: "strip" }), true);
  assert.equal(typescriptSupported({ typescript: "transform" }), true);
  assert.equal(typescriptSupported({}), false);
  assert.equal(typescriptSupported(undefined), false);
  // 本机（跑测试的这台）必须支持，否则插件自己就跑不起来。
  assert.equal(typescriptSupported(runtimeFeatures()), true);
});
