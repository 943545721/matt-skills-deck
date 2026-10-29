import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import {
  checkGitLabWritable,
  classifyGlabError,
  closeGitLabIssue,
  createGitLabIssue,
  describeGitLabRepo,
  getGitLabCurrentUser,
  getGitLabDependencies,
  getGitLabIssue,
  getGitLabRepoKey,
  getGitLabRepoPermissions,
  gitLabCounts,
  gitLabIssueAddress,
  gitLabPreflight,
  initGitLabProject,
  listGitLabIssues,
  listGitLabLabels,
  listGitLabPage,
  listGitLabSubIssues,
  mapGitLabIssues,
  normalizeGitLabColor,
  parseBlockedByLine,
  parseGitLabRemote,
  parsePartOfLine,
  postGitLabComment,
  readGitLabBudget,
  redactGlabText,
  reopenGitLabIssue,
  setGitLabAssignees,
  setGitLabBlockedBy,
  setGitLabLabelColors,
  setGitLabLabels,
  setGitLabParent,
  takeGitLabIssue,
  updateGitLabIssue,
} from "../server/tracker/gitlab.ts";
import { parseRemoteUrl, readRemoteUrl, redactRemoteUrl } from "../server/tracker/remote.ts";
import { resolveWritableBackend } from "../server/tracker/backend.ts";
import { setLabelColorsHandler } from "../server/rpc/labels.ts";

/**
 * GitLab 读+写：glab api 参数构造、错误分类、权限闸门、写失败语义。
 * 全部用 fixture + 假 glab，不碰真实 GitLab；真实 git 只用于临时仓库的 remote 解析。
 */

const sandboxes = [];
let fixtureSeq = 0;
const gitAvailable = () => spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

function sandbox(prefix = "deck-glab-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** 假 glab：把完整 argv 以 \x1f 分隔写入日志，脚本体决定返回值。 */
function fakeGlab(body) {
  const dir = sandbox();
  const bin = path.join(dir, "glab");
  const log = path.join(dir, "glab.log");
  const state = path.join(dir, "state");
  const script = `#!/bin/sh
while ! mkdir "$GLAB_LOG.lock" 2>/dev/null; do :; done
{ for arg in "$@"; do printf '%s' "$arg" | tr '\\n' '\\034'; printf '\\037'; done; printf '\\n'; } >> "$GLAB_LOG"
rmdir "$GLAB_LOG.lock"
STATE='${state}'
${body}
`;
  writeFileSync(bin, script, "utf8");
  chmodSync(bin, 0o755);
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(dir, "keep"), "", "utf8");
  const previousPath = process.env.PATH;
  const previousLog = process.env.GLAB_LOG;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  process.env.GLAB_LOG = log;
  return {
    dir,
    log,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split("\x1f").filter(Boolean).map((arg) => arg.split("\x1c").join("\n")))
        : [],
    restore: () => {
      process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.GLAB_LOG;
      else process.env.GLAB_LOG = previousLog;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 把 fixture 写成文件，脚本体用 `cat` 输出，避免 JSON 里的引号进 shell。 */
function fixture(dir, value) {
  const file = path.join(dir, `fixture-${++fixtureSeq}.json`);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return `cat '${file}'`;
}

function failureScript(text) {
  return `printf '%s\\n' '${text.replace(/'/g, "'\\''")}' >&2; exit 1`;
}

const issuePayload = (iid, extra = {}) => ({
  iid,
  title: `issue ${iid}`,
  state: "opened",
  web_url: `https://gitlab.com/acme/deck/-/issues/${iid}`,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  description: "body",
  labels: [{ name: "bug", color: "#FF0000" }],
  assignees: [{ username: "alice" }],
  project_id: 42,
  ...extra,
});

const projectPayload = (level, extra = {}) => ({
  id: 42,
  path_with_namespace: "acme/deck",
  web_url: "https://gitlab.com/acme/deck",
  archived: false,
  issues_enabled: true,
  issues_access_level: "enabled",
  permissions: { project_access: { access_level: level }, group_access: null },
  ...extra,
});

const finds = (calls, needle) => calls.find((args) => args.some((arg) => arg.includes(needle)));

test("错误分类：未安装 / 未登录 / 权限不足 / 只读 / 找不到 / 一般失败", () => {
  assert.equal(classifyGlabError({ code: "ENOENT" }).kind, "glab-missing");
  assert.equal(classifyGlabError({ code: 1, stderr: "Please run glab auth login" }).kind, "glab-unauth");
  assert.equal(classifyGlabError({ code: 1, stderr: "HTTP 401 Unauthorized" }).kind, "glab-unauth");
  assert.equal(classifyGlabError({ code: 1, stderr: "HTTP 403 Forbidden: permission denied" }).kind, "glab-forbidden");
  assert.equal(classifyGlabError({ code: 1, stderr: "project is archived" }).kind, "read-only-project");
  assert.equal(classifyGlabError({ code: 1, stderr: "HTTP 404 Not Found" }).kind, "not-found");
  assert.equal(classifyGlabError({ code: 1, stderr: "connection reset by peer" }).kind, "glab-failed");
  // 权限/只读对外只能压成 glab-failed，细节留在 kind 与 detail。
  assert.equal(classifyGlabError({ code: 1, stderr: "HTTP 403 Forbidden" }).reason, "glab-failed");
});

test("脱敏：glpat、URL 凭据、Authorization 与 query token 都不进日志", () => {
  const text = redactGlabText(
    "token glpat-AbCdEf123456 url https://user:secret@gitlab.com/a/b Authorization: Bearer xyz private_token=abc",
  );
  assert.doesNotMatch(text, /AbCdEf123456|secret|xyz|private_token=abc/);
  assert.match(text, /glpat-\*\*\*/);
  assert.match(text, /https:\/\/\*\*\*@gitlab\.com/);
});

test("映射：iid/state/labels/assignees/阻塞行，读数不套 GitHub 字段", () => {
  const mapped = mapGitLabIssues([
    issuePayload(7, { description: "Blocked by: #2, #9" }),
    issuePayload(8, { state: "closed", labels: [{ name: "wayfinder:map", color: "#00FF00" }] }),
    { title: "没有 iid，跳过" },
  ]);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].number, 7);
  assert.equal(mapped[0].state, "OPEN");
  assert.equal(mapped[0].readiness, "blocked");
  assert.deepEqual(mapped[0].blockedBy.map((item) => item.number), [2, 9]);
  assert.deepEqual(mapped[0].labels, [{ name: "bug", color: "ff0000" }]);
  assert.deepEqual(mapped[0].assignees, ["alice"]);
  assert.equal(mapped[1].state, "CLOSED");
  assert.equal(mapped[1].isMap, true);
  assert.equal(normalizeGitLabColor("#9D7CD8"), "9d7cd8");
  assert.equal(normalizeGitLabColor("not-a-color"), "cccccc");
});

