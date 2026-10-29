import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BundledSkill } from "./catalog.ts";
import { isDirectory, readSkillTree, treeMatches } from "./tree.ts";

/**
 * 技能装进**当前项目**：`<工作区>/.claude/skills` 与 `<工作区>/.agents/skills`。
 *
 * 为什么是两个目录：客户端各自写死了自己扫哪儿，我们只能往那两个名字里放，起别的名字没人读。
 *
 * - Claude 读 `.claude/skills`（宿主启动 claude 时 `settingSources` 含 `project`）
 * - Codex 读 `.agents/skills`（实测 `codex debug prompt-input` 的技能根表里有它）
 *
 * 两个目录由程序一起写，不给用户出选择题。ACP 那几家（copilot / cursor / kimi / kiro …）
 * 宿主 daemon 里找不到任何技能路径的读取证据，**未验证**，所以不给它们编目录。
 *
 * **整棵目录**都装：上游技能常带 `references/`、`examples/`，只拷 `SKILL.md` 会让正文里的
 * 相对链接指空。比对与卸载同样按整棵目录算。
 */
export type SkillClient = "claude" | "codex";
export type SkillState = "none" | "current" | "differs";

export const SKILL_CLIENTS: readonly SkillClient[] = ["claude", "codex"];

/** 客户端 → 它扫的目录名。名字来自各家自己的约定，不是我们发明的。 */
export const SKILL_CLIENT_ROOT: Record<SkillClient, string> = {
  claude: ".claude/skills",
  codex: ".agents/skills",
};

/** 两个目标目录名（相对工作区）。草稿安装也按它遍历。 */
export const SKILL_TARGET_ROOTS = [SKILL_CLIENT_ROOT.claude, SKILL_CLIENT_ROOT.codex] as const;

export interface SkillRoot {
  client: SkillClient;
  /** 绝对路径，直接给人看。 */
  dir: string;
}

/** 项目里的两个目标目录。工作区目录必须是已存在的绝对路径，不合法就抛错，不猜。 */
export function skillDirs(workspaceDir: string): SkillRoot[] {
  if (!path.isAbsolute(workspaceDir)) {
    throw new Error(`工作区目录必须是绝对路径，收到的是 ${workspaceDir || "(空)"}`);
  }
  if (!existsSync(workspaceDir) || !isDirectory(workspaceDir)) {
    throw new Error(`工作区目录不存在：${workspaceDir}`);
  }
  return SKILL_CLIENTS.map((client) => ({ client, dir: path.join(workspaceDir, SKILL_CLIENT_ROOT[client]) }));
}

function skillDirIn(dir: string, id: string): string {
  return path.join(dir, id);
}

function skillFileIn(dir: string, id: string): string {
  return path.join(skillDirIn(dir, id), "SKILL.md");
}

/** 插件包里这份技能的完整内容。读不出来就让调用方报错，不当作空技能。 */
function sourceTreeOf(skill: BundledSkill): Map<string, Buffer> {
  return readSkillTree(path.dirname(skill.file));
}

/** 单个目录里这一份技能的状态。 */
export function skillStateAt(skill: BundledSkill, dir: string): SkillState {
  const target = skillDirIn(dir, skill.id);
  if (!isDirectory(target)) return "none";
  try {
    return treeMatches(sourceTreeOf(skill), readSkillTree(target)) ? "current" : "differs";
  } catch {
    return "differs";
  }
}

/** 两处合体的状态：只要有一处缺失或不同就判 `differs`——「装了一半」就是没装好。 */
export function skillState(skill: BundledSkill, workspaceDir: string): SkillState {
  const states = skillDirs(workspaceDir).map((root) => skillStateAt(skill, root.dir));
  if (states.every((state) => state === "current")) return "current";
  if (states.every((state) => state === "none")) return "none";
  return "differs";
}

export interface InstallOutcome {
  written: string[];
  skipped: string[];
  conflicts: string[];
  /** 真实写入的目录（绝对路径），给界面显示「写到哪儿了」。 */
  targets: string[];
}

/**
 * 把选中的技能写进**一个**客户端目录。
 *
 * 拆出来是给多项目安装用的：那里要按「项目 → 客户端」逐格报结果，
 * 只有一个合并后的结果说不清是哪一格冲突了。
 */
export interface DirInstallOutcome {
  written: string[];
  skipped: string[];
  conflicts: string[];
}

