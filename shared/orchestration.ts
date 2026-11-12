/**
 * 多客户端派单编排的纯函数层。
 *
 * 这里只有数据形状与判断，不碰宿主：路由怎么选、标签怎么写、能不能再往下派、
 * 子会话的树怎么拼。客户端（`paseo.providers.*`）与服务端（`paseo.config.*`、
 * `agents.create`）各自把自己那一半注入进来。
 *
 * 三条口径（与 `.claude/plans/20261029-agent-orchestration.md` 一致）：
 * 1.「客户端」= Paseo 的 provider（claude / codex / opencode…），模型挂在 `provider/model` 上。
 * 2.「客户端档案」直接用宿主的 `daemon.agentProfiles`，不另造一套并行概念。
 * 3. 难度只接受显式声明或标签推导，不让模型自评——自评必然虚高。
 */

import { DEFAULT_ROLE_PROMPTS, FIXED_ROLES, MAX_ROLE_PROMPT_CHARS } from "./role-prompts.ts";
import type { FixedRole, RoleLang } from "./role-prompts.ts";
import { asRecord, clampInt, optionalText, text } from "./coerce.ts";
import {
  normalizeModelThinking,
  resolveThinkingOptionId,
  type ModelThinkingDefault,
  type ThinkingResolutionContext,
} from "./model-thinking.ts";
import { DECK_STAFF_LABEL, MAX_STAFF_CARDS, normalizeStaffCards, normalizeStaffId, normalizeStaffPath, roleCarriesFields, rosterOf, staffCardOf } from "./staff.ts";
import type { StaffCard } from "./staff.ts";
import { resolveOwner } from "./staff-guard.ts";

export const DIFFICULTIES = ["trivial", "normal", "hard", "critical"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" && (DIFFICULTIES as readonly string[]).includes(value);
}

/** 难度排序：用于「至少这个档位」这类比较，例如按票面标签把 trivial 抬到 normal。 */
export const DIFFICULTY_RANK: Readonly<Record<Difficulty, number>> = {
  trivial: 0,
  normal: 1,
  hard: 2,
  critical: 3,
};

/** 一次派单要落到宿主上的具体会话配置。 */
export interface ClientTarget {
  /** provider id，不能带 `/`；模型单独放 `model`。 */
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

/** 宿主 `daemon.agentProfiles` 的一条；只取编排需要的字段。 */
export interface ClientProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
}

/**
 * 路由规则：某一档难度落到哪个客户端与模型。
 *
 * 路由只到「客户端 + 模型」这一步；客户端自己的地址与凭证由宿主配置管。
 */
export interface RoutingRule {
  difficulty: Difficulty;
  /** 优先用档案：档案改一次，四档一起生效。 */
  profileId?: string;
  /** 档案被删掉时的兜底；两者都没有就算这条规则不可用。 */
  target?: ClientTarget;
}

export {
  DEFAULT_ROLE_PROMPTS,
  FIXED_ROLE_NAMES,
  FIXED_ROLES,
  MAX_ROLE_PROMPT_CHARS,
  ROLE_LANGS,
  ROLE_WINDOW_TITLES,
  type FixedRole,
  type RoleLang,
  type LocalizedText,
} from "./role-prompts.ts";

// 默认档那一段整体在 `./model-thinking.ts`：解析规则与归一在独立领域里，
// 从编排门面统一导出，调用方仍然只认 `shared/orchestration.ts` 这一个入口。
export {
  MAX_MODEL_THINKING,
  normalizeModelThinking,
  resolveThinkingOptionId,
  type ModelThinkingDefault,
  type ThinkingResolutionContext,
} from "./model-thinking.ts";

// 岗位名册那一段整体在 `./staff.ts`：名册是独立领域，堆在这里只会让本文件继续变长。
// 下面的重新导出保留旧引用路径（`shared/orchestration.ts` 仍是编排的对外门面）。
export {
  DECK_STAFF_LABEL,
  MAX_STAFF_CARDS,
  MAX_STAFF_CONCURRENCY,
  MAX_STAFF_DUTY_CHARS,
  MAX_STAFF_ID_CHARS,
  MAX_STAFF_NAME_CHARS,
  MAX_STAFF_PATHS,
  MAX_STAFF_PATH_CHARS,
  isValidStaffId,
  newStaffId,
  normalizeStaffCards,
  normalizeStaffId,
  normalizeStaffPath,
  roleCarriesFields,
  staffCardOf,
  withStaffCards,
  type StaffCard,
  type StaffKind,
} from "./staff.ts";

export interface WorkspaceRoles {
  workspaceId: string;
  /** 主窗口：跟用户探讨方案的地方；回传链条的终点。 */
  mainAgentId?: string;
  /** 需求窗口：唯一允许建需求票的地方；不建工作票、不派活。 */
  requirementAgentId?: string;
  /** 派单窗口：接定稿方案、拆活、派子会话的地方。可以与主窗口是同一个。 */
  dispatcherAgentId?: string;
  /** 进度窗口：只收进度抄送的地方；没配就不抄送。 */
  progressAgentId?: string;
  /** 用户改过的身份提示词；缺的那一段回落到 `DEFAULT_ROLE_PROMPTS`。 */
  prompts?: Partial<Record<FixedRole, string>>;
  /** 岗位名册；旧文件没有这一段 = 空名册，派单行为与现在完全一致。 */
  staff?: StaffCard[];
}

/** 角色 → 槽位字段。客户端与服务端都从这里取，别处不再各写一份映射。 */
export const ROLE_AGENT_FIELD: Readonly<
  Record<FixedRole, "mainAgentId" | "requirementAgentId" | "dispatcherAgentId" | "progressAgentId">
> = Object.freeze({
  main: "mainAgentId",
  requirement: "requirementAgentId",
  dispatcher: "dispatcherAgentId",
  progress: "progressAgentId",
});

