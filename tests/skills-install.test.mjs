import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listBundledSkills } from "../server/skills/catalog.ts";
import { installSkills, removeSkills, skillDirs, skillStateAt } from "../server/skills/install.ts";
import { installWorkspaceSkills } from "../server/skills/workspace.ts";
import { installSkillsHandler, listSkills } from "../server/rpc/skills.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";
import { skillsInstallRpc, skillsListRpc } from "../shared/skills.ts";
import { makeSkill, snapshotTree, tempRoot, workspaceWith, writeLocalSkill } from "./helpers/skill-fixtures.mjs";

/**
 * 技能装进**当前项目**，不装到别处。
 *
 * 钉四件事：
 * 1. 目标就是项目里两个客户端各自认的目录（`.claude/skills`、`.agents/skills`），都由程序一起写；
 * 2. 工作区目录不合法就报错，不猜落到哪儿；
 * 3. 卸载只删我们自己写的那一份，人改过的文件原样留着；
 * 4. 状态按目录单独算，界面才不会拿一个「已安装」糊过去。
 *
 * 后面一半是多项目工作区的两种模式：统一模式（备份→清理→装）与各自模式（只补缺失）。
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

/* ───────────────────────── 多项目工作区 ───────────────────────── */

/** 夹具自己建的临时目录也一并登记，`after` 统一清掉。 */
const track = (dir) => {
  tempDirs.push(dir);
  return dir;
};

const fixtureSkills = () => {
  const source = track(tempRoot("src"));
  return [
    makeSkill(source, "ste", { "references/terminology.md": "术语表\n", "examples/result-report.md": "报告\n" }),
    makeSkill(source, "tdd"),
  ];
};

const clientDir = (projectDir, client) => path.join(projectDir, client, "skills");

test("统一模式：2 个项目 × 2 个目录装齐，ste 的 references 一起到", async () => {
  const workspace = track(workspaceWith([{ key: "web", dir: "apps/web" }, { key: "api", dir: "apps/api" }]));
  const skills = fixtureSkills();

  const report = await installWorkspaceSkills({ skills, workspaceDir: workspace, workspaceMode: "unified" });
  assert.equal(report.workspaceMode, "unified");
  assert.deepEqual(report.projects.map((project) => project.key), ["web", "api"]);
  assert.deepEqual(report.written, ["ste", "tdd"]);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.targets.length, 4, "2 个项目 × 2 个目录");

  for (const project of report.projects) {
    assert.equal(project.status, "ok");
    assert.equal(project.mode, "unified");
    assert.equal(project.modeSource, "workspace");
    assert.equal(project.cells.length, 2);
    for (const cell of project.cells) {
      assert.deepEqual(cell.written, ["ste", "tdd"]);
      assert.deepEqual(cell.conflicts, []);
      assert.deepEqual(cell.cleared, []);
    }
  }

  for (const dir of ["apps/web", "apps/api"]) {
    for (const client of [".claude", ".agents"]) {
      const root = clientDir(path.join(workspace, dir), client);
      assert.equal(readFileSync(path.join(root, "ste", "references", "terminology.md"), "utf8"), "术语表\n");
      assert.equal(readFileSync(path.join(root, "ste", "examples", "result-report.md"), "utf8"), "报告\n");
      assert.equal(readFileSync(path.join(root, "tdd", "SKILL.md"), "utf8"), readFileSync(skills[1].file, "utf8"));
    }
  }
});

