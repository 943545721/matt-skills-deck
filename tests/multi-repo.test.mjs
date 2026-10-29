import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { findTool } from "../server/mcp/tools.ts";
import { createIssueHandler } from "../server/rpc/issues.ts";
import { listLabelsHandler } from "../server/rpc/labels.ts";
import { readBoard, readIssue } from "../server/tracker/read.ts";
import {
  listWorkspaceRepoTargets,
  pickTarget,
  resolveWorkspaceTargets,
  resolveWritableTarget,
} from "../server/tracker/targets.ts";

/**
 * 合板（一个容器工作区下多个仓库）。
 *
 * 这里刻意让两个仓库都有 `#12`：票号只在仓库内唯一，任何「按号码去重」或
 * 「按号码找仓库」的写法都会在这个用例里现形。
 */

const sandboxes = [];
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
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
  assert.equal(spawnSync("git", ["-C", repo, "remote", "add", "origin", url]).status, 0);
  return repo;
}

function container(remotes) {
  const dir = sandbox("deck-multi-ws-");
  for (const [child, url] of Object.entries(remotes)) repoAt(dir, child, url);
  return dir;
}

/** 假 gh 用一段 Node 脚本决定每个仓库回什么；列表与详情按查询文本区分。 */
function toolGh(source) {
  const dir = sandbox("deck-multi-bin-");
  const script = path.join(dir, "handler.mjs");
  writeFileSync(script, source, "utf8");
  return fakeGh(`exec "${process.execPath}" "${script}" "$@"`);
}

test("RPC 建票：远端带 parentKey / idempotencyKey 时明确拒绝，不静默丢字段", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const repo = repoAt(sandbox("deck-rpc-ws-"), "repo", "https://github.com/acme/deck.git");
  const parent = await createIssueHandler({ workspaceDir: repo, title: "子票", parentKey: "3" });
  assert.equal(parent.ok, false);
  assert.equal(parent.reason, "invalid");
  assert.match(parent.detail, /parentKey/);
  const retry = await createIssueHandler({ workspaceDir: repo, title: "子票", idempotencyKey: "k1" });
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "invalid");
  assert.match(retry.detail, /idempotencyKey/);
});