export function installSkillsInto(
  skills: readonly BundledSkill[],
  dir: string,
  overwrite: boolean = false,
): DirInstallOutcome {
  const written = new Set<string>();
  const skipped = new Set<string>();
  const conflicts = new Set<string>();

  for (const skill of skills) {
    const source = sourceTreeOf(skill);
    const base = skillDirIn(dir, skill.id);
    const blocked = [...source].some(([rel, data]) => {
      const file = path.join(base, rel);
      if (!existsSync(file)) return false;
      try {
        return !readFileSync(file).equals(data);
      } catch {
        return true;
      }
    });
    if (blocked && !overwrite) {
      conflicts.add(skill.id);
      continue;
    }

    let wrote = 0;
    for (const [rel, data] of source) {
      const file = path.join(base, rel);
      if (existsSync(file)) {
        try {
          if (readFileSync(file).equals(data)) continue;
        } catch {
          // 读不出来就当不同，下面照写（已确认 overwrite）。
        }
      }
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      writeFileSync(file, data, { mode: 0o644 });
      wrote += 1;
    }
    if (wrote > 0) written.add(skill.id);
    else skipped.add(skill.id);
  }

  return {
    written: [...written].sort(),
    skipped: [...skipped].sort(),
    conflicts: [...conflicts].sort(),
  };
}

/**
 * 把选中的技能写进项目里的两个目录。
 *
 * 已存在且内容不同的文件默认算冲突、不覆盖：那里可能是用户自己改过的版本，
 * 也可能是另一个插件装的同名技能，静默覆盖等于替人做决定。
 * 冲突按**整份技能**算：一份技能里只要有一个文件对不上，这个目录就整份不动，
 * 避免写出「主文件是新的、参考资料还是旧的」这种半新半旧的状态。
 * 要覆盖必须是显式 `overwrite`——界面把差异标出来，由人按「用插件版本覆盖」。
 */
export function installSkills(options: {
  skills: readonly BundledSkill[];
  workspaceDir: string;
  /** 覆盖内容不同的文件（默认不覆盖）。 */
  overwrite?: boolean;
}): InstallOutcome {
  const roots = skillDirs(options.workspaceDir);
  const written = new Set<string>();
  const skipped = new Set<string>();
  const conflicts = new Set<string>();

  for (const root of roots) {
    const outcome = installSkillsInto(options.skills, root.dir, options.overwrite ?? false);
    for (const id of outcome.written) written.add(id);
    for (const id of outcome.skipped) skipped.add(id);
    for (const id of outcome.conflicts) conflicts.add(id);
  }

  return {
    written: [...written].sort(),
    skipped: [...skipped].sort(),
    conflicts: [...conflicts].sort(),
    targets: roots.map((root) => root.dir),
  };
}

export interface RemoveOutcome {
  removed: string[];
  /** 内容与内置源不同、没有删的文件：那是人改过的，删掉等于替人做决定。 */
  kept: Array<{ id: string; path: string }>;
  /** 本来就不在的。 */
  missing: string[];
  targets: string[];
}

/**
 * 卸载：只删**我们自己写下去的那一份**。
 *
 * 判据跟安装对称——内容与内置源完全一致才算我们的；不一致就是人改过或别处装的，
 * 原样留着并报出来。删完顺手收掉空的子目录（`rmdir` 只删空目录，有别的文件就留着）。
 */
export function removeSkills(options: { skills: readonly BundledSkill[]; workspaceDir: string }): RemoveOutcome {
  const roots = skillDirs(options.workspaceDir);
  const removed = new Set<string>();
  const kept: Array<{ id: string; path: string }> = [];
  const missing = new Set<string>();

  for (const skill of options.skills) {
    const source = sourceTreeOf(skill);
    for (const root of roots) {
      const base = skillDirIn(root.dir, skill.id);
      if (!existsSync(skillFileIn(root.dir, skill.id)) || !existsSync(base)) {
        missing.add(skill.id);
        continue;
      }
      let deleted = 0;
      for (const [rel, data] of source) {
        const file = path.join(base, rel);
        if (!existsSync(file)) continue;
        let same = false;
        try {
          same = readFileSync(file).equals(data);
        } catch {
          same = false;
        }
        if (!same) {
          kept.push({ id: skill.id, path: file });
          continue;
        }
        try {
          unlinkSync(file);
          deleted += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            kept.push({ id: skill.id, path: file });
          }
        }
      }
      // 空目录（含 references/、examples/ 这类子目录）一并收掉；非空的留着。
      pruneEmptyDirs(base);
      if (deleted > 0) removed.add(skill.id);
    }
  }

  return {
    removed: [...removed].sort(),
    kept: kept.sort((a, b) => a.path.localeCompare(b.path)),
    missing: [...missing].sort(),
    targets: roots.map((root) => root.dir),
  };
}

/** 自底向上删空目录；`rmdir` 遇到非空就停下，用户或别的插件放的文件不会被碰。 */
function pruneEmptyDirs(root: string): void {
  if (!isDirectory(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(root, entry.name));
  }
  try {
    rmdirSync(root);
  } catch {
    // 非空：留着。
  }
}
