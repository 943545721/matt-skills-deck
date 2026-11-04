import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECK_STAFF_LABEL,
  MAX_STAFF_CARDS,
  MAX_STAFF_CONCURRENCY,
  MAX_STAFF_DUTY_CHARS,
  MAX_STAFF_NAME_CHARS,
  MAX_STAFF_PATHS,
  buildDispatchTicket,
  newStaffId,
  isValidStaffId,
  normalizeOrchestration,
  normalizeStaffCards,
  normalizeStaffId,
  normalizeStaffPath,
  planDispatch,
  staffCardOf,
  ticketSpecOf,
  withStaffCards,
  withWorkspaceRoles,
} from "../shared/orchestration.ts";
import { staffCardSchema } from "../shared/orchestration-rpc.ts";

/**
 * 岗位名册的纯函数。
 *
 * 这一组钉的是三类历史高发 bug：
 * 1. 中文名被归一化成空串 → 卡静默消失；
 * 2. 两张同名卡合并成一张；
 * 3. 保存一次角色绑定就把名册抹掉（`withWorkspaceRoles` 手抄字段漏一行）。
 */

const card = (overrides = {}) => ({ id: "frontend", name: "前端", ...overrides });

test("id 归一：中文名不会被当成 id，非法字符被丢掉", () => {
  assert.equal(normalizeStaffId("Frontend"), "frontend");
  assert.equal(normalizeStaffId("  web-admin  "), "web-admin");
  assert.equal(normalizeStaffId("前端"), "", "中文收敛后为空——这张卡该被丢掉，而不是变成一个空 id");
  assert.equal(normalizeStaffId("a b/c"), "abc");
  assert.equal(normalizeStaffId(undefined), "");
});

test("建卡时的严格判定与归一化不是一回事", () => {
  assert.equal(isValidStaffId("web-admin"), true);
  assert.equal(isValidStaffId("Web-Admin"), false, "大写不算合法：原样就得是 [a-z0-9-]");
  assert.equal(isValidStaffId("a b"), false);
  assert.equal(isValidStaffId(""), false);
});

test("领地路径：去前导 / 与尾部 /、反斜杠统一", () => {
  assert.equal(normalizeStaffPath("./web/"), "web");
  assert.equal(normalizeStaffPath("/src/api/"), "src/api");
  assert.equal(normalizeStaffPath("web\\admin"), "web/admin");
  assert.equal(normalizeStaffPath("   "), "");
});

test("名册归一：中文名保留、id 没变、缺省是员工", () => {
  const cards = normalizeStaffCards([{ id: "web", name: "前端 🚀" }]);
  assert.deepEqual(cards, [{ id: "web", name: "前端 🚀", kind: "worker", maxConcurrent: 1 }]);
});

test("名册归一不给人编 id：没有 id 的卡整张丢掉（id 在建卡那一步由 `newStaffId` 生成）", () => {
  assert.equal(normalizeStaffCards([{ name: "没有 id" }]), undefined);
});

test("名册归一：名字为空时回落到 id，别显示成空白行", () => {
  assert.equal(normalizeStaffCards([{ id: "backend" }])[0].name, "backend");
});

