import { readFileSync } from "node:fs";
import { pluginRoot } from "../paths.ts";
import { adoptProjectSkill, listProjectSkills } from "../skills/adopt.ts";
import { listBundledSkills, readBundledSkill, type BundledSkill } from "../skills/catalog.ts";
import { installSkills, removeSkills, skillDirs, skillStateAt } from "../skills/install.ts";
import type {
  skillsAdoptRpc,
  skillsInstallRpc,
  skillsListRpc,
  skillsReadRpc,
  skillsRemoveRpc,
} from "../../shared/skills.ts";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

type ListInput = RpcInput<typeof skillsListRpc>;
type InstallInput = RpcInput<typeof skillsInstallRpc>;
type RemoveInput = RpcInput<typeof skillsRemoveRpc>;
type ReadInput = RpcInput<typeof skillsReadRpc>;
type AdoptInput = RpcInput<typeof skillsAdoptRpc>;

/**
 * 这些处理器都不缓存结果：技能目录很小（28 份 Markdown，合计 1MB 量级），
 * 而「刚点完安装界面还是旧状态」是最容易让人怀疑插件坏了的一种体验。
 */
export function listSkills(input: ListInput): RpcOutput<typeof skillsListRpc> {
  const roots = skillDirs(input.workspaceDir);
  const skills = listBundledSkills(pluginRoot(), input.lang);
  // 两个语言都算「插件自带」：一份英文技能的 id 出现在项目里，也不该被当成「项目独有」拿去回收。
  const bundledIds = [...new Set(["en", "zh"].flatMap((lang) => listBundledSkills(pluginRoot(), lang as "en" | "zh").map((skill) => skill.id)))];
  return {
    skills: skills.map((skill) => ({
      id: skill.id,
      description: skill.description,
      states: roots.map((root) => ({ client: root.client, state: skillStateAt(skill, root.dir) })),
    })),
    roots,
    projectOnly: listProjectSkills(input.workspaceDir, bundledIds),
  };
}

export async function adoptSkillHandler(input: AdoptInput): Promise<RpcOutput<typeof skillsAdoptRpc>> {
  return adoptProjectSkill({
    workspaceDir: input.workspaceDir,
    pluginDir: pluginRoot(),
    id: input.id,
    lang: input.lang,
    overwrite: input.overwrite,
  });
}

/** 没点名就全装；点名了就必须每个 id 都认识，认得一半更容易让人以为装完了。 */
function wantedSkills(lang: InstallInput["lang"], ids: string[] | undefined): BundledSkill[] {
  const available = listBundledSkills(pluginRoot(), lang);
  if (!ids) return available;
  const known = new Set(available.map((skill) => skill.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`未知的技能：${unknown.join("、")}`);
  return available.filter((skill) => ids.includes(skill.id));
}

export function installSkillsHandler(input: InstallInput): RpcOutput<typeof skillsInstallRpc> {
  return installSkills({
    skills: wantedSkills(input.lang, input.ids),
    workspaceDir: input.workspaceDir,
    overwrite: input.overwrite,
  });
}

export function removeSkillsHandler(input: RemoveInput): RpcOutput<typeof skillsRemoveRpc> {
  return removeSkills({ skills: wantedSkills(input.lang, input.ids), workspaceDir: input.workspaceDir });
}

export function readSkill(input: ReadInput): RpcOutput<typeof skillsReadRpc> {
  const skill = readBundledSkill(pluginRoot(), input.lang, input.id);
  if (!skill) throw new Error(`找不到技能 ${input.id}（语言 ${input.lang}）`);
  return {
    id: skill.id,
    description: skill.description,
    markdown: readFileSync(skill.file, "utf8"),
  };
}
