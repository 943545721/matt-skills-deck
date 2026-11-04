import assert from "node:assert/strict";
import test from "node:test";
import { listArchivedAgents } from "../server/archived-agents.ts";
import { filterArchivedRows, mergeArchivedRows } from "../client/deck/surfaces/orchestration/archivedFilter.ts";

/**
 * 「已归档会话」清单（`deck.orchestration.archived`）与它的本地筛选。
 *
 * 这一页存在的理由只有一个：归档之后会话从默认列表里消失了，而宿主**没有**
 * 取消归档的接口，恢复得靠 provider 会话 id 去 import。所以这里要钉住的是：
 * - 必须真的向宿主要归档记录（`includeArchived`），否则这一页永远是空的；
 * - 归档列表是**跨全部工作区**的，本工作区的记录可能排在后面：必须往后翻页；
 * - 必须把 provider 会话 id 与恢复命令摊开，缺 id 时如实说明而不是给半条命令；
 * - 命令里的每个参数都要能安全粘进终端；
 * - 只看本工作区，且宿主读失败时明确报错，不假装「没有已归档会话」。
 */

const WS = "ws-1";
const DIR = "/repo";

function entry(agent) {
  return { agent };
}

/**
 * 分页版的假宿主：`pages` 一次给一页，游标由测试指定。
 * `hasMore` 与 `nextCursor` 分开给，是为了能钉住「说了还有更多却没给游标」这条死路。
 */
function fakePaseo({ entries = [], hasMore = false, nextCursor = null, listError, calls } = {}) {
  const seen = calls ?? [];
  return {
    calls: seen,
    paseo: {
      agents: {
        list: async (options) => {
          seen.push(options);
          if (listError) throw listError;
          return { entries, pageInfo: { hasMore, nextCursor, prevCursor: null } };
        },
      },
    },
  };
}

/** 按游标翻页的假宿主：第 N 次调用回第 N 页。 */
function pagedPaseo(pages) {
  const calls = [];
  return {
    calls,
    paseo: {
      agents: {
        list: async (options) => {
          calls.push(options);
          const page = pages[Math.min(calls.length - 1, pages.length - 1)];
          return {
            entries: page.entries.map(entry),
            pageInfo: { hasMore: Boolean(page.nextCursor), nextCursor: page.nextCursor ?? null, prevCursor: null },
          };
        },
      },
    },
  };
}

const archived = (patch = {}) => ({
  id: "agent-1",
  workspaceId: WS,
  cwd: DIR,
  title: "派单窗口",
  provider: "claude",
  model: "sonnet",
  status: "closed",
  updatedAt: "2026-11-01T10:00:00.000Z",
  archivedAt: "2026-11-02T09:00:00.000Z",
  labels: {},
  persistence: { provider: "claude", sessionId: "sess-abc" },
  ...patch,
});

test("已归档：向宿主要归档记录，只留下真的归档了的会话", async () => {
  const fake = fakePaseo({
    entries: [entry(archived()), entry({ id: "agent-live", workspaceId: WS, cwd: DIR, title: "还活着" })],
  });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].filter.includeArchived, true, "不带这个词，这一页永远是空的");
  assert.deepEqual(
    result.rows.map((row) => row.agentId),
    ["agent-1"],
    "没归档的会话不该出现在这里",
  );
});

test("已归档：只列本工作区的会话", async () => {
  const fake = fakePaseo({
    entries: [
      entry(archived()),
      entry(archived({ id: "agent-other", workspaceId: "ws-2", cwd: "/elsewhere" })),
      entry(archived({ id: "agent-by-cwd", workspaceId: null, cwd: DIR })),
    ],
  });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.rows.map((row) => row.agentId).sort(),
    ["agent-1", "agent-by-cwd"],
    "归属靠 workspaceId，没有就用 cwd 兜底",
  );
});

test("已归档：给出 provider 会话 id 与一条能直接粘进终端的恢复命令", async () => {
  const fake = fakePaseo({
    entries: [
      entry(
        archived({
          cwd: "/repo dir",
          labels: { "deck.role": "dispatcher", "deck.role.window": "1", "paseo.parent-agent-id": "parent-1" },
        }),
      ),
    ],
  });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  const row = result.rows[0];
  assert.equal(row.sessionId, "sess-abc");
  assert.equal(row.restoreBlocked, null);
  assert.equal(
    row.restoreCommand,
    "paseo import sess-abc --provider claude --cwd '/repo dir' --label deck.role=dispatcher --label deck.role.window=1",
    "目录带空格要引起来；只带 deck 自己的标签（父会话关系带不回已归档的窗口）",
  );
});

