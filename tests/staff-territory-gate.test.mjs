import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerHooks, resetStaffTerritoryGateForTest } from "../server/hooks.ts";
import { appendGroup } from "../server/group-store.ts";
import { listLogs, resetLogs } from "../server/logs.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";
import { appendCoordination, appendLineageRecord, readCoordination, requestCoordination } from "../server/staff-territory.ts";
import { rememberStaffSession } from "../server/staff-sessions.ts";
import {
  orchestrationInboxActHandler,
  orchestrationInboxHandler,
} from "../server/rpc/orchestration.ts";

/**
 * 第 4 批：越界拦截 + 协调收件箱。
 *
 * 钉住的是这一批最容易「看起来做了」的四件事：
 * 1. 员工写出自己的区会被 deny，并且收件箱里真的有一条；
 * 2. read / search / shell 不被当成越界（shell 的放行要能在日志里看出来）；
 * 3. 没有证据（detail 缺失）时既不自动放行、也不 deny；
 * 4. 越界闸先注册、自动放行后跑——开了自动放行，deny 也不会被翻回来。
 */

const ROSTER = [
  { id: "back", name: "后端", kind: "manager", paths: ["server"], duty: "负责后端接口与数据库" },
  { id: "front", name: "前端", kind: "worker", paths: ["web"], duty: "负责页面与交互" },
];

function orchestrationSettings() {
  return {
    version: 1,
    updatedAt: "2026-11-04T00:00:00.000Z",
    workspaceId: "ws-1",
    roles: [{ workspaceId: "ws-1", staff: ROSTER }],
    routing: [],
    maxDepth: 3,
    maxChildrenPerDispatch: 4,
    reportOnFinish: true,
  };
}

async function makeWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-territory-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".deck"), { recursive: true });
  await writeFile(
    path.join(dir, ".deck", "orchestration.json"),
    JSON.stringify(orchestrationSettings()),
    "utf8",
  );
  return dir;
}

/** 按注册顺序保存同一个事件的所有处理函数——顺序本身就是这道闸的一半。 */
function fakeServer() {
  const handlers = new Map();
  const push = (name, handler) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  };
  return {
    handlers,
    before(name, handler) {
      push(`before:${name}`, handler);
    },
    on(name, handler) {
      push(`on:${name}`, handler);
    },
  };
}

function permissionHandlers() {
  const server = fakeServer();
  registerHooks(server);
  const handlers = server.handlers.get("on:agent.permission_requested") ?? [];
  assert.equal(handlers.length, 2, "同一事件上必须有两个处理函数：越界闸在前，自动放行在后");
  return handlers;
}

/** 宿主替身：deny 过的请求会真的消失，第二条 allow 会像真宿主那样报 No pending permission request。 */
function fakePaseo() {
  const pending = new Set();
  const calls = [];
  return {
    pending,
    calls,
    agents: {
      ref: (agentId) => ({
        respondToPermission: async ({ requestId, response }) => {
          calls.push({ agentId, requestId, response });
          if (!pending.has(requestId)) {
            throw new Error(`No pending permission request with id ${requestId}`);
          }
          pending.delete(requestId);
        },
      }),
    },
  };
}

const context = (paseo) => ({ paseo, signal: new AbortController().signal });

/**
 * 转派用的宿主替身：会话清单、续发、新建三条路各留一个可断言的篮子。
 *
 * `sessions` 是目标岗位已在跑的会话；`original` 是原会话（用来带票号与父会话）。
 * `sendError` / `createError` 用来验证「派活失败不能改状态」。
 */
function reassignPaseo({ sessions = [], original = null, sendError, createError, config = {} } = {}) {
  const sent = [];
  const created = [];
  const listFilters = [];
  const paseo = {
    sent,
    created,
    listFilters,
    config: {
      get: async () => ({ config }),
    },
    agents: {
      list: async ({ filter = {} } = {}) => {
        listFilters.push(filter);
        const wanted = filter.labels?.["deck.staff"];
        const candidates = wanted
          ? sessions.filter((item) => item.labels?.["deck.staff"] === wanted)
          : sessions;
        const visible = candidates.filter(
          (item) => filter.includeArchived === true || !item.archivedAt,
        );
        if (wanted || filter.includeArchived) {
          const entries = visible.map((item) => ({ agent: item }));
          if (original && !wanted) entries.push({ agent: original });
          return { entries };
        }
        return { entries: [] };
      },
      ref: (agentId) => ({
        send: async (prompt) => {
          if (sendError) throw new Error(sendError);
          sent.push({ agentId, prompt });
        },
      }),
    },
    workspaces: {
      ref: (workspaceId) => ({
        agents: {
          create: async (options) => {
            if (createError) throw new Error(createError);
            created.push({ workspaceId, options });
            return { id: "new-back-session" };
          },
        },
      }),
    },
  };
  return { paseo, sent, created, listFilters };
}

