import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { adoptProjectSkill, listProjectSkills } from "../server/skills/adopt.ts";
import { listBundledSkills } from "../server/skills/catalog.ts";
import { installSkills, removeSkills, skillState } from "../server/skills/install.ts";
import { pluginSkillFile, writePluginSkill } from "../server/skills/plugin-skills.ts";

/**
 * 多文件技能：`SKILL.md` + `references/` + `examples/`。
 *
 * 上游常见这种形态（ste-zh 就是），正文里的相对链接指向附件。
 * 只拷主文件会让链接指空，所以安装、状态、卸载、回收都按整棵目录走。
 */

const tempDirs = [];

function tempDir(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `deck-skill-tree-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function skillText(id, description = "when to use it") {
  return ["---", `name: ${id}`, `description: ${description}`, "---", "", `# ${id}`, ""].join("\n");
}

function writeFile(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

/** 插件包里放一份带附件的技能，返回 { plugin, skill }。 */
function fakePluginWithSkill(tag, id = "multi-skill") {
  const plugin = tempDir(tag);
  const root = path.join(plugin, "templates", "skills", "zh", id);
  writeFile(path.join(root, "SKILL.md"), skillText(id));
  writeFile(path.join(root, "references", "terms.md"), "固定译法");
  writeFile(path.join(root, "examples", "demo.md"), "示例");
  const skill = listBundledSkills(plugin, "zh").find((entry) => entry.id === id);
  assert.ok(skill, "多文件技能应能列出来");
  return { plugin, skill, root };
}

function workspace(tag) {
  const dir = tempDir(tag);
  mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
  return dir;
}

test("安装：附件一起装进两个目录，状态判 current", () => {
  const { skill } = fakePluginWithSkill("install");
  const ws = workspace("install-ws");
  const result = installSkills({ skills: [skill], workspaceDir: ws });
  assert.deepEqual(result.written, [skill.id]);
  assert.equal(skillState(skill, ws), "current");
  for (const root of [".claude", ".agents"]) {
    const base = path.join(ws, root, "skills", skill.id);
    assert.equal(readFileSync(path.join(base, "references", "terms.md"), "utf8"), "固定译法");
    assert.equal(readFileSync(path.join(base, "examples", "demo.md"), "utf8"), "示例");
  }
});

test("状态：只改附件也算 differs；不覆盖时整份技能算冲突", () => {
  const { skill } = fakePluginWithSkill("differs");
  const ws = workspace("differs-ws");
  installSkills({ skills: [skill], workspaceDir: ws });
  const attachment = path.join(ws, ".claude", "skills", skill.id, "references", "terms.md");
  writeFileSync(attachment, "本地改过", "utf8");

  assert.equal(skillState(skill, ws), "differs");
  const again = installSkills({ skills: [skill], workspaceDir: ws });
  assert.deepEqual(again.conflicts, [skill.id]);
  assert.equal(readFileSync(attachment, "utf8"), "本地改过", "冲突时不覆盖，也不写半份");

  const overwritten = installSkills({ skills: [skill], workspaceDir: ws, overwrite: true });
  assert.deepEqual(overwritten.written, [skill.id]);
  assert.equal(readFileSync(attachment, "utf8"), "固定译法");
  assert.equal(skillState(skill, ws), "current");
});

test("状态：用户自己放的多余文件不影响 current", () => {
  const { skill } = fakePluginWithSkill("extra");
  const ws = workspace("extra-ws");
  installSkills({ skills: [skill], workspaceDir: ws });
  writeFile(join(ws, ".claude", "skills", skill.id, "notes.md"), "我的笔记");
  assert.equal(skillState(skill, ws), "current");
});

test("卸载：附件与空子目录一并收掉，别人的文件留着", () => {
  const { skill } = fakePluginWithSkill("remove");
  const ws = workspace("remove-ws");
  installSkills({ skills: [skill], workspaceDir: ws });
  const base = path.join(ws, ".claude", "skills", skill.id);
  writeFile(path.join(base, "notes.md"), "我的笔记");

  const result = removeSkills({ skills: [skill], workspaceDir: ws });
  assert.deepEqual(result.removed, [skill.id]);
  assert.equal(existsSync(path.join(base, "references")), false, "空子目录要收掉");
  assert.equal(existsSync(path.join(base, "examples")), false);
  assert.equal(readFileSync(path.join(base, "notes.md"), "utf8"), "我的笔记");
  assert.equal(existsSync(path.join(ws, ".agents", "skills", skill.id)), false);
});

test("回收：附件写进插件包的两个语言目录", async () => {
  const ws = workspace("adopt-tree-ws");
  const plugin = tempDir("adopt-tree-plugin");
  const text = skillText("my-own-skill");
  for (const root of [".claude", ".agents"]) {
    writeFile(path.join(ws, root, "skills", "my-own-skill", "SKILL.md"), text);
    writeFile(path.join(ws, root, "skills", "my-own-skill", "references", "terms.md"), "固定译法");
  }
  const result = await adoptProjectSkill({ workspaceDir: ws, pluginDir: plugin, id: "my-own-skill", lang: "zh" });
  assert.equal(result.ok, true);
  for (const lang of ["zh", "en"]) {
    const target = path.join(plugin, "templates", "skills", lang, "my-own-skill", "references", "terms.md");
    assert.equal(readFileSync(target, "utf8"), "固定译法");
    assert.equal(readFileSync(pluginSkillFile(plugin, lang, "my-own-skill"), "utf8"), text);
  }
});

test("回收：只有附件不同也判 split，不替人挑一份", async () => {
  const ws = workspace("adopt-split-tree");
  const plugin = tempDir("adopt-split-tree-plugin");
  const text = skillText("my-own-skill");
  writeFile(path.join(ws, ".claude", "skills", "my-own-skill", "SKILL.md"), text);
  writeFile(path.join(ws, ".agents", "skills", "my-own-skill", "SKILL.md"), text);
  writeFile(path.join(ws, ".claude", "skills", "my-own-skill", "references", "terms.md"), "一");
  writeFile(path.join(ws, ".agents", "skills", "my-own-skill", "references", "terms.md"), "二");

  const listed = listProjectSkills(ws, []).find((entry) => entry.id === "my-own-skill");
  assert.equal(listed?.split, true);
  const result = await adoptProjectSkill({ workspaceDir: ws, pluginDir: plugin, id: "my-own-skill", lang: "zh" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "split");
});

test("写进插件：附属文件路径不能跳出技能目录", async () => {
  const plugin = tempDir("unsafe-rel");
  const result = await writePluginSkill({
    pluginDir: plugin,
    slug: "my-skill",
    lang: "zh",
    sourceText: skillText("my-skill"),
    extraFiles: [{ rel: "../evil.md", data: Buffer.from("x") }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

function join(...parts) {
  return path.join(...parts);
}