test("两张同名（id 相同）的卡后者覆盖前者，不是并存两个", () => {
  const cards = normalizeStaffCards([
    { id: "web", name: "旧名字" },
    { id: "web", name: "新名字" },
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, "新名字");
});

test("名字相同但 id 不同：两张卡各自独立，互不覆盖", () => {
  const cards = normalizeStaffCards([
    { id: "web-a", name: "前端" },
    { id: "web-b", name: "前端" },
  ]);
  assert.equal(cards.length, 2);
});

test("截断与封顶：职责 4000 字、领地 20 条、并发夹到 1..8、张数 24", () => {
  const longDuty = "字".repeat(MAX_STAFF_DUTY_CHARS + 100);
  const manyPaths = Array.from({ length: MAX_STAFF_PATHS + 10 }, (_, index) => `p${index}`);
  const tooMany = Array.from({ length: MAX_STAFF_CARDS + 5 }, (_, index) => ({
    id: `s${index}`,
    name: `卡${index}`,
  }));
  const [one] = normalizeStaffCards([card({ duty: longDuty, paths: manyPaths, maxConcurrent: 999 })]);
  assert.equal(one.duty.length, MAX_STAFF_DUTY_CHARS);
  assert.equal(one.paths.length, MAX_STAFF_PATHS);
  assert.equal(one.maxConcurrent, MAX_STAFF_CONCURRENCY);
  assert.equal(normalizeStaffCards(tooMany).length, MAX_STAFF_CARDS);
});

test("领地重复项去重，顺序按第一次出现", () => {
  const [one] = normalizeStaffCards([card({ paths: ["web/", "./web", "api"] })]);
  assert.deepEqual(one.paths, ["web", "api"]);
});

test("按 id 取卡：大小写归一后比较", () => {
  const roles = { workspaceId: "w1", staff: normalizeStaffCards([card()]) };
  assert.equal(staffCardOf(roles, "FRONTEND")?.id, "frontend");
  assert.equal(staffCardOf(roles, "nobody"), null);
  assert.equal(staffCardOf({ workspaceId: "w1" }, "frontend"), null);
});

test("整组替换名册时其它字段原样带走；清空后不留空壳字段", () => {
  const roles = { workspaceId: "w1", mainAgentId: "m", prompts: { main: "自定义" } };
  const withCards = withStaffCards(roles, [card()]);
  assert.equal(withCards.mainAgentId, "m");
  assert.equal(withCards.prompts.main, "自定义");
  const cleared = withStaffCards(withCards, []);
  assert.equal("staff" in cleared, false);
});

test("滚动额度：旧文件默认 12，0 是「关掉这道闸」而不是「回落到默认」", () => {
  assert.equal(normalizeOrchestration({}).staffSessionQuota, 12);
  assert.equal(normalizeOrchestration({ staffSessionQuota: 0 }).staffSessionQuota, 0);
  assert.equal(normalizeOrchestration({ staffSessionQuota: 9999 }).staffSessionQuota, 200);
});

test("旧文件没有 staff：归一化后就是空名册，一个字段都不多出来", () => {
  const settings = normalizeOrchestration({ roles: [{ workspaceId: "w1", mainAgentId: "m" }] });
  assert.equal(settings.roles[0].staff, undefined);
  assert.equal(settings.minConcurrentStaff, 1);
  assert.equal(settings.confirmRequirementSplit, true);
});

test("保存角色绑定不能把名册抹掉（手抄字段漏一行就是这条挂）", () => {
  const settings = normalizeOrchestration({
    roles: [{ workspaceId: "w1", mainAgentId: "m", staff: [card()] }],
  });
  const saved = withWorkspaceRoles(settings, { workspaceId: "w1", mainAgentId: "m2" });
  assert.equal(saved.roles[0].staff.length, 1);
  assert.equal(saved.roles[0].staff[0].id, "frontend");
});

test("只有名册、没绑任何窗口的工作区也要留下来", () => {
  const settings = normalizeOrchestration({ roles: [{ workspaceId: "w1", staff: [card()] }] });
  const saved = withWorkspaceRoles(settings, { workspaceId: "w1", staff: settings.roles[0].staff });
  assert.equal(saved.roles.length, 1);
  assert.equal(saved.roles[0].staff.length, 1);
});

// ---------------------------------------------------------------------------
// 派单
// ---------------------------------------------------------------------------

const settings = { routing: [{ difficulty: "normal", target: { provider: "claude", model: "sonnet" } }] };

function dispatchInput(tasks, overrides = {}) {
  return {
    workspaceId: "w1",
    roles: [{ workspaceId: "w1", dispatcherAgentId: "dispatcher" }],
    routing: settings.routing,
    profiles: [],
    tasks,
    maxDepth: 3,
    maxChildrenPerDispatch: 6,
    depth: 1,
    dispatchId: "d1",
    ...overrides,
  };
}

test("空名册：派单结果与接这个功能之前完全一样（不写 deck.staff 标）", () => {
  const plan = planDispatch(dispatchInput([{ key: "#1", prompt: "做事" }]));
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].staffId, undefined);
  assert.equal(plan.tasks[0].systemPrompt, undefined);
  assert.equal(DECK_STAFF_LABEL in plan.tasks[0].labels, false);
});