async function writeRouting(dir, routing, extra = {}) {
  await writeFile(
    path.join(dir, ".deck", "orchestration.json"),
    JSON.stringify({ ...orchestrationSettings(), routing, ...extra }),
    "utf8",
  );
}

const agent = (dir, overrides = {}) => ({
  id: "agent-1",
  workspaceId: "ws-1",
  parentAgentId: "parent-1",
  provider: "claude",
  cwd: dir,
  title: "前端会话",
  labels: { "deck.staff": "front" },
  ...overrides,
});

const request = (detail, overrides = {}) => ({
  id: "perm-1",
  provider: "claude",
  name: "Edit",
  kind: "tool",
  title: "给登录接口加验证码校验",
  ...(detail === undefined ? {} : { detail }),
  ...overrides,
});

function useSettings(t, overrides) {
  setSettingsForTest({ ...DEFAULT_SETTINGS, ...overrides });
  resetStaffTerritoryGateForTest();
  resetLogs();
  t.after(() => {
    setSettingsForTest(DEFAULT_SETTINGS);
    resetStaffTerritoryGateForTest();
    resetLogs();
  });
}

function logs() {
  return listLogs(200).map((entry) => entry.message).join("\n");
}

const record = (overrides = {}) => ({
  at: new Date().toISOString(),
  kind: "territory",
  workspaceId: "ws-1",
  fromStaff: "front",
  toStaff: "back",
  paths: ["server/api/user.ts"],
  sessionAgentId: "agent-1",
  taskSummary: "给登录接口加验证码校验",
  state: "pending",
  ...overrides,
});

/* ------------------------------------------------------------------ 权限闸 */

test("员工写到别人的区：拒绝并落一条 territory 请求", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: false });
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  paseo.pending.add("perm-1");
  const [territory] = permissionHandlers();

  await territory(
    { agent: agent(dir), request: request({ type: "edit", filePath: path.join(dir, "server/api/user.ts") }) },
    context(paseo),
  );

  assert.equal(paseo.calls.length, 1, "越界写要被拒绝");
  assert.equal(paseo.calls[0].response.behavior, "deny");
  assert.match(paseo.calls[0].response.message, /back/, "说明里要指出这片归谁");
  assert.match(paseo.calls[0].response.message, /协调/, "拒绝的下一步是协调，不是「禁止」");

  const read = await readCoordination(dir);
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0].kind, "territory");
  assert.equal(read.records[0].state, "pending");
  assert.equal(read.records[0].fromStaff, "front");
  assert.equal(read.records[0].toStaff, "back");
  assert.deepEqual(read.records[0].paths, ["server/api/user.ts"]);
  assert.ok(logs().includes("越界写已拒绝"));
});

test("同一会话同一目标区的一批路径合成一条 pending，不刷屏", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: false });
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  const [territory] = permissionHandlers();

  for (const [id, file] of [
    ["perm-1", "server/api/a.ts"],
    ["perm-2", "server/api/b.ts"],
  ]) {
    paseo.pending.add(id);
    await territory(
      { agent: agent(dir), request: request({ type: "write", filePath: path.join(dir, file) }, { id }) },
      context(paseo),
    );
  }

  const read = await readCoordination(dir);
  const pending = read.records.filter((item) => item.state === "pending");
  assert.equal(pending.length, 1, "同会话同目标区只留一条 pending");
  assert.deepEqual(pending[0].paths, ["server/api/a.ts", "server/api/b.ts"]);
  assert.equal(read.records.filter((item) => item.state === "superseded").length, 1);
});

