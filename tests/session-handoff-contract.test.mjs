import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHandoffs, readHandoff, saveHandoff } from "../server/ledger.ts";
import { renderHandoff } from "../shared/session.ts";
import { sessionHandoffReadRpc, sessionHandoffsListRpc } from "../shared/session-rpc.ts";
import { readFileSync as readText } from "node:fs";

test("handoff 保存、列出、读取形成闭环，并拒绝路径穿越", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deck-handoff-contract-"));
  try {
    const markdown = renderHandoff({
      lang: "zh",
      title: "合同测试",
      destination: "验证交接",
      done: ["已完成读取"],
      nextSteps: ["继续核对"],
    });
    const homeDir = mkdtempSync(join(tmpdir(), "deck-handoff-home-"));
    const scope = { cwd, agentId: null, homeDir };
    const saved = await saveHandoff(markdown, { ...scope, now: new Date() });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(readFileSync(saved.path, "utf8"), markdown);

    const listed = await listHandoffs(scope);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, saved.name);

    const read = await readHandoff(saved.name, scope);
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.markdown, markdown);

    const traversal = await readHandoff(`../${saved.name}`, scope);
    assert.equal(traversal.ok, false);
    if (!traversal.ok) assert.equal(traversal.reason, "invalid-name");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("handoff RPC 已在契约与服务端注册，Agent 面板有可达入口", () => {
  assert.equal(sessionHandoffsListRpc.name, "deck.session.handoffs.list");
  assert.equal(sessionHandoffReadRpc.name, "deck.session.handoffs.read");
  const registration = readText(new URL("../server/rpc/register.ts", import.meta.url), "utf8");
  const panel = readText(new URL("../client/deck/surfaces/agentPanel.tsx", import.meta.url), "utf8");
  assert.match(registration, /server\.handle\(sessionHandoffsListRpc/);
  assert.match(registration, /server\.handle\(sessionHandoffReadRpc/);
  assert.match(panel, /sessionHandoffsListRpc/);
  assert.match(panel, /sessionHandoffReadRpc/);
  assert.match(panel, /agentPanel\.handoffs/);
});
