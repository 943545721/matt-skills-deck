import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { adoptProjectSkill, listProjectSkills } from "../server/skills/adopt.ts";
import { listBundledSkills } from "../server/skills/catalog.ts";
import { pluginSkillFile, writePluginSkill } from "../server/skills/plugin-skills.ts";
import { installSkillDraft, writeSkillDraft } from "../server/skills-draft.ts";

/**
 * 插件的两个方向：新增技能时可选「装进插件包」，项目里自写的技能可以「回收进插件」。
 *
 * 钉住的都是保守的那一半：
 * - 插件包是源码，已有同名但内容不同的文件算冲突，不覆盖；
 * - 两个语言目录都写（外壳按「两侧都在」判断技能完整），另一侧要如实标「待翻译」；
 * - 回收不猜来源：两个目录内容不同就拒绝，不替人挑一份。
 */

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

function tempDir(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `deck-plugin-skills-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 只带 SKILL.md 的最小技能正文。 */
function skillText(id, description = "when to use it") {
  return ["---", `name: ${id}`, `description: ${description}`, "---", "", `# ${id}`, "", "- step one", ""].join("\n");
}

function fakePlugin(tag) {
  const dir = tempDir(tag);
  mkdirSync(path.join(dir, "templates", "skills"), { recursive: true });
  return dir;
}

function fakeWorkspace(tag) {
  const dir = tempDir(tag);
  mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
  return dir;
}

