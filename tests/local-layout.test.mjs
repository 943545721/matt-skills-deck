import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendScratchComment,
  containerConflictOf,
  findIdempotentHit,
  formatTicketNumber,
  idempotencyKeyOf,
  nextTicketNumber,
  numberOfFile,
  parseDeckComments,
  parseDeckIssue,
  parseScratchComments,
  parseScratchRecord,
  planContainerDir,
  planIssuePath,
  renderDeckIssue,
  renderScratchRecord,
  replaceScratchBody,
  setScratchLabels,
  setScratchStatus,
  setScratchTitle,
  slugify,
  ticketEntriesOf,
} from "../shared/local-layout.ts";
import {
  createLocalIssue,
  getLocalIssue,
  initializeLocalScratch,
  listLocalIssues,
  listLocalLabels,
  patchLocalIssue,
  postLocalComment,
  readLocalContainer,
  replaceLocalLabels,
  resetLocalColorCacheForTest,
  resolveLocalStore,
  setLocalIssueState,
  setLocalLabelColors,
} from "../server/tracker/local.ts";

/**
 * 本地 Markdown 布局的纯函数与双读行为。
 * 断言的是 DSH 的原文口径：slug、编号、目录冲突、幂等锚、隐藏字段优先级，
 * 以及 `.deck` / `.scratch` 同读但只写主布局、旧根 `issues/` 只读。
 */