const PRELUDE = `
const args = process.argv.slice(2);
const all = args.join(" ");
const get = (key) => {
  const hit = args.find((arg) => arg.startsWith(key + "="));
  return hit ? hit.slice(key.length + 1) : "";
};
const key = get("owner") + "/" + get("name");
const tickets = {
  "one/alpha": { number: 12, title: "alpha twelve" },
  "two/beta": { number: 12, title: "beta twelve" },
};
const ticket = tickets[key];
if (!ticket) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
const node = {
  number: ticket.number,
  title: ticket.title,
  state: "OPEN",
  url: "https://github.com/" + key + "/issues/" + ticket.number,
  updatedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-09-01T00:00:00Z",
  labels: { totalCount: 0, nodes: [] },
  assignees: { nodes: [] },
  blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
};
// 列表查询按连接分开：issues 与 pullRequests 各有独立的游标，不能塞进同一条查询。
const wantsIssues = all.includes("issues(first:");
const wantsPulls = all.includes("pullRequests(first:");
if (wantsIssues || wantsPulls) {
  const connection = (count, nodes) => ({ totalCount: count, pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  console.log(JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4999, resetAt: "2026-10-01T00:00:00Z" }, repository: {
    issues: wantsIssues ? connection(1, [node]) : undefined,
    pullRequests: wantsPulls ? connection(0, []) : undefined,
  } } }));
  process.exit(0);
}
if (all.includes("$number:Int!")) {
  console.log(JSON.stringify({ data: { repository: { issue: {
    ...node,
    body: "body of " + key,
    comments: { totalCount: 0, nodes: [] },
  } } } }));
  process.exit(0);
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

const MIXED_HANDLER = PRELUDE;
const PARTIAL_HANDLER = `${PRELUDE}
`.replace(
  `if (!ticket) {`,
  `if (key === "two/beta") {
  console.error("gh: Server Error (HTTP 500)");
  process.exit(1);
}
if (!ticket) {`,
);

test("多目标省略 repoKey：明确报错并列出可用仓库，不猜", () => {
  const targets = {
    ok: true,
    kind: "repos",
    targets: [
      {
        key: "acme/one",
        host: "github",
        owner: "acme",
        name: "one",
        webUrl: "https://github.com/acme/one",
        dir: "/work/one",
        readOnly: false,
        ref: { host: "github", owner: "acme", name: "one" },
      },
      {
        key: "acme/two",
        host: "github",
        owner: "acme",
        name: "two",
        webUrl: "https://github.com/acme/two",
        dir: "/work/two",
        readOnly: false,
        ref: { host: "github", owner: "acme", name: "two" },
      },
    ],
    defaultKey: null,
  };

  const missing = pickTarget(targets, undefined, "票面详情");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "invalid");
  assert.match(missing.detail, /acme\/one/);
  assert.match(missing.detail, /acme\/two/);

  const unknown = pickTarget(targets, "acme/three", "票面详情");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "invalid");

  const picked = pickTarget(targets, "acme/two", "票面详情");
  assert.equal(picked.ok, true);
  assert.equal(picked.target.key, "acme/two");
  assert.equal(picked.target.dir, "/work/two");
});

test("单目标省略 repoKey 仍可定位；本地后端只认 local 这个键", () => {
  const single = {
    ok: true,
    kind: "repos",
    targets: [
      {
        key: "acme/one",
        host: "github",
        owner: "acme",
        name: "one",
        webUrl: "https://github.com/acme/one",
        dir: "/work/one",
        readOnly: false,
        ref: { host: "github", owner: "acme", name: "one" },
      },
    ],
    defaultKey: "acme/one",
  };
  assert.equal(pickTarget(single, undefined, "票面详情").target.key, "acme/one");

  const local = { ok: true, kind: "local", workspaceDir: "/work", repo: { host: "local", owner: "", name: "work", webUrl: null } };
  const picked = pickTarget(local, "local", "票面详情");
  assert.equal(picked.kind, "local");
  assert.equal(picked.workspaceDir, "/work");

  // 传别的仓库键不能静默落到本地 `.deck/`：那会把「owner/repo#12」写成 `.deck/12.md`。
  const wrong = pickTarget(local, "acme/one", "票面详情");
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "invalid");
  assert.match(wrong.detail, /local/);
});

test(
  "容器工作区：两个子目录仓库都进合板，默认选择只影响 defaultKey",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      beta: "https://github.com/two/beta.git",
    });

    const targets = await resolveWorkspaceTargets(ws);
    assert.equal(targets.ok, true);
    assert.equal(targets.kind, "repos");
    assert.deepEqual(
      targets.targets.map((target) => target.key).sort(),
      ["one/alpha", "two/beta"],
    );
    assert.equal(targets.defaultKey, null);
    for (const target of targets.targets) {
      assert.equal(target.dir, path.join(ws, target.name));
    }

    // 选一个默认仓库不再缩小范围：两张票仍然都该读到。
    writeFileSync(path.join(ws, ".paseo-deck.json"), `${JSON.stringify({ repoDir: "beta" }, null, 2)}\n`);
    const selected = await resolveWorkspaceTargets(ws);
    assert.equal(selected.ok, true);
    assert.equal(selected.targets.length, 2);
    assert.equal(selected.defaultKey, "two/beta");
  },
);

test(
  "合板读：两个仓库的同号票各自保留，并带上自己的代码目录",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      beta: "https://github.com/two/beta.git",
    });
    const gh = toolGh(MIXED_HANDLER);
    try {
      const board = await readBoard(ws, { view: "open" });
      assert.equal(board.ok, true, JSON.stringify(board));
      assert.equal(board.issues.length, 2);
      // 同一个 #12 出现两次：不能按号码去重。
      assert.deepEqual(
        board.issues.map((issue) => `${issue.repoKey}#${issue.number}`).sort(),
        ["one/alpha#12", "two/beta#12"],
      );
      assert.deepEqual(
        board.repos.map((repo) => repo.key).sort(),
        ["one/alpha", "two/beta"],
      );
      assert.equal(board.repos.find((repo) => repo.key === "one/alpha").dir, path.join(ws, "alpha"));
      assert.deepEqual(board.failures, []);
      // 多仓库时顶层不再给单个 repo，调用方要用 repos 里的 key。
      assert.equal(board.repo, undefined);
    } finally {
      gh.restore();
    }
  },
);

