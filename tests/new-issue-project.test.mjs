import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { findTool } from "../server/mcp/tools.ts";
import { createIssueHandler, setIssueLabelsHandler } from "../server/rpc/issues.ts";
import { projectForRepo, resolveIssueProjectScope } from "../server/mcp/project-scope.ts";

/**
 * 新建票时的「项目 → 模块」定位，以及地图骨架的接线。
 *
 * 这些用例走的是工具入口 → 领域代码 → 落盘这一整条路（本地 `.deck` 后端，不调 gh），
 * 所以要断言的是**建出来的票上真的挂着那些标签**，而不是某个函数返回了什么。
 * 纯判断（仓库反查项目）另起一条，免得为了一个三行逻辑去造一套远端假数据。
 */

const sandboxes = [];
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function sandbox(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

/** 一个没有远端的工作区：后端回落本地 `.deck/`，建票不碰远端。 */
function workspace() {
  const dir = sandbox("deck-project-ws-");
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
  return dir;
}

/** 一份 v2 项目清单：两个项目、各有自己的模块与角色。 */
const PROJECTS = [
  { key: "backend", dir: "api", repo: "acme/api", owner: "backend", areas: ["orders", "users"] },
  { key: "admin-web", dir: "apps/admin-web", repo: "acme/admin", owner: "frontend", areas: ["pages", "settings"] },
];

function writeProjectConfig(ws, projects = PROJECTS) {
  writeFileSync(
    path.join(ws, ".paseo-deck.json"),
    JSON.stringify({ version: 2, projects }, null, 2),
    "utf8",
  );
}

/** 本地后端一条 gh 都不该调：假 gh 只用来证明「没调」。 */
function quietGh() {
  return fakeGh('process.stdout.write("{}\\n")');
}

const run = (name, args, workspaceDir) => findTool(name).run(args, { workspaceDir });
const json = (result) => {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
};
const failure = (result) => {
  assert.equal(result.isError, true, result.text);
  return JSON.parse(result.text);
};

const deckIssueFile = (ws, number) => readFileSync(path.join(ws, ".deck", "issues", `${number}.md`), "utf8");

/* ---------------------------------------------------------------- 纯判断 */

test("仓库反查项目：按配置里的 repo 比，大小写不敏感，本地后端不往任何项目上撞", () => {
  const projects = PROJECTS.map((project) => ({
    key: project.key,
    dir: project.dir,
    repo: project.repo,
    owner: project.owner,
    areas: project.areas,
    deprecatedAreas: [],
    skillsMode: null,
  }));
  assert.equal(projectForRepo(projects, "acme/api")?.key, "backend");
  assert.equal(projectForRepo(projects, "ACME/API")?.key, "backend");
  assert.equal(projectForRepo(projects, "acme/other"), null);
  assert.equal(projectForRepo(projects, "local"), null);
});

/* ---------------------------------------------------------------- 选项目 + 模块 */

test("多项目下指定项目 + area：建出来的票带 area:x 与 role:<owner>，手写标签不被删", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  writeProjectConfig(ws);
  const gh = quietGh();
  try {
    const created = json(
      await run(
        "deck_issue_create",
        { title: "下单列表要能按状态筛", kind: "issue", project: "backend", area: "orders", labels: ["bug"] },
        ws,
      ),
    );
    // 只增不删：手写的 bug 还在，自动标签补在后面。
    assert.deepEqual(created.labels, ["bug", "area:orders", "role:backend"]);
    assert.deepEqual(created.projectScope, {
      project: "backend",
      area: "orders",
      autoLabels: ["area:orders", "role:backend"],
      warnings: [],
    });
    // 票面上真的挂着这两个标签，而不是只在回执里。
    const stored = deckIssueFile(ws, created.number);
    assert.match(stored, /area:orders/);
    assert.match(stored, /role:backend/);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

test("仓库对得上项目时不给 project 也能定位：只带 role，没选模块时说明清楚", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  writeProjectConfig(ws);
  try {
    const withArea = await resolveIssueProjectScope({ workspaceDir: ws, repoKey: "acme/api", area: "users" });
    assert.equal(withArea.ok, true);
    assert.equal(withArea.scope.project?.key, "backend");
    assert.deepEqual(withArea.scope.labels, ["area:users", "role:backend"]);
    assert.deepEqual(withArea.scope.warnings, []);

    const noArea = await resolveIssueProjectScope({ workspaceDir: ws, repoKey: "acme/api" });
    assert.equal(noArea.ok, true);
    assert.deepEqual(noArea.scope.labels, ["role:backend"]);
    assert.match(noArea.scope.warnings.join(" "), /不会带 area 标签/);
  } finally {
    // 这个用例不建票，没有 gh 要还原。
  }
});

test("area 不在项目的清单里：明确拒绝并列出可选值，一个字都没写", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  writeProjectConfig(ws);
  const gh = quietGh();
  try {
    const rejected = failure(
      await run("deck_issue_create", { title: "不该建出来", kind: "issue", project: "backend", area: "payments" }, ws),
    );
    assert.equal(rejected.reason, "invalid");
    assert.match(rejected.detail, /没有模块「payments」/);
    // 可选值必须列全：只说「不行」等于让人去翻配置文件。
    assert.match(rejected.detail, /orders/);
    assert.match(rejected.detail, /users/);
    assert.match(rejected.detail, /这张票没建/);
    assert.equal(existsSync(path.join(ws, ".deck", "issues")), false);

    const unknownProject = failure(
      await run("deck_issue_create", { title: "也不该建", kind: "issue", project: "nope", area: "orders" }, ws),
    );
    assert.equal(unknownProject.reason, "invalid");
    assert.match(unknownProject.detail, /backend/);
    assert.match(unknownProject.detail, /admin-web/);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

test("area 已标为废弃：拒绝并说清「不要再挂票」，一个文件都不写", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  // 同一个项目的 areas 里既有在用的 orders，也有收了摊的 legacy。
  writeProjectConfig(ws, [
    { key: "backend", dir: "api", repo: "acme/api", owner: "backend", areas: ["orders", "legacy"], deprecatedAreas: ["legacy"] },
  ]);
  const gh = quietGh();
  try {
    const scope = await resolveIssueProjectScope({
      workspaceDir: ws,
      repoKey: "acme/api",
      projectKey: "backend",
      area: "legacy",
    });
    assert.equal(scope.ok, false);
    assert.match(scope.detail, /已标为废弃/);
    assert.match(scope.detail, /deprecatedAreas/, "要点名是哪一段配置把它标成废弃的");
    assert.match(scope.detail, /orders/, "可选值要列出来，只说「不行」等于让人去翻配置");

    const rejected = failure(
      await run("deck_issue_create", { title: "不该建出来", kind: "issue", project: "backend", area: "legacy" }, ws),
    );
    assert.equal(rejected.reason, "invalid");
    assert.match(rejected.detail, /已标为废弃/);
    assert.equal(existsSync(path.join(ws, ".deck", "issues")), false, "校验发生在写之前");

    // 同项目里在用的模块照建：废弃的是那一个模块，不是整个项目。
    const created = json(
      await run("deck_issue_create", { title: "正常模块", kind: "issue", project: "backend", area: "orders" }, ws),
    );
    assert.deepEqual(created.labels, ["area:orders", "role:backend"]);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

/* ---------------------------------------------------------------- 没有清单 */

test("没有 v2 清单：建票行为一点没变，也不自动加 area / role", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const gh = quietGh();
  try {
    const created = json(await run("deck_issue_create", { title: "本地票", kind: "issue", labels: ["bug"] }, ws));
    assert.deepEqual(created.labels, ["bug"]);
    assert.equal(created.projectScope, null);

    // 清单不存在时传 project / area 不能默默忽略：那样人会以为标签已经加上了。
    const rejected = failure(await run("deck_issue_create", { title: "x", kind: "issue", project: "backend" }, ws));
    assert.equal(rejected.reason, "invalid");
    assert.match(rejected.detail, /没有项目清单可用/);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

/* ---------------------------------------------------------------- 地图骨架 */

test("建图时按目标项目的 areas 分组建骨架：五个区块与 area:<k> 决策位都在", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  writeProjectConfig(ws);
  const gh = quietGh();
  try {
    const result = json(
      await run(
        "deck_map_plan_create",
        {
          title: "管理端地图",
          destination: "把管理端的下单链路梳理清楚",
          project: "admin-web",
          notes: "人写的备注",
          decisions: [{ title: "先拆页面清单", gist: "按路由拆" }],
          tickets: [{ title: "先看现有页面", kind: "research" }],
        },
        ws,
      ),
    );
    assert.equal(result.failed, 0);
    assert.deepEqual(result.project, { key: "admin-web", areas: ["pages", "settings"] });

    const body = deckIssueFile(ws, result.map.number);
    // 写与读是一对：五个二级标题一个都不能少（ensureIssueBody 另外补的「## 进度」不在此列）。
    for (const title of ["Destination", "Notes", "Decisions so far", "Not yet specified", "Out of scope"]) {
      assert.match(body, new RegExp(`^## ${title}$`, "m"), `缺少区块：${title}`);
    }
    // DESTINATION 等参数的语义没变：给什么就写什么。
    assert.match(body, /把管理端的下单链路梳理清楚/);
    // 调用方给的备注与决策不能因为「改走骨架」就丢掉。
    assert.match(body, /人写的备注/);
    assert.match(body, /^- \*\*先拆页面清单\*\*：按路由拆$/m);
    // 决策位按该项目的模块分组，而不是拿别人的 area 凑数。
    assert.match(body, /^- \*\*area:pages\*\*/m);
    assert.match(body, /^- \*\*area:settings\*\*/m);
    assert.ok(!body.includes("area:orders"), "不该出现别的项目的模块");
    // 骨架读回来再写出去不能叠出 `- - 条目`：那会让面板上每一项前面多一根横线。
    assert.ok(!body.includes("- - "), "列表符号被叠了两次");
    assert.match(body, /本图只覆盖 admin-web（apps\/admin-web）/);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

test("没有 v2 清单时建图正文保持原样：不凭空造 area", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const gh = quietGh();
  try {
    const result = json(
      await run(
        "deck_map_plan_create",
        { title: "普通地图", destination: "先跑通再说", tickets: [{ title: "先调研", kind: "research" }] },
        ws,
      ),
    );
    assert.equal(result.project, null);
    const body = deckIssueFile(ws, result.map.number);
    assert.match(body, /^## Destination$/m);
    assert.ok(!body.includes("area:"), "没有清单时不该生成 area 决策位");
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

/* --------------------------------------------------------- 面板建票（RPC） */

test("面板建票走同一条校验：area / role 由服务端并进标签，模块写错当场拒绝", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  writeProjectConfig(ws);

  const created = await createIssueHandler({
    workspaceDir: ws,
    title: "面板建的票",
    labels: ["bug"],
    project: "backend",
    area: "orders",
  });
  assert.equal(created.ok, true);
  // 手写的在前、自动加的在后：标签顺序是给人看的，不该被打乱。
  assert.deepEqual(created.labels, ["bug", "area:orders", "role:backend"]);
  // 回执说挂上了不算数，票面上真要有。
  const body = deckIssueFile(ws, created.number);
  assert.match(body, /area:orders/);
  assert.match(body, /role:backend/);

  const rejected = await createIssueHandler({
    workspaceDir: ws,
    title: "不该建出来",
    project: "backend",
    area: "payments",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "invalid");
  assert.match(rejected.detail, /没有模块「payments」/);
  assert.match(rejected.detail, /orders/);
});

test("面板建票：没有 v2 清单时传 project 要明说按不了，不能当作没看见", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const rejected = await createIssueHandler({ workspaceDir: ws, title: "x", project: "backend" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "invalid");
  assert.match(rejected.detail, /项目清单/);

  // 不传时行为与从前一致。
  const plain = await createIssueHandler({ workspaceDir: ws, title: "老样子", labels: ["bug"] });
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.labels, ["bug"]);
});

test("面板建票：正文里的影响面表写坏 → 拒绝，不建这张票", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  // 面板允许直接粘正文，写坏的表不该等到定稿按钮或派单窗口才发现。
  const refused = await createIssueHandler({
    workspaceDir: ws,
    title: "需求：表头写坏",
    body: "## 影响面\n| 区 | 依据 | 结论 | 核的人 |\n|---|---|---|---|",
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "invalid");
  assert.match(refused.detail, /区 \/ 仓库/);

  // 规则没写错的时候照建：这张闸不该挡住正常正文。
  const created = await createIssueHandler({
    workspaceDir: ws,
    title: "需求：表头写对",
    body: "## 影响面\n| 区 / 仓库 | 依据 | 结论 | 核的人 |\n|---|---|---|---|\n| 当前工作区 | 需求票本身 | 要动 | 单区，免核 |",
  });
  assert.equal(created.ok, true);
});

/* ----------------------------------------------------- 定稿标签（服务端复核） */

test("面板补定稿标签：正文这刻不合规就不给打，不拿按钮那一刻的缓存说了算", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const created = await createIssueHandler({
    workspaceDir: ws,
    title: "需求：结论写歪了",
    labels: ["requirement"],
    body: "## 影响面\n| 区 / 仓库 | 依据 | 结论 | 核的人 |\n|---|---|---|---|\n| 当前工作区 | 需求票本身 | 动一下 | 单区，免核 |",
  });
  assert.equal(created.ok, true);

  // 按钮与这次调用之间正文可能变了 / 缓存可能旧：服务端按现在的正文重算一遍。
  const refused = await setIssueLabelsHandler({
    workspaceDir: ws,
    number: created.number,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "invalid");
  assert.match(refused.detail, /结论/);
  assert.match(refused.detail, /没定稿/);
  assert.equal((await deckIssueFile(ws, created.number)).includes("deck:定稿"), false);

  // 正文改对了就放行：这道复核只挡不合规的正文，不挡正常定稿。
  const fixed = await createIssueHandler({
    workspaceDir: ws,
    title: "需求：结论写对了",
    labels: ["requirement"],
    body: "## 影响面\n| 区 / 仓库 | 依据 | 结论 | 核的人 |\n|---|---|---|---|\n| 当前工作区 | 需求票本身 | 要动 | 单区，免核 |",
  });
  assert.equal(fixed.ok, true);
  const accepted = await setIssueLabelsHandler({
    workspaceDir: ws,
    number: fixed.number,
    labels: ["requirement", "deck:定稿"],
  });
  assert.equal(accepted.ok, true);
});