test("正文行：Blocked by 解析去重，Part of 只认独立成行的父票", () => {
  assert.deepEqual(parseBlockedByLine("Blocked by: #3, #3, #7"), ["3", "7"]);
  assert.deepEqual(parseBlockedByLine("no blockers"), []);
  assert.equal(parsePartOfLine("Part of #12\nbody"), "12");
  assert.equal(parsePartOfLine("see Part of #12 inline"), null);
});

test("正文行：跨仓库隐藏区段里的 Blocked by 不算原生阻塞边", () => {
  // 不摘掉这段，GitLab 会把它当成一张永远 OPEN 的原生边：对方关票也解除不了。
  const body = "正文\n\n<!-- DSH-CROSS-REPO-BLOCKED-BY\nBlocked by: one/alpha#3\n-->\n";
  assert.deepEqual(parseBlockedByLine(body), []);
  // 可见行与隐藏区段同时存在时，只认可见那一行。
  const both = "Blocked by: #5\n\n<!-- DSH-CROSS-REPO-BLOCKED-BY\nBlocked by: one/alpha#3\n-->\n";
  assert.deepEqual(parseBlockedByLine(both), ["5"]);
});

test("列票：opened/closed/all 下推，per_page 有上限，merged 视图不碰远端", async () => {
  const gh = fakeGlab(`printf '%s\\n' '${JSON.stringify([issuePayload(1)])}'`);
  try {
    const open = await listGitLabIssues("acme", "deck", { limit: 500 });
    assert.equal(open.ok, true);
    assert.equal(open.source, "gitlab");
    assert.equal(open.issues.length, 1);
    const call = gh.calls()[0];
    assert.equal(call[0], "api");
    assert.match(call[1], /projects\/acme%2Fdeck\/issues\?state=opened/);
    assert.match(call[1], /per_page=100/);
    assert.match(call[1], /with_labels_details=true/);

    const closed = await listGitLabIssues("acme", "deck", { view: "closed" });
    assert.equal(closed.ok, true);
    assert.match(gh.calls()[1][1], /state=closed/);

    const before = gh.calls().length;
    const merged = await listGitLabIssues("acme", "deck", { view: "merged" });
    assert.equal(merged.ok, true);
    assert.equal(merged.issues.length, 0);
    assert.equal(gh.calls().length, before);
  } finally {
    gh.restore();
  }
});

