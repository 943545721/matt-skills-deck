import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MIXED_OPTIONS, classifyWorkspaceShape, surveyPromptText } from "../shared/workspace-shape.ts";
import { parseWorkspaceConfigValue } from "../shared/workspace-projects.ts";
import { detectWorkspaceShape } from "../server/workspace/shape.ts";

/**
 * 工作区自识别。
 *
 * 三种形态各自的判据、以及「人表过态就不再多嘴」这一条，都在这里钉住。
 * 纯判定与磁盘探测分开测：前者证明规则，后者证明凑事实这一步没走偏。
 */

const hasGit = spawnSync("git", ["--version"]).status === 0;

const config = (value) => {
  const parsed = parseWorkspaceConfigValue(value);
  assert.equal(parsed.ok, true, parsed.detail);
  return parsed.config;
};

const repo = (dir, owner, name) => ({ dir, host: "github", owner, name });

test("根目录是仓库、没有别的仓库：单项目，不提示", () => {
  const verdict = classifyWorkspaceShape({ rootIsRepo: true, config: null, repos: [] });
  assert.equal(verdict.shape, "single");
  assert.equal(verdict.prompt, null);
  assert.equal(verdict.acknowledged, false);
});

test("只有一个子仓库：单项目", () => {
  const verdict = classifyWorkspaceShape({ rootIsRepo: false, config: null, repos: [repo("alpha", "acme", "alpha")] });
  assert.equal(verdict.shape, "single");
  assert.match(verdict.reasons[0], /alpha/);
});

test("两个同 owner 的仓库：多项目容器，建议梳理", () => {
  const verdict = classifyWorkspaceShape({
    rootIsRepo: false,
    config: null,
    repos: [repo("api", "acme", "api"), repo("web", "acme", "admin")],
  });
  assert.equal(verdict.shape, "container");
  assert.equal(verdict.prompt.kind, "survey");
  assert.deepEqual(verdict.prompt.options, []);
  assert.ok(verdict.reasons.some((line) => line.includes("acme")));
});

test("owner 不同但仓库名有共同前缀：按同一产品线处理，理由里说明这只是「可能」", () => {
  const verdict = classifyWorkspaceShape({
    rootIsRepo: false,
    config: null,
    repos: [repo("p1", "acme", "kxhyapp.com"), repo("p2", "other", "kxhyapp.com-saas")],
  });
  assert.equal(verdict.shape, "container");
  assert.ok(verdict.reasons.some((line) => line.includes("共同前缀")));
  assert.ok(verdict.reasons.some((line) => line.includes("可能")));
});

test("两个不相关的仓库：不成套，给出三条去处，并标未确认", () => {
  const verdict = classifyWorkspaceShape({
    rootIsRepo: false,
    config: null,
    repos: [repo("alpha", "acme", "alpha"), repo("beta", "other", "beta")],
  });
  assert.equal(verdict.shape, "mixed");
  assert.equal(verdict.prompt.kind, "mixed");
  assert.deepEqual(verdict.prompt.options, [...MIXED_OPTIONS]);
  assert.deepEqual(MIXED_OPTIONS, ["subset", "split", "all-with-source"]);
  assert.ok(verdict.reasons.some((line) => line.startsWith("未确认")));
});

test("共同前缀太短不算关联（不能因为都以 a 开头就合成一套）", () => {
  const verdict = classifyWorkspaceShape({
    rootIsRepo: false,
    config: null,
    repos: [repo("a", "one", "app-a"), repo("b", "two", "app-b")],
  });
  assert.equal(verdict.shape, "mixed");
});

test("配置里写了项目清单：多项目且已表态，不再提示", () => {
  const parsed = config({ version: 2, projects: [{ key: "api", dir: "api" }, { key: "web", dir: "web" }] });
  const verdict = classifyWorkspaceShape({ rootIsRepo: false, config: parsed, repos: [] });
  assert.equal(verdict.shape, "container");
  assert.equal(verdict.acknowledged, true);
  assert.equal(verdict.prompt, null);
});

