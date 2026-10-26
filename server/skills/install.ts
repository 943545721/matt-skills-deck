import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BundledSkill } from "./catalog.ts";

/**
 * 装到哪里：Claude 读 `.claude/skills`，Codex 读 `.agents/skills`，两者都写，用户换 provider 时不用重装。
 * 这两个目录名来自各家 provider 自己的搜索路径，不是我们发明的约定。
 */
export const SKILL_TARGET_ROOTS = [".claude/skills", ".agents/skills"] as const;

export type SkillState = "none" | "current" | "differs";

function targetFile(workspaceDir: string, root: string, id: string): string {
  return path.join(workspaceDir, root, id, "SKILL.md");
}

/**
 * 一份技能在工作区里的状态。
 * 两个目标目录只要有一个缺失或内容不同，就判 `differs`——「装了一半」对用户来说就是没装好，
 * 报成已安装会让他在某个 provider 下找不到技能还以为插件坏了。
 */
export function skillState(skill: BundledSkill, workspaceDir: string): SkillState {
  const source = readFileSync(skill.file, "utf8");
  const states = SKILL_TARGET_ROOTS.map((root) => {
    const file = targetFile(workspaceDir, root, skill.id);
    if (!existsSync(file)) return "none";
    try {
      return readFileSync(file, "utf8") === source ? "current" : "differs";
    } catch {
      return "differs";
    }
  });
  if (states.every((state) => state === "current")) return "current";
  if (states.every((state) => state === "none")) return "none";
  return "differs";
}

export interface InstallOutcome {
  written: string[];
  skipped: string[];
  conflicts: string[];
  targets: string[];
}

/**
 * 把选中的技能写进工作区。
 *
 * 已存在且内容不同的文件一律算冲突、绝不覆盖：那里可能是用户自己改过的版本，
 * 也可能是另一个插件装的同名技能，静默覆盖等于替人做决定。界面负责把冲突列出来让人自己处理。
 */
export function installSkills(options: {
  skills: readonly BundledSkill[];
  workspaceDir: string;
}): InstallOutcome {
  const { skills, workspaceDir } = options;
  if (!path.isAbsolute(workspaceDir)) {
    throw new Error(`工作区目录必须是绝对路径，收到的是 ${workspaceDir}`);
  }
  if (!existsSync(workspaceDir) || !statSync(workspaceDir).isDirectory()) {
    throw new Error(`工作区目录不存在：${workspaceDir}`);
  }

  const written = new Set<string>();
  const skipped = new Set<string>();
  const conflicts = new Set<string>();

  for (const skill of skills) {
    const source = readFileSync(skill.file, "utf8");
    for (const root of SKILL_TARGET_ROOTS) {
      const file = targetFile(workspaceDir, root, skill.id);
      if (existsSync(file)) {
        let same = false;
        try {
          same = readFileSync(file, "utf8") === source;
        } catch {
          same = false;
        }
        if (same) skipped.add(skill.id);
        else conflicts.add(skill.id);
        continue;
      }
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      writeFileSync(file, source, { encoding: "utf8", mode: 0o644 });
      written.add(skill.id);
    }
  }

  return {
    written: [...written].sort(),
    skipped: [...skipped].sort(),
    conflicts: [...conflicts].sort(),
    targets: [...SKILL_TARGET_ROOTS],
  };
}