/** 某个固定窗口绑的会话 id；没配回 null。 */
export function agentIdOf(roles: WorkspaceRoles | null | undefined, role: FixedRole): string | null {
  const value = roles?.[ROLE_AGENT_FIELD[role]];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/**
 * 一个工作区的角色绑定，名册已经按目录合并过。
 *
 * 两半的归属不同，必须分开取：
 * - 会话槽位（主窗口 / 需求窗口 / 派单窗口 / 进度窗口）按 `workspaceId`——会话本来就属于具体工作区；
 * - 名册按**目录**——同一个目录在宿主里会攒出好几个 workspaceId（每次重开一个），
 *   卡若跟着 id 分开，「换个工作区打开」就等于人全没了。见 `rosterOf`。
 */
export function workspaceRolesOf(
  settings: OrchestrationSettings,
  workspaceId: string,
): WorkspaceRoles | null {
  const id = workspaceId.trim();
  const entry = settings.roles.find((role) => role.workspaceId === id) ?? null;
  const staff = rosterOf(settings);
  if (!entry) return staff.length ? { workspaceId: id, staff } : null;
  return { ...entry, ...(staff.length ? { staff } : {}) };
}

/**
 * 把一个会话写进某个角色的槽位，其它槽位与提示词原样带走。
 *
 * 用对象展开而不是逐个字段重抄：手抄漏一个字段，就是保存一次把派单窗口或用户改过的
 * 提示词抹掉——这正是这轮最容易复发的那类 bug。
 */
export function withAgentIdFor(
  roles: WorkspaceRoles | null | undefined,
  workspaceId: string,
  role: FixedRole,
  agentId: string | null,
): WorkspaceRoles {
  const next: WorkspaceRoles = { ...(roles ?? {}), workspaceId };
  delete next.mainAgentId;
  delete next.requirementAgentId;
  delete next.dispatcherAgentId;
  delete next.progressAgentId;
  const trimmed = agentId?.trim();
  if (trimmed) next[ROLE_AGENT_FIELD[role]] = trimmed;
  // 其它槽位要留：只换一个角色，不该把另外几个清空。
  for (const other of FIXED_ROLES) {
    if (other === role) continue;
    const id = agentIdOf(roles, other);
    if (id) next[ROLE_AGENT_FIELD[other]] = id;
  }
  return next;
}

/** 某个窗口该用的身份提示词：用户改过就用改过的，否则用该语言的默认值。 */
export function rolePromptFor(
  roles: WorkspaceRoles | null | undefined,
  role: FixedRole,
  lang: RoleLang = "zh",
): string {
  const custom = roles?.prompts?.[role]?.trim();
  return custom ? custom : DEFAULT_ROLE_PROMPTS[role][lang];
}

/**
 * 一张地图的并发预算：同一时刻最多几个子会话在替它干活。
 *
 * 为什么按并发而不是总量：票能不能开工由依赖决定，frontier 一般只有一两张。
 * 记「一共开几个」会在票还没解开时就把额度占光，最后剩下的那几张只能等；
 * 记「同时几个」才是能执行的那条约束——凑够数就等，凑不够就派。
 *
 * `map` 与票面的写法一致：`owner/repo#2`（跨仓库）或 `#2`（本仓库）。
 */
export interface MapBudget {
  map: string;
  concurrency: number;
}

export interface OrchestrationSettings {
  roles: WorkspaceRoles[];
  routing: RoutingRule[];
  /**
   * 客户端卡片上按「客户端 + 模型」配的默认档位。
   *
   * 旧设置文件没有这一段 = 空表，读写与派单行为都与接这个功能之前一致。
   */
  modelThinking: ModelThinkingDefault[];
  /** 主窗口 → 派单窗口 → 子会话，默认 3；到顶就不许再派。 */
  maxDepth: number;
  /** 一次派单最多建几个子会话。 */
  maxChildrenPerDispatch: number;
  /** 地图级并发预算；没有条目 = 不限制（保持接这个功能之前的行为）。 */
  mapBudgets: MapBudget[];
  /** 子会话结束时是否把结果推给上一级；关掉只写台账不推消息。 */
  reportOnFinish: boolean;
  /** 一批活至少铺在几张员工卡上同时干；1 = 不强制铺开（保持今天的行为）。 */
  minConcurrentStaff: number;
  /** 需求定稿之后、铺票之前，要不要先列清单给人看；默认 true。 */
  confirmRequirementSplit: boolean;
  /**
   * 滚动额度：每个工作区每 6 小时最多新开几个 deck 子会话。
   *
   * 单批上限（`maxChildrenPerDispatch`）只管一次，经理连着派十批谁也拦不住；
   * 上限乘上次数才是真的花费。这条在 `agent.created` 上数（见计划第二节阀门二）。
   */
  staffSessionQuota: number;
}

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_CHILDREN = 6;
export const DEFAULT_MIN_CONCURRENT_STAFF = 1;
export const DEFAULT_CONFIRM_REQUIREMENT_SPLIT = true;
/** 6 小时内的 deck 子会话额度；默认 12，0 = 关掉这道闸。 */
export const DEFAULT_STAFF_SESSION_QUOTA = 12;
export const MAX_STAFF_SESSION_QUOTA = 200;
/** 「至少铺开几张卡」的上限：与名册张数封顶同源，别再单写一个魔数。 */
export const MAX_MIN_CONCURRENT_STAFF = MAX_STAFF_CARDS;
/** 同一张地图上并行跑超过这个数，基本是失控而不是产能。 */
export const MAX_MAP_CONCURRENCY = 12;

const DEFAULT_ROUTE: ClientTarget = { provider: "claude" };

export const DEFAULT_ORCHESTRATION: OrchestrationSettings = {
  roles: [],
  routing: [],
  modelThinking: [],
  maxDepth: DEFAULT_MAX_DEPTH,
  maxChildrenPerDispatch: DEFAULT_MAX_CHILDREN,
  mapBudgets: [],
  reportOnFinish: true,
  minConcurrentStaff: DEFAULT_MIN_CONCURRENT_STAFF,
  confirmRequirementSplit: DEFAULT_CONFIRM_REQUIREMENT_SPLIT,
  staffSessionQuota: DEFAULT_STAFF_SESSION_QUOTA,
};

/**
 * 地图引用归一：`owner/repo#2` / `key#2` / `#2` 都收，别的写法一律不认。
 *
 * 比较时按小写：GitHub 的 owner/repo 本就不分大小写，项目键规则里也只有小写。
 */
export function normalizeMapRef(value: unknown): string | null {
  const raw = text(value);
  const match = /^(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)?#(\d{1,10})$/.exec(raw);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return raw.toLowerCase();
}

/** 某张地图的并发预算；没有条目回 null（= 不限制）。 */
export function mapBudgetOf(
  budgets: readonly MapBudget[],
  map: string | null | undefined,
): MapBudget | null {
  const wanted = normalizeMapRef(map);
  if (!wanted) return null;
  return budgets.find((budget) => budget.map === wanted) ?? null;
}


/** `provider/model` → 两段；没有 `/` 时 model 为 undefined。 */
export function parseProviderSpec(spec: string): { provider: string; model?: string } {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { provider: trimmed };
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  return model ? { provider, model } : { provider };
}

/**
 * `provider/model` → 归一后的客户端 id（小写、去空白）；没有 id 时是空串。
 *
 * 凡是按「哪家客户端」下判断的地方都走这一个入口：标签、提示词方言、预授权能力……
 * 三处各写一遍 `split("/")[0]` 迟早分叉（`Claude/sonnet` 在一处认得出、在另一处认不出）。
 */
export function providerId(spec: string | undefined): string {
  return parseProviderSpec(spec ?? "").provider.trim().toLowerCase();
}

/**
 * Codex 站点使用的派生 provider id（`extends: "codex"`）。
 *
 * 为什么非要派生一条：宿主的 Codex 适配器只在「请求的 provider 是派生条目且
 * `env.OPENAI_BASE_URL` 非空」时才生成 `model_providers`；写在内建 `codex` 上的
 * 地址它根本不读，会话会退回 `~/.codex/config.toml`。名字由插件自己写定，
 * 所以写配置、读配置、建会话路由这三处共用这一个常量，别各写一遍字符串。
 */
export const CODEX_SITE_PROVIDER = "deck-codex";

/**
 * 派生条目在宿主里的显示名（Paseo 自己的模型选择器/设置里看到的那一行）。
 *
 * 与 id 分开：id 是路由用的键，改一次就断一批配置；显示名只是给人看的。
 * 三处建/改派生条目（接管旧式地址、启用站点、保存模型）共用这一个常量，
 * 免得某个窗口里出现「Deck Codex」、另一个窗口是别的名字。这是一句**用户可见的界面文案**，
 * 不做中文化：宿主界面本身是英文的，混排更难认。
 */
export const CODEX_SITE_LABEL = "Deck Codex";

/**
 * 插件真能为它配接入地址的客户端：Claude / Codex。
 *
 * 其余家（OpenCode、Copilot、Cursor、Pi、Oh My Pi、Antigravity、Muse Code……）在宿主里
 * 没有读 `*_BASE_URL` 的路径，插件写进去的地址与凭证不会被任何会话用上（OpenCode
 * 只有前缀约定，没有实证）。界面上把它们列出来，只会让人以为「配好了」，其实一句
 * 也没生效——所以客户端列表与模型选择器都只留这两家。被隐藏的家不逐条告警（宿主
 * 动辄报出七八家，会变成页面顶部常驻噪音），口径写在客户端页的说明行里
 * （`orch.clientsScope`）。
 *
 * 别和另外两份名单合并——判的是别的事：`server/hooks.ts` 的
 * `EXACT_MCP_PREAPPROVAL_PROVIDERS`（宿主能不能精确预授权，含 OpenCode）与
 * `shared/session.ts` 的 `SLASH_PROVIDERS`（提示词方言）。宿主改契约时三份会分头变。
 */
export const SUPPORTED_CLIENTS = ["claude", "codex"] as const;

/** 上面那两家的显示名，拼成告警里那一句：印裸 id 会和客户端页的写法不一致。 */
export const SUPPORTED_CLIENTS_LABEL = "Claude / Codex";

/** 客户端 id 归一（小写、去空白）后是否在支持范围内。 */
export function isSupportedClient(id: string | undefined): boolean {
  return (SUPPORTED_CLIENTS as readonly string[]).includes((id ?? "").trim().toLowerCase());
}

/**
 * 该不该出现在客户端列表与模型选择器里：支持的两家，且不是插件自己造的派生 provider。
 *
 * `deck-codex` 的地址与模型已经并到 `codex` 那一行显示，单列只会让人以为多了一家。
 * 列表与选择器两处共用这一个判断，别各写一遍（新加派生 provider 时只改这里）。
 */
export function isListedClient(id: string | undefined): boolean {
  const normalized = (id ?? "").trim().toLowerCase();
  return isSupportedClient(normalized) && normalized !== CODEX_SITE_PROVIDER;
}

/** 反向：宿主 `config.provider` 收的是 `provider/model` 一段字符串。 */
export function providerSpec(target: ClientTarget): string {
  const provider = target.provider.trim();
  const model = target.model?.trim() ?? "";
  return model ? `${provider}/${model}` : provider;
}

/** 按难度取规则：精确档位 → normal → 内置兜底。永远返回一条，界面不留空白。 */
export function resolveRoute(
  settings: { routing: readonly RoutingRule[] },
  difficulty: Difficulty,
): RoutingRule {
  const exact = settings.routing.find((rule) => rule.difficulty === difficulty);
  if (exact) return exact;
  const normal = settings.routing.find((rule) => rule.difficulty === "normal");
  if (normal) return normal;
  return { difficulty, target: DEFAULT_ROUTE };
}

/**
 * 这一档是不是「借来的」路由。
 *
 * `resolveRoute` 会退到 `normal`，再退到内置默认目标——两种兜底都可能让
 * 一件难活跑在轻量模型上。这里只回答「借了谁的」，好让派单方把话说清楚。
 */
export function routeFromOf(
  routing: readonly RoutingRule[],
  difficulty: Difficulty,
): { routeFrom?: Difficulty | "default" } {
  if (routing.some((rule) => rule.difficulty === difficulty)) return {};
  const borrowed = routing.find((rule) => rule.difficulty === "normal");
  return { routeFrom: borrowed ? "normal" : "default" };
}

export type RouteFailureReason = "profile-missing" | "no-target" | "no-model";

export type RouteResolution =
  | { ok: true; target: ClientTarget; via: "profile" | "target" }
  | { ok: false; reason: RouteFailureReason; detail: string };

/**
 * 目标能不能真的发出去。
 *
 * 宿主 SDK 的 `create_agent` 对 `config.provider` 是硬校验：只认 `provider/model`，
 * 少一段就直接抛 `Expected config.provider in "provider/model" format`——而且是在
 * **建会话**那一刻。等它报错，窗口可能已经建过、票可能已经建过，所以校验放在路由
 * 解析这一层：碰任何东西之前就说清楚缺什么。
 */
export function targetProblem(
  target: ClientTarget,
): { reason: "no-target" | "no-model"; detail: string } | null {
  const provider = target.provider.trim();
  if (!provider) return { reason: "no-target", detail: "这一档没有客户端" };
  if (!target.model?.trim()) {
    return {
      reason: "no-model",
      detail: `这一档只选了客户端 ${provider}、没有模型：宿主只认 provider/model，填一个模型（例如 ${provider}/sonnet）才能发出去`,
    };
  }
  return null;
}

/** 把解析出的档位写进目标；返回新对象，不动入参。没有档位就保持不传。 */
export function withResolvedThinking(
  target: ClientTarget,
  context: ThinkingResolutionContext = {},
): ClientTarget {
  const thinkingOptionId = resolveThinkingOptionId(target, context);
  const next: ClientTarget = { ...target };
  if (thinkingOptionId) next.thinkingOptionId = thinkingOptionId;
  else delete next.thinkingOptionId;
  return next;
}

/**
 * 规则 → 具体会话配置。
 *
 * 档案优先；档案 id 指过去但已经被删掉时**不静默降级到别的档案**：
 * 有 `target` 才用 target，否则明确报错，让界面显示「这条路由坏了」。
 *
 * 少模型也算坏：宿主不会为「只有客户端」的目标兜底，这一档在补上模型之前发不出去。
 *
 * `thinking` 是卡片里按模型配的默认档：解析出的目标已经合成了最终要传的档位，
 * 派单 / 改派 / 建派单窗口 / 群发 / MCP `deck_dispatch_plan`，外加状态预览与需求批次
 * 预览，都走这一处，不各自再算一遍。
 */
export function resolveRouteTarget(
  rule: RoutingRule,
  profiles: readonly ClientProfile[],
  thinking: ThinkingResolutionContext = {},
): RouteResolution {
  const profileId = rule.profileId?.trim();
  if (profileId) {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (profile) {
      const target: ClientTarget = {
        provider: profile.provider,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.modeId ? { modeId: profile.modeId } : {}),
        ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
        ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
      };
      const problem = targetProblem(target);
      if (problem) {
        // 档案是宿主那边的东西，说清楚是「这份档案不完整」，别让人去改路由。
        return {
          ok: false,
          reason: problem.reason,
          detail: `客户端档案 ${profile.name?.trim() || profile.id}：${problem.detail}`,
        };
      }
      return { ok: true, via: "profile", target: withResolvedThinking(target, thinking) };
    }
    if (!rule.target) {
      return {
        ok: false,
        reason: "profile-missing",
        detail: `客户端档案 ${profileId} 已不存在，且这一档没有兜底配置`,
      };
    }
  }
  if (rule.target?.provider.trim()) {
    const problem = targetProblem(rule.target);
    if (problem) return { ok: false, reason: problem.reason, detail: problem.detail };
    return { ok: true, via: "target", target: withResolvedThinking(rule.target, thinking) };
  }
  return { ok: false, reason: "no-target", detail: "这一档既没有档案也没有兜底 provider" };
}

