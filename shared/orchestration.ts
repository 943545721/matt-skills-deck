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

export interface WorkspaceRoles {
  workspaceId: string;
  /** 主沟通窗口：汇总最终结果的地方。 */
  mainAgentId?: string;
  /** 派单窗口：接需求、拆活、派子会话的地方。可以与主窗口是同一个。 */
  dispatcherAgentId?: string;
}

export interface OrchestrationSettings {
  roles: WorkspaceRoles[];
  routing: RoutingRule[];
  /** 主窗口 → 派单窗口 → 子会话，默认 3；到顶就不许再派。 */
  maxDepth: number;
  /** 一次派单最多建几个子会话。 */
  maxChildrenPerDispatch: number;
  /** 子会话结束时是否把结果推给上一级；关掉只写台账不推消息。 */
  reportOnFinish: boolean;
}

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_CHILDREN = 6;

const DEFAULT_ROUTE: ClientTarget = { provider: "claude" };

export const DEFAULT_ORCHESTRATION: OrchestrationSettings = {
  roles: [],
  routing: [],
  maxDepth: DEFAULT_MAX_DEPTH,
  maxChildrenPerDispatch: DEFAULT_MAX_CHILDREN,
  reportOnFinish: true,
};

/** `provider/model` → 两段；没有 `/` 时 model 为 undefined。 */
export function parseProviderSpec(spec: string): { provider: string; model?: string } {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { provider: trimmed };
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  return model ? { provider, model } : { provider };
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

export type RouteResolution =
  | { ok: true; target: ClientTarget; via: "profile" | "target" }
  | { ok: false; reason: "profile-missing" | "no-target"; detail: string };

/**
 * 规则 → 具体会话配置。
 *
 * 档案优先；档案 id 指过去但已经被删掉时**不静默降级到别的档案**：
 * 有 `target` 才用 target，否则明确报错，让界面显示「这条路由坏了」。
 */
export function resolveRouteTarget(
  rule: RoutingRule,
  profiles: readonly ClientProfile[],
): RouteResolution {
  const profileId = rule.profileId?.trim();
  if (profileId) {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (profile) {
      return {
        ok: true,
        via: "profile",
        target: {
          provider: profile.provider,
          ...(profile.model ? { model: profile.model } : {}),
          ...(profile.modeId ? { modeId: profile.modeId } : {}),
          ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
          ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
        },
      };
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
    return { ok: true, via: "target", target: rule.target };
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

// ---------------------------------------------------------------------------
// 标签：父子关系与来源
// ---------------------------------------------------------------------------

/** 宿主自己的父子标签；子会话由 `create_agent` 建出来时 daemon 会写。 */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";

/** 我们自己打的标：区分「这个子会话是 deck 派出来的」和普通会话。 */
export const DECK_CHILD_LABEL = "deck.child";
export const DECK_TICKET_LABEL = "deck.ticket";
export const DECK_DIFFICULTY_LABEL = "deck.difficulty";
export const DECK_DISPATCH_LABEL = "deck.dispatch";

export interface ChildLabelInput {
  dispatcherAgentId: string;
  /** 票号或地图条目键，例如 `owner/repo#12`。 */
  ticketKey?: string;
  difficulty: Difficulty;
  /** 同一次派单的批次号，便于一次撤掉。 */
  dispatchId?: string;
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
  if (input.dispatchId?.trim()) labels[DECK_DISPATCH_LABEL] = input.dispatchId.trim();
  return labels;
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
}

export type DispatchRejection =
  | "unknown-workspace"
  | "no-dispatcher"
  | "depth-exceeded"
  | "too-many-children"
  | "empty-prompt"
  | "duplicate-key"
  | "route-unavailable";

export interface DispatchTask extends DispatchTaskInput {
  difficulty: Difficulty;
  target: ClientTarget;
  providerSpec: string;
  labels: Record<string, string>;
  idempotencyKey: string;
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
  /** 派单窗口现在是第几层；主窗口是 0，派单窗口是 1。 */
  depth: number;
  dispatchId: string;
  /**
   * 实际在调派单的那个会话。
   *
   * 有它就用它写 `paseo.parent-agent-id` 与提示词抬头：宿主的父子关系挂在真实调用者身上，
   * 标签却写配置里的派单窗口时，会话树（按标签拼）和回传链（按宿主 `parentAgentId`）会指向
   * 两个不同会话。角色绑定仍是放行条件，这里只解决「写给谁看」。
   */
  callerAgentId?: string;
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
  const roles = input.roles.find((role) => role.workspaceId === input.workspaceId);
  const configuredDispatcher = roles?.dispatcherAgentId?.trim() || null;
  const rejected: DispatchRejected[] = [];
  const tasks: DispatchTask[] = [];

  const reject = (task: DispatchTaskInput, reason: DispatchRejection, detail: string) => {
    rejected.push({ key: task.key, ...(task.title ? { title: task.title } : {}), reason, detail });
  };

  if (!roles) {
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

  const seen = new Set<string>();
  let accepted = 0;
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
    const difficulty: Difficulty = task.difficulty ?? "normal";
    const rule = resolveRoute({ routing: input.routing }, difficulty);
    const resolution = resolveRouteTarget(rule, input.profiles);
    if (!resolution.ok) {
      reject({ ...task, key }, "route-unavailable", resolution.detail);
      continue;
    }
    const target = resolution.target;
    accepted += 1;
    tasks.push({
      ...task,
      key,
      difficulty,
      target,
      providerSpec: providerSpec(target),
      ...routeFromOf(input.routing, difficulty),
      labels: buildChildLabels({
        dispatcherAgentId,
        difficulty,
        dispatchId: input.dispatchId,
        ...(task.key ? { ticketKey: task.key } : {}),
      }),
      idempotencyKey: `deck-dispatch-${stableKey([input.workspaceId, key, input.dispatchId])}`,
    });
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
      ]
    : [
        `[dispatch] You are a child session of dispatcher ${input.dispatcherAgentId} (depth ${input.depth}, difficulty ${input.difficulty}${ticket ? `, ticket ${ticket}` : ""}).`,
        "When you finish, call `deck_handoff` with status / summary / done / nextSteps / files / blocking; " +
          "without it your work is never reported upward. Never present unfinished work as done.",
      ];
  return lines.join("\n");
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
  const index = new Map<string, AgentNode>();
  for (const node of nodes) {
    const labels = node.labels ?? {};
    const difficulty = labels[DECK_DIFFICULTY_LABEL];
    index.set(node.agentId, {
      agentId: node.agentId,
      title: node.title ?? null,
      provider: node.provider ?? null,
      model: node.model ?? null,
      status: node.status ?? null,
      difficulty: isDifficulty(difficulty) ? difficulty : null,
      ticketKey: labels[DECK_TICKET_LABEL] ?? null,
      updatedAt: node.updatedAt ?? null,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | undefined {
  const t = text(value);
  return t ? t : undefined;
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
      const dispatcherAgentId = optionalText(role.dispatcherAgentId);
      roles.push({
        workspaceId,
        ...(mainAgentId ? { mainAgentId } : {}),
        ...(dispatcherAgentId ? { dispatcherAgentId } : {}),
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
    maxDepth,
    maxChildrenPerDispatch: maxChildren,
    reportOnFinish: record.reportOnFinish === undefined ? true : record.reportOnFinish === true,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 改一个工作区的角色绑定，返回新设置（不改入参）。 */
export function withWorkspaceRoles(
  settings: OrchestrationSettings,
  role: WorkspaceRoles,
): OrchestrationSettings {
  const rest = settings.roles.filter((item) => item.workspaceId !== role.workspaceId);
  const next: WorkspaceRoles = { workspaceId: role.workspaceId };
  if (role.mainAgentId?.trim()) next.mainAgentId = role.mainAgentId.trim();
  if (role.dispatcherAgentId?.trim()) next.dispatcherAgentId = role.dispatcherAgentId.trim();
  const roles = next.mainAgentId || next.dispatcherAgentId ? [...rest, next] : rest;
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
