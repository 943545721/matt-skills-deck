import type { z } from "zod";
import {
  DEFAULT_ROLE_PROMPTS,
  FIXED_ROLES,
  MAX_MAP_CONCURRENCY,
  MAX_ROLE_PROMPT_CHARS,
  ROLE_AGENT_FIELD,
  rolePromptFor,
  withWorkspaceRoles,
  type FixedRole,
  type RoleLang,
  type WorkspaceRoles,
} from "../../../../shared/orchestration.ts";
import type { StaffCard } from "../../../../shared/staff.ts";
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

/**
 * 这一档走的那份档案（还在的前提下）。
 *
 * 与 `shared/orchestration.ts` 的 `resolveRouteTarget` 同一套口径：`profileId` 先 trim、
 * 找得到就算走档案——哪怕那份档案自己没写模型（那时这一档坏在档案上，不是坏在没选客户端）。
 */
export function liveProfileOf(row: RoutingRow, profiles: ClientProfile[]): ClientProfile | null {
  const profileId = row.profileId?.trim();
  if (!profileId) return null;
  return profiles.find((profile) => profile.id === profileId) ?? null;
}

/**
 * 这一档真正会落到「直选客户端」上的目标。
 *
 * 档案优先（与 `resolveRouteTarget` 同一条规则）；档案已经不在了才回落到 `target`——
 * 这时仍要能点模型，否则界面推荐的那条路（档案）一走空，用户就只剩手打。
 * 写成纯函数是为了能单独测这一判断，不必渲染整个路由页。
 */
export function directTargetOf(row: RoutingRow, profiles: ClientProfile[]): ClientTarget | null {
  return liveProfileOf(row, profiles) ? null : row.target;
}

/**
 * 行上该印哪条目标。
 *
 * 解析成功就是解析结果；解析失败时印「这一档真正会用的那条」：活档案本人（哪怕它缺模型
 * ——那正是要说清的坏处，印「未配置」等于说用户没配过），或档案没了之后的兜底 `target`。
 */
export function displayTargetOf(
  row: RoutingRow,
  profiles: ClientProfile[],
): { provider: string; model?: string | null } | null {
  if (row.resolved.ok) return row.resolved.target;
  return liveProfileOf(row, profiles) ?? row.target;
}

/**
 * 这一档走的是**活档案**、但那份档案自己没写模型时，返回那份档案。
 *
 * 这种档从路由页点不了模型（模型在档案里），界面必须指回档案页，否则「配过却发不出去」
 * 的老毛病在这条路径上原样复现，而且不给任何线索。
 */
export function profileWithoutModel(row: RoutingRow, profiles: ClientProfile[]): ClientProfile | null {
  const profile = liveProfileOf(row, profiles);
  // 与 shared 的 `targetProblem` 同一口径：空白模型算没写，别一边报 no-model、一边不给下去改的路。
  return profile && !profile.model?.trim() ? profile : null;
}

/**
 * 一个客户端下能点的模型候选。四种结果必须分开，说法完全不同：
 * - `host-empty`：宿主这一趟一个客户端都没报出来（刷新失败 / 还没读），说「删了或改名了」是瞎猜；
 * - `no-client`：还没指客户端，谈不上模型；
 * - `unknown-client`：指的客户端宿主已经不认（删了或改名了）；
 * - `ok` 且清单为空：客户端在，但它一个模型都没报出来（没启用 / 没配凭证）。
 */
export type ModelChoicesState =
  | { kind: "host-empty" }
  | { kind: "no-client" }
  | { kind: "unknown-client"; provider: string }
  | { kind: "ok"; models: string[] };

export function modelChoicesOf(providerId: string, providers: ProviderRow[]): ModelChoicesState {
  const id = providerId.trim();
  // 客户端清单本身是空的：这时「这个客户端已经不在清单里」无从谈起，别拿空集当证据。
  if (providers.length === 0) return { kind: "host-empty" };
  if (!id) return { kind: "no-client" };
  const provider = providers.find((candidate) => candidate.id === id);
  return provider ? { kind: "ok", models: provider.models } : { kind: "unknown-client", provider: id };
}

/** 角色绑定：settings.roles 里当前工作区那一条。 */
export function rolesOf(settings: OrchestrationSettings, workspaceId: string) {
  return settings.roles.find((role) => role.workspaceId === workspaceId) ?? null;
}

/** 当前工作区的名册；没有名册就是空数组，调用方不必处处判 null。 */
export function staffOf(settings: OrchestrationSettings, workspaceId: string): StaffCard[] {
  return rolesOf(settings, workspaceId)?.staff ?? [];
}

