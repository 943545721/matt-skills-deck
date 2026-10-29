import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogFor,
  checksById,
  guideMissingOf,
  guideProgress,
  guideState,
  guideStepState,
  guideStepsFor,
  GUIDE_STEPS,
} from "../shared/checks.ts";
import { evaluateChecks, evaluatePredicate } from "../server/checks.ts";
import { STANDARD_LABELS } from "../shared/labels.ts";

/**
 * 检查/引导全在纯函数与注入探测里跑：不碰真实 PATH、网络、用户仓库。
 */

const WORKSPACE = "/tmp/deck-workspace";
const GITHUB_REMOTE = { ok: true, url: "https://github.com/acme/widgets.git" };
const TRACKER_FILE = `${WORKSPACE}/docs/agents/issue-tracker.md`;

const runResult = (ok, stdout = "", stderr = "") => ({ ok, stdout, stderr });

function fakeProbe(overrides = {}) {
  const base = {
    async run(command, args) {
      if (args[0] === "--version") {
        return command === "gh" ? runResult(true, "gh version 2.40.0") : runResult(false, "", "not found");
      }
      if (args[0] === "auth") return runResult(true, "Logged in to github.com");
      if (args[0] === "api") return runResult(true, "acme/widgets\n");
      return runResult(false, "", `unexpected ${command} ${args.join(" ")}`);
    },
    async exists(target) {
      return target === TRACKER_FILE || target === `${WORKSPACE}/.deck`;
    },
    async readDir() {
      return [];
    },
    env() {
      return null;
    },
    homeDir() {
      return "/home/tester";
    },
    async dirWritable() {
      return true;
    },
    async skillInstalled() {
      return true;
    },
    async readRemote() {
      return GITHUB_REMOTE;
    },
    async listLabels() {
      return { ok: true, labels: STANDARD_LABELS.map((label) => ({ name: label.name })) };
    },
    settingsBackend() {
      return "auto";
    },
  };
  return { ...base, ...overrides };
}

function predicateContext(probe, overrides = {}) {
  return { workspaceDir: WORKSPACE, probe, remote: GITHUB_REMOTE, commands: new Map(), ...overrides };
}

const mapOf = (entries) => new Map(entries.map(([id, status]) => [id, { id, status }]));

const GITHUB_CHECKS = ["gh:installed", "gh:authed", "gh:remote", "gh:repoAccess", "gh:labels"];
const GUIDE_TAIL = ["gh:installed", "gh:authed", "gh:remote", "tracker:initialized", "skill:wayfinder"];

test("GitHub 目录是十项：通用 5 + GitHub 5，顺序固定", () => {
  const ids = catalogFor("github").map((item) => item.id);
  assert.deepEqual(ids, [
    "skill:wayfinder",
    "skill:setup-matt-pocock-skills",
    "skill:ask-matt",
    "env:home",
    "tracker:initialized",
    "gh:remote",
    "gh:installed",
    "gh:authed",
    "gh:repoAccess",
    "gh:labels",
  ]);
  assert.equal(ids.length, 10);
});

test("GitLab / 本地 Markdown 各 8 项，未知后端只给通用 5 项", () => {
  assert.deepEqual(
    catalogFor("gitlab").map((item) => item.id),
    ["skill:wayfinder", "skill:setup-matt-pocock-skills", "skill:ask-matt", "env:home", "tracker:initialized", "glab:installed", "glab:authed", "glab:repoAccess"],
  );
  assert.deepEqual(
    catalogFor("markdown").map((item) => item.id),
    ["skill:wayfinder", "skill:setup-matt-pocock-skills", "skill:ask-matt", "env:home", "tracker:initialized", "md:workspace", "md:scratchWritable", "md:containersReadable"],
  );
  assert.equal(catalogFor(null).length, 5);
  assert.deepEqual(catalogFor(null).map((item) => item.id), catalogFor("github").slice(0, 5).map((item) => item.id));
});

