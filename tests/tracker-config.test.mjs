import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LABEL_COLORS_KNOWN_VERSION,
  LABEL_COLORS_YAML_REL,
  MAX_CONFIG_FILE_CHARS,
  WORKSPACE_KNOWN_VERSION,
  parseIssueTrackerDeclaration,
  parseLabelColorsDoc,
  parseLabelColorsText,
  parseWorkspace,
  parseWorkspaceText,
  parseYamlSubset,
  planLabelColorsMigration,
  planLabelColorsWrite,
  planWorkspaceMigration,
  readIssueTrackerDeclaration,
  readLabelColorsConfig,
  readLocalTrackerState,
  readWorkspaceConfig,
  stringifyLabelColors,
  stringifyWorkspace,
} from "../server/tracker/config.ts";

/**
 * docs/agents 配置层：受限 YAML、workspace 版本与 source、label-colors 迁移、
 * issue-tracker 声明。断言的重点是「只读不写、迁移只出计划」。
 */

async function makeWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-config-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function put(dir, relative, text) {
  const file = path.join(dir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return file;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const workspaceBody = (overrides = {}) => ({ version: 2, backendId: "markdown", pickedAt: 1760000000000, source: "user", ...overrides });

/* ------------------------------------------------------------------ 受限 YAML */

test("受限 YAML：一层映射、行内对象、引号键、注释与 null", () => {
  const parsed = parseYamlSubset(`# 头部注释
version: 2
backendId: markdown
pickedAt: 1760000000000
source: user
labels:
  bug: d73a4a
  "wayfinder:map": "8b5cf6"
  feature: {"color": "00ff00", "description": "一张 # 号不算注释的地图票"}
inline: {"a": 1, "b": true}
empty:
`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.version, 2);
  assert.equal(parsed.value.backendId, "markdown");
  assert.equal(parsed.value.pickedAt, 1760000000000);
  assert.equal(parsed.value.source, "user");
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.value.labels)), {
    bug: "d73a4a",
    "wayfinder:map": "8b5cf6",
    feature: { color: "00ff00", description: "一张 # 号不算注释的地图票" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.value.inline)), { a: 1, b: true });
  assert.equal(parsed.value.empty, null);
});

test("受限 YAML：顶层 JSON 也照读，坏输入给明确错误", () => {
  const json = parseYamlSubset(JSON.stringify(workspaceBody()));
  assert.equal(json.ok, true);
  assert.equal(json.value.backendId, "markdown");

  const cases = [
    ["", /什么都没有/],
    ["a: 1\na: 2", /重复/],
    ["a:\n  - one", /清单/],
    ["a:\n  b:\n    c: 1", /第二层/],
    ["a: &anchor 1", /锚点/],
    ["a: *anchor", /锚点/],
    ["a:\n\tb: 1", /制表符/],
    ["a: [1, 2]", /清单/],
  ];
  for (const [text, pattern] of cases) {
    const parsed = parseYamlSubset(text);
    assert.equal(parsed.ok, false, text);
    assert.match(parsed.message, pattern, text);
  }
});

test("受限 YAML：64 KiB 上限与别名数量上限先于解析生效", () => {
  const over = parseYamlSubset(`k: ${"x".repeat(MAX_CONFIG_FILE_CHARS)}`);
  assert.equal(over.ok, false);
  assert.equal(over.reason, "oversize");

  const aliases = Array.from({ length: 51 }, (_, index) => `k${index}: *a`).join("\n");
  const many = parseYamlSubset(aliases);
  assert.equal(many.ok, false);
  assert.equal(many.reason, "aliases");
});

/* ------------------------------------------------------------------ workspace */

