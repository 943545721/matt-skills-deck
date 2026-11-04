import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { groupSendHandler } from "../server/rpc/group.ts";
import { getIssueHandler } from "../server/rpc/issues.ts";
import { readGroup } from "../server/group-store.ts";
import { groupRequestFileOf } from "../server/group-requests.ts";
import { writeOrchestration } from "../server/orchestration-store.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";
import { createLocalIssue, getLocalIssue } from "../server/tracker/local.ts";

/**
 * 群发送 handler 的**副作用**测试。
 *
 * 纯路由（谁被点到、票面写什么、什么时候拒绝）已经在 `group-rpc.test.mjs` 里测过；
 * 这里只问三件会产生真实后果的事：
 * 1. 顺序：先建票 → 再建会话 → 再落岗位群记录（user 记录在派活前落）；
 * 2. 三条拒绝 / 停顿路径（需求未定稿、@全部 预览、单目标建票失败）一个副作用都不能漏；
 * 3. requestId 重放不再重复建票 / 建会话。
 *
 * 全部在临时目录里跑本地 `.deck` 后端：不联网、不碰真实 git。
 */

// 固定成 local，避免 `resolveWorkspaceTargets` 去跑 git 探测临时目录。
setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "local" });
// 设置是进程级单例，用完还原，别让同进程里的其它用例跟着跑在 local 上。
after(() => setSettingsForTest(DEFAULT_SETTINGS));

const WORKSPACE_ID = "ws-1";
const FRONTEND = { id: "staff-aaaaaa", name: "前端", duty: "改前端界面" };
const BACKEND = { id: "staff-bbbbbb", name: "后端", duty: "改接口" };

const ROUTING = [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }];