test("并发落协调请求：路径合并在写锁内完成，谁都不会覆盖掉对方", async (t) => {
  const dir = await makeWorkspace(t);
  const base = {
    kind: "territory",
    workspaceId: "ws-1",
    fromStaff: "front",
    toStaff: "back",
    sessionAgentId: "agent-1",
    taskSummary: "批量改接口",
    mergePendingPaths: true,
  };
  await Promise.all([
    requestCoordination(dir, { ...base, paths: ["server/api/a.ts"] }),
    requestCoordination(dir, { ...base, paths: ["server/api/b.ts"] }),
  ]);

  const pending = (await readCoordination(dir)).records.filter((item) => item.state === "pending");
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].paths, ["server/api/a.ts", "server/api/b.ts"]);
});

test("read / search 一律不拦，也不产生协调请求", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: false });
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  const [territory] = permissionHandlers();

  await territory(
    { agent: agent(dir), request: request({ type: "read", filePath: path.join(dir, "server/api/user.ts") }) },
    context(paseo),
  );
  await territory(
    { agent: agent(dir), request: request({ type: "search", query: "server" }) },
    context(paseo),
  );

  assert.deepEqual(paseo.calls, []);
  assert.deepEqual((await readCoordination(dir)).records, []);
});

test("shell 明确选择不拦，并在日志里看得出来", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: true });
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  paseo.pending.add("perm-1");
  const handlers = permissionHandlers();

  const shellRequest = request(
    { type: "shell", command: "rm -rf server" },
    { title: "TOKEN=secret rm -rf server" },
  );
  const payload = { agent: agent(dir), request: shellRequest };
  await handlers[0](payload, context(paseo));
  await handlers[1](payload, context(paseo));

  // 闸本身不 deny；开了自动放行时这条请求照常走后面的自动放行，不是「被闸拦了」。
  assert.equal(paseo.calls.length, 1);
  assert.equal(paseo.calls[0].response.behavior, "allow");
  assert.deepEqual((await readCoordination(dir)).records, []);
  const text = logs();
  assert.ok(text.includes("shell"));
  assert.ok(text.includes("不拦"), "日志要能看出这是选择不拦，不是漏判");
  assert.ok(!text.includes("TOKEN=secret"), "shell 的标题可能是命令原文，不能抄进日志");
});

test("detail 缺失 / unknown：不自动放行，也不 deny，留给用户确认", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: true });
  const dir = await makeWorkspace(t);
  const handlers = permissionHandlers();

  for (const [id, detail] of [
    ["perm-1", undefined],
    ["perm-2", { type: "unknown" }],
  ]) {
    const paseo = fakePaseo();
    paseo.pending.add(id);
    const payload = { agent: agent(dir), request: request(detail, { id }) };
    await handlers[0](payload, context(paseo));
    await handlers[1](payload, context(paseo));
    assert.deepEqual(paseo.calls, [], `${id} 没有证据时不能替用户点头，也不能假装拒绝`);
  }

  const text = logs();
  assert.ok(text.includes("留给用户确认"));
  assert.ok(!text.includes("已自动放行"), "被闸留下的请求不能又被自动放行");
});

test("批准这一次只放行一次：用掉后同一路径再次越界仍被拒绝", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: false });
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record({ state: "approved-once" }));
  const paseo = fakePaseo();
  paseo.pending.add("perm-1");
  const [territory] = permissionHandlers();

  await territory(
    { agent: agent(dir), request: request({ type: "edit", filePath: path.join(dir, "server/api/user.ts") }) },
    context(paseo),
  );
  assert.equal(paseo.calls.length, 1);
  assert.equal(paseo.calls[0].response.behavior, "allow", "有待用批准时应当放行");
  assert.equal((await readCoordination(dir)).records[0].state, "consumed", "批准用掉后要落 consumed");

  const again = fakePaseo();
  again.pending.add("perm-2");
  await territory(
    {
      agent: agent(dir),
      request: request({ type: "edit", filePath: path.join(dir, "server/api/user.ts") }, { id: "perm-2" }),
    },
    context(again),
  );
  assert.equal(again.calls.length, 1);
  assert.equal(again.calls[0].response.behavior, "deny", "一次批准只能放行一次");
  assert.equal(logs().includes("批准已用掉"), true);
});

