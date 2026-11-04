/**
 * 跨区代码链条：四级判定、影响面第五列解析、验收票与跨仓库依赖的文本规则。
 *
 * 为什么单独立一份：plan 第十节把跨区关系从「一律并行」拆成四级，第五列的四种写法
 * 就是这四级的机器可读落点。判定与写票面文本必须共用同一份规则，否则会出现
 * 「计划里按强依赖拦了、建票时又按无关放过去」。
 *
 * 纯函数：不读盘、不取钟、不读环境变量、不发起网络请求。
 * 三级要判「对方票关没关」，但**不在这里读**——调用方把「是否存在 / 是否已关」的事实
 * 作为 `counterpart.ticket` 传进来。读不到事实时按「还没核对」拒绝，绝不默认已解除。
 */

import {
  ACCEPTANCE_RECORD_PREFIX,
  normalizeRequirementKey,
  parseImpactChain,
} from "./impact.ts";
import { renderCrossRepoBlock } from "./edge-rules.ts";

/**
 * 跨仓库依赖只能落在正文隐藏区段：远端没有跨仓库原生边，GitHub 的 readiness 只看
 * 原生 blocker 节点，GitLab 读正文时还会剥掉隐藏区段。三个函数直接复用一份实现，
 * 这里只换成语义更窄的名字，避免调用方误以为可以建父子边。
 */
export {
  parseCrossRepoBlockRefs as readBlockedBySection,
  renderCrossRepoBlock as renderBlockedBySection,
  upsertCrossRepoBlockedBy as upsertBlockedBySection,
} from "./edge-rules.ts";

/** 四级顺序固定：从最轻到最重，界面按这个顺序展示。 */
export const CHAIN_LEVELS = ["unrelated", "contract", "depends", "capability"] as const;
export type ChainLevel = (typeof CHAIN_LEVELS)[number];

/** 中文名与 plan 第十节那张表逐字一致。 */
export const CHAIN_LEVEL_LABELS: Readonly<Record<ChainLevel, string>> = Object.freeze({
  unrelated: "无关",
  contract: "有契约",
  depends: "强依赖",
  capability: "能力·授权",
});

/** 第五列的四种写法前缀；只在这里写一份，解析与文案都引用它。 */
export const CHAIN_CONTRACT_PREFIX = "契约：";
export const CHAIN_CAPABILITY_PREFIX = "权益：";
export const CHAIN_WAITING_PREFIX = "等 ";
export const CHAIN_DETAIL_PREFIX = "详见 ";

/** 没声明链条时的默认级别：plan 说默认按「一」处理。 */
export const DEFAULT_CHAIN_LEVEL: ChainLevel = "unrelated";

/** 关需求票时写进正文的持久记录（关票照放行，痕要留下）。 */
export const ACCEPTANCE_PENDING_LINE = "验收：未验收";
/** 验收票正文里记对方「还只有研究票、没有工作票」的那一行前缀。 */
export const ACCEPTANCE_COUNTERPART_LINE_PREFIX = "待授权端工作票：";

/** 协调收件箱里契约变更的 kind；群消息第 6 批才有，这里不造。 */
export const CONTRACT_COORDINATION_KIND = "contract" as const;

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

/** 第五列解析出来的机器字段；没有的项一律 null，不用空串冒充。 */
export interface ParsedChain {
  /** none = 第五列留空（默认按「无关」处理）。 */
  readonly kind: "none" | "contract" | "capability" | "depends";
  /** `契约：<摘要>` 的摘要；`详见 #N` 时为 null。 */
  readonly summary: string | null;
  /** `详见 #<票号>` 指向的那张普通票；不是这种写法时为 null。 */
  readonly detailTicket: number | null;
  /** `权益：` 的功能键。 */
  readonly featureKey: string | null;
  /** `存量升级=是|否`；没写或写法不对时为 null。 */
  readonly upgradeExisting: boolean | null;
  /** `等 #<票号>` 指向的被依赖票。 */
  readonly waitingTicket: number | null;
}

export type ChainParseResult =
  | { readonly ok: true; readonly chain: ParsedChain }
  | { readonly ok: false; readonly reason: string };

/**
 * 解析影响面第五列。
 *
 * 格式规则只有一份：`shared/impact.ts` 的 `parseImpactChain`（定稿按钮与派单闸共用）。
 * 这里只把它拆成四级判定要用的形状，不再抄一遍正则或文案。
 *
 * 四种写法：
 *   契约：<摘要>                        → kind=contract，summary=<摘要>
 *   权益：feature_key=<键>，存量升级=是|否 → kind=capability
 *   等 #<票号>                          → kind=depends，waitingTicket=<票号>
 *   详见 #<票号>                        → kind=contract，detailTicket=<票号>（契约太长，摘要另开票）
 * 空串 = 没有链条 → kind=none。
 */