test(
  "合板读：一个仓库失败不拖垮另一个，失败项带 repoKey",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      beta: "https://github.com/two/beta.git",
    });
    const gh = toolGh(PARTIAL_HANDLER);
    try {
      const board = await readBoard(ws, { view: "open" });
      assert.equal(board.ok, true, JSON.stringify(board));
      assert.deepEqual(board.issues.map((issue) => issue.repoKey), ["one/alpha"]);
      assert.equal(board.failures.length, 1);
      assert.equal(board.failures[0].repoKey, "two/beta");
      assert.match(board.failures[0].detail, /two\/beta|Server Error/);
    } finally {
      gh.restore();
    }
  },
);

test(
  "详情按 repoKey 路由；省略 repoKey 在多仓库下拒绝猜",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      beta: "https://github.com/two/beta.git",
    });
    const gh = toolGh(MIXED_HANDLER);
    try {
      const alpha = await readIssue(ws, 12, { repoKey: "one/alpha" });
      assert.equal(alpha.ok, true, JSON.stringify(alpha));
      assert.equal(alpha.repoKey, "one/alpha");
      assert.equal(alpha.result.ok, true);
      assert.equal(alpha.result.issue.title, "alpha twelve");

      const beta = await readIssue(ws, 12, { repoKey: "two/beta" });
      assert.equal(beta.ok, true, JSON.stringify(beta));
      assert.equal(beta.repoKey, "two/beta");
      assert.equal(beta.result.issue.title, "beta twelve");

      const ambiguous = await readIssue(ws, 12);
      assert.equal(ambiguous.ok, false);
      assert.equal(ambiguous.reason, "invalid");
      assert.match(ambiguous.detail, /one\/alpha/);
    } finally {
      gh.restore();
    }
  },
);

test(
  "写目标解析：GitHub / GitLab 都按 repoKey 路由，缺省多仓库拒绝",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      mirror: "git@gitlab.com:group/sub/mirror.git",
    });

    const github = await resolveWritableTarget(ws, "one/alpha", "评论");
    assert.equal(github.ok, true);
    assert.equal(github.kind, "github");
    assert.equal(github.key, "one/alpha");
    assert.equal(github.dir, path.join(ws, "alpha"));

    // 目标解析不再把 GitLab 判成只读；真正能不能写由 resolveWritableBackend 的权限闸门回答。
    const gitlab = await resolveWritableTarget(ws, "group/sub/mirror", "评论");
    assert.equal(gitlab.ok, true);
    assert.equal(gitlab.kind, "gitlab");
    assert.equal(gitlab.key, "group/sub/mirror");
    assert.equal(gitlab.dir, path.join(ws, "mirror"));

    const ambiguous = await resolveWritableTarget(ws, undefined, "评论");
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.reason, "invalid");
  },
);

test(
  "MCP 列表：不带 repo 时两张票都回，带 repo 时只回该仓库并给出 repo 名",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      beta: "https://github.com/two/beta.git",
    });
    const gh = toolGh(MIXED_HANDLER);
    const list = findTool("deck_issues_list");
    try {
      const all = await list.run({}, { workspaceDir: ws });
      assert.equal(all.isError, false, all.text);
      const payload = JSON.parse(all.text);
      assert.equal(payload.repo, null);
      assert.equal(payload.repos.length, 2);
      assert.deepEqual(
        payload.issues.map((issue) => `${issue.repo}#${issue.number}`).sort(),
        ["one/alpha#12", "two/beta#12"],
      );

      const one = await list.run({ repo: "two/beta" }, { workspaceDir: ws });
      assert.equal(one.isError, false, one.text);
      const filtered = JSON.parse(one.text);
      // 落到单个仓库后顶层 repo 恢复成 owner/name，Agent 不必再自己拼。
      assert.equal(filtered.repo, "two/beta");
      assert.deepEqual(filtered.issues.map((issue) => issue.repo), ["two/beta"]);

      const unknown = await list.run({ repo: "nope/x" }, { workspaceDir: ws });
      assert.equal(unknown.isError, true);
      assert.match(unknown.text, /one\/alpha/);
    } finally {
      gh.restore();
    }
  },
);