test("统一模式：先整份备份再清理，备份能还原清理前的全部内容，.claude 其它内容不碰", async () => {
  const projectDir = path.join("apps", "web");
  const workspace = track(workspaceWith([{ key: "web", dir: projectDir }]));
  const project = path.join(workspace, projectDir);
  const claude = clientDir(project, ".claude");
  const codex = clientDir(project, ".agents");

  writeLocalSkill(project, ".claude", "mine", "自写技能", { "references/own.md": "自己的参考\n" });
  writeLocalSkill(project, ".agents", "other", "另一份自写技能");
  mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
  writeFileSync(path.join(project, ".claude", "agents", "reviewer.md"), "agent 定义", "utf8");

  const beforeClaude = snapshotTree(claude);
  const beforeCodex = snapshotTree(codex);

  const report = await installWorkspaceSkills({
    skills: fixtureSkills(),
    workspaceDir: workspace,
    workspaceMode: "unified",
    stamp: "2026-10-30T00-00-00-000Z",
  });

  const row = report.projects[0];
  assert.equal(row.status, "ok");
  assert.equal(row.backupDir, path.join(workspace, ".deck", "backups", "skills", "web", "2026-10-30T00-00-00-000Z"));

  // 备份是整份复制：清理前的每一个文件都在，内容逐字节一致。
  assert.deepEqual(snapshotTree(path.join(row.backupDir, "claude", "skills")), beforeClaude);
  assert.deepEqual(snapshotTree(path.join(row.backupDir, "codex", "skills")), beforeCodex);

  const manifest = JSON.parse(readFileSync(path.join(row.backupDir, "manifest.json"), "utf8"));
  assert.equal(manifest.projectKey, "web");
  assert.equal(manifest.projectDir, project);

  // 清理只清这两份目录本身，`.claude/agents` 不动。
  assert.equal(existsSync(path.join(claude, "mine")), false);
  assert.equal(existsSync(path.join(codex, "other")), false);
  assert.equal(readFileSync(path.join(project, ".claude", "agents", "reviewer.md"), "utf8"), "agent 定义");

  const claudeCell = row.cells.find((cell) => cell.client === "claude");
  assert.deepEqual(claudeCell.cleared, ["mine"]);
});

test("统一模式：备份失败就停手，不清空、不写入，别的项目继续", async () => {
  const workspace = track(workspaceWith([{ key: "web", dir: "apps/web" }, { key: "api", dir: "apps/api" }]));
  const web = path.join(workspace, "apps", "web");
  writeLocalSkill(web, ".claude", "mine", "自写技能");

  // 让 web 这个项目的备份目录位置被一个文件占住：复制一定失败，但别的项目不受影响。
  const skillsBackups = path.join(workspace, ".deck", "backups", "skills");
  mkdirSync(skillsBackups, { recursive: true });
  writeFileSync(path.join(skillsBackups, "web"), "占位", "utf8");

  const report = await installWorkspaceSkills({ skills: fixtureSkills(), workspaceDir: workspace, workspaceMode: "unified" });

  const failed = report.projects.find((row) => row.key === "web");
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /备份/);
  assert.equal(failed.backupDir, null);
  assert.deepEqual(failed.cells, []);
  assert.equal(readFileSync(path.join(clientDir(web, ".claude"), "mine", "SKILL.md"), "utf8"), "自写技能", "备份失败不许清空");
  assert.equal(existsSync(path.join(clientDir(web, ".claude"), "ste")), false, "备份失败不许写入");

  const ok = report.projects.find((row) => row.key === "api");
  assert.equal(ok.status, "ok");
  assert.ok(existsSync(path.join(clientDir(path.join(workspace, "apps", "api"), ".claude"), "ste", "SKILL.md")));
});

test("各自模式：只补缺失，已有文件一个都不删，冲突逐条列出", async () => {
  const workspace = track(workspaceWith([{ key: "web", dir: "apps/web" }, { key: "api", dir: "apps/api" }]));
  const web = path.join(workspace, "apps", "web");
  const api = path.join(workspace, "apps", "api");
  const mine = writeLocalSkill(web, ".claude", "mine", "自写技能");
  const stale = writeLocalSkill(web, ".claude", "ste", "别人装的同名技能");

  const report = await installWorkspaceSkills({ skills: fixtureSkills(), workspaceDir: workspace, workspaceMode: "per-project" });

  const webRow = report.projects.find((row) => row.key === "web");
  assert.equal(webRow.status, "ok");
  assert.equal(webRow.mode, "per-project");
  assert.equal(webRow.backupDir, null, "各自模式不建备份");
  const webClaude = webRow.cells.find((cell) => cell.client === "claude");
  assert.deepEqual(webClaude.conflicts, ["ste"]);
  assert.deepEqual(webClaude.written, ["tdd"]);
  assert.deepEqual(webClaude.cleared, []);
  assert.equal(readFileSync(path.join(mine, "SKILL.md"), "utf8"), "自写技能", "自写技能不许删");
  assert.equal(readFileSync(path.join(stale, "SKILL.md"), "utf8"), "别人装的同名技能", "冲突不许覆盖");
  assert.equal(existsSync(path.join(workspace, ".deck")), false, "各自模式不碰 .deck");

  const apiRow = report.projects.find((row) => row.key === "api");
  assert.deepEqual(
    apiRow.cells.map((cell) => cell.written),
    [["ste", "tdd"], ["ste", "tdd"]],
    "没冲突的项目照装",
  );
  assert.ok(existsSync(path.join(clientDir(api, ".agents"), "tdd", "SKILL.md")));
});