test("名册非空但没写派给谁、也没写区域：拒绝，不猜一个人", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事" }], {
      roles: [
        {
          workspaceId: "w1",
          dispatcherAgentId: "dispatcher",
          staff: normalizeStaffCards([card()]),
        },
      ],
    }),
  );
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "region-required");
  assert.match(plan.rejected[0].detail, /region/);
});

test("写了名册里没有的 id：拒绝，并把可选的名字列出来", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", staff: "nobody" }], {
      roles: [
        {
          workspaceId: "w1",
          dispatcherAgentId: "dispatcher",
          staff: normalizeStaffCards([card()]),
        },
      ],
    }),
  );
  assert.equal(plan.rejected[0].reason, "unknown-staff");
  assert.match(plan.rejected[0].detail, /frontend/);
});

test("派到卡上：标签、staffId、职责提示词三样都落地", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", staff: "frontend" }], {
      roles: [
        {
          workspaceId: "w1",
          dispatcherAgentId: "dispatcher",
          staff: normalizeStaffCards([card({ duty: "只改前端，别碰后端" })]),
        },
      ],
    }),
  );
  assert.equal(plan.tasks[0].staffId, "frontend");
  assert.equal(plan.tasks[0].systemPrompt, "只改前端，别碰后端");
  assert.equal(plan.tasks[0].labels[DECK_STAFF_LABEL], "frontend");
});

test("卡上写了档案：按档案走，不走难度路由", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", staff: "frontend", difficulty: "hard" }], {
      routing: [{ difficulty: "hard", target: { provider: "claude", model: "sonnet" } }],
      profiles: [{ id: "cheap", name: "便宜档", provider: "codex", model: "gpt" }],
      roles: [
        {
          workspaceId: "w1",
          dispatcherAgentId: "dispatcher",
          staff: normalizeStaffCards([card({ profileId: "cheap" })]),
        },
      ],
    }),
  );
  assert.equal(plan.tasks[0].providerSpec, "codex/gpt");
  assert.equal(plan.tasks[0].routeFrom, undefined, "档案不是从难度表借来的，不该标 routeFrom");
});

test("卡指向的档案被删：明确拒绝，不静默换模型", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", staff: "frontend" }], {
      roles: [
        {
          workspaceId: "w1",
          dispatcherAgentId: "dispatcher",
          staff: normalizeStaffCards([card({ profileId: "gone" })]),
        },
      ],
    }),
  );
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "route-unavailable");
});

test("至少铺开几张：名册人不够 → 整批拒绝，不悄悄降级", () => {
  const plan = planDispatch(
    dispatchInput(
      [
        { key: "#1", prompt: "做事", staff: "web-a" },
        { key: "#2", prompt: "做事", staff: "web-b" },
        { key: "#3", prompt: "做事", staff: "web-b" },
      ],
      {
        minConcurrentStaff: 3,
        roles: [
          {
            workspaceId: "w1",
            dispatcherAgentId: "dispatcher",
            staff: normalizeStaffCards([
              { id: "web-a", name: "A" },
              { id: "web-b", name: "B" },
            ]),
          },
        ],
      },
    ),
  );
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "min-concurrent-staff");
  assert.match(plan.rejected[0].detail, /只有 2 张员工卡/);
});