/** 只够跑通这条链路的假宿主：配置可读、建会话必成、列表可空。 */
function fakePaseo({ config = {}, entries = [], workspaceDir = null } = {}) {
  const created = [];
  const sent = [];
  const listCalls = [];
  return {
    created,
    sent,
    listCalls,
    config: {
      get: async () => ({ config: structuredClone(config) }),
    },
    agents: {
      list: async (options) => {
        listCalls.push(options);
        return { entries };
      },
      ref: (agentId) => ({
        send: async (text, options) => {
          sent.push({ agentId, text, options });
        },
        // 履历读时间线只在没有回传件时发生；这里给一个空时间线。
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    workspaces: {
      ref: (workspaceId) => ({
        id: workspaceId,
        agents: {
          create: async (options) => {
            // 建会话这一刻票是否已经落盘：用来证明顺序不是「先会话后补票」。
            let ticketExisted = null;
            if (workspaceDir) {
              const ticketKey = options.labels?.["deck.ticket"] ?? "";
              const number = Number(ticketKey.replace(/^.*#/, ""));
              if (number > 0) {
                ticketExisted = await access(path.join(workspaceDir, ".deck", "issues", `${number}.md`)).then(
                  () => true,
                  () => false,
                );
              }
            }
            // 建会话这一刻群记录里已经有什么：用来证明 user 那条不是事后补的。
            // 记录文件按 workspaceId 存（群标签存的是目录），所以这里按 id 读。
            const groupAtCreate = workspaceDir
              ? (await readGroup(workspaceDir, WORKSPACE_ID)).records.map((record) => record.kind)
              : null;
            created.push({ workspaceId, options, ticketExisted, groupAtCreate });
            return { id: `agent-${created.length}` };
          },
        },
      }),
    },
  };
}

async function workspace(t, { staff = [FRONTEND], workspaceId = WORKSPACE_ID, extra = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-group-send-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const written = await writeOrchestration(
    dir,
    {
      roles: [{ workspaceId, mainAgentId: "main-1", dispatcherAgentId: "dispatch-1", staff }],
      routing: ROUTING,
      maxDepth: 3,
      maxChildrenPerDispatch: 4,
      reportOnFinish: true,
      ...extra,
    },
    { workspaceId },
  );
  assert.equal(written.ok, true);
  return dir;
}

async function requirementTicket(dir, { labels = ["requirement", "deck:定稿"] } = {}) {
  const created = await createLocalIssue(dir, {
    title: "需求：登录页间距",
    body: "## 需求\n\n把登录页的间距改一下。",
    labels,
  });
  assert.equal(created.ok, true);
  return created.number;
}

/** 群记录是索引文件：读失败必须显式失败，不能把「一行都没有」当成「一条都没写」。 */
const groupRecords = async (dir) => {
  const read = await readGroup(dir, WORKSPACE_ID);
  assert.equal(read.failed, undefined, `群记录读不出来：${read.failed}`);
  return read.records;
};

/** 本地票目录里的票文件数；目录还没建出来就是 0，不是读失败。 */
const ticketFileCount = async (dir) => {
  const names = await readdir(path.join(dir, ".deck", "issues")).catch((error) => {
    if (error && error.code === "ENOENT") return [];
    throw error;
  });
  return names.filter((name) => /^\d+\.md$/.test(name)).length;
};

/* ------------------------------------------------------------ @岗位：完整发送 */

test("@岗位：先建票再建会话，群记录先 user 后 staff，票面带 Refs 与岗位标签", async (t) => {
  const dir = await workspace(t);
  const requirement = await requirementTicket(dir);
  const paseo = fakePaseo({ workspaceDir: dir });
  const text = "@前端 把登录页的间距改一下";

  const result = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir, text, requirementNumber: requirement },
    { paseo },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "sent");
  assert.equal(result.deliveries.length, 1);
  const delivery = result.deliveries[0];
  assert.equal(delivery.staffId, FRONTEND.id);
  assert.equal(delivery.name, FRONTEND.name);
  assert.equal(delivery.agentId, "agent-1");
  assert.equal(delivery.ticketNumber, requirement + 1);
  assert.equal(delivery.detail, undefined);

  // 群记录：user 在最前，岗位那条在会话建好之后。
  const records = await groupRecords(dir);
  assert.deepEqual(
    records.map((record) => record.kind),
    ["user", "staff"],
    "user 记录先落，岗位记录后落",
  );
  assert.equal(records[0].from, "你");
  assert.equal(records[0].text, text);
  assert.equal(records[1].from, FRONTEND.name);
  assert.equal(records[1].agentId, "agent-1");
  assert.equal(records[1].text, text);

  // 票真的建出来了，正文挂着需求票，标签认出岗位与群。
  const ticket = await getIssueHandler({ workspaceDir: dir, number: delivery.ticketNumber });
  assert.equal(ticket.ok, true);
  assert.match(ticket.issue.body, new RegExp(`Refs: #${requirement}`));
  assert.deepEqual(
    ticket.issue.labels.map((label) => label.name).toSorted(),
    ["deck.group", "deck.staff"].toSorted(),
  );

  // 会话建在指定工作区，标签指向岗位与这张票；建会话时票已经在盘上。
  assert.equal(paseo.created.length, 1);
  const { workspaceId, options, ticketExisted, groupAtCreate } = paseo.created[0];
  assert.equal(workspaceId, WORKSPACE_ID);
  assert.equal(ticketExisted, true, "建会话之前票必须已经落盘");
  assert.deepEqual(groupAtCreate, ["user"], "user 那条群记录必须在建会话之前就落盘");
  assert.equal(options.config.provider, "claude/sonnet");
  assert.equal(options.labels["deck.staff"], FRONTEND.id);
  // 群标签写**目录**：换个 workspaceId 打开还是同一个群，会话不会从成员表里消失。
  assert.equal(options.labels["deck.group"], path.resolve(dir));
  assert.equal(options.labels["deck.ticket"], `#${delivery.ticketNumber}`);
  assert.equal(options.labels["paseo.parent-agent-id"], "dispatch-1");
  assert.equal(options.parent, "dispatch-1");
  assert.equal(options.prompt, text);
});

/* ------------------------------------------ 群发也是「建会话」：要带默认思考档 */

test("群建的会话带上同模型的默认档；模型从清单删掉后不再带", async (t) => {
  const modelThinking = [{ provider: "claude", model: "sonnet", thinkingOptionId: "high" }];

  const dir = await workspace(t, { extra: { modelThinking } });
  const requirement = await requirementTicket(dir);
  const paseo = fakePaseo({
    workspaceDir: dir,
    config: { providers: { claude: { additionalModels: [{ id: "sonnet" }] } } },
  });
  const sent = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir, text: "@前端 改一下间距", requirementNumber: requirement },
    { paseo },
  );
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(paseo.created[0].options.config.thinkingOptionId, "high", "路由没显式设档时用默认档");

  // 同一份默认表，但那个模型已经从清单里删掉：残留条目不许再往外传。
  const dir2 = await workspace(t, { extra: { modelThinking } });
  const requirement2 = await requirementTicket(dir2);
  const paseo2 = fakePaseo({
    workspaceDir: dir2,
    config: { providers: { claude: { additionalModels: [] } } },
  });
  const sent2 = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir2, text: "@前端 改一下间距", requirementNumber: requirement2 },
    { paseo: paseo2 },
  );
  assert.equal(sent2.ok, true, JSON.stringify(sent2));
  assert.equal(
    "thinkingOptionId" in paseo2.created[0].options.config,
    false,
    "模型已经不在清单里，默认档不许继续生效",
  );
});

