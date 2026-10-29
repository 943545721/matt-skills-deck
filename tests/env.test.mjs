import assert from "node:assert/strict";
import { test } from "node:test";
import { collectEnvChecks, effectiveBackend, inspectWorkspaceProjects } from "../server/env.ts";
import { areasMissingFromStructure, workspacePackagePaths } from "../shared/env.ts";
import { STANDARD_LABELS } from "../shared/labels.ts";

/**
 * 环境检查的职责是「说清楚缺什么、下一步做什么」，不是替用户动手。
 * 用注入的探针测，才不会被跑测试的机器上恰好装了什么影响结论。
 */

const baseSettings = { backend: "auto", refreshSeconds: 60, debugLogging: true, appearance: "auto" };

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
    // 默认没有本地票：`.deck` 整棵树与 `.scratch/` 都不在；需要时由单个用例覆盖。
    exists: async (target) => !target.includes("/.deck") && !target.endsWith("/.scratch"),
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

test("只有 .deck/orchestration.json 不算本地票：编排状态不是票，不许因此报警", async () => {
  const { checks } = await collectEnvChecks(
    "/work/repo",
    probe({
      // `.deck` 本身在（插件写编排状态），但 `.deck/issues/` 与 `.scratch/` 都不在。
      exists: async (target) =>
        target.endsWith("/.scratch") ? false : target.endsWith("/.deck") ? true : !target.includes("/.deck"),
    }),
  );
  const backend = byId(checks).backend;
  assert.equal(backend.status, "ok");
  assert.doesNotMatch(backend.detail, /本地票/);
});

