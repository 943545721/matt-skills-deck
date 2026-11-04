import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  aggregateCoordination,
  appendCoordination,
  appendLineageRecord,
  approveCoordination,
  approveOnce,
  cancelCoordination,
  cancelRequest,
  consumeApproval,
  consumeCoordinationApproval,
  contractChangedCoordination,
  coordinationFileOf,
  declineCoordination,
  declineRequest,
  denyCoordination,
  denyRequest,
  findUsableApproval,
  implChangedCoordination,
  markContractChanged,
  markImplChanged,
  normalizeCoordinationPath,
  normalizeCoordinationPaths,
  pruneLineageRecords,
  readCoordination,
  reassignCoordination,
  reassignRequest,
  requestCoordination,
  staffCoordination,
  staffRequest,
  supersedeCoordination,
  supersedeRequest,
  sweepCoordination,
} from "../server/staff-territory.ts";

/**
 * 协调收件箱的存储与状态机。
 * 断言的是 plan 第七点五节那张状态表：三种 kind 共用一份 JSONL，
 * 聚合按（会话，目标区），批准粒度按（会话，归一化路径），24 小时自动取消。
 */

async function makeWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-coordination-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

const AT = "2026-01-01T00:00:00.000Z";

function record(overrides = {}) {
  return {
    at: AT,
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    toStaff: "staff-back",
    paths: ["server/api/user.ts"],
    sessionAgentId: "agent-1",
    taskSummary: "给登录接口加上验证码校验",
    state: "pending",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ 追加 / 重读 */

test("追加与重读：目录自动创建、路径归一化、返回写入的那条", async (t) => {
  const dir = await makeWorkspace(t);
  const first = await appendCoordination(dir, record());
  const second = await appendCoordination(
    dir,
    record({ toStaff: "staff-docs", paths: ["docs\\guide\\..\\a.md"] }),
  );
  assert.equal(first.paths[0], "server/api/user.ts");
  assert.deepEqual(second.paths, ["docs/a.md"]);

  const read = await readCoordination(dir);
  assert.equal(read.skipped, 0);
  assert.deepEqual(read.records, [first, second]);

  const text = await readFile(coordinationFileOf(dir), "utf8");
  assert.equal(text.trim().split("\n").length, 2);
});

test("missing 文件当空：不抛异常、skipped 为 0", async (t) => {
  const dir = await makeWorkspace(t);
  assert.deepEqual(await readCoordination(dir), { records: [], skipped: 0 });
});

test("坏行跳过并计数：非法 JSON / 缺字段 / 非法 state 各自算一条", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record());
  const file = coordinationFileOf(dir);
  await appendFile(file, "{不是 json\n", "utf8");
  await appendFile(file, `${JSON.stringify({ kind: "territory" })}\n`, "utf8");
  await appendFile(file, `${JSON.stringify(record({ state: "unknown" }))}\n`, "utf8");
  // 空行不是坏行。
  await appendFile(file, "\n", "utf8");

  const read = await readCoordination(dir);
  assert.equal(read.records.length, 1);
  assert.equal(read.skipped, 3);
});

/* ------------------------------------------------------------------ 三种 kind */

test("三种 kind 互不干扰：动作只接受自己的 kind 与状态", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record());
  await appendCoordination(dir, record({ kind: "staffing", need: "要一个会写前端的" }));
  await appendCoordination(dir, record({ kind: "contract", field: "status" }));

  assert.equal((await staffCoordination(dir, 1)).ok, true);
  assert.equal((await contractChangedCoordination(dir, 2)).ok, true);

  const read = await readCoordination(dir);
  assert.deepEqual(
    read.records.map((item) => item.state),
    ["pending", "staffed", "contract-changed"],
  );

  // 跨 kind / 跨终态的迁移一律拒绝，且不改文件。
  assert.equal((await approveCoordination(dir, 2)).ok, false);
  assert.equal((await denyCoordination(dir, 1)).ok, false);
  assert.equal((await declineCoordination(dir, 1)).ok, false);
  assert.equal((await implChangedCoordination(dir, 0)).ok, false);
  assert.equal((await reassignCoordination(dir, 2)).ok, false);
  assert.equal((await supersedeCoordination(dir, 1)).ok, false);

  const after = await readCoordination(dir);
  assert.deepEqual(
    after.records.map((item) => item.state),
    ["pending", "staffed", "contract-changed"],
  );
});

