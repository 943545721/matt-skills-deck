import type { z } from "zod";
import { MAX_MAP_CONCURRENCY } from "../../../../shared/orchestration.ts";
import {
  agentRowSchema,
  clientProfileSchema,
  clientTargetSchema,
  difficultySchema,
  orchestrationSettingsSchema,
  providerStateRowSchema,
  routeResolutionSchema,
  siteRowSchema,
  treeNodeSchema,
} from "../../../../shared/orchestration-rpc.ts";

/**
 * 编排页的类型与文案换算。
 *
 * 类型全部从 RPC 契约的 zod schema 反推，不在这里手写一份平行定义：
 * 服务端加了字段、客户端忘了同步时，类型检查会先炸，而不是界面上静默少一行。
 */

export type Difficulty = z.infer<typeof difficultySchema>;
export type ClientTarget = z.infer<typeof clientTargetSchema>;
export type ClientProfile = z.infer<typeof clientProfileSchema>;
export type OrchestrationSettings = z.infer<typeof orchestrationSettingsSchema>;
/** 客户端行（带它的站点表与「现在生效的是哪条」）。 */
export type ProviderRow = z.infer<typeof providerStateRowSchema>;
/** 客户端下的一条站点（凭证只到掩码这一层）。 */
export type SiteRow = z.infer<typeof siteRowSchema>;
export type AgentRow = z.infer<typeof agentRowSchema>;
export type TreeNode = z.infer<typeof treeNodeSchema>;
export type RouteResolution = z.infer<typeof routeResolutionSchema>;

/** 一档难度的路由现状：配了什么、解析出什么、是不是借来的。 */
export type RoutingRow = {
  difficulty: Difficulty;
  profileId: string | null;
  target: ClientTarget | null;
  resolved: RouteResolution;
  routeFrom?: Difficulty | "default";
};

export const DIFFICULTIES: readonly Difficulty[] = ["trivial", "normal", "hard", "critical"];

/** 难度 → 文案键后缀；未知难度不猜，原样显示。 */
export const DIFFICULTY_KEY: Record<Difficulty, string> = {
  trivial: "orch.route.difficulty.trivial",
  normal: "orch.route.difficulty.normal",
  hard: "orch.route.difficulty.hard",
  critical: "orch.route.difficulty.critical",
};

/** `provider/model`，与宿主 `config.provider` 的写法一致。 */
export function specOf(target: { provider: string; model?: string | null }): string {
  return target.model ? `${target.provider}/${target.model}` : target.provider;
}

/** 角色绑定：settings.roles 里当前工作区那一条。 */
export function rolesOf(settings: OrchestrationSettings, workspaceId: string) {
  return settings.roles.find((role) => role.workspaceId === workspaceId) ?? null;
}

/** 换掉当前工作区的角色，其它工作区原样保留（不可变：返回新设置）。 */
export function withRoles(
  settings: OrchestrationSettings,
  workspaceId: string,
  patch: { mainAgentId?: string | null; dispatcherAgentId?: string | null },
): OrchestrationSettings {
  const current = rolesOf(settings, workspaceId);
  const nextRole = {
    workspaceId,
    ...(patch.mainAgentId !== undefined
      ? patch.mainAgentId ? { mainAgentId: patch.mainAgentId } : {}
      : current?.mainAgentId ? { mainAgentId: current.mainAgentId } : {}),
    ...(patch.dispatcherAgentId !== undefined
      ? patch.dispatcherAgentId ? { dispatcherAgentId: patch.dispatcherAgentId } : {}
      : current?.dispatcherAgentId ? { dispatcherAgentId: current.dispatcherAgentId } : {}),
  };
  const others = settings.roles.filter((role) => role.workspaceId !== workspaceId);
  const keep = nextRole.mainAgentId || nextRole.dispatcherAgentId;
  return { ...settings, roles: keep ? [...others, nextRole] : others };
}

/**
 * 设一张地图的并发预算；`concurrency` 为 null 表示删掉这条。
 *
 * 排序按地图名：面板上一行一个地图，改完值不该让行跳到别处。
 */
export function withMapBudget(
  settings: OrchestrationSettings,
  map: string,
  concurrency: number | null,
): OrchestrationSettings {
  const rest = settings.mapBudgets.filter((budget) => budget.map !== map);
  const next =
    concurrency === null
      ? rest
      : [...rest, { map, concurrency: Math.min(MAX_MAP_CONCURRENCY, Math.max(1, Math.round(concurrency))) }];
  return { ...settings, mapBudgets: next.sort((left, right) => left.map.localeCompare(right.map)) };
}

/** 换掉某一档难度的路由；`rule` 为 null 表示清掉这一档。 */
export function withRoute(
  settings: OrchestrationSettings,
  difficulty: Difficulty,
  rule: { profileId?: string; target?: ClientTarget } | null,
): OrchestrationSettings {
  const others = settings.routing.filter((item) => item.difficulty !== difficulty);
  const next = rule
    ? [
        ...others,
        {
          difficulty,
          ...(rule.profileId ? { profileId: rule.profileId } : {}),
          ...(rule.target ? { target: rule.target } : {}),
        },
      ]
    : others;
  // 保持固定顺序，界面的四行不会因为「最后改的那档」跳到末尾。
  const ordered = DIFFICULTIES.map((item) => next.find((ruleItem) => ruleItem.difficulty === item)).filter(
    (item): item is NonNullable<typeof item> => Boolean(item),
  );
  return { ...settings, routing: ordered };
}
