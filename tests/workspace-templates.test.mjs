import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ISSUE_TEMPLATE_KINDS,
  issueTemplateText,
  planIssueTemplates,
  templateKindsForProject,
  writeIssueTemplates,
} from "../server/workspace/templates.ts";

/**
 * issue 模板的落盘口径。
 *
 * 模板是仓库里的文件，人随时会手改：这里钉住两件事——字段形状固定（新建的票能放在一起看），
 * 以及「只补缺失、绝不覆盖」。测试全部在临时目录里跑，不碰真实仓库。
 */

const FIXED_FIELDS = ["背景", "期望行为", "影响范围（area）", "验收标准", "依赖（Blocked by）"];

const project = (overrides = {}) => ({
  key: "api",
  dir: "api",
  repo: "acme/api",
  owner: "backend",
  areas: ["api"],
  skillsMode: null,
  ...overrides,
});

test("四类模板都在，字段固定五项，且带 area: 与 Blocked by: 提示", () => {
  assert.deepEqual([...ISSUE_TEMPLATE_KINDS], ["backend-api", "frontend-page", "client-app", "license-billing"]);
  for (const kind of ISSUE_TEMPLATE_KINDS) {
    const text = issueTemplateText(kind);
    for (const field of FIXED_FIELDS) assert.ok(text.includes(field), `${kind} 缺少字段「${field}」`);
    assert.match(text, /area:/);
    assert.match(text, /Blocked by:/);
  }
});

test("模板是合法的 issue form 骨架：name / description / body 与六个区块", () => {
  for (const kind of ISSUE_TEMPLATE_KINDS) {
    const text = issueTemplateText(kind);
    assert.match(text, /^name: ".+"$/m);
    assert.match(text, /^description: ".+"$/m);
    assert.match(text, /^labels: \[\]$/m);
    assert.match(text, /^body:$/m);
    // 一段 markdown 说明 + 三个文本区 + 两个输入框。
    assert.equal((text.match(/^ {2}- type: /gm) ?? []).length, 6, `${kind} 的区块数量不对`);
    // 除 markdown 外每个区块都要有 id，否则 GitHub 会拒收这份表单。
    const blocks = text.split(/\n {2}- type: /).slice(1);
    for (const block of blocks) {
      if (block.startsWith("markdown")) continue;
      assert.match(block, /^\s+id: [a-z-]+$/m, `${kind} 有区块缺 id`);
    }
    assert.ok(text.endsWith("\n"));
  }
});

test("按 areas 决定模板：一个项目可以命中多类，顺序与目录里的一致", () => {
  assert.deepEqual(templateKindsForProject({ owner: "backend", areas: ["api", "admin-web"] }), [
    "backend-api",
    "frontend-page",
  ]);
  // 一个 area 同时像两类时两类的模板都写。
  assert.deepEqual(templateKindsForProject({ owner: null, areas: ["billing-api"] }), ["backend-api", "license-billing"]);
  assert.deepEqual(templateKindsForProject({ owner: "license", areas: ["billing-core"] }), ["license-billing"]);
  // 普通业务模块归接口：给登录、订单写对账模板等于让人填错表。
  assert.deepEqual(templateKindsForProject({ owner: null, areas: ["auth"] }), ["backend-api"]);
  assert.deepEqual(templateKindsForProject({ owner: null, areas: ["orders", "account"] }), ["backend-api"]);
  assert.deepEqual(templateKindsForProject({ owner: null, areas: ["cardkey"] }), ["license-billing"]);
});

test("areas 一个都没命中时按 owner 兜底；ops 没有对应模板", () => {
  assert.deepEqual(templateKindsForProject({ owner: "frontend", areas: ["misc"] }), ["frontend-page"]);
  assert.deepEqual(templateKindsForProject({ owner: "miniapp", areas: [] }), ["client-app"]);
  assert.deepEqual(templateKindsForProject({ owner: "ops", areas: ["deploy"] }), []);
  assert.deepEqual(templateKindsForProject({ owner: null, areas: [] }), []);
});