async function makeWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-local-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function put(dir, relative, text) {
  const file = path.join(dir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return file;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function deckText(number, title, extra = {}) {
  const stamp = "2026-01-01T00:00:00.000Z";
  return renderDeckIssue({
    number,
    title,
    state: "OPEN",
    labels: [],
    assignees: [],
    blockedBy: [],
    createdAt: stamp,
    updatedAt: stamp,
    body: `# ${title}\n`,
    ...extra,
  });
}

function ticketText(number, title, extra = {}) {
  return renderScratchRecord({
    kind: "ticket",
    number,
    title,
    body: "## What to build\n\n做这件事。",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
}

/* ------------------------------------------------------------------ slug / 编号 */

test("slugify：与 DSH 同口径，保留各语言字母与数字，最多 40 字", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  买 咖啡  "), "买-咖啡");
  assert.equal(slugify("-- A --"), "a");
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify("x".repeat(50)).length, 40);
  assert.equal(slugify("a---b"), "a-b");
});

test("编号：两位格式、跳过非票文件、取已用最大值 + 1", () => {
  assert.equal(formatTicketNumber(1), "01");
  assert.equal(formatTicketNumber(7), "07");
  assert.equal(formatTicketNumber(100), "100");
  assert.equal(numberOfFile("01-买咖啡.md"), 1);
  assert.equal(numberOfFile("7.md"), 7);
  assert.equal(numberOfFile("README.md"), 0);
  assert.equal(numberOfFile("notes.md"), 0);
  assert.equal(nextTicketNumber(["01-a.md", "3.md", "notes.md", "x.md"]), 4);
  assert.deepEqual(ticketEntriesOf(["02-b.md", "01-a.md", "notes.md"]), [
    { fileName: "01-a.md", number: 1, slug: "a" },
    { fileName: "02-b.md", number: 2, slug: "b" },
  ]);
});

test("路径计划：scratch 从 01 起、deck 用裸数字、容器固定 00", () => {
  const scratch = { root: "/ws/.scratch/feat", kind: "scratch" };
  assert.deepEqual(planIssuePath({ layout: scratch, kind: "issue", title: "Hello World", existing: ["01-a.md", "03-c.md"] }), {
    path: "/ws/.scratch/feat/issues/04-hello-world.md",
    number: 4,
  });
  assert.deepEqual(planIssuePath({ layout: scratch, kind: "map-ticket", title: "问一句", number: 7, existing: [] }), {
    path: "/ws/.scratch/feat/issues/07-问一句.md",
    number: 7,
  });
  assert.deepEqual(planIssuePath({ layout: scratch, kind: "spec", title: "Spec", existing: [] }), {
    path: "/ws/.scratch/feat/spec.md",
    number: 0,
  });
  assert.deepEqual(planIssuePath({ layout: scratch, kind: "map", title: "Map", existing: [] }), {
    path: "/ws/.scratch/feat/map.md",
    number: 0,
  });
  assert.deepEqual(planIssuePath({ layout: { root: "/ws/.deck", kind: "deck" }, kind: "issue", title: "x", existing: ["1.md"] }), {
    path: "/ws/.deck/issues/2.md",
    number: 2,
  });
});

/* ------------------------------------------------------------------ 目录冲突 */

test("目录冲突：一个目录只能放一种容器，点名冲突时给出 -2 建议", () => {
  const conflict = planContainerDir({
    scratchRoot: "/ws/.scratch",
    kind: "spec",
    title: "Hello",
    existing: [{ name: "hello", entries: ["map.md"] }],
    preferredName: "hello",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "conflict");
  assert.equal(conflict.suggestedName, "hello-2");
  assert.match(conflict.detail, /map\.md/);
  assert.equal(containerConflictOf("spec", ["map.md"])?.includes("map.md"), true);
  assert.equal(containerConflictOf("map", ["spec.md"])?.includes("spec.md"), true);
  assert.equal(containerConflictOf("spec", ["issues"]), null);
});

test("目录冲突：已占用目录按标题退到 -2，且能一直试到 -50", () => {
  const next = planContainerDir({
    scratchRoot: "/ws/.scratch",
    kind: "spec",
    title: "Hello",
    existing: [{ name: "hello", entries: ["issues"] }],
  });
  assert.equal(next.ok, true);
  assert.equal(next.name, "hello-2");

  const full = [{ name: "hello", entries: ["issues"] }];
  for (let n = 2; n <= 50; n += 1) full.push({ name: `hello-${n}`, entries: ["issues"] });
  const exhausted = planContainerDir({ scratchRoot: "/ws/.scratch", kind: "spec", title: "Hello", existing: full });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, "conflict");
  assert.match(exhausted.detail, /-50|50 个/);
});

test("目录冲突：票可以与容器同住，但生成的新票目录不抢已占用目录", () => {
  const shared = planContainerDir({
    scratchRoot: "/ws/.scratch",
    kind: "issue",
    title: "Hello",
    existing: [{ name: "hello", entries: ["spec.md", "issues"] }],
    preferredName: "hello",
  });
  assert.deepEqual(shared, { ok: true, name: "hello", path: "/ws/.scratch/hello" });

  const generated = planContainerDir({
    scratchRoot: "/ws/.scratch",
    kind: "issue",
    title: "Hello",
    existing: [{ name: "hello", entries: ["spec.md", "issues"] }],
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.name, "hello-2");
});

/* ------------------------------------------------------------------ 幂等 */

test("幂等锚：只认独占一行的注释，按对象种类只命中对应文件", () => {
  const ticket = "<!-- DSH-IDEMPOTENCY-KEY: key-1 -->\n# 01: 标题\n";
  assert.equal(idempotencyKeyOf(ticket), "key-1");
  assert.equal(idempotencyKeyOf("正文里提到 <!-- DSH-IDEMPOTENCY-KEY: key-1 --> 不算"), "");
  assert.equal(idempotencyKeyOf("<!-- DSH-IDEMPOTENCY-KEY: key-1 --> 后面还有字"), "");
  assert.equal(idempotencyKeyOf(""), "");

  const files = [
    { path: "/ws/.scratch/a/spec.md", text: "<!-- DSH-IDEMPOTENCY-KEY: key-1 -->\n# Spec\n" },
    { path: "/ws/.scratch/a/issues/03-x.md", text: ticket },
  ];
  assert.deepEqual(findIdempotentHit({ kind: "spec", files, idempotencyKey: "key-1" }), { path: "/ws/.scratch/a/spec.md", number: 0 });
  assert.deepEqual(findIdempotentHit({ kind: "issue", files, idempotencyKey: "key-1" }), { path: "/ws/.scratch/a/issues/03-x.md", number: 3 });
  assert.equal(findIdempotentHit({ kind: "issue", files, idempotencyKey: "other" }), null);
  assert.equal(findIdempotentHit({ kind: "issue", files, idempotencyKey: "  " }), null);
});

/* ------------------------------------------------------------------ 票面读写 */

test("票面往返：标题、标签、阻塞、父票、幂等键与隐藏头都读得回来", () => {
  const text = renderScratchRecord({
    kind: "ticket",
    number: 7,
    title: "Fix login",
    body: "## What to build\n\nDo it.",
    labels: ["bug", "wayfinder:map"],
    blockedBy: [2, 3],
    parentKey: "01",
    idempotencyKey: "key-7",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(text, /^<!-- DSH-FORMAT: md-v1 -->/);
  assert.match(text, /<!-- DSH-IDEMPOTENCY-KEY: key-7 -->/);
  const record = parseScratchRecord({ text, number: 7, kind: "ticket" });
  assert.equal(record.number, 7);
  assert.equal(record.title, "Fix login");
  assert.equal(record.state, "OPEN");
  assert.deepEqual(record.labels, ["bug", "wayfinder:map"]);
  assert.deepEqual(record.blockedBy, [2, 3]);
  assert.equal(record.parentKey, "01");
  assert.equal(record.idempotencyKey, "key-7");
  assert.equal(record.createdAt, "2026-01-01T00:00:00.000Z");
  assert.match(record.body, /## What to build/);
  assert.match(record.body, /Do it\./);
});

test("票面读取：可见 Status / Labels 优先于隐藏注释，空标签是明确为空", () => {
  const hidden = "<!-- DSH-STATUS: resolved -->\n<!-- DSH-LABELS: old -->\n# 01: X\n\n**Status:** ready-for-agent\nLabels:\n";
  const record = parseScratchRecord({ text: hidden, number: 1, kind: "ticket" });
  assert.equal(record.state, "OPEN");
  assert.deepEqual(record.labels, []);

  const onlyHidden = "<!-- DSH-STATUS: resolved -->\n<!-- DSH-LABELS: old, new -->\n# 01: X\n\n正文\n";
  const closed = parseScratchRecord({ text: onlyHidden, number: 1, kind: "ticket" });
  assert.equal(closed.state, "CLOSED");
  assert.deepEqual(closed.labels, ["old", "new"]);
});

test("地图子票：Type / Status / Question 按原文形状落盘", () => {
  const text = renderScratchRecord({
    kind: "ticket",
    number: 2,
    title: "要不要拆",
    body: "问题正文",
    labels: ["wayfinder:research"],
    mapTicket: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(text, /^# 02: 要不要拆$/m);
  assert.match(text, /^Type: research$/m);
  assert.match(text, /^Status: claimed$/m);
  assert.match(text, /^## Question$/m);
  const record = parseScratchRecord({ text, number: 2, kind: "ticket" });
  assert.equal(record.title, "要不要拆");
  assert.deepEqual(record.labels, ["wayfinder:research"]);
});

test("段修改：状态保留加粗写法，标签可改隐藏行，标题保留两位编号", () => {
  const bold = setScratchStatus("# 01: X\n\n**Status:** ready-for-agent\n", true);
  assert.match(bold, /^\*\*Status:\*\* resolved$/m);
  const reopened = setScratchStatus(bold, false);
  assert.match(reopened, /^\*\*Status:\*\* ready-for-agent$/m);

  const hidden = setScratchStatus("<!-- DSH-STATUS: ready-for-agent -->\n# 01: X\n", true);
  assert.match(hidden, /<!-- DSH-STATUS: resolved -->/);
  assert.doesNotMatch(hidden, /^Status:/m);

  const labeled = setScratchLabels("# 01: X\n\n**Labels:** bug\n", ["bug", "ux"]);
  assert.match(labeled, /^\*\*Labels:\*\* bug, ux$/m);
  const empty = setScratchLabels("# 01: X\n", []);
  assert.match(empty, /<!-- DSH-LABELS: {2}-->/);
  assert.equal(parseScratchRecord({ text: empty, number: 1, kind: "ticket" }).labels.length, 0);

  assert.match(setScratchTitle("# 01: Old\n", "New"), /^# 01: New$/m);
  assert.match(setScratchTitle("## Problem Statement\n", "Spec title"), /<!-- DSH-TITLE: Spec title -->/);
});

test("整份改正文：标题、状态 / 阻塞 / 标签字段与评论都保住", () => {
  const original = renderScratchRecord({
    kind: "ticket",
    number: 1,
    title: "Old",
    body: "旧正文",
    labels: ["bug"],
    blockedBy: [2],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const withComment = appendScratchComment(original, { author: "ann", createdAt: "2026-01-02T00:00:00.000Z", body: "看过了" });
  const next = replaceScratchBody(withComment, "## New\n\n新正文", "ticket");
  assert.match(next, /<!-- DSH-FORMAT: md-v1 -->/);
  assert.match(next, /^# 01: Old$/m);
  assert.match(next, /^\*\*Status:\*\* ready-for-agent$/m);
  assert.match(next, /^\*\*Blocked by:\*\* 02$/m);
  assert.match(next, /<!-- DSH-LABELS: bug -->/);
  assert.match(next, /## New/);
  assert.match(next, /## Comments/);
  assert.match(next, /看过了/);
});

test("评论：按 ### 作者 — ISO 解析，追加保持顺序", () => {
  const one = appendScratchComment("# 01: X\n", { author: "ann", createdAt: "2026-01-02T00:00:00.000Z", body: "第一条" });
  const two = appendScratchComment(one, { author: "bob", createdAt: "2026-01-03T00:00:00.000Z", body: "第二条" });
  const comments = parseScratchComments(two);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].author, "ann");
  assert.equal(comments[0].createdAt, "2026-01-02T00:00:00.000Z");
  assert.equal(comments[0].body, "第一条");
  assert.equal(comments[1].author, "bob");
});

test(".deck 票面：frontmatter 往返、缺头当非票、坏评论按空处理", () => {
  const text = deckText(3, "Deck 票", { state: "CLOSED", labels: ["bug"], assignees: ["ann"], blockedBy: [1] });
  const record = parseDeckIssue(text, 99);
  assert.equal(record.number, 3);
  assert.equal(record.title, "Deck 票");
  assert.equal(record.state, "CLOSED");
  assert.deepEqual(record.labels, ["bug"]);
  assert.deepEqual(record.assignees, ["ann"]);
  assert.deepEqual(record.blockedBy, [1]);
  assert.equal(parseDeckIssue("没有文件头", 1), null);
  assert.equal(parseDeckIssue("---\nnumber: x\n---\nbody", 4).number, 4);
  assert.deepEqual(parseDeckComments("not json"), []);
  assert.deepEqual(parseDeckComments(JSON.stringify([{ author: "a", createdAt: "t", body: "b" }, { body: "" }])), [
    { author: "a", createdAt: "t", body: "b" },
  ]);
});

/* ------------------------------------------------------------------ 双读与写路径 */

test("双读：.deck 与 .scratch 同时可见，旧根 issues/ 只读", async (t) => {
  const dir = await makeWorkspace(t);
  await put(dir, ".deck/issues/2.md", deckText(2, "deck two"));
  await put(dir, ".scratch/feature/issues/01-scratch.md", ticketText(1, "scratch one"));
  await put(dir, "issues/03-legacy.md", ticketText(3, "legacy root"));

  const store = await resolveLocalStore(dir);
  assert.equal(store.deckActive, true);
  assert.equal(store.scratchActive, true);
  assert.equal(store.primary.kind, "deck");
  assert.equal(store.primary.root, path.join(dir, ".deck"));

  resetLocalColorCacheForTest();
  const list = await listLocalIssues(dir, { view: "all" });
  assert.equal(list.ok, true);
  assert.deepEqual(list.issues.map((issue) => issue.number).sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(list.totalCount, 3);
  assert.equal(list.source, "local");

  const legacy = await getLocalIssue(dir, 3);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.issue.title, "legacy root");
  const blocked = await patchLocalIssue(dir, 3, { title: "改了" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "invalid");
  assert.match(await readFile(path.join(dir, "issues/03-legacy.md"), "utf8"), /legacy root/);
});

test("双读：同号票按主布局优先，被遮住的那份仍在盘上", async (t) => {
  const dir = await makeWorkspace(t);
  await put(dir, ".deck/issues/1.md", deckText(1, "deck wins"));
  await put(dir, ".scratch/feature/issues/01-scratch.md", ticketText(1, "scratch loses"));

  const detail = await getLocalIssue(dir, 1);
  assert.equal(detail.ok, true);
  assert.equal(detail.issue.title, "deck wins");
  const list = await listLocalIssues(dir, { view: "all" });
  assert.equal(list.issues.length, 1);
  assert.equal(await exists(path.join(dir, ".scratch/feature/issues/01-scratch.md")), true);
});

test("详情父子边：DSH-PARENT 能读回父票，父票能列出手下子票", async (t) => {
  const dir = await makeWorkspace(t);
  const initialized = await initializeLocalScratch(dir, { name: "feature" });
  assert.equal(initialized.ok, true);

  const parent = await createLocalIssue(dir, { title: "父票", body: "", labels: [] });
  assert.equal(parent.ok, true);
  const child = await createLocalIssue(dir, { title: "子票", body: "", labels: [], parentKey: String(parent.number) });
  assert.equal(child.ok, true);

  const parentDetail = await getLocalIssue(dir, parent.number);
  assert.equal(parentDetail.ok, true);
  assert.equal(parentDetail.parent, null);
  assert.deepEqual(parentDetail.children?.map((item) => item.number), [child.number]);
  assert.equal(parentDetail.childrenTotal, 1);

  const childDetail = await getLocalIssue(dir, child.number);
  assert.equal(childDetail.ok, true);
  assert.deepEqual(childDetail.parent, { number: parent.number, title: "父票" });
  // 本地每次都扫全量：没有子票就是空数组，而不是「没查」。
  assert.deepEqual(childDetail.children, []);
  assert.equal(childDetail.childrenTotal, 0);

  const blocked = await createLocalIssue(dir, { title: "被父票阻塞", body: "", labels: [], blockedBy: [parent.number] });
  assert.equal(blocked.ok, true);
  const blockingDetail = await getLocalIssue(dir, parent.number);
  assert.equal(blockingDetail.ok, true);
  assert.deepEqual(blockingDetail.blocking?.map((item) => item.number), [blocked.number]);
});

test(".deck 建票：parentKey 落到文件头，父票必须是地图，前导零按数值认", async (t) => {
  const dir = await makeWorkspace(t);
  const map = await createLocalIssue(dir, { title: "地图", body: "", labels: ["wayfinder:map"] });
  assert.equal(map.ok, true);
  // "01" 与 #1 是同一张票：存进去要归一成 "1"，否则读回时按字符串比会漏。
  const child = await createLocalIssue(dir, { title: "工单", body: "", labels: ["wayfinder:map-ticket"], parentKey: "01" });
  assert.equal(child.ok, true);

  const mapDetail = await getLocalIssue(dir, map.number);
  assert.equal(mapDetail.ok, true);
  assert.deepEqual(mapDetail.children?.map((item) => item.number), [child.number]);
  const raw = await readFile(path.join(dir, ".deck", "issues", `${child.number}.md`), "utf8");
  assert.match(raw, /^parentKey: 1$/m);

  const missing = await createLocalIssue(dir, { title: "孤儿", body: "", labels: [], parentKey: "99" });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /没有父票 #99/);

  const plain = await createLocalIssue(dir, { title: "普通票", body: "", labels: [] });
  assert.equal(plain.ok, true);
  const badParent = await createLocalIssue(dir, { title: "挂普通票", body: "", labels: [], parentKey: String(plain.number) });
  assert.equal(badParent.ok, false);
  assert.match(badParent.detail, /不是探索地图/);

  const badFormat = await createLocalIssue(dir, { title: "怪父票", body: "", labels: [], parentKey: "abc" });
  assert.equal(badFormat.ok, false);
  assert.match(badFormat.detail, /父票号必须是正整数/);
  const specTicket = await createLocalIssue(dir, { title: "实施票", body: "", labels: [], kind: "spec-ticket" });
  assert.equal(specTicket.ok, false);
  assert.match(specTicket.detail, /没有规格容器/);
});

test(".deck 有坏票文件时，详情把子票清单标成截断（关容器不能拿残表核对）", async (t) => {
  const dir = await makeWorkspace(t);
  const map = await createLocalIssue(dir, { title: "地图", body: "", labels: ["wayfinder:map"] });
  assert.equal(map.ok, true);
  await put(dir, ".deck/issues/99.md", "这不是一张票");

  const detail = await getLocalIssue(dir, map.number);
  assert.equal(detail.ok, true);
  assert.equal(detail.childrenTruncated, true);
});

test("新工作区：没显式初始化就不建 .scratch，票落在 .deck", async (t) => {
  const dir = await makeWorkspace(t);
  const store = await resolveLocalStore(dir);
  assert.equal(store.primary.kind, "deck");
  assert.equal(store.scratchActive, false);

  const created = await createLocalIssue(dir, { title: "First", body: "正文", labels: ["bug"] });
  assert.equal(created.ok, true);
  assert.equal(created.number, 1);
  assert.equal(created.path, path.join(dir, ".deck/issues/1.md"));
  assert.equal(await exists(path.join(dir, ".scratch")), false);
  assert.equal(await exists(created.path), true);
});

test("显式初始化：建可写票目录，之后的票写进 .scratch", async (t) => {
  const dir = await makeWorkspace(t);
  const init = await initializeLocalScratch(dir, { name: "Backlog" });
  assert.equal(init.ok, true);
  assert.equal(init.name, "backlog");
  assert.equal(init.created, true);
  assert.equal(init.primary, "scratch");
  assert.equal(await exists(path.join(dir, ".scratch/backlog/issues")), true);

  const again = await initializeLocalScratch(dir, { name: "backlog" });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);

  const created = await createLocalIssue(dir, { title: "First", body: "正文", labels: [] });
  assert.equal(created.ok, true);
  assert.equal(created.number, 1);
  assert.equal(created.path, path.join(dir, ".scratch/backlog/issues/01-first.md"));
});

test("已有 .deck 的工作区：初始化 .scratch 只并行读，写仍回 .deck", async (t) => {
  const dir = await makeWorkspace(t);
  await put(dir, ".deck/issues/1.md", deckText(1, "existing"));
  const init = await initializeLocalScratch(dir, { name: "scratchy" });
  assert.equal(init.ok, true);
  assert.equal(init.primary, "deck");
  assert.match(init.notice, /\.deck/);

  const created = await createLocalIssue(dir, { title: "Second", body: "正文", labels: [] });
  assert.equal(created.ok, true);
  assert.equal(created.number, 2);
  assert.equal(created.path, path.join(dir, ".deck/issues/2.md"));
});

test("并发建票：同一目录里编号不重、文件都在", async (t) => {
  const dir = await makeWorkspace(t);
  await initializeLocalScratch(dir, { name: "work" });
  const [first, second] = await Promise.all([
    createLocalIssue(dir, { title: "Alpha", body: "a", labels: [] }),
    createLocalIssue(dir, { title: "Beta", body: "b", labels: [] }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual([first.number, second.number].sort((a, b) => a - b), [1, 2]);
  assert.equal(await exists(first.path), true);
  assert.equal(await exists(second.path), true);
  const names = await readdir(path.join(dir, ".scratch/work/issues"));
  assert.equal(names.filter((name) => name.endsWith(".md")).length, 2);
});

test("幂等建票：同一个键只落一份，第二次复用原路径", async (t) => {
  const dir = await makeWorkspace(t);
  await initializeLocalScratch(dir, { name: "work" });
  const first = await createLocalIssue(dir, { title: "Same", body: "x", labels: [], idempotencyKey: "key-1" });
  const second = await createLocalIssue(dir, { title: "Changed title", body: "y", labels: [], idempotencyKey: "key-1" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.number, first.number);
  assert.equal(second.path, first.path);
  const names = await readdir(path.join(dir, ".scratch/work/issues"));
  assert.equal(names.filter((name) => name.endsWith(".md")).length, 1);
});

test("幂等键校验：只收字母数字与 . _ : / -，上限 200 字", async (t) => {
  const dir = await makeWorkspace(t);
  await initializeLocalScratch(dir, { name: "work" });
  const bad = await createLocalIssue(dir, { title: "Bad", body: "", labels: [], idempotencyKey: "bad key" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid");
  const huge = await createLocalIssue(dir, { title: "Huge", body: "", labels: [], idempotencyKey: "a".repeat(201) });
  assert.equal(huge.ok, false);
  assert.equal(huge.reason, "invalid");
});

test("容器：spec / map 落对应文件，一个目录不能同时放两种", async (t) => {
  const dir = await makeWorkspace(t);
  await initializeLocalScratch(dir, { name: "work" });

  const spec = await createLocalIssue(dir, { title: "Feature Spec", body: "问题说明", labels: [], kind: "spec", feature: "feature-one" });
  assert.equal(spec.ok, true);
  assert.equal(spec.number, 0);
  assert.equal(spec.path, path.join(dir, ".scratch/feature-one/spec.md"));
  assert.match(await readFile(spec.path, "utf8"), /## Problem Statement/);

  const conflict = await createLocalIssue(dir, { title: "Feature Map", body: "目标", labels: [], kind: "map", effort: "feature-one" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "invalid");
  assert.match(conflict.detail, /spec\.md/);

  const map = await createLocalIssue(dir, { title: "Effort Map", body: "目标", labels: [], kind: "map", effort: "effort-one" });
  assert.equal(map.ok, true);
  assert.equal(map.path, path.join(dir, ".scratch/effort-one/map.md"));

  const readSpec = await readLocalContainer(dir, "spec", "feature-one");
  assert.equal(readSpec.ok, true);
  assert.equal(readSpec.title, "Feature Spec");
  assert.equal(readSpec.kind, "spec");
  assert.equal(readSpec.readOnly, false);
  assert.match(readSpec.body, /问题说明/);

  const secondSpec = await createLocalIssue(dir, { title: "Other Spec", body: "另一个", labels: [], kind: "spec", feature: "feature-two" });
  assert.equal(secondSpec.ok, true);
  const ambiguous = await readLocalContainer(dir, "spec");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "invalid");
});

test("子票：spec-ticket 挂规格目录，map-ticket 写 Type 行并默认父票 00", async (t) => {
  const dir = await makeWorkspace(t);
  await initializeLocalScratch(dir, { name: "work" });
  await createLocalIssue(dir, { title: "Spec", body: "说明", labels: [], kind: "spec", feature: "feature-one" });
  await createLocalIssue(dir, { title: "Map", body: "目标", labels: [], kind: "map", effort: "effort-one" });

  const specTicket = await createLocalIssue(dir, { title: "Spec child", body: "做", labels: [], kind: "spec-ticket" });
  assert.equal(specTicket.ok, true);
  assert.equal(specTicket.path, path.join(dir, ".scratch/feature-one/issues/01-spec-child.md"));
  const specRecord = parseScratchRecord({ text: await readFile(specTicket.path, "utf8"), number: 1, kind: "ticket" });
  assert.equal(specRecord.parentKey, "00");

  const mapTicket = await createLocalIssue(dir, { title: "Map child", body: "问", labels: ["wayfinder:research"], kind: "map-ticket" });
  assert.equal(mapTicket.ok, true);
  assert.equal(mapTicket.path, path.join(dir, ".scratch/effort-one/issues/01-map-child.md"));
  const mapText = await readFile(mapTicket.path, "utf8");
  assert.match(mapText, /^Type: research$/m);
  assert.match(mapText, /^## Question$/m);
});

test("写票：评论、标签、状态、改题都改在正确布局，旧布局拒绝", async (t) => {
  const dir = await makeWorkspace(t);
  await initializeLocalScratch(dir, { name: "work" });
  const created = await createLocalIssue(dir, { title: "Ticket", body: "正文", labels: ["bug"] });
  assert.equal(created.ok, true);

  const commented = await postLocalComment(dir, 1, "第一条评论");
  assert.equal(commented.ok, true);
  const detail = await getLocalIssue(dir, 1);
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.comments[0].body, "第一条评论");

  const labeled = await replaceLocalLabels(dir, 1, ["bug", "ux", "bug"]);
  assert.equal(labeled.ok, true);
  assert.deepEqual(labeled.labels.map((item) => item.name), ["bug", "ux"]);

  const closed = await setLocalIssueState(dir, 1, "closed");
  assert.equal(closed.ok, true);
  assert.equal(closed.state, "CLOSED");
  assert.match(await readFile(created.path, "utf8"), /^\*\*Status:\*\* resolved$/m);

  const patched = await patchLocalIssue(dir, 1, { title: "Renamed", body: "## New\n\n新正文" });
  assert.equal(patched.ok, true);
  assert.equal(patched.title, "Renamed");
  const text = await readFile(created.path, "utf8");
  assert.match(text, /^# 01: Renamed$/m);
  assert.match(text, /新正文/);
});

test("标签配色：.scratch 布局只出计划，绝不写 docs/agents", async (t) => {
  const dir = await makeWorkspace(t);
  await initializeLocalScratch(dir, { name: "work" });
  const yamlPath = await put(dir, "docs/agents/label-colors.yaml", "version: 1\nbug: d73a4a\n");
  const before = await readFile(yamlPath, "utf8");

  const planned = await setLocalLabelColors(dir, [{ name: "bug", color: "#00ff00" }]);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.applied, []);
  assert.equal(planned.plan.dryRun, true);
  assert.equal(planned.plan.path, yamlPath);
  assert.match(planned.plan.text, /bug: "00ff00"/);
  assert.equal(await readFile(yamlPath, "utf8"), before);

  const missing = await setLocalLabelColors(dir, [{ name: "new-label", color: "00ff00" }]);
  assert.equal(missing.ok, true);
  assert.equal(missing.plan, undefined);
  assert.equal(missing.failed[0].name, "new-label");

  const bad = await setLocalLabelColors(dir, [{ name: "__proto__", color: "00ff00" }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid");
});

test("标签目录：文档配色与票面标签合并进列表", async (t) => {
  const dir = await makeWorkspace(t);
  await initializeLocalScratch(dir, { name: "work" });
  await createLocalIssue(dir, { title: "Ticket", body: "正文", labels: ["bug"] });
  await put(dir, "docs/agents/label-colors.yaml", "version: 1\nbug: d73a4a\n");

  resetLocalColorCacheForTest();
  const labels = await listLocalLabels(dir);
  assert.equal(labels.ok, true);
  const bug = labels.labels.find((item) => item.name === "bug");
  assert.equal(bug.color, "d73a4a");

  const list = await listLocalIssues(dir, { view: "open" });
  assert.equal(list.issues[0].labels[0].color, "d73a4a");
});