test("项目目录不存在：跳过并报出原因，其它项目照装", async () => {
  const workspace = track(workspaceWith([{ key: "web", dir: "apps/web" }, { key: "ghost", dir: "apps/ghost" }]));
  rmSync(path.join(workspace, "apps", "ghost"), { recursive: true, force: true });

  const report = await installWorkspaceSkills({ skills: fixtureSkills(), workspaceDir: workspace, workspaceMode: "unified" });

  const ghost = report.projects.find((row) => row.key === "ghost");
  assert.equal(ghost.status, "skipped");
  assert.match(ghost.reason, /不存在/);
  assert.deepEqual(ghost.cells, []);
  assert.equal(report.projects.find((row) => row.key === "web").status, "ok");
  assert.equal(report.targets.length, 2, "只有 web 的两处");
});

test("模式优先级：项目自己的 skillsMode 压过工作区设置", async () => {
  const workspace = track(
    workspaceWith([
      { key: "web", dir: "apps/web", skillsMode: "unified" },
      { key: "api", dir: "apps/api" },
    ]),
  );

  const report = await installWorkspaceSkills({ skills: fixtureSkills(), workspaceDir: workspace, workspaceMode: "per-project" });

  const web = report.projects.find((row) => row.key === "web");
  const api = report.projects.find((row) => row.key === "api");
  assert.equal(web.mode, "unified");
  assert.equal(web.modeSource, "project");
  assert.equal(api.mode, "per-project");
  assert.equal(api.modeSource, "workspace");
});

test("没有项目清单：等同只有根项目，默认各自模式，不删任何东西", async () => {
  const workspace = track(tempRoot("bare"));
  writeLocalSkill(workspace, ".claude", "mine", "自写技能");
  setSettingsForTest(DEFAULT_SETTINGS);
  try {
    const report = await installWorkspaceSkills({ skills: fixtureSkills(), workspaceDir: workspace });
    assert.equal(report.workspaceMode, "per-project", "默认值就是 per-project");
    assert.equal(report.projects.length, 1);
    assert.equal(report.projects[0].dir, workspace);
    assert.equal(report.targets.length, 2);
    assert.equal(readFileSync(path.join(clientDir(workspace, ".claude"), "mine", "SKILL.md"), "utf8"), "自写技能");
    assert.equal(existsSync(path.join(workspace, ".deck")), false);
  } finally {
    setSettingsForTest(DEFAULT_SETTINGS);
  }
});

test("RPC 契约：安装与列表的输出都能被共享 schema 原样解析", async () => {
  const workspace = track(workspaceWith([{ key: "web", dir: "apps/web" }]));

  const installed = await installSkillsHandler({ workspaceDir: workspace, lang: "zh" });
  assert.deepEqual(skillsInstallRpc.output.parse(installed), installed);
  assert.equal(installed.workspaceMode, "per-project");
  assert.equal(installed.projects.length, 1);
  assert.ok(installed.written.length > 0, "没点名就是全装");
  assert.equal(installed.targets.length, 2);

  const listed = await listSkills({ workspaceDir: workspace, lang: "zh" });
  assert.deepEqual(skillsListRpc.output.parse(listed), listed);
  const row = listed.projects[0];
  assert.ok(row);
  for (const cell of row.cells) {
    assert.equal(cell.status, "current", `${cell.client} 装完就该是一致`);
  }
});