export function parseChainCell(cell: unknown): ChainParseResult {
  const parsed = parseImpactChain(cell);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const source = parsed.chain;
  const chain: ParsedChain = Object.freeze({
    kind: source.kind === "waiting" ? "depends" : source.kind === "detail" ? "contract" : source.kind,
    summary: source.summary,
    detailTicket: source.kind === "detail" ? source.ticket : null,
    featureKey: source.featureKey,
    upgradeExisting: source.upgradeExisting,
    waitingTicket: source.kind === "waiting" ? source.ticket : null,
  });
  return { ok: true, chain };
}

/** 解析结果 → 四级。只按第五列判，不看别的字段；穷举 switch 让新增 kind 时编译报错。 */
export function chainLevelOf(chain: ParsedChain): ChainLevel {
  switch (chain.kind) {
    case "none": return "unrelated";
    case "contract": return "contract";
    case "depends": return "depends";
    case "capability": return "capability";
  }
}

/** 对方票的事实；由调用方读好后传入，判定函数不自己取数。 */
export interface CounterpartTicketFact {
  readonly exists: boolean;
  readonly closed: boolean;
}

/** 对方区信息：工只用于文案、事实与验收票挂载。 */
export interface ChainCounterpart {
  /** 对方区 / 仓库名，用于警告与拒绝文案。 */
  readonly area?: string | null;
  readonly repo?: string | null;
  /** 三级：被依赖那张票是否存在 / 已关。 */
  readonly ticket?: CounterpartTicketFact | null;
  /** 二级 `详见 #N`：那张契约票是否存在 / 已关；plan 只认「存在且开着」。 */
  readonly detailTicket?: CounterpartTicketFact | null;
  /** 第四级：授权端那一区是否已经有工作票（有才允许验收票挂边）。 */
  readonly hasWorkTicket?: boolean | null;
}

export interface JudgeChainInput {
  /** 影响面第五列原文；空 = 没声明链条。 */
  readonly chain?: string | null;
  /** 当前票与对方区是否跨仓库。 */
  readonly crossRepo?: boolean | null;
  /** 对方区信息；三级至少要有 `ticket`。 */
  readonly counterpart?: ChainCounterpart | null;
}

export type ChainJudgment =
  | {
      readonly ok: true;
      readonly level: ChainLevel;
      readonly chain: ParsedChain;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly level: ChainLevel | null;
      readonly chain: ParsedChain | null;
      readonly warnings: readonly string[];
    };

function counterpartName(counterpart: ChainCounterpart | null | undefined): string {
  const area = text(counterpart?.area);
  const repo = text(counterpart?.repo);
  if (area && repo) return `${area}（${repo}）`;
  return area || repo || "对方区";
}

/**
 * 四级判定与建票 / 派单闸。
 *
 * 判定顺序（先命中的先说）：
 *   1. 第五列格式不对 → 拒绝（理由来自 `parseImpactChain`，与定稿闸同一份）；
 *   2. 第五列留空 → 无关。跨仓库时**只给一条警告，不拒绝**——硬拦一条其实没依赖的
 *      跨仓库任务，比放过一条有依赖的代价更大（plan 十节末）；
 *   3. 契约：缺摘要且没写 `详见 #N` → 解析阶段就拒；`详见 #N` 还要拿到
 *      「那张票存在且开着」的事实（plan 1350），读不到不默认已核；
 *   4. 权益：缺 `feature_key` / `存量升级` → 解析阶段就拒；`存量升级=否` 只警告，
 *      要求需求票正文明说；
 *   5. 等 #N：必须拿到「对方票存在且已关」的事实。没给事实、票不存在、票没关都拒绝；
 *      不把「读不到」当「已解除」。
 *
 * 返回 `ok:false` 时，`level` / `chain` 可能为 null（格式都没过，谈不上级别）。
 */