test("岗位卡指定档案时同样按默认档合成；卡上显式档位优先", async (t) => {
  const modelThinking = [{ provider: "claude", model: "sonnet", thinkingOptionId: "high" }];
  const profiles = [
    { id: "daily", provider: "claude", model: "sonnet" },
    { id: "deep", provider: "claude", model: "sonnet", thinkingOptionId: "low" },
  ];
  const config = {
    agentProfiles: profiles,
    providers: { claude: { additionalModels: [{ id: "sonnet" }] } },
  };

  for (const [profileId, expected] of [["daily", "high"], ["deep", "low"]]) {
    const dir = await workspace(t, {
      staff: [{ ...FRONTEND, profileId }],
      extra: { modelThinking },
    });
    const requirement = await requirementTicket(dir);
    const paseo = fakePaseo({ workspaceDir: dir, config });
    const sent = await groupSendHandler(
      { workspaceId: WORKSPACE_ID, workspaceDir: dir, text: "@前端 改一下间距", requirementNumber: requirement },
      { paseo },
    );
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(paseo.created[0].options.config.provider, "claude/sonnet");
    assert.equal(paseo.created[0].options.config.thinkingOptionId, expected, `档案 ${profileId} 的档位`);
  }
});

test("档案缺模型：提前拒绝并说清是哪份档案，票和会话都不建", async (t) => {
  // 档案分支走 `resolveRouteTarget` 之后，不完整的档案在插件这层就被挡下（宿主只认
  // provider/model）。这条测试钉住「提前拒绝」这个行为本身，以及错误说人话。
  const dir = await workspace(t, { staff: [{ ...FRONTEND, profileId: "broken" }] });
  const requirement = await requirementTicket(dir);
  const paseo = fakePaseo({
    workspaceDir: dir,
    config: {
      agentProfiles: [{ id: "broken", name: "半成品", provider: "claude" }],
      providers: { claude: { additionalModels: [{ id: "sonnet" }] } },
    },
  });
  const sent = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir, text: "@前端 改一下间距", requirementNumber: requirement },
    { paseo },
  );

  assert.equal(sent.ok, true, JSON.stringify(sent));
  const delivery = sent.deliveries.find((item) => item.staffId === FRONTEND.id);
  assert.equal(delivery.agentId, null, "档案不完整时一个会话都不能建");
  assert.equal(delivery.ticketNumber, null, "拒绝发生在建票之前");
  assert.match(delivery.detail, /半成品/, "要说清是哪份档案");
  assert.match(delivery.detail, /模型/, "要说清缺的是模型");
  assert.equal(paseo.created.length, 0);
});

/* ---------------------------------------------------- 需求未定稿：零副作用 */

test("需求没定稿：整句拒绝，不建票、不建会话、不写群记录", async (t) => {
  const dir = await workspace(t);
  const requirement = await requirementTicket(dir, { labels: ["requirement"] });
  const paseo = fakePaseo();

  const result = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir, text: "@前端 改一下", requirementNumber: requirement },
    { paseo },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "requirement-not-final");
  assert.match(result.detail, new RegExp(`#${requirement}`));
  assert.equal(paseo.created.length, 0, "一个会话都不能建");
  assert.equal(paseo.listCalls.length, 0, "连履历都不该去读");
  assert.equal((await getLocalIssue(dir, requirement + 1)).ok, false, "不能多出一张工作票");
  assert.equal(await ticketFileCount(dir), 1, "票目录里只能有那张需求票");
  assert.deepEqual(await groupRecords(dir), [], "群记录一条都不该写");
});

/* ------------------------------------------------ @全部：先预览，确认后才动手 */