// ---------------------------------------------------------------------------
// 难度来源
// ---------------------------------------------------------------------------

/**
 * 票面标签可以写成 `difficulty:hard` / `difficulty=hard` / `difficulty/hard`，
 * 以及带我们自己的键名 `deck.difficulty:hard` / `deck.difficulty=hard` / `deck:difficulty:hard`。
 *
 * 说明白一点：目前**没有任何代码会自动往票上写难度标签**——难度是派单时由调用方给的，
 * 或者由人手动打这种标签。这里只保证「人按这几种写法打了，读得出来」，不假定某一种「真实写法」。
 */
const DIFFICULTY_LABEL_PREFIXES = [
  "difficulty:",
  "difficulty=",
  "difficulty/",
  "deck.difficulty:",
  "deck.difficulty=",
  "deck:difficulty:",
  "deck:difficulty=",
];

/**
 * 从票面标签推难度。
 *
 * 只认精确档位名；认不出就返回 null 交给调用方按 normal 处理，
 * 不做「含 hard 字样就算 hard」这种模糊匹配。
 */
export function difficultyFromLabels(labels: readonly string[] | undefined): Difficulty | null {
  if (!labels) return null;
  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    for (const prefix of DIFFICULTY_LABEL_PREFIXES) {
      if (!label.startsWith(prefix)) continue;
      const value = label.slice(prefix.length).trim();
      if (isDifficulty(value)) return value;
    }
  }
  return null;
}

/** 反过来：把档位写成标签名。写与读必须同一套前缀，所以两个函数挨着放。 */
export function difficultyLabel(tier: Difficulty): string {
  return `difficulty:${tier}`;
}

/**
 * 「这张票交给哪个客户端」——只写客户端，不写模型。
 *
 * 模型跟着档位走（档位 → 路由 → 客户端 + 模型），票上再抄一份就会与路由打架：
 * 改了路由而票上还写着旧模型，没人知道该信哪一个。
 */
export function clientLabel(providerSpec: string): string {
  const provider = providerId(providerSpec);
  return `client:${provider}`;
}

// ---------------------------------------------------------------------------
// 标签：父子关系与来源
// ---------------------------------------------------------------------------

/** 宿主自己的父子标签；子会话由 `create_agent` 建出来时 daemon 会写。 */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";

/** 我们自己打的标：区分「这个子会话是 deck 派出来的」和普通会话。 */
export const DECK_CHILD_LABEL = "deck.child";
export const DECK_TICKET_LABEL = "deck.ticket";

/**
 * `deck.ticket` 标签的写法。
 *
 * 多仓库工作区里「#12」可能有两张：写全 `owner/repo#12` 才能让履历反查读到对的那张。
 * 本地后端给的仓库键是 `local` 这类合成值，不带 `/`，写进标签只会多一段噪声——
 * 那种情况仍写 `#12`。
 */
export function ticketLabelOf(repoKey: string | null | undefined, number: number): string {
  const key = (repoKey ?? "").trim();
  return key.includes("/") ? `${key}#${number}` : `#${number}`;
}

export const DECK_DIFFICULTY_LABEL = "deck.difficulty";
export const DECK_DISPATCH_LABEL = "deck.dispatch";
/** 这个子会话是名册里的哪张卡在干；岗位履历按它反查。定义在 `./staff.ts`，上面已重新导出。 */
/** 这个会话是四个固定窗口里的哪一个；会话树与面板按它认人。 */
export const DECK_ROLE_LABEL = "deck.role";
/** 标记「这是插件建出来的固定窗口」，与派单产生的子会话区分开。 */
export const DECK_ROLE_WINDOW_LABEL = "deck.role.window";
/**
 * 这个子会话在替哪张地图干活。
 *
 * 地图级并发预算全靠它数人：没有这个标，下一次派单就不知道「已经有两个在跑了」。
 */