test("详情：系统便签不是评论，原生阻塞边带进 blockedBy", async () => {
  const dir = sandbox();
  const notes = [
    { author: { username: "alice" }, created_at: "2026-10-01T00:00:00Z", body: "人写的", system: false },
    { author: { username: "alice" }, created_at: "2026-10-02T00:00:00Z", body: "added label bug", system: true },
  ];
  const gh = fakeGlab(`case "$*" in
  *"/notes"*) ${fixture(dir, notes)} ;;
  *"/links"*) ${fixture(dir, [{ link_type: "is_blocked_by", iid: 2, title: "blocker", state: "opened" }])} ;;
  *"/issues/3"*) ${fixture(dir, issuePayload(3))} ;;
  *"/issues/2"*) ${fixture(dir, issuePayload(2, { title: "blocker" }))} ;;
  *) echo '[]' ;;
esac`);
  try {
    const detail = await getGitLabIssue("acme", "deck", 3);
    assert.equal(detail.ok, true);
    assert.equal(detail.issue.body, "body");
    assert.deepEqual(detail.comments.map((comment) => comment.body), ["人写的"]);
    assert.deepEqual(detail.issue.blockedBy.map((item) => item.number), [2]);
    assert.equal(detail.issue.blockedBy[0].title, "blocker");
    assert.equal(detail.meta.commentCount, 1);
  } finally {
    gh.restore();
  }
});

test("标签：读回 # 前缀去掉并转小写，缺色用 cccccc", async () => {
  const labels = [
    { name: "bug", color: "#FF0000", description: "缺陷" },
    { name: "no-color" },
  ];
  const dir = sandbox();
  const gh = fakeGlab(fixture(dir, labels));
  try {
    const result = await listGitLabLabels("acme", "deck");
    assert.equal(result.ok, true);
    assert.deepEqual(result.labels, [
      { name: "bug", color: "ff0000", description: "缺陷" },
      { name: "no-color", color: "cccccc", description: "" },
    ]);
  } finally {
    gh.restore();
  }
});

test("计数：缺 opened/closed/all 就失败，state 收窄在本地", async () => {
  const dir = sandbox();
  const good = fakeGlab(fixture(dir, { statistics: { counts: { opened: 3, closed: 2, all: 5 } } }));
  try {
    const all = await gitLabCounts("acme", "deck");
    assert.deepEqual(all, { ok: true, open: 3, closed: 2, total: 5 });
    const closed = await gitLabCounts("acme", "deck", { state: "closed" });
    assert.deepEqual(closed, { ok: true, open: 0, closed: 2, total: 2 });
    const call = good.calls()[0];
    assert.match(call[1], /issues_statistics\?scope=all/);
  } finally {
    good.restore();
  }
  const bad = fakeGlab(fixture(dir, { statistics: { counts: { opened: 1 } } }));
  try {
    const result = await gitLabCounts("acme", "deck");
    assert.equal(result.ok, false);
    assert.match(result.detail, /opened \/ closed \/ all/);
  } finally {
    bad.restore();
  }
});

test("分页：游标是页码，满页才给下一页，总数与票数同口径", async () => {
  const dir = sandbox();
  const gh = fakeGlab(`case "$*" in
  *"issues_statistics"*) ${fixture(dir, { statistics: { counts: { opened: 5, closed: 0, all: 5 } } })} ;;
  *) ${fixture(dir, [issuePayload(1), issuePayload(2)])} ;;
esac`);
  try {
    const result = await listGitLabPage("acme", "deck", {}, { limit: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.page.items.length, 2);
    assert.equal(result.page.nextCursor, "2");
    assert.equal(result.page.total, 5);
    const call = finds(gh.calls(), "page=1");
    assert.ok(call);
    assert.match(call[1], /per_page=2/);
  } finally {
    gh.restore();
  }
});

test("子票：只认 Part of #n；归一失败的行计入 dropped，不静默丢", async () => {
  const dir = sandbox();
  const rows = [
    issuePayload(1, { description: "Part of #9\nbody" }),
    issuePayload(2),
    { title: "坏行" },
  ];
  const gh = fakeGlab(fixture(dir, rows));
  try {
    const result = await listGitLabSubIssues("acme", "deck", 9);
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.items.map((item) => item.number), [1]);
    assert.equal(result.result.fetched, 3);
    assert.equal(result.result.dropped, 1);
    assert.equal(result.result.capped, false);
  } finally {
    gh.restore();
  }
});