test("workspace：写出版本 2 模板，读回来同值", () => {
  const encoded = stringifyWorkspace(workspaceBody({ layout: "multi" }));
  assert.equal(encoded.ok, true);
  assert.match(encoded.text, /^# 本文件的注释由插件生成/m);
  assert.match(encoded.text, /^version: 2$/m);
  assert.match(encoded.text, /^backendId: markdown$/m);
  assert.match(encoded.text, /^pickedAt: 1760000000000$/m);
  assert.match(encoded.text, /^source: user$/m);
  assert.match(encoded.text, /^layout: multi$/m);

  const parsed = parseWorkspaceText(encoded.text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { version: 2, backendId: "markdown", pickedAt: 1760000000000, source: "user", layout: "multi" });
  assert.equal(parsed.readonly, false);
});

test("workspace：v1 的 auto 在写出时映射成 v2 的 detected", () => {
  const encoded = stringifyWorkspace(workspaceBody({ version: 1, source: "auto" }));
  assert.equal(encoded.ok, true);
  assert.match(encoded.text, /^version: 2$/m);
  assert.match(encoded.text, /^source: detected$/m);
  assert.doesNotMatch(encoded.text, /source: auto/);
});

test("workspace：未知键拒绝，版本与 source 校验按版本分档", () => {
  assert.equal(parseWorkspaceText("version: 2\nbackendId: markdown\npickedAt: 1\nsource: user\nfoo: bar").reason, "unknown-keys");
  assert.equal(stringifyWorkspace({ ...workspaceBody(), extra: true }).reason, "unknown-keys");
  assert.equal(stringifyWorkspace(workspaceBody({ version: 3 })).reason, "version-newer");
  assert.equal(stringifyWorkspace(workspaceBody({ version: 2, source: "auto" })).reason, "bad-shape");

  const v1 = parseWorkspaceText("version: 1\nbackendId: markdown\npickedAt: 1\nsource: auto");
  assert.equal(v1.ok, true);
  assert.equal(v1.value.source, "auto");
  assert.equal(v1.value.version, 1);
  assert.equal(parseWorkspaceText("version: 2\nbackendId: markdown\npickedAt: 1\nsource: auto").ok, false);

  const newer = parseWorkspaceText("version: 3\nbackendId: markdown\npickedAt: 1\nsource: user\nfuture: true");
  assert.equal(newer.ok, false);
  assert.equal(newer.reason, "unknown-keys");
  const newerWithoutExtra = parseWorkspaceText("version: 3\nbackendId: markdown\npickedAt: 1\nsource: user");
  assert.equal(newerWithoutExtra.ok, true);
  assert.equal(newerWithoutExtra.readonly, true);
  assert.match(newerWithoutExtra.warnings[0], /version-newer/);
  assert.equal(newerWithoutExtra.value.version, 3);

  assert.equal(parseWorkspaceText("version: 0\nbackendId: markdown\npickedAt: 1\nsource: user").ok, false);
  assert.equal(parseWorkspaceText("version: 2\nbackendId: ''\npickedAt: 1\nsource: user").ok, false);
  assert.equal(parseWorkspaceText("version: 2\nbackendId: markdown\npickedAt: -1\nsource: user").ok, false);
  assert.equal(parseWorkspaceText("version: 2\nbackendId: markdown\npickedAt: 1\nsource: user\nlayout: grid").ok, false);
  assert.equal(parseWorkspace(workspaceBody()).ok, true);
  assert.equal(WORKSPACE_KNOWN_VERSION, 2);
});

test("workspace：只有老 JSON 时照读，迁移只出计划不落盘", async (t) => {
  const dir = await makeWorkspace(t);
  const legacy = await put(dir, "docs/agents/workspace.json", JSON.stringify({ version: 1, backendId: "local", pickedAt: 5, source: "auto", layout: "single" }));
  const legacyBefore = await readFile(legacy, "utf8");

  const read = await readWorkspaceConfig(dir);
  assert.equal(read.ok, true);
  assert.equal(read.present, true);
  assert.equal(read.from, "json");
  assert.equal(read.config.source, "auto");
  assert.equal(read.config.version, 1);

  const plan = await planWorkspaceMigration(dir);
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.migrate, true);
  assert.equal(plan.from, "json");
  assert.equal(plan.legacyPath, legacy);
  assert.match(plan.text, /^version: 2$/m);
  assert.match(plan.text, /^source: detected$/m);
  assert.equal(await exists(path.join(dir, "docs/agents/workspace.yaml")), false);
  assert.equal(await readFile(legacy, "utf8"), legacyBefore);

  const reparsed = parseWorkspaceText(plan.text);
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.value.source, "detected");
  assert.equal(reparsed.value.layout, "single");
});

test("workspace：YAML 优先且坏 YAML 不回退老 JSON", async (t) => {
  const dir = await makeWorkspace(t);
  await put(dir, "docs/agents/workspace.json", JSON.stringify(workspaceBody({ version: 1, source: "user" })));
  await put(dir, "docs/agents/workspace.yaml", "version: 2\nbackendId: [bad\n");
  const read = await readWorkspaceConfig(dir);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "parse-failed");

  await put(dir, "docs/agents/workspace.yaml", "version: 2\nbackendId: github\npickedAt: 9\nsource: user\n");
  const yamlRead = await readWorkspaceConfig(dir);
  assert.equal(yamlRead.ok, true);
  assert.equal(yamlRead.from, "yaml");
  assert.equal(yamlRead.config.backendId, "github");
  const plan = await planWorkspaceMigration(dir);
  assert.equal(plan.ok, true);
  assert.equal(plan.migrate, false);
  assert.equal(plan.reason, "yaml-present");
});