export const DECK_MAP_LABEL = "deck.map";

export interface ChildLabelInput {
  dispatcherAgentId: string;
  /** 票号或地图条目键，例如 `owner/repo#12`。 */
  ticketKey?: string;
  /** 这张票属于哪张地图；有值才写标，数预算靠它。 */
  map?: string;
  difficulty: Difficulty;
  /** 同一次派单的批次号，便于一次撤掉。 */
  dispatchId?: string;
  /** 名册上的哪张卡在干；有才写标，岗位履历按它反查。 */
  staffId?: string;
}

/**
 * 子会话标签。
 *
 * `paseo.parent-agent-id` 自己写一遍：SDK 的 `agents.create` 只有传了 `parent` 才写它，
 * 而我们还想要「即使父会话被归档也能追回这笔派单」，所以标签与 `parent` 参数两边都给。
 */
export function buildChildLabels(input: ChildLabelInput): Record<string, string> {
  const labels: Record<string, string> = {
    [DECK_CHILD_LABEL]: "1",
    [PARENT_AGENT_ID_LABEL]: input.dispatcherAgentId,
    [DECK_DIFFICULTY_LABEL]: input.difficulty,
  };
  if (input.ticketKey?.trim()) labels[DECK_TICKET_LABEL] = input.ticketKey.trim();
  const map = normalizeMapRef(input.map);
  if (map) labels[DECK_MAP_LABEL] = map;
  if (input.dispatchId?.trim()) labels[DECK_DISPATCH_LABEL] = input.dispatchId.trim();
  const staff = normalizeStaffId(input.staffId);
  if (staff) labels[DECK_STAFF_LABEL] = staff;
  return labels;
}

/** 一个子会话标签里记的地图引用；没写就是 null。 */
export function readMapLabel(labels: Readonly<Record<string, string>> | undefined): string | null {
  return normalizeMapRef(labels?.[DECK_MAP_LABEL]);
}

export function readParentAgentId(labels: Readonly<Record<string, string>> | undefined): string | null {
  const value = labels?.[PARENT_AGENT_ID_LABEL]?.trim();
  return value ? value : null;
}

/** deck 派出来的子会话（有我们自己的标；不把宿主别的子代理算进来）。 */
export function isDeckChild(labels: Readonly<Record<string, string>> | undefined): boolean {
  return labels?.[DECK_CHILD_LABEL] === "1";
}

// ---------------------------------------------------------------------------
// 派单计划
// ---------------------------------------------------------------------------

export interface DispatchTaskInput {
  /** 任务在本批次里的稳定键，用作幂等键的一部分。 */
  key: string;
  title?: string;
  prompt: string;
  /** 不传就按 normal。 */
  difficulty?: Difficulty;
  /** 这条任务在替哪张地图干活；不传就看批次上的 `map`，都没有就不受地图预算约束。 */
  map?: string;
  /**
   * 这条任务落在哪个仓库（多仓库工作区必填）。
   *
   * 工作区是个容器目录时，票写进哪个仓库不能靠猜：两个仓库同一天各建一张 #12，
   * 猜错就是两张票互相顶掉。单仓库不填。
   */
  repoKey?: string;
  /**
   * 派给名册里的哪张卡。
   *
   * 名册非空时**必填**：没写就拒，而不是猜一个人。名册为空时可以不写，
   * 行为与接这个功能之前完全一致（按难度路由）。
   */
  staff?: string;
  /**
   * 这条任务落在哪片（仓库 + 路径前缀）。
   *
   * `staff` 给了就以它为准；没给才按 `region` 走归属算法选卡。名册非空、
   * 又没给 `staff` 也没给 `region` 时拒绝——不猜人。
   */
  region?: DispatchRegion;
  /**
   * 这条活挂在哪条需求票下。
   *
   * 只用于「需求 → 每区一张票」那条路：票面写 `需求：#N`，同仓库时再挂一条父边。
   * 普通派单不传，行为与接这个字段之前完全一致。
   */
  requirementKey?: number;
  /**
   * 需求票正文。内部调用方（需求拆票）已经读过时直接给，执行层不再按票号重读；
   * RPC 入参不暴露这一位，所以远端调用方仍然只能靠读票拿正文。
   */
  requirementBody?: string;
  /**
   * 需求票自己所在的仓库。
   *
   * 不能用任务的 `repoKey` 代替：那是**子票**落哪个仓库。需求在 A、子票在 B 时，
   * 拿 B 去判断父边能不能挂，会把 B 里的同号票误当成需求票。
   */
  requirementRepoKey?: string;
}

export interface DispatchRegion {
  /** 多仓库工作区里这条活落在哪个仓库；单仓库不写。 */
  repoKey?: string;
  /** 相对工作区根的目录前缀；不写 = 整片。 */
  pathPrefix?: string;
}

export type DispatchRejection =
  | "unknown-workspace"
  | "no-dispatcher"
  | "depth-exceeded"
  | "too-many-children"
  | "empty-prompt"
  | "duplicate-key"
  | "route-unavailable"
  | "map-budget-exhausted"
  | "unknown-staff"
  | "min-concurrent-staff"
  | "repo-required"
  | "invalid-region"
  /** 名册非空、没写 staff，也没给 region：不猜人，也不猜区。 */
  | "region-required"
  /** region 里没有任何一张卡覆盖这片：不回落成根经理或随便一张卡。 */
  | "region-unowned"
  /** 这条任务没挂需求票：无票不干活。 */
  | "no-requirement"
  /** 需求票读不出来：无法确认它定没定稿。 */
  | "requirement-unreadable"
  /** 需求票没有 `deck:定稿`：先谈完、核完影响面再派。 */
  | "requirement-not-finalized";

export interface DispatchTask extends DispatchTaskInput {
  difficulty: Difficulty;
  target: ClientTarget;
  providerSpec: string;
  labels: Record<string, string>;
  idempotencyKey: string;
  /** 派给哪张卡；名册为空时没有这个字段。 */
  staffId?: string;
  /** 这条任务落在哪个仓库；单仓库时没有这个字段。 */
  repoKey?: string;
  /** 这张卡的职责提示词；建会话时写进 `config.systemPrompt`。 */
  systemPrompt?: string;
  /**
   * 这一档没配路由时，实际借用的是哪一档的规则；一档都没配时是 `default`。
   *
   * 借了就必须说出来：`critical` 悄悄跑在 `normal` 的模型上，是这套编排最容易出事的地方。
   * 完全没配（`default`）时用的是内置默认目标，更要让调用方自己决定要不要照办。
   */
  routeFrom?: Difficulty | "default";
}

export interface DispatchRejected {
  key: string;
  title?: string;
  reason: DispatchRejection;
  detail: string;
}

export interface DispatchPlan {
  dispatchId: string;
  dispatcherAgentId: string | null;
  tasks: DispatchTask[];
  rejected: DispatchRejected[];
}

export interface DispatchPlanInput {
  workspaceId: string;
  roles: readonly WorkspaceRoles[];
  routing: readonly RoutingRule[];
  profiles: readonly ClientProfile[];
  tasks: readonly DispatchTaskInput[];
  maxDepth: number;
  maxChildrenPerDispatch: number;
  /** 地图级并发预算；不传 = 不限制（与接这个功能之前一样）。 */
  mapBudgets?: readonly MapBudget[];
  /**
   * 每张地图上「已经开着」的子会话数。
   *
   * 只有拿得到宿主会话清单的调用方（面板派单）能给；拿不到的（MCP 工具）留空，
   * 这时预算退化成「这一批之内」的约束，且调用方要把这件事说出来。
   */
  runningByMap?: Readonly<Record<string, number>>;
  /** 这一批任务默认替哪张地图干活（逐条可以用 `task.map` 覆盖）。 */
  map?: string;
  /** 派单窗口现在是第几层；主窗口是 0，派单窗口是 1。 */
  depth: number;
  dispatchId: string;
  /** 一批活至少铺在几张卡上；不传 = 1（不强制铺开）。 */
  minConcurrentStaff?: number;
  /**
   * 这个工作区里可写的仓库。多于一个时，任务必须写明 `repoKey`——
   * 否则「票写到哪个仓库」只能靠猜，而建票那一步的报错已经太晚（会话可能已经开了）。
   */
  repoKeys?: readonly string[];
  /**
   * 实际在调派单的那个会话。
   *
   * 有它就用它写 `paseo.parent-agent-id` 与提示词抬头：宿主的父子关系挂在真实调用者身上，
   * 标签却写配置里的派单窗口时，会话树（按标签拼）和回传链（按宿主 `parentAgentId`）会指向
   * 两个不同会话。角色绑定仍是放行条件，这里只解决「写给谁看」。
   */
  callerAgentId?: string;
  /**
   * 卡片上按模型配的默认档 + 当前可选模型。
   * 不传 = 与接这个功能之前完全一致：只认档案 / 路由里显式写的档位。
   */
  thinking?: ThinkingResolutionContext;
}