test("GitLab 后端：写能力已接，诊断不再报「只读」", async () => {
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
  assert.equal(row.status, "ok");
  assert.doesNotMatch(row.detail, /只读/);
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
  // 标签集已扩到十个（triage 五角色 + wayfinder 五件）：只有 wayfinder:map 在，其余九个都该点名。
  assert.match(labels.detail, /wayfinder:task/);
  assert.match(labels.detail, /wayfinder:research/);
  assert.match(labels.detail, /ready-for-agent/);
  // 建议命令取缺失清单的第一条：STANDARD_LABELS 的顺序里 bug 排最前。
  assert.match(labels.fix, /gh label create "bug"/);
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

test("容器工作区：诊断列出多个仓库，而不是报「没有仓库」", async () => {
  const listing = {
    ok: true,
    kind: "repos",
    repos: [
      { key: "acme/one", host: "github", owner: "acme", name: "one", webUrl: "https://github.com/acme/one", dir: "/work/ws/one", relDir: "one", readOnly: false },
      { key: "acme/two", host: "gitlab", owner: "acme", name: "two", webUrl: "https://gitlab.com/acme/two", dir: "/work/ws/two", relDir: "two", readOnly: false },
    ],
    defaultKey: null,
    truncated: false,
  };
  const { backend, checks } = await collectEnvChecks("/work/ws", probe({ resolveTargets: async () => listing }));
  const map = byId(checks);
  assert.equal(map.repo.status, "ok");
  assert.match(map.repo.detail, /acme\/one/);
  assert.match(map.repo.detail, /acme\/two/);
  // 多仓库没有唯一的标签集合可查，跳过而不是拿其中一个代表全部。
  assert.equal(map.labels.status, "skip");
  // 混合宿主时按有写能力的一侧报后端，并在详情里说明两个仓库。
  assert.equal(backend, "github");
  assert.match(map.backend.detail, /GitLab/);
});

test("没有识别到仓库：诊断说本地 .deck，而不是一句 no-repo 失败", async () => {
  const listing = {
    ok: true,
    kind: "local",
    repos: [
      { key: "local", host: "local", owner: "", name: "ws", webUrl: null, dir: "/work/ws", relDir: null, readOnly: false },
    ],
    defaultKey: null,
    truncated: false,
  };
  const { backend, checks } = await collectEnvChecks("/work/ws", probe({ resolveTargets: async () => listing }));
  const map = byId(checks);
  assert.equal(map.repo.status, "warn");
  assert.match(map.repo.detail, /\.deck/);
  assert.equal(backend, "local");
});

test("显式后端解析不到仓库：后端行如实报失败，并给出「改回 auto」的修法", async () => {
  const { backend, checks } = await collectEnvChecks(
    "/work/ws",
    probe({
      settings: () => ({ ...baseSettings, backend: "github" }),
      resolveTargets: async () => ({
        ok: false,
        reason: "unsupported-host",
        detail: "设置要求 github，但工作区远端是 gitlab",
      }),
    }),
  );
  const map = byId(checks);
  assert.equal(backend, "github");
  assert.equal(map.repo.status, "fail");
  assert.match(map.repo.fix, /auto/);
  assert.equal(map.backend.status, "fail");
  assert.match(map.backend.detail, /设置要求 github/);
  assert.match(map.backend.fix, /改回 auto/);
});

test("auto 解析失败：后端报 none，不再假装本地可用", async () => {
  const { backend, checks } = await collectEnvChecks(
    "/work/ws",
    probe({
      resolveTargets: async () => ({
        ok: false,
        reason: "unsupported-host",
        detail: "当前远端是 bitbucket，任务板只接了 GitHub / GitLab / 本地 Markdown",
      }),
    }),
  );
  assert.equal(backend, "none");
  assert.equal(byId(checks).backend.status, "fail");
  assert.match(byId(checks).backend.detail, /bitbucket/);
});

// ---------------------------------------------------------------------------
// 项目清单（#6）：配了几个、各自什么后端、哪里不对、是不是跟目录对不上
// ---------------------------------------------------------------------------

const projectsProbe = (overrides = {}) => ({
  listProjects: async () => projectListing(),
  readDir: async (target) => (target.endsWith("/api") ? ["api", "auth", "node_modules"] : null),
  readText: async () => null,
  ...overrides,
});

function projectListing(overrides = {}) {
  return {
    ok: true,
    kind: "v2",
    config: { version: 2, projects: [], warnings: [] },
    error: null,
    projects: [
      {
        key: "api",
        dir: "api",
        repo: "acme/api",
        owner: "backend",
        areas: ["api", "auth"],
        skillsMode: null,
        exists: true,
        resolved: { host: "github", owner: "acme", name: "api", webUrl: "https://github.com/acme/api" },
        problem: null,
      },
      {
        key: "web",
        dir: "apps/web",
        repo: null,
        owner: "frontend",
        areas: [],
        skillsMode: "per-project",
        exists: false,
        resolved: null,
        problem: "目录「apps/web」不存在",
      },
    ],
    scanned: [],
    drift: ["磁盘上有 tool（acme/tool），项目清单里没有它"],
    warnings: [],
    ...overrides,
  };
}

const byProject = (report) => Object.fromEntries(report.projects.map((row) => [row.key, row]));

test("项目清单：列目录、仓库、后端与技能模式，坏掉的项目逐条点名", async () => {
  const report = await inspectWorkspaceProjects("/work/ws", projectsProbe());
  assert.equal(report.kind, "v2");
  assert.equal(report.error, null);
  const rows = byProject(report);
  assert.equal(rows.api.backend, "github");
  assert.equal(rows.api.problem, null);
  assert.deepEqual(rows.api.areas, ["api", "auth"]);
  assert.equal(rows.web.backend, null);
  assert.match(rows.web.problem, /apps\/web/);
  assert.equal(rows.web.skillsMode, "per-project");
  // 磁盘上有、清单里没写的仓库：只在 v2 报。
  assert.deepEqual(report.drift, ["磁盘上有 tool（acme/tool），项目清单里没有它"]);
  assert.deepEqual(report.warnings, []);
});

test("项目清单：area 目录不见了就提示配置可能过期，但不判项目坏", async () => {
  const listing = projectListing();
  listing.projects[0].areas = ["api", "report"];
  const report = await inspectWorkspaceProjects("/work/ws", projectsProbe({ listProjects: async () => listing }));
  const row = byProject(report).api;
  assert.deepEqual(row.areaDrift, ["report"]);
  assert.equal(row.problem, null);
  assert.equal(row.backend, "github");
});

test("项目清单：area 在 package.json workspaces 里也算对得上", async () => {
  const listing = projectListing();
  listing.projects[0].areas = ["admin-web"];
  const report = await inspectWorkspaceProjects(
    "/work/ws",
    projectsProbe({
      listProjects: async () => listing,
      readDir: async () => [],
      readText: async () => JSON.stringify({ workspaces: ["apps/admin-web"] }),
    }),
  );
  assert.deepEqual(byProject(report).api.areaDrift, []);
});

test("项目清单：workspace 声明带通配符时判不了，就不给过期提示", async () => {
  const listing = projectListing();
  listing.projects[0].areas = ["admin-web"];
  const report = await inspectWorkspaceProjects(
    "/work/ws",
    projectsProbe({
      listProjects: async () => listing,
      readDir: async () => [],
      readText: async () => JSON.stringify({ workspaces: ["apps/*"] }),
    }),
  );
  assert.deepEqual(byProject(report).api.areaDrift, []);
});

test("项目清单：旧格式 v1 一句话说明、不产生任何错误与漂移", async () => {
  const listing = projectListing({
    kind: "v1",
    projects: [
      {
        key: "api",
        dir: "api",
        repo: null,
        owner: null,
        areas: [],
        skillsMode: null,
        exists: true,
        resolved: { host: "github", owner: "acme", name: "api", webUrl: "https://github.com/acme/api" },
        problem: null,
      },
    ],
  });
  const report = await inspectWorkspaceProjects("/work/ws", projectsProbe({ listProjects: async () => listing }));
  assert.equal(report.kind, "v1");
  assert.equal(report.error, null);
  assert.deepEqual(report.drift, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.projects.length, 1);
  assert.equal(report.projects[0].problem, null);
  assert.deepEqual(report.projects[0].areaDrift, []);
});

test("项目清单：配置读不出来时报出原文，而不是显示「没有项目」", async () => {
  const listing = projectListing({ kind: "none", error: { reason: "bad-json", detail: "Unexpected token }" }, projects: [], drift: [] });
  const report = await inspectWorkspaceProjects("/work/ws", projectsProbe({ listProjects: async () => listing }));
  assert.equal(report.kind, "none");
  assert.match(report.error, /bad-json/);
  assert.match(report.error, /Unexpected token/);
  assert.deepEqual(report.projects, []);
});

test("workspace 声明解析：数组、packages 对象都认，带通配符标为判不了", () => {
  assert.deepEqual(workspacePackagePaths(null), { paths: [], undecidable: false });
  assert.deepEqual(workspacePackagePaths('{"workspaces":["apps/web"]}'), { paths: ["apps/web"], undecidable: false });
  assert.deepEqual(workspacePackagePaths('{"workspaces":{"packages":["pkg/a"]}}'), { paths: ["pkg/a"], undecidable: false });
  assert.deepEqual(workspacePackagePaths('{"workspaces":["apps/*","lib/x"]}'), { paths: ["lib/x"], undecidable: true });
  // 坏的 package.json 判不了，不拿来当证据。
  assert.deepEqual(workspacePackagePaths("{oops"), { paths: [], undecidable: true });
});

test("area 对目录：同名子目录、workspace 全路径与末段都算命中", () => {
  const structure = { dirs: ["Api", "legacy"], workspacePaths: ["apps/admin-web", "./pkg/core/"] };
  assert.deepEqual(areasMissingFromStructure(["api", "legacy"], structure), []);
  assert.deepEqual(areasMissingFromStructure(["admin-web", "core"], structure), []);
  assert.deepEqual(areasMissingFromStructure(["report"], structure), ["report"]);
  // 空 áreas 不提示：没有清单就没有「过期」可言。
  assert.deepEqual(areasMissingFromStructure([], structure), []);
});
