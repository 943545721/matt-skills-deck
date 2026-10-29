import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GIT_IDENTITY,
  PUBLISH_TOKEN_TTL_MS,
  planPublish,
  publishTokenOf,
  renderPublishScript,
  repoNameProblem,
  shellQuote,
  verifyPublishToken,
} from "../server/publish.ts";
import { publishRunHandler } from "../server/rpc/publish.ts";

/**
 * 发布只构造计划，不执行：所有断言都对着 argv 数组与令牌，不碰真实 git / gh。
 */

const CWD = "/tmp/deck-workspace";
const NOW = Date.parse("2026-10-28T01:00:00.000Z");

function baseInput(overrides = {}) {
  return {
    cwd: CWD,
    name: "my-deck",
    isGitRepo: false,
    hasOrigin: false,
    identity: "configured",
    ...overrides,
  };
}

const argvsOf = (plan) => plan.commands.map((command) => command.argv);

test("新建仓库：git init → add → commit --allow-empty → gh repo create --source --push", () => {
  const plan = planPublish(baseInput(), { now: NOW });
  assert.equal(plan.ok, true);
  assert.equal(plan.route, "create");
  assert.equal(plan.visibility, "private");
  assert.equal(plan.dryRun, true);
  assert.deepEqual(argvsOf(plan), [
    ["git", "init"],
    ["git", "add", "."],
    ["git", "commit", "-m", "initial commit", "--allow-empty"],
    ["gh", "repo", "create", "my-deck", "--private", "--source=.", "--push"],
  ]);
  assert.equal(plan.commands.every((command) => command.why.length > 0), true);
  assert.equal(plan.commands.some((command) => command.when !== undefined), false);
});

test("已经是 git 仓库时跳过 git init；public 用 --public", () => {
  const plan = planPublish(baseInput({ isGitRepo: true, visibility: "public" }), { now: NOW });
  assert.equal(plan.ok, true);
  assert.equal(plan.visibility, "public");
  assert.equal(argvsOf(plan).some((argv) => argv.join(" ") === "git init"), false);
  assert.deepEqual(argvsOf(plan).at(-1), ["gh", "repo", "create", "my-deck", "--public", "--source=.", "--push"]);
  assert.equal(plan.warnings.some((warning) => warning.includes("公开仓库")), true);
});

test("提交身份缺失：追加三条条件命令，最后一条重试提交", () => {
  const plan = planPublish(baseInput({ identity: "missing" }), { now: NOW });
  assert.equal(plan.ok, true);
  const conditional = plan.commands.filter((command) => command.when === "commit-identity-missing");
  assert.deepEqual(conditional.map((command) => command.argv), [
    ["git", "config", "user.email", DEFAULT_GIT_IDENTITY.email],
    ["git", "config", "user.name", DEFAULT_GIT_IDENTITY.name],
    ["git", "commit", "-m", "initial commit", "--allow-empty"],
  ]);
  // 回退命令必须排在 gh repo create 之前，否则会先建出一个没有提交的远端。
  const lastFallback = plan.commands.findLastIndex((command) => command.when === "commit-identity-missing");
  const createIndex = plan.commands.findIndex((command) => command.argv[0] === "gh");
  assert.ok(lastFallback < createIndex);
  assert.equal(plan.warnings.some((warning) => warning.includes(DEFAULT_GIT_IDENTITY.email)), true);
});

test("身份未知时也保留回退，但不声称用户没配", () => {
  const plan = planPublish(baseInput({ identity: undefined }), { now: NOW });
  assert.equal(plan.ok, true);
  assert.equal(plan.commands.filter((command) => command.when !== undefined).length, 3);
  assert.equal(plan.warnings.some((warning) => warning.includes("无法确认")), true);
  assert.equal(plan.warnings.some((warning) => warning.includes("没有配置")), false);
});

test("已有 origin：建空远端 → set-url → push -u，绝不使用 --source", () => {
  const plan = planPublish(baseInput({ isGitRepo: true, hasOrigin: true, owner: "acme" }), { now: NOW });
  assert.equal(plan.ok, true);
  assert.equal(plan.route, "existing-remote");
  assert.deepEqual(argvsOf(plan), [
    ["git", "add", "."],
    ["git", "commit", "-m", "initial commit", "--allow-empty"],
    ["gh", "repo", "create", "my-deck", "--private"],
    ["git", "remote", "set-url", "origin", "https://github.com/acme/my-deck.git"],
    ["git", "push", "-u", "origin", "HEAD"],
  ]);
  assert.equal(plan.script.includes("--source"), false);
  assert.equal(plan.warnings.some((warning) => warning.includes("origin 已存在")), true);
});

test("已有 origin：可以直接给 remoteUrl，拿不到 owner 时才报错", () => {
  const explicit = planPublish(baseInput({ isGitRepo: true, hasOrigin: true, remoteUrl: "https://github.com/team/deck.git" }), { now: NOW });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.commands.some((command) => command.argv.join(" ").includes("https://github.com/team/deck.git")), true);

  const noTarget = planPublish(baseInput({ isGitRepo: true, hasOrigin: true }), { now: NOW });
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.reason, "bad-owner");
});

test("仓库名与目录校验：不合法就拒绝，不生成半个计划", () => {
  for (const name of ["", "  ", "has space", "a/b", "-rf", ".", "..", "名字", "a".repeat(101)]) {
    const result = planPublish(baseInput({ name }), { now: NOW });
    assert.equal(result.ok, false, `应当拒绝仓库名 ${JSON.stringify(name)}`);
    assert.equal(result.reason, "bad-name");
  }
  assert.equal(repoNameProblem("My.Deck_1-2"), null);
  assert.equal(repoNameProblem("a".repeat(100)), null);

  assert.equal(planPublish(baseInput({ cwd: "relative/path" }), { now: NOW }).reason, "bad-cwd");
  assert.equal(planPublish(baseInput({ cwd: "" }), { now: NOW }).reason, "bad-cwd");
  assert.equal(planPublish(baseInput({ hasOrigin: true }), { now: NOW }).reason, "inconsistent");
  assert.equal(planPublish(baseInput({ isGitRepo: true, hasOrigin: true, owner: "bad owner" }), { now: NOW }).reason, "bad-owner");
});