function stableKey(parts: readonly (string | number | undefined)[]): string {
  let hash = 0x811c9dc5;
  const material = parts.map((part) => String(part ?? "")).join("\u0000");
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 出派单计划。
 *
 * 纯函数：界面先拿它做预览（每条会落到哪个客户端、会不会被拒），
 * 服务端执行前再跑一遍同一份逻辑，预览与实际不会说两套话。
 * 拒绝项逐条保留，不因为一条不可用就把整批停掉。
 */
export function planDispatch(input: DispatchPlanInput): DispatchPlan {
  const entry = input.roles.find((role) => role.workspaceId === input.workspaceId);
  const configuredDispatcher = entry?.dispatcherAgentId?.trim() || null;
  const rejected: DispatchRejected[] = [];
  const tasks: DispatchTask[] = [];

  const reject = (task: DispatchTaskInput, reason: DispatchRejection, detail: string) => {
    rejected.push({ key: task.key, ...(task.title ? { title: task.title } : {}), reason, detail });
  };

  if (!entry) {
    // 「这个工作区没绑定」和「绑定了但没选派单窗口」是两回事，提示不同：
    // 前者要去补一条角色，后者只要在已有的那条里填个会话。
    for (const task of input.tasks) {
      reject(task, "unknown-workspace", "这个工作区没有任何角色绑定：先到「编排」里加一条工作区角色");
    }
    return { dispatchId: input.dispatchId, dispatcherAgentId: null, tasks, rejected };
  }
  if (!configuredDispatcher) {
    for (const task of input.tasks) {
      reject(task, "no-dispatcher", "这个工作区还没有指定派单窗口：先到「编排」里选一个会话");
    }
    return { dispatchId: input.dispatchId, dispatcherAgentId: null, tasks, rejected };
  }
  // 放行看绑定，写标签看真实调用者（见 `callerAgentId` 的注释）。
  const dispatcherAgentId = input.callerAgentId?.trim() || configuredDispatcher;
  if (input.depth + 1 > input.maxDepth) {
    for (const task of input.tasks) {
      reject(task, "depth-exceeded", `已经到第 ${input.depth} 层，上限是 ${input.maxDepth} 层`);
    }
    return { dispatchId: input.dispatchId, dispatcherAgentId, tasks, rejected };
  }

  // 名册按目录合并：同一目录在宿主里可能有好几个 workspaceId，卡不该跟着 id 分开。
  // 槽位（派单窗口）仍按 id 取——会话本来就属于具体工作区。
  const roster = rosterOf({ roles: input.roles });
  const roles: WorkspaceRoles = { ...entry, ...(roster.length ? { staff: roster } : {}) };
  // 名册为空 = 今天的行为（按难度路由、不写 `deck.staff` 标），一个字都不该变。
  const minStaff = Math.max(1, Math.round(input.minConcurrentStaff ?? DEFAULT_MIN_CONCURRENT_STAFF));
  // 「至少铺开几张」是速度旋钮，不是硬塞：任务比人少时按任务数算。
  const wanted = Math.min(minStaff, input.tasks.length);
  const rejectAll = (detail: string, keys: readonly DispatchTaskInput[]): DispatchPlan => {
    for (const task of keys) reject(task, "min-concurrent-staff", detail);
    return { dispatchId: input.dispatchId, dispatcherAgentId, tasks: [], rejected };
  };
  const workers = roster.filter((card) => card.kind !== "manager");
  if (minStaff > input.maxChildrenPerDispatch) {
    // 两个上限互相打架：一批最多派 M 个，却要求铺 N 张卡。照做也永远达不到，
    // 而提示说「拆给不同的人」会把人带到错的方向——真实瓶颈是单批上限。
    return rejectAll(
      `要求一批至少铺在 ${minStaff} 张员工卡上，但一次最多只能派 ${input.maxChildrenPerDispatch} 个：先把「一次最多派几个」调大，或把「至少铺开几张」调小`,
      input.tasks,
    );
  }
  if (wanted > 1 && workers.length < wanted) {
    // 不悄悄降到「能派多少算多少」：那会让人以为调了旋钮、其实没调。
    return rejectAll(
      `要求一批至少铺在 ${wanted} 张员工卡上，但名册里只有 ${workers.length} 张员工卡（经理卡不算）：先加人，或把这个数调小`,
      input.tasks,
    );
  }

  const seen = new Set<string>();
  let accepted = 0;
  // 每张地图这一批已经占掉的并发名额（宿主上开着的由 `runningByMap` 单独给）。
  const usedByMap = new Map<string, number>();
  const usedOf = (map: string): number => usedByMap.get(map) ?? 0;
  const batchMap = normalizeMapRef(input.map);
  for (const task of input.tasks) {
    const key = task.key.trim();
    if (!key) {
      reject(task, "duplicate-key", "任务键为空，无法生成幂等键");
      continue;
    }
    if (seen.has(key)) {
      reject({ ...task, key }, "duplicate-key", `任务键 ${key} 在本批次里重复`);
      continue;
    }
    seen.add(key);
    if (!task.prompt.trim()) {
      reject({ ...task, key }, "empty-prompt", "提示词为空");
      continue;
    }
    if (accepted >= input.maxChildrenPerDispatch) {
      reject({ ...task, key }, "too-many-children", `一次最多派 ${input.maxChildrenPerDispatch} 个`);
      continue;
    }
    // region 是「这条活落在哪片」：先归一，归属算法与票面都要用它。
    // `..` 不折叠也不放过——一条能跳出工作区的路径会让领地判定彻底失效。
    const rawPrefix = text(task.region?.pathPrefix);
    const regionPrefix = rawPrefix ? normalizeStaffPath(rawPrefix) : "";
    if (rawPrefix && (!regionPrefix || regionPrefix.split("/").includes(".."))) {
      reject(
        { ...task, key },
        "invalid-region",
        `region.pathPrefix 只能写工作区内部的路径（不能有 ..）：${rawPrefix}`,
      );
      continue;
    }
    // `repoKey` 与 `region.repoKey` 是同一件事的两种写法：老的调用方只写前者。
    const effectiveRepo = text(task.repoKey) || text(task.region?.repoKey);

    // 多仓库工作区：票写到哪个仓库不能靠猜。这里就拒，别等到建票那一步才报错
    // （那时会话可能已经开了，钱已经花了）。
    if ((input.repoKeys?.length ?? 0) > 1) {
      if (!effectiveRepo) {
        reject(
          { ...task, key },
          "repo-required",
          `这个工作区有 ${input.repoKeys?.length} 个仓库（${input.repoKeys?.join(" / ")}），每条任务必须写明 repoKey（或 region.repoKey）`,
        );
        continue;
      }
      if (!input.repoKeys?.includes(effectiveRepo)) {
        // 拼错 / 指向一个被跳过的仓库：在这儿说清可选值，别等建票那一步才报。
        reject(
          { ...task, key },
          "repo-required",
          `这个工作区里没有「${effectiveRepo}」这个仓库：可选 ${input.repoKeys?.join(" / ")}`,
        );
        continue;
      }
    }
    const taskMap = normalizeMapRef(task.map) ?? batchMap;
    const budget = taskMap ? mapBudgetOf(input.mapBudgets ?? [], taskMap) : null;
    if (budget && taskMap) {
      // 已经开着的 + 这一批刚才放行的：两个都算，否则一次派 5 条能把上限当空气。
      const used = (input.runningByMap?.[taskMap] ?? 0) + usedOf(taskMap);
      if (used >= budget.concurrency) {
        reject(
          { ...task, key },
          "map-budget-exhausted",
          `地图 ${budget.map} 同时最多跑 ${budget.concurrency} 个子会话，现在已经有 ${used} 个（开着的与本批已放行的都算）：等一个结束再派`,
        );
        continue;
      }
    }
    // 名册非空时「派给谁」必须有确定答案：给了 staff 就用它，没给就按 region 算。
    // 两条都没有时拒绝——猜一个人比拒绝更贵，猜一个区同样会把活交给错的人。
    let card: StaffCard | null = null;
    if (roster.length) {
      const wantedStaff = text(task.staff);
      if (wantedStaff) {
        card = staffCardOf(roles, wantedStaff);
        if (!card) {
          reject(
            { ...task, key },
            "unknown-staff",
            `名册里没有 id 为「${wantedStaff}」的卡：可选 ${roster.map((item) => item.id).join(" / ")}`,
          );
          continue;
        }
      } else {
        if (task.region === undefined && !effectiveRepo) {
          reject(
            { ...task, key },
            "region-required",
            `名册里有 ${roster.length} 张卡：要么写明派给谁（staff），要么写清这片活在哪（region.repoKey / region.pathPrefix），由归属算法选卡`,
          );
          continue;
        }
        // 和越界拦截同一把尺子：先经理层、再员工层。命中经理 = 这一跳交给它，
        // 命中根经理（名册里没有卡）= 区里没人，明确拒绝，不回落。
        const ownershipPath = regionPrefix || effectiveRepo;
        const owner = resolveOwner({
          path: ownershipPath,
          roster,
          workspaceId: input.workspaceId,
        });
        if (!owner.ok) {
          reject(
            { ...task, key },
            "region-unowned",
            `region（${ownershipPath || "整片"}）没有卡覆盖：${owner.detail}先补一张负责这片的卡，或在任务上写明 staff`,
          );
          continue;
        }
        if (owner.staff.id === null) {
          reject(
            { ...task, key },
            "region-unowned",
            `region（${ownershipPath || "整片"}）归根经理自己，没有名册卡覆盖这片：先补一张负责这片的员工 / 经理卡，或在任务上写明 staff`,
          );
          continue;
        }
        card = roster.find((item) => item.id === owner.staff.id) ?? null;
        if (!card) {
          reject(
            { ...task, key },
            "unknown-staff",
            `归属算法给出「${owner.staff.id}」，但名册里找不到这张卡：可选 ${roster.map((item) => item.id).join(" / ")}`,
          );
          continue;
        }
      }
    }
    const difficulty: Difficulty = task.difficulty ?? "normal";
    // 卡上写了档案就按档案走，没写才按难度路由——见第一节。
    const rule = card?.profileId
      ? { difficulty, profileId: card.profileId }
      : resolveRoute({ routing: input.routing }, difficulty);
    const resolution = resolveRouteTarget(rule, input.profiles, input.thinking);
    if (!resolution.ok) {
      reject({ ...task, key }, "route-unavailable", resolution.detail);
      continue;
    }
    const target = resolution.target;
    accepted += 1;
    // 放行的才占名额，被拒的不占：否则一批里前面几条失败会把后面的额度吃掉。
    if (taskMap) usedByMap.set(taskMap, usedOf(taskMap) + 1);
    tasks.push({
      ...task,
      key,
      ...(taskMap ? { map: taskMap } : {}),
      difficulty,
      target,
      providerSpec: providerSpec(target),
      // 卡上有档案时「借了谁的档」没有意义：不是从难度表里借来的。
      ...(card?.profileId ? {} : routeFromOf(input.routing, difficulty)),
      ...(card ? { staffId: card.id } : {}),
      ...(card?.duty ? { systemPrompt: card.duty } : {}),
      ...(effectiveRepo ? { repoKey: effectiveRepo } : {}),
      // 归一后的领地随计划一起交出去：下游按它算归属、拼票面，不用再猜一次。
      ...(task.region && (effectiveRepo || regionPrefix)
        ? {
            region: {
              ...(effectiveRepo ? { repoKey: effectiveRepo } : {}),
              ...(regionPrefix ? { pathPrefix: regionPrefix } : {}),
            },
          }
        : {}),
      labels: buildChildLabels({
        dispatcherAgentId,
        difficulty,
        dispatchId: input.dispatchId,
        ...(task.key ? { ticketKey: task.key } : {}),
        ...(taskMap ? { map: taskMap } : {}),
        ...(card ? { staffId: card.id } : {}),
      }),
      idempotencyKey: `deck-dispatch-${stableKey([input.workspaceId, key, input.dispatchId])}`,
    });
  }

  // 铺开度按**真的放行的**那些任务算：被拒的任务、写了名册里没有的 id 的任务、派给经理的
  // 任务都不该被当成人头——否则「实际上只铺到 2 张卡」的批次会照样过闸，
  // 而这条闸的全部意义就是防止「你以为在并行，其实没有」。
  if (wanted > 1) {
    const workerIds = new Set(workers.map((card) => card.id));
    const spread = new Set(
      tasks
        .map((task) => task.staffId)
        .filter((id): id is string => typeof id === "string" && workerIds.has(id)),
    );
    if (spread.size < wanted) {
      return rejectAll(
        `要求一批至少铺在 ${wanted} 张员工卡上，这一批实际只铺到 ${spread.size} 张：把这批活拆给不同的人`,
        tasks,
      );
    }
  }

  return { dispatchId: input.dispatchId, dispatcherAgentId, tasks, rejected };
}

// ---------------------------------------------------------------------------
// 子任务提示词
// ---------------------------------------------------------------------------

export interface DispatchPreambleInput {
  lang?: "zh" | "en";
  dispatcherAgentId: string;
  difficulty: Difficulty;
  ticketKey?: string;
  /** 子会话是第几层；主窗口直接派就是 1。 */
  depth: number;
}

/**
 * 派单提示词的抬头。
 *
 * 三件事必须在子会话的第一次输入里说清，否则回传链条就断了：
 * 谁是派你的窗口、你干完要调 `deck_handoff` 写结果、没写就等于没回传。
 * 不重复任务本身——任务正文由调用方拼在后面。
 */
export function buildDispatchPreamble(input: DispatchPreambleInput): string {
  const zh = input.lang !== "en";
  const ticket = input.ticketKey?.trim();
  const lines = zh
    ? [
        `[派单] 你是派单窗口 ${input.dispatcherAgentId} 的子会话（第 ${input.depth} 层，难度 ${input.difficulty}${ticket ? `，票 ${ticket}` : ""}）。`,
        "干完后调用 `deck_handoff` 写回结果（status / summary / done / nextSteps / files / blocking）；" +
          "没有这一步，你的成果不会回到上一级。完成前不要把没做的事写成已完成。",
        "收回尾：`deck_issue_patch` 同一次调用里带 `comment`（验证证据）与 `close:true`，把证据写上并关票；" +
          "分两次调用会被闸门拒掉。没做完就只写评论、写明缺口，不要关。",
      ]
    : [
        `[dispatch] You are a child session of dispatcher ${input.dispatcherAgentId} (depth ${input.depth}, difficulty ${input.difficulty}${ticket ? `, ticket ${ticket}` : ""}).`,
        "When you finish, call `deck_handoff` with status / summary / done / nextSteps / files / blocking; " +
          "without it your work is never reported upward. Never present unfinished work as done.",
        "Close the loop: call `deck_issue_patch` once with `comment` (the verification evidence) and `close:true`; " +
          "two separate calls are rejected by the close guard. If it is unfinished, comment on the gap and leave the ticket open.",
      ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 派单建的票
// ---------------------------------------------------------------------------

export interface DispatchTicketSpecInput {
  key: string;
  prompt: string;
  title?: string;
  difficulty: Difficulty;
  /** `provider` 或 `provider/model`：票上只写客户端，模型进正文。 */
  providerSpec: string;
  dispatchId: string;
  dispatcherAgentId: string;
  depth: number;
  map?: string;
  /** 这一档的路由是借来的：写进正文，免得日后以为难活跑在强模型上。 */
  routeFrom?: Difficulty | "default";
  /** 这张票派给名册上的哪张卡：票面上要写清楚，会话没了也查得到是谁干的。 */
  staff?: { id: string; name: string };
  /** 哪个工作区；多工作区里「哪个区」是第一眼要看对的。 */
  workspaceId?: string;
  /** 多仓库工作区里票写进了哪个仓库。 */
  repoKey?: string;
  /**
   * 这张票挂回哪条需求票。
   *
   * `repoKey` 用来判断父边能不能挂：GitHub / GitLab 的父子边跨不了仓库，
   * 跨仓库时只在正文留 `Refs: #N`，不硬挂到别人仓库的同号票下面。
   */
  requirement?: { number: number; repoKey?: string };
}

export interface DispatchTicketSpec {
  title: string;
  body: string;
  labels: string[];
}

/** 票标题最多放多少字：再长列表里就看不出是哪条活了。 */
const TICKET_TITLE_MAX = 72;

/** 从任务正文里取一行当标题：去掉列表/标题记号，挤掉换行与多余空格。 */
function firstLineTitle(prompt: string): string {
  for (const raw of prompt.split("\n")) {
    const line = raw
      .replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    return line.length > TICKET_TITLE_MAX ? `${line.slice(0, TICKET_TITLE_MAX - 1)}…` : line;
  }
  return "";
}

/**
 * 从「一条放行的任务 + 它的卡」拼出票面入参。
 *
 * 两处调用（MCP 预览 `deck_dispatch_plan`、服务端自动派单 `runDispatch`）必须拼出同一张票；
 * 各自手抄十五个字段的话，加一个抬头字段就会有一处漏掉。
 */
export function ticketSpecOf(input: {
  task: Pick<
    DispatchTask,
    "key" | "prompt" | "title" | "difficulty" | "providerSpec" | "map" | "routeFrom" | "repoKey" | "requirementKey" | "requirementRepoKey"
  >;
  card: StaffCard | null;
  dispatchId: string;
  dispatcherAgentId: string;
  depth: number;
  workspaceId?: string;
}): DispatchTicketSpecInput {
  const { task, card } = input;
  return {
    key: task.key,
    prompt: task.prompt,
    ...(task.title ? { title: task.title } : {}),
    difficulty: task.difficulty,
    providerSpec: task.providerSpec,
    dispatchId: input.dispatchId,
    dispatcherAgentId: input.dispatcherAgentId,
    depth: input.depth,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(card ? { staff: { id: card.id, name: card.name } } : {}),
    ...(task.map ? { map: task.map } : {}),
    ...(task.routeFrom ? { routeFrom: task.routeFrom } : {}),
    ...(task.repoKey ? { repoKey: task.repoKey } : {}),
    ...(input.task.requirementKey
      ? {
          requirement: {
            number: input.task.requirementKey,
            ...(task.requirementRepoKey ? { repoKey: task.requirementRepoKey } : {}),
          },
        }
      : {}),
  };
}

/**
 * 派单要建的那张票：标题 + 正文 + 标签。纯函数，不写盘。
 *
 * 写票的是 `server/tracker/dispatch-ticket.ts`；MCP 的计划工具也用这一份，
 * 两条路给出的必须是同一张票——否则「计划里说的」和「真建出来的」会各写各的。
 *
 * 标签只放两件能在列表里筛的事：难度与客户端。模型不进标签也不进标题：
 * 档位 → 路由 → 模型只有一处真相，改了路由不该还要回来改票。
 */
export function buildDispatchTicket(input: DispatchTicketSpecInput): DispatchTicketSpec {
  const title = input.title?.trim() || firstLineTitle(input.prompt) || `派单 ${input.dispatchId} 任务 ${input.key}`;
  const spec = parseProviderSpec(input.providerSpec);
  const route = input.routeFrom
    ? input.routeFrom === "default"
      ? "没配路由，用了内置默认目标"
      : `借用 ${input.routeFrom} 档的路由（这一档没单独配）`
    : "按本档配置";
  const lines = [
    // 任务正文原样放在最前面：它是这张票的主体，再套一层 `## 任务` 标题会和
    // 正文自己的标题撞级，读起来像两层结构。
    input.prompt.trim(),
    "",
    "---",
    "",
    "## 派单",
    "",
    ...(input.workspaceId ? [`- 工作区：\`${input.workspaceId}\``] : []),
    ...(input.repoKey ? [`- 仓库：\`${input.repoKey}\``] : []),
    `- 批次：\`${input.dispatchId}\``,
    `- 派单窗口：\`${input.dispatcherAgentId}\``,
    // 岗位写在票面上而不是只挂在会话标签里：会话会被归档、标签会被摘掉，
    // 票是这件事留下的凭证，谁干的必须查得到。
    ...(input.staff ? [`- 岗位：${input.staff.name}（id=\`${input.staff.id}\`）`] : []),
    `- 层级：第 ${input.depth} 层`,
    `- 难度：\`${input.difficulty}\``,
    `- 执行客户端：\`${spec.provider}\`${spec.model ? `（模型 \`${spec.model}\`）` : ""}`,
    `- 路由：${route}`,
    ...(input.map?.trim() ? [`- 地图：\`${input.map.trim()}\``] : []),
    ...(input.requirement ? [`- 需求：#${input.requirement.number}`] : []),
    `- 任务键：\`${input.key}\``,
    "",
    "> 由 deck 派单自动建票。干完后用 `deck_handoff` 写回结果，票号填这张。",
  ];
  return {
    title,
    body: lines.join("\n"),
    labels: [difficultyLabel(input.difficulty), clientLabel(input.providerSpec)],
  };
}

