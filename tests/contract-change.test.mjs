import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyContractChange, diffImpactRows } from "../server/contract-change.ts";
import { findTool } from "../server/mcp/tools.ts";
import { readGroup } from "../server/group-store.ts";
import { coordinationFileOf } from "../server/staff-territory.ts";
import { createLocalIssue, getLocalIssue } from "../server/tracker/local.ts";

/**
 * 影响面链条变更：diff 只认第五列声明了链条的行；apply 把结果送到票面、
 * 协调收件箱与群记录，任何一步失败都只进 warnings。
 */

const TABLE_HEAD = [
  "## 影响面",
  "| 区 / 仓库 | 依据 | 结论 | 核的人 | 链条（没有就留空） |",
  "|---|---|---|---|---|",
];

const row = (area, chain, basis = "src/main.ts:1") =>
  `| ${area} | ${basis} | 要动 | 某人（2026-11-04） | ${chain} |`;

const table = (...rows) => [...TABLE_HEAD, ...rows].join("\n");

const CONTRACT_OLD = table(row("app", "契约：GET /x"));
const CONTRACT_NEW = table(row("app", "契约：POST /x"));

async function tempWorkspace(t, prefix = "deck-contract-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/* ---------------------------------------------------------------- 纯 diff */

test("第五列从 GET 改成 POST → 一条「契约摘要」变化", () => {
  assert.deepEqual(diffImpactRows(CONTRACT_OLD, CONTRACT_NEW), [{
    area: "app",
    repo: "app",
    field: "契约摘要",
    before: "GET /x",
    after: "POST /x",
  }]);
});

test("「契约在哪」改了 → field 写清是哪一列", () => {
  const before = table(row("app", "详见 #1"));
  const after = table(row("app", "详见 #2"));
  assert.deepEqual(diffImpactRows(before, after), [{
    area: "app",
    repo: "app",
    field: "契约在哪",
    before: "#1",
    after: "#2",
  }]);
});

test("权益项 / 存量升级改了 → 各自命中", () => {
  const oldBody = table(row("saas", "权益：feature_key=coupon，存量升级=否"));
  const feature = table(row("saas", "权益：feature_key=discount，存量升级=否"));
  assert.deepEqual(diffImpactRows(oldBody, feature), [{
    area: "saas",
    repo: "saas",
    field: "权益项",
    before: "coupon",
    after: "discount",
  }]);

  const upgrade = table(row("saas", "权益：feature_key=coupon，存量升级=是"));
  assert.deepEqual(diffImpactRows(oldBody, upgrade), [{
    area: "saas",
    repo: "saas",
    field: "存量升级",
    before: "否",
    after: "是",
  }]);

  const both = table(row("saas", "权益：feature_key=discount，存量升级=是"));
  assert.deepEqual(
    diffImpactRows(oldBody, both).map((change) => change.field).sort(),
    ["存量升级", "权益项"],
  );
});

test("没声明链条的行改字 → 不算契约变更", () => {
  const before = table(row("app", "", "src/old.ts:1"));
  const after = table(row("app", "", "src/new.ts:1"));
  assert.deepEqual(diffImpactRows(before, after), []);
});

test("没有影响面表 / 表里没有链条行 → 空数组", () => {
  assert.deepEqual(diffImpactRows("## 问题\n没有表", CONTRACT_NEW), []);
  assert.deepEqual(diffImpactRows(CONTRACT_OLD, "## 问题\n没有表"), []);
  assert.deepEqual(diffImpactRows(table(row("app", "")), table(row("app", ""))), []);
});

test("新增 / 删除一条有链条的行 → 命中并标明", () => {
  const before = table(row("app", "契约：GET /x"), row("saas", "权益：feature_key=coupon，存量升级=否"));
  const after = table(row("app", "契约：GET /x"), row("web", "契约：GET /y"));
  const changes = diffImpactRows(before, after);
  const removed = changes.find((change) => change.area === "saas");
  const added = changes.find((change) => change.area === "web");
  assert.equal(removed?.field, "删除行");
  assert.match(removed?.before ?? "", /feature_key=coupon/);
  assert.equal(added?.field, "新增行");
  assert.equal(added?.after, "契约：GET /y");
});

/* ---------------------------------------------------------------- 落盘 */

test("applyContractChange：协调记录一行 contract、群一条 system、notes 写进票面", async (t) => {
  const dir = await tempWorkspace(t);
  const created = await createLocalIssue(dir, { title: "需求：优惠券", body: CONTRACT_OLD, labels: ["requirement"] });
  assert.equal(created.ok, true);

  const result = await applyContractChange({
    workspaceDir: dir,
    workspaceId: "ws-contract",
    requirementNumber: created.number,
    changes: diffImpactRows(CONTRACT_OLD, CONTRACT_NEW),
    repoKey: "local",
    currentRef: `#${created.number}`,
    counterpartRefs: [],
    sessionAgentId: "agent-test",
    by: "测试",
    at: "2026-11-04T00:00:00.000Z",
  });

  assert.equal(result.changes, 1);
  assert.equal(result.notes, 1);
  assert.equal(result.coordination, 1);
  assert.equal(result.groupMessages, 1);
  assert.deepEqual(result.warnings, []);

  const lines = (await readFile(coordinationFileOf(dir), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.kind, "contract");
  assert.equal(record.field, "app · 契约摘要");
  assert.match(record.taskSummary, /GET \/x/);
  assert.equal(record.sessionAgentId, "agent-test");

  const group = await readGroup(dir, "ws-contract");
  assert.equal(group.records.length, 1);
  assert.equal(group.records[0].kind, "system");
  assert.equal(group.records[0].from, "deck");
  assert.match(group.records[0].text, /契约变更/);

  const detail = await getLocalIssue(dir, created.number);
  assert.equal(detail.ok, true);
  assert.equal(detail.comments.length, 1);
  assert.match(detail.comments[0].body, /契约变更（影响面）：app · 契约摘要/);
  assert.match(detail.comments[0].body, /GET \/x/);
});

test("applyContractChange：带仓库键的票面引用（owner/repo#N 形状）走跨仓库写入口", async (t) => {
  const dir = await tempWorkspace(t, "deck-contract-ref-");
  const created = await createLocalIssue(dir, { title: "需求：优惠券", body: CONTRACT_OLD, labels: ["requirement"] });
  assert.equal(created.ok, true);

  const result = await applyContractChange({
    workspaceDir: dir,
    workspaceId: "ws-ref",
    requirementNumber: created.number,
    changes: diffImpactRows(CONTRACT_OLD, CONTRACT_NEW),
    repoKey: "local",
    currentRef: `#${created.number}`,
    // 本地后端的仓库键是 local；这条走 parseRef + resolveWritableBackend 的带前缀分支。
    counterpartRefs: [`local#${created.number}`],
    sessionAgentId: "agent-ref",
    by: "测试",
    at: "2026-11-04T00:00:00.000Z",
  });

  assert.equal(result.notes, 2, "当前票与 local#N 两个引用各写一笔");
  assert.deepEqual(result.warnings, []);
  const detail = await getLocalIssue(dir, created.number);
  assert.equal(detail.ok, true);
  assert.equal(detail.comments.length, 2);
});

test("applyContractChange：一步失败时其余照做，warnings 可读", async (t) => {
  const dir = await tempWorkspace(t);
  const written = [];
  const result = await applyContractChange({
    workspaceDir: dir,
    workspaceId: "ws-fail",
    requirementNumber: 7,
    changes: diffImpactRows(CONTRACT_OLD, CONTRACT_NEW),
    repoKey: "local",
    currentRef: "#7",
    counterpartRefs: ["app#2", "app#3"],
    // 协调记录会因为会话 id 为空失败；notes 与群消息仍要写。
    sessionAgentId: "",
    by: "测试",
    at: "2026-11-04T00:00:00.000Z",
    writeNote: async (ref, body) => {
      if (ref === "app#3") return { ok: false, detail: "远端拒绝" };
      written.push({ ref, body });
      return { ok: true };
    },
  });

  assert.equal(result.notes, 2, "当前票与 app#2 照写，只有 app#3 失败");
  assert.equal(result.coordination, 0);
  assert.equal(result.groupMessages, 1);
  assert.deepEqual(written.map((item) => item.ref), ["#7", "app#2"]);
  assert.ok(result.warnings.some((item) => item.includes("协调记录")), "协调失败要进 warnings");
  assert.ok(result.warnings.some((item) => item.includes("app#3")), "写失败的票面要点名");
});

/* ---------------------------------------------------------------- 接进 deck_issue_patch */

test("deck_issue_patch：影响面链条变了 → 票面留一笔，patch 本身仍然成功", async (t) => {
  const dir = await tempWorkspace(t, "deck-contract-patch-");
  await mkdir(join(dir, ".deck"), { recursive: true });
  await writeFile(join(dir, ".deck", "orchestration.json"), JSON.stringify({ workspaceId: "ws-patch" }), "utf8");
  const created = await createLocalIssue(dir, { title: "需求：优惠券", body: CONTRACT_OLD, labels: ["requirement"] });
  assert.equal(created.ok, true);

  await withEnv({ PASEO_AGENT_ID: "agent-patch" }, async () => {
    const result = await findTool("deck_issue_patch").run(
      { number: created.number, body: CONTRACT_NEW },
      { workspaceDir: dir, now: () => new Date("2026-11-04T00:00:00.000Z") },
    );
    assert.equal(result.isError, false, result.text);
    const output = JSON.parse(result.text);
    assert.equal(output.ok, true);
    assert.equal(output.contractChange.changes, 1);
    assert.equal(output.contractChange.notes, 1);
    assert.equal(output.contractChange.coordination, 1);
    assert.equal(output.contractChange.groupMessages, 1);
    assert.deepEqual(output.contractChange.warnings, []);
    assert.equal(output.partial, false);
  });

  const detail = await getLocalIssue(dir, created.number);
  assert.equal(detail.ok, true);
  assert.match(detail.issue.body, /契约：POST \/x/, "patch 正文仍然写进去了");
  assert.equal(detail.comments.length, 1);
  assert.match(detail.comments[0].body, /契约变更/);

  const coordination = await readFile(coordinationFileOf(dir), "utf8");
  assert.match(coordination, /"kind":"contract"/);
});
