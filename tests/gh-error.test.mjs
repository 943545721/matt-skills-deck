import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { classifyGhError } from "../server/tracker/gh-error.ts";
import { listIssues } from "../server/tracker/github.ts";
import { listIssuesHandler } from "../server/rpc/issues.ts";

/**
 * gh 失败必须分得清「没装」「没登录」「远端拒绝」。
 *
 * 当初只分前两种，于是「装了 gh 但没登录」显示成「GitHub 拒绝了这次操作」——
 * 请求根本没发出去，用户却去查仓库权限。这里把分类真身和读路径的接线一起钉住。
 */

test("没装 gh：ENOENT 归成 gh-missing，并保留重试提示", () => {
  const result = classifyGhError(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), "刷新");
  assert.equal(result.reason, "gh-missing");
  assert.match(result.detail, /再刷新/);
});

test("没登录：退出码 4 归成 gh-unauth，而不是 gh-failed", () => {
  const error = Object.assign(new Error("Command failed: gh api graphql"), {
    code: 4,
    stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
  });
  assert.equal(classifyGhError(error).reason, "gh-unauth");
});

test("没登录：退出码 4 单独就够，不依赖 stderr 文案", () => {
  // 这条专门钉数字分支：把它删掉，只靠上一例的提示词也能过，等于没测。
  const error = Object.assign(new Error("Command failed"), { code: 4, stderr: "Command failed" });
  assert.equal(classifyGhError(error).reason, "gh-unauth");
});

test("超时且 stderr 为空：命令行里的用户内容不能把失败判成没登录", () => {
  // execFile 超时时 code=null、stderr 为空，message 里拼着完整 argv。
  // 评论正文恰好写了「gh auth login」时，旧写法会误判成 gh-unauth，
  // 从而绕过 write.ts 的「评论可能已写入」保护——重试就会产生重复评论。
  const error = Object.assign(
    new Error("Command failed: gh api repos/acme/deck/issues/7/comments -f body=请先运行 gh auth login"),
    { code: null, killed: true, signal: "SIGTERM", stderr: "" },
  );
  const result = classifyGhError(error);
  assert.equal(result.reason, "gh-failed");
  // 详情里也不该回显命令行（可能含用户写的正文）。
  assert.doesNotMatch(result.detail, /repos\/acme|请先运行/);
});

test("代理要求认证（407）不是 gh 没登录", () => {
  const error = Object.assign(new Error("Command failed"), {
    code: 1,
    stderr: 'Post "https://api.github.com/graphql": Proxy Authentication Required',
  });
  assert.equal(classifyGhError(error).reason, "gh-failed");
});

test("没登录：退出码不是 4 时，按 gh 的提示文案兜底判定", () => {
  // gh 的退出码约定是 4，但不排除包装脚本改了退出码；stderr 说得很清楚时也要认出来。
  const error = Object.assign(new Error("Command failed"), {
    code: 1,
    stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
  });
  assert.equal(classifyGhError(error).reason, "gh-unauth");
});

test("远端/网络类失败仍然是 gh-failed，不能被误判成没登录", () => {
  const error = Object.assign(new Error("Command failed"), {
    code: 1,
    stderr: "HTTP 502: Server Error",
  });
  assert.equal(classifyGhError(error).reason, "gh-failed");
});

test("读列表真的会走这条分类：假 gh 退出 4 时返回 gh-unauth", async () => {
  const gh = fakeGh('echo "To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4');
  try {
    const result = await listIssues("acme", "deck");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "gh-unauth");
    assert.match(result.detail, /gh auth login/);
  } finally {
    gh.restore();
  }
});

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

test("RPC 层：失败时也带回已解析的仓库，界面才不用显示「未关联仓库」", { skip: !gitAvailable }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "deck-unauth-"));
  assert.equal(spawnSync("git", ["init", "-q", workspace]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", workspace, "remote", "add", "origin", "https://github.com/acme/deck.git"]).status,
    0,
  );

  const gh = fakeGh('echo "To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4');
  try {
    const result = await listIssuesHandler({ workspaceDir: workspace, includeClosed: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "gh-unauth");
    // 关键：远端解析成功，仓库坐标要随失败一起回来。
    assert.deepEqual(result.repo, {
      host: "github",
      owner: "acme",
      name: "deck",
      webUrl: "https://github.com/acme/deck",
    });
  } finally {
    gh.restore();
    rmSync(workspace, { recursive: true, force: true });
  }
});