// ---------------------------------------------------------------------------
// 树
// ---------------------------------------------------------------------------

export interface AgentNodeInput {
  agentId: string;
  parentAgentId?: string | null;
  title?: string | null;
  provider?: string;
  model?: string | null;
  status?: string;
  labels?: Readonly<Record<string, string>>;
  updatedAt?: string | null;
}

export interface AgentNode {
  agentId: string;
  title: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  difficulty: Difficulty | null;
  ticketKey: string | null;
  updatedAt: string | null;
  /**
   * 有父会话 id，但那个父会话不在本工作区的快照里：跨区派出去的子会话。
   * 界面按根节点画它，但要标一句「跨区 ↹」，否则会以为它是个孤立的根。
   */
  crossWorkspace: boolean;
  children: AgentNode[];
}

/**
 * 把扁平的 agent 快照拼成树。
 *
 * 父子关系优先用宿主的 `parentAgentId`，没有才退回标签 `paseo.parent-agent-id`
 * （宿主归档过的会话在快照里可能只剩标签）。**不按 `deck.child` 过滤**：
 * 会话树要能看见宿主自己建的子代理，`deck.child` 只用来区分「这条是 deck 派的」。
 * 父节点不在快照里（已被归档）时按根节点显示，不丢这一支。
 * 成环的边一律断开按根处理——宁可多一个根，也不无限递归。
 */
