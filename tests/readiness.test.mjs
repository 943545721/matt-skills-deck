import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { listIssues, mapIssueNodes, mapRestIssues } from "../server/tracker/github.ts";
import { countBoard, filterBoard, readinessOf, sortBoard } from "../server/tracker/readiness.ts";

/**
 * 可接 / 阻塞 / 认领的口径必须与 DSH 一致：
 * 只有**仍打开**的阻塞者才算阻塞，认领单独成立，关闭与合并都算收尾。
 * 这几条一旦漂移，面板、地图与 Agent 工具会给出互相矛盾的结论。
 */

const blocker = (state, number = 1) => ({ number, title: `#${number}`, state, kind: "issue" });

test("可接：未关闭 + 无认领 + 没有仍打开的阻塞者", () => {
  assert.equal(readinessOf({ state: "OPEN", assignees: [], blockedBy: [] }), "ready");
  // 关掉的阻塞者不再挡路：它已经做完了。
  assert.equal(readinessOf({ state: "OPEN", assignees: [], blockedBy: [blocker("CLOSED")] }), "ready");
});

test("阻塞：任意一个阻塞者仍打开就不可接，优先于认领", () => {
  assert.equal(readinessOf({ state: "OPEN", assignees: [], blockedBy: [blocker("OPEN")] }), "blocked");
  assert.equal(
    readinessOf({ state: "OPEN", assignees: ["octocat"], blockedBy: [blocker("CLOSED"), blocker("OPEN", 2)] }),
    "blocked",
  );
  assert.equal(readinessOf({ state: "CLOSED", assignees: [], blockedBy: [blocker("OPEN")] }), "closed");
});

test("认领：有人接手但没被阻塞时是 claimed，不是 ready", () => {
  assert.equal(readinessOf({ state: "OPEN", assignees: ["octocat"], blockedBy: [] }), "claimed");
  assert.equal(readinessOf({ state: "OPEN", merged: true, assignees: [], blockedBy: [] }), "closed");
});

const item = (overrides) => ({
  number: 1,
  title: "t",
  state: "OPEN",
  updatedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-10-01T00:00:00Z",
  labels: [],
  assignees: [],
  isMap: false,
  kind: "issue",
  merged: false,
  blockedBy: [],
  readiness: "ready",
  ...overrides,
});

test("计数：打开票的三个桶互斥，合并 PR 计入关闭与合并", () => {
  const counts = countBoard([
    item({ number: 1 }),
    item({ number: 2, assignees: ["a"], readiness: "claimed" }),
    item({ number: 3, blockedBy: [blocker("OPEN")], readiness: "blocked" }),
    item({ number: 4, state: "CLOSED", readiness: "closed" }),
    item({ number: 5, kind: "pull-request", state: "CLOSED", merged: true, readiness: "closed" }),
  ]);
  assert.deepEqual(counts, {
    total: 5,
    open: 3,
    closed: 2,
    ready: 1,
    claimed: 1,
    blocked: 1,
    merged: 1,
    issues: 4,
    pullRequests: 1,
  });
  assert.equal(counts.ready + counts.claimed + counts.blocked, counts.open);
});

test("筛选：视图、页签、标签三者叠加，且不改入参", () => {
  const list = [
    item({ number: 1, labels: [{ name: "bug" }] }),
    item({ number: 2, readiness: "blocked", blockedBy: [blocker("OPEN")] }),
    item({ number: 3, state: "CLOSED", readiness: "closed" }),
    item({ number: 4, kind: "pull-request", state: "CLOSED", merged: true, readiness: "closed" }),
  ];
  const snapshot = list.map((entry) => entry.number);
  assert.deepEqual(filterBoard(list, { view: "ready" }).map((entry) => entry.number), [1]);
  assert.deepEqual(filterBoard(list, { view: "blocked" }).map((entry) => entry.number), [2]);
  assert.deepEqual(filterBoard(list, { view: "closed" }).map((entry) => entry.number), [3, 4]);
  assert.deepEqual(filterBoard(list, { view: "merged" }).map((entry) => entry.number), [4]);
  assert.deepEqual(filterBoard(list, { kind: "pull-request" }).map((entry) => entry.number), [4]);
  assert.deepEqual(filterBoard(list, { label: "bug" }).map((entry) => entry.number), [1]);
  assert.deepEqual(list.map((entry) => entry.number), snapshot);
});

test("排序：地图优先 → 未关闭优先，再按所选次级键", () => {
  const list = [
    item({ number: 1, state: "CLOSED", readiness: "closed", updatedAt: "2026-10-03T00:00:00Z" }),
    item({ number: 2, isMap: true, updatedAt: "2026-10-01T00:00:00Z" }),
    item({ number: 3, updatedAt: "2026-10-02T00:00:00Z" }),
  ];
  assert.deepEqual(sortBoard(list).map((entry) => entry.number), [2, 3, 1]);
  assert.deepEqual(sortBoard(list, "number").map((entry) => entry.number), [2, 3, 1]);
  assert.deepEqual(sortBoard(list, "title").map((entry) => entry.number), [2, 3, 1]);
  // 显式排序不动前两层：编号更小的关闭票仍然排在未关闭票之后。
  assert.deepEqual(
    sortBoard([...list, item({ number: 0, state: "CLOSED", readiness: "closed" })], "number").map((entry) => entry.number),
    [2, 3, 0, 1],
  );
});