test("六步引导按后端过滤，顺序是 DSH 定版", () => {
  assert.deepEqual(guideStepsFor("github").map((step) => step.id), ["selection:backendSelected", ...GUIDE_TAIL]);
  assert.deepEqual(guideStepsFor("gitlab").map((step) => step.id), ["selection:backendSelected", "tracker:initialized", "skill:wayfinder"]);
  assert.deepEqual(guideStepsFor("markdown").map((step) => step.id), ["selection:backendSelected", "tracker:initialized", "skill:wayfinder"]);
  assert.deepEqual(guideStepsFor(null), []);
  assert.equal(GUIDE_STEPS.length, 6);
  assert.equal(GUIDE_STEPS.find((step) => step.id === "gh:remote").blocksSetup, true);
});

test("引导状态：全部完成时 current 为 null，gate 没有服务端结果就跳过", () => {
  const results = mapOf(GITHUB_CHECKS.map((id) => [id, "ok"]).concat([
    ["tracker:initialized", "ok"],
    ["skill:wayfinder", "ok"],
    ["skill:setup-matt-pocock-skills", "ok"],
    ["skill:ask-matt", "ok"],
  ]));
  const state = guideState(results, "github");
  assert.equal(state.current, null);
  assert.deepEqual(state.done, GUIDE_TAIL);
  assert.deepEqual(state.blocked, []);
  assert.deepEqual(guideProgress(state, "github"), { done: 5, total: 5, percent: 100 });

  const withGate = guideState(mapOf([["selection:backendSelected", "ok"], ...GITHUB_CHECKS.map((id) => [id, "ok"]), ["tracker:initialized", "ok"], ["skill:wayfinder", "ok"], ["skill:setup-matt-pocock-skills", "ok"], ["skill:ask-matt", "ok"]]), "github");
  assert.deepEqual(withGate.done, ["selection:backendSelected", ...GUIDE_TAIL]);
});

test("引导状态：第一个没完成的步骤是 current，后面的未完成步骤进 blocked", () => {
  const results = mapOf([["gh:installed", "fail"], ["gh:authed", "fail"], ["gh:remote", "ok"], ["tracker:initialized", "ok"], ["skill:wayfinder", "ok"], ["skill:setup-matt-pocock-skills", "ok"], ["skill:ask-matt", "ok"]]);
  const state = guideState(results, "github");
  assert.equal(state.current, "gh:installed");
  assert.deepEqual(state.blocked, ["gh:authed"]);
  // 后面的步骤确实已经完成，不能因为前面卡住就改口说没完成。
  assert.deepEqual(state.done, ["gh:remote", "tracker:initialized", "skill:wayfinder"]);
  assert.deepEqual(guideProgress(state, "github"), { done: 3, total: 5, percent: 60 });
});

test("引导状态：没有结果不等于通过；gate 自己失败时排在最前", () => {
  const empty = guideState(new Map(), "github");
  assert.equal(empty.current, "gh:installed");
  assert.deepEqual(empty.done, []);
  assert.deepEqual(empty.blocked, ["gh:authed", "gh:remote", "tracker:initialized", "skill:wayfinder"]);

  const gateFail = guideState(mapOf([["selection:backendSelected", "fail"], ...GITHUB_CHECKS.map((id) => [id, "ok"])]), "github");
  assert.equal(gateFail.current, "selection:backendSelected");
  // GitHub 的三步已经 ok，真正还没完成的只有后面两步。
  assert.deepEqual(gateFail.blocked, ["tracker:initialized", "skill:wayfinder"]);

  const gitlabEmpty = guideState(new Map(), "gitlab");
  assert.equal(gitlabEmpty.current, "tracker:initialized");
  assert.deepEqual(gitlabEmpty.blocked, ["skill:wayfinder"]);
});