test("批准这一次放行整批：同一条批准里的其余路径仍可用，最后一条才转 consumed", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: false });
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record({ state: "approved-once", paths: ["server/api/a.ts", "server/api/b.ts"] }));
  const [territory] = permissionHandlers();

  const first = fakePaseo();
  first.pending.add("perm-1");
  await territory(
    { agent: agent(dir), request: request({ type: "write", filePath: path.join(dir, "server/api/a.ts") }) },
    context(first),
  );
  assert.equal(first.calls[0].response.behavior, "allow");
  let read = await readCoordination(dir);
  assert.equal(read.records[0].state, "approved-once", "同批还有路径没用完，批准记录不能整体失效");
  assert.deepEqual(read.records[0].paths, ["server/api/b.ts"], "用掉的那条路径要从批准里消掉");

  const second = fakePaseo();
  second.pending.add("perm-2");
  await territory(
    {
      agent: agent(dir),
      request: request({ type: "write", filePath: path.join(dir, "server/api/b.ts") }, { id: "perm-2" }),
    },
    context(second),
  );
  assert.equal(second.calls[0].response.behavior, "allow");
  read = await readCoordination(dir);
  assert.equal(read.records[0].state, "consumed", "最后一条用掉后转 consumed");
});

test("事件里没有 labels 时，靠岗位会话台账仍认出员工", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: false });
  const dir = await makeWorkspace(t);
  await rememberStaffSession(dir, { agentId: "agent-1", staffId: "front" });
  const paseo = fakePaseo();
  paseo.pending.add("perm-1");
  const [territory] = permissionHandlers();

  await territory(
    {
      agent: agent(dir, { labels: undefined }),
      request: request({ type: "write", filePath: path.join(dir, "server/api/user.ts") }),
    },
    context(paseo),
  );

  assert.equal(paseo.calls.length, 1, "认不出员工才是这道闸最危险的漏法");
  assert.equal(paseo.calls[0].response.behavior, "deny");
});

test("开了自动放行：越界仍是 deny，后面的 allow 落空并留下 No pending permission request", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: true });
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  paseo.pending.add("perm-1");
  const handlers = permissionHandlers();
  const payload = {
    agent: agent(dir),
    request: request({ type: "edit", filePath: path.join(dir, "server/api/user.ts") }),
  };

  // 按注册顺序跑：越界闸先注册、先跑，自动放行后跑。
  await handlers[0](payload, context(paseo));
  await handlers[1](payload, context(paseo));

  assert.equal(paseo.calls.length, 2, "先是 deny，后是自动放行那一次 allow 尝试");
  assert.equal(paseo.calls[0].response.behavior, "deny");
  assert.equal(paseo.calls[1].response.behavior, "allow");
  const text = logs();
  assert.ok(
    text.includes("No pending permission request"),
    "请求已被 deny 撤掉，第二条 allow 必须落空——这是顺序生效的正面证据",
  );
  assert.ok(!text.includes("已自动放行"), "deny 不能被翻回 allow");
});

test("宿主并发分发时，自动放行也先等闸判完，不会抢在 deny 前面 allow", async (t) => {
  useSettings(t, { backend: "local", autoAllowPermissions: true });
  const dir = await makeWorkspace(t);
  const paseo = fakePaseo();
  paseo.pending.add("perm-1");
  const handlers = permissionHandlers();
  const payload = {
    agent: agent(dir),
    request: request({ type: "edit", filePath: path.join(dir, "server/api/user.ts") }),
  };

  // 不 await 第一条就发第二条：模拟宿主不保证串行 await 的最坏情况。
  await Promise.all([
    handlers[0](payload, context(paseo)),
    handlers[1](payload, context(paseo)),
  ]);

  assert.equal(paseo.calls[0].response.behavior, "deny");
  assert.ok(
    logs().includes("No pending permission request"),
    "第二条 allow 必须撞上已经撤掉的请求",
  );
});

/* ------------------------------------------------------------------ 收件箱 RPC */

test("收件箱读取：24 小时 pending 在读取时变 cancelled，并给出 warning", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record({ at: "2020-01-01T00:00:00.000Z" }));

  const result = await orchestrationInboxHandler({ workspaceId: "ws-1", workspaceDir: dir });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].state, "cancelled");
  assert.equal(result.records[0].expired, true);
  assert.ok(result.warnings.some((warning) => warning.includes("24 小时")));
  assert.equal((await readCoordination(dir)).records[0].state, "cancelled");
});