test("映射：阻塞边只认打开的才算阻塞；PR 用 mergedAt 区分关闭与合并", () => {
  const issues = mapIssueNodes([
    {
      number: 7,
      state: "OPEN",
      labels: { nodes: [] },
      assignees: { nodes: [] },
      blockedBy: { nodes: [{ number: 3, title: "前置", state: "OPEN" }, { number: 4, state: "CLOSED" }] },
    },
  ]);
  assert.equal(issues[0].readiness, "blocked");
  assert.deepEqual(issues[0].blockedBy.map((entry) => entry.number), [3, 4]);
  assert.equal(issues[0].blockedBy[1].title, "#4");

  const prs = mapIssueNodes(
    [
      { number: 9, state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", labels: { nodes: [] }, assignees: { nodes: [] } },
      { number: 10, state: "CLOSED", mergedAt: null, labels: { nodes: [] }, assignees: { nodes: [] } },
    ],
    "pull-request",
  );
  assert.equal(prs[0].merged, true);
  assert.equal(prs[0].readiness, "closed");
  assert.equal(prs[0].kind, "pull-request");
  assert.equal(prs[1].merged, false);
});

test("REST 回退映射：pull_request 字段决定这是 PR，merged_at 决定是否已合并", () => {
  const mapped = mapRestIssues([
    {
      number: 1,
      title: "票",
      state: "open",
      html_url: "https://github.com/acme/deck/issues/1",
      updated_at: "2026-10-01T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
      labels: [{ name: "bug", color: "ff0000" }],
      assignees: [{ login: "a" }],
    },
    {
      number: 2,
      title: "PR",
      state: "closed",
      pull_request: { merged_at: "2026-10-02T00:00:00Z" },
      labels: [],
      assignees: [],
    },
  ]);
  assert.equal(mapped[0].kind, "issue");
  assert.equal(mapped[0].readiness, "claimed");
  assert.equal(mapped[1].kind, "pull-request");
  assert.equal(mapped[1].merged, true);
  assert.equal(mapped[1].readiness, "closed");
});

test("列表：一次 GraphQL 同时取 issue 与 PR，并带回额度", async () => {
  const gh = fakeGh(`cat <<'JSON'
{"data":{"repository":{
  "issues":{"totalCount":2,"pageInfo":{"hasNextPage":false},"nodes":[
    {"number":1,"title":"票","state":"OPEN","url":"u1","updatedAt":"2026-10-01T00:00:00Z","createdAt":"2026-09-01T00:00:00Z","labels":{"nodes":[]},"assignees":{"nodes":[]},"blockedBy":{"nodes":[]}}
  ]},
  "pullRequests":{"totalCount":1,"pageInfo":{"hasNextPage":true},"nodes":[
    {"number":2,"title":"PR","state":"OPEN","url":"u2","updatedAt":"2026-10-02T00:00:00Z","createdAt":"2026-09-02T00:00:00Z","mergedAt":null,"labels":{"nodes":[]},"assignees":{"nodes":[]}}
  ]},
  "rateLimit":{"limit":5000,"remaining":4999,"resetAt":"2026-10-01T01:00:00Z"}
}}}
JSON`);
  try {
    const result = await listIssues("acme", "deck");
    assert.equal(result.ok, true);
    assert.equal(result.issues.length, 2);
    assert.deepEqual(result.issues.map((entry) => entry.kind), ["issue", "pull-request"]);
    assert.equal(result.totalCount, 3);
    assert.equal(result.hasMore, true);
    assert.equal(result.source, "graphql");
    assert.equal(result.rateLimit.remaining, 4999);
  } finally {
    gh.restore();
  }
});

test("列表：GraphQL 报限流时换 REST，并如实标记 source=rest", async () => {
  const gh = fakeGh(`case "$2" in
  graphql) echo '{"errors":[{"message":"API rate limit exceeded for user"}]}' ; exit 0 ;;
  *) cat <<'JSON'
[{"number":5,"title":"来自 REST","state":"open","html_url":"u5","updated_at":"2026-10-03T00:00:00Z","created_at":"2026-09-03T00:00:00Z","labels":[],"assignees":[],"pull_request":null}]
JSON
  ;;
esac`);
  try {
    const result = await listIssues("acme", "deck");
    assert.equal(result.ok, true);
    assert.equal(result.source, "rest");
    assert.deepEqual(gh.calls(), ["api", "api"]);
    assert.equal(result.issues[0].number, 5);
    // REST 拿不到阻塞边，计数不能假装完整——source 就是给界面的警告。
    assert.deepEqual(result.issues[0].blockedBy, []);
  } finally {
    gh.restore();
  }
});
