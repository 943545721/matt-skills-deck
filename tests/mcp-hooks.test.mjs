import assert from "node:assert/strict";
import { test } from "node:test";
import { injectDeckTools, mcpEntryPath } from "../server/hooks.ts";
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

  const writeTools = ["deck_issue_comment", "deck_issue_create", "deck_issue_labels"];
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

test("入口路径固定在插件目录下的 server/mcp/main.ts", () => {
  assert.equal(mcpEntryPath("/plugins/deck"), "/plugins/deck/server/mcp/main.ts");
});