test("单步状态：ok 才算 done，warn/unknown 是 pending，没结果是 absent", () => {
  const skill = GUIDE_STEPS.find((step) => step.id === "skill:wayfinder");
  const ids = ["skill:wayfinder", "skill:setup-matt-pocock-skills", "skill:ask-matt"];
  assert.equal(guideStepState(skill, mapOf(ids.map((id) => [id, "ok"]))), "done");
  assert.equal(guideStepState(skill, mapOf(ids.map((id) => [id, "warn"]))), "pending");
  assert.equal(guideStepState(skill, mapOf(ids.map((id) => [id, "unknown"]))), "pending");
  assert.equal(guideStepState(skill, mapOf([[ids[0], "ok"], [ids[1], "fail"], [ids[2], "ok"]])), "fail");
  // 只有一项有结论、其余缺失：证据不足，不能当 done。
  assert.equal(guideStepState(skill, mapOf([[ids[0], "ok"]])), "pending");
  assert.equal(guideStepState(skill, new Map()), "absent");
  assert.equal(guideStepState(null, new Map()), "absent");
});

test("登录步骤问不出结论时改成重查，不注入登录指引", () => {
  const auth = GUIDE_STEPS.find((step) => step.id === "gh:authed");
  const skill = GUIDE_STEPS.find((step) => step.id === "skill:wayfinder");
  assert.deepEqual(guideMissingOf(auth, mapOf([["gh:authed", "unknown"]])), { type: "refresh", target: "chain", label: "重新检查" });
  assert.equal(guideMissingOf(auth, mapOf([["gh:authed", "fail"]])).prompt, "ghAuthLogin");
  assert.equal(guideMissingOf(skill, mapOf([["skill:wayfinder", "fail"]])).prompt, "installSkills");
  assert.equal(guideMissingOf(null, new Map()), null);
});

test("GitHub 全绿：十项检查通过，引导只剩服务端不收录的后端选择门控", async () => {
  const report = await evaluateChecks({ workspaceDir: WORKSPACE }, fakeProbe());
  assert.equal(report.backend, "github");
  assert.equal(report.checks.length, 10);
  assert.deepEqual(report.checks.filter((check) => check.status !== "ok"), []);
  assert.equal(report.checks.some((check) => check.action !== undefined), false);
  assert.equal(report.guide.current, null);
  assert.deepEqual(report.guide.done, GUIDE_TAIL);
  assert.equal(typeof report.checkedAt, "string");
  assert.equal(checksById(report.checks).size, 10);
});

test("技能缺失：三项都 fail 并带安装动作，引导停在技能步骤", async () => {
  const report = await evaluateChecks({ workspaceDir: WORKSPACE }, fakeProbe({ skillInstalled: async () => false }));
  const failing = report.checks.filter((check) => check.status === "fail");
  assert.equal(failing.length, 3);
  for (const check of failing) {
    assert.equal(check.action[0].type, "form");
    assert.equal(check.action[0].submitAction.prompt, "installSkills");
  }
  assert.equal(report.guide.current, "skill:wayfinder");
  assert.deepEqual(report.guide.blocked, []);
});

test("gh 没装：安装项 fail、登录项 unknown，引导停在安装步骤", async () => {
  const probe = fakeProbe({
    async run(command, args) {
      if (args[0] === "--version") return command === "gh" ? runResult(false, "", "not found") : runResult(false, "", "not found");
      return runResult(false, "", "should not run");
    },
  });
  const report = await evaluateChecks({ workspaceDir: WORKSPACE }, probe);
  assert.equal(report.checks.find((check) => check.id === "gh:installed").status, "fail");
  assert.equal(report.checks.find((check) => check.id === "gh:authed").status, "unknown");
  assert.equal(report.guide.current, "gh:installed");
  assert.deepEqual(report.guide.blocked, ["gh:authed"]);
});

test("登录态：网络超时说 unknown，明确未登录才是 fail", async () => {
  const offline = fakeProbe({
    async run(command, args) {
      if (args[0] === "--version") return command === "gh" ? runResult(true, "gh version 2.40.0") : runResult(false, "", "not found");
      if (args[0] === "auth") return runResult(false, "", "error connecting to api.github.com: dial tcp: i/o timeout");
      return runResult(false, "", "unexpected");
    },
  });
  const unknown = await evaluatePredicate({ kind: "preflight", id: "ghAuth" }, predicateContext(offline));
  assert.equal(unknown.status, "unknown");
  assert.match(unknown.detail, /没问出结论/);

  const signedOut = fakeProbe({
    async run(command, args) {
      if (args[0] === "--version") return command === "gh" ? runResult(true, "gh version 2.40.0") : runResult(false, "", "not found");
      if (args[0] === "auth") return runResult(false, "", "You are not logged into any GitHub hosts.");
      return runResult(false, "", "unexpected");
    },
  });
  const failed = await evaluatePredicate({ kind: "preflight", id: "ghAuth" }, predicateContext(signedOut));
  assert.equal(failed.status, "fail");
});