test("收件箱读取：血缘行不进收件箱，但它的存在不打乱后面那条请求的 index", async (t) => {
  const dir = await makeWorkspace(t);
  // 先落一条血缘（文件第 0 行），再落一条真请求（第 1 行）。
  await appendLineageRecord(dir, { workspaceId: "ws-1", childAgentId: "child-1", parentAgentId: "parent-1" });
  await appendCoordination(dir, record());

  const result = await orchestrationInboxHandler({ workspaceId: "ws-1", workspaceDir: dir });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1, "血缘不该出现在收件箱");
  assert.equal(result.records[0].kind, "territory");
  // 下标仍是文件里的位置：动作 RPC 拿它定位，指错就会处置到隔壁那条。
  assert.equal(result.records[0].index, 1);
});

test("agent.created：子会话带父 id → 往协调收件箱记一条血缘", async (t) => {
  // 空名册的工作区：岗位闸会早退，血缘记录必须发生在它之前才留得下。
  const dir = await mkdtemp(path.join(tmpdir(), "deck-lineage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const server = fakeServer();
  registerHooks(server);
  const created = server.handlers.get("on:agent.created") ?? [];
  assert.equal(created.length, 1);

  await created[0](
    { agent: { id: "child-1", cwd: dir, workspaceId: "ws-1", parentAgentId: "parent-1", labels: {} } },
    context(fakePaseo()),
  );

  const lineage = (await readCoordination(dir)).records.filter((item) => item.kind === "lineage");
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0].sessionAgentId, "child-1");
  assert.equal(lineage[0].fromStaff, "parent-1");
  assert.equal(lineage[0].state, "recorded");
});

test("三种处置各写对 state：approve-once / reassign / deny", async (t) => {
  const dir = await makeWorkspace(t);
  for (const file of ["server/api/a.ts", "server/api/b.ts", "server/api/c.ts"]) {
    await appendCoordination(dir, record({ paths: [file] }));
  }

  const approved = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 0,
    action: "approve-once",
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.record.state, "approved-once");

  const back = reassignPaseo({
    sessions: [{ id: "back-session", labels: { "deck.staff": "back" }, workspaceId: "ws-1" }],
  });
  const reassigned = await orchestrationInboxActHandler(
    {
      workspaceId: "ws-1",
      workspaceDir: dir,
      index: 1,
      action: "reassign",
      toStaff: "back",
    },
    context(back.paseo),
  );
  assert.equal(reassigned.ok, true);
  assert.equal(reassigned.record.state, "reassigned");
  assert.equal(reassigned.record.toStaff, "back");
  assert.equal(back.sent.length, 1, "转派要真的把活发给目标岗位");

  const denied = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 2,
    action: "deny",
  });
  assert.equal(denied.ok, true);
  assert.equal(denied.record.state, "denied");

  const read = await readCoordination(dir);
  assert.deepEqual(
    read.records.map((item) => item.state),
    ["approved-once", "reassigned", "denied"],
  );
});

test("转派目标必须在名册里；名册读不出来时不放行", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record());
  await appendCoordination(dir, record());

  const unknown = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 0,
    action: "reassign",
    toStaff: "nobody",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "invalid-action");
  assert.match(unknown.detail, /名册里没有/);

  await writeFile(path.join(dir, ".deck", "orchestration.json"), "{ broken", "utf8");
  const unreadable = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 1,
    action: "reassign",
    toStaff: "back",
  });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, "read-failed", "读不出名册时不能默默接受任意目标");
});

test("转派到已有会话：续发任务原文与路径，不新建会话", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record());
  const back = reassignPaseo({
    sessions: [
      { id: "old-back", labels: { "deck.staff": "back" }, workspaceId: "ws-1", updatedAt: "2026-11-01T00:00:00.000Z" },
      { id: "new-back", labels: { "deck.staff": "back" }, workspaceId: "ws-1", updatedAt: "2026-11-03T00:00:00.000Z" },
      // 诱饵：异岗位 / 已归档 / 异工作区，都不该被选中。
      { id: "front-live", labels: { "deck.staff": "front" }, workspaceId: "ws-1", updatedAt: "2026-11-04T00:00:00.000Z" },
      {
        id: "back-archived",
        labels: { "deck.staff": "back" },
        workspaceId: "ws-1",
        updatedAt: "2026-11-04T00:00:00.000Z",
        archivedAt: "2026-11-04T00:00:00.000Z",
      },
      { id: "back-elsewhere", labels: { "deck.staff": "back" }, workspaceId: "ws-2", updatedAt: "2026-11-04T00:00:00.000Z" },
    ],
  });

  const result = await orchestrationInboxActHandler(
    { workspaceId: "ws-1", workspaceDir: dir, index: 0, action: "reassign", toStaff: "back" },
    context(back.paseo),
  );

  assert.equal(result.ok, true);
  assert.equal(result.record.state, "reassigned");
  assert.equal(back.sent.length, 1, "已有会话只续发，不要再建一个");
  assert.equal(back.sent[0].agentId, "new-back", "续用最近活跃的那个会话");
  assert.match(back.sent[0].prompt, /给登录接口加验证码校验/, "原文要带过去");
  assert.match(back.sent[0].prompt, /server\/api\/user\.ts/, "路径要带过去");
  assert.equal(back.created.length, 0, "找到会话时不该新建");
  assert.equal(back.listFilters[0].includeArchived, false, "先找未归档的会话");
  assert.equal(back.listFilters[0].labels["deck.staff"], "back", "按目标岗位标签筛选");
});

