import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { orchestrationProviderDiagnosticHandler, orchestrationSaveHandler } from "../server/rpc/orchestration.ts";
import { readOrchestration } from "../server/orchestration-store.ts";

/**
 * RPC 出口的字段搬运。
 *
 * 为什么单独测 handler：`saveOrchestration` 的用例直接调函数，绕过 handler。
 * 上一版就是「函数支持 workspaceId，handler 把它丢了」——测试全绿，生产路径上等于没修。
 */

const SETTINGS = {
  roles: [{ workspaceId: "ws-2", mainAgentId: "main-2", dispatcherAgentId: "d-2" }],
  routing: [],
  maxDepth: 3,
  maxChildrenPerDispatch: 4,
  reportOnFinish: true,
};

test("保存 handler：把调用方的 workspaceId 透到落盘，不从角色反推", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-rpc-save-"));
  const result = await orchestrationSaveHandler({ workspaceDir: dir, workspaceId: "ws-1", settings: SETTINGS });
  assert.equal(result.ok, true);
  assert.equal((await readOrchestration(dir)).workspaceId, "ws-1", "角色里只有 ws-2，归属仍必须是 ws-1");
});

test("保存 handler：没给 workspaceId 时才退回角色里的唯一工作区", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-rpc-save-"));
  const result = await orchestrationSaveHandler({ workspaceDir: dir, settings: SETTINGS });
  assert.equal(result.ok, true);
  assert.equal((await readOrchestration(dir)).workspaceId, "ws-2");
});

test("保存 handler：多份角色且没给 workspaceId 时，不猜归属（沿用文件里已有的）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-rpc-save-"));
  await orchestrationSaveHandler({ workspaceDir: dir, workspaceId: "ws-0", settings: SETTINGS });
  const twoRoles = {
    ...SETTINGS,
    roles: [
      { workspaceId: "ws-2", mainAgentId: null, dispatcherAgentId: null },
      { workspaceId: "ws-3", mainAgentId: null, dispatcherAgentId: null },
    ],
  };
  const result = await orchestrationSaveHandler({ workspaceDir: dir, settings: twoRoles });
  assert.equal(result.ok, true);
  assert.equal((await readOrchestration(dir)).workspaceId, "ws-0", "推不出唯一归属就别动它");
});

test("保存 handler：workspaceId 传了却是空白时报 invalid，不静默改成猜归属", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-rpc-save-"));
  const result = await orchestrationSaveHandler({ workspaceDir: dir, workspaceId: "   ", settings: SETTINGS });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

/** 诊断 handler 只搬字段：宿主给什么就显示什么，空文本与异常要能分开说。 */
const diagnosticContext = (impl) => ({ paseo: { providers: { diagnostic: impl } } });

test("诊断 handler：原文透传并去掉首尾空白", async () => {
  const result = await orchestrationProviderDiagnosticHandler(
    { provider: "copilot" },
    diagnosticContext(async () => ({ provider: "copilot", diagnostic: "\n  Resolved path: not found\n", requestId: "r" })),
  );
  assert.equal(result.ok, true);
  assert.equal(result.diagnostic, "Resolved path: not found");
});

test("诊断 handler：宿主给空文本时报 empty，而不是显示一片空白", async () => {
  const result = await orchestrationProviderDiagnosticHandler(
    { provider: "copilot" },
    diagnosticContext(async () => ({ provider: "copilot", diagnostic: "   ", requestId: "r" })),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty");
});

test("诊断 handler：宿主抛错时把原因带出来", async () => {
  const result = await orchestrationProviderDiagnosticHandler(
    { provider: "copilot" },
    diagnosticContext(async () => {
      throw new Error("provider not found");
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.match(result.detail, /provider not found/);
});

test("诊断 handler：provider 空白直接报 invalid，不发给宿主", async () => {
  let called = false;
  const result = await orchestrationProviderDiagnosticHandler(
    { provider: "  " },
    diagnosticContext(async () => {
      called = true;
      return { diagnostic: "x" };
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(called, false);
});
