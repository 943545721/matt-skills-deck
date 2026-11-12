import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gateDispatchTasks } from "../server/dispatch-ticket-gate.ts";
import { runDispatch } from "../server/orchestration.ts";
import { createLocalIssue } from "../server/tracker/local.ts";

/**
 * E 票门：无票不干活、需求没定稿不派。
 *
 * MCP 那条路早就有这两道闸；这里钉的是执行层（RPC / 需求拆票）同一条口径，
 * 以及「被拦下的任务不进计划、也不建会话」。
 */

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "deck-ticket-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(
    join(dir, ".deck", "orchestration.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-11-05T00:00:00.000Z",
      workspaceId: "ws-1",
      roles: [{ workspaceId: "ws-1", dispatcherAgentId: "dispatch-1" }],
      routing: [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }],
      maxDepth: 3,
      maxChildrenPerDispatch: 4,
      reportOnFinish: true,
    }),
    "utf8",
  );
  return dir;
}

function fakePaseo() {
  const created = [];
  return {
    created,
    config: { get: async () => ({ config: {} }) },
    agents: {
      list: async () => ({ entries: [] }),
      create: async (options) => {
        created.push(options);
        return { id: `child-${created.length}` };
      },
    },
    workspaces: {
      ref: (workspaceId) => ({
        id: workspaceId,
        agents: {
          create: async (options) => {
            created.push(options);
            return { id: `child-${created.length}` };
          },
        },
      }),
    },
  };
}

test("票门：没挂需求票的一条单独拒，其余照常进计划", async (t) => {
  const dir = await workspace(t);
  const result = await gateDispatchTasks(dir, [
    { key: "a", prompt: "干活" },
    { key: "b", prompt: "干活", requirementKey: 404 },
  ]);
  assert.deepEqual(result.gated.map((task) => task.key), []);
  assert.equal(result.rejected[0].reason, "no-requirement");
  assert.match(result.rejected[0].detail, /无票不干活/);
  assert.equal(result.rejected[1].reason, "requirement-unreadable");
});

test("票门：需求没定稿拒；定稿后放行并带回正文", async (t) => {
  const dir = await workspace(t);
  const draft = await createLocalIssue(dir, { title: "需求：草稿", body: "还没谈完", labels: ["requirement"] });
  assert.equal(draft.ok, true);
  const blocked = await gateDispatchTasks(dir, [{ key: "a", prompt: "干活", requirementKey: draft.number }]);
  assert.equal(blocked.rejected.length, 1);
  assert.equal(blocked.rejected[0].reason, "requirement-not-finalized");
  assert.match(blocked.rejected[0].detail, /定稿/);

  const settled = await createLocalIssue(dir, {
    title: "需求：定稿",
    body: "六节谈完了",
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(settled.ok, true);
  const passed = await gateDispatchTasks(dir, [
    { key: "a", prompt: "干活", requirementKey: settled.number },
    { key: "b", prompt: "再干一点", requirementKey: settled.number },
  ]);
  assert.deepEqual(passed.gated.map((task) => task.key), ["a", "b"]);
  assert.equal(passed.rejected.length, 0);
  assert.equal(passed.requirements.get(`#${settled.number}`)?.body, "六节谈完了");
});

test("执行层：无票任务被拒，一个会话都不建", async (t) => {
  const dir = await workspace(t);
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [{ key: "t1", prompt: "做点事" }],
    depth: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].reason, "no-requirement");
  assert.equal(paseo.created.length, 0);
});

test("执行层：需求未定稿被拒，同样不建会话", async (t) => {
  const dir = await workspace(t);
  const requirement = await createLocalIssue(dir, { title: "需求：草稿", body: "没谈完", labels: ["requirement"] });
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [{ key: "t1", prompt: "做点事", requirementKey: requirement.number }],
    depth: 1,
  });
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].reason, "requirement-not-finalized");
  assert.equal(paseo.created.length, 0);
});

test("执行层：需求票读不出来被拒，不建会话", async (t) => {
  const dir = await workspace(t);
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [{ key: "t1", prompt: "做点事", requirementKey: 404 }],
    depth: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].reason, "requirement-unreadable");
  assert.equal(paseo.created.length, 0);
});

test("执行层：定稿需求照常派，票与父会话都指对", async (t) => {
  const dir = await workspace(t);
  const requirement = await createLocalIssue(dir, {
    title: "需求：定稿",
    body: "六节谈完了",
    labels: ["requirement", "deck:定稿"],
  });
  const paseo = fakePaseo();
  const result = await runDispatch(paseo, {
    workspaceId: "ws-1",
    workspaceDir: dir,
    tasks: [{ key: "t1", prompt: "做点事", requirementKey: requirement.number }],
    depth: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true, JSON.stringify(result.results));
  assert.equal(paseo.created.length, 1);
  assert.equal(paseo.created[0].parent, "dispatch-1");
});
