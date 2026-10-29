import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { findTool } from "../server/mcp/tools.ts";
import { countBoard } from "../server/tracker/readiness.ts";
import { readBoard, readIssue, resetDependencyCacheForTest } from "../server/tracker/read.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";
import {
  dependencyRefOf,
  parseCrossRepoBlockRefs,
  renderCrossRepoBlock,
  resolveDependencyRefs,
  upsertCrossRepoBlockedBy,
} from "../shared/edge-rules.ts";

/**
 * 跨仓库依赖：写进正文固定行、读回来合并成一条边。
 *
 * 远端没有跨仓库原生依赖边，所以写的一侧只能落在正文；读的一侧必须把
 * 「原生 blockedBy + 正文行」合并成同一份列表，并且读不到对方的票时**不能**当成已解除。
 */

const sandboxes = [];
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  setSettingsForTest(DEFAULT_SETTINGS);
  delete process.env.FAKE_BETA_STATE;
});

function sandbox(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

function repoAt(parent, dir, url) {
  const repo = path.join(parent, dir);
  mkdirSync(repo);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  if (url) assert.equal(spawnSync("git", ["-C", repo, "remote", "add", "origin", url]).status, 0);
  return repo;
}

function container(remotes) {
  const dir = sandbox("deck-cross-ws-");
  for (const [child, url] of Object.entries(remotes)) repoAt(dir, child, url);
  return dir;
}

function toolGh(source) {
  const dir = sandbox("deck-cross-bin-");
  const script = path.join(dir, "handler.mjs");
  writeFileSync(script, source, "utf8");
  return fakeGh(`exec "${process.execPath}" "${script}" "$@"`);
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

/* ---------------------------------------------------------------- 纯规则 */

const scope = {
  projects: [
    { key: "backend", repo: "one/alpha" },
    { key: "frontend", repo: null },
    { key: "beta", repo: "two/beta" },
  ],
  currentRepo: "one/alpha",
};

test("固定行：整段是一行 `Blocked by:`，多个引用逗号分隔；没有引用时整段不写", () => {
  const block = renderCrossRepoBlock(["two/beta#7", "three/gamma#9"]);
  assert.equal(block, "<!-- DSH-CROSS-REPO-BLOCKED-BY\nBlocked by: two/beta#7, three/gamma#9\n-->");
  assert.deepEqual(parseCrossRepoBlockRefs(`正文\n\n${block}\n`), ["two/beta#7", "three/gamma#9"]);
  assert.equal(renderCrossRepoBlock([]), "");
  assert.deepEqual(parseCrossRepoBlockRefs("正文里没有区段"), []);
});

test("幂等写入：同一组引用重复写不叠加，清空时整段删掉", () => {
  const first = upsertCrossRepoBlockedBy("hello", ["two/beta#7"]);
  assert.equal(first.changed, true);
  assert.equal(first.body, "hello\n\n<!-- DSH-CROSS-REPO-BLOCKED-BY\nBlocked by: two/beta#7\n-->\n");

  const again = upsertCrossRepoBlockedBy(first.body, ["two/beta#7", "two/beta#7"]);
  assert.equal(again.changed, false, "重复写同一组引用不该产生第二行");
  assert.equal(again.body, first.body);

  const replaced = upsertCrossRepoBlockedBy(first.body, ["three/gamma#9"]);
  assert.equal((replaced.body.match(/DSH-CROSS-REPO-BLOCKED-BY/g) ?? []).length, 1);
  assert.deepEqual(parseCrossRepoBlockRefs(replaced.body), ["three/gamma#9"]);

  const cleared = upsertCrossRepoBlockedBy(first.body, []);
  assert.equal(cleared.body, "hello");
  assert.deepEqual(parseCrossRepoBlockRefs(cleared.body), []);
});

test("引用写法：本仓库票号、owner/repo#n、项目键#n 三种都认", () => {
  assert.deepEqual(dependencyRefOf("#12", scope), { ok: true, local: true, number: 12 });
  assert.deepEqual(dependencyRefOf(12, scope), { ok: true, local: true, number: 12 });
  assert.deepEqual(dependencyRefOf("two/beta#7", scope), {
    ok: true,
    local: false,
    repo: "two/beta",
    number: 7,
    ref: "two/beta#7",
  });
  // 项目键要能查到 projects[].key，并且那个项目写了 repo。
  assert.deepEqual(dependencyRefOf("backend#3", scope), {
    ok: true,
    local: false,
    repo: "one/alpha",
    number: 3,
    ref: "one/alpha#3",
  });
});

test("引用写法非法：缺号、仓库不在配置里、项目没写 repo 都拒绝并说清原因", () => {
  const reject = (value, pattern) => {
    const parsed = dependencyRefOf(value, scope);
    assert.equal(parsed.ok, false, `${String(value)} 应该被拒绝`);
    assert.match(parsed.detail, pattern);
  };
  reject("", /空项/);
  reject("two/beta", /认不出来/);
  reject("two/beta#", /认不出来/);
  reject("nope/repo#3", /不在配置里/);
  reject("frontend#3", /没有写 repo/);
  reject("two/beta#0", /票号不合法/);
});

test("整组归一：重复项去重；任何一项写错就整组拒绝", () => {
  assert.deepEqual(resolveDependencyRefs(["#3", "12", "two/beta#7", "two/beta#7"], scope), {
    ok: true,
    local: [3, 12],
    cross: ["two/beta#7"],
  });
  const bad = resolveDependencyRefs(["#3", "nope/repo#1"], scope);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /nope\/repo/);
});

/* ---------------------------------------------------------------- 本地写入 */

test(
  "本地 .deck：跨仓库引用写进正文隐藏区段，重复 patch 只有一行，读不到时标引用失效",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = sandbox("deck-cross-local-");
    assert.equal(spawnSync("git", ["init", "-q", ws]).status, 0);
    mkdirSync(path.join(ws, "alpha"));
    writeFileSync(
      path.join(ws, ".paseo-deck.json"),
      `${JSON.stringify({ version: 2, projects: [{ key: "backend", dir: "alpha", repo: "one/alpha" }] }, null, 2)}\n`,
    );
    setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "local" });
    try {
      // 项目键是简写：正文里落的是解析出来的 owner/repo#n。
      const created = json(
        await run("deck_issue_create", { title: "跨仓库依赖", kind: "issue", blockedBy: ["backend#3"] }, ws),
      );
      assert.equal(created.number, 1);
      assert.deepEqual(created.blockedBy.requested, ["one/alpha#3"]);
      assert.deepEqual(created.blockedBy.crossRepo, ["one/alpha#3"]);

      const file = path.join(ws, ".deck", "issues", "1.md");
      const stored = readFileSync(file, "utf8");
      assert.match(stored, /Blocked by: one\/alpha#3/);
      assert.equal((stored.match(/DSH-CROSS-REPO-BLOCKED-BY/g) ?? []).length, 1);

      // 同一个引用再写两次：正文里仍然只有一行。
      await run("deck_issue_patch", { key: "1", blockedBy: ["backend#3"] }, ws);
      const patched = json(await run("deck_issue_patch", { key: "1", blockedBy: ["one/alpha#3"] }, ws));
      assert.equal(patched.blockedByFailed, false);
      const repeated = readFileSync(file, "utf8");
      assert.equal((repeated.match(/DSH-CROSS-REPO-BLOCKED-BY/g) ?? []).length, 1);
      assert.equal((repeated.match(/^Blocked by:/gm) ?? []).length, 1);

      // 写错一项：整组拒绝，票面一个字节都不改。
      const refused = failure(await run("deck_issue_patch", { key: "1", blockedBy: ["nope/repo#9"] }, ws));
      assert.equal(refused.reason, "invalid");
      assert.match(refused.detail, /nope\/repo/);
      assert.equal(readFileSync(file, "utf8"), repeated);

      // 本地后端连不上远端：这张票读不到，只能标「引用失效」，仍然算阻塞。
      resetDependencyCacheForTest();
      const board = await readBoard(ws, { view: "all", includeClosed: true });
      assert.equal(board.ok, true, JSON.stringify(board));
      const ticket = board.issues.find((issue) => issue.number === 1);
      assert.equal(ticket.readiness, "blocked");
      const stale = ticket.blockedBy.find((blocker) => blocker.repo === "one/alpha");
      assert.equal(stale.state, "UNKNOWN");
      assert.equal(stale.stale, true);
      assert.equal(stale.source, "body");

      // 清空整组：隐藏区段整段删掉，票变成可接。
      json(await run("deck_issue_patch", { key: "1", blockedBy: [] }, ws));
      const cleared = readFileSync(file, "utf8");
      assert.doesNotMatch(cleared, /DSH-CROSS-REPO-BLOCKED-BY/);
      resetDependencyCacheForTest();
      const after = await readBoard(ws, { view: "all", includeClosed: true });
      assert.equal(after.issues.find((issue) => issue.number === 1).readiness, "ready");
    } finally {
      setSettingsForTest(DEFAULT_SETTINGS);
    }
  },
);