test("权限：project/group 取最大 access_level；问不出来如实失败", async () => {
  const dir = sandbox();
  const gh = fakeGlab(fixture(dir, projectPayload(20, { permissions: { project_access: { access_level: 10 }, group_access: { access_level: 20 } } })));
  try {
    const result = await getGitLabRepoPermissions("acme", "deck");
    assert.equal(result.ok, true);
    assert.deepEqual(result.permissions, { push: false, triage: true, accessLevel: 20, archived: false, issuesEnabled: true });
    assert.match(gh.calls()[0][1], /simple=true/);
  } finally {
    gh.restore();
  }
  const missing = fakeGlab(fixture(dir, { id: 42, permissions: {} }));
  try {
    const result = await getGitLabRepoPermissions("acme", "deck");
    assert.equal(result.ok, false);
    assert.match(result.detail, /access_level/);
  } finally {
    missing.restore();
  }
});

test("写闸门：归档、issue 关闭、低于 Reporter 都拒绝；Reporter 放行", async () => {
  const dir = sandbox();
  const cases = [
    [projectPayload(40, { archived: true }), /归档/],
    [projectPayload(40, { issues_enabled: false }), /关闭了 issue/],
    [projectPayload(10), /access_level=10/],
  ];
  for (const [payload, pattern] of cases) {
    const gh = fakeGlab(fixture(dir, payload));
    try {
      const result = await checkGitLabWritable("acme", "deck", "评论");
      assert.equal(result.ok, false);
      assert.match(result.detail, pattern);
    } finally {
      gh.restore();
    }
  }
  const ok = fakeGlab(fixture(dir, projectPayload(20)));
  try {
    const result = await checkGitLabWritable("acme", "deck", "评论");
    assert.equal(result.ok, true);
    assert.equal(result.permissions.triage, true);
  } finally {
    ok.restore();
  }
});

test("backend.ts：GitLab 可写，但低权限仍被拒绝", { skip: !gitAvailable() && "本机没有 git" }, async () => {
  const dir = sandbox();
  const ws = sandbox("deck-glab-ws-");
  spawnSync("git", ["init", "-q", ws]);
  spawnSync("git", ["-C", ws, "remote", "add", "origin", "https://gitlab.com/acme/deck.git"]);

  const good = fakeGlab(fixture(dir, projectPayload(30)));
  try {
    const backend = await resolveWritableBackend(ws, "评论");
    assert.equal(backend.ok, true);
    assert.equal(backend.kind, "gitlab");
    assert.equal(backend.key, "acme/deck");
    assert.equal(backend.repo.host, "gitlab");
    assert.equal(backend.permissions.triage, true);
  } finally {
    good.restore();
  }
  const low = fakeGlab(fixture(dir, projectPayload(10)));
  try {
    const backend = await resolveWritableBackend(ws, "评论");
    assert.equal(backend.ok, false);
    assert.equal(backend.reason, "glab-failed");
    assert.match(backend.detail, /access_level=10/);
  } finally {
    low.restore();
  }
});

