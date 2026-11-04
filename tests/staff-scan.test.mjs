import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_STAFF_SCAN_CANDIDATES,
  parseStaffScan,
  staffScanKeyOf,
} from "../shared/staff-scan.ts";
import { MAX_STAFF_DUTY_CHARS } from "../shared/staff.ts";
import { adoptScanCandidates } from "../client/deck/surfaces/orchestration/scan-model.ts";
import { MAX_STAFF_CARDS } from "../shared/staff.ts";

/**
 * 扫岗结果是模型写的，服务端只读不执行：这里是它进名册之前唯一的一道闸。
 * 这些用例钉的是「什么该留下、什么该丢掉、丢掉时说不说得出为什么」。
 */

const candidate = (overrides = {}) => ({
  name: "前端",
  kind: "worker",
  duty: "改界面",
  paths: ["src/web"],
  evidence: ["src/web/app.tsx"],
  ...overrides,
});

test("一份正常的扫描结果：原样收下，kind 缺省按员工", () => {
  const parsed = parseStaffScan({
    candidates: [
      candidate(),
      candidate({ name: "后端", kind: "manager", paths: ["server"], evidence: [] }),
      candidate({ name: "文档", paths: [], duty: "" }),
    ],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.candidates.map((item) => [item.name, item.kind, item.paths]),
    [
      ["前端", "worker", ["src/web"]],
      ["后端", "manager", ["server"]],
      ["文档", "worker", []],
    ],
  );
  assert.deepEqual(parsed.warnings, []);
});

test("没有 candidates 数组：这次扫描没结果，报失败而不是交一张空表", () => {
  assert.deepEqual(parseStaffScan({}), {
    ok: false,
    detail: "扫描结果里没有 candidates 数组——这次扫描没写出候选",
  });
  assert.equal(parseStaffScan(null).ok, false);
  assert.equal(parseStaffScan("[]").ok, false);
});

test("没有名字的候选丢掉，并说出是第几条", () => {
  const parsed = parseStaffScan({ candidates: [candidate({ name: "  " }), candidate()] });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.candidates.map((item) => item.name), ["前端"]);
  assert.match(parsed.warnings[0], /第 1 条候选没有名字/);
});

test("身份只认 manager 与 worker：别的一律按员工，不凭空长出经理", () => {
  const parsed = parseStaffScan({
    candidates: [candidate({ kind: "boss" }), candidate({ name: "经理", kind: "manager" })],
  });
  assert.deepEqual(parsed.candidates.map((item) => item.kind), ["worker", "manager"]);
});

test("领地归一：去 ./ 与前导斜杠、去重、封顶", () => {
  const parsed = parseStaffScan({
    candidates: [candidate({ paths: ["./src/web/", "/server", "src/web"] })],
  });
  assert.deepEqual(parsed.candidates[0].paths, ["src/web", "server"]);
});

test("声称的领地不存在：整条丢掉，不给人一张编出来的地图", () => {
  const parsed = parseStaffScan(
    { candidates: [candidate({ paths: ["src/web", "src/ghost"] }), candidate({ name: "后端" })] },
    (path) => path !== "src/ghost",
  );
  assert.deepEqual(parsed.candidates.map((item) => item.name), ["后端"]);
  assert.match(parsed.warnings[0], /src\/ghost/);
});

test("领地指到工作区外面（..）：整条丢掉", () => {
  const parsed = parseStaffScan({ candidates: [candidate({ paths: ["../other-repo"] })] });
  assert.deepEqual(parsed.candidates, []);
  assert.match(parsed.warnings[0], /工作区外面/);
});

test("职责过长就截断，不把一整篇散文塞进系统提示", () => {
  const parsed = parseStaffScan({ candidates: [candidate({ duty: "啊".repeat(5000) })] });
  assert.equal(parsed.candidates[0].duty.length, MAX_STAFF_DUTY_CHARS);
});

test("同名同领地的重复候选合并成一条，连点两次不会长出两张卡", () => {
  const parsed = parseStaffScan({ candidates: [candidate(), candidate()] });
  assert.equal(parsed.candidates.length, 1);
  assert.match(parsed.warnings[0], /重复出现/);
});

test("候选太多只留前 12 条，并明说还有没收下的", () => {
  const many = Array.from({ length: MAX_STAFF_SCAN_CANDIDATES + 3 }, (_, index) =>
    candidate({ name: `岗 ${index}`, paths: [`dir-${index}`] }),
  );
  const parsed = parseStaffScan({ candidates: many });
  assert.equal(parsed.candidates.length, MAX_STAFF_SCAN_CANDIDATES);
  assert.match(parsed.warnings.at(-1), /另有 3 条候选没能收下/);
});

test("依据只留前几条，且不重复", () => {
  const parsed = parseStaffScan({
    candidates: [candidate({ evidence: ["a", "a", "b", "c", "d", "e", "f", "g"] })],
  });
  assert.deepEqual(parsed.candidates[0].evidence, ["a", "b", "c", "d", "e", "f"]);
});

test("空结果也要说一句，不让人对着空白猜「是不是跑挂了」", () => {
  const parsed = parseStaffScan({ candidates: [] });
  assert.deepEqual(parsed.candidates, []);
  assert.match(parsed.warnings[0], /没有提出任何岗位/);
});

