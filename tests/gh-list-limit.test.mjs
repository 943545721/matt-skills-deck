import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { listIssues } from "../server/tracker/github.ts";

/**
 * 列表请求的 `first` 上限。
 *
 * GitHub 对 connections 的 `first` 硬上限是 100，超了不是截断，是整条查询被拒：
 * `Requesting 200 records on the issues connection exceeds the first limit of 100 records.`
 * 插件里 `deck_issue_list` / 地图快照都要 200 条，于是整块板子读不出来。
 * 这条用例把「要 200 就翻两页」钉住：假 gh 一旦收到 first>100 就照着 GitHub 的说法报错。
 */

const dir = mkdtempSync(path.join(tmpdir(), "deck-list-limit-"));
const log = path.join(dir, "calls.log");

const handler = path.join(dir, "handler.mjs");
writeFileSync(
  handler,
  `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const get = (key) => {
  const hit = args.find((arg) => arg.startsWith(key + "="));
  return hit ? hit.slice(key.length + 1) : "";
};
const query = args.find((arg) => arg.startsWith("query=")) ?? "";
const first = Number(get("first"));
const after = get("after");
const isIssue = query.includes("issues(first:");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ first, after, isIssue }) + "\\n");

if (first > 100) {
  console.log(JSON.stringify({ errors: [{ message: "Requesting " + first + " records on the \`issues\` connection exceeds the \`first\` limit of 100 records." }] }));
  process.exit(0);
}

const nodes = (start, count) =>
  Array.from({ length: count }, (_, index) => ({
    number: start + index,
    title: "ticket " + (start + index),
    state: "OPEN",
    url: "https://github.com/acme/deck/issues/" + (start + index),
    updatedAt: "2026-10-01T00:00:00Z",
    createdAt: "2026-09-01T00:00:00Z",
    labels: { totalCount: 0, nodes: [] },
    assignees: { nodes: [] },
    blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
  }));

const page = (items, hasNext, cursor) => ({
  totalCount: 150,
  pageInfo: { hasNextPage: hasNext, endCursor: cursor },
  nodes: items,
});

const issues = after ? page(nodes(101, 50), false, null) : page(nodes(1, 100), true, "cursor-1");
const pullRequests = page([], false, null);
console.log(
  JSON.stringify({
    data: {
      rateLimit: { limit: 5000, remaining: 4999, resetAt: "2026-10-01T00:00:00Z" },
      repository: isIssue ? { issues } : { pullRequests },
    },
  }),
);
`,
  "utf8",
);

const gh = fakeGh(`exec "${process.execPath}" "${handler}" "$@"`);

test.after(() => {
  gh.restore();
  rmSync(dir, { recursive: true, force: true });
});

test("列表要 200 条：拆成两页各 ≤100，而不是把 200 塞进 first", async () => {
  writeFileSync(log, "");

  const result = await listIssues("acme", "deck", { limit: 200, includeClosed: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.issues.length, 150, "两页拼起来应该是 150 条");
  assert.equal(result.hasMore, false);

  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  // 请求次数：issues 两页 + pullRequests 一页；每次都 ≤100。
  assert.equal(calls.length, 3, JSON.stringify(calls));
  for (const call of calls) {
    assert.ok(call.first <= 100, `first=${call.first} 超过 GitHub 上限`);
  }
  const issueCalls = calls.filter((call) => call.isIssue);
  // 第二页按「还差多少」要，但一页仍不超过 100；游标从第一页的 endCursor 接上。
  assert.deepEqual(
    issueCalls.map((call) => [call.first, call.after]),
    [
      [100, ""],
      [100, "cursor-1"],
    ],
  );
});

test("列表默认 100 条只发一次请求，不白翻页", async () => {
  writeFileSync(log, "");
  const result = await listIssues("acme", "deck", {});
  assert.equal(result.ok, true, JSON.stringify(result));
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  // pullRequests 那页是空的，hasNextPage=false，不该再翻；issues 满 100 条但已到 limit。
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.deepEqual(
    calls.map((call) => call.first),
    [100, 100],
  );
});
