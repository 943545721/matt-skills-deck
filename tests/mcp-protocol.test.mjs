import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK_PROTOCOL_VERSION, handleMessage } from "../server/mcp/protocol.ts";
import { MCP_TOOLS } from "../server/mcp/tools.ts";

/**
 * 协议层是纯函数，所以这里不需要起子进程：直接喂一行文本，检查回包。
 * 真实链路由 tests 之外的冒烟脚本用 stdio 驱动（见 PROGRESS.md 的验证记录）。
 */

const context = { workspaceDir: process.cwd() };
const call = (message) => handleMessage(JSON.stringify(message), context);

test("初始化：回客户端给的版本；给不认识的版本时回退到我们声明支持的那个", async () => {
  const echoed = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(echoed.result.protocolVersion, "2025-06-18");
  assert.equal(echoed.result.serverInfo.name, "matt-skills-deck");
  assert.deepEqual(echoed.result.capabilities, { tools: { listChanged: false } });

  const fallback = await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(fallback.result.protocolVersion, FALLBACK_PROTOCOL_VERSION);

  const missing = await call({ jsonrpc: "2.0", id: 3, method: "initialize" });
  assert.equal(missing.result.protocolVersion, FALLBACK_PROTOCOL_VERSION);
});

test("工具清单：与实现同源，全部带 deck_ 前缀且都有输入 schema", async () => {
  const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const listed = response.result.tools;
  assert.equal(listed.length, MCP_TOOLS.length);
  for (const tool of listed) {
    assert.match(tool.name, /^deck_[a-z_]+$/);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 20);
  }
  assert.deepEqual(
    listed.map((tool) => tool.name).sort(),
    MCP_TOOLS.map((tool) => tool.name).sort(),
  );
});

test("通知不回包：notifications/initialized 与未知通知都返回 null", async () => {
  assert.equal(await call({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await call({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), null);
});

test("通知一律不回包：连 initialize / ping / tools/list 这种请求型方法也不回", async () => {
  assert.equal(await call({ jsonrpc: "2.0", method: "ping" }), null);
  assert.equal(await call({ jsonrpc: "2.0", method: "tools/list" }), null);
  assert.equal(
    await call({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    null,
  );
});

test("非法 id 回 -32600，而不是拿 null 冒充一个新请求的编号", async () => {
  const response = await call({ jsonrpc: "2.0", id: { nested: 1 }, method: "ping" });
  assert.equal(response.error.code, -32600);
  assert.equal(response.id, null);
});

test("ping 立刻回空结果", async () => {
  const response = await call({ jsonrpc: "2.0", id: 7, method: "ping" });
  assert.deepEqual(response, { jsonrpc: "2.0", id: 7, result: {} });
});

test("坏输入各归各的错误码：解析、信封、方法、参数", async () => {
  const parse = JSON.parse(JSON.stringify(await handleMessage("{ 不是 json", context)));
  assert.equal(parse.error.code, -32700);

  const envelope = await call({ id: 1, method: "ping" });
  assert.equal(envelope.error.code, -32600);

  const method = await call({ jsonrpc: "2.0", id: 2, method: "resources/list" });
  assert.equal(method.error.code, -32601);

  const noName = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} });
  assert.equal(noName.error.code, -32602);

  const unknown = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "deck_nope" } });
  assert.equal(unknown.error.code, -32602);
});

test("工具调用：参数不合法时按工具错误回，而不是协议错误", async () => {
  const response = await call({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "deck_issue_get", arguments: {} },
  });
  assert.equal(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "invalid");
  assert.match(payload.detail, /number/);
});

test("工具入参：多给的键被拒绝，而不是静默丢弃后当成「已过滤」", async () => {
  const response = await call({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "deck_issues_list", arguments: { state: "open", label: "wayfinder:map" } },
  });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, true);
  assert.equal(payload.reason, "invalid");
  assert.match(payload.detail, /label/);
});

test("工具调用：工作区没有 git 远端时退回本地后端，给空板而不是 no-repo", async () => {
  const response = await handleMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "deck_issues_list", arguments: {} } }),
    { workspaceDir: "/nonexistent-deck-workspace" },
  );
  const payload = JSON.parse(response.result.content[0].text);
  // 没有远端不等于「没活可干」：本地后端仍然可读，只是板子为空。
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "local");
  assert.equal(payload.totalCount, 0);
  assert.deepEqual(payload.issues, []);
  assert.equal(response.result.isError, undefined);
});
