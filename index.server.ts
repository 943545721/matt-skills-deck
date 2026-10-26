import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listSkills, installSkillsHandler, readSkill } from "./server/rpc/skills.ts";
import { readStatus } from "./server/status.ts";
import { skillsInstallRpc, skillsListRpc, skillsReadRpc } from "./shared/skills.ts";
import { statusRpc } from "./shared/status.ts";

/**
 * 服务端入口：只做注册，不写实现。
 *
 * 约定：每个域一个文件（server/rpc/<domain>.ts），入口按域注册 RPC，与源仓库
 * 「入口只装配、实现各归各家」的口径一致，避免这个文件变成下一个千行怪物。
 */
export default function contribute(server: PluginServerContext) {
  server.handle(statusRpc, readStatus);
  server.handle(skillsListRpc, listSkills);
  server.handle(skillsInstallRpc, installSkillsHandler);
  server.handle(skillsReadRpc, readSkill);
  return () => {};
}