export function judgeChain(input: JudgeChainInput): ChainJudgment {
  const parsed = parseChainCell(input.chain);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, level: null, chain: null, warnings: [] };
  }

  const chain = parsed.chain;
  const level = chainLevelOf(chain);
  const counterpart = input.counterpart ?? null;
  const warnings: string[] = [];

  if (chain.kind === "none") {
    if (input.crossRepo === true) {
      warnings.push(
        `跨仓库：${counterpartName(counterpart)}与当前票之间没声明链条。`
        + "只警告，不拒绝——硬拦一条其实没依赖的跨仓库任务，代价更大。"
        + "真有依赖就补第五列：契约：<摘要> / 等 #<票号> / 权益：feature_key=<键>，存量升级=是|否。",
      );
    }
    return { ok: true, level, chain, warnings };
  }

  if (chain.kind === "contract" && chain.detailTicket !== null) {
    const detail = chain.detailTicket;
    const fact = counterpart?.detailTicket ?? null;
    if (!fact) {
      return {
        ok: false,
        reason: `二级（有契约）：还没读「详见」指向的契约票 #${detail} 是否开着，不能默认已核。`,
        level,
        chain,
        warnings,
      };
    }
    if (!fact.exists) {
      return {
        ok: false,
        reason: `二级（有契约）：「详见 #${detail}」指向的票不存在。先建那张普通 issue，或改成实际票号。`,
        level,
        chain,
        warnings,
      };
    }
    if (fact.closed) {
      return {
        ok: false,
        reason: `二级（有契约）：「详见 #${detail}」指向的票已经关了；这一格只认票号存在且开着，`
          + "换一张还开着的契约票。",
        level,
        chain,
        warnings,
      };
    }
    return { ok: true, level, chain, warnings };
  }

  if (chain.kind === "capability") {
    if (chain.upgradeExisting === false) {
      warnings.push(
        "存量升级=否：需求票正文必须明说「存量客户端不会自动获得这个功能」，"
        + "否则上线当天才发现老客户看不到。",
      );
    }
    return { ok: true, level, chain, warnings };
  }

  if (chain.kind === "depends") {
    const ticket = chain.waitingTicket;
    if (ticket === null) {
      return {
        ok: false,
        reason: "三级（强依赖）缺被依赖的票号：写成「等 #<票号>」。",
        level,
        chain,
        warnings,
      };
    }
    const fact = counterpart?.ticket ?? null;
    if (!fact) {
      return {
        ok: false,
        reason: `三级（强依赖）：还没读对方票 #${ticket} 的开闭状态，不能按已解除处理。`
          + "先去对方仓库读那张票，把「是否存在 / 是否已关」作为事实传进来。",
        level,
        chain,
        warnings,
      };
    }
    if (!fact.exists) {
      return {
        ok: false,
        reason: `三级（强依赖）：被依赖的票 #${ticket} 在${counterpartName(counterpart)}不存在。`
          + "先建那张票，或者把第五列改成实际存在的票号。",
        level,
        chain,
        warnings,
      };
    }
    if (!fact.closed) {
      return {
        ok: false,
        reason: `三级（强依赖）：被依赖的票 #${ticket} 还没关，B 不能先开工。`
          + "等对方关了再派；不要指望仓库的 ready 标记（跨仓库引用被写进正文隐藏区段，"
          + "板子上会显示 ready）。",
        level,
        chain,
        warnings,
      };
    }
    return { ok: true, level, chain, warnings };
  }

  return { ok: true, level, chain, warnings };
}

/* ------------------------------------------------------------------ 验收票 */

export interface AcceptanceTicketFacts {
  /** 验收票建没建。 */
  readonly exists: boolean;
  readonly number?: number | string | null;
  /** `assignees`；必须至少有一个，没有主的验收票不算数。 */
  readonly assignees?: readonly string[] | null;
}

/**
 * 有链条的需求建四区票之前的闸：验收票必须存在且有主。
 *
 * 返回 null 表示通过，否则一句可操作的拒绝理由。缺票 / 没人认领都**拒绝建票**，
 * 但**不拦关需求票**——关票照放行，痕由 `acceptanceRecordLine` 写进正文。
 */
export function acceptanceTicketProblem(input: AcceptanceTicketFacts | null | undefined): string | null {
  if (!input || input.exists !== true) {
    return "有链条的需求必须建一张验收票：缺了就在板子上标「未验收」；先把验收票建出来，"
      + "写明跑哪条场景、步骤、期望结果。";
  }
  const assignees = Array.isArray(input.assignees)
    ? input.assignees.map((item) => text(item)).filter(Boolean)
    : [];
  if (!assignees.length) {
    return "验收票没有主：先建一张验收岗位卡并指派给它，或自己认领。没有主的验收票不算数。";
  }
  return null;
}