test("转派到没有会话的岗位：按卡新建，prompt 含原文与路径，标签沿用原会话", async (t) => {
  const dir = await makeWorkspace(t);
  await writeRouting(dir, [{ difficulty: "normal", target: { provider: "mock", model: "model" } }], {
    roles: [{ workspaceId: "ws-1", staff: ROSTER, dispatcherAgentId: "dispatch-1" }],
  });
  await appendCoordination(dir, record());
  await appendGroup(dir, "ws-1", {
    at: "2026-11-04T00:00:00.000Z",
    from: "你",
    agentId: "",
    kind: "user",
    text: "@后端 先看接口再动手",
  });
  const back = reassignPaseo({
    sessions: [],
    original: {
      id: "agent-1",
      workspaceId: "ws-1",
      labels: {
        "deck.staff": "front",
        "deck.ticket": "owner/repo#12",
        "paseo.parent-agent-id": "parent-9",
      },
    },
  });

  const result = await orchestrationInboxActHandler(
    { workspaceId: "ws-1", workspaceDir: dir, index: 0, action: "reassign", toStaff: "back" },
    context(back.paseo),
  );

  assert.equal(result.ok, true);
  assert.equal(result.record.state, "reassigned");
  assert.equal(back.created.length, 1, "没有会话时要新建一个");
  assert.equal(back.sent.length, 0, "不该往不存在的会话里发");
  const options = back.created[0].options;
  assert.equal(back.created[0].workspaceId, "ws-1", "会话要落在请求所属的工作区");
  assert.equal(options.config.provider, "mock/model", "按 normal 档路由拿 provider/model");
  assert.match(options.prompt, /给登录接口加验证码校验/);
  assert.match(options.prompt, /server\/api\/user\.ts/);
  assert.equal(options.labels["deck.staff"], "back");
  assert.equal(options.labels["deck.ticket"], "owner/repo#12", "原会话有票时转派会话带同一张票");
  assert.equal(options.labels["paseo.parent-agent-id"], "dispatch-1", "工作区配了派单窗口时挂到它下面");
  assert.equal(options.parent, "dispatch-1", "父会话也要接上，回传链不能断");
  assert.match(options.config.systemPrompt, /负责后端接口与数据库/, "systemPrompt 至少带岗位职责");
  assert.match(options.config.systemPrompt, /先看接口再动手/, "群消息也要拼进上下文");
});

test("派活失败：请求留在 pending，detail 可读，状态不前进", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record());
  const back = reassignPaseo({
    sessions: [{ id: "back-session", labels: { "deck.staff": "back" }, workspaceId: "ws-1" }],
    sendError: "宿主连接已断开",
  });

  const result = await orchestrationInboxActHandler(
    { workspaceId: "ws-1", workspaceDir: dir, index: 0, action: "reassign", toStaff: "back" },
    context(back.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "action-failed");
  assert.match(result.detail, /派活失败/);
  assert.match(result.detail, /宿主连接已断开/, "失败原因要原样可读");
  assert.match(result.detail, /状态未改动/, "要说明请求还在收件箱里");
  assert.equal((await readCoordination(dir)).records[0].state, "pending", "派不出去就不能标成已转派");
});

