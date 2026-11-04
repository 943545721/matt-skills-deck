import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rememberStaffSession, staffIdOfSession } from "../server/staff-sessions.ts";

/** 会话台账是 MCP 侧唯一能认出「调用者是哪张卡」的依据，坏行与缺失都必须能收场。 */

async function dir(t) {
  const value = await mkdtemp(join(tmpdir(), "deck-staff-sessions-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test("记下 agent id → 卡 id，并按最后一条为准", async (t) => {
  const workspace = await dir(t);
  await rememberStaffSession(workspace, { agentId: "agent-1", staffId: "frontend", workspaceId: "w1" });
  await rememberStaffSession(workspace, { agentId: "agent-1", staffId: "backend" });
  assert.equal(await staffIdOfSession(workspace, "agent-1"), "backend");
  assert.equal(await staffIdOfSession(workspace, "agent-2"), null);
});

test("没有台账、坏行、空 id 都不算错误", async (t) => {
  const workspace = await dir(t);
  assert.equal(await staffIdOfSession(workspace, "agent-1"), null);

  await rememberStaffSession(workspace, { agentId: "", staffId: "frontend" });
  await rememberStaffSession(workspace, { agentId: "agent-1", staffId: "" });
  await mkdir(join(workspace, ".deck"), { recursive: true });
  const file = join(workspace, ".deck", "staff-sessions.jsonl");
  await writeFile(file, "{ not json\n" + `${JSON.stringify({ agentId: "agent-1", staffId: "frontend" })}\n`, "utf8");
  assert.equal(await staffIdOfSession(workspace, "agent-1"), "frontend");
  assert.match(await readFile(file, "utf8"), /not json/);
});