test("已归档：命令里带引号或空格的参数各自只被当一个词", async () => {
  const fake = fakePaseo({
    entries: [entry(archived({ cwd: "/tmp/it's here", labels: { "deck.role": "it's mine" } }))],
  });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.equal(
    result.rows[0].restoreCommand,
    "paseo import sess-abc --provider claude --cwd '/tmp/it'\\''s here' --label 'deck.role=it'\\''s mine'",
    "单引号要靠 '\\'' 收住，否则粘进终端会提前截断参数",
  );
});

test("已归档：带 # 的参数要引起来，免得被当成注释", async () => {
  const fake = fakePaseo({ entries: [entry(archived({ labels: { "deck.role": "#dispatch" } }))] });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.match(
    result.rows[0].restoreCommand,
    /--label 'deck.role=#dispatch'$/,
    "词首的 # 在交互式 shell 里会把后面整段参数吃掉",
  );
});

test("已归档：id 以 - 开头时不拼命令（引号救不回来，会被当成选项）", async () => {
  const fake = fakePaseo({ entries: [entry(archived({ persistence: { provider: "claude", sessionId: "-abc" } }))] });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.equal(result.rows[0].sessionId, "-abc", "id 还是要列出来：用户至少能看见");
  assert.equal(result.rows[0].restoreCommand, null);
  assert.match(result.rows[0].restoreBlocked ?? "", /以 - 开头/);
});

test("已归档：没有 provider 会话 id 时不给半条命令，并说明原因", async () => {
  const fake = fakePaseo({ entries: [entry(archived({ persistence: null }))] });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  const row = result.rows[0];
  assert.equal(row.agentId, "agent-1", "记录本身还是要列出来：用户至少知道有这么一条");
  assert.equal(row.sessionId, null);
  assert.equal(row.restoreCommand, null);
  assert.match(row.restoreBlocked ?? "", /没有 provider 会话 id/);
  assert.ok(result.warnings.some((line) => line.includes("给不出恢复命令")));
});

test("已归档：没有客户端 id 或目录时不拼残命令", async () => {
  const fake = fakePaseo({
    entries: [entry(archived({ provider: "  " })), entry(archived({ id: "agent-2", cwd: null }))],
  });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  for (const row of result.rows) {
    assert.equal(row.restoreCommand, null, "缺一位就不拼，半条命令比没有更糟");
    assert.ok(row.restoreBlocked);
  }
});

test("已归档：归档时间新的排在前面", async () => {
  const fake = fakePaseo({
    entries: [
      entry(archived({ id: "old", archivedAt: "2026-10-01T00:00:00.000Z" })),
      entry(archived({ id: "new", archivedAt: "2026-11-02T00:00:00.000Z" })),
      entry(archived({ id: "mid", archivedAt: "2026-10-20T00:00:00.000Z" })),
    ],
  });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map((row) => row.agentId), ["new", "mid", "old"]);
});

test("已归档：第一页没有本工作区的记录时继续往后翻", async () => {
  const fake = pagedPaseo([
    {
      entries: [archived({ id: "agent-other", workspaceId: "ws-2", cwd: "/elsewhere" })],
      nextCursor: "cursor-2",
    },
    { entries: [archived({ id: "agent-mine" })] },
  ]);
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 2, "第一页被别的仓库占满时，本工作区的记录还在后面");
  assert.equal(fake.calls[1].page.cursor, "cursor-2", "第二页要带上宿主给的游标");
  assert.deepEqual(result.rows.map((row) => row.agentId), ["agent-mine"]);
  assert.equal(result.truncated, false);
});

test("已归档：两页之间有重叠的记录只出现一次", async () => {
  const fake = pagedPaseo([
    { entries: [archived({ id: "agent-1" })], nextCursor: "cursor-2" },
    { entries: [archived({ id: "agent-1" }), archived({ id: "agent-2" })] },
  ]);
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.rows.map((row) => row.agentId).sort(),
    ["agent-1", "agent-2"],
    "宿主翻页时可能有重叠（会话在翻页途中被归档），重复会让界面同一行出现两次",
  );
});

