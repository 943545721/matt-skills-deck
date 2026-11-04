import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectStaffHistory,
  DEFAULT_HISTORY_CHARS,
  MAX_HISTORY_ENTRY_CHARS,
  renderHistory,
  TRUNCATED_NOTICE,
} from "../server/staff-history.ts";

/**
 * 岗位履历的口径：
 * - 反查必须带 `includeArchived`（岗位会话干完就归档，漏了履历安静地少一半）；
 * - 工作区在内存里过滤（`list` 的 filter 没有 workspace 这一维）；
 * - 最近 5 条、倒序、整段 2000 字封顶；
 * - 任何读取失败都只进 warnings，绝不挡派单。
 */

async function makeWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-staff-history-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function putHandoff(dir, record) {
  const file = path.join(dir, ".deck", "handoffs", `${record.agentId}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

function handoff(agentId, overrides = {}) {
  return {
    version: 1,
    agentId,
    status: "completed",
    summary: `${agentId} 干完了`,
    done: ["改了 A", "改了 B"],
    files: ["server/a.ts"],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function agent(id, workspaceId, createdAt) {
  return { id, workspaceId, createdAt };
}

/** 假宿主：只实现 agents.list，并把每次调用的参数记下来。 */
function fakePaseo(agents, calls = []) {
  return {
    calls,
    paseo: {
      agents: {
        list: async (options) => {
          calls.push(options);
          return { entries: agents.map((item) => ({ agent: item })) };
        },
      },
    },
  };
}

test("反查按 deck.staff 标签，includeArchived 在 filter 里", async (t) => {
  const dir = await makeWorkspace(t);
  await putHandoff(dir, handoff("agent-1", { summary: "上次修了登录" }));
  const { paseo, calls } = fakePaseo([agent("agent-1", "ws-1", "2026-01-01T00:00:00.000Z")]);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].filter.labels["deck.staff"], "backend");
  // 关键断言：在 filter 里面。写成顶层参数宿主会忽略，归档会话就永远查不到。
  assert.equal(calls[0].filter.includeArchived, true);
  assert.equal(calls[0].includeArchived, undefined);
  assert.equal(result.text.includes("上次修了登录"), true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.count, 1);
});

test("跨工作区的同名岗位不计入：list 没有 workspace 维，必须在内存里过滤", async (t) => {
  const dir = await makeWorkspace(t);
  await putHandoff(dir, handoff("mine", { summary: "本区的活" }));
  await putHandoff(dir, handoff("theirs", { summary: "别区的活" }));
  const { paseo } = fakePaseo([
    agent("mine", "ws-1", "2026-01-02T00:00:00.000Z"),
    agent("theirs", "ws-2", "2026-01-03T00:00:00.000Z"),
  ]);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
  });

  assert.equal(result.text.includes("本区的活"), true);
  assert.equal(result.text.includes("别区的活"), false);
  assert.equal(result.count, 1);
});

test("最近 5 条上限，并按 createdAt 倒序拼装", async (t) => {
  const dir = await makeWorkspace(t);
  const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    await putHandoff(dir, handoff(id, { summary: `第${index + 1}次` }));
  }
  const { paseo } = fakePaseo(
    ids.map((id, index) => agent(id, "ws-1", `2026-01-0${index + 1}T00:00:00.000Z`)),
  );

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
  });

  assert.equal(result.count, 5);
  // 7..3 在，2、1 被上限挡掉。
  for (const n of [3, 4, 5, 6, 7]) assert.equal(result.text.includes(`第${n}次`), true, `缺第${n}次`);
  for (const n of [1, 2]) assert.equal(result.text.includes(`第${n}次`), false, `不该有第${n}次`);
  const positions = [7, 6, 5, 4, 3].map((n) => result.text.indexOf(`第${n}次`));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test("limit 可调：只取最近 2 条", async (t) => {
  const dir = await makeWorkspace(t);
  await putHandoff(dir, handoff("old", { summary: "旧的" }));
  await putHandoff(dir, handoff("new", { summary: "新的" }));
  const { paseo } = fakePaseo([
    agent("old", "ws-1", "2026-01-01T00:00:00.000Z"),
    agent("new", "ws-1", "2026-01-02T00:00:00.000Z"),
  ]);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
    limit: 1,
  });

  assert.equal(result.count, 1);
  assert.equal(result.text.includes("新的"), true);
  assert.equal(result.text.includes("旧的"), false);
});

test("2000 字封顶：按时间截断并留下「更早的没列」", async (t) => {
  const dir = await makeWorkspace(t);
  const long = "很长的活".repeat(200); // 800 字
  const ids = ["h1", "h2", "h3", "h4", "h5"];
  for (let index = 0; index < ids.length; index += 1) {
    await putHandoff(dir, handoff(ids[index], { summary: `第${index + 1}段${long}` }));
  }
  const { paseo } = fakePaseo(
    ids.map((id, index) => agent(id, "ws-1", `2026-01-0${index + 1}T00:00:00.000Z`)),
  );

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
  });

  assert.equal(result.text.length <= DEFAULT_HISTORY_CHARS, true, `超长：${result.text.length}`);
  assert.equal(result.text.includes(TRUNCATED_NOTICE), true);
  assert.equal(result.text.includes("第5段"), true);
  assert.equal(result.text.includes("第1段"), false);
});

test("纯函数：空履历返回空串，截断与倒序与外层一致", () => {
  assert.equal(renderHistory([], 2000), "");

  const entries = [
    { agentId: "a", createdAt: "2026-01-01T00:00:00.000Z", status: "completed", summary: "旧的", done: [], files: [] },
    { agentId: "b", createdAt: "2026-01-02T00:00:00.000Z", status: "blocked", summary: "新的", done: ["做了"], files: [] },
  ];
  const text = renderHistory(entries, 2000);
  assert.equal(text.indexOf("新的") < text.indexOf("旧的"), true);
  assert.equal(text.includes("blocked"), true);
  assert.equal(text.includes("完成：做了"), true);

  const huge = "字".repeat(400);
  const many = [1, 2, 3, 4, 5].map((n) => ({
    agentId: `x${n}`,
    createdAt: `2026-01-0${n}T00:00:00.000Z`,
    status: "completed",
    summary: huge,
    done: [],
    files: [],
  }));
  const clipped = renderHistory(many, 900);
  assert.equal(clipped.length <= 900, true);
  assert.equal(clipped.includes(TRUNCATED_NOTICE), true);
});

test("纯函数：最新一条自己就超长时，截字后仍保住完整的「更早的没列」", () => {
  const text = renderHistory(
    [
      {
        agentId: "huge",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        summary: "字".repeat(5000),
        done: [],
        files: [],
      },
    ],
    200,
  );
  assert.equal(text.length <= 200, true);
  assert.equal(text.includes(TRUNCATED_NOTICE), true);
});

test("没有历史：返回空串，调用方据此不写空段", async (t) => {
  const dir = await makeWorkspace(t);
  const { paseo } = fakePaseo([]);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
  });

  assert.equal(result.text, "");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.count, 0);
});

test("坏 JSON 只记 warning，不抛出、不影响其它条目", async (t) => {
  const dir = await makeWorkspace(t);
  await putHandoff(dir, handoff("good", { summary: "好的一份" }));
  const broken = path.join(dir, ".deck", "handoffs", "bad.json");
  await mkdir(path.dirname(broken), { recursive: true });
  await writeFile(broken, "{ 这不是 JSON", "utf8");
  const { paseo } = fakePaseo([
    agent("good", "ws-1", "2026-01-01T00:00:00.000Z"),
    agent("bad", "ws-1", "2026-01-02T00:00:00.000Z"),
  ]);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
  });

  assert.equal(result.text.includes("好的一份"), true);
  assert.equal(result.count, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /bad/);
  assert.match(result.warnings[0], /回传件/);
});

test("创建时间读不出来、条目形状不对：只记 warning", async (t) => {
  const dir = await makeWorkspace(t);
  await putHandoff(dir, handoff("good", { summary: "能读的一条" }));
  const { paseo } = fakePaseo([
    agent("good", "ws-1", "2026-01-01T00:00:00.000Z"),
    agent("no-time", "ws-1", ""),
  ]);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
  });
  assert.equal(result.text.includes("能读的一条"), true);
  assert.equal(result.count, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /no-time/);
  assert.match(result.warnings[0], /创建时间/);

  // entries 里混入空壳：不抛，提醒有一条形状不对。
  const malformed = {
    agents: {
      list: async () => ({ entries: [{}, { agent: { id: "" } }, { agent: { id: "good", workspaceId: "ws-1", createdAt: "2026-01-01T00:00:00.000Z" } }] }),
    },
  };
  const second = await collectStaffHistory(malformed, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
  });
  assert.equal(second.count, 1);
  assert.equal(second.warnings.length, 1);
  assert.match(second.warnings[0], /形状不对/);
});

test("没给岗位 id：直接空串，不去查宿主", async () => {
  const calls = [];
  const { paseo } = fakePaseo([], calls);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "   ",
    workspaceDir: "/tmp/whatever",
  });

  assert.equal(result.text, "");
  assert.equal(calls.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /没有岗位 id/);
});

test("agents.list 抛错只记 warning：履历失败不挡派单", async () => {
  const paseo = {
    agents: {
      list: async () => {
        throw new Error("daemon 掉线");
      },
    },
  };

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: "/tmp/does-not-matter",
  });

  assert.equal(result.text, "");
  assert.equal(result.count, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /daemon 掉线/);
});

test("单条超过 2000 字时截断这一条，不影响「最近」的判定", () => {
  const huge = "字".repeat(MAX_HISTORY_ENTRY_CHARS + 500);
  const text = renderHistory(
    [
      {
        agentId: "huge",
        createdAt: "2026-01-02T00:00:00.000Z",
        status: "completed",
        summary: huge,
        done: [],
        files: [],
      },
      {
        agentId: "small",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        summary: "短的一条",
        done: [],
        files: [],
      },
    ],
    // 故意给足总字数，证明截断发生在单条而不是整段。
    DEFAULT_HISTORY_CHARS * 10,
  );

  assert.equal(text.includes("短的一条"), true);
  assert.equal(text.includes("字".repeat(MAX_HISTORY_ENTRY_CHARS + 1)), false);
  const firstBlock = text.split("\n\n").find((block) => block.includes("completed"));
  assert.equal(firstBlock.length <= MAX_HISTORY_ENTRY_CHARS, true);
  assert.equal(firstBlock.endsWith("…"), true);
});

test("回传件目录根本不存在：返回空结果且不抛", async () => {
  const { paseo } = fakePaseo([agent("gone", "ws-1", "2026-01-01T00:00:00.000Z")]);
  const missing = path.join(tmpdir(), `deck-staff-history-missing-${process.pid}-${Date.now()}`);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: missing,
  });

  assert.equal(result.text, "");
  assert.equal(result.count, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /gone/);
});

test("最近几个会话没写回传件时，继续往前翻够 N 条真实履历", async (t) => {
  const dir = await makeWorkspace(t);
  // s1..s4 有回传件，s5..s7 没写（失败/取消）。只看最近 3 个会话会一条履历都拿不到。
  for (const id of ["s1", "s2", "s3", "s4"]) {
    await putHandoff(dir, handoff(id, { summary: `${id} 的履历` }));
  }
  const { paseo } = fakePaseo(
    [1, 2, 3, 4, 5, 6, 7].map((n) =>
      agent(`s${n}`, "ws-1", `2026-01-0${n}T00:00:00.000Z`),
    ),
  );

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
    limit: 3,
  });

  assert.equal(result.count, 3);
  assert.equal(result.text.includes("s4 的履历"), true);
  assert.equal(result.text.includes("s3 的履历"), true);
  assert.equal(result.text.includes("s2 的履历"), true);
  assert.equal(result.text.includes("s1 的履历"), false);
  // s5..s7 缺失聚合成一条 warning，不挡结果，也不把派单的 warnings 刷屏。
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /s5/);
  assert.match(result.warnings[0], /3 个/);
});

test("「最近」按回传件时间排：开工早、收尾晚的会话算新的", async (t) => {
  const dir = await makeWorkspace(t);
  await putHandoff(
    dir,
    handoff("long", { summary: "长会话最后收尾", createdAt: "2026-03-01T00:00:00.000Z" }),
  );
  await putHandoff(
    dir,
    handoff("short", { summary: "短会话先收尾", createdAt: "2026-02-01T00:00:00.000Z" }),
  );
  const { paseo } = fakePaseo([
    agent("long", "ws-1", "2026-01-01T00:00:00.000Z"),
    agent("short", "ws-1", "2026-02-15T00:00:00.000Z"),
  ]);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: dir,
    limit: 1,
  });

  assert.equal(result.count, 1);
  assert.equal(result.text.includes("长会话最后收尾"), true);
  assert.equal(result.text.includes("短会话先收尾"), false);
});

test("可注入读取器：不碰文件系统也能取履历，读取器抛错只跳过这一条", async () => {
  const { paseo } = fakePaseo([
    agent("ok", "ws-1", "2026-01-02T00:00:00.000Z"),
    agent("boom", "ws-1", "2026-01-01T00:00:00.000Z"),
  ]);
  const asked = [];
  const readHandoff = async (_dir, agentId) => {
    asked.push(agentId);
    if (agentId === "boom") throw new Error("盘坏了");
    return handoff(agentId, { summary: "注入读到的履历" });
  };

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: "/tmp/never-touched",
    readHandoff,
  });

  assert.deepEqual(asked, ["ok", "boom"]);
  assert.equal(result.text.includes("注入读到的履历"), true);
  assert.equal(result.count, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /boom/);
  assert.match(result.warnings[0], /盘坏了/);
});

/** 带 `deck.ticket` 标签的会话条目，形状与宿主一致。 */
function agentWithTicket(id, workspaceId, createdAt, ticket) {
  return {
    id,
    workspaceId,
    createdAt,
    labels: { "deck.staff": "backend", ...(ticket ? { "deck.ticket": ticket } : {}) },
  };
}

function openTicket(number, state = "OPEN") {
  return { number, title: `标题${number}`, state };
}

test("未关闭的票并进履历，已关的票不进", async () => {
  const { paseo } = fakePaseo([
    agentWithTicket("a", "ws-1", "2026-01-02T00:00:00.000Z", "#12"),
    agentWithTicket("b", "ws-1", "2026-01-01T00:00:00.000Z", "#7"),
    agentWithTicket("c", "ws-1", "2026-01-03T00:00:00.000Z", "#3"),
  ]);
  const byNumber = { 12: openTicket(12), 7: openTicket(7), 3: openTicket(3, "CLOSED") };

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: "/tmp/never-touched",
    readHandoff: async (_dir, agentId) => handoff(agentId),
    readTicket: async (_dir, _repoKey, number) => byNumber[number],
  });

  assert.match(result.text, /未关闭的票：#12 标题12/);
  assert.match(result.text, /未关闭的票：#7 标题7/);
  assert.equal(result.text.includes("#3"), false);
  // 票号倒序：12 在 7 前面。
  assert.equal(result.text.indexOf("#12") < result.text.indexOf("#7"), true);
  assert.deepEqual(result.openTickets.map((ticket) => ticket.number), [12, 7]);
  // 已关的票只进聚合 warning，不算失败，但也不进文本。
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /已关闭/);
});

test("读票抛异常只进 warnings，不抛出、不影响其它票", async () => {
  const { paseo } = fakePaseo([
    agentWithTicket("a", "ws-1", "2026-01-02T00:00:00.000Z", "#5"),
    agentWithTicket("b", "ws-1", "2026-01-01T00:00:00.000Z", "#4"),
  ]);

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: "/tmp/never-touched",
    readHandoff: async (_dir, agentId) => handoff(agentId),
    readTicket: async (_dir, _repoKey, number) => {
      if (number === 5) throw new Error("gh 掉线");
      return openTicket(number);
    },
  });

  assert.equal(result.text.includes("#5"), false);
  assert.match(result.text, /未关闭的票：#4 标题4/);
  assert.deepEqual(result.openTickets.map((ticket) => ticket.number), [4]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /gh 掉线/);
  assert.match(result.warnings[0], /#5/);
});

test("同一张票被多个会话引用时只读一次、只列一次", async () => {
  const { paseo } = fakePaseo([
    agentWithTicket("a", "ws-1", "2026-01-03T00:00:00.000Z", "#12"),
    agentWithTicket("b", "ws-1", "2026-01-02T00:00:00.000Z", "#12"),
    agentWithTicket("c", "ws-1", "2026-01-01T00:00:00.000Z", "#5"),
  ]);
  const asked = [];

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: "/tmp/never-touched",
    readHandoff: async (_dir, agentId) => handoff(agentId),
    readTicket: async (_dir, _repoKey, number) => {
      asked.push(number);
      return openTicket(number);
    },
  });

  assert.deepEqual(asked, [12, 5]);
  assert.deepEqual(result.openTickets.map((ticket) => ticket.number), [12, 5]);
  assert.equal(result.text.split("未关闭的票：#12").length - 1, 1);
});

test("没有 deck.ticket 标签时不读票", async () => {
  const { paseo } = fakePaseo([
    agentWithTicket("a", "ws-1", "2026-01-01T00:00:00.000Z", null),
  ]);
  let calls = 0;

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: "/tmp/never-touched",
    readHandoff: async (_dir, agentId) => handoff(agentId),
    readTicket: async () => {
      calls += 1;
      return openTicket(1);
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(result.openTickets, []);
  assert.equal(result.text.includes("未关闭的票"), false);
});

test("未关闭的票最多 10 张，按票号倒序", async () => {
  const numbers = [3, 12, 1, 8, 20, 5, 19, 2, 11, 7, 4, 9];
  const { paseo } = fakePaseo(
    numbers.map((number, index) =>
      agentWithTicket(`a${number}`, "ws-1", `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`, `#${number}`),
    ),
  );

  const result = await collectStaffHistory(paseo, {
    workspaceId: "ws-1",
    staffId: "backend",
    workspaceDir: "/tmp/never-touched",
    readHandoff: async (_dir, agentId) => handoff(agentId),
    readTicket: async (_dir, _repoKey, number) => openTicket(number),
  });

  assert.deepEqual(
    result.openTickets.map((ticket) => ticket.number),
    [20, 19, 12, 11, 9, 8, 7, 5, 4, 3],
  );
  const positions = result.openTickets.map((ticket) => result.text.indexOf(`#${ticket.number} `));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test("票也受 maxChars 约束：只在整行边界截断并留下「更早的没列」", () => {
  const tickets = [9, 8, 7, 6, 5, 4, 3, 2, 1].map((number) => ({
    number,
    title: `标题${number}`,
  }));
  const maxChars = 130;
  const text = renderHistory([], maxChars, tickets);

  assert.equal(text.length <= maxChars, true, `超长：${text.length}`);
  assert.equal(text.includes(TRUNCATED_NOTICE), true);
  const ticketLines = text.split("\n").filter((line) => line.startsWith("未关闭的票："));
  assert.equal(ticketLines.length > 0, true);
  // 每一张被保留的票都是完整一行，没有半句标题。
  for (const line of ticketLines) assert.match(line, /^未关闭的票：#\d+ 标题\d+$/);
  // 被截掉的票整张消失，不留残行。
  assert.equal(text.includes("#1 标题1"), false);
});