test("workspace：两个文件都不在时回 present: false，迁移计划 absent", async (t) => {
  const dir = await makeWorkspace(t);
  const read = await readWorkspaceConfig(dir);
  assert.equal(read.ok, true);
  assert.equal(read.present, false);
  assert.equal(read.from, "none");
  const plan = await planWorkspaceMigration(dir);
  assert.equal(plan.ok, true);
  assert.equal(plan.migrate, false);
  assert.equal(plan.reason, "absent");
});

/* ------------------------------------------------------------------ issue-tracker */

test("issue-tracker：标题声明的优先级是 gitlab > markdown/local > github", () => {
  assert.deepEqual(parseIssueTrackerDeclaration("# Issue tracker: gitlab\n"), {
    backend: "gitlab",
    rawHint: "gitlab",
    confidence: "high",
    reason: "title-gitlab",
  });
  assert.equal(parseIssueTrackerDeclaration("# Issue tracker: markdown\n").backend, "markdown");
  assert.equal(parseIssueTrackerDeclaration("# Issue tracker: local\n").backend, "markdown");
  assert.equal(parseIssueTrackerDeclaration("# Issue tracker: github\n").backend, "github");
  assert.equal(parseIssueTrackerDeclaration("# Issue tracker: github\n# Issue tracker: gitlab\n").backend, "gitlab");
  assert.equal(parseIssueTrackerDeclaration("# Issue tracker: github\n# Issue tracker: markdown\n").backend, "markdown");
});

test("issue-tracker：正文关键词只做低置信兜底，markdown 不靠正文猜", () => {
  const gitlab = parseIssueTrackerDeclaration("用 gitlab 管票");
  assert.equal(gitlab.backend, "gitlab");
  assert.equal(gitlab.confidence, "low");
  assert.equal(gitlab.reason, "keyword-gitlab");

  const github = parseIssueTrackerDeclaration("用 github issues 管票");
  assert.equal(github.backend, "github");
  assert.equal(github.confidence, "low");
  assert.equal(github.reason, "github-template");

  const scratch = parseIssueTrackerDeclaration("票在 .scratch/<feature>/spec.md 里");
  assert.equal(scratch.backend, null);
  assert.equal(scratch.confidence, "none");

  const empty = parseIssueTrackerDeclaration("");
  assert.equal(empty.reason, "empty");
});

test("issue-tracker：读文件与本地后端初始化判定只认显式声明", async (t) => {
  const dir = await makeWorkspace(t);
  const absent = await readIssueTrackerDeclaration(dir);
  assert.equal(absent.ok, true);
  assert.equal(absent.present, false);

  await put(dir, "docs/agents/issue-tracker.md", "# Issue tracker: markdown\n");
  const declaration = await readIssueTrackerDeclaration(dir);
  assert.equal(declaration.ok, true);
  assert.equal(declaration.present, true);
  assert.equal(declaration.declaration.backend, "markdown");

  const byDeclaration = await readLocalTrackerState(dir);
  assert.equal(byDeclaration.ok, true);
  assert.equal(byDeclaration.state.initialized, true);
  assert.equal(byDeclaration.state.declared, "markdown");
  assert.match(byDeclaration.state.reasons.join(" "), /issue-tracker\.md/);

  const second = await makeWorkspace(t);
  await put(second, "docs/agents/workspace.yaml", "version: 2\nbackendId: local\npickedAt: 1\nsource: user\n");
  const byWorkspace = await readLocalTrackerState(second);
  assert.equal(byWorkspace.ok, true);
  assert.equal(byWorkspace.state.initialized, true);
  assert.equal(byWorkspace.state.workspaceBackendId, "local");

  const third = await makeWorkspace(t);
  const none = await readLocalTrackerState(third);
  assert.equal(none.ok, true);
  assert.equal(none.state.initialized, false);
  assert.equal(none.state.declared, null);

  await put(third, "docs/agents/workspace.yaml", "version: 2\nbackendId: [bad\n");
  const broken = await readLocalTrackerState(third);
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "parse-failed");
});

/* ------------------------------------------------------------------ label-colors */

test("label-colors：字符串与对象两种写法往返，冒号标签名也写得回去", () => {
  const text = stringifyLabelColors({
    version: LABEL_COLORS_KNOWN_VERSION,
    colors: {
      bug: "d73a4a",
      "wayfinder:map": "8b5cf6",
      feature: { color: "00ff00", description: "地图票" },
    },
  });
  assert.equal(text.ok, true);
  assert.match(text.text, /^version: 1$/m);
  assert.match(text.text, /^bug: d73a4a$/m);
  assert.match(text.text, /"wayfinder:map": "8b5cf6"/);

  const parsed = parseLabelColorsText(text.text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.colors, {
    bug: "d73a4a",
    "wayfinder:map": "8b5cf6",
    feature: { color: "00ff00", description: "地图票" },
  });
  assert.equal(parsed.readonly, false);
});