export interface AcceptanceLinkInput {
  readonly counterpart?: ChainCounterpart | null;
  /** 覆盖 `counterpart.hasWorkTicket`；两者都没给按「待核」处理，不挂边。 */
  readonly hasWorkTicket?: boolean | null;
  /** 对方那张工作票的引用：同仓库 `#42`，跨仓库 `owner/repo#42`。 */
  readonly workTicketRef?: string | null;
  /** 是否跨仓库：同仓库走原生边，跨仓库走正文隐藏区段。没传时按 ref 形状判。 */
  readonly crossRepo?: boolean | null;
  /** 第四级的功能键，用于「对方待核」时正文那一行。 */
  readonly featureKey?: string | null;
}

/** `owner/repo#12` / `项目键#12` 这种带仓库前缀的引用一定是跨仓库；本仓库写法只有 `#12`。 */
function refLooksCrossRepo(ref: string): boolean {
  return /^[^#\s]+#\d+$/.test(ref);
}

export type AcceptanceLink =
  | { readonly ok: true; readonly kind: "native-blockedBy"; readonly ref: string }
  | {
      readonly ok: true;
      readonly kind: "body-blockedBy";
      readonly ref: string;
      /** 可直接 upsert 进验收票正文的隐藏区段。 */
      readonly section: string;
    }
  | { readonly ok: true; readonly kind: "body-line"; readonly line: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 验收票该挂哪张票、还是只能记一行正文。
 *
 * 规则（plan 十节）：
 *   - 验收票**只挂已经存在的票**；对方那一区还只有研究票、标着「待核」时，
 *     不许挂一条指向空气的 `blockedBy`，改成正文记一行「待授权端工作票：feature_key=<键>」；
 *   - 同一仓库内用原生边，跨仓库用正文隐藏区段（两种都由插件判，不靠仓库 ready）；
 *   - `crossRepo` 没传时按引用形状兜底：`owner/repo#12` 这种带仓库前缀的引用一律当
 *     跨仓库。默认方向必须偏向正文区段——误当成原生边会在板子上显示 ready，闸一次都不响；
 *   - 对方说有工作票但没给票号 → 拒绝，不造一条空边。
 */
export function acceptanceCounterpartLink(input: AcceptanceLinkInput): AcceptanceLink {
  const counterpart = input.counterpart ?? null;
  const hasWorkTicket = input.hasWorkTicket ?? counterpart?.hasWorkTicket ?? null;
  const ref = text(input.workTicketRef);
  const featureKey = text(input.featureKey);

  if (hasWorkTicket === true) {
    if (!ref) {
      return {
        ok: false,
        reason: "对方区说已经有工作票，但没给票号：验收票不能挂一条空边。"
          + "把那张票的引用（同仓库 #<票号> / 跨仓库 owner/repo#<票号>）一起传进来。",
      };
    }
    const crossRepo = input.crossRepo === true || refLooksCrossRepo(ref);
    if (crossRepo) {
      return { ok: true, kind: "body-blockedBy", ref, section: renderCrossRepoBlock([ref]) };
    }
    return { ok: true, kind: "native-blockedBy", ref };
  }

  const line = featureKey
    ? `${ACCEPTANCE_COUNTERPART_LINE_PREFIX}feature_key=${featureKey}`
    : `${ACCEPTANCE_COUNTERPART_LINE_PREFIX}对方区还没有工作票`;
  return { ok: true, kind: "body-line", line };
}

export interface AcceptanceRecordInput {
  /** 验收票票号；可传数字或 `"#12"`。没给 = 没有验收票；给了但读不出会写进痕迹。 */
  readonly ticketNumber?: number | string | null;
  /** 关票日期；由调用方传入（纯函数不取钟）。 */
  readonly closedOn?: string | null;
}

/**
 * 关需求票时写进正文的那一行（持久记录，票关着也搜得到）。
 *
 * 例：`验收：未验收（验收票 #123 仍开着，2026-11-03 关闭）`
 * 关票**照常放行**，不硬挡——硬挡只会逼人随手打勾。这里只生成文本，不判断关不关。
 * 票号给了却读不出来时如实写「编号不可读」，不静默退化成「没有验收票」。
 */
export function acceptanceRecordLine(input: AcceptanceRecordInput): string {
  const raw = text(input.ticketNumber);
  const number = normalizeRequirementKey(input.ticketNumber);
  const closedOn = text(input.closedOn);
  const head = number !== null
    ? `${ACCEPTANCE_RECORD_PREFIX}未验收（验收票 #${number} 仍开着`
    : raw
      ? `${ACCEPTANCE_RECORD_PREFIX}未验收（验收票编号不可读「${raw}」`
      : `${ACCEPTANCE_RECORD_PREFIX}未验收（没有验收票`;
  return closedOn ? `${head}，${closedOn} 关闭）` : `${head}）`;
}

/** 这篇正文里是否已经留着「未验收」的痕；板子上那枚标记读它。 */
export function hasPendingAcceptanceRecord(body: unknown): boolean {
  const value = typeof body === "string" ? body : "";
  return value.split(/\r?\n/).some((line) => line.trim().startsWith(ACCEPTANCE_PENDING_LINE));
}

/**
 * 从需求票正文里读出挂着的验收票号。
 *
 * 沿用 `acceptanceRecordLine` 写出的既有写法「验收票 #123」，不新增标签、不新增票型。
 * 人工也可以直接写一行「验收票：#123」或「- 验收票：#123」；两种都认。
 * 读不到返回 null（调用方据此提示「还没建验收票」，不拿 0 或空串冒充）。
 */
export function acceptanceTicketNumberOf(body: unknown): number | null {
  const value = typeof body === "string" ? body : "";
  const match = /验收票\s*[：:]?\s*#?(\d+)/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/* ------------------------------------------------------------------ 契约变更记录 */

export interface ContractChangeNote {
  readonly ref: string;
  readonly body: string;
}

export interface ContractChangeArtifacts {
  /** 两边票面各记一笔，顺序按 `impacted`。 */
  readonly notes: readonly ContractChangeNote[];
  /** `.deck/coordination.jsonl` 里的一行；不写群消息（群视图第 6 批才有）。 */
  readonly coordination: {
    readonly kind: typeof CONTRACT_COORDINATION_KIND;
    readonly field: string;
    readonly taskSummary: string;
    readonly at: string | null;
    readonly by: string | null;
  };
}

export type ContractChangeResult =
  | { readonly ok: true; readonly artifacts: ContractChangeArtifacts }
  | { readonly ok: false; readonly reason: string };

export interface ContractChangeInput {
  readonly requirementKey?: number | string | null;
  /** 哪一条字段变了（plan 的 contract 请求语义：哪一条字段、为什么）。 */
  readonly field: string;
  readonly reason: string;
  /** 受影响的两边票面引用，例如 `["kxhyapp.com#12", "kxhyapp.com-saas#13"]`。 */
  readonly impacted: readonly string[];
  readonly at?: string | null;
  readonly by?: string | null;
}

/**
 * 影响面那一行改了以后，纯文本层面的两份产出：两边票面各一条 + 一条 kind:"contract"。
 *
 * 这里只生成内容，不写文件、不发消息；写盘与群消息的接线在 server 批次里做。
 * 群视图第 6 批才有，所以这里**不造群消息**，免得先写一个永远没人读的出口。
 */
export function contractChangeArtifacts(input: ContractChangeInput): ContractChangeResult {
  const field = text(input.field);
  const reason = text(input.reason);
  if (!field) return { ok: false, reason: "契约变更要说清改的是哪一条字段（`field` 不能空）。" };
  if (!reason) return { ok: false, reason: "契约变更要说清为什么改（`reason` 不能空），否则另一方不知道要不要跟。" };

  // 同一张票传两次只记一笔：两边票面各一条，不能因为调用方重复传就写两条。
  const refs = Array.isArray(input.impacted)
    ? input.impacted.map((item) => text(item)).filter((ref, index, all) => ref && all.indexOf(ref) === index)
    : [];
  if (!refs.length) {
    return { ok: false, reason: "契约变更至少要指出一边受影响的票面（`impacted` 不能空）。" };
  }

  const requirement = normalizeRequirementKey(input.requirementKey);
  const at = text(input.at) || null;
  const by = text(input.by) || null;
  const stamp = [by ? `${by} 记` : "", at ? `${at} 记` : ""].filter(Boolean).join("，");
  const suffix = stamp ? `（${stamp}）` : "";
  const refLine = requirement === null ? "" : `\nRefs: #${requirement}`;

  const notes = refs.map((ref) => Object.freeze({
    ref,
    body: `契约变更（影响面）：${field}\n为什么：${reason}${refLine}${suffix}`,
  }));

  const coordination = Object.freeze({
    kind: CONTRACT_COORDINATION_KIND,
    field,
    taskSummary: `影响面契约变更：${field} —— ${reason}`,
    at,
    by,
  });

  return { ok: true, artifacts: Object.freeze({ notes: Object.freeze(notes), coordination }) };
}
