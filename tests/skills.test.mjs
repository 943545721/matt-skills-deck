import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listBundledSkills, readBundledSkill } from "../server/skills/catalog.ts";
import { parseSkillFrontmatter } from "../server/skills/frontmatter.ts";
import { installSkills, skillState } from "../server/skills/install.ts";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

function tempWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-skills-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("frontmatter 能读出 name 与 description，缺字段时返回 null", () => {
  assert.deepEqual(parseSkillFrontmatter("---\nname: tdd\ndescription: 测试驱动\n---\n正文"), {
    name: "tdd",
    description: "测试驱动",
  });
  assert.deepEqual(parseSkillFrontmatter('---\nname: "qa"\ndescription: \'带引号\'\n---\n'), {
    name: "qa",
    description: "带引号",
  });
  assert.equal(parseSkillFrontmatter("没有头部"), null);
  assert.equal(parseSkillFrontmatter("---\nname: x\n---\n"), null);
});

test("随包的 27 个技能在中英两侧都齐，且目录名与 frontmatter 一致", () => {
  for (const lang of ["en", "zh"]) {
    const skills = listBundledSkills(pluginDir, lang);
    assert.equal(skills.length, 27, `${lang} 侧技能数量应为 27，实际 ${skills.length}`);
    for (const skill of skills) {
      assert.equal(skill.id, skill.name, `${lang}/${skill.id} 的 frontmatter name 与目录名不一致`);
      assert.match(skill.id, /^[a-z0-9][a-z0-9-]*$/);
      assert.ok(skill.description.length > 0);
    }
  }
});

test("详情只按 id 取，非法 id 一律拒绝", () => {
  assert.equal(readBundledSkill(pluginDir, "zh", "tdd")?.id, "tdd");
  assert.equal(readBundledSkill(pluginDir, "zh", "../package"), null);
  assert.equal(readBundledSkill(pluginDir, "zh", "不存在"), null);
});

test("安装写入两侧目录，重复安装跳过，改过内容的文件算冲突不覆盖", () => {
  const workspace = tempWorkspace();
  const skills = listBundledSkills(pluginDir, "zh").slice(0, 1);
  const skill = skills[0];
  assert.ok(skill);

  assert.equal(skillState(skill, workspace), "none");

  const first = installSkills({ skills, workspaceDir: workspace });
  assert.deepEqual(first.written, [skill.id]);
  assert.equal(skillState(skill, workspace), "current");

  const claudeFile = path.join(workspace, ".claude", "skills", skill.id, "SKILL.md");
  const agentsFile = path.join(workspace, ".agents", "skills", skill.id, "SKILL.md");
  assert.equal(readFileSync(claudeFile, "utf8"), readFileSync(skill.file, "utf8"));
  assert.equal(readFileSync(agentsFile, "utf8"), readFileSync(skill.file, "utf8"));

  const second = installSkills({ skills, workspaceDir: workspace });
  assert.deepEqual(second.skipped, [skill.id]);
  assert.deepEqual(second.written, []);

  writeFileSync(claudeFile, "本地改过的版本", "utf8");
  assert.equal(skillState(skill, workspace), "differs");
  const third = installSkills({ skills, workspaceDir: workspace });
  assert.deepEqual(third.conflicts, [skill.id]);
  assert.equal(readFileSync(claudeFile, "utf8"), "本地改过的版本", "冲突时绝不能覆盖用户文件");
});

test("工作区目录必须是已存在的绝对路径", () => {
  const skills = listBundledSkills(pluginDir, "en").slice(0, 1);
  assert.throws(() => installSkills({ skills, workspaceDir: "rel/path" }), /绝对路径/);
  assert.throws(() => installSkills({ skills, workspaceDir: "/不存在的目录-xyz" }), /不存在/);
});