test("三种处置各写对 state：批准一次→consumed、转派、驳回、拒绝派人、实现已改", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record({ paths: ["a.ts"] }));
  await appendCoordination(dir, record({ paths: ["b.ts"] }));
  await appendCoordination(dir, record({ paths: ["c.ts"] }));
  await appendCoordination(dir, record({ kind: "staffing", need: "缺前端" }));
  await appendCoordination(dir, record({ kind: "contract", field: "status" }));

  assert.equal((await approveCoordination(dir, 0)).ok, true);
  assert.equal((await consumeCoordinationApproval(dir, "agent-1", "a.ts")).ok, true);
  assert.equal((await reassignCoordination(dir, 1)).ok, true);
  assert.equal((await denyCoordination(dir, 2)).ok, true);
  assert.equal((await declineCoordination(dir, 3)).ok, true);
  assert.equal((await implChangedCoordination(dir, 4)).ok, true);

  const read = await readCoordination(dir);
  assert.deepEqual(
    read.records.map((item) => item.state),
    ["consumed", "reassigned", "denied", "declined", "impl-changed"],
  );
});

test("非法迁移：纯函数返回 { ok:false, detail }，不静默改状态", () => {
  const territory = record();
  const staffing = record({ kind: "staffing" });
  const contract = record({ kind: "contract" });

  for (const [result, label] of [
    [approveOnce(staffing), "staffing 不能批准一次"],
    [consumeApproval(territory), "pending 不能直接消费"],
    [reassignRequest(record({ state: "consumed" })), "consumed 不能转派"],
    [denyRequest(record({ state: "denied" })), "denied 不能再次驳回"],
    [staffRequest(territory), "territory 不能派人"],
    [declineRequest(contract), "contract 不能拒绝派人"],
    [markContractChanged(territory), "territory 不能记契约已改"],
    [markImplChanged(staffing), "staffing 不能记实现已改"],
    [supersedeRequest(record({ state: "consumed" })), "非 pending 不能被覆盖"],
    [cancelRequest(record({ state: "approved-once" })), "非 pending 不能取消"],
  ]) {
    assert.equal(result.ok, false, label);
    assert.equal(typeof result.detail, "string", label);
    assert.ok(result.detail.length > 0, label);
  }
});

/* ------------------------------------------------------------------ 聚合 */

