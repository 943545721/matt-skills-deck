import assert from "node:assert/strict";
import { test } from "node:test";
import { collectEnvChecks, effectiveBackend } from "../server/env.ts";
import { STANDARD_LABELS } from "../shared/labels.ts";

/**
 * 环境检查的职责是「说清楚缺什么、下一步做什么」，不是替用户动手。
 * 用注入的探针测，才不会被跑测试的机器上恰好装了什么影响结论。
 */

const baseSettings = { backend: "auto", refreshSeconds: 60, debugLogging: true };

const githubGate = {
  ok: true,
  ref: { host: "github", owner: "acme", name: "deck" },
  repo: { host: "github", owner: "acme", name: "deck", webUrl: "https://github.com/acme/deck" },
};

function probe(overrides = {}) {
  const labels = STANDARD_LABELS.map((label) => ({ name: label.name, color: label.color, description: label.description }));
  return {
    nodeVersion: "v22.20.0",
    settings: () => baseSettings,
    // 默认没有本地票；需要时由单个用例覆盖。
    exists: async (target) => !target.endsWith("/.deck"),
    resolveRepo: async () => githubGate,
    listLabels: async () => ({ ok: true, labels }),
    run: async (command, args) => {
      if (command === "git") return { ok: true, stdout: "git version 2.45.0", stderr: "" };
      if (command === "gh" && args[0] === "--version") return { ok: true, stdout: "gh version 2.60.0", stderr: "" };
      if (command === "gh") return { ok: true, stdout: "Logged in to github.com", stderr: "" };
      return { ok: false, stdout: "", stderr: "not found" };
    },
    ...overrides,
  };
}

const byId = (checks) => Object.fromEntries(checks.map((check) => [check.id, check]));

test("全部就绪：每一项都给出 ok，GitHub 后端且标签齐全", async () => {
  const { backend, checks } = await collectEnvChecks("/work/repo", probe());
  assert.equal(backend, "github");
  const map = byId(checks);
  for (const id of ["node", "git", "gh", "gh-auth", "workspace", "repo", "backend", "skills", "labels"]) {
    assert.equal(map[id].status, "ok", `${id}: ${JSON.stringify(map[id])}`);
  }
});

test("没装 gh：登录检查跳过、标签检查跳过，而不是连报三条同类错误", async () => {
  const { checks } = await collectEnvChecks(
    "/work/repo",
    probe({
      run: async (command, args) => {
        if (command === "git") return { ok: true, stdout: "git version 2.45.0", stderr: "" };
        if (command === "gh") return { ok: false, stdout: "", stderr: "" };
        return { ok: false, stdout: "", stderr: "" };
      },
    }),
  );
  const map = byId(checks);
  assert.equal(map.gh.status, "fail");
  assert.match(map.gh.fix, /gh auth login/);
  assert.equal(map["gh-auth"].status, "skip");
  assert.equal(map.labels.status, "skip");
});

test("gh 未登录：只报登录，且修复命令就是 gh auth login", async () => {
  const { checks } = await collectEnvChecks(
    "/work/repo",
    probe({
      run: async (command, args) => {
        if (command === "git") return { ok: true, stdout: "git version 2.45.0", stderr: "" };
        if (command === "gh" && args[0] === "--version") return { ok: true, stdout: "gh version 2.60.0", stderr: "" };
        if (command === "gh") return { ok: false, stdout: "", stderr: "You are not logged into any GitHub hosts." };
        return { ok: false, stdout: "", stderr: "" };
      },
    }),
  );
  const map = byId(checks);
  assert.equal(map["gh-auth"].status, "fail");
  assert.match(map["gh-auth"].detail, /not logged/);
  assert.equal(map["gh-auth"].fix, "gh auth login");
});

test("没有远端：auto 回落到本地 Markdown，不是「不支持」", async () => {
  const { backend, checks } = await collectEnvChecks(
    "/work/repo",
    probe({
      resolveRepo: async () => ({ ok: false, reason: "no-repo", detail: "这个工作区没有可用的 git 远端" }),
    }),
  );
  assert.equal(backend, "local");
  const map = byId(checks);
  assert.equal(map.repo.status, "fail");
  assert.match(map.repo.fix, /git remote add origin/);
  assert.equal(map.backend.status, "ok");
  assert.match(map.backend.detail, /本地 Markdown/);
  assert.equal(map.labels.status, "skip");
});