function writeProjectSkill(workspace, root, id, text) {
  const file = path.join(workspace, root, id, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

test("写进插件：两个语言目录都写，另一侧标成待翻译", async () => {
  const plugin = fakePlugin("write");
  const text = skillText("my-skill");
  const result = await writePluginSkill({ pluginDir: plugin, slug: "my-skill", lang: "zh", sourceText: text });
  assert.equal(result.ok, true);
  assert.deepEqual(result.written.sort(), [
    pluginSkillFile(plugin, "en", "my-skill"),
    pluginSkillFile(plugin, "zh", "my-skill"),
  ].sort());
  assert.deepEqual(result.pendingTranslation, ["en"]);
  assert.equal(readFileSync(pluginSkillFile(plugin, "zh", "my-skill"), "utf8"), text);
});

test("写进插件：内容相同算跳过，内容不同算冲突且不覆盖", async () => {
  const plugin = fakePlugin("conflict");
  const text = skillText("my-skill");
  await writePluginSkill({ pluginDir: plugin, slug: "my-skill", lang: "zh", sourceText: text });

  const again = await writePluginSkill({ pluginDir: plugin, slug: "my-skill", lang: "zh", sourceText: text });
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.skipped.length, 2);

  const changed = skillText("my-skill", "a different description");
  const conflicted = await writePluginSkill({ pluginDir: plugin, slug: "my-skill", lang: "zh", sourceText: changed });
  assert.equal(conflicted.conflicts.length, 2);
  assert.equal(readFileSync(pluginSkillFile(plugin, "en", "my-skill"), "utf8"), text);

  const overwritten = await writePluginSkill({
    pluginDir: plugin,
    slug: "my-skill",
    lang: "zh",
    sourceText: changed,
    overwrite: true,
  });
  assert.equal(overwritten.written.length, 2);
  assert.equal(readFileSync(pluginSkillFile(plugin, "zh", "my-skill"), "utf8"), changed);
});

test("写进插件：非法 id 直接拒绝，不拼路径", async () => {
  const plugin = fakePlugin("bad-id");
  const result = await writePluginSkill({ pluginDir: plugin, slug: "../evil", lang: "zh", sourceText: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

test("草稿装进插件：走同一套语言与冲突规则", async () => {
  const workspace = tempDir("draft-ws");
  const plugin = fakePlugin("draft-plugin");
  const draft = await writeSkillDraft({ workspaceDir: workspace, requirement: "把这个仓库的 CI 配置解释给我听", lang: "zh" });
  assert.equal(draft.ok, true);

  // 骨架没通过校验，装不出去——这是刻意的：装一个空骨架等于什么都没做。
  const blocked = await installSkillDraft(workspace, draft.slug, false, { target: "plugin", lang: "zh", pluginDir: plugin });
  assert.equal(blocked.ok, false);

  const file = path.join(workspace, ".deck", "skills-draft", draft.slug, "SKILL.md");
  writeFileSync(
    file,
    [
      "---",
      `name: ${draft.slug}`,
      "description: 解释 CI 配置，说明每一步在做什么",
      "---",
      "",
      "# CI 解释",
      "",
      "## 何时使用",
      "",
      "有人问 CI 为什么这样配的时候。",
      "",
      "## 步骤",
      "",
      "1. 读工作流文件。",
      "2. 逐步解释。",
      "",
      "## 输出",
      "",
      "一段中文说明。",
      "",
      "## 不要做",
      "",
      "- 不要改配置文件。",
      "",
    ].join("\n"),
    "utf8",
  );
  const ok = await installSkillDraft(workspace, draft.slug, false, { target: "plugin", lang: "zh", pluginDir: plugin });
  assert.equal(ok.ok, true);
  assert.equal(ok.target, "plugin");
  assert.deepEqual(ok.pendingTranslation, ["en"]);
  assert.equal(existsSync(pluginSkillFile(plugin, "en", draft.slug)), true);
});

test("回收：只列插件里没有的技能，文件头 name 必须与目录同名", () => {
  const workspace = fakeWorkspace("adopt-list");
  writeProjectSkill(workspace, ".claude/skills", "my-own-skill", skillText("my-own-skill"));
  writeProjectSkill(workspace, ".claude/skills", "broken", skillText("not-broken"));
  const bundled = listBundledSkills(pluginDir, "zh").map((skill) => skill.id);
  const ids = listProjectSkills(workspace, bundled).map((skill) => skill.id);
  assert.deepEqual(ids, ["my-own-skill"]);
});

test("回收：两个目录内容不同就拒绝，不挑一份", async () => {
  const workspace = fakeWorkspace("adopt-split");
  const plugin = fakePlugin("adopt-split-plugin");
  writeProjectSkill(workspace, ".claude/skills", "my-own-skill", skillText("my-own-skill", "one"));
  writeProjectSkill(workspace, ".agents/skills", "my-own-skill", skillText("my-own-skill", "two"));
  const result = await adoptProjectSkill({ workspaceDir: workspace, pluginDir: plugin, id: "my-own-skill", lang: "zh" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "split");
  assert.equal(existsSync(pluginSkillFile(plugin, "zh", "my-own-skill")), false);
});

test("回收：一致的那份写进插件包，另一语言待翻译", async () => {
  const workspace = fakeWorkspace("adopt-ok");
  const plugin = fakePlugin("adopt-ok-plugin");
  const text = skillText("my-own-skill", "项目里写的技能");
  writeProjectSkill(workspace, ".claude/skills", "my-own-skill", text);
  writeProjectSkill(workspace, ".agents/skills", "my-own-skill", text);
  const result = await adoptProjectSkill({ workspaceDir: workspace, pluginDir: plugin, id: "my-own-skill", lang: "zh" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pendingTranslation, ["en"]);
  assert.equal(readFileSync(pluginSkillFile(plugin, "en", "my-own-skill"), "utf8"), text);
});

test("回收：插件里已有同名不同内容的文件算冲突", async () => {
  const workspace = fakeWorkspace("adopt-conflict");
  const plugin = fakePlugin("adopt-conflict-plugin");
  const text = skillText("my-own-skill", "项目里写的技能");
  writeProjectSkill(workspace, ".claude/skills", "my-own-skill", text);
  const before = skillText("my-own-skill", "插件里原本的版本");
  await writePluginSkill({ pluginDir: plugin, slug: "my-own-skill", lang: "zh", sourceText: before });
  const result = await adoptProjectSkill({ workspaceDir: workspace, pluginDir: plugin, id: "my-own-skill", lang: "zh" });
  assert.equal(result.ok, true);
  assert.equal(result.conflicts.length, 2);
  assert.equal(readFileSync(pluginSkillFile(plugin, "zh", "my-own-skill"), "utf8"), before);
});
