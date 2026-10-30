import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listBundledSkills, readBundledSkill } from "../server/skills/catalog.ts";
import { parseSkillFrontmatter } from "../server/skills/frontmatter.ts";
import { installSkills, skillDirs, skillState } from "../server/skills/install.ts";
import { installWorkspaceSkills, skillsMatrix } from "../server/skills/workspace.ts";
import { makeSkill, tempRoot, workspaceWith, writeLocalSkill } from "./helpers/skill-fixtures.mjs";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

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

test("随包的 31 个技能在中英两侧都齐，且目录名与 frontmatter 一致", () => {
  for (const lang of ["en", "zh"]) {
    const skills = listBundledSkills(pluginDir, lang);
    assert.equal(skills.length, 31, `${lang} 侧技能数量应为 31，实际 ${skills.length}`);
    for (const skill of skills) {
      assert.equal(skill.id, skill.name, `${lang}/${skill.id} 的 frontmatter name 与目录名不一致`);
      assert.match(skill.id, /^[a-z0-9][a-z0-9-]*$/);
      assert.ok(skill.description.length > 0);
    }
  }
});

test("legacy-issue-intake：中英都在，且保留只读、批准、幂等三条底线", () => {
  for (const lang of ["zh", "en"]) {
    const skill = readBundledSkill(pluginDir, lang, "legacy-issue-intake");
    assert.ok(skill, `${lang} 缺 legacy-issue-intake`);
    assert.ok(skill.description.length <= 200, `${lang} 描述过长：${skill.description.length}`);
  }
  const zh = readFileSync(path.join(pluginDir, "templates/skills/zh/legacy-issue-intake/SKILL.md"), "utf8");
  for (const needle of ["只读", "批准", "幂等键", "未移动", "parentKey", "wayfinder:", "60,000 字节", "5 分钟窗口"]) {
    assert.match(zh, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const en = readFileSync(path.join(pluginDir, "templates/skills/en/legacy-issue-intake/SKILL.md"), "utf8");
  for (const needle of ["Read-only", "approval", "Idempotency key", "not moved", "parentKey", "wayfinder:", "60,000 bytes", "5-minute window"]) {
    assert.match(en, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("详情只按 id 取，非法 id 一律拒绝", () => {
  assert.equal(readBundledSkill(pluginDir, "zh", "tdd")?.id, "tdd");
  assert.equal(readBundledSkill(pluginDir, "zh", "../package"), null);
  assert.equal(readBundledSkill(pluginDir, "zh", "不存在"), null);
});

test("安装写入项目里的两个目录，重复安装跳过，改过内容的文件算冲突不覆盖", () => {
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
  assert.throws(() => skillDirs(""), /绝对路径/);
});

/* ───────────────────────── 技能矩阵（项目 × 客户端）───────────────────────── */

const trackDir = (dir) => {
  tempDirs.push(dir);
  return dir;
};

const matrixFixtures = () => {
  const source = trackDir(tempRoot("src"));
  return [makeSkill(source, "ste", { "references/terminology.md": "术语表\n" }), makeSkill(source, "tdd")];
};

const cellOf = (row, client) => {
  const cell = row.cells.find((entry) => entry.client === client);
  assert.ok(cell, `${row.key} 缺 ${client} 这一格`);
  return cell;
};

test("矩阵：一行一个项目、一列一个客户端，装齐的一致，没装的写未安装", async () => {
  const workspace = trackDir(workspaceWith([{ key: "web", dir: "apps/web" }, { key: "api", dir: "apps/api" }]));
  const skills = matrixFixtures();
  // web 装齐，api 一份都没装。
  await installWorkspaceSkills({ skills, workspaceDir: path.join(workspace, "apps", "web"), workspaceMode: "per-project" });

  const matrix = await skillsMatrix({ skills, workspaceDir: workspace, workspaceMode: "per-project" });
  assert.equal(matrix.workspaceMode, "per-project");
  assert.deepEqual(matrix.rows.map((row) => row.key), ["web", "api"]);

  const web = matrix.rows[0];
  assert.equal(web.mode, "per-project");
  assert.equal(web.modeSource, "workspace");
  assert.equal(web.exists, true);
  assert.deepEqual(web.cells.map((cell) => cell.client), ["claude", "codex"]);
  for (const client of ["claude", "codex"]) {
    const cell = cellOf(web, client);
    assert.equal(cell.status, "current");
    assert.equal(cell.current, 2);
    assert.equal(cell.total, 2);
    assert.deepEqual(cell.differs, []);
    assert.deepEqual(cell.missing, []);
  }

  const api = matrix.rows[1];
  for (const client of ["claude", "codex"]) {
    const cell = cellOf(api, client);
    assert.equal(cell.status, "none", "一份都没有就是「未安装」，不留空白");
    assert.equal(cell.current, 0);
    assert.deepEqual(cell.missing, ["ste", "tdd"]);
  }
});

test("矩阵：改过模板后一眼看出哪个项目过期、哪个项目缺技能", async () => {
  const workspace = trackDir(workspaceWith([{ key: "web", dir: "apps/web" }, { key: "api", dir: "apps/api" }]));
  const skills = matrixFixtures();
  const webDir = path.join(workspace, "apps", "web");
  const apiDir = path.join(workspace, "apps", "api");

  await installWorkspaceSkills({ skills, workspaceDir: webDir, workspaceMode: "per-project" });
  // api 只装了 ste：另一份 tdd 缺着。
  await installWorkspaceSkills({ skills: [skills[0]], workspaceDir: apiDir, workspaceMode: "per-project" });
  // web 的 Claude 那份被人改回旧版本：过期。
  writeFileSync(path.join(webDir, ".claude", "skills", "ste", "SKILL.md"), "旧版本", "utf8");

  const matrix = await skillsMatrix({ skills, workspaceDir: workspace, workspaceMode: "per-project" });
  const web = matrix.rows[0];
  const stale = cellOf(web, "claude");
  assert.equal(stale.status, "differs");
  assert.deepEqual(stale.differs, ["ste"]);
  assert.equal(cellOf(web, "codex").status, "current", "另一侧没被改，仍是一致");

  const api = matrix.rows[1];
  const partial = cellOf(api, "claude");
  assert.equal(partial.status, "missing");
  assert.deepEqual(partial.missing, ["tdd"]);
  assert.equal(partial.current, 1);
});

test("矩阵：统一模式全部更新后所有格回到 current，并留下可还原的备份", async () => {
  const workspace = trackDir(workspaceWith([{ key: "web", dir: "apps/web" }, { key: "api", dir: "apps/api" }]));
  const skills = matrixFixtures();
  const webDir = path.join(workspace, "apps", "web");
  await installWorkspaceSkills({ skills, workspaceDir: webDir, workspaceMode: "per-project" });
  writeFileSync(path.join(webDir, ".claude", "skills", "ste", "SKILL.md"), "旧版本", "utf8");
  writeLocalSkill(webDir, ".claude", "mine", "自写技能");

  const report = await installWorkspaceSkills({ skills, workspaceDir: workspace, workspaceMode: "unified" });
  for (const row of report.projects) {
    assert.equal(row.status, "ok");
  }
  const webBackup = report.projects[0].backupDir;
  assert.ok(webBackup, "web 原来有技能目录，必须留下备份");
  assert.ok(existsSync(path.join(webBackup, "manifest.json")));
  assert.ok(existsSync(path.join(webBackup, "claude", "skills", "mine", "SKILL.md")), "备份里有自写技能");
  // api 原来一份技能都没有：没有东西可备份，就不编一个空备份目录出来。
  assert.equal(report.projects[1].backupDir, null);

  const matrix = await skillsMatrix({ skills, workspaceDir: workspace, workspaceMode: "unified" });
  for (const row of matrix.rows) {
    for (const cell of row.cells) {
      assert.equal(cell.status, "current", `${row.key}/${cell.client} 应为 current`);
      assert.equal(cell.current, 2);
    }
  }
});

test("矩阵：各自模式全部更新时冲突不被覆盖，冲突逐条列出", async () => {
  const workspace = trackDir(workspaceWith([{ key: "web", dir: "apps/web" }]));
  const skills = matrixFixtures();
  const webDir = path.join(workspace, "apps", "web");
  const stale = writeLocalSkill(webDir, ".claude", "ste", "别人装的同名技能");

  const report = await installWorkspaceSkills({ skills, workspaceDir: workspace, workspaceMode: "per-project" });
  const row = report.projects[0];
  assert.equal(row.backupDir, null);
  const claude = row.cells.find((cell) => cell.client === "claude");
  assert.deepEqual(claude.conflicts, ["ste"], "冲突逐条列出");
  assert.equal(readFileSync(path.join(stale, "SKILL.md"), "utf8"), "别人装的同名技能", "绝不覆盖");

  const matrix = await skillsMatrix({ skills, workspaceDir: workspace, workspaceMode: "per-project" });
  const staleCell = cellOf(matrix.rows[0], "claude");
  assert.equal(staleCell.status, "differs");
  assert.deepEqual(staleCell.differs, ["ste"]);
});

test(
  "矩阵：说清技能目录会不会被 git 提交——忽略、没忽略、判断不了是三回事",
  { skip: !gitAvailable && "本机没有 git" },
  async () => {
    const workspace = trackDir(workspaceWith([{ key: "web", dir: "apps/web" }, { key: "gone", dir: "gone" }]));
    const skills = matrixFixtures();
    assert.equal(spawnSync("git", ["init", "-q", workspace]).status, 0);
    // 只忽略 .claude：另一侧照旧会被提交。
    writeFileSync(path.join(workspace, ".gitignore"), ".claude/\n", "utf8");

    // 目录不在：判断不了，不能写成「不会被提交」。
    rmSync(path.join(workspace, "gone"), { recursive: true, force: true });

    const matrix = await skillsMatrix({ skills, workspaceDir: workspace, workspaceMode: "per-project" });
    const web = matrix.rows[0];
    assert.equal(cellOf(web, "claude").ignored, true, ".gitignore 里有 .claude/");
    assert.equal(cellOf(web, "codex").ignored, false, ".agents 没被忽略，装进去会跟着提交");
    for (const cell of matrix.rows[1].cells) {
      assert.equal(cell.ignored, null, "目录不在就是「判断不了」");
    }

    // 插件只读事实，从不改用户的 .gitignore。
    assert.equal(readFileSync(path.join(workspace, ".gitignore"), "utf8"), ".claude/\n");

    // 不是 git 仓库：同样只能说「判断不了」。
    const plain = trackDir(workspaceWith([{ key: "web", dir: "apps/web" }]));
    const plainMatrix = await skillsMatrix({ skills, workspaceDir: plain, workspaceMode: "per-project" });
    for (const cell of plainMatrix.rows[0].cells) assert.equal(cell.ignored, null);
    assert.equal(existsSync(path.join(plain, ".gitignore")), false, "不该替用户造一个 .gitignore 出来");
  },
);