export function buildAgentTree(nodes: readonly AgentNodeInput[]): AgentNode[] {
  const known = new Set(nodes.map((node) => node.agentId));
  const index = new Map<string, AgentNode>();
  for (const node of nodes) {
    const labels = node.labels ?? {};
    const difficulty = labels[DECK_DIFFICULTY_LABEL];
    const parentId = node.parentAgentId?.trim() || readParentAgentId(node.labels);
    index.set(node.agentId, {
      agentId: node.agentId,
      title: node.title ?? null,
      provider: node.provider ?? null,
      model: node.model ?? null,
      status: node.status ?? null,
      difficulty: isDifficulty(difficulty) ? difficulty : null,
      ticketKey: labels[DECK_TICKET_LABEL] ?? null,
      updatedAt: node.updatedAt ?? null,
      // 父 id 有值、但父不在本区快照里：跨区派出去的子会话，按根画但打标记。
      crossWorkspace: Boolean(parentId && parentId !== node.agentId && !known.has(parentId)),
      children: [],
    });
  }

  const parentOf = new Map<string, string>();
  for (const node of nodes) {
    const parentId = node.parentAgentId?.trim() || readParentAgentId(node.labels);
    if (parentId && parentId !== node.agentId && index.has(parentId)) {
      parentOf.set(node.agentId, parentId);
    }
  }
  // 断环：从每个节点往上走，走回自己就把这条边删掉。
  for (const agentId of [...parentOf.keys()]) {
    const seen = new Set([agentId]);
    let current = parentOf.get(agentId);
    while (current) {
      if (seen.has(current)) {
        parentOf.delete(agentId);
        break;
      }
      seen.add(current);
      current = parentOf.get(current);
    }
  }

  const roots: AgentNode[] = [];
  for (const [agentId, node] of index) {
    const parentId = parentOf.get(agentId);
    const parent = parentId ? index.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const recency = (node: AgentNode): number => {
    const parsed = node.updatedAt ? Date.parse(node.updatedAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const sortDeep = (list: AgentNode[]) => {
    list.sort((left, right) => recency(right) - recency(left));
    for (const item of list) sortDeep(item.children);
  };
  sortDeep(roots);
  return roots;
}

/** 树上共有多少节点；界面显示「3 层 / 7 个会话」用。 */
export function countTree(nodes: readonly AgentNode[]): { nodes: number; depth: number } {
  let total = 0;
  const walk = (list: readonly AgentNode[], depth: number): number => {
    let deepest = depth;
    for (const node of list) {
      total += 1;
      deepest = Math.max(deepest, walk(node.children, depth + 1));
    }
    return deepest;
  };
  const depth = walk(nodes, 0);
  return { nodes: total, depth };
}

// ---------------------------------------------------------------------------
// 设置归一化
// ---------------------------------------------------------------------------

/**
 * 收四个窗口的提示词：只认四个固定键，空的不留，超长的截断。
 *
 * 截断而不是拒收：这里是归一化路径，一份手改坏的文件不该让整份设置失效；
 * 真按 4000 字去写提示词的人本来就该拆成更短的指令。
 */
function promptsOf(value: unknown): Partial<Record<FixedRole, string>> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const prompts: Partial<Record<FixedRole, string>> = {};
  for (const role of FIXED_ROLES) {
    const one = text(record[role]);
    if (one) prompts[role] = one.slice(0, MAX_ROLE_PROMPT_CHARS);
  }
  return Object.keys(prompts).length ? prompts : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(([, item]) => item !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function targetOf(value: unknown): ClientTarget | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const provider = text(record.provider);
  if (!provider) return undefined;
  return {
    provider,
    ...(optionalText(record.model) ? { model: optionalText(record.model) } : {}),
    ...(optionalText(record.modeId) ? { modeId: optionalText(record.modeId) } : {}),
    ...(optionalText(record.thinkingOptionId) ? { thinkingOptionId: optionalText(record.thinkingOptionId) } : {}),
    ...(optionalRecord(record.featureValues) ? { featureValues: optionalRecord(record.featureValues) } : {}),
  };
}

/**
 * 把外来的设置对象收拾成可信结构。
 *
 * 设置文件可能被手改、也可能是旧版本写的：认不出的字段直接丢，
 * 数值越界就夹到范围内，绝不让坏配置把派单卡死在半路。
 */
export function normalizeOrchestration(value: unknown): OrchestrationSettings {
  const record = asRecord(value);
  if (!record) return DEFAULT_ORCHESTRATION;

  const roles: WorkspaceRoles[] = [];
  if (Array.isArray(record.roles)) {
    for (const item of record.roles) {
      const role = asRecord(item);
      const workspaceId = text(role?.workspaceId);
      if (!role || !workspaceId) continue;
      const mainAgentId = optionalText(role.mainAgentId);
      const requirementAgentId = optionalText(role.requirementAgentId);
      const dispatcherAgentId = optionalText(role.dispatcherAgentId);
      const progressAgentId = optionalText(role.progressAgentId);
      const prompts = promptsOf(role.prompts);
      const staff = normalizeStaffCards(role.staff);
      roles.push({
        workspaceId,
        ...(mainAgentId ? { mainAgentId } : {}),
        ...(requirementAgentId ? { requirementAgentId } : {}),
        ...(dispatcherAgentId ? { dispatcherAgentId } : {}),
        ...(progressAgentId ? { progressAgentId } : {}),
        ...(prompts ? { prompts } : {}),
        ...(staff ? { staff } : {}),
      });
    }
  }

  const routing: RoutingRule[] = [];
  if (Array.isArray(record.routing)) {
    for (const item of record.routing) {
      const rule = asRecord(item);
      if (!rule || !isDifficulty(rule.difficulty)) continue;
      const profileId = optionalText(rule.profileId);
      const target = targetOf(rule.target);
      if (!profileId && !target) continue;
      routing.push({
        difficulty: rule.difficulty,
        ...(profileId ? { profileId } : {}),
        ...(target ? { target } : {}),
      });
    }
  }

  const maxDepth = clampInt(record.maxDepth, 1, 6, DEFAULT_MAX_DEPTH);
  const maxChildren = clampInt(record.maxChildrenPerDispatch, 1, 24, DEFAULT_MAX_CHILDREN);
  return {
    roles,
    routing,
    // 旧设置没有这一段 = 空表：不报错、不影响现有读写。
    modelThinking: normalizeModelThinking(record.modelThinking),
    maxDepth,
    maxChildrenPerDispatch: maxChildren,
    mapBudgets: normalizeMapBudgets(record.mapBudgets),
    reportOnFinish: record.reportOnFinish === undefined ? true : record.reportOnFinish === true,
    minConcurrentStaff: clampInt(
      record.minConcurrentStaff,
      1,
      MAX_MIN_CONCURRENT_STAFF,
      DEFAULT_MIN_CONCURRENT_STAFF,
    ),
    confirmRequirementSplit:
      record.confirmRequirementSplit === undefined
        ? DEFAULT_CONFIRM_REQUIREMENT_SPLIT
        : record.confirmRequirementSplit === true,
    // 0 是合法值（= 关掉额度闸），所以下限是 0 而不是 1。
    staffSessionQuota: clampInt(record.staffSessionQuota, 0, MAX_STAFF_SESSION_QUOTA, DEFAULT_STAFF_SESSION_QUOTA),
  };
}

/**
 * 地图预算归一：写坏的条目丢掉而不是夹成别的数。
 *
 * 与数值上限的差别：`maxDepth` 写坏了夹回默认值仍然「能用」；预算写坏了例如把地图
 * 引用写错，夹出来的是一条指向不存在地图的预算——不生效还让人以为配好了。同一张地图
 * 写了多条取第一条：后来的重复项不会覆盖掉人认真写的那条。
 */
export function normalizeMapBudgets(value: unknown): MapBudget[] {
  if (!Array.isArray(value)) return [];
  const out: MapBudget[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const map = normalizeMapRef(record.map);
    if (!map || seen.has(map)) continue;
    const raw = typeof record.concurrency === "number" ? Math.round(record.concurrency) : Number.NaN;
    if (!Number.isFinite(raw)) continue;
    seen.add(map);
    out.push({ map, concurrency: Math.min(MAX_MAP_CONCURRENCY, Math.max(1, raw)) });
  }
  return out;
}

/** 设一张地图的预算；`concurrency` 为 null 表示删掉这条（恢复不限制）。 */
export function withMapBudget(
  settings: OrchestrationSettings,
  map: string,
  concurrency: number | null,
): OrchestrationSettings {
  const wanted = normalizeMapRef(map);
  if (!wanted) return settings;
  const rest = settings.mapBudgets.filter((budget) => budget.map !== wanted);
  const next =
    concurrency === null
      ? rest
      : [...rest, { map: wanted, concurrency: clampInt(concurrency, 1, MAX_MAP_CONCURRENCY, 1) }];
  return { ...settings, mapBudgets: next };
}

/** 改一个工作区的角色绑定，返回新设置（不改入参）。 */
export function withWorkspaceRoles(
  settings: OrchestrationSettings,
  role: WorkspaceRoles,
): OrchestrationSettings {
  const rest = settings.roles.filter((item) => item.workspaceId !== role.workspaceId);
  const next: WorkspaceRoles = { workspaceId: role.workspaceId };
  if (role.mainAgentId?.trim()) next.mainAgentId = role.mainAgentId.trim();
  if (role.requirementAgentId?.trim()) next.requirementAgentId = role.requirementAgentId.trim();
  if (role.dispatcherAgentId?.trim()) next.dispatcherAgentId = role.dispatcherAgentId.trim();
  if (role.progressAgentId?.trim()) next.progressAgentId = role.progressAgentId.trim();
  const prompts = promptsOf(role.prompts);
  if (prompts) next.prompts = prompts;
  // 名册：传了就按传的归一，没传就沿用原来的——保存一次角色绑定不能把名册抹掉。
  // 想清空必须显式传空数组，这样「没提到」和「要清空」是两件事。
  const existing = settings.roles.find((item) => item.workspaceId === role.workspaceId);
  const staff = role.staff === undefined ? existing?.staff : normalizeStaffCards(role.staff);
  if (staff) next.staff = staff;
  // 这一条必须把新字段一起抄进去：只重抄会话 id 的话，保存一次就把用户改过的提示词抹掉。
  const roles = roleCarriesFields(next) ? [...rest, next] : rest;
  return { ...settings, roles };
}

/** 改一档路由，返回新设置。`rule` 为 null 表示这一档恢复成跟随 normal。 */
export function withRoutingRule(
  settings: OrchestrationSettings,
  rule: RoutingRule | null,
  difficulty: Difficulty,
): OrchestrationSettings {
  const rest = settings.routing.filter((item) => item.difficulty !== difficulty);
  return { ...settings, routing: rule ? [...rest, rule] : rest };
}