test(
  "本地 .deck：跨仓库引用写错时整张票不建，也不留半截正文",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = sandbox("deck-cross-refuse-");
    assert.equal(spawnSync("git", ["init", "-q", ws]).status, 0);
    mkdirSync(path.join(ws, "alpha"));
    writeFileSync(
      path.join(ws, ".paseo-deck.json"),
      `${JSON.stringify({ version: 2, projects: [{ key: "backend", dir: "alpha", repo: "one/alpha" }] }, null, 2)}\n`,
    );
    setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "local" });
    try {
      const refused = failure(
        await run("deck_issue_create", { title: "不该建出来", kind: "issue", blockedBy: ["backend#3", "nope/repo#1"] }, ws),
      );
      assert.equal(refused.reason, "invalid");
      assert.match(refused.detail, /nope\/repo/);
      // 校验发生在写之前：目录里不该多出一张票。
      assert.throws(() => readdirSync(path.join(ws, ".deck", "issues")), /ENOENT/);
    } finally {
      setSettingsForTest(DEFAULT_SETTINGS);
    }
  },
);

/* ---------------------------------------------------------------- 合板读取 */

const MERGE_HANDLER = `
const args = process.argv.slice(2);
const all = args.join(" ");
const get = (key) => {
  const hit = args.find((arg) => arg.startsWith(key + "="));
  return hit ? hit.slice(key.length + 1) : "";
};
const key = get("owner") + "/" + get("name");
const betaState = process.env.FAKE_BETA_STATE === "closed" ? "CLOSED" : "OPEN";
const bodyOfAlpha = "alpha one\\n\\n<!-- DSH-CROSS-REPO-BLOCKED-BY\\nBlocked by: two/beta#7\\n-->\\n";
const bodyOfThird = "alpha three\\n\\n<!-- DSH-CROSS-REPO-BLOCKED-BY\\nBlocked by: two/beta#99\\n-->\\n";
const node = (number, title, state, body, nativeBlockers) => ({
  number, title, state, body: body || "",
  url: "https://github.com/" + key + "/issues/" + number,
  updatedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-09-01T00:00:00Z",
  labels: { totalCount: 0, nodes: [] },
  assignees: { nodes: [] },
  blockedBy: { pageInfo: { hasNextPage: false }, nodes: nativeBlockers || [] },
});
const rows = {
  "one/alpha": [
    node(1, "alpha one", "OPEN", bodyOfAlpha, [{ number: 2, title: "alpha two", state: "CLOSED" }]),
    node(3, "alpha three", "OPEN", bodyOfThird, []),
  ],
  "two/beta": [node(7, "beta seven", betaState, "beta body", [])],
};
const list = rows[key];
if (!list) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (all.includes("$number:Int!")) {
  const number = Number(get("number"));
  if (key === "two/beta" && number === 99) {
    console.error("gh: Not Found (HTTP 404)");
    process.exit(1);
  }
  const row = list.find((item) => item.number === number);
  if (!row) {
    console.error("gh: Not Found (HTTP 404)");
    process.exit(1);
  }
  console.log(JSON.stringify({ data: { repository: { issue: { ...row, comments: { totalCount: 0, nodes: [] } } } } }));
  process.exit(0);
}
const wantsIssues = all.includes("issues(first:");
const wantsPulls = all.includes("pullRequests(first:");
if (wantsIssues || wantsPulls) {
  const connection = (count, nodes) => ({ totalCount: count, pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  console.log(JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4999, resetAt: "2026-10-01T00:00:00Z" }, repository: {
    issues: wantsIssues ? connection(list.length, list) : undefined,
    pullRequests: wantsPulls ? connection(0, []) : undefined,
  } } }));
  process.exit(0);
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

test(
  "合板读取：原生边与正文行合并，对方关票后从阻塞变可接，读不到标引用失效",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      beta: "https://github.com/two/beta.git",
    });
    setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "auto" });
    const gh = toolGh(MERGE_HANDLER);
    try {
      process.env.FAKE_BETA_STATE = "open";
      resetDependencyCacheForTest();
      const board = await readBoard(ws, { view: "all", includeClosed: true });
      assert.equal(board.ok, true, JSON.stringify(board));
      const alpha = board.issues.find((issue) => issue.repoKey === "one/alpha" && issue.number === 1);
      const third = board.issues.find((issue) => issue.repoKey === "one/alpha" && issue.number === 3);

      // 原生边保留，并标明来源；正文行带 repo 与来源。
      const native = alpha.blockedBy.find((blocker) => blocker.number === 2);
      assert.equal(native.source, "native");
      assert.equal(native.repo, undefined);
      const crossRepo = alpha.blockedBy.find((blocker) => blocker.repo === "two/beta" && blocker.number === 7);
      assert.equal(crossRepo.source, "body");
      assert.equal(crossRepo.state, "OPEN");
      assert.equal(crossRepo.title, "beta seven");
      assert.equal(alpha.readiness, "blocked");

      // 引用不存在：读不到就是引用失效，仍然算阻塞，不能当成已解除。
      const stale = third.blockedBy.find((blocker) => blocker.repo === "two/beta");
      assert.equal(stale.state, "UNKNOWN");
      assert.equal(stale.stale, true);
      assert.equal(third.readiness, "blocked");

      const counts = countBoard(board.issues);
      assert.equal(counts.blocked, 2);

      // 对方把票关掉：同一块板子上这张票就变成可接。
      process.env.FAKE_BETA_STATE = "closed";
      resetDependencyCacheForTest();
      const after = await readBoard(ws, { view: "all", includeClosed: true });
      const alphaAfter = after.issues.find((issue) => issue.repoKey === "one/alpha" && issue.number === 1);
      const thirdAfter = after.issues.find((issue) => issue.repoKey === "one/alpha" && issue.number === 3);
      assert.equal(alphaAfter.blockedBy.find((blocker) => blocker.repo === "two/beta").state, "CLOSED");
      assert.equal(alphaAfter.readiness, "ready");
      // 引用失效的那张仍然堵着：对方没关票，只是我们读不到。
      assert.equal(thirdAfter.readiness, "blocked");
      assert.equal(countBoard(after.issues).blocked, 1);

      // 详情页走同一份合并口径。
      const detail = await readIssue(ws, 1, { repoKey: "one/alpha" });
      assert.equal(detail.ok, true, JSON.stringify(detail));
      assert.equal(detail.result.ok, true);
      assert.equal(detail.result.issue.readiness, "ready");
      assert.equal(
        detail.result.issue.blockedBy.find((blocker) => blocker.repo === "two/beta").source,
        "body",
      );
    } finally {
      delete process.env.FAKE_BETA_STATE;
      gh.restore();
      setSettingsForTest(DEFAULT_SETTINGS);
    }
  },
);
