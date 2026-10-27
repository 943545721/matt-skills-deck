import assert from "node:assert/strict";
import { test } from "node:test";
import {
  injectDeckTools,
  injectionProblem,
  mcpEntryPath,
  runtimeFeatures,
  shouldInjectDeckTools,
  typescriptSupported,
} from "../server/hooks.ts";
import { MCP_SERVER_NAME, MCP_TOOLS, PREAPPROVED_TOOL_NAMES } from "../server/mcp/tools.ts";

/** 注入器是纯函数：不碰 daemon、不碰文件，所以可以直接拿一份配置试。 */

const request = () => ({
  config: {
    provider: "claude-code",
    cwd: "/work/deck",
  },
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
      provider: "claude-code",
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

test("注入判定：GitHub / GitLab 远端一定注入；本地后端只在已有 .deck/ 或用户明确选 local 时注入", () => {
  const github = { ok: true, kind: "github", ref: { host: "github" }, repo: {} };
  const gitlab = { ok: true, kind: "gitlab", ref: { host: "gitlab" }, repo: {} };
  const local = { ok: true, kind: "local", workspaceDir: "/work/deck", repo: {} };
  assert.equal(shouldInjectDeckTools(github, false), true);
  assert.equal(shouldInjectDeckTools(gitlab, false), true);
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