test("coordination.shape 覆盖自动判断：人说了算，且不再提示", () => {
  const parsed = config({
    version: 2,
    projects: [{ key: "api", dir: "api" }, { key: "web", dir: "web" }],
    coordination: { shape: "mixed", note: "这些就是不一套" },
  });
  const verdict = classifyWorkspaceShape({ rootIsRepo: false, config: parsed, repos: [] });
  assert.equal(verdict.shape, "mixed");
  assert.equal(verdict.acknowledged, true);
  assert.equal(verdict.prompt, null);
  assert.ok(verdict.reasons.some((line) => line.includes("这些就是不一套")));
});

test("v1 配置不触发任何新提示", () => {
  const parsed = config({ repoDir: "alpha" });
  const verdict = classifyWorkspaceShape({
    rootIsRepo: false,
    config: parsed,
    repos: [repo("alpha", "acme", "alpha"), repo("beta", "acme", "beta")],
  });
  // v1 = 人只选了一个仓库，但不等于「这套项目就这么一个」：仍按扫到的仓库判断，
  // 且理由是「同一 owner」，不是因为 v1 文件。
  assert.equal(verdict.shape, "container");
  assert.equal(verdict.acknowledged, false);
});

test("梳理提示词：中英各一份，都说清楚「只给候选、别写配置」", () => {
  const repos = [repo("api", "acme", "api"), repo("web", "acme", "admin")];
  const zh = surveyPromptText({ lang: "zh", shape: "container", repos, projects: [] });
  assert.match(zh, /\/project-survey/);
  assert.match(zh, /\.paseo-deck\.json/);
  assert.match(zh, /不要写/);
  assert.match(zh, /acme\/api/);

  const en = surveyPromptText({ lang: "en", shape: "container", repos, projects: [{ key: "api", dir: "api" }] });
  assert.match(en, /\/project-survey/);
  assert.match(en, /do not write \.paseo-deck\.json/);
  assert.match(en, /api → api/);

  const mixed = surveyPromptText({ lang: "zh", shape: "mixed", repos, projects: [] });
  assert.match(mixed, /三选一/);
});

test("磁盘探测：同 owner 两个仓库判为容器，并带回可粘贴的提示词", { skip: !hasGit }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-shape-"));
  for (const [dir, url] of [
    ["api", "https://github.com/acme/api.git"],
    ["web", "https://github.com/acme/admin.git"],
  ]) {
    const target = path.join(root, dir);
    mkdirSync(target, { recursive: true });
    spawnSync("git", ["init", "-q", target]);
    spawnSync("git", ["-C", target, "remote", "add", "origin", url]);
  }

  const detected = await detectWorkspaceShape(root, "zh");
  assert.equal(detected.shape, "container");
  assert.deepEqual(detected.repos.map((item) => item.dir), ["api", "web"]);
  assert.match(detected.surveyPrompt, /\/project-survey/);
  assert.equal(detected.configError, null);
  assert.equal(detected.truncated, false);
});

test("磁盘探测：不同 owner 的不相关仓库判为不成套，配置坏了要说出来", { skip: !hasGit }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-shape-mixed-"));
  for (const [dir, url] of [
    ["alpha", "https://github.com/acme/alpha.git"],
    ["beta", "https://gitlab.com/other/beta.git"],
  ]) {
    const target = path.join(root, dir);
    mkdirSync(target, { recursive: true });
    spawnSync("git", ["init", "-q", target]);
    spawnSync("git", ["-C", target, "remote", "add", "origin", url]);
  }
  writeFileSync(path.join(root, ".paseo-deck.json"), "{坏");

  const detected = await detectWorkspaceShape(root);
  assert.equal(detected.shape, "mixed");
  assert.equal(detected.configError.reason, "bad-json");
  assert.equal(detected.prompt.options.length, 3);
});

test("磁盘探测：根目录自己是仓库时不误报多项目", { skip: !hasGit }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-shape-single-"));
  spawnSync("git", ["init", "-q", root]);
  spawnSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/solo.git"]);

  const detected = await detectWorkspaceShape(root);
  assert.equal(detected.shape, "single");
  assert.equal(detected.surveyPrompt, null);
});