test("label-colors：未知字段、危险键、坏版本都明确拒绝", () => {
  assert.equal(parseLabelColorsText("bug:\n  color: d73a4a\n  note: x").reason, "unknown-keys");
  assert.equal(parseLabelColorsText("bug:\n  note: x").reason, "unknown-keys");
  assert.equal(parseLabelColorsText("bug:\n  color: 123").reason, "bad-shape");
  assert.equal(parseLabelColorsText("version: 0\nbug: d73a4a").ok, false);
  assert.equal(parseLabelColorsText("version: 2\nbug: d73a4a").readonly, true);
  assert.equal(parseLabelColorsText("").ok, false);

  const proto = JSON.parse('{"__proto__": "ff0000"}');
  assert.equal(parseLabelColorsDoc(proto).ok, false);
  assert.equal(stringifyLabelColors(proto).ok, false);
  assert.equal(stringifyLabelColors({ version: 2, colors: { bug: "d73a4a" } }).reason, "version-newer");
  assert.equal(stringifyLabelColors({ version: 1, colors: { bug: "d73a4a" }, extra: 1 }).ok, true);
});

test("label-colors：YAML 优先，只有老 JSON 时兼容读，坏 YAML 不回退", async (t) => {
  const dir = await makeWorkspace(t);
  await put(dir, "docs/agents/label-colors.json", JSON.stringify({ bug: "111111" }));
  const fromJson = await readLabelColorsConfig(dir);
  assert.equal(fromJson.ok, true);
  assert.equal(fromJson.present, true);
  assert.equal(fromJson.from, "json");
  assert.equal(fromJson.config.colors.bug, "111111");

  await put(dir, LABEL_COLORS_YAML_REL, "version: 1\nbug: \"222222\"\n");
  const fromYaml = await readLabelColorsConfig(dir);
  assert.equal(fromYaml.ok, true);
  assert.equal(fromYaml.from, "yaml");
  assert.equal(fromYaml.config.colors.bug, "222222");

  await put(dir, LABEL_COLORS_YAML_REL, "version: 1\nbug: [bad\n");
  const broken = await readLabelColorsConfig(dir);
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "parse-failed");
});

test("label-colors：迁移只出计划，不建 YAML、不删 JSON", async (t) => {
  const dir = await makeWorkspace(t);
  const json = await put(dir, "docs/agents/label-colors.json", JSON.stringify({ version: 1, bug: "d73a4a", feature: { color: "00ff00", description: "地图票" } }));
  const before = await readFile(json, "utf8");

  const plan = await planLabelColorsMigration(dir);
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.migrate, true);
  assert.equal(plan.from, "json");
  assert.equal(plan.legacyPath, json);
  assert.match(plan.text, /^version: 1$/m);
  assert.match(plan.text, /^bug: d73a4a$/m);
  assert.equal(await exists(path.join(dir, LABEL_COLORS_YAML_REL)), false);
  assert.equal(await readFile(json, "utf8"), before);

  const parsed = parseLabelColorsText(plan.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.colors.bug, "d73a4a");

  await put(dir, LABEL_COLORS_YAML_REL, "version: 1\nbug: \"222222\"\n");
  const already = await planLabelColorsMigration(dir);
  assert.equal(already.ok, true);
  assert.equal(already.migrate, false);
  assert.equal(already.reason, "yaml-present");
});

test("label-colors：迁移拒绝更新版本的老文件", async (t) => {
  const dir = await makeWorkspace(t);
  await put(dir, "docs/agents/label-colors.json", JSON.stringify({ version: 2, bug: "d73a4a" }));
  const plan = await planLabelColorsMigration(dir);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "readonly");
});

test("label-colors：写入计划要求 YAML 已存在，且不改盘上文件", async (t) => {
  const dir = await makeWorkspace(t);
  const missing = await planLabelColorsWrite(dir, { version: 1, colors: { bug: "00ff00" } });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "invalid");

  const yaml = await put(dir, LABEL_COLORS_YAML_REL, "version: 1\nbug: d73a4a\n");
  const before = await readFile(yaml, "utf8");
  const plan = await planLabelColorsWrite(dir, { version: 1, colors: { bug: "00ff00" } });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.path, yaml);
  assert.match(plan.text, /^bug: "00ff00"$/m);
  assert.equal(await readFile(yaml, "utf8"), before);
});
