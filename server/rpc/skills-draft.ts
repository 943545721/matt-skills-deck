import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  skillsDraftInstallRpc,
  skillsDraftRpc,
  skillsDraftValidateRpc,
} from "../../shared/skills-draft.ts";
import { pluginRoot } from "../paths.ts";
import { installSkillDraft, validateSkillDraft, writeSkillDraft } from "../skills-draft.ts";

/**
 * 技能草稿的三个出口：生成骨架 + 提示词、校验、安装。
 *
 * 每一步都单独暴露，是为了让用户在界面上看到 AI 到底改了哪个文件、
 * 校验挑出了什么毛病、装上之后写到了哪些路径——而不是一个「一键生成」黑箱。
 */

export async function skillsDraftHandler(
  input: RpcInput<typeof skillsDraftRpc>,
): Promise<RpcOutput<typeof skillsDraftRpc>> {
  return writeSkillDraft({
    workspaceDir: input.workspaceDir,
    requirement: input.requirement,
    lang: input.lang,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
  });
}

export async function skillsDraftValidateHandler(
  input: RpcInput<typeof skillsDraftValidateRpc>,
): Promise<RpcOutput<typeof skillsDraftValidateRpc>> {
  return validateSkillDraft(input.workspaceDir, input.slug);
}

export async function skillsDraftInstallHandler(
  input: RpcInput<typeof skillsDraftInstallRpc>,
): Promise<RpcOutput<typeof skillsDraftInstallRpc>> {
  return installSkillDraft(input.workspaceDir, input.slug, input.overwrite ?? false, {
    target: input.target ?? "project",
    lang: input.lang,
    pluginDir: pluginRoot(),
  });
}