test("已归档：翻到上限还没读完时交出游标，界面可以继续往前读", async () => {
  const fake = pagedPaseo([
    { entries: [archived({ id: "agent-other", workspaceId: "ws-2", cwd: "/elsewhere" })], nextCursor: "cursor-2" },
  ]);
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 5, "翻页有上限，不能把宿主的存档一路拖到底");
  assert.equal(result.truncated, true);
  assert.equal(result.nextCursor, "cursor-2", "没读完就要留一条继续往前的路");
  assert.deepEqual(result.rows, []);
  assert.ok(
    result.warnings.some((line) => line.includes("更早的归档还没读")),
    "没读到 ≠ 没有：这种情况必须说清楚",
  );
  assert.ok(
    result.warnings.some((line) => line.includes("5")),
    "警告里要带这次实际读了多少条",
  );
});

test("已归档：带游标时从那一批之后接着读", async () => {
  const fake = pagedPaseo([{ entries: [archived({ id: "agent-older" })] }]);
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR, cursor: "cursor-9" });

  assert.equal(result.ok, true);
  assert.equal(fake.calls[0].page.cursor, "cursor-9", "续读必须从界面交回来的游标开始");
  assert.deepEqual(result.rows.map((row) => row.agentId), ["agent-older"]);
  assert.equal(result.truncated, false);
  assert.equal(result.nextCursor, null);
});

test("已归档：说了还有更多却没给游标时停下，并明说翻不动", async () => {
  const fake = fakePaseo({ entries: [entry(archived())], hasMore: true, nextCursor: null });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 1, "没有游标就翻不动，不能空转");
  assert.equal(result.truncated, true, "翻了不动也还是没读完，不能报成读完了");
  assert.equal(result.nextCursor, null);
  assert.equal(result.rows.length, 1);
  assert.ok(result.warnings.some((line) => line.includes("没给游标")));
});

test("已归档：客户端现在不可用的记录要标出来", async () => {
  const fake = fakePaseo({ entries: [entry(archived({ providerUnavailable: true }))] });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, true);
  assert.equal(result.rows[0].providerUnavailable, true);
  assert.ok(result.warnings.some((line) => line.includes("不可用")));
});

test("已归档：宿主读失败时报 agents-failed，不当成「没有已归档会话」", async () => {
  const fake = fakePaseo({ listError: new Error("daemon 掉线") });
  const result = await listArchivedAgents(fake.paseo, { workspaceId: WS, workspaceDir: DIR });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "agents-failed");
  assert.match(result.detail, /daemon 掉线/);
});

test("已归档：空工作区参数直接拒绝", async () => {
  const fake = fakePaseo();
  const result = await listArchivedAgents(fake.paseo, { workspaceId: "  ", workspaceDir: DIR });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-workspace");
  assert.equal(fake.calls.length, 0, "参数不成立时连宿主都不该问");
});

/* 本地筛选：用户手里的 id 可能是 provider 会话 id，也可能是内部 agent id。 */
const rows = [
  { agentId: "6de6-aaaa", sessionId: "97d6-bbbb", title: "主沟通窗口", provider: "claude" },
  { agentId: "1111-cccc", sessionId: null, title: "派单窗口", provider: "codex" },
];

test("筛选：空查询原样返回，但不共享同一个数组", () => {
  const shown = filterArchivedRows(rows, "   ");
  assert.equal(shown.length, 2);
  assert.notEqual(shown, rows, "返回副本：界面拿到的不该是服务端那份数组本身");
});

test("筛选：provider 会话 id 与 agent id 都能搜到", () => {
  assert.deepEqual(filterArchivedRows(rows, "97d6").map((row) => row.agentId), ["6de6-aaaa"]);
  assert.deepEqual(filterArchivedRows(rows, "1111").map((row) => row.agentId), ["1111-cccc"]);
});

test("续读：把更早的一批接在后面，同一条不重复", () => {
  const base = [rows[0]];
  const merged = mergeArchivedRows(base, [rows[0], rows[1]]);
  assert.deepEqual(merged.map((row) => row.agentId), ["6de6-aaaa", "1111-cccc"]);
  assert.equal(merged.length, 2, "宿主两页之间可能给出重叠的记录，接的时候要去重");
});

test("筛选：标题与客户端名也认，大小写不敏感", () => {
  assert.deepEqual(filterArchivedRows(rows, "派单").map((row) => row.agentId), ["1111-cccc"]);
  assert.deepEqual(filterArchivedRows(rows, "CODEX").map((row) => row.agentId), ["1111-cccc"]);
  assert.deepEqual(filterArchivedRows(rows, "没有这个"), []);
});