test("@全部：不带 confirmAll 只回清单；带 confirmAll 才建两张票、两个会话", async (t) => {
  const dir = await workspace(t, { staff: [FRONTEND, BACKEND] });
  const requirement = await requirementTicket(dir);
  const paseo = fakePaseo({ workspaceDir: dir });
  const text = "@全部 把各自的测试补齐";

  const preview = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir, text, requirementNumber: requirement },
    { paseo },
  );
  assert.equal(preview.ok, true);
  assert.equal(preview.status, "preview");
  assert.deepEqual(preview.targets.map((target) => target.staffId), [FRONTEND.id, BACKEND.id]);
  assert.equal(paseo.created.length, 0, "预览阶段一个会话都不能建");
  assert.equal((await getLocalIssue(dir, requirement + 1)).ok, false, "预览阶段一张票都不能建");
  assert.equal(await ticketFileCount(dir), 1, "预览阶段票目录里只能有那张需求票");
  assert.deepEqual(await groupRecords(dir), [], "预览阶段群记录一条都不该写");

  const sent = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir, text, requirementNumber: requirement, confirmAll: true },
    { paseo },
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.status, "sent");
  assert.deepEqual(sent.deliveries.map((item) => item.staffId), [FRONTEND.id, BACKEND.id]);
  assert.equal(paseo.created.length, 2, "两张卡各建一个会话");
  assert.equal((await getLocalIssue(dir, requirement + 1)).ok, true);
  assert.equal((await getLocalIssue(dir, requirement + 2)).ok, true);
  assert.equal(
    (await getLocalIssue(dir, requirement + 3)).ok,
    false,
    "只建两张票，不能因为重试多建一张",
  );
  assert.equal(await ticketFileCount(dir), 3, "需求票 + 两张工作票，没有第三张");
  assert.deepEqual(
    (await groupRecords(dir)).map((record) => record.kind),
    ["user", "staff", "staff"],
  );
  assert.deepEqual(
    paseo.created.map((item) => item.options.labels["deck.staff"]),
    [FRONTEND.id, BACKEND.id],
  );
});

test("需求影响面表写坏：群建票同一个 split-guard 拦下，不建票、不建会话", async (t) => {
  const dir = await workspace(t);
  const created = await createLocalIssue(dir, {
    title: "需求：坏表",
    body: "## 影响面\n\n| 区 | 依据 |\n|---|---|\n",
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(created.ok, true);
  const paseo = fakePaseo({ workspaceDir: dir });

  const result = await groupSendHandler(
    {
      workspaceId: WORKSPACE_ID,
      workspaceDir: dir,
      text: "@前端 改一下间距",
      requirementNumber: created.number,
    },
    { paseo },
  );
  assert.equal(result.ok, true);
  assert.equal(result.deliveries[0].ticketNumber, null);
  assert.match(result.deliveries[0].detail, /影响面/);
  assert.equal(paseo.created.length, 0);
  assert.equal(await ticketFileCount(dir), 1, "只剩那张需求票");
});

/* ------------------------------------------------------------ requestId 幂等 */

test("同一个 requestId 重发：回放上次 deliveries，不重复建票 / 建会话 / 写群记录", async (t) => {
  const dir = await workspace(t);
  const requirement = await requirementTicket(dir);
  const paseo = fakePaseo({ workspaceDir: dir });
  const input = {
    workspaceId: WORKSPACE_ID,
    workspaceDir: dir,
    text: "@前端 改一下间距",
    requirementNumber: requirement,
    requestId: "req-1",
  };

  const first = await groupSendHandler(input, { paseo });
  assert.equal(first.ok, true);
  assert.equal(first.status, "sent");
  assert.equal(paseo.created.length, 1);
  const recordsAfterFirst = await groupRecords(dir);
  assert.equal(recordsAfterFirst.length, 2);

  const second = await groupSendHandler(input, { paseo });
  assert.equal(second.ok, true);
  assert.equal(second.status, "sent");
  assert.deepEqual(second.deliveries, first.deliveries, "回放的必须是上次那批结果");
  assert.match(second.warnings.join("\n"), /回放/);
  assert.equal(paseo.created.length, 1, "第二次不能再建会话");
  assert.equal((await getLocalIssue(dir, requirement + 2)).ok, false, "第二次不能再建票");
  assert.equal(await ticketFileCount(dir), 2, "第一次建的需求票 + 工作票，第二次不再增加");
  assert.deepEqual(await groupRecords(dir), recordsAfterFirst, "第二次不能再写群记录");
});

test("幂等记录读不出来：拒绝重发，一张票一个会话都不建", async (t) => {
  const dir = await workspace(t);
  const requirement = await requirementTicket(dir);
  // 记录文件的位置被目录占住：读失败不是 ENOENT，不能当成「没派过」。
  await mkdir(groupRequestFileOf(dir, WORKSPACE_ID), { recursive: true });
  const paseo = fakePaseo({ workspaceDir: dir });

  const result = await groupSendHandler(
    {
      workspaceId: WORKSPACE_ID,
      workspaceDir: dir,
      text: "@前端 改一下间距",
      requirementNumber: requirement,
      requestId: "req-1",
    },
    { paseo },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "read-failed");
  assert.equal(paseo.created.length, 0);
  assert.equal(await ticketFileCount(dir), 1, "只剩那张需求票");
  assert.deepEqual(await groupRecords(dir), []);
});

/* -------------------------------------------- 建票失败：不建会话，原因逐条返回 */

test("建票失败：该目标带原因、不建会话，群记录只留 user 那条", async (t) => {
  const dir = await workspace(t);
  const requirement = await requirementTicket(dir);
  // 把下一张票的目标路径占成目录：本地后端写不进去，模拟后端不可写。
  await mkdir(path.join(dir, ".deck", "issues", `${requirement + 1}.md`), { recursive: true });
  const paseo = fakePaseo({ workspaceDir: dir });

  const result = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir, text: "@前端 改一下", requirementNumber: requirement },
    { paseo },
  );

  assert.equal(result.ok, true, "单目标失败不该让整次调用失败");
  assert.equal(result.status, "sent");
  assert.equal(result.deliveries.length, 1);
  const delivery = result.deliveries[0];
  assert.equal(delivery.staffId, FRONTEND.id);
  assert.equal(delivery.agentId, null);
  assert.equal(delivery.ticketNumber, null);
  assert.equal(typeof delivery.detail, "string");
  assert.match(delivery.detail, /本地 Markdown|EISDIR|ENOTDIR/, "原因要来自真实的后端写入失败");
  assert.equal(paseo.created.length, 0, "没有票就不建会话");
  assert.deepEqual(
    (await groupRecords(dir)).map((record) => record.kind),
    ["user"],
    "派活没成，但 user 那句话仍然留在群记录里",
  );
  assert.match(result.warnings.join("\n"), /1 个目标没派出去/);
});