test("检查详情不打印环境变量值，也不会把命令 argv 当错误信息", async () => {
  const probe = fakeProbe({ env: (key) => (key === "GITHUB_TOKEN" ? "ghp_secret_value" : null) });
  const ctx = predicateContext(probe);
  const ok = await evaluatePredicate({ kind: "primitive", primitive: "env", key: "GITHUB_TOKEN" }, ctx);
  assert.equal(ok.status, "ok");
  assert.equal(ok.detail.includes("ghp_secret_value"), false);
  assert.match(ok.detail, /GITHUB_TOKEN/);

  const missing = await evaluatePredicate({ kind: "primitive", primitive: "env", key: "MISSING_KEY" }, ctx);
  assert.equal(missing.status, "fail");
});

test("六种原语：commandExists / fileExists / skillProbe / homeDir / dirWritable", async () => {
  const probe = fakeProbe();
  const ctx = predicateContext(probe);
  assert.equal((await evaluatePredicate({ kind: "primitive", primitive: "commandExists", command: "gh" }, ctx)).status, "ok");
  assert.equal((await evaluatePredicate({ kind: "primitive", primitive: "commandExists", command: "glab" }, ctx)).status, "fail");
  assert.equal((await evaluatePredicate({ kind: "primitive", primitive: "fileExists", path: "docs/agents/issue-tracker.md" }, ctx)).status, "ok");
  assert.equal((await evaluatePredicate({ kind: "primitive", primitive: "fileExists", path: "missing.md" }, ctx)).status, "fail");
  assert.equal((await evaluatePredicate({ kind: "primitive", primitive: "dirWritable", path: "." }, ctx)).status, "ok");
  assert.equal((await evaluatePredicate({ kind: "primitive", primitive: "homeDir" }, ctx)).status, "ok");
  assert.equal((await evaluatePredicate({ kind: "primitive", primitive: "fileExists", path: "x.md" }, predicateContext(probe, { workspaceDir: undefined }))).status, "unknown");

  let seen = null;
  const recording = fakeProbe({ async skillInstalled(skill, workspaceDir) { seen = { skill, workspaceDir }; return true; } });
  assert.equal((await evaluatePredicate({ kind: "primitive", primitive: "skillProbe", skill: "wayfinder" }, predicateContext(recording))).status, "ok");
  assert.deepEqual(seen, { skill: "wayfinder", workspaceDir: WORKSPACE });
});

test("后端探测：设置优先，其次按远端；问不到远端就落到本地 Markdown", async () => {
  const local = await evaluateChecks({ workspaceDir: WORKSPACE }, fakeProbe({ settingsBackend: () => "local" }));
  assert.equal(local.backend, "markdown");
  assert.equal(local.checks.length, 8);
  assert.deepEqual(local.checks.slice(5).map((check) => check.id), ["md:workspace", "md:scratchWritable", "md:containersReadable"]);

  const noRemote = await evaluateChecks({ workspaceDir: WORKSPACE }, fakeProbe({ readRemote: async () => ({ ok: false, reason: "no-remote", detail: "没有远端" }) }));
  assert.equal(noRemote.backend, "markdown");
  assert.equal(noRemote.checks.find((check) => check.id === "tracker:initialized").status, "ok");

  const gitlab = await evaluateChecks({ workspaceDir: WORKSPACE }, fakeProbe({ settingsBackend: () => "gitlab" }));
  assert.equal(gitlab.backend, "gitlab");
  assert.equal(gitlab.checks.length, 8);
  assert.equal(gitlab.checks.find((check) => check.id === "glab:installed").status, "fail");
  assert.equal(gitlab.checks.find((check) => check.id === "glab:authed").status, "unknown");
  assert.equal(gitlab.checks.find((check) => check.id === "glab:repoAccess").status, "fail");

  const forced = await evaluateChecks({ workspaceDir: WORKSPACE, backend: "markdown" }, fakeProbe());
  assert.equal(forced.backend, "markdown");
});