test("采纳去重键与路径顺序无关", () => {
  assert.equal(
    staffScanKeyOf({ name: "前端", paths: ["a", "b"] }),
    staffScanKeyOf({ name: " 前端 ", paths: ["b", "a"] }),
  );
});

/* ---------------------------------------------------------------- 采纳 */

const scanCandidate = (overrides = {}) => ({
  name: "前端",
  kind: "worker",
  duty: "改界面",
  paths: ["src/web"],
  evidence: ["src/web/app.tsx"],
  ...overrides,
});

const staffCard = (overrides = {}) => ({ id: "staff-aaaaaa", name: "旧卡", maxConcurrent: 1, ...overrides });

test("采纳只追加：已有的卡一个字段都不动", () => {
  const current = [staffCard({ name: "前端", paths: ["src/web"], duty: "人改过的职责" })];
  const result = adoptScanCandidates(current, [scanCandidate({ name: "后端", paths: ["server"] })]);
  assert.equal(result.added, 1);
  assert.equal(result.cards[0], current[0]);
  assert.deepEqual(result.cards[1].paths, ["server"]);
  assert.equal(result.cards[1].kind, "worker");
  assert.equal(result.cards[1].maxConcurrent, 1);
});

test("同名同领地已经在名册上：跳过，连点两次不会翻倍", () => {
  const current = [staffCard({ name: "前端", paths: ["src/web"] })];
  const result = adoptScanCandidates(current, [scanCandidate()]);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.cards.length, 1);
});

test("新卡的 id 现场生成，与名字无关且互不相同", () => {
  const result = adoptScanCandidates([], [
    scanCandidate({ name: "前端", paths: ["src/web"] }),
    scanCandidate({ name: "后端", paths: ["server"] }),
  ]);
  const ids = result.cards.map((card) => card.id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, /^staff-[a-z0-9]{6}$/);
});

test("没给职责与领地时不写空字段：空串职责会变成一段空系统提示", () => {
  const result = adoptScanCandidates([], [scanCandidate({ duty: "", paths: [] })]);
  assert.equal("duty" in result.cards[0], false);
  assert.equal("paths" in result.cards[0], false);
});

test("名册满了：超出的条数说出来，不悄悄丢", () => {
  const current = Array.from({ length: MAX_STAFF_CARDS }, (_, index) =>
    staffCard({ id: `staff-fill${index}`, name: `已有 ${index}`, paths: [`dir-${index}`] }),
  );
  const result = adoptScanCandidates(current, [scanCandidate(), scanCandidate({ name: "后端", paths: ["server"] })]);
  assert.equal(result.added, 0);
  assert.equal(result.overLimit, 2);
  assert.equal(result.cards.length, MAX_STAFF_CARDS);
});

/* ------------------------------------------------------------ 清点与简报 */

const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { buildScanBrief, inventoryOf } = await import("../server/staff-scan-brief.ts");

/** 造一个小小的「仓库」：依赖与产物目录必须有，否则测不出「会不会把 node_modules 当岗」。 */
async function fakeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "staff-scan-"));
  await mkdir(join(dir, "src", "web"), { recursive: true });
  await mkdir(join(dir, "server", "rpc"), { recursive: true });
  await mkdir(join(dir, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(dir, "dist"), { recursive: true });
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });
  await writeFile(join(dir, "package.json"), "{}");
  await writeFile(join(dir, "AGENTS.md"), "# x");
  await writeFile(join(dir, ".github", "workflows", "ci.yml"), "on: push");
  return dir;
}

test("清点只读两层，并且跳过依赖与产物目录", async () => {
  const dir = await fakeRepo();
  const inventory = await inventoryOf(dir);
  const names = inventory.dirs.map((entry) => entry.name);
  assert.deepEqual(names.sort(), ["server", "src"]);
  assert.equal(names.includes("node_modules"), false);
  assert.equal(names.includes("dist"), false);
  assert.deepEqual(inventory.files, ["AGENTS.md", "package.json"]);
  assert.deepEqual(inventory.ci, [".github/workflows/ci.yml"]);
  const web = inventory.dirs.find((entry) => entry.name === "src");
  assert.deepEqual(web.children, ["web/"]);
});

test("简报带上现有名册，免得扫出同一片领地", () => {
  const brief = buildScanBrief(
    {
      workspaceDir: "/w/demo",
      cards: [{ id: "staff-aaaaaa", name: "前端", kind: "manager", paths: ["src/web"], maxConcurrent: 1 }],
    },
    { dirs: [{ name: "src", children: ["web/"] }], files: ["package.json"], ci: [], warnings: [] },
  );
  assert.match(brief, /前端/);
  assert.match(brief, /staff-aaaaaa/);
  assert.match(brief, /src\/web/);
  assert.match(brief, /\.deck\/staff-scan\.json/);
  assert.match(brief, /project-survey/);
});

test("英文简报写英文规矩，且同样指定落盘文件", () => {
  const brief = buildScanBrief(
    { workspaceDir: "/w/demo", cards: [], lang: "en" },
    { dirs: [], files: [], ci: [], warnings: [] },
  );
  assert.match(brief, /Staff scan brief/);
  assert.match(brief, /\.deck\/staff-scan\.json/);
  assert.match(brief, /roster is still empty/);
  assert.equal(brief.includes("名册还是空的"), false);
});