test("确认令牌：同一计划确定性一致，换任一字段就变", () => {
  const first = planPublish(baseInput(), { now: NOW });
  const same = planPublish(baseInput(), { now: NOW + 5_000 });
  const publicPlan = planPublish(baseInput({ visibility: "public" }), { now: NOW });
  const renamed = planPublish(baseInput({ name: "other-deck" }), { now: NOW });
  const existing = planPublish(baseInput({ isGitRepo: true, hasOrigin: true, owner: "acme" }), { now: NOW });
  const identity = planPublish(baseInput({ identity: "missing" }), { now: NOW });

  assert.equal(first.confirmToken, same.confirmToken);
  assert.match(first.confirmToken, /^[0-9a-f]{32}$/);
  for (const other of [publicPlan, renamed, existing, identity]) assert.notEqual(other.confirmToken, first.confirmToken);
  assert.equal(publishTokenOf(first), first.confirmToken);
});

test("二次确认：令牌对得上才通过，伪造、空值、计划改动、过期都拒绝", () => {
  const plan = planPublish(baseInput(), { now: NOW, ttlMs: 60_000 });
  assert.deepEqual(verifyPublishToken(plan, plan.confirmToken, { now: NOW + 1_000 }), { ok: true });
  assert.deepEqual(verifyPublishToken(plan, plan.confirmToken, { now: NOW + 60_000 }), { ok: true });

  const empty = verifyPublishToken(plan, "   ", { now: NOW });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "token-mismatch");

  const fake = verifyPublishToken(plan, "0".repeat(32), { now: NOW });
  assert.equal(fake.ok, false);
  assert.equal(fake.reason, "token-mismatch");

  const changed = planPublish(baseInput({ visibility: "public" }), { now: NOW, ttlMs: 60_000 });
  const mismatch = verifyPublishToken(changed, plan.confirmToken, { now: NOW });
  assert.equal(mismatch.reason, "token-mismatch");

  const expired = verifyPublishToken(plan, plan.confirmToken, { now: NOW + 60_001 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "token-expired");
  assert.equal(plan.issuedAt, new Date(NOW).toISOString());
  assert.equal(plan.expiresAt, new Date(NOW + 60_000).toISOString());
  assert.equal(PUBLISH_TOKEN_TTL_MS, 10 * 60_000);
});

test("dry-run 脚本可读：带说明注释、条件分支标注、含空格的参数正确引用", () => {
  const plan = planPublish(baseInput({ identity: "missing" }), { now: NOW });
  assert.match(plan.script, /dry-run 计划，尚未执行/);
  assert.match(plan.script, /git commit -m 'initial commit' --allow-empty/);
  assert.match(plan.script, /仅在提交因身份缺失失败时执行/);
  assert.match(plan.script, /gh repo create my-deck --private --source=\. --push/);
  assert.equal(plan.script.includes("&&"), false);

  assert.equal(shellQuote("plain"), "plain");
  assert.equal(shellQuote("initial commit"), "'initial commit'");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(renderPublishScript([{ argv: ["git", "add", "."], why: "暂存" }]), "# 暂存\ngit add .");
});

test("发布计划不执行任何写操作：只有命令与说明，没有执行结果字段", () => {
  const plan = planPublish(baseInput(), { now: NOW });
  assert.equal(plan.ok, true);
  assert.deepEqual(Object.keys(plan).sort(), [
    "commands",
    "confirmToken",
    "cwd",
    "dryRun",
    "expiresAt",
    "issuedAt",
    "name",
    "notes",
    "ok",
    "route",
    "script",
    "visibility",
    "warnings",
  ]);
  assert.equal("stdout" in plan, false);
  assert.equal("executed" in plan, false);
});

test("publishRunHandler：成功路线原样带回 owner/url/route", async () => {
  const seen = [];
  const result = await publishRunHandler(
    { workspaceDir: "/work/repo", name: "demo", visibility: "private" },
    {
      projectInit: async (input) => {
        seen.push(input);
        return {
          ok: true,
          data: { owner: "acme", name: "demo", url: "https://github.com/acme/demo", route: "created", healedOwnership: false },
        };
      },
    },
  );
  assert.deepEqual(seen, [{ cwd: "/work/repo", name: "demo", visibility: "private" }]);
  assert.deepEqual(result, {
    ok: true,
    owner: "acme",
    name: "demo",
    url: "https://github.com/acme/demo",
    route: "created",
    healedOwnership: false,
  });
});

test("publishRunHandler：失败档位透传，未知档位折成 unknown，不带 detail 时用 kind 兜底", async () => {
  const fail = await publishRunHandler(
    { workspaceDir: "/work/repo", name: "demo" },
    { projectInit: async () => ({ ok: false, error: { kind: "already-exists", message: "远端已有同名仓库", repoUrl: "https://github.com/acme/demo" } }) },
  );
  assert.deepEqual(fail, {
    ok: false,
    reason: "already-exists",
    detail: "远端已有同名仓库",
    repoUrl: "https://github.com/acme/demo",
  });

  const unknown = await publishRunHandler(
    { workspaceDir: "/work/repo", name: "demo" },
    { projectInit: async () => ({ ok: false, error: { kind: "something-new" } }) },
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknown");
  assert.equal(unknown.detail, "something-new");
});