test("至少铺开几张：人在但活都塞给同一个人 → 拒绝并说清「拆给不同的人」", () => {
  const plan = planDispatch(
    dispatchInput(
      [
        { key: "#1", prompt: "做事", staff: "web-a" },
        { key: "#2", prompt: "做事", staff: "web-a" },
        { key: "#3", prompt: "做事", staff: "web-b" },
      ],
      {
        minConcurrentStaff: 3,
        roles: [
          {
            workspaceId: "w1",
            dispatcherAgentId: "dispatcher",
            staff: normalizeStaffCards([
              { id: "web-a", name: "A" },
              { id: "web-b", name: "B" },
              { id: "web-c", name: "C" },
            ]),
          },
        ],
      },
    ),
  );
  assert.equal(plan.rejected[0].reason, "min-concurrent-staff");
  assert.match(plan.rejected[0].detail, /实际只铺到 2 张/);
});

test("至少铺开几张：任务比人少时按任务数算，不因为人少就把活卡住", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", staff: "web-a" }], {
      minConcurrentStaff: 3,
      roles: [
        {
          workspaceId: "w1",
          dispatcherAgentId: "dispatcher",
          staff: normalizeStaffCards([
            { id: "web-a", name: "A" },
            { id: "web-b", name: "B" },
            { id: "web-c", name: "C" },
          ]),
        },
      ],
    }),
  );
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.tasks.length, 1);
});

test("票面上写明岗位：会话归档了，票还查得到是谁干的", () => {
  const ticket = buildDispatchTicket({
    key: "#12",
    prompt: "做事",
    difficulty: "normal",
    providerSpec: "claude/sonnet",
    dispatchId: "d1",
    dispatcherAgentId: "dispatcher",
    depth: 1,
    staff: { id: "frontend", name: "前端" },
  });
  assert.match(ticket.body, /- 岗位：前端（id=`frontend`）/);
});

test("没有岗位时不写那一行（空名册的票面与今天逐字节一致）", () => {
  const ticket = buildDispatchTicket({
    key: "#12",
    prompt: "做事",
    difficulty: "normal",
    providerSpec: "claude/sonnet",
    dispatchId: "d1",
    dispatcherAgentId: "dispatcher",
    depth: 1,
  });
  assert.equal(ticket.body.includes("岗位："), false);
});

test("任务级 repoKey 原样带到计划里（多仓库工作区靠它决定票写在哪）", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", repoKey: "owner/api" }]),
  );
  assert.equal(plan.tasks[0].repoKey, "owner/api");
  assert.equal(plan.tasks[0].labels.repo, undefined, "仓库不进会话标签：它不是认出这是谁的键");
});

test("多仓库工作区没写 repoKey：计划阶段就拒，并列出有哪些仓库", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", staff: "frontend" }], {
      repoKeys: ["owner/web", "owner/api"],
      roles: [
        {
          workspaceId: "w1",
          dispatcherAgentId: "dispatcher",
          staff: normalizeStaffCards([card()]),
        },
      ],
    }),
  );
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "repo-required");
  assert.match(plan.rejected[0].detail, /owner\/web \/ owner\/api/);
});

test("单仓库工作区不要求写 repoKey", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事" }], { repoKeys: ["owner/web"] }),
  );
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.tasks.length, 1);
});

test("region.repoKey 可以替任务补上仓库（老调用方只写 repoKey，两种写法等价）", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", region: { repoKey: "owner/api" } }], {
      repoKeys: ["owner/web", "owner/api"],
    }),
  );
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.tasks[0].repoKey, "owner/api");
  assert.deepEqual(plan.tasks[0].region, { repoKey: "owner/api" });
});

test("region.pathPrefix 归一后随计划交出去（前导 / 与结尾 / 都去掉）", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", repoKey: "owner/api", region: { pathPrefix: "/src/api/" } }]),
  );
  assert.equal(plan.tasks[0].region.pathPrefix, "src/api");
  assert.equal(plan.tasks[0].repoKey, "owner/api");
});

test("region.pathPrefix 指向工作区外面（..）→ 拒绝，不把越界路径交给归属算法", () => {
  const plan = planDispatch(
    dispatchInput([{ key: "#1", prompt: "做事", region: { pathPrefix: "../other" } }]),
  );
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.rejected[0].reason, "invalid-region");
  assert.match(plan.rejected[0].detail, /不能有 \.\./);
});