test("聚合：同会话同目标区的一批路径合成一条，不同区各一条", async (t) => {
  const dir = await makeWorkspace(t);
  const result = await requestCoordination(dir, {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "改登录和文档",
    entries: [
      { path: "server/a.ts", toStaff: "staff-back" },
      { path: "server/./b.ts", toStaff: "staff-back" },
      { path: "server\\a.ts", toStaff: "staff-back" },
      { path: "docs/x.md", toStaff: "staff-docs" },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 2);

  const back = result.records.find((item) => item.toStaff === "staff-back");
  const docs = result.records.find((item) => item.toStaff === "staff-docs");
  assert.deepEqual(back?.paths, ["server/a.ts", "server/b.ts"]);
  assert.deepEqual(docs?.paths, ["docs/x.md"]);
  assert.equal((await readCoordination(dir)).records.length, 2);

  // 纯聚合函数不落盘，形状与落盘结果一致。
  const pure = aggregateCoordination(dir, {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "改登录和文档",
    paths: ["server/a.ts", "server/b.ts"],
    toStaff: "staff-back",
  });
  assert.equal(pure.length, 1);
  assert.deepEqual(pure[0].paths, ["server/a.ts", "server/b.ts"]);
  assert.equal(pure[0].state, "pending");
});

test("聚合：20 个文件落在同一区只产生一条，不同会话各一条", async (t) => {
  const dir = await makeWorkspace(t);
  const entries = Array.from({ length: 20 }, (_, index) => ({
    path: `server/file-${index}.ts`,
    toStaff: "staff-back",
  }));
  const base = {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    taskSummary: "一次改 20 个文件",
  };
  const first = await requestCoordination(dir, { ...base, sessionAgentId: "agent-1", entries });
  assert.equal(first.ok && first.records.length, 1);
  assert.equal(first.ok && first.records[0].paths.length, 20);

  const second = await requestCoordination(dir, { ...base, sessionAgentId: "agent-2", entries });
  assert.equal(second.ok && second.records.length, 1);
  assert.equal((await readCoordination(dir)).records.length, 2);
});

test("并发写串行化：两个不同目标区的请求都不会丢", async (t) => {
  const dir = await makeWorkspace(t);
  const base = {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "并发请求",
  };
  const [back, docs] = await Promise.all([
    requestCoordination(dir, { ...base, paths: ["server/a.ts"], toStaff: "staff-back" }),
    requestCoordination(dir, { ...base, paths: ["docs/a.md"], toStaff: "staff-docs" }),
  ]);
  assert.equal(back.ok, true);
  assert.equal(docs.ok, true);
  const read = await readCoordination(dir);
  assert.deepEqual(
    read.records.map((item) => item.toStaff).sort(),
    ["staff-back", "staff-docs"],
  );
});

test("边界输入：非法 at / paths 类型 / entries 形状都拒绝且不落盘", async (t) => {
  const dir = await makeWorkspace(t);
  const base = {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "边界",
    toStaff: "staff-back",
  };
  assert.equal((await requestCoordination(dir, { ...base, at: "不是时间", paths: ["a.ts"] })).ok, false);
  assert.equal((await requestCoordination(dir, { ...base, paths: "a.ts" })).ok, false);
  assert.equal(
    (await requestCoordination(dir, { ...base, entries: [{ path: "a.ts", toStaff: 3 }] })).ok,
    false,
  );
  assert.equal((await requestCoordination(dir, { ...base, kind: "unknown", paths: ["a.ts"] })).ok, false);
  assert.deepEqual(await readCoordination(dir), { records: [], skipped: 0 });
});

test("staffing / contract 没有路径也能成一条，且按 need / field 分桶", async (t) => {
  const dir = await makeWorkspace(t);
  const staffing = aggregateCoordination(dir, {
    kind: "staffing",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "缺人",
    need: "要一个会写前端的",
    toStaff: null,
  });
  assert.equal(staffing.length, 1);
  assert.deepEqual(staffing[0].paths, []);
  assert.equal(staffing[0].need, "要一个会写前端的");

  const same = aggregateCoordination(dir, {
    kind: "staffing",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "缺人",
    need: "要一个会写前端的",
    toStaff: null,
  });
  assert.equal(same[0].need, staffing[0].need);

  const different = aggregateCoordination(dir, {
    kind: "staffing",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "缺人",
    need: "要一个会写 Rust 的",
    toStaff: null,
  });
  assert.notEqual(different[0].need, staffing[0].need);
});

/* ------------------------------------------------------------------ 批准粒度 */

test("approved-once 粒度 =（会话，归一化路径）；整批逐条用掉，最后一条才 consumed", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(
    dir,
    record({ paths: ["server/a.ts", "server/b.ts"] }),
  );
  assert.equal((await approveCoordination(dir, 0)).ok, true);
  let read = await readCoordination(dir);
  assert.equal(read.records[0].state, "approved-once");
  assert.ok(findUsableApproval(read.records, "agent-1", "server/a.ts"));
  assert.equal(findUsableApproval(read.records, "agent-2", "server/a.ts"), null);
  assert.equal(findUsableApproval(read.records, "agent-1", "server/c.ts"), null);

  // 反斜杠写法也要命中同一条路径。规格：批准一次放行整批，用掉一条后其余仍可用。
  const consumed = await consumeCoordinationApproval(dir, "agent-1", "server\\a.ts");
  assert.equal(consumed.ok, true);
  read = await readCoordination(dir);
  assert.equal(read.records[0].state, "approved-once");
  assert.deepEqual(read.records[0].paths, ["server/b.ts"]);
  assert.equal(findUsableApproval(read.records, "agent-1", "server/a.ts"), null);
  assert.ok(findUsableApproval(read.records, "agent-1", "server/b.ts"), "同批剩下的路径仍被这次批准覆盖");

  const last = await consumeCoordinationApproval(dir, "agent-1", "server/b.ts");
  assert.equal(last.ok, true);
  read = await readCoordination(dir);
  assert.equal(read.records[0].state, "consumed");
  const again = await consumeCoordinationApproval(dir, "agent-1", "server/a.ts");
  assert.equal(again.ok, false);
});

/* ------------------------------------------------------------------ superseded */

test("superseded：同会话同区更早的 pending 被新请求覆盖", async (t) => {
  const dir = await makeWorkspace(t);
  const first = await requestCoordination(dir, {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "第一次尝试",
    paths: ["server/a.ts"],
    toStaff: "staff-back",
  });
  assert.equal(first.ok && first.superseded, 0);

  const second = await requestCoordination(dir, {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "重试",
    paths: ["server/b.ts"],
    toStaff: "staff-back",
  });
  assert.equal(second.ok && second.superseded, 1);

  let read = await readCoordination(dir);
  assert.deepEqual(
    read.records.map((item) => item.state),
    ["superseded", "pending"],
  );
  assert.deepEqual(read.records[1].paths, ["server/b.ts"]);

  // 换一个目标区不算「同区」，旧的那条仍是 pending。
  await requestCoordination(dir, {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "staff-front",
    sessionAgentId: "agent-1",
    taskSummary: "另一个区",
    paths: ["docs/a.md"],
    toStaff: "staff-docs",
  });
  read = await readCoordination(dir);
  assert.deepEqual(
    read.records.map((item) => item.state),
    ["superseded", "pending", "pending"],
  );
});

/* ------------------------------------------------------------------ cancelled */

test("24 小时未处置自动 cancelled；未到时限的不动", async (t) => {
  const dir = await makeWorkspace(t);
  const now = "2026-03-01T12:00:00.000Z";
  const old = new Date(Date.parse(now) - 25 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(Date.parse(now) - 1 * 60 * 60 * 1000).toISOString();
  await appendCoordination(dir, record({ at: old, paths: ["a.ts"] }));
  await appendCoordination(dir, record({ at: fresh, paths: ["b.ts"] }));

  const swept = await sweepCoordination(dir, { now });
  assert.equal(swept.ok && swept.cancelled, 1);
  assert.equal(swept.ok && swept.reason, "timeout");
  const read = await readCoordination(dir);
  assert.deepEqual(
    read.records.map((item) => item.state),
    ["cancelled", "pending"],
  );
});

test("目标卡被删 / 需求被关：同一个 sweep 函数，由调用方传原因", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record({ toStaff: "staff-back", paths: ["a.ts"] }));
  await appendCoordination(dir, record({ toStaff: "staff-docs", paths: ["b.ts"] }));

  const swept = await sweepCoordination(dir, {
    now: AT,
    match: (item) => item.toStaff === "staff-back",
    reason: "target-deleted",
  });
  assert.equal(swept.ok && swept.cancelled, 1);
  assert.equal(swept.ok && swept.reason, "target-deleted");
  const read = await readCoordination(dir);
  assert.deepEqual(
    read.records.map((item) => item.state),
    ["cancelled", "pending"],
  );

  // 再次扫不会重复计数。
  const again = await sweepCoordination(dir, {
    now: AT,
    match: (item) => item.toStaff === "staff-back",
    reason: "target-deleted",
  });
  assert.equal(again.ok && again.cancelled, 0);
});