/* ------------------------------------------------ 点名册：不写 @ 也派给这张卡 */

test("点了名册上的人：正文没有 @ 也先建票再建会话", async (t) => {
  const dir = await workspace(t);
  const requirement = await requirementTicket(dir);
  const paseo = fakePaseo({ workspaceDir: dir });
  const text = "把登录页的间距改一下";

  const result = await groupSendHandler(
    { workspaceId: WORKSPACE_ID, workspaceDir: dir, text, requirementNumber: requirement, staffId: FRONTEND.id },
    { paseo },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "sent");
  assert.equal(result.deliveries[0].staffId, FRONTEND.id);
  assert.equal(result.deliveries[0].agentId, "agent-1");
  assert.equal(paseo.created[0].workspaceId, WORKSPACE_ID);
  assert.equal(paseo.created[0].options.labels["deck.staff"], FRONTEND.id);
});

/* -------------------------------------- 一个项目一个群：别的目录的人不在本群名册上 */

test("@ 只在别的目录对得上：本群名册上没有这个人，整句拒绝，不建票不建会话", async (t) => {
  const dirA = await workspace(t, { staff: [BACKEND], workspaceId: "ws-a" });
  const dirB = await workspace(t, { staff: [FRONTEND], workspaceId: "ws-b" });
  const requirement = await requirementTicket(dirA);
  const paseo = fakePaseo({ workspaceDir: dirA });

  const result = await groupSendHandler(
    {
      workspaceId: "ws-a",
      workspaceDir: dirA,
      text: "@前端 把登录页的间距改一下",
      requirementNumber: requirement,
    },
    { paseo },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-staff");
  assert.match(result.detail, /后端/, "拒绝时要把本群名册上的人列出来");
  assert.equal(paseo.created.length, 0);
  assert.equal(await ticketFileCount(dirA), 1, "只剩那张需求票");
  assert.deepEqual(await groupRecords(dirA), [], "拒绝的句子不落群记录");
  // 别的目录那边一个字都没写：这个群属于 dirA，不往别人的目录里落东西。
  assert.equal(await ticketFileCount(dirB), 0);
  assert.deepEqual(await groupRecords(dirB), []);
});

test("点了别的目录的岗位 id：同样按本群名册拒绝，不去别人的目录建会话", async (t) => {
  const dirA = await workspace(t, { staff: [BACKEND], workspaceId: "ws-a" });
  const dirB = await workspace(t, { staff: [FRONTEND], workspaceId: "ws-b" });
  const requirement = await requirementTicket(dirA);
  const paseo = fakePaseo({ workspaceDir: dirA });

  const result = await groupSendHandler(
    {
      workspaceId: "ws-a",
      workspaceDir: dirA,
      text: "把登录页的间距改一下",
      requirementNumber: requirement,
      staffId: FRONTEND.id,
    },
    { paseo },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-staff");
  assert.equal(paseo.created.length, 0);
  assert.deepEqual(await groupRecords(dirB), []);
});