test("标签改色 RPC 走写闸门：低权限时一条 PUT 都不发", { skip: !gitAvailable() && "本机没有 git" }, async () => {
  const dir = sandbox();
  const ws = sandbox("deck-glab-labels-");
  spawnSync("git", ["init", "-q", ws]);
  spawnSync("git", ["-C", ws, "remote", "add", "origin", "https://gitlab.com/acme/deck.git"]);

  const gh = fakeGlab(fixture(dir, projectPayload(10)));
  try {
    const result = await setLabelColorsHandler({
      workspaceDir: ws,
      changes: [{ name: "bug", color: "#00ff00" }],
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /access_level=10/);
    assert.equal(finds(gh.calls(), "--method"), undefined);
  } finally {
    gh.restore();
  }
});

test("评论：POST notes、body 原样作为单个参数，不经过 shell", async () => {
  const dir = sandbox();
  const marker = path.join(dir, "pwned");
  const body = `please check $(touch ${marker}) and \`id\``;
  const gh = fakeGlab(fixture(dir, { author: { username: "alice" }, created_at: "2026-10-01T00:00:00Z", body }));
  try {
    const result = await postGitLabComment("acme", "deck", 3, body);
    assert.equal(result.ok, true);
    assert.equal(result.comment.author, "alice");
    const call = finds(gh.calls(), "/notes");
    assert.ok(call);
    assert.equal(call[call.indexOf("--method") + 1], "POST");
    assert.equal(call[call.indexOf("-f") + 1], `body=${body}`);
    assert.equal(existsSync(marker), false);
    assert.ok(call.every((arg) => !/glpat-|GITLAB_TOKEN/.test(arg)));
  } finally {
    gh.restore();
  }
});

test("建票：POST 集合端点，锚行 + 父票行 + 标签一次发出", async () => {
  const dir = sandbox();
  const created = { iid: 12, web_url: "https://gitlab.com/acme/deck/-/issues/12", labels: ["bug"] };
  const gh = fakeGlab(`case "$*" in
  *"search=deck-key"*) printf '[]\\n' ;;
  *"state=opened&order_by=created_at"*) printf '[]\\n' ;;
  *"--method POST"*) ${fixture(dir, created)} ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await createGitLabIssue("acme", "deck", {
      title: "New issue",
      body: "hello",
      labels: ["bug", "bug", "p1"],
      idempotencyKey: "deck-key",
      parentKey: 9,
    });
    assert.equal(result.ok, true);
    assert.equal(result.number, 12);
    const call = finds(gh.calls(), "--method");
    assert.ok(call);
    assert.match(call[1], /\/issues$/);
    assert.equal(call[call.indexOf("--method") + 1], "POST");
    assert.equal(call[call.indexOf("-f") + 1], "title=New issue");
    const description = call.find((arg) => arg.startsWith("description="));
    assert.equal(description, "description=Part of #9\n<!-- DSH-IDEMPOTENCY-KEY: deck-key -->\nhello");
    assert.ok(call.includes("labels=bug,p1"));
    assert.ok(call.every((arg) => !/glpat-|token/i.test(arg)));
  } finally {
    gh.restore();
  }
});

test("建票幂等：搜索命中锚就复用，不再 POST", async () => {
  const dir = sandbox();
  const hit = issuePayload(21, { description: "<!-- DSH-IDEMPOTENCY-KEY: deck-key -->\nbody" });
  const gh = fakeGlab(fixture(dir, [hit]));
  try {
    const result = await createGitLabIssue("acme", "deck", { title: "New", body: "", idempotencyKey: "deck-key" });
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(result.number, 21);
    assert.equal(finds(gh.calls(), "--method"), undefined);
  } finally {
    gh.restore();
  }
});

test("建票失败：回查两条路都不通时不出手；5xx 可能已建，4xx 明确没建", async () => {
  const dir = sandbox();
  const blind = fakeGlab(`case "$*" in
  *"search=key"*) ${failureScript("HTTP 500 search down")} ;;
  *) ${failureScript("HTTP 500 list down")} ;;
esac`);
  try {
    const result = await createGitLabIssue("acme", "deck", { title: "New", body: "", idempotencyKey: "key" });
    assert.equal(result.ok, false);
    assert.equal(result.maybeWritten, false);
    assert.match(result.detail, /回查/);
    assert.equal(finds(blind.calls(), "--method"), undefined);
  } finally {
    blind.restore();
  }

  const server = fakeGlab(`case "$*" in
  *"search=key"*) printf '[]\\n' ;;
  *"state=opened&order_by=created_at"*) printf '[]\\n' ;;
  *) ${failureScript("HTTP 502 Bad Gateway")} ;;
esac`);
  try {
    const result = await createGitLabIssue("acme", "deck", { title: "New", body: "", idempotencyKey: "key" });
    assert.equal(result.ok, false);
    assert.equal(result.maybeCreated, true);
    assert.equal(result.outcome, "maybe-written");
    assert.match(result.detail, /幂等键 key/);
  } finally {
    server.restore();
  }

  const rejected = fakeGlab(`case "$*" in
  *"search=key"*) printf '[]\\n' ;;
  *"state=opened&order_by=created_at"*) printf '[]\\n' ;;
  *) ${failureScript("HTTP 422 Unprocessable Entity")} ;;