/* ------------------------------------------------------------------ 路径归一化 */

test("路径归一化：相对工作区根、折叠 ./..、反斜杠转 /", async (t) => {
  const dir = await makeWorkspace(t);
  assert.equal(normalizeCoordinationPath(dir, "server\\api\\..\\..\\x/./y.ts"), "x/y.ts");
  assert.equal(normalizeCoordinationPath(dir, "./a/../b.ts"), "b.ts");
  assert.equal(normalizeCoordinationPath(dir, path.join(dir, "server", "a.ts")), "server/a.ts");
  assert.equal(normalizeCoordinationPath(dir, "/etc/passwd"), "/etc/passwd");
  assert.deepEqual(
    normalizeCoordinationPaths(dir, ["a.ts", "./a.ts", "a\\..\\a.ts", "b/../a.ts"]),
    ["a.ts"],
  );
});

/* ------------------------------------------------------------------ 持久化封装 */

test("transitionCoordination 找不到目标时返回失败，不创建半份文件", async (t) => {
  const dir = await makeWorkspace(t);
  const result = await approveCoordination(dir, 0);
  assert.equal(result.ok, false);
  const read = await readCoordination(dir);
  assert.deepEqual(read, { records: [], skipped: 0 });
});

/* ------------------------------------------------------------------ 血缘 */