test("目标卡指定了档案：按档案建会话并透传 modeId，没有票就不带票标签", async (t) => {
  const dir = await makeWorkspace(t);
  await writeRouting(dir, [], {
    roles: [
      {
        workspaceId: "ws-1",
        staff: [
          { id: "back", name: "后端", kind: "manager", paths: ["server"], duty: "负责后端接口与数据库", profileId: "profile-back" },
          { id: "front", name: "前端", kind: "worker", paths: ["web"] },
        ],
      },
    ],
  });
  await appendCoordination(dir, record());
  const back = reassignPaseo({
    sessions: [],
    original: { id: "agent-1", workspaceId: "ws-1", labels: { "deck.staff": "front" } },
    config: {
      agentProfiles: [
        { id: "profile-back", name: "后端档案", provider: "mock", model: "model", modeId: "mode-x" },
      ],
    },
  });

  const result = await orchestrationInboxActHandler(
    { workspaceId: "ws-1", workspaceDir: dir, index: 0, action: "reassign", toStaff: "back" },
    context(back.paseo),
  );

  assert.equal(result.ok, true);
  const options = back.created[0].options;
  assert.equal(options.config.provider, "mock/model", "卡上档案优先于 normal 档路由");
  assert.equal(options.config.modeId, "mode-x", "档案里的模式也要透传");
  assert.equal(options.labels["deck.ticket"], undefined, "原会话没有票时不带票标签");
  assert.equal(options.labels["paseo.parent-agent-id"], undefined, "没配派单窗口就不挂父会话");
});

test("新建会话失败：请求留在 pending，detail 指向新建失败", async (t) => {
  const dir = await makeWorkspace(t);
  await writeRouting(dir, [{ difficulty: "normal", target: { provider: "mock", model: "model" } }]);
  await appendCoordination(dir, record());
  const back = reassignPaseo({ sessions: [], createError: "宿主拒绝创建会话" });

  const result = await orchestrationInboxActHandler(
    { workspaceId: "ws-1", workspaceDir: dir, index: 0, action: "reassign", toStaff: "back" },
    context(back.paseo),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "action-failed");
  assert.match(result.detail, /新建「后端」的会话失败/);
  assert.match(result.detail, /宿主拒绝创建会话/);
  assert.equal((await readCoordination(dir)).records[0].state, "pending");
});

test("非法动作组合被拒：kind 与动作不匹配时不改状态", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record({ kind: "staffing", need: "要一个会写前端的", paths: [] }));
  await appendCoordination(dir, record({ kind: "contract", field: "status", paths: [] }));
  await appendCoordination(dir, record());

  const staffingApprove = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 0,
    action: "approve-once",
  });
  assert.equal(staffingApprove.ok, false);
  assert.equal(staffingApprove.reason, "invalid-action");
  assert.match(staffingApprove.detail, /staffing/);

  const contractDeny = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 1,
    action: "deny",
  });
  assert.equal(contractDeny.ok, false);
  assert.equal(contractDeny.reason, "invalid-action");

  const territoryStaff = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 2,
    action: "staff",
  });
  assert.equal(territoryStaff.ok, false);
  assert.equal(territoryStaff.reason, "invalid-action");

  assert.deepEqual(
    (await readCoordination(dir)).records.map((item) => item.state),
    ["pending", "pending", "pending"],
    "非法组合一个状态都不该改",
  );
});

test("staffing / contract 的合法终态各走各的", async (t) => {
  const dir = await makeWorkspace(t);
  await appendCoordination(dir, record({ kind: "staffing", need: "要一个会写前端的", paths: [] }));
  await appendCoordination(dir, record({ kind: "staffing", need: "要一个会写后端的", paths: [] }));
  await appendCoordination(dir, record({ kind: "contract", field: "status", paths: [] }));
  await appendCoordination(dir, record({ kind: "contract", field: "route", paths: [] }));

  const staffed = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 0,
    action: "staff",
  });
  assert.equal(staffed.ok, true);
  assert.equal(staffed.record.state, "staffed");

  const declined = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 1,
    action: "decline",
  });
  assert.equal(declined.ok, true);
  assert.equal(declined.record.state, "declined");

  const contract = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 2,
    action: "contract-changed",
  });
  assert.equal(contract.ok, true);
  assert.equal(contract.record.state, "contract-changed");

  const impl = await orchestrationInboxActHandler({
    workspaceId: "ws-1",
    workspaceDir: dir,
    index: 3,
    action: "impl-changed",
  });
  assert.equal(impl.ok, true);
  assert.equal(impl.record.state, "impl-changed");
});
