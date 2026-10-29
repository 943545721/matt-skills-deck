import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listBundledSkills } from "../server/skills/catalog.ts";
import { installSkills, removeSkills, skillDirs, skillStateAt } from "../server/skills/install.ts";

/**
 * 技能装进**当前项目**，不装到别处。
 *
 * 钉四件事：
 * 1. 目标就是项目里两个客户端各自认的目录（`.claude/skills`、`.agents/skills`），都由程序一起写；
 * 2. 工作区目录不合法就报错，不猜落到哪儿；
 * 3. 卸载只删我们自己写的那一份，人改过的文件原样留着；
 * 4. 状态按目录单独算，界面才不会拿一个「已安装」糊过去。
 */

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

function tempDir(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `deck-skills-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const oneSkill = () => {
  const skills = listBundledSkills(pluginDir, "zh").slice(0, 1);
  assert.ok(skills[0]);
  return skills;
};

test("目标目录：项目里的两个路径，都由程序一起写", () => {
  const workspace = tempDir("ws");
  assert.deepEqual(skillDirs(workspace), [
    { client: "claude", dir: path.join(workspace, ".claude", "skills") },
    { client: "codex", dir: path.join(workspace, ".agents", "skills") },
  ]);
  assert.throws(() => skillDirs("rel/path"), /绝对路径/);
  assert.throws(() => skillDirs("/不存在的目录-xyz"), /不存在/);
});

test("安装只写这个项目，两处目录都写满", () => {
  const workspace = tempDir("ws");
  const [skill] = oneSkill();

  const result = installSkills({ skills: [skill], workspaceDir: workspace });
  assert.deepEqual(result.written, [skill.id]);
  assert.deepEqual(result.targets, [
    path.join(workspace, ".claude", "skills"),
    path.join(workspace, ".agents", "skills"),
  ]);
  assert.equal(
    readFileSync(path.join(workspace, ".claude", "skills", skill.id, "SKILL.md"), "utf8"),
    readFileSync(skill.file, "utf8"),
  );
  assert.equal(
    readFileSync(path.join(workspace, ".agents", "skills", skill.id, "SKILL.md"), "utf8"),
    readFileSync(skill.file, "utf8"),
  );
  assert.deepEqual(readdirSync(workspace).sort(), [".agents", ".claude"], "项目里只多这两个目录");
});

test("状态按目录单独算：一侧装了一侧没装，各自如实报", () => {
  const workspace = tempDir("ws");
  const [skill] = oneSkill();
  const claudeDir = path.join(workspace, ".claude", "skills");
  mkdirSync(path.join(claudeDir, skill.id), { recursive: true });
  writeFileSync(path.join(claudeDir, skill.id, "SKILL.md"), readFileSync(skill.file, "utf8"), "utf8");

  assert.equal(skillStateAt(skill, claudeDir), "current");
  assert.equal(skillStateAt(skill, path.join(workspace, ".agents", "skills")), "none");
});

test("卸载：只删内容一致的那份，人改过的原样留着", () => {
  const workspace = tempDir("ws");
  const [skill] = oneSkill();
  installSkills({ skills: [skill], workspaceDir: workspace });

  const claude = path.join(workspace, ".claude", "skills", skill.id, "SKILL.md");
  const agents = path.join(workspace, ".agents", "skills", skill.id, "SKILL.md");
  writeFileSync(claude, "自己改过的版本", "utf8");

  const result = removeSkills({ skills: [skill], workspaceDir: workspace });
  assert.deepEqual(result.removed, [skill.id], "agents 那一份是我们的，删掉");
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].path, claude);
  assert.equal(readFileSync(claude, "utf8"), "自己改过的版本", "人改过的文件不能删");
  assert.equal(existsSync(agents), false);
  assert.equal(existsSync(path.dirname(agents)), false, "空技能目录顺手收掉");
});

test("卸载：本来就不在的报 missing，不报错", () => {
  const workspace = tempDir("ws");
  const [skill] = oneSkill();
  const result = removeSkills({ skills: [skill], workspaceDir: workspace });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.missing, [skill.id]);
});

test("卸载：技能目录里还有别人的文件时，目录留着", () => {
  const workspace = tempDir("ws");
  const [skill] = oneSkill();
  installSkills({ skills: [skill], workspaceDir: workspace });
  const dir = path.join(workspace, ".claude", "skills", skill.id);
  writeFileSync(path.join(dir, "notes.md"), "别的文件", "utf8");

  const result = removeSkills({ skills: [skill], workspaceDir: workspace });
  assert.deepEqual(result.removed, [skill.id]);
  assert.equal(existsSync(path.join(dir, "SKILL.md")), false, "SKILL.md 删掉了");
  assert.equal(existsSync(path.join(dir, "notes.md")), true, "别的文件不能碰");
  assert.equal(existsSync(dir), true, "目录非空，留着");
});

test("遇到别处装好的同名技能：内容不同就是冲突，不覆盖", () => {
  const workspace = tempDir("ws");
  const [skill] = oneSkill();
  const file = path.join(workspace, ".agents", "skills", skill.id, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "别人装的同名技能", "utf8");

  const result = installSkills({ skills: [skill], workspaceDir: workspace });
  assert.deepEqual(result.conflicts, [skill.id]);
  assert.equal(readFileSync(file, "utf8"), "别人装的同名技能");
  assert.equal(
    existsSync(path.join(workspace, ".claude", "skills", skill.id, "SKILL.md")),
    true,
    "另一侧没有同名文件，照样装上",
  );
});

test("显式覆盖：内容不同的那份被插件版本替换，另一侧不受影响", () => {
  const workspace = tempDir("ws");
  const [skill] = oneSkill();
  const file = path.join(workspace, ".agents", "skills", skill.id, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "别人装的同名技能", "utf8");

  const result = installSkills({ skills: [skill], workspaceDir: workspace, overwrite: true });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.written, [skill.id]);
  assert.equal(readFileSync(file, "utf8"), readFileSync(skill.file, "utf8"));
});
