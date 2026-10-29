import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SkillMode } from "../../shared/workspace-projects.ts";
import { getSettings } from "../settings.ts";
import { readWorkspaceConfig } from "../tracker/workspace-repo.ts";
import type { BundledSkill } from "./catalog.ts";
import {
  SKILL_CLIENTS,
  SKILL_CLIENT_ROOT,
  installSkillsInto,
  skillDirs,
  skillStateAt,
  type SkillClient,
} from "./install.ts";

/**
 * 多项目工作区里技能怎么落。
 *
 * 三种输入合成一条路径：
 * - `.paseo-deck.json` v2 的项目清单（每个项目的目录 + 可选 `skillsMode`）；
 * - 工作区设置里的 `skillsMode`（默认 `per-project`）；
 * - 项目自己的 `skillsMode` 优先于工作区设置。
 *
 * 没有 v2 清单时行为等同「只有根项目」，且模式是 `per-project`——老的单项目用户
 * 升级后不会因为「统一模式」被清掉自己写的技能。
 *
 * 这里只读 `workspace-repo.ts` 的配置读取（`missing` / `unreadable` / `bad-json` 的分辨
 * 不该抄第二份）；目录存在性与符号链接越界由本文件自己判——任务板那套探针会顺带跑 git，
 * 技能安装不需要，也不该因为项目没配远端就装不了。
 */

/** 有效模式与它的来源：界面要说清「这个项目为什么是统一模式」。 */
export interface ResolvedSkillMode {
  mode: SkillMode;
  source: "project" | "workspace";
}

export function resolveSkillMode(projectMode: SkillMode | null, workspaceMode: SkillMode): ResolvedSkillMode {
  return projectMode ? { mode: projectMode, source: "project" } : { mode: workspaceMode, source: "workspace" };
}

/** 技能要装到哪儿：项目键 + 绝对目录（目录可能不存在，由调用方判）。 */
export interface SkillProjectRef {
  key: string;
  dir: string;
  projectMode: SkillMode | null;
}