test("血缘记录：写一条 lineage/recorded，读得回来，且清扫不会把它当待办取消", async (t) => {
  const dir = await makeWorkspace(t);
  const wrote = await appendLineageRecord(dir, {
    workspaceId: "ws-1",
    childAgentId: "child-1",
    parentAgentId: "parent-1",
    at: AT,
  });
  assert.equal(wrote.kind, "lineage");
  assert.equal(wrote.state, "recorded");
  assert.equal(wrote.sessionAgentId, "child-1");
  assert.equal(wrote.fromStaff, "parent-1");
  assert.match(wrote.taskSummary, /child-1/);
  assert.match(wrote.taskSummary, /parent-1/);

  const read = await readCoordination(dir);
  assert.equal(read.skipped, 0);
  assert.deepEqual(read.records, [wrote]);

  // 一年后清扫：recorded 不是 pending，不该被改成 cancelled。
  const swept = await sweepCoordination(dir, { now: "2027-01-01T00:00:00.000Z" });
  assert.equal(swept.ok, true);
  assert.equal(swept.cancelled, 0);
  assert.equal((await readCoordination(dir)).records[0].state, "recorded");
});

test("血缘记录：缺子/父/工作区任一 id 就拒绝，不写坏行", async (t) => {
  const dir = await makeWorkspace(t);
  await assert.rejects(() => appendLineageRecord(dir, { workspaceId: "ws-1", childAgentId: "", parentAgentId: "p" }));
  await assert.rejects(() => appendLineageRecord(dir, { workspaceId: "", childAgentId: "c", parentAgentId: "p" }));
  assert.deepEqual((await readCoordination(dir)).records, []);
});

/* ------------------------------------------------------------------ 血缘裁剪 */

test("血缘裁剪：只删血缘，其余台账一条不少，血缘留最近 N 条", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record({ paths: ["server/a.ts"] }));
  await appendCoordination(dir, record({ kind: "contract", field: "status" }));
  for (let index = 0; index < 5; index += 1) {
    await appendLineageRecord(dir, {
      workspaceId: "ws-1",
      childAgentId: `child-${index}`,
      parentAgentId: "parent-1",
      at: AT,
      retention: { now: AT },
    });
  }

  const pruned = await pruneLineageRecords(dir, { now: AT, maxRecords: 2 });
  assert.equal(pruned.ok, true);
  assert.equal(pruned.removed, 3);

  const read = await readCoordination(dir);
  assert.equal(read.records.filter((item) => item.kind !== "lineage").length, 2);
  assert.deepEqual(
    read.records.filter((item) => item.kind === "lineage").map((item) => item.sessionAgentId),
    ["child-3", "child-4"],
  );
});

