import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseSkillFrontmatter, type SkillMeta } from "./frontmatter.ts";

export type SkillLang = "en" | "zh";

export interface BundledSkill extends SkillMeta {
  /** 技能目录名，也是安装到工作区时的目录名。 */
  id: string;
  /** 这份技能在插件包里的绝对路径。 */
  file: string;
}

/** 只允许小写字母、数字与连字符：这个值会拼进工作区路径，不能带 `..` 或斜杠。 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

export function skillsRoot(pluginDir: string, lang: SkillLang): string {
  return path.join(pluginDir, "templates", "skills", lang);
}

/**
 * 读插件自带的技能清单。
 *
 * 目录名与 frontmatter 的 name 必须逐字相等：上游把这个约定当作「这份技能没有被改坏」的判据，
 * 不相等就跳过并留一条告警，而不是猜一个名字——猜出来的名字会变成工作区里一个找不到来源的目录。
 */
export function listBundledSkills(pluginDir: string, lang: SkillLang): BundledSkill[] {
  const root = skillsRoot(pluginDir, lang);
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const skills: BundledSkill[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name, "SKILL.md");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const meta = parseSkillFrontmatter(text);
    if (!meta || meta.name !== entry.name) continue;
    skills.push({ ...meta, id: entry.name, file });
  }
  return skills;
}

/** 单份技能的正文，供详情页渲染；找不到时返回 null，不伪造空文档。 */
export function readBundledSkill(
  pluginDir: string,
  lang: SkillLang,
  id: string,
): BundledSkill | null {
  if (!SAFE_ID.test(id)) return null;
  return listBundledSkills(pluginDir, lang).find((skill) => skill.id === id) ?? null;
}