test("切换前置检查：本地已有 .deck/ 而当前后端是 GitHub，要提示这些票不会显示", async () => {
  const { checks } = await collectEnvChecks("/work/repo", probe({ exists: async () => true }));
  const backend = byId(checks).backend;
  assert.equal(backend.status, "warn");
  assert.match(backend.detail, /\.deck\//);
});

test("切换前置检查：GitLab 后端明说只读，不让用户以为写按钮会生效", async () => {
  const gitlabGate = {
    ok: true,
    ref: { host: "gitlab", owner: "group/sub", name: "deck" },
    repo: { host: "gitlab", owner: "group/sub", name: "deck", webUrl: "https://gitlab.com/group/sub/deck" },
  };
  const { backend, checks } = await collectEnvChecks(
    "/work/repo",
    probe({
      resolveRepo: async () => gitlabGate,
      run: async (command, args) => {
        if (command === "glab" && args[0] === "--version") return { ok: true, stdout: "glab 1.50.0", stderr: "" };
        if (command === "glab") return { ok: true, stdout: "Logged in to gitlab.com", stderr: "" };
        if (command === "git") return { ok: true, stdout: "git version 2.45.0", stderr: "" };
        if (command === "gh" && args[0] === "--version") return { ok: true, stdout: "gh version 2.60.0", stderr: "" };
        return { ok: true, stdout: "Logged in", stderr: "" };
      },
    }),
  );
  assert.equal(backend, "gitlab");
  const row = byId(checks).backend;
  assert.equal(row.status, "warn");
  assert.match(row.detail, /只读/);
});

test("设置强制 GitHub 但远端是 GitLab：判失败并说明冲突，同时检查 glab", async () => {
  const gitlabGate = {
    ok: true,
    ref: { host: "gitlab", owner: "group/sub", name: "deck" },
    repo: { host: "gitlab", owner: "group/sub", name: "deck", webUrl: "https://gitlab.com/group/sub/deck" },
  };
  const { backend, checks } = await collectEnvChecks(
    "/work/repo",
    probe({
      settings: () => ({ ...baseSettings, backend: "github" }),
      resolveRepo: async () => gitlabGate,
      run: async (command, args) => {
        if (command === "git") return { ok: true, stdout: "git version 2.45.0", stderr: "" };
        if (command === "gh" && args[0] === "--version") return { ok: true, stdout: "gh version 2.60.0", stderr: "" };
        if (command === "gh") return { ok: true, stdout: "Logged in", stderr: "" };
        return { ok: false, stdout: "", stderr: "" };
      },
    }),
  );
  assert.equal(backend, "github");
  const map = byId(checks);
  assert.equal(map.backend.status, "fail");
  assert.match(map.backend.detail, /gitlab/);
  // 实际后端是设置里的 github，所以不去查 glab；先把「设置与远端打架」这一条修好。
  assert.equal(map.glab, undefined);
  assert.equal(map.labels.status, "skip");
});

test("缺标签：逐项列名，并给出可直接复制的第一条创建命令", async () => {
  const { checks } = await collectEnvChecks(
    "/work/repo",
    probe({
      listLabels: async () => ({
        ok: true,
        labels: [{ name: "wayfinder:map", color: "6e7781", description: "" }],
      }),
    }),
  );
  const labels = byId(checks).labels;
  assert.equal(labels.status, "warn");
  assert.match(labels.detail, /wayfinder:task/);
  assert.match(labels.fix, /gh label create "wayfinder:research"/);
  assert.match(labels.fix, /--repo acme\/deck/);
});

test("Node 版本不够：失败而不是警告，因为整个插件跑不起来", async () => {
  const { checks } = await collectEnvChecks("/work/repo", probe({ nodeVersion: "v20.11.1" }));
  const node = byId(checks).node;
  assert.equal(node.status, "fail");
  assert.match(node.detail, /22\.18/);
});

test("后端判定：auto 跟随远端，强制值永远优先（哪怕远端不支持）", () => {
  assert.equal(effectiveBackend("auto", "github"), "github");
  assert.equal(effectiveBackend("auto", "gitlab"), "gitlab");
  assert.equal(effectiveBackend("auto", ""), "local");
  assert.equal(effectiveBackend("auto", "other"), "local");
  assert.equal(effectiveBackend("local", "github"), "local");
  assert.equal(effectiveBackend("gitlab", "github"), "gitlab");
});