/**
 * 名册的一次操作，而不是一份快照。
 *
 * 保存前 `applySettings` 会重读盘上的最新设置；把「加/改/删」写成对最新名册的函数，
 * 另一个窗口刚加的那张卡就不会被本窗口的旧数组整份覆盖掉。
 */
export type StaffMutation = (cards: StaffCard[]) => StaffCard[];

/**
 * 整组替换当前工作区的名册，其它字段（角色槽位、提示词）原样带走。
 *
 * 空数组会真的清空名册：`withWorkspaceRoles` 把「没传 staff」当成「保持原样」，
 * 所以这里必须显式给出 `staff`，不能依赖 `withStaffCards` 删除字段后的 undefined。
 */
export function withStaff(
  settings: OrchestrationSettings,
  workspaceId: string,
  cards: readonly StaffCard[],
): OrchestrationSettings {
  const current = rolesOf(settings, workspaceId);
  const role: WorkspaceRoles = { ...(current ?? {}), workspaceId, staff: [...cards] };
  return withWorkspaceRoles(settings, role);
}

/** 「限制」区一次提交的补丁；`undefined` 不动，数值由 `OrchStepper` 提前夹在范围内。 */
export type LimitsPatch = {
  maxDepth?: number;
  maxChildrenPerDispatch?: number;
  reportOnFinish?: boolean;
  minConcurrentStaff?: number;
  confirmRequirementSplit?: boolean;
  staffSessionQuota?: number;
};

/** 一行的角色槽位补丁：`undefined` 不动，`null` 清掉。 */
export type RolesPatch = {
  mainAgentId?: string | null;
  dispatcherAgentId?: string | null;
  progressAgentId?: string | null;
  /**
   * 身份提示词补丁：`undefined` 保留、`null` 或空串恢复默认。
   * 只提交改了的那一段，其余段原样保留。
   */
  prompts?: Partial<Record<FixedRole, string | null>>;
};

/** 换掉当前工作区的角色，其它工作区原样保留（不可变：返回新设置）。 */
export function withRoles(
  settings: OrchestrationSettings,
  workspaceId: string,
  patch: RolesPatch,
): OrchestrationSettings {
  const current = rolesOf(settings, workspaceId);
  // 先只做「补丁合并」：trim / 截断 / 丢空键都由 `withWorkspaceRoles` 统一归一，
  // 两边各写一遍迟早会分叉。
  const next: WorkspaceRoles = { ...(current ?? {}), workspaceId };

  for (const role of FIXED_ROLES) {
    const field = ROLE_AGENT_FIELD[role];
    // `undefined` 是「这一栏没提交」，不是「清空」；只有显式传 null/空白才清。
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null || !value.trim()) delete next[field];
    else next[field] = value;
  }

  // 提示词同样只合并提交了的那几段；空串交给 `withWorkspaceRoles` 丢掉。
  const prompts: Partial<Record<FixedRole, string>> = { ...(current?.prompts ?? {}) };
  if (patch.prompts) {
    for (const role of FIXED_ROLES) {
      const value = patch.prompts[role];
      if (value === undefined) continue;
      if (value === null) delete prompts[role];
      else prompts[role] = value;
    }
  }
  if (Object.keys(prompts).length) next.prompts = prompts;
  // 删掉最后一段自定义提示词时要连同旧对象一起清掉：`next` 是从 `current` 展开来的，
  // 不 delete 就会把旧 prompts 又带回给 `withWorkspaceRoles`，恢复默认等于没恢复。
  else delete next.prompts;

  return withWorkspaceRoles(settings, next);
}

/**
 * 编辑器的文本该写回什么；`null` = 不用落盘。
 *
 * 三条规则：与**当前语言**的默认值相同视为没改（删掉自定义段，之后切语言仍跟随）；
 * 与当前生效值相同不重复写；超长直接拒绝。写成纯函数是为了能单独测面板的判断，
 * 不必渲染整个角色页。
 */
export function promptPatchFor(
  role: FixedRole,
  text: string,
  roles: WorkspaceRoles | null | undefined,
  lang: RoleLang,
): RolesPatch | null {
  const trimmed = text.trim();
  if (trimmed.length > MAX_ROLE_PROMPT_CHARS) return null;
  const fallback = DEFAULT_ROLE_PROMPTS[role][lang].trim();
  const custom = roles?.prompts?.[role];
  if (trimmed === fallback) return custom ? { prompts: { [role]: null } } : null;
  if (!trimmed) return custom ? { prompts: { [role]: null } } : null;
  if (trimmed === rolePromptFor(roles, role, lang).trim()) return null;
  return { prompts: { [role]: trimmed } };
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