test("落盘计划：缺失的才写，已有的内容一致算「在」，内容不同列成冲突", () => {
  const dir = "/ws";
  const missing = planIssueTemplates({ project: project({ dir: "apps/api" }), readFile: () => null });
  assert.equal(missing.projectKey, "api");
  assert.deepEqual(
    missing.write.map((row) => row.path),
    ["apps/api/.github/ISSUE_TEMPLATE/backend-api.yml"],
  );

  const same = planIssueTemplates({
    project: project(),
    readFile: () => issueTemplateText("backend-api"),
  });
  assert.deepEqual(same.write, []);
  assert.equal(same.present.length, 1);
  assert.deepEqual(same.conflicts, []);

  const different = planIssueTemplates({ project: project(), readFile: () => "name: 我自己的模板\n" });
  assert.deepEqual(different.write, []);
  assert.deepEqual(
    different.conflicts.map((row) => row.path),
    ["api/.github/ISSUE_TEMPLATE/backend-api.yml"],
  );
});

test("落盘计划：没有对应模板的项目给出原因，不静默跳过", () => {
  const plan = planIssueTemplates({ project: project({ owner: "ops", areas: ["deploy"] }), readFile: () => null });
  assert.deepEqual(plan.kinds, []);
  assert.deepEqual(plan.write, []);
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0], /没有对应的 issue 模板/);
});

test("写文件：首轮补齐、再跑一次什么都不写、手改过的文件不被覆盖", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-templates-"));
  try {
    const projects = [
      project({ key: "api", dir: "api", owner: "backend", areas: ["api"] }),
      project({ key: "web", dir: "apps/web", owner: "frontend", areas: ["admin-web"] }),
      project({ key: "ops", dir: "ops", owner: "ops", areas: ["deploy"] }),
    ];

    const first = await writeIssueTemplates(root, projects);
    assert.deepEqual(first.written, [
      "api/.github/ISSUE_TEMPLATE/backend-api.yml",
      "apps/web/.github/ISSUE_TEMPLATE/frontend-page.yml",
    ]);
    assert.deepEqual(first.conflicts, []);
    assert.deepEqual(first.failed, []);
    // ops 项目没有模板，但原因要能被看到。
    const opsPlan = first.plans.find((plan) => plan.projectKey === "ops");
    assert.equal(opsPlan?.notes.length, 1);

    const written = readFileSync(path.join(root, "api", ".github", "ISSUE_TEMPLATE", "backend-api.yml"), "utf8");
    assert.equal(written, issueTemplateText("backend-api"));

    const second = await writeIssueTemplates(root, projects);
    assert.deepEqual(second.written, []);
    assert.equal(second.plans.find((plan) => plan.projectKey === "api")?.present.length, 1);

    // 人改过模板：内容不同就不覆盖，列成冲突。
    const editedPath = path.join(root, "apps", "web", ".github", "ISSUE_TEMPLATE", "frontend-page.yml");
    writeFileSync(editedPath, "name: 我们自己改过的\n", "utf8");
    const third = await writeIssueTemplates(root, projects);
    assert.deepEqual(third.conflicts, ["apps/web/.github/ISSUE_TEMPLATE/frontend-page.yml"]);
    assert.equal(readFileSync(editedPath, "utf8"), "name: 我们自己改过的\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写文件：目录不存在时连父目录一起建，写失败逐条报出", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-templates-mk-"));
  try {
    mkdirSync(path.join(root, "api"));
    const outcome = await writeIssueTemplates(root, [project({ dir: "api" })]);
    assert.deepEqual(outcome.failed, []);
    assert.equal(outcome.written.length, 1);
    assert.ok(readFileSync(path.join(root, "api", ".github", "ISSUE_TEMPLATE", "backend-api.yml"), "utf8").includes("背景"));

    // 把 `.github` 占成一个普通文件：写不进去时要报出路径与原因，而不是静默成功。
    rmSync(path.join(root, "api", ".github"), { recursive: true, force: true });
    writeFileSync(path.join(root, "api", ".github"), "not a directory", "utf8");
    const failed = await writeIssueTemplates(root, [project({ dir: "api" })]);
    assert.equal(failed.written.length, 0);
    assert.equal(failed.failed.length, 1);
    assert.equal(failed.failed[0].path, "api/.github/ISSUE_TEMPLATE/backend-api.yml");
    assert.ok(failed.failed[0].detail.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
