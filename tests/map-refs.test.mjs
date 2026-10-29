import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { mapHandler } from "../server/rpc/map.ts";
import { resetDependencyCacheForTest } from "../server/tracker/read.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";

/**
 * 地图页的跨项目引用（issue #9）。
 *
 * 三件事要同时成立：
 *  1. 地图的数据源只在本仓库——另一个项目的票不能混进路线；
 *  2. 正文里写的 `key#n` / `owner/repo#n` 要能读回对方那张票的状态；
 *  3. 读不到或写错的引用要如实说清楚，不能静默吞掉。
 */

const sandboxes = [];
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  setSettingsForTest(DEFAULT_SETTINGS);
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

/**
 * 假 gh 返回的固定数据。
 *
 * one/alpha 是「本仓库」：一张地图 + 一张路线票；two/beta 是另一个项目，它的 #3 也带
 * `wayfinder:task` —— 如果地图页真的跨仓库聚合了，它会出现在路线上，测试就该红。
 * 路线票正文里同时写了三条引用：能读到的、读不到的、写错项目键的。
 */
const MAP_HANDLER = String.raw`
const args = process.argv.slice(2);
const all = args.join(" ");
const get = (key) => {
  const hit = args.find((arg) => arg.startsWith(key + "="));
  return hit ? hit.slice(key.length + 1) : "";
};
const key = get("owner") + "/" + get("name");
const block = (refs) => "\n\n<!-- DSH-CROSS-REPO-BLOCKED-BY\nBlocked by: " + refs + "\n-->\n";
const node = (number, title, state, body, labels, nativeBlockers) => ({
  number,
  title,
  state,
  body,
  url: "https://github.com/" + key + "/issues/" + number,
  updatedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-09-01T00:00:00Z",
  labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name, color: "ededed" })) },
  assignees: { nodes: [] },
  blockedBy: { pageInfo: { hasNextPage: false }, nodes: nativeBlockers || [] },
});
const rows = {
  "one/alpha": [
    node(1, "Map alpha", "OPEN", "## Destination\n把两边的票接起来" + block("api#3"), ["wayfinder:map"], []),
    node(2, "alpha two", "OPEN", "alpha two body" + block("api#3, two/beta#99, nope#5"), ["wayfinder:task"], []),
  ],
  "two/beta": [node(3, "beta three", "OPEN", "beta body", ["wayfinder:task"], [])],
};
const list = rows[key];
if (!list) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (all.includes("$number:Int!")) {
  const number = Number(get("number"));
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

function toolGh(source) {
  const dir = sandbox("deck-maprefs-bin-");
  const script = path.join(dir, "handler.mjs");
  writeFileSync(script, source, "utf8");
  return fakeGh(`exec "${process.execPath}" "${script}" "$@"`);
}

/** 容器工作区：alpha（本仓库） + beta（另一个项目，项目键 api）。 */
function container() {
  const dir = sandbox("deck-maprefs-ws-");
  repoAt(dir, "alpha", "https://github.com/one/alpha.git");
  repoAt(dir, "beta", "https://github.com/two/beta.git");
  writeFileSync(
    path.join(dir, ".paseo-deck.json"),
    `${JSON.stringify(
      {
        version: 2,
        projects: [
          { key: "alpha", dir: "alpha", repo: "one/alpha" },
          { key: "api", dir: "beta", repo: "two/beta" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

/** 每个用例重搭一次假 gh：读路径有 2 秒短缓存，用例之间必须清掉。 */
async function withWorkspace(run) {
  const ws = container();
  setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "auto" });
  const gh = toolGh(MAP_HANDLER);
  try {
    resetDependencyCacheForTest();
    return await run(ws);
  } finally {
    gh.restore();
    setSettingsForTest(DEFAULT_SETTINGS);
  }
}

const readMap = (ws) => mapHandler({ workspaceDir: ws, repoKey: "one/alpha", number: 1 });

test(
  "数据源只在本仓库：另一个项目的同号票不混进路线、分组与层级",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    await withWorkspace(async (ws) => {
      const result = await readMap(ws);
      assert.equal(result.ok, true, JSON.stringify(result));

      // 本仓库只有 #2 是路线票（#1 是地图票本身）；beta 的 #3 也带 wayfinder:task 标签，
      // 但它属于另一个仓库，不该出现在这一页。
      assert.equal(result.issue.number, 1);
      assert.equal(result.repoKey, "one/alpha");
      assert.deepEqual(result.route.map((item) => item.number), [2]);
      const allNumbers = [
        ...result.route.map((item) => item.number),
        ...result.groups.flatMap((group) => group.numbers),
        ...result.levels.flatMap((level) => level.numbers),
      ];
      assert.equal(allNumbers.includes(3), false, "另一个项目的票号不该出现在地图里");
    });
  },
);

test(
  "正文里的 key#n 引用：读回对方仓库与对方状态，跨仓库的给外链地址",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    await withWorkspace(async (ws) => {
      const result = await readMap(ws);
      assert.equal(result.ok, true, JSON.stringify(result));

      // 地图票正文与路线票正文都写了 api#3（= two/beta#3）：去重后只剩一条。
      const beta = result.references.filter((item) => item.repo === "two/beta" && item.number === 3);
      assert.equal(beta.length, 1, JSON.stringify(result.references));
      assert.deepEqual(beta[0], {
        repo: "two/beta",
        number: 3,
        title: "beta three",
        state: "OPEN",
        stale: false,
        url: "https://github.com/two/beta/issues/3",
      });
      // 按票号排序：3 在 99 前面。
      assert.deepEqual(
        result.references.map((item) => `${item.repo}#${item.number}`),
        ["two/beta#3", "two/beta#99"],
      );
      assert.deepEqual(result.invalidRefs.map((item) => item.text), ["nope#5"]);
    });
  },
);

test(
  "对方票读不到：state 是 UNKNOWN、stale 为 true，并有明确的「引用失效」文案",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    await withWorkspace(async (ws) => {
      const result = await readMap(ws);
      assert.equal(result.ok, true, JSON.stringify(result));

      const missing = result.references.find((item) => item.repo === "two/beta" && item.number === 99);
      assert.ok(missing, JSON.stringify(result.references));
      assert.equal(missing.state, "UNKNOWN");
      assert.equal(missing.stale, true);
      // 地址仍然拼得出来：人点过去能看到 404，比只给一个编号强。
      assert.equal(missing.url, "https://github.com/two/beta/issues/99");

      // 界面文案是静态资源；这里直接钉住中文那一行，免得「引用失效」被悄悄改成一句含糊的话。
      const panel = readFileSync(new URL("../client/deck/panel/panelText.tsx", import.meta.url), "utf8");
      assert.match(panel, /"mapRef\.stale": "引用失效：\{ref\}"/);
      assert.match(panel, /"mapRef\.invalid": "引用失效：\{ref\} — \{detail\}"/);
    });
  },
);

test(
  "项目键写错：不当成阻塞项，但要原样列出并说明哪里写错了、能怎么写",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    await withWorkspace(async (ws) => {
      const result = await readMap(ws);
      assert.equal(result.ok, true, JSON.stringify(result));

      const invalid = result.invalidRefs.find((item) => item.text === "nope#5");
      assert.ok(invalid, JSON.stringify(result.invalidRefs));
      assert.match(invalid.detail, /项目键「nope」不在 \.paseo-deck\.json 里/);
      assert.match(invalid.detail, /能用的键/);
      // 认不出来的引用不该混进可点列表（没有可点的目标）。
      assert.equal(result.references.some((item) => item.number === 5), false);
      // 也不该被当成阻塞边：路线票照常只有那两条真正的引用。
      assert.equal(result.references.length, 2);
    });
  },
);
