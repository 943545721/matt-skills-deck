import { readFileSync } from "node:fs";
import { pluginRoot } from "../paths.ts";
import { listBundledSkills, readBundledSkill } from "../skills/catalog.ts";
import { installSkills, skillState } from "../skills/install.ts";
import type { skillsInstallRpc, skillsListRpc, skillsReadRpc } from "../../shared/skills.ts";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

type ListInput = RpcInput<typeof skillsListRpc>;
type InstallInput = RpcInput<typeof skillsInstallRpc>;
type ReadInput = RpcInput<typeof skillsReadRpc>;

/**
 * 三个处理器都不缓存结果：技能目录很小（27 份 Markdown，合计 1MB 量级），
 * 而「刚点完安装界面还是旧状态」是最容易让人怀疑插件坏了的一种体验。
 */
export function listSkills(input: ListInput): RpcOutput<typeof skillsListRpc> {
  const skills = listBundledSkills(pluginRoot(), input.lang);
  return {
    skills: skills.map((skill) => ({
      id: skill.id,
      description: skill.description,
      state: skillState(skill, input.workspaceDir),
    })),
  };
}

export function installSkillsHandler(input: InstallInput): RpcOutput<typeof skillsInstallRpc> {
  const available = listBundledSkills(pluginRoot(), input.lang);
  const wanted = input.ids
    ? available.filter((skill) => input.ids?.includes(skill.id))
    : available;
  if (input.ids && wanted.length !== input.ids.length) {
    const known = new Set(available.map((skill) => skill.id));
    const unknown = input.ids.filter((id) => !known.has(id));
    throw new Error(`未知的技能：${unknown.join("、")}`);
  }
  return installSkills({ skills: wanted, workspaceDir: input.workspaceDir });
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