esac`);
  try {
    const result = await createGitLabIssue("acme", "deck", { title: "New", body: "", idempotencyKey: "key" });
    assert.equal(result.ok, false);
    assert.equal(result.maybeCreated, false);
    assert.equal(result.outcome, "not-written");
  } finally {
    rejected.restore();
  }
});

test("关票/重开：只发 state_event，不猜远端最终状态", async () => {
  const gh = fakeGlab(`printf '{}\\n'`);
  try {
    const closed = await closeGitLabIssue("acme", "deck", 4);
    assert.deepEqual(closed, { ok: true, state: "CLOSED" });
    const reopened = await reopenGitLabIssue("acme", "deck", 4);
    assert.deepEqual(reopened, { ok: true, state: "OPEN" });
    const [first, second] = gh.calls();
    assert.ok(first.includes("state_event=close"));
    assert.ok(second.includes("state_event=reopen"));
  } finally {
    gh.restore();
  }
});

test("改票：只发给出的字段，milestone 用 id；回包缺字段按发出去的值回填", async () => {
  const dir = sandbox();
  const gh = fakeGlab(fixture(dir, { title: "new", description: "new body", state: "closed" }));
  try {
    const result = await updateGitLabIssue("acme", "deck", 5, { title: " new ", body: "new body", state: "closed", milestoneId: 7 });
    assert.deepEqual(result, { ok: true, title: "new", body: "new body", state: "CLOSED" });
    const call = finds(gh.calls(), "--method");
    assert.ok(call.includes("title=new"));
    assert.ok(call.includes("description=new body"));
    assert.ok(call.includes("state_event=close"));
    assert.ok(call.includes("milestone_id=7"));
  } finally {
    gh.restore();
  }
  const minimal = fakeGlab(fixture(dir, {}));
  try {
    const result = await updateGitLabIssue("acme", "deck", 5, { title: "only" });
    assert.equal(result.ok, true);
    const call = finds(minimal.calls(), "--method");
    assert.ok(call.includes("title=only"));
    assert.ok(!call.some((arg) => arg.startsWith("description=")));
    assert.ok(!call.some((arg) => arg.startsWith("state_event=")));
  } finally {
    minimal.restore();
  }
});

test("标签替换：逗号拼接，空数组就是清空；颜色缺失按 cccccc", async () => {
  const dir = sandbox();
  const gh = fakeGlab(fixture(dir, { labels: ["bug", "p1"] }));
  try {
    const result = await setGitLabLabels("acme", "deck", 6, ["bug", "p1", "bug"]);
    assert.deepEqual(result, { ok: true, labels: [{ name: "bug", color: "cccccc" }, { name: "p1", color: "cccccc" }] });
    assert.ok(finds(gh.calls(), "labels=bug,p1"));
    await setGitLabLabels("acme", "deck", 6, []);
    assert.ok(gh.calls()[1].includes("labels="));
  } finally {
    gh.restore();
  }
});

test("指派：用户名先解析成 id；找不到用户时明确没写入", async () => {
  const dir = sandbox();
  const gh = fakeGlab(`case "$*" in
  *"users?username=alice"*) ${fixture(dir, [{ id: 7 }])} ;;
  *) ${fixture(dir, { assignees: [{ username: "alice" }] })} ;;
esac`);
  try {
    const result = await setGitLabAssignees("acme", "deck", 7, ["alice"]);
    assert.deepEqual(result, { ok: true, assignees: ["alice"] });
    const put = finds(gh.calls(), "--method");
    assert.ok(put.includes("assignee_ids=7"));
  } finally {
    gh.restore();
  }
  const missing = fakeGlab(`case "$*" in
  *"users?username=ghost"*) printf '[]\\n' ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await setGitLabAssignees("acme", "deck", 7, ["ghost"]);
    assert.equal(result.ok, false);
    assert.equal(result.maybeWritten, false);
    assert.match(result.detail, /找不到用户 ghost/);
    assert.equal(finds(missing.calls(), "--method"), undefined);
  } finally {
    missing.restore();
  }
});

test("接手：读当前登录用户与现有指派，再增量写回", async () => {
  const dir = sandbox();
  const gh = fakeGlab(`case "$*" in
  "api user") ${fixture(dir, { username: "me" })} ;;
  *"users?username=alice"*) ${fixture(dir, [{ id: 7 }])} ;;
  *"users?username=me"*) ${fixture(dir, [{ id: 8 }])} ;;
  *"--method PUT"*) ${fixture(dir, { assignees: [{ username: "alice" }, { username: "me" }] })} ;;
  *) ${fixture(dir, issuePayload(8))} ;;
esac`);
  try {
    const result = await takeGitLabIssue("acme", "deck", 8, true);
    assert.deepEqual(result, { ok: true, login: "me", assignees: ["alice", "me"] });
    const put = finds(gh.calls(), "--method");
    assert.ok(put.includes("assignee_ids=7,8"));
  } finally {
    gh.restore();
  }
});