test("血缘裁剪：超过保留时长的旧行被删，没过期的留下", async (t) => {
  const dir = await makeWorkspace(t);
  const now = "2026-03-01T12:00:00.000Z";
  const day = 24 * 60 * 60 * 1000;
  const old = new Date(Date.parse(now) - 100 * day).toISOString();
  // 写入这一步用宽期限，好让两条都先落盘；裁剪单独调一次，只看 90 天。
  await appendLineageRecord(dir, {
    workspaceId: "ws-1", childAgentId: "old-child", parentAgentId: "parent-1", at: old,
    retention: { now, maxAgeMs: 365 * day },
  });
  await appendLineageRecord(dir, {
    workspaceId: "ws-1", childAgentId: "new-child", parentAgentId: "parent-1", at: now,
    retention: { now, maxAgeMs: 365 * day },
  });

  const pruned = await pruneLineageRecords(dir, { now, maxAgeMs: 90 * day });
  assert.equal(pruned.ok && pruned.removed, 1);
  const read = await readCoordination(dir);
  assert.deepEqual(read.records.map((item) => item.sessionAgentId), ["new-child"]);
});

test("血缘裁剪：可处置记录之前的血缘不动（收件箱下标要稳），转成终态后才裁", async (t) => {
  const dir = await makeWorkspace(t);
  await appendLineageRecord(dir, {
    workspaceId: "ws-1", childAgentId: "child-1", parentAgentId: "parent-1", at: AT, retention: { now: AT },
  });
  await appendLineageRecord(dir, {
    workspaceId: "ws-1", childAgentId: "child-2", parentAgentId: "parent-1", at: AT, retention: { now: AT },
  });
  await appendCoordination(dir, record({ paths: ["server/a.ts"] }));

  // 下标 2 还是 pending：下标 0 / 1 的血缘暂时不能删。
  const guarded = await pruneLineageRecords(dir, { now: AT, maxRecords: 0 });
  assert.equal(guarded.ok && guarded.removed, 0);
  assert.equal((await readCoordination(dir)).records.length, 3);

  // 请求转终态后，可处置记录不再存在，裁剪才生效。
  assert.equal((await cancelCoordination(dir, 2)).ok, true);
  const pruned = await pruneLineageRecords(dir, { now: AT, maxRecords: 0 });
  assert.equal(pruned.ok && pruned.removed, 2);
  assert.deepEqual(
    (await readCoordination(dir)).records.map((item) => item.kind),
    ["territory"],
  );
});

test("血缘裁剪：保留策略不合法时明确报错，一条不删", async (t) => {
  const dir = await makeWorkspace(t);
  await appendLineageRecord(dir, {
    workspaceId: "ws-1", childAgentId: "child-1", parentAgentId: "parent-1", at: AT, retention: { now: AT },
  });
  for (const options of [{ maxRecords: -1 }, { maxRecords: 1.5 }, { maxAgeMs: -1 }, { now: "不是时间" }]) {
    const result = await pruneLineageRecords(dir, options);
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.equal(typeof result.detail, "string");
  }
  assert.equal((await readCoordination(dir)).records.length, 1);
});

test("血缘追加自带裁剪：刚写的一条一定落地，超出上限的旧行被删", async (t) => {
  const dir = await makeWorkspace(t);
  for (let index = 0; index < 3; index += 1) {
    await appendLineageRecord(dir, {
      workspaceId: "ws-1", childAgentId: `child-${index}`, parentAgentId: "parent-1", at: AT,
      retention: { now: AT, maxRecords: 2 },
    });
  }
  const read = await readCoordination(dir);
  assert.deepEqual(read.records.map((item) => item.sessionAgentId), ["child-1", "child-2"]);
});