test("建卡 id 与名字无关：中文名不填 id 也存得住", () => {
  const id = newStaffId();
  assert.match(id, /^staff-[a-z0-9]{6}$/);
  // 名字是中文、归一化后为空——若拿名字当 id，这张卡会被整张丢掉。
  const cards = normalizeStaffCards([{ id, name: "前端" }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, id);
});

test("建卡 id 会避开已有的：撞了再摇，不是覆盖", () => {
  const first = newStaffId();
  const second = newStaffId([first]);
  assert.notEqual(first, second);
});

test("名字超长截断到 32 字（RPC 与归一化同一条上限）", () => {
  const longName = "名".repeat(MAX_STAFF_NAME_CHARS + 20);
  assert.equal(normalizeStaffCards([{ id: "a", name: longName }])[0].name.length, MAX_STAFF_NAME_CHARS);
});

test("票面抬头写明工作区与仓库：多仓库里「哪个区」要第一眼看得对", () => {
  const ticket = buildDispatchTicket({
    key: "#12",
    prompt: "做事",
    difficulty: "normal",
    providerSpec: "claude/sonnet",
    dispatchId: "d1",
    dispatcherAgentId: "dispatcher",
    depth: 1,
    workspaceId: "w1",
    repoKey: "owner/api",
  });
  assert.match(ticket.body, /- 工作区：`w1`/);
  assert.match(ticket.body, /- 仓库：`owner\/api`/);
});

test("没给工作区与仓库时票面不多这两行（单仓库的票与今天一致）", () => {
  const ticket = buildDispatchTicket({
    key: "#12",
    prompt: "做事",
    difficulty: "normal",
    providerSpec: "claude/sonnet",
    dispatchId: "d1",
    dispatcherAgentId: "dispatcher",
    depth: 1,
  });
  assert.equal(ticket.body.includes("- 工作区："), false);
  assert.equal(ticket.body.includes("- 仓库："), false);
});

test("经理卡不参与「至少几个员工同时干」的计数", () => {
  const plan = planDispatch(
    dispatchInput(
      [
        { key: "#1", prompt: "做事", staff: "boss" },
        { key: "#2", prompt: "做事", staff: "boss" },
      ],
      {
        minConcurrentStaff: 2,
        roles: [
          {
            workspaceId: "w1",
            dispatcherAgentId: "dispatcher",
            staff: normalizeStaffCards([{ id: "boss", name: "经理", kind: "manager" }]),
          },
        ],
      },
    ),
  );
  assert.equal(plan.rejected[0].reason, "min-concurrent-staff");
  assert.match(plan.rejected[0].detail, /只有 0 张员工卡/);
});

test("铺开度按真的放行的算：被别的理由拒掉的任务不算人头", () => {
  const plan = planDispatch(
    dispatchInput(
      [
        { key: "#1", prompt: "做事", staff: "web-a" },
        { key: "#2", prompt: "", staff: "web-b" }, // 空提示词，会在计数前就被拒
      ],
      {
        minConcurrentStaff: 2,
        roles: [
          {
            workspaceId: "w1",
            dispatcherAgentId: "dispatcher",
            staff: normalizeStaffCards([
              { id: "web-a", name: "A" },
              { id: "web-b", name: "B" },
            ]),
          },
        ],
      },
    ),
  );
  assert.equal(plan.tasks.length, 0, "只剩一张卡真的铺开了，整批不该过闸");
  assert.ok(plan.rejected.some((item) => item.reason === "empty-prompt"));
  assert.match(plan.rejected.at(-1).detail, /实际只铺到 1 张/);
});

test("铺开度按真的放行的算：写了个不存在的 id 不算人头", () => {
  const plan = planDispatch(
    dispatchInput(
      [
        { key: "#1", prompt: "做事", staff: "web-a" },
        { key: "#2", prompt: "做事", staff: "nobody" },
      ],
      {
        minConcurrentStaff: 2,
        roles: [
          {
            workspaceId: "w1",
            dispatcherAgentId: "dispatcher",
            staff: normalizeStaffCards([
              { id: "web-a", name: "A" },
              { id: "web-b", name: "B" },
            ]),
          },
        ],
      },
    ),
  );
  assert.equal(plan.tasks.length, 0);
  assert.ok(plan.rejected.some((item) => item.reason === "unknown-staff"));
  assert.match(plan.rejected.at(-1).detail, /实际只铺到 1 张/);
});

// ---------------------------------------------------------------------------
// 票面入参：两条调用路径必须拼出同一张票
// ---------------------------------------------------------------------------

test("ticketSpecOf：任务与卡上的抬头字段一一搬进票面", () => {
  const spec = ticketSpecOf({
    task: {
      key: "#12",
      prompt: "做事",
      title: "自定义标题",
      difficulty: "hard",
      providerSpec: "claude/sonnet",
      map: "owner/web#3",
      routeFrom: "normal",
      repoKey: "owner/api",
    },
    card: { id: "frontend", name: "前端", kind: "worker", maxConcurrent: 1 },
    dispatchId: "d1",
    dispatcherAgentId: "dispatcher",
    depth: 2,
    workspaceId: "w1",
  });
  assert.deepEqual(spec.staff, { id: "frontend", name: "前端" });
  assert.equal(spec.repoKey, "owner/api");
  assert.equal(spec.workspaceId, "w1");
  assert.equal(spec.map, "owner/web#3");
  assert.equal(spec.routeFrom, "normal");
  assert.equal(spec.title, "自定义标题");
  assert.equal(spec.depth, 2);
});

test("ticketSpecOf：没有卡、没有可选字段时不多带空字段", () => {
  const spec = ticketSpecOf({
    task: { key: "#1", prompt: "做事", difficulty: "normal", providerSpec: "claude/sonnet" },
    card: null,
    dispatchId: "d1",
    dispatcherAgentId: "dispatcher",
    depth: 1,
  });
  assert.equal("staff" in spec, false);
  assert.equal("repoKey" in spec, false);
  assert.equal("workspaceId" in spec, false);
  assert.equal("map" in spec, false);
  assert.equal("routeFrom" in spec, false);
});

test("ticketSpecOf → buildDispatchTicket：repoKey 真的落在票面上（不是只进计划对象）", () => {
  const ticket = buildDispatchTicket(
    ticketSpecOf({
      task: { key: "#12", prompt: "做事", difficulty: "normal", providerSpec: "claude/sonnet", repoKey: "owner/api" },
      card: null,
      dispatchId: "d1",
      dispatcherAgentId: "dispatcher",
      depth: 1,
      workspaceId: "w1",
    }),
  );
  assert.match(ticket.body, /- 仓库：`owner\/api`/);
  assert.match(ticket.body, /- 工作区：`w1`/);
});

// ---------------------------------------------------------------------------
// RPC 边界：坏的 id 到这里就要被拦下
// ---------------------------------------------------------------------------

test("staffCardSchema：合法卡原样通过，默认值不替调用方补", () => {
  const parsed = staffCardSchema.parse({ id: "web-admin", name: "前端" });
  assert.deepEqual(parsed, { id: "web-admin", name: "前端" });
});

test("staffCardSchema：大写 id 与超长名字被拒（与归一化不是同一套口径）", () => {
  assert.equal(staffCardSchema.safeParse({ id: "Web", name: "前端" }).success, false);
  assert.equal(staffCardSchema.safeParse({ id: "a b", name: "前端" }).success, false);
  assert.equal(
    staffCardSchema.safeParse({ id: "web", name: "名".repeat(MAX_STAFF_NAME_CHARS + 1) }).success,
    false,
  );
});

test("staffCardSchema：领地上限与并发上限和归一化同一组常量", () => {
  assert.equal(
    staffCardSchema.safeParse({
      id: "web",
      name: "前端",
      paths: Array.from({ length: MAX_STAFF_PATHS + 1 }, (_, index) => `p${index}`),
    }).success,
    false,
  );
  assert.equal(staffCardSchema.safeParse({ id: "web", name: "前端", maxConcurrent: 9 }).success, false);
});