test(
  "仓库全集：筛过之后仍给全部仓库，界面靠它画筛选条",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      beta: "https://github.com/two/beta.git",
    });
    const gh = toolGh(MIXED_HANDLER);
    try {
      const filtered = await readBoard(ws, { view: "open", repoKey: "two/beta" });
      assert.equal(filtered.ok, true, JSON.stringify(filtered));
      assert.deepEqual(filtered.issues.map((issue) => issue.repoKey), ["two/beta"]);
      // 关键：repos 是全集，不能因为筛了 beta 就只剩 beta。
      assert.deepEqual(filtered.repos.map((repo) => repo.key).sort(), ["one/alpha", "two/beta"]);
      assert.equal(filtered.repo?.name, "beta");

      const listing = await listWorkspaceRepoTargets(ws);
      assert.equal(listing.ok, true, JSON.stringify(listing));
      assert.equal(listing.kind, "repos");
      assert.deepEqual(listing.repos.map((repo) => repo.key).sort(), ["one/alpha", "two/beta"]);
      assert.deepEqual(
        listing.repos.map((repo) => repo.relDir).sort(),
        ["alpha", "beta"],
      );
      assert.equal(listing.defaultKey, null);

      writeFileSync(path.join(ws, ".paseo-deck.json"), `${JSON.stringify({ repoDir: "beta" }, null, 2)}\n`);
      const selected = await listWorkspaceRepoTargets(ws);
      assert.equal(selected.ok, true);
      assert.equal(selected.repos.length, 2);
      assert.equal(selected.defaultKey, "two/beta");
    } finally {
      gh.restore();
    }
  },
);

test(
  "仓库全集：工作区根目录自己就是仓库时 relDir 为 null，且没有默认子目录",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = sandbox("deck-multi-root-");
    // 工作区根目录自己就是仓库，没有子目录可当默认项。
    assert.equal(spawnSync("git", ["init", "-q", ws]).status, 0);
    assert.equal(spawnSync("git", ["-C", ws, "remote", "add", "origin", "https://github.com/one/root.git"]).status, 0);

    const listing = await listWorkspaceRepoTargets(ws);
    assert.equal(listing.ok, true, JSON.stringify(listing));
    assert.deepEqual(listing.repos.map((repo) => repo.key), ["one/root"]);
    assert.equal(listing.repos[0].relDir, null);
    assert.equal(listing.defaultKey, null);
  },
);

test(
  "auto 后端：没有 git / 认不出远端时回落本地，而不是判死",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = sandbox("deck-multi-plain-");
    // 普通目录：git 可用但没仓库，auto 应回落本地 .deck。
    const plain = await resolveWorkspaceTargets(ws);
    assert.equal(plain.ok, true);
    assert.equal(plain.kind, "local");
  },
);

test(
  "auto 后端：根目录远端认不出来时回落本地，不把工作区判死",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = sandbox("deck-multi-bad-remote-");
    assert.equal(spawnSync("git", ["init", "-q", ws]).status, 0);
    assert.equal(spawnSync("git", ["-C", ws, "remote", "add", "origin", "/srv/mirror.git"]).status, 0);
    const targets = await resolveWorkspaceTargets(ws);
    assert.equal(targets.ok, true);
    assert.equal(targets.kind, "local");
  },
);

test(
  "多仓库标签：缺 repoKey 明确拒绝，不猜着改某个仓库",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const ws = container({
      alpha: "https://github.com/one/alpha.git",
      beta: "https://github.com/two/beta.git",
    });
    const result = await listLabelsHandler({ workspaceDir: ws });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid");
    assert.match(result.detail, /one\/alpha/);
  },
);