/** 根目录项目的键：备份目录要有个稳定、能直接当目录名的名字。 */
function rootProjectKey(workspaceDir: string): string {
  const slug = path
    .basename(workspaceDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : "root";
}

/**
 * 工作区里的技能项目清单。
 *
 * 只在 v2 清单**有项目**时按清单走；v1（只有 `repoDir`）与读不出来的清单都回落到
 * 「只有根项目」——v1 时代技能本来就装在根目录，换口径等于把老用户的技能搬一次家。
 */
export async function skillProjectsOf(workspaceDir: string): Promise<{ projects: SkillProjectRef[]; notes: string[] }> {
  const read = await readWorkspaceConfig(workspaceDir);
  const notes: string[] = [];
  if (read.ok && read.config.version === 2 && read.config.projects.length > 0) {
    return {
      projects: read.config.projects.map((project) => ({
        key: project.key,
        dir: path.join(workspaceDir, project.dir),
        projectMode: project.skillsMode,
      })),
      notes: [...read.config.warnings],
    };
  }
  if (!read.ok && read.reason !== "missing") {
    notes.push(`项目清单读不出来（${read.reason}）：${read.detail}；按单项目处理`);
  } else if (read.ok && read.config.version === 1) {
    notes.push("这份 .paseo-deck.json 是 v1：技能装在工作区根目录");
  } else if (read.ok) {
    notes.push("项目清单是空的：技能装在工作区根目录");
  }
  return { projects: [{ key: rootProjectKey(workspaceDir), dir: workspaceDir, projectMode: null }], notes };
}

export interface ProjectDirState {
  realDir: string | null;
  problem: string | null;
}

/** 项目目录必须是工作区内真实存在的目录；指向工作区外的符号链接一律当成不存在。 */
export function resolveSkillProjectDir(workspaceDir: string, dir: string): ProjectDirState {
  if (!existsSync(dir)) return { realDir: null, problem: `目录不存在：${dir}` };
  let real: string;
  try {
    real = realpathSync(dir);
  } catch (error) {
    return { realDir: null, problem: `目录读不到：${dir}（${messageOf(error)}）` };
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(workspaceDir);
  } catch {
    rootReal = workspaceDir;
  }
  const rel = path.relative(rootReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { realDir: null, problem: `目录指向工作区外（符号链接？）：${dir}` };
  }
  try {
    if (!statSync(real).isDirectory()) return { realDir: null, problem: `不是目录：${dir}` };
  } catch (error) {
    return { realDir: null, problem: `目录读不到：${dir}（${messageOf(error)}）` };
  }
  return { realDir: real, problem: null };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SkillBackupRoot {
  client: SkillClient;
  from: string;
  to: string;
}

/** `dir` 为 null = 两个技能目录都不在，没有东西可备份，也就不留一个空备份目录。 */
export type SkillBackup = { ok: true; dir: string | null; roots: SkillBackupRoot[] } | { ok: false; detail: string };

/**
 * 把项目的两个技能目录整份复制到 `<工作区>/.deck/backups/skills/<项目键>/<时间戳>/`。
 *
 * 复制而不是移动：备份没成功之前，磁盘上的东西一律不动，用户随时能按原样退出。
 * 备份布局按客户端分目录（`claude/skills`、`codex/skills`），外加一份 manifest.json，
 * 记着每个目录是从哪儿复制的——不然半年后没人说得清该还原到哪。
 */
export function backupSkillDirs(input: {
  workspaceDir: string;
  projectKey: string;
  projectDir: string;
  /** 测试用；默认取当前时间，同一项目一次操作一份。 */
  stamp?: string;
}): SkillBackup {
  const stamp = input.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(input.workspaceDir, ".deck", "backups", "skills", input.projectKey, stamp);
  const roots = SKILL_CLIENTS.map((client) => ({
    client,
    from: path.join(input.projectDir, SKILL_CLIENT_ROOT[client]),
    to: path.join(dir, client, path.basename(SKILL_CLIENT_ROOT[client])),
  })).filter((root) => existsSync(root.from));

  // 两个技能目录都不在：没有东西可备份，连一个空备份目录都不留（它只会让人以为「备份过」）。
  if (roots.length === 0) return { ok: true, dir: null, roots };

  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    for (const root of roots) {
      mkdirSync(path.dirname(root.to), { recursive: true, mode: 0o755 });
      cpSync(root.from, root.to, { recursive: true, force: true });
    }
    writeFileSync(
      path.join(dir, "manifest.json"),
      `${JSON.stringify(
        {
          projectKey: input.projectKey,
          projectDir: input.projectDir,
          createdAt: new Date().toISOString(),
          roots: roots.map((root) => ({ client: root.client, from: root.from, to: root.to })),
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );
  } catch (error) {
    // 半份备份比没有备份更危险：清掉它，让「备份失败」就是纯粹的失败。
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 连清理都失败也照样按失败报，不吞掉真正的原因。
    }
    return { ok: false, detail: `备份到 ${dir} 失败：${messageOf(error)}` };
  }
  return { ok: true, dir, roots };
}

/** 清空一个技能目录的内容，**保留目录本身**；范围只有这个目录，`.claude/` 下别的都不碰。 */
export function clearSkillDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const cleared: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    cleared.push(entry.name);
  }
  return cleared.sort();
}

export interface WorkspaceInstallCell {
  client: SkillClient;
  dir: string;
  written: string[];
  skipped: string[];
  conflicts: string[];
  /** 统一模式下清掉的条目（技能目录名）。 */
  cleared: string[];
}

export interface WorkspaceInstallProject {
  key: string;
  dir: string;
  mode: SkillMode;
  modeSource: "project" | "workspace";
  status: "ok" | "skipped" | "failed";
  /** 跳过 / 停手的原因；成功时为 null。 */
  reason: string | null;
  backupDir: string | null;
  cells: WorkspaceInstallCell[];
}

export interface WorkspaceInstallReport {
  workspaceMode: SkillMode;
  projects: WorkspaceInstallProject[];
  written: string[];
  skipped: string[];
  conflicts: string[];
  targets: string[];
  notes: string[];
}

/**
 * 一次装到全部项目。
 *
 * 统一模式：整份备份 → 备份成功才清空 `.claude/skills` 与 `.agents/skills` → 装插件那份。
 * 备份失败就停手（不清空、不写入），其它项目继续。
 * 各自模式：只写缺失的，冲突不覆盖，**一个文件都不删**。
 */
export async function installWorkspaceSkills(options: {
  skills: readonly BundledSkill[];
  workspaceDir: string;
  /** 显式覆盖：各自模式下也照写（统一模式本来就会清空，等价于覆盖）。 */
  overwrite?: boolean;
  /** 工作区级模式；不给就读设置。测试直接传，避免改全局设置。 */
  workspaceMode?: SkillMode;
  /** 备份时间戳，测试用。 */
  stamp?: string;
}): Promise<WorkspaceInstallReport> {
  // 根目录不合法就抛错，不猜装到哪儿（与单项目安装同一条边界）。
  skillDirs(options.workspaceDir);
  const workspaceMode = options.workspaceMode ?? getSettings().skillsMode;
  const { projects, notes } = await skillProjectsOf(options.workspaceDir);
  const results: WorkspaceInstallProject[] = [];

  for (const project of projects) {
    const resolved = resolveSkillMode(project.projectMode, workspaceMode);
    const state = resolveSkillProjectDir(options.workspaceDir, project.dir);
    if (!state.realDir) {
      results.push({
        key: project.key,
        dir: project.dir,
        mode: resolved.mode,
        modeSource: resolved.source,
        status: "skipped",
        reason: state.problem,
        backupDir: null,
        cells: [],
      });
      continue;
    }

    if (resolved.mode === "unified") {
      const backup = backupSkillDirs({
        workspaceDir: options.workspaceDir,
        projectKey: project.key,
        projectDir: state.realDir,
        stamp: options.stamp,
      });
      if (!backup.ok) {
        results.push({
          key: project.key,
          dir: state.realDir,
          mode: resolved.mode,
          modeSource: resolved.source,
          status: "failed",
          reason: backup.detail,
          backupDir: null,
          cells: [],
        });
        continue;
      }
      const cells = skillDirs(state.realDir).map((root) => ({
        client: root.client,
        dir: root.dir,
        cleared: clearSkillDir(root.dir),
        ...installSkillsInto(options.skills, root.dir, true),
      }));
      results.push({
        key: project.key,
        dir: state.realDir,
        mode: resolved.mode,
        modeSource: resolved.source,
        status: "ok",
        reason: null,
        backupDir: backup.dir,
        cells,
      });
      continue;
    }

    const cells = skillDirs(state.realDir).map((root) => ({
      client: root.client,
      dir: root.dir,
      cleared: [],
      ...installSkillsInto(options.skills, root.dir, options.overwrite ?? false),
    }));
    results.push({
      key: project.key,
      dir: state.realDir,
      mode: resolved.mode,
      modeSource: resolved.source,
      status: "ok",
      reason: null,
      backupDir: null,
      cells,
    });
  }

  const union = (pick: (cell: WorkspaceInstallCell) => string[]): string[] =>
    [...new Set(results.flatMap((row) => row.cells.flatMap(pick)))].sort();

  return {
    workspaceMode,
    projects: results,
    written: union((cell) => cell.written),
    skipped: union((cell) => cell.skipped),
    conflicts: union((cell) => cell.conflicts),
    targets: results.flatMap((row) => row.cells.map((cell) => cell.dir)),
    notes,
  };
}

/** 一格（项目 × 客户端）的状态：整列汇总成一句话。 */
export type MatrixCellStatus = "none" | "current" | "differs" | "missing";

export interface MatrixCell {
  client: SkillClient;
  dir: string;
  status: MatrixCellStatus;
  total: number;
  /** 与插件包一致的份数。 */
  current: number;
  /** 内容不同的技能 id。 */
  differs: string[];
  /** 这个目录里没有的技能 id。 */
  missing: string[];
}

export interface MatrixRow {
  key: string;
  dir: string;
  exists: boolean;
  problem: string | null;
  mode: SkillMode;
  modeSource: "project" | "workspace";
  cells: MatrixCell[];
}

export interface SkillsMatrix {
  workspaceMode: SkillMode;
  rows: MatrixRow[];
  notes: string[];
}

/**
 * 项目 × 客户端矩阵。
 *
 * 一格的状态取「最需要人动手」的那一档：有内容不同就是 `differs`（要人决定覆盖与否），
 * 否则有缺的算 `missing`，一份都没有算 `none`（界面上写「未安装」，不留空白）。
 * 计数与 id 一起给：只说「过期了」，用户还得自己一份份点开找。
 */
export async function skillsMatrix(input: {
  skills: readonly BundledSkill[];
  workspaceDir: string;
  workspaceMode?: SkillMode;
}): Promise<SkillsMatrix> {
  skillDirs(input.workspaceDir);
  const workspaceMode = input.workspaceMode ?? getSettings().skillsMode;
  const { projects, notes } = await skillProjectsOf(input.workspaceDir);
  const rows: MatrixRow[] = projects.map((project) => {
    const resolved = resolveSkillMode(project.projectMode, workspaceMode);
    const state = resolveSkillProjectDir(input.workspaceDir, project.dir);
    const realDir = state.realDir;
    const cells: MatrixCell[] = SKILL_CLIENTS.map((client) => {
      // 目录不在也照样给出「本来该装到哪儿」的路径：界面上不留空，人也知道缺的是什么。
      const dir = path.join(realDir ?? project.dir, SKILL_CLIENT_ROOT[client]);
      if (!realDir) {
        return {
          client,
          dir,
          status: "none" as const,
          total: input.skills.length,
          current: 0,
          differs: [],
          missing: input.skills.map((skill) => skill.id),
        };
      }
      const differs: string[] = [];
      const missing: string[] = [];
      let current = 0;
      for (const skill of input.skills) {
        const at = skillStateAt(skill, dir);
        if (at === "current") current += 1;
        else if (at === "differs") differs.push(skill.id);
        else missing.push(skill.id);
      }
      const status: MatrixCellStatus =
        current === input.skills.length ? "current" : differs.length > 0 ? "differs" : current > 0 ? "missing" : "none";
      return { client, dir, status, total: input.skills.length, current, differs: differs.sort(), missing: missing.sort() };
    });
    return {
      key: project.key,
      dir: realDir ?? project.dir,
      exists: realDir !== null,
      problem: state.problem,
      mode: resolved.mode,
      modeSource: resolved.source,
      cells,
    };
  });
  return { workspaceMode, rows, notes };
}