test("标签缺项是 warn 不是 fail，并给出补全动作", async () => {
  const probe = fakeProbe({ listLabels: async () => ({ ok: true, labels: [{ name: STANDARD_LABELS[0].name }] }) });
  const report = await evaluateChecks({ workspaceDir: WORKSPACE }, probe);
  const labels = report.checks.find((check) => check.id === "gh:labels");
  assert.equal(labels.status, "warn");
  assert.match(labels.detail, new RegExp(`缺少 ${STANDARD_LABELS.length - 1} 个标签`));
  assert.equal(labels.action[0].prompt, "ensureLabels");
  assert.equal(report.guide.current, null);
});

test("git 缺失：gh:remote 直接报 git-missing，不伪装成「没有远端」", async () => {
  const report = await evaluateChecks({ workspaceDir: WORKSPACE }, fakeProbe({
    settingsBackend: () => "github",
    readRemote: async () => ({ ok: false, reason: "git-missing", detail: "没有找到 git 命令：装好 git 并确认它在 PATH 里" }),
  }));
  const remote = report.checks.find((check) => check.id === "gh:remote");
  assert.equal(remote.status, "fail");
  assert.match(remote.detail, /git/);
  assert.equal(report.checks.find((check) => check.id === "gh:repoAccess").status, "fail");
  assert.equal(report.checks.find((check) => check.id === "gh:labels").status, "fail");
});

test("仓库读不到时 gh:repoAccess 如实报错，不猜通过", async () => {
  const probe = fakeProbe({
    async run(command, args) {
      if (args[0] === "--version") return runResult(true, "gh version 2.40.0");
      if (args[0] === "auth") return runResult(true, "Logged in");
      if (args[0] === "api") return runResult(false, "", "HTTP 404: Not Found");
      return runResult(false, "", "unexpected");
    },
  });
  const report = await evaluateChecks({ workspaceDir: WORKSPACE }, probe);
  const access = report.checks.find((check) => check.id === "gh:repoAccess");
  assert.equal(access.status, "fail");
  assert.match(access.detail, /HTTP 404/);
});

test("同一次评估里 gh 可用性只问一次", async () => {
  let versionCalls = 0;
  const base = fakeProbe();
  const probe = fakeProbe({
    async run(command, args) {
      if (args[0] === "--version") versionCalls += 1;
      return base.run(command, args);
    },
  });
  await evaluateChecks({ workspaceDir: WORKSPACE }, probe);
  assert.equal(versionCalls, 1);
});

test("本地 Markdown：可写探测优先已存在的数据目录，其次工作区根", async () => {
  const probe = fakeProbe({
    settingsBackend: () => "local",
    async exists(target) {
      if (target === WORKSPACE) return true;
      if (target === `${WORKSPACE}/.scratch`) return true;
      return false;
    },
    async readDir() {
      return [];
    },
    async dirWritable() {
      return true;
    },
  });
  const report = await evaluateChecks({ workspaceDir: WORKSPACE }, probe);
  const scratch = report.checks.find((check) => check.id === "md:scratchWritable");
  assert.equal(scratch.status, "ok");
  assert.match(scratch.detail, /\.scratch 可写/);
  assert.equal(report.checks.find((check) => check.id === "md:workspace").status, "ok");
  assert.equal(report.checks.find((check) => check.id === "md:containersReadable").detail, "1 个容器目录可读");

  const unwritable = await evaluateChecks({ workspaceDir: WORKSPACE }, fakeProbe({ settingsBackend: () => "local", dirWritable: async () => false, exists: async (target) => target === WORKSPACE }));
  assert.equal(unwritable.checks.find((check) => check.id === "md:scratchWritable").status, "fail");
});
