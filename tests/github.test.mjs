import test from "node:test";
import assert from "node:assert/strict";
import * as gh from "../server/tracker/github.ts";
import * as core from "../server/tracker/github/index.ts";

/**
 * GitHub 后端全量移植的 fixture 测试。
 *
 * 不跑真实 gh：所有命令都被注入的执行器接住；断言的是「我们发了什么参数、怎么判回包」。
 * 每个 fixture 只回答被问到的命令，未覆盖的命令会明确失败，避免测试静默放过。
 */

const ok = (stdout = "") => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const bad = (kind, raw = kind, exitCode = 1) => ({
  ok: false,
  error: { kind, message: raw, raw, stderr: raw, exitCode },
  stdout: "",
  stderr: raw,
  exitCode,
});

function fixture(handler) {
  const calls = [];
  const exec = async (args, options = {}) => {
    calls.push({ args: [...args], options: { ...options } });
    return handler(args, options, calls);
  };
  return { client: gh.createGhClient(exec), calls };
}

const queryOf = (args) => {
  const entry = args.find((arg) => arg.startsWith("query="));
  return entry ? entry.slice("query=".length) : "";
};
const argAfter = (args, flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const json = (value) => ok(JSON.stringify(value));
const repo = { owner: "acme", name: "deck" };
const SLUG = "acme/deck";

function node(number, extra = {}) {
  return {
    number,
    title: `#${number}`,
    state: "OPEN",
    url: `https://github.com/${SLUG}/issues/${number}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    labels: { totalCount: 0, nodes: [] },
    assignees: { nodes: [] },
    blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...extra,
  };
}

function listReply(nodes, extra = {}) {
  return json({
    data: {
      rateLimit: { cost: extra.cost ?? 1, limit: 5000, remaining: 4999, resetAt: "2026-01-03T00:00:00Z" },
      repository: {
        issues: {
          totalCount: extra.total ?? nodes.length,
          pageInfo: { hasNextPage: extra.hasMore ?? false, endCursor: extra.cursor ?? null },
          nodes,
        },
      },
    },
  });
}

function restIssue(number, extra = {}) {
  return {
    number,
    title: `REST ${number}`,
    state: "open",
    html_url: `https://github.com/${SLUG}/issues/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    labels: [],
    assignees: [],
    ...extra,
  };
}

function detailReply(nodes, extra = {}) {
  return json({
    data: {
      rateLimit: { cost: 1 },
      repository: {
        issue: {
          ...node(extra.number ?? 5),
          body: "正文",
          comments: {
            totalCount: extra.commentTotal ?? nodes.length,
            pageInfo: { hasNextPage: extra.hasMore ?? false, endCursor: extra.cursor ?? null },
            nodes,
          },
        },
      },
    },
  });
}

const comment = (body) => ({ author: { login: "octo" }, createdAt: "2026-01-02T00:00:00Z", body });

test("判档表：错误只认 stderr/stdout，不看 argv", () => {
  assert.equal(core.classifyGhFailure({ exitCode: 4 }).kind, "auth");
  assert.equal(core.classifyGhFailure({ exitCode: -1 }).kind, "env");
  assert.equal(core.classifyGhFailure({ stderr: "AddLabelsToLabelable failed" }).kind, "auth");
  assert.equal(core.classifyGhFailure({ stderr: "Could not resolve to a Repository" }).kind, "notfound");
  assert.equal(core.classifyGhFailure({ stderr: "HTTP 422 Validation failed" }).kind, "parse");
  assert.equal(core.classifyGhFailure({ stderr: "excessive pagination" }).kind, "unsupported");
  assert.equal(core.classifyGhFailure({ stderr: "API rate limit exceeded" }).kind, "ratelimit");
  const unknown = core.classifyGhFailure({ stderr: "something odd" });
  assert.equal(unknown.kind, "network");
  assert.match(unknown.message, /未识别/);
  // 命令行里出现 gh auth login 不能把普通失败误判成未登录。
  const argvLike = core.classifyGhFailure({ exitCode: 1, stderr: "boom", message: "Command failed: gh issue comment 1 --body 'gh auth login'" });
  assert.equal(argvLike.kind, "network");
});

test("列表：GraphQL 查询形状、first 上限、since 增量、点数修正", async () => {
  const fx = fixture((args) => (args[0] === "api" && args[1] === "graphql" ? listReply([node(1)], { cost: 4 }) : bad("network", "unexpected")));
  const result = await gh.listIssuesPage(fx.client, {
    repo,
    kind: "issue",
    state: "all",
    limit: 500,
    since: "2026-01-01T00:00:00Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].number, 1);
  assert.equal(result.data.source, "graphql");
  const call = fx.calls[0];
  assert.deepEqual(call.args.slice(0, 2), ["api", "graphql"]);
  const query = queryOf(call.args);
  assert.ok(query.indexOf("rateLimit") < query.indexOf("repository("));
  assert.match(query, /\$since:DateTime!/);
  assert.match(query, /filterBy:\{since:\$since\}/);
  for (const expected of ["owner=acme", "name=deck", "first=100", "since=2026-01-01T00:00:00.000Z"]) {
    assert.ok(call.args.includes(expected), `缺少参数 ${expected}`);
  }
  assert.equal(fx.client.stats().graphqlPoints, 4);
  assert.equal(fx.client.stats().restRequests, 0);
  assert.equal(fx.client.rateSnapshot().graphql.remaining, 4999);
  assert.equal(gh.timeoutForGhArgs(["issue", "edit", "1"]), 30_000);
  assert.equal(gh.timeoutForGhArgs(["api", "graphql"]), 12_000);
  assert.equal(gh.timeoutForGhArgs(["auth", "status"]), 15_000);
});

test("列表：游标翻页；失效游标按 notfound 报", async () => {
  const fx = fixture((args) => {
    const query = queryOf(args);
    if (!query.includes("issues(first")) return bad("network", "unexpected");
    return args.includes("after=CUR")
      ? listReply([node(2)], { total: 2 })
      : listReply([node(1)], { total: 2, hasMore: true, cursor: "CUR" });
  });
  const first = await gh.listIssuesPage(fx.client, { repo, kind: "issue", limit: 2 });
  assert.equal(first.ok, true);
  assert.equal(first.data.nextCursor, "CUR");
  assert.equal(first.data.hasMore, true);
  const second = await gh.listIssuesPage(fx.client, { repo, kind: "issue", limit: 2, cursor: first.data.nextCursor });
  assert.equal(second.ok, true);
  assert.ok(fx.calls[1].args.includes("after=CUR"));

  const broken = fixture(() => json({ errors: [{ message: "invalid cursor" }], data: { repository: null } }));
  const failed = await gh.listIssuesPage(broken.client, { repo, kind: "issue", cursor: "gone" });
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, "notfound");
  assert.match(failed.message, /游标/);
});

test("列表：GraphQL 点数耗尽回落 REST，并标注来源", async () => {
  const fx = fixture((args) => {
    if (args[0] === "api" && args[1] === "graphql") {
      return json({ errors: [{ message: "API rate limit exceeded" }], data: { repository: null } });
    }
    if (args[0] === "api" && String(args[1]).startsWith(`repos/${SLUG}/issues?`)) {
      return json([restIssue(1), restIssue(2, { pull_request: { merged_at: null } })]);
    }
    if (args[0] === "api" && String(args[1]).startsWith(`repos/${SLUG}/pulls?`)) {
      return json([{ number: 2, merged_at: "2026-02-02T00:00:00Z" }]);
    }
    return bad("network", "unexpected");
  });
  const result = await gh.listIssuesPage(fx.client, { repo, kind: "all", limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.data.source, "rest");
  assert.equal(result.data.fallbackReason, "rate-limit");
  assert.equal(result.data.items.length, 2);
  assert.equal(result.data.items[1].merged, true);
  assert.match(String(fx.calls[1].args[1]), /per_page=100&page=1/);
  assert.equal(fx.client.stats().restRequests, 2);
});

test("详情：评论分页补到 wanted 条，并带 after 游标", async () => {
  const fx = fixture((args) => {
    const query = queryOf(args);
    if (!query.includes("comments(first")) return bad("network", "unexpected");
    if (args.includes("commentsAfter=C1")) {
      return detailReply([comment("第三条")], { number: 5, commentTotal: 3, cursor: null });
    }
    return detailReply([comment("第一条"), comment("第二条")], { number: 5, commentTotal: 3, hasMore: true, cursor: "C1" });
  });
  const result = await gh.getIssueDetail(fx.client, repo, 5, { comments: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.data.comments.length, 3);
  assert.equal(result.data.commentsTruncated, false);
  assert.match(queryOf(fx.calls[1].args), /after:\$commentsAfter/);
  assert.ok(fx.calls[1].args.includes("commentsAfter=C1"));
});

test("详情：issue 查不到时改查 PR，编号共用空间", async () => {
  const fx = fixture((args) => {
    const query = queryOf(args);
    if (query.includes("issue(number:$number)")) {
      return json({ data: { repository: { issue: null } } });
    }
    if (query.includes("pullRequest(number:$number)")) {
      return json({
        data: {
          rateLimit: { cost: 1 },
          repository: {
            pullRequest: {
              ...node(7, {
                mergedAt: "2026-02-01T00:00:00Z",
                state: "MERGED",
                reviews: { nodes: [{ state: "APPROVED", author: { login: "alice" }, submittedAt: "2026-02-02T00:00:00Z" }] },
              }),
              body: "PR 正文",
              comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
            },
          },
        },
      });
    }
    return bad("network", "unexpected");
  });
  const result = await gh.getIssueDetail(fx.client, repo, 7);
  assert.equal(result.ok, true);
  assert.equal(result.data.issue.kind, "pull-request");
  assert.equal(result.data.issue.merged, true);
  assert.equal(result.data.issue.state, "CLOSED");
  assert.equal(result.data.issue.mergedAt, "2026-02-01T00:00:00Z");
  assert.deepEqual(result.data.issue.reviews, [
    { state: "APPROVED", reviewer: { login: "alice" }, submittedAt: "2026-02-02T00:00:00Z" },
  ]);
});

test("PR 列表/详情：只查 pullRequests 连接，不混入 issue 查询", async () => {
  const fx = fixture((args) => {
    const query = queryOf(args);
    if (query.includes("pullRequest(number:$number)")) {
      return json({
        data: {
          rateLimit: { cost: 1 },
          repository: {
            pullRequest: {
              ...node(7, { mergedAt: "2026-02-01T00:00:00Z", state: "MERGED" }),
              body: "PR 正文",
              comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
            },
          },
        },
      });
    }
    if (query.includes("pullRequests(first")) {
      return json({
        data: {
          rateLimit: { cost: 1 },
          repository: {
            pullRequests: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [node(7, { mergedAt: "2026-02-01T00:00:00Z", state: "MERGED" })],
            },
          },
        },
      });
    }
    return bad("network", "unexpected");
  });
  const list = await gh.listIssuesPage(fx.client, { repo, kind: "pull-request", state: "all" });
  assert.equal(list.ok, true);
  assert.equal(list.data.items[0].kind, "pull-request");
  assert.equal(list.data.items[0].merged, true);
  assert.equal(queryOf(fx.calls[0].args).includes("issues(first"), false);
  const detail = await gh.getIssueDetail(fx.client, repo, 7, { kind: "pull-request" });
  assert.equal(detail.ok, true);
  assert.equal(detail.data.issue.kind, "pull-request");
  assert.equal(detail.data.issue.body, "PR 正文");
});

test("PR REST 详情：/pulls 补合并时间，/reviews 补评审；小写状态归一", async () => {
  const fx = fixture((args) => {
    if (args[0] === "api" && args[1] === "graphql") return bad("network", "unexpected EOF");
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/12`) {
      return json({
        ...restIssue(12, { state: "closed" }),
        title: "REST PR",
        body: "PR REST 正文",
        pull_request: { merged_at: "2026-03-01T00:00:00Z" },
      });
    }
    if (args[0] === "api" && args[1] === `repos/${SLUG}/pulls/12`) {
      return json({ number: 12, state: "closed", merged_at: "2026-03-01T00:00:00Z" });
    }
    if (args[0] === "api" && args[1] === `repos/${SLUG}/pulls/12/reviews?per_page=100`) {
      return json([{ state: "CHANGES_REQUESTED", user: { login: "bob" }, submitted_at: "2026-03-02T00:00:00Z" }]);
    }
    if (args[0] === "api" && String(args[1]).startsWith(`repos/${SLUG}/issues/12/comments?`)) return json([]);
    return bad("network", `unexpected ${String(args[1])}`);
  });
  const result = await gh.getIssueDetail(fx.client, repo, 12);
  assert.equal(result.ok, true);
  assert.equal(result.data.source, "rest");
  assert.equal(result.data.issue.kind, "pull-request");
  assert.equal(result.data.issue.state, "CLOSED");
  assert.equal(result.data.issue.merged, true);
  assert.equal(result.data.issue.mergedAt, "2026-03-01T00:00:00Z");
  assert.deepEqual(result.data.issue.reviews, [
    { state: "CHANGES_REQUESTED", reviewer: { login: "bob" }, submittedAt: "2026-03-02T00:00:00Z" },
  ]);
});

test("降级原因：超时 / 限流 / 企业版主机 / 查询失败四类", async () => {
  assert.equal(core.pickFallbackReason({ kind: "network", raw: "dial tcp: i/o timeout" }, { host: "github.com" }), "timeout");
  assert.equal(core.pickFallbackReason({ kind: "ratelimit", raw: "API rate limit exceeded" }, { host: "ghe.corp" }), "rate-limit");
  assert.equal(core.pickFallbackReason({ kind: "network", raw: "unexpected EOF" }, { host: "ghe.example.com" }), "ghe-host");
  assert.equal(core.pickFallbackReason({ kind: "network", raw: "unexpected EOF" }, { host: "github.com" }), "graphql-error");
  assert.equal(core.isGheHostName("api.github.com"), false);

  const fx = fixture((args) => {
    if (args[0] === "api" && args[1] === "graphql") return bad("network", "ETIMEDOUT");
    if (args[0] === "api" && String(args[1]).startsWith(`repos/${SLUG}/issues?`)) {
      return json([restIssue(1, { state: "closed" })]);
    }
    return bad("network", "unexpected");
  });
  const result = await gh.listIssuesPage(fx.client, { repo, kind: "issue" });
  assert.equal(result.ok, true);
  assert.equal(result.data.source, "rest");
  assert.equal(result.data.fallbackReason, "timeout");
  // REST 的 state 是小写 closed：归一后不能还显示成打开。
  assert.equal(result.data.items[0].state, "CLOSED");
});

test("子票：逐页读取，失败页重试一次", async () => {
  let attempts = 0;
  const fx = fixture((args) => {
    if (!queryOf(args).includes("subIssues(first")) return bad("network", "unexpected");
    const secondPage = args.includes("after=P2");
    if (!secondPage && attempts === 0) {
      attempts += 1;
      return bad("network", "temporary");
    }
    return secondPage
      ? json({ data: { repository: { issue: { subIssues: { totalCount: 3, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(3)] } } } } })
      : json({ data: { repository: { issue: { subIssues: { totalCount: 3, pageInfo: { hasNextPage: true, endCursor: "P2" }, nodes: [node(1), node(2)] } } } } });
  });
  const result = await gh.listSubIssues(fx.client, repo, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data.fetched, 3);
  assert.equal(result.data.total, 3);
  assert.equal(result.data.missing, 0);
  assert.equal(result.data.capped, false);
  assert.equal(fx.calls.length, 3);
});

test("计数：标签用数组变量，state 收窄另一格归零", async () => {
  const fx = fixture((args) => {
    if (!queryOf(args).includes("openIssues")) return bad("network", "unexpected");
    return json({ data: { repository: { openIssues: { totalCount: 5 }, closedIssues: { totalCount: 2 } } } });
  });
  const result = await gh.countIssues(fx.client, repo, { state: "open", labels: ["bug", "p1"] });
  assert.equal(result.ok, true);
  assert.equal(result.data.open, 5);
  assert.equal(result.data.closed, 0);
  assert.equal(result.data.total, 5);
  assert.ok(fx.calls[0].args.includes("labels[]=bug"));
  assert.ok(fx.calls[0].args.includes("labels[]=p1"));

  const malformed = fixture(() => json({ data: { repository: { openIssues: { totalCount: 1 } } } }));
  const failed = await gh.countIssues(malformed.client, repo);
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, "parse");
});

test("依赖边：原生两位读全；缺 blocking 时扫描并标注不完整", async () => {
  const native = fixture((args) =>
    queryOf(args).includes("blocking(first:50)")
      ? json({ data: { repository: { issue: { blockedBy: { pageInfo: { hasNextPage: false }, nodes: [node(1)] }, blocking: { pageInfo: { hasNextPage: false }, nodes: [node(3)] } } } } })
      : bad("network", "unexpected"),
  );
  const nativeResult = await gh.getDependencies(native.client, repo, 2);
  assert.equal(nativeResult.ok, true);
  assert.equal(nativeResult.data.blockingSource, "native");
  assert.equal(nativeResult.data.blockedBy[0].number, 1);
  assert.equal(nativeResult.data.blocking[0].number, 3);
  assert.equal(nativeResult.data.blockingComplete, true);

  const nativeRead = fixture(() => json([{ number: 10, title: "Blocker", state: "open" }]));
  const read = await gh.readBlockedBy(nativeRead.client, repo, 2);
  assert.equal(read.ok, true);
  assert.equal(read.data.nativeKnown, true);
  assert.equal(read.data.blockedBy[0].number, 10);

  const scan = fixture((args) => {
    const query = queryOf(args);
    if (query.includes("blocking(first:50)")) {
      return json({ data: { repository: { issue: { blockedBy: { pageInfo: { hasNextPage: false }, nodes: [node(1)] } } } } });
    }
    if (query.includes("comments(first")) {
      return detailReply([], { number: 2 });
    }
    if (query.includes("issues(first")) {
      return listReply([node(3, { blockedBy: { pageInfo: { hasNextPage: false }, nodes: [{ number: 2, state: "OPEN" }] } }), node(2)], { total: 3, hasMore: true, cursor: "N" });
    }
    return bad("network", "unexpected");
  });
  const scanned = await gh.getDependencies(scan.client, repo, 2);
  assert.equal(scanned.ok, true);
  assert.equal(scanned.data.blockingSource, "scan");
  assert.equal(scanned.data.blocking[0].number, 3);
  assert.equal(scanned.data.blockingComplete, false);
  assert.match(scanned.data.blockingNote, /扫描/);
});

test("额度：两套预算缺一即不可测；探测走 15s 档", async () => {
  const fx = fixture(() =>
    json({ resources: { core: { limit: 5000, remaining: 4000, reset: 1700000000 }, graphql: { limit: 5000, remaining: 1234, reset: 1700000000 } } }),
  );
  const budget = await gh.readGithubBudget(fx.client);
  assert.equal(budget.ok, true);
  assert.equal(budget.known, true);
  assert.equal(budget.buckets.rest.remaining, 4000);
  assert.equal(budget.buckets.graphql.remaining, 1234);
  assert.equal(fx.calls[0].options.timeoutMs, 15_000);

  const missing = fixture(() => json({ resources: { core: { limit: 5000, remaining: 1 } } }));
  const unavailable = await gh.readGithubBudget(missing.client);
  assert.equal(unavailable.known, false);
  assert.equal(unavailable.reason, "unavailable");

  const envFailure = fixture(() => bad("env", "gh not found"));
  const notMeasured = await gh.readGithubBudget(envFailure.client);
  assert.equal(notMeasured.known, false);
  assert.equal(notMeasured.reason, "not-measured");
});

test("权限：REST .permissions 为主，viewerPermission 作补充", async () => {
  const fx = fixture((args) =>
    queryOf(args).includes("viewerPermission")
      ? json({ data: { repository: { viewerPermission: "WRITE" } } })
      : json({ push: false, triage: true, admin: false, maintain: false }),
  );
  const cache = gh.createPermissionCache();
  const first = await gh.readRepoPermissions(fx.client, SLUG, cache);
  const second = await gh.readRepoPermissions(fx.client, SLUG, cache);
  assert.deepEqual(first, { push: false, triage: true, admin: false, maintain: false });
  assert.deepEqual(second, first);
  assert.equal(fx.calls.length, 1);
  assert.ok(fx.calls[0].args.includes(".permissions"));
  const viewer = await gh.readViewerPermission(fx.client, repo);
  assert.deepEqual(viewer, { permission: "WRITE", push: true, triage: false });

  const malformed = fixture(() => json({ push: true }));
  assert.equal(await gh.readRepoPermissions(malformed.client, SLUG), null);
});

test("preflight：auth status 失败时用 api user 复核放行", async () => {
  const fx = fixture((args) => {
    if (args[0] === "--version") return ok("gh version 2.0.0");
    if (args[0] === "auth" && args[1] === "status") return bad("auth", "not logged in", 4);
    if (args[0] === "api" && args[1] === "user") return ok("octocat\n");
    if (args[0] === "repo" && args[1] === "view") return ok(`${SLUG}\n`);
    if (args[0] === "api" && args[1] === `repos/${SLUG}`) return ok("{}");
    return bad("network", "unexpected");
  });
  const result = await gh.ghPreflight(fx.client, { cwd: "/tmp/work" });
  assert.equal(result.ok, true);
  assert.equal(result.data.repo, SLUG);
  assert.equal(result.data.account, "octocat");
  assert.equal(result.data.crosschecked, true);

  const missing = fixture((args) => (args[0] === "--version" ? bad("env", "not found") : bad("network", "unexpected")));
  const failed = await gh.ghPreflight(missing.client);
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, "env");
});

test("幂等锚点：正文首行；search 失败退 list；两条都失败不得报 not-found", async () => {
  const body = gh.withAnchor("原始正文", "k1");
  assert.equal(body, "<!-- DSH-IDEMPOTENCY-KEY: k1 -->\n原始正文");
  assert.equal(gh.idempotencyKeyOf(body), "k1");
  assert.equal(gh.idempotencyKeyOf(gh.withAnchor("x", " a/b:c ")), "a/b:c");
  assert.equal(gh.idempotencyKeyOf(`不是首行\n${body}`), null);

  const searchHit = fixture((args) =>
    args[0] === "search"
      ? json([{ number: 7, body, state: "OPEN", createdAt: "2026-01-01T00:00:00Z" }])
      : bad("network", "unexpected"),
  );
  const hit = await gh.lookupByAnchor(searchHit.client, repo, "k1");
  assert.equal(hit.ok, true);
  assert.equal(hit.hit, true);
  assert.equal(hit.via, "search");

  const closed = fixture(() => json([{ number: 7, body, state: "CLOSED", createdAt: "2026-01-01T00:00:00Z" }]));
  const closedHit = await gh.lookupByAnchor(closed.client, repo, "k1");
  assert.deepEqual(closedHit, { ok: true, hit: false });

  const listFallback = fixture((args) => {
    if (args[0] === "search") return bad("network", "search down");
    if (args[0] === "issue" && args[1] === "list") {
      return json([{ number: 8, body, state: "OPEN", createdAt: new Date().toISOString() }]);
    }
    return bad("network", "unexpected");
  });
  const viaList = await gh.lookupByAnchor(listFallback.client, repo, "k1");
  assert.equal(viaList.hit, true);
  assert.equal(viaList.via, "list");

  const down = fixture(() => bad("network", "down"));
  const unknown = await gh.lookupByAnchor(down.client, repo, "k1");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.kind, "network");
});

test("建票：锚点写进正文；幂等命中不重复 POST；失败可能已建", async () => {
  const created = {
    number: 42,
    title: "新票",
    state: "open",
    html_url: `https://github.com/${SLUG}/issues/42`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    labels: [],
    assignees: [],
  };
  const fx = fixture((args, options, calls) => {
    if (args[0] === "search") return json([]);
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues` && args.includes("POST")) return json(created);
    if (args[0] === "issue" && args[1] === "view") return json({ ...created, body: "正文" });
    return bad("network", "unexpected");
  });
  const result = await gh.createGithubIssue(fx.client, repo, { title: "新票", body: "正文", idempotencyKey: "k9" });
  assert.equal(result.ok, true);
  assert.equal(result.data.issue.number, 42);
  assert.equal(result.data.deduplicated, false);
  const post = fx.calls.find((call) => call.args[1] === `repos/${SLUG}/issues`);
  assert.ok(post.args.includes("body=<!-- DSH-IDEMPOTENCY-KEY: k9 -->\n正文"));

  const network = fixture((args) => (args[0] === "search" ? json([]) : bad("network", "connection reset")));
  const maybe = await gh.createGithubIssue(network.client, repo, { title: "新票", idempotencyKey: "k10" });
  assert.equal(maybe.ok, false);
  assert.equal(maybe.maybeCreated, true);

  const dup = fixture((args) => {
    if (args[0] === "search") return json([{ number: 42, body: gh.withAnchor("正文", "k11"), state: "OPEN", createdAt: "2026-01-01T00:00:00Z" }]);
    if (args[0] === "issue" && args[1] === "view") return json({ ...created, body: gh.withAnchor("正文", "k11") });
    return bad("network", "unexpected");
  });
  const duplicate = await gh.createGithubIssue(dup.client, repo, { title: "新票", idempotencyKey: "k11" });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.data.deduplicated, true);
  assert.equal(dup.calls.some((call) => call.args[1] === `repos/${SLUG}/issues`), false);

  const labelFailure = fixture((args) => {
    if (args[0] === "search") return json([]);
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues`) return json(created);
    if (args[0] === "issue" && args[1] === "view") return json({ ...created, body: "", labels: [] });
    if (args[0] === "issue" && args[1] === "edit") return ok();
    return bad("network", "unexpected");
  });
  const partial = await gh.createGithubIssue(labelFailure.client, repo, { title: "新票", labels: ["bug"], idempotencyKey: "k12" });
  assert.equal(partial.ok, true);
  assert.match(partial.data.labelError, /标签没挂上/);
});

test("建票：kind/type 边界；地图票自动挂 wayfinder:map", async () => {
  const created = {
    number: 9,
    title: "地图",
    state: "open",
    html_url: `https://github.com/${SLUG}/issues/9`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    labels: [],
    assignees: [],
  };
  const none = fixture(() => bad("network", "unexpected"));
  const pull = await gh.createGithubIssue(none.client, repo, { title: "PR", kind: "pull-request" });
  assert.equal(pull.ok, false);
  assert.equal(pull.kind, "unsupported");
  const unknownType = await gh.createGithubIssue(none.client, repo, { title: "x", type: "epic" });
  assert.equal(unknownType.ok, false);
  assert.equal(unknownType.kind, "invalid");
  assert.equal(none.calls.length, 0);

  let views = 0;
  const map = fixture((args) => {
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues`) return json(created);
    if (args[0] === "issue" && args[1] === "view") {
      views += 1;
      const labels = views === 1 ? [] : [{ name: "wayfinder:map", color: "cccccc" }];
      return json({ ...created, labels });
    }
    if (args[0] === "issue" && args[1] === "edit") return ok();
    return bad("network", "unexpected");
  });
  const result = await gh.createGithubIssue(map.client, repo, { title: "地图", type: "map" });
  assert.equal(result.ok, true);
  assert.equal(result.data.labelError, undefined);
  assert.deepEqual(result.data.issue.labels.map((label) => label.name), ["wayfinder:map"]);
  const edit = map.calls.find((call) => call.args[0] === "issue" && call.args[1] === "edit");
  assert.ok(edit.args.includes("wayfinder:map"));
});

test("报告：结构化正文（发生了什么/期望/复现步骤）走同一条建票路径", async () => {
  const created = {
    number: 44,
    title: "报告",
    state: "open",
    html_url: `https://github.com/${SLUG}/issues/44`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    labels: [],
    assignees: [],
  };
  const fx = fixture((args) => (args[0] === "api" && args[1] === `repos/${SLUG}/issues` ? json(created) : bad("network", "unexpected")));
  const result = await gh.reportGithubIssue(fx.client, repo, {
    title: "报告",
    whatHappened: "点保存没反应",
    expected: "应该保存",
    steps: ["打开面板", "点保存"],
  });
  assert.equal(result.ok, true);
  const body = fx.calls[0].args.find((arg) => arg.startsWith("body="));
  assert.match(body, /## 发生了什么/);
  assert.match(body, /## 期望/);
  assert.match(body, /## 复现步骤/);
  assert.match(body, /1\. 打开面板/);
});

test("改票：不支持字段一条命令都不发；写后严格读回", async () => {
  const noCalls = fixture(() => bad("network", "unexpected"));
  const unsupported = await gh.updateGithubIssue(noCalls.client, repo, "5", { milestone: "v1" });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.kind, "unsupported");
  const empty = await gh.updateGithubIssue(noCalls.client, repo, "5", {});
  assert.equal(empty.ok, false);
  assert.equal(empty.kind, "invalid");
  assert.equal(noCalls.calls.length, 0);

  const fx = fixture((args) => {
    if (args[0] === "issue" && args[1] === "edit") return ok();
    if (args[0] === "issue" && args[1] === "view") {
      return json({ number: 5, title: "新标题", body: "新正文", state: "open", url: "u", createdAt: "t1", updatedAt: "t2", labels: [], assignees: [] });
    }
    return bad("network", "unexpected");
  });
  const updated = await gh.updateGithubIssue(fx.client, repo, "5", { title: "新标题", body: "新正文" });
  assert.equal(updated.ok, true);
  assert.equal(updated.data.title, "新标题");
  assert.ok(fx.calls[0].args.includes("--title"));
  assert.ok(fx.calls[0].args.includes("新标题"));

  const mismatch = fixture((args) => {
    if (args[0] === "issue" && args[1] === "edit") return ok();
    if (args[0] === "issue" && args[1] === "view") {
      return json({ number: 5, title: "别的标题", body: "", state: "open", url: "u", createdAt: "t1", updatedAt: "t2", labels: [], assignees: [] });
    }
    return bad("network", "unexpected");
  });
  const diff = await gh.updateGithubIssue(mismatch.client, repo, "5", { title: "新标题" });
  assert.equal(diff.ok, false);
  assert.equal(diff.kind, "conflict");
  assert.match(diff.message, /写后读回不一致/);

  const stale = fixture((args) => {
    if (args[0] === "issue" && args[1] === "view") {
      return json({ number: 5, title: "旧", body: "", state: "open", url: "u", createdAt: "t1", updatedAt: "t2", labels: [], assignees: [] });
    }
    return bad("network", "unexpected");
  });
  const conflict = await gh.updateGithubIssue(stale.client, repo, "5", { title: "新标题", expectedUpdatedAt: "t1" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.kind, "conflict");
  assert.equal(stale.calls.some((call) => call.args[1] === "edit"), false);
});

test("关票与评论：关票严格读回；评论 REST 失败回落 CLI", async () => {
  let state = "CLOSED";
  const closed = fixture((args) => {
    if (args[0] === "issue" && args[1] === "close") {
      state = "CLOSED";
      return ok();
    }
    if (args[0] === "issue" && args[1] === "reopen") {
      state = "OPEN";
      return ok();
    }
    if (args[0] === "issue" && args[1] === "view") {
      return json({ number: 5, title: "x", body: "", state, url: "u", createdAt: "t1", updatedAt: "t2", labels: [], assignees: [] });
    }
    return bad("network", "unexpected");
  });
  const result = await gh.setGithubIssueState(closed.client, repo, "5", "closed", { reason: "not planned" });
  assert.equal(result.ok, true);
  assert.equal(result.data.state, "CLOSED");
  assert.equal(result.data.reason, "not planned");
  const closeCall = closed.calls.find((call) => call.args[0] === "issue" && call.args[1] === "close");
  assert.ok(closeCall.args.includes("--reason"));
  assert.ok(closeCall.args.includes("not planned"));
  const beforeReopen = closed.calls.length;
  const reopenReason = await gh.setGithubIssueState(closed.client, repo, "5", "open", { reason: "not planned" });
  assert.equal(reopenReason.ok, false);
  assert.equal(reopenReason.kind, "invalid");
  assert.equal(closed.calls.length, beforeReopen);
  const reopened = await gh.setGithubIssueState(closed.client, repo, "5", "open");
  assert.equal(reopened.ok, true);
  assert.equal(reopened.data.state, "OPEN");

  const commented = fixture((args) => {
    if (args[0] === "api" && String(args[1]).endsWith("/comments")) {
      return json({ id: 1, user: { login: "octo" }, body: "hi", created_at: "2026-01-02T00:00:00Z" });
    }
    return bad("network", "unexpected");
  });
  const commentResult = await gh.addGithubComment(commented.client, repo, "5", "hi");
  assert.equal(commentResult.ok, true);
  assert.equal(commentResult.data.author, "octo");

  const fallback = fixture((args) => {
    if (args[0] === "api") return bad("network", "timeout");
    if (args[0] === "issue" && args[1] === "comment") return ok();
    return bad("network", "unexpected");
  });
  const optimistic = await gh.addGithubComment(fallback.client, repo, "5", "hi");
  assert.equal(optimistic.ok, true);
  assert.equal(optimistic.data.author, "");
  assert.ok(fallback.calls[1].args.includes("issue"));
});

test("标签：差值写 + 读回；404 且无 push 判只读", async () => {
  let views = 0;
  const fx = fixture((args) => {
    if (args[0] === "issue" && args[1] === "view") {
      views += 1;
      const labels = views === 1 ? [{ name: "a", color: "ff0000" }] : [{ name: "b", color: "00ff00" }];
      return json({ number: 5, title: "x", body: "", state: "open", url: "u", createdAt: "t1", updatedAt: "t2", labels, assignees: [] });
    }
    if (args[0] === "issue" && args[1] === "edit") return ok();
    return bad("network", "unexpected");
  });
  const result = await gh.setGithubLabels(fx.client, repo, "5", ["b"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.labels.map((label) => label.name), ["b"]);
  const edit = fx.calls.find((call) => call.args[0] === "issue" && call.args[1] === "edit");
  assert.ok(edit.args.includes("--remove-label"));
  assert.ok(edit.args.includes("--add-label"));

  const denied = fixture((args) => {
    if (args[0] === "issue" && args[1] === "view") {
      return json({ number: 5, title: "x", body: "", state: "open", url: "u", createdAt: "t1", updatedAt: "t2", labels: [], assignees: [] });
    }
    if (args[0] === "issue" && args[1] === "edit") return bad("notfound", "HTTP 404", 1);
    if (args[0] === "api" && args[1] === `repos/${SLUG}`) return json({ push: false, triage: false });
    return bad("network", "unexpected");
  });
  const auth = await gh.setGithubLabels(denied.client, repo, "5", ["b"]);
  assert.equal(auth.ok, false);
  assert.equal(auth.kind, "auth");
  assert.match(auth.message, /只读/);

  let assigneeViews = 0;
  const assigns = fixture((args) => {
    if (args[0] === "issue" && args[1] === "view") {
      assigneeViews += 1;
      return json({ number: 5, title: "x", body: "", state: "open", url: "u", createdAt: "t1", updatedAt: "t2", labels: [], assignees: assigneeViews === 1 ? [{ login: "a" }] : [{ login: "b" }] });
    }
    if (args[0] === "issue" && args[1] === "edit") return ok();
    return bad("network", "unexpected");
  });
  const assigned = await gh.setGithubAssignees(assigns.client, repo, "5", ["b"]);
  assert.equal(assigned.ok, true);
  assert.deepEqual(assigned.data.assignees, ["b"]);

  let addViews = 0;
  const addedFixture = fixture((args) => {
    if (args[0] === "issue" && args[1] === "view") {
      addViews += 1;
      const labels = addViews === 1 ? [{ name: "a", color: "ff0000" }] : [{ name: "a", color: "ff0000" }, { name: "b", color: "00ff00" }];
      return json({ number: 5, title: "x", body: "", state: "open", url: "u", createdAt: "t1", updatedAt: "t2", labels, assignees: [] });
    }
    if (args[0] === "issue" && args[1] === "edit") return ok();
    return bad("network", "unexpected");
  });
  const added = await gh.addGithubLabel(addedFixture.client, repo, "5", "b");
  assert.equal(added.ok, true);
  assert.deepEqual(added.data.labels.map((label) => label.name), ["a", "b"]);
});

test("父票：先改后读回；未知 flag 回落 REST 子票接口", async () => {
  let parentReads = 0;
  const fx = fixture((args) => {
    const query = queryOf(args);
    if (query.includes("parent{number}")) {
      parentReads += 1;
      return json({ data: { repository: { issue: { number: 5, parent: parentReads === 1 ? null : { number: 10 } } } } });
    }
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/5`) {
      return json({ number: 5, state: "open", updated_at: "2026-01-02T00:00:00Z", blocked_by: [] });
    }
    if (args[0] === "issue" && args[1] === "edit") return ok();
    return bad("network", "unexpected");
  });
  const result = await gh.setGithubParent(fx.client, repo, "5", "10");
  assert.equal(result.ok, true);
  assert.equal(result.data.parentKey, "10");
  const edit = fx.calls.find((call) => call.args[0] === "issue" && call.args[1] === "edit");
  assert.ok(edit.args.includes("--parent"));
  assert.ok(edit.args.includes("10"));

  let restParentReads = 0;
  const rest = fixture((args) => {
    const query = queryOf(args);
    if (query.includes("parent{number}")) {
      restParentReads += 1;
      return json({ data: { repository: { issue: { number: 5, parent: restParentReads === 1 ? null : { number: 10 } } } } });
    }
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/5`) {
      return argAfter(args, "--jq") === ".id" ? ok("55") : json({ number: 5, state: "open", updated_at: "2026-01-02T00:00:00Z" });
    }
    if (args[0] === "issue" && args[1] === "edit") return bad("network", "unknown flag: --parent", 1);
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/10/sub_issues`) return ok("{}");
    return bad("network", "unexpected");
  });
  const viaRest = await gh.setGithubParent(rest.client, repo, "5", "10");
  assert.equal(viaRest.ok, true);
  const post = rest.calls.find((call) => call.args[1] === `repos/${SLUG}/issues/10/sub_issues`);
  assert.ok(post.args.includes("sub_issue_id=55"));
});

test("阻塞边：成环直接拒绝；GraphQL 主路；REST 兜底；读回失败给乐观结果", async () => {
  const noCalls = fixture(() => bad("network", "unexpected"));
  const self = await gh.setGithubBlockedBy(noCalls.client, repo, "2", ["2"]);
  assert.equal(self.ok, false);
  assert.equal(self.kind, "conflict");
  assert.equal(noCalls.calls.length, 0);

  const cycle = fixture((args) => {
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/2`) {
      return json({ number: 2, state: "open", updated_at: "T", blocked_by: [] });
    }
    if (queryOf(args).includes("issues(first")) {
      return listReply([node(3, { blockedBy: { pageInfo: { hasNextPage: false }, nodes: [{ number: 2, state: "OPEN" }] } })], { total: 1 });
    }
    return bad("network", "unexpected");
  });
  const cyclic = await gh.setGithubBlockedBy(cycle.client, repo, "2", ["3"]);
  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.kind, "conflict");
  assert.equal(cycle.calls.length, 2);

  let depsReads = 0;
  const gql = fixture((args) => {
    const query = queryOf(args);
    if (query.includes("issues(first")) return listReply([node(2)], { total: 1 });
    if (query.includes("i0: issue")) {
      return json({ data: { repository: { i0: { id: "ID2" }, i1: { id: "ID10" } } } });
    }
    if (query.includes("addBlockedBy")) return json({ data: { addBlockedBy: { issue: { number: 2 } } } });
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/2`) {
      return json({ number: 2, state: "open", updated_at: "T", blocked_by: [] });
    }
    if (args[0] === "api" && String(args[1]).includes("/dependencies/blocked_by")) {
      depsReads += 1;
      return depsReads === 1 ? json([]) : json([{ number: 10, title: "Blocker", state: "open" }]);
    }
    return bad("network", "unexpected");
  });
  const written = await gh.setGithubBlockedBy(gql.client, repo, "2", ["10"]);
  assert.equal(written.ok, true);
  assert.equal(written.data.route, "graphql");
  assert.equal(written.data.blockedBy[0].number, 10);
  assert.equal(written.data.cycleCheck, "clear");

  let restDepsReads = 0;
  const rest = fixture((args) => {
    const query = queryOf(args);
    if (query.includes("issues(first")) return listReply([node(2)], { total: 1 });
    if (query.includes("i0: issue")) return bad("network", "graphql id lookup down");
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/2`) {
      return json({ number: 2, state: "open", updated_at: "T", blocked_by: [] });
    }
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/10`) return argAfter(args, "--jq") === ".id" ? ok("1010") : json({});
    if (args[0] === "api" && String(args[1]).includes("/dependencies/blocked_by") && !args.includes("POST")) {
      restDepsReads += 1;
      return restDepsReads === 1 ? json([]) : json([{ number: 10, title: "Blocker", state: "open" }]);
    }
    if (args[0] === "api" && String(args[1]).includes("/dependencies/blocked_by") && args.includes("POST")) return ok("{}");
    return bad("network", "unexpected");
  });
  const viaRest = await gh.setGithubBlockedBy(rest.client, repo, "2", ["10"]);
  assert.equal(viaRest.ok, true);
  assert.equal(viaRest.data.route, "rest");
  const post = rest.calls.find((call) => call.args.includes("POST") && String(call.args[1]).includes("/dependencies/blocked_by"));
  assert.ok(post.args.includes("issue_id=1010"));

  let optimisticReads = 0;
  const optimistic = fixture((args) => {
    const query = queryOf(args);
    if (query.includes("issues(first")) return listReply([node(2)], { total: 1 });
    if (query.includes("i0: issue")) return bad("network", "down");
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/2`) return json({ number: 2, state: "open", updated_at: "T", blocked_by: [] });
    if (args[0] === "api" && args[1] === `repos/${SLUG}/issues/10`) return argAfter(args, "--jq") === ".id" ? ok("1010") : json({});
    if (args[0] === "api" && String(args[1]).includes("/dependencies/blocked_by") && !args.includes("POST")) {
      optimisticReads += 1;
      return optimisticReads === 1 ? json([]) : bad("network", "readback down");
    }
    if (args[0] === "api" && String(args[1]).includes("/dependencies/blocked_by") && args.includes("POST")) return ok("{}");
    return bad("network", "unexpected");
  });
  const soft = await gh.setGithubBlockedBy(optimistic.client, repo, "2", ["10"]);
  assert.equal(soft.ok, true);
  assert.equal(soft.data.optimistic, true);
});

test("标签色：颜色归一、变更校验、逐条成败、清单触顶", async () => {
  assert.equal(gh.normalizeColor("#ABC"), "aabbcc");
  assert.equal(gh.normalizeColor("00FF00"), "00ff00");
  assert.equal(gh.normalizeColor("#12"), null);
  assert.equal(gh.validateChanges([{ name: "Bug", color: "fff" }, { name: "bug", color: "000" }]).ok, false);
  assert.equal(gh.validateChanges([{ name: "bug", color: "nope" }]).ok, false);

  const fx = fixture((args) => {
    if (args[0] === "label" && args[1] === "edit") {
      return args.includes("bug") ? bad("notfound", "HTTP 404", 1) : ok();
    }
    if (args[0] === "api" && args[1] === `repos/${SLUG}`) return json({ push: false, triage: false });
    return bad("network", "unexpected");
  });
  const colors = await gh.setLabelColors(fx.client, repo, [{ name: "bug", color: "#fff" }, { name: "ops", color: "000000" }]);
  assert.equal(colors.ok, true);
  assert.equal(colors.data.applied.length, 1);
  assert.equal(colors.data.applied[0].name, "ops");
  assert.equal(colors.data.applied[0].color, "000000");
  assert.equal(colors.data.failed.length, 1);
  assert.equal(colors.data.failed[0].name, "bug");
  assert.equal(colors.data.failed[0].kind, "auth");

  const tooMany = fixture(() => json(Array.from({ length: 1000 }, (_, index) => ({ name: `l${index}`, color: "ffffff", description: "" }))));
  const truncated = await gh.listLabels(tooMany.client, repo);
  assert.equal(truncated.ok, false);
  assert.equal(truncated.kind, "env");

  const labels = fixture(() => json([{ name: "bug", color: "ABC", description: "d" }]));
  const listed = await gh.listLabels(labels.client, repo);
  assert.equal(listed.ok, true);
  assert.equal(listed.data.labels[0].color, "aabbcc");
});

test("条件请求：If-None-Match + 304；since 非法不发命令", async () => {
  const envelope = [
    "HTTP/2.0 200 OK",
    'etag: "v1"',
    "content-type: application/json",
    "",
    JSON.stringify([restIssue(1)]),
  ].join("\n");
  const parsed = gh.parseHttpResponse(envelope);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.headers.etag, '"v1"');

  const fx = fixture(() => ok('HTTP/2.0 304 Not Modified\netag: "v0"\n\n'));
  const notModified = await gh.listIssuesConditional(fx.client, repo, { etag: '"v0"', since: "2026-01-01T00:00:00Z" });
  assert.equal(notModified.ok, true);
  assert.equal(notModified.data.notModified, true);
  assert.deepEqual(notModified.data.items, []);
  assert.ok(fx.calls[0].args.includes("--include"));
  assert.ok(fx.calls[0].args.includes('If-None-Match: "v0"'));
  assert.match(String(fx.calls[0].args[1]), /since=/);

  const fresh = fixture(() => ok(envelope));
  const changed = await gh.listIssuesConditional(fresh.client, repo, { etag: '"v0"' });
  assert.equal(changed.ok, true);
  assert.equal(changed.data.notModified, false);
  assert.equal(changed.data.items[0].number, 1);
  assert.equal(changed.data.etag, '"v1"');

  const none = fixture(() => bad("network", "unexpected"));
  const invalid = await gh.listIssuesConditional(none.client, repo, { since: "not-a-date" });
  assert.equal(invalid.ok, false);
  assert.equal(none.calls.length, 0);
});

test("开仓：名字校验；成功走 git 序列 + gh repo create", async () => {
  const gitCalls = [];
  const fakeGit = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    if (args[0] === "--version") return { ok: true, stdout: "git version 2", stderr: "" };
    if (args[0] === "rev-parse") return { ok: false, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" };
    if (args[0] === "init" || args[0] === "add" || args[0] === "commit") return { ok: true, stdout: "", stderr: "" };
    if (args[0] === "remote") return { ok: false, stdout: "", stderr: "no such remote" };
    return { ok: true, stdout: "", stderr: "" };
  };
  const fx = fixture((args) => {
    if (args[0] === "--version") return ok("gh version 2");
    if (args[0] === "auth" && args[1] === "status") return ok("logged in");
    if (args[0] === "api" && args[1] === "user") return ok("acme\n");
    if (args[0] === "repo" && args[1] === "create") return ok("https://github.com/acme/deck");
    if (args[0] === "repo" && args[1] === "view") return ok(`${SLUG}\n`);
    return bad("network", "unexpected");
  });
  const result = await gh.initProject(fx.client, { cwd: "/tmp/work", name: "deck" }, fakeGit);
  assert.equal(result.ok, true);
  assert.equal(result.data.owner, "acme");
  assert.equal(result.data.route, "created");
  const create = fx.calls.find((call) => call.args[0] === "repo" && call.args[1] === "create");
  assert.deepEqual(create.args, ["repo", "create", "deck", "--private", "--source=.", "--push"]);

  const untouched = fixture(() => bad("network", "unexpected"));
  const badName = await gh.initProject(untouched.client, { cwd: "/tmp/work", name: "../x" }, fakeGit);
  assert.equal(badName.ok, false);
  assert.equal(badName.error.kind, "bad-name");
  assert.equal(untouched.calls.length, 0);

  const noGh = fixture((args) => (args[0] === "--version" ? bad("env", "gh not found") : bad("network", "unexpected")));
  const noGhResult = await gh.initProject(noGh.client, { cwd: "/tmp/work", name: "deck" }, fakeGit);
  assert.equal(noGhResult.ok, false);
  assert.equal(noGhResult.error.kind, "no-gh");

  const remoteGit = async (args) =>
    args[0] === "remote" ? { ok: true, stdout: "git@github.com:acme/deck.git", stderr: "" } : { ok: false, stdout: "", stderr: "" };
  const identity = await gh.resolveRepoKey(untouched.client, "/tmp/work", remoteGit);
  assert.deepEqual(identity, { owner: "acme", name: "deck", source: "remote" });
  assert.equal(untouched.calls.length, 0);
});

test("操作清单：25+ 项全部可调用，命名与注册表一致", async () => {
  const fx = fixture((args) => {
    if (args[0] === "issue" && args[1] === "close") return ok();
    if (args[0] === "issue" && args[1] === "view") {
      return json({ number: 1, title: "x", body: "", state: "CLOSED", url: "u", createdAt: "t", updatedAt: "t", labels: [], assignees: [] });
    }
    return bad("network", "unexpected");
  });
  const ops = gh.createGithubOperations({ exec: async (args, options) => (await fx.client.exec(args, options)) });
  assert.ok(gh.GITHUB_OPERATION_NAMES.length >= 25);
  for (const name of gh.GITHUB_OPERATION_NAMES) assert.equal(typeof ops[name], "function", name);
  const closed = await ops.issueClose(repo, "1");
  assert.equal(closed.ok, true);
  assert.equal(closed.data.state, "CLOSED");
  assert.equal(typeof ops.stats().graphqlCalls, "number");
});

test("边界与安全：仓库坐标拒绝路径注入；所有调用都是参数数组", async () => {
  const fx = fixture(() => bad("network", "unexpected"));
  const invalid = await gh.listIssuesPage(fx.client, { repo: { owner: "acme/../evil", name: "deck" } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.kind, "invalid");
  assert.equal(fx.calls.length, 0);

  const created = {
    number: 1,
    title: "x; rm -rf /",
    state: "open",
    html_url: "u",
    created_at: "t",
    updated_at: "t",
    labels: [],
    assignees: [],
  };
  const security = fixture((args) => (args[0] === "api" ? json(created) : bad("network", "unexpected")));
  const result = await gh.createGithubIssue(security.client, repo, { title: "x; rm -rf /" });
  assert.equal(result.ok, true);
  for (const call of security.calls) {
    assert.ok(Array.isArray(call.args));
    assert.equal(call.args.includes("-c"), false);
    assert.equal(call.args.includes("sh"), false);
    for (const arg of call.args) {
      assert.equal(typeof arg, "string");
      assert.doesNotMatch(arg, /ghp_|github_pat_|Bearer /);
    }
  }
  assert.ok(security.calls[0].args.includes("title=x; rm -rf /"));
});
