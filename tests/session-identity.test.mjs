import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adoptSessionAgentId, agentIdFromProcessTree } from "../server/mcp/session-identity.ts";

async function procFixture(t, rows) {
  const root = await mkdtemp(join(tmpdir(), "deck-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [pid, row] of Object.entries(rows)) {
    await mkdir(join(root, pid), { recursive: true });
    await writeFile(
      join(root, pid, "environ"),
      Object.entries(row.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\0") + "\0",
      "utf8",
    );
    await writeFile(join(root, pid, "status"), `Name:\ttest\nPPid:\t${row.ppid ?? 0}\n`, "utf8");
  }
  return root;
}

test("从父进程树补齐会话身份，不覆盖已有值", async (t) => {
  const procRoot = await procFixture(t, {
    100: { ppid: 200, env: {} },
    200: { ppid: 1, env: { PASEO_AGENT_ID: "dispatch-1" } },
  });
  const env = {};
  const result = adoptSessionAgentId({ procRoot, ppid: 100, platform: "linux", env });
  assert.deepEqual(result, { adopted: true, agentId: "dispatch-1" });
  assert.equal(env.PASEO_AGENT_ID, "dispatch-1");

  const existing = { PASEO_AGENT_ID: "owner-1" };
  assert.deepEqual(
    adoptSessionAgentId({ procRoot, ppid: 100, platform: "linux", env: existing }),
    { adopted: false, agentId: "owner-1" },
  );
  assert.equal(existing.PASEO_AGENT_ID, "owner-1");
});

test("找不到身份时保持空，不伪造", async (t) => {
  const procRoot = await procFixture(t, {
    100: { ppid: 200, env: {} },
    200: { ppid: 1, env: {} },
  });
  const env = {};
  assert.deepEqual(
    adoptSessionAgentId({ procRoot, ppid: 100, platform: "linux", env }),
    { adopted: false, agentId: "" },
  );
  assert.equal(env.PASEO_AGENT_ID, undefined);
});

test("只走有限层祖先，非 Linux 不读 /proc", async (t) => {
  const procRoot = await procFixture(t, {
    100: { ppid: 200, env: {} },
    200: { ppid: 300, env: {} },
    300: { ppid: 1, env: { PASEO_AGENT_ID: "too-far" } },
  });
  assert.equal(agentIdFromProcessTree(100, { procRoot, platform: "linux", maxDepth: 2 }), "");
  assert.equal(agentIdFromProcessTree(100, { procRoot, platform: "darwin", maxDepth: 4 }), "");
});

test("坏文件与不存在的 pid 都安全返回空", () => {
  assert.equal(agentIdFromProcessTree(999, { platform: "linux", readText: () => { throw new Error("no"); } }), "");
});