test("父票：只改正文 Part of 行，写后读回确认", async () => {
  const dir = sandbox();
  const gh = fakeGlab(`case "$*" in
  *"--method PUT"*) touch "$STATE/put"; printf '{}\\n' ;;
  *"/issues/9"*) if [ -f "$STATE/put" ]; then ${fixture(dir, issuePayload(9, { description: "Part of #3\nbody" }))}; else ${fixture(dir, issuePayload(9))}; fi ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await setGitLabParent("acme", "deck", 9, 3);
    assert.deepEqual(result, { ok: true, parentKey: "3" });
    const put = finds(gh.calls(), "--method");
    assert.equal(put[put.indexOf("-f") + 1], "description=Part of #3\nbody");
  } finally {
    gh.restore();
  }
});

test("阻塞原生边：target_project_id 用数字，写后读回，不把 owner/name 塞进 id 字段", async () => {
  const dir = sandbox();
  const gh = fakeGlab(`case "$*" in
  *"/links"*"--method POST"*) printf '%s' linked > "$STATE/links"; ${fixture(dir, { issue_link_id: 99 })} ;;
  *"/links"*) if [ -f "$STATE/links" ]; then ${fixture(dir, [{ link_type: "is_blocked_by", iid: 2, title: "blocker", state: "opened", issue_link_id: 99 }])}; else printf '[]\\n'; fi ;;
  *"/issues/2"*) ${fixture(dir, issuePayload(2, { title: "blocker" }))} ;;
  *"/issues/1"*) ${fixture(dir, issuePayload(1))} ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await setGitLabBlockedBy("acme", "deck", 1, [2]);
    assert.deepEqual(result, { ok: true, blockers: [2], source: "native" });
    const post = finds(gh.calls(), "--method");
    assert.ok(post.includes("target_project_id=42"));
    assert.ok(post.includes("target_issue_iid=2"));
    assert.ok(post.includes("link_type=is_blocked_by"));
  } finally {
    gh.restore();
  }
});

test("阻塞回退：免费版没有原生边时改写正文 Blocked by 行并读回", async () => {
  const dir = sandbox();
  const gh = fakeGlab(`case "$*" in
  *"/links"*) ${failureScript("HTTP 404 Not Found")} ;;
  *"--method PUT"*) touch "$STATE/put"; printf '{}\\n' ;;
  *"/issues/1"*) if [ -f "$STATE/put" ]; then ${fixture(dir, issuePayload(1, { description: "Blocked by: #2\n\nbody" }))}; else ${fixture(dir, issuePayload(1))}; fi ;;
  *"/issues/2"*) ${fixture(dir, issuePayload(2))} ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await setGitLabBlockedBy("acme", "deck", 1, [2]);
    assert.deepEqual(result, { ok: true, blockers: [2], source: "description" });
    const put = finds(gh.calls(), "--method");
    assert.equal(put[put.indexOf("-f") + 1], "description=Blocked by: #2\n\nbody");
  } finally {
    gh.restore();
  }
});

test("阻塞预检：阻塞链读不出来时拒绝写入，不假装没有环", async () => {
  const dir = sandbox();
  const gh = fakeGlab(`case "$*" in
  *"/issues/1"*) ${fixture(dir, issuePayload(1))} ;;
  *"/issues/2"*) ${failureScript("HTTP 500 Internal Server Error")} ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await setGitLabBlockedBy("acme", "deck", 1, [2]);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "not-written");
    assert.match(result.detail, /成环预检没跑完/);
    assert.equal(finds(gh.calls(), "--method"), undefined);
  } finally {
    gh.restore();
  }
});

test("阻塞预检：原生边读不出来时拒绝写入，不退回正文行假装没有环", async () => {
  const dir = sandbox();
  const gh = fakeGlab(`case "$*" in
  *"/links"*) ${failureScript("HTTP 500 Internal Server Error")} ;;
  *"/issues/1"*) ${fixture(dir, issuePayload(1))} ;;
  *"/issues/2"*) ${fixture(dir, issuePayload(2, { description: "body without a blocked-by line" }))} ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await setGitLabBlockedBy("acme", "deck", 1, [2]);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "not-written");
    assert.match(result.detail, /原生阻塞边/);
    assert.equal(finds(gh.calls(), "--method"), undefined);
  } finally {
    gh.restore();
  }
});

test("标签色：逐条 PUT，写 #rrggbb；非法颜色整批拒绝", async () => {
  const gh = fakeGlab(`printf '{}\\n'`);
  try {
    const ok = await setGitLabLabelColors("acme", "deck", [{ name: "Bug", color: "#9D7CD8" }]);
    assert.deepEqual(ok, { ok: true, applied: [{ name: "Bug", color: "9d7cd8" }], failed: [] });
    const call = gh.calls()[0];
    assert.match(call[1], /labels\/Bug$/);
    assert.ok(call.includes("color=#9d7cd8"));
    const bad = await setGitLabLabelColors("acme", "deck", [{ name: "Bug", color: "purple" }]);
    assert.equal(bad.ok, false);
    assert.equal(gh.calls().length, 1);
  } finally {
    gh.restore();
  }
});

test("预检：没登录归 auth，项目不可达归 project", async () => {
  const unauth = fakeGlab(failureScript("not logged in"));
  try {
    const result = await gitLabPreflight();
    assert.equal(result.ok, false);
    assert.equal(result.stage, "auth");
    assert.equal(result.reason, "glab-unauth");
  } finally {
    unauth.restore();
  }
  const project = fakeGlab(`case "$*" in
  *"auth status"*) printf 'Logged in to gitlab.com\\n' ;;
  *) ${failureScript("HTTP 404 Not Found")} ;;
esac`);
  try {
    const result = await gitLabPreflight("acme", "deck");
    assert.equal(result.ok, false);
    assert.equal(result.stage, "project");
    assert.equal(result.reason, "not-found");
  } finally {
    project.restore();
  }
});

test("预算：读 RateLimit 头；量不到就说未知，不编 0", async () => {
  const known = fakeGlab(`printf 'HTTP/1.1 200 OK\\nRateLimit-Limit: 600\\nRateLimit-Remaining: 42\\n\\n{}\\n'`);
  try {
    assert.deepEqual(await readGitLabBudget(), { ok: true, known: true, limit: 600, remaining: 42 });
    assert.equal(known.calls()[0].includes("--include"), true);
  } finally {
    known.restore();
  }
  const unknown = fakeGlab(`printf '{}\\n'`);
  try {
    assert.deepEqual(await readGitLabBudget(), { ok: true, known: false, reason: "unavailable" });
  } finally {
    unknown.restore();
  }
});

test("当前用户与仓库定位：remote → 坐标；自建实例/多段分组可解析", { skip: !gitAvailable() && "本机没有 git" }, async () => {
  const dir = sandbox();
  const gh = fakeGlab(fixture(dir, { username: "alice", name: "Alice", avatar_url: "https://x/y.png" }));
  try {
    assert.deepEqual(await getGitLabCurrentUser(), { ok: true, login: "alice", name: "Alice", avatarUrl: "https://x/y.png" });
  } finally {
    gh.restore();
  }
  const ws = sandbox("deck-glab-key-");
  spawnSync("git", ["init", "-q", ws]);
  spawnSync("git", ["-C", ws, "remote", "add", "origin", "git@gitlab.example.com:group/sub/deck.git"]);
  assert.deepEqual(await getGitLabRepoKey(ws), { owner: "group/sub", name: "deck" });
  assert.deepEqual(parseGitLabRemote("https://gitlab.com/acme/deck.git"), { owner: "acme", name: "deck" });
  assert.equal(parseGitLabRemote("not a url"), null);
  assert.deepEqual(describeGitLabRepo("acme", "deck"), { provider: "gitlab", key: "acme/deck", url: "https://gitlab.com/acme/deck" });
  assert.deepEqual(gitLabIssueAddress("acme", "deck", 3), {
    provider: "gitlab",
    repoKey: "acme/deck",
    number: 3,
    kind: "issue",
    url: "https://gitlab.com/acme/deck/-/issues/3",
  });
});

test("初始化：非法仓库名在动任何命令之前就拒绝", async () => {
  const result = await initGitLabProject("/tmp/not-used", { name: "bad name!" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(result.maybeWritten, false);
});

test("remote.ts：凭据与 token 在读出前脱敏，解析仍然认得出 GitLab", { skip: !gitAvailable() && "本机没有 git" }, async () => {
  const ws = sandbox("deck-glab-remote-");
  spawnSync("git", ["init", "-q", ws]);
  spawnSync("git", ["-C", ws, "remote", "add", "origin", "https://user:secret@gitlab.com/acme/deck.git?private_token=abc"]);
  const read = await readRemoteUrl(ws);
  assert.equal(read.ok, true);
  assert.doesNotMatch(read.url, /secret|private_token=abc/);
  assert.match(read.url, /gitlab\.com\/acme\/deck\.git/);
  const ref = parseRemoteUrl("https://gitlab.com/acme/deck.git");
  assert.deepEqual(ref, { host: "gitlab", owner: "acme", name: "deck" });
  assert.equal(redactRemoteUrl("ssh://git@gitlab.com/acme/deck.git"), "ssh://***@gitlab.com/acme/deck.git");
  assert.deepEqual(parseRemoteUrl("git@gitlab.com:acme/deck.git"), { host: "gitlab", owner: "acme", name: "deck" });
});
