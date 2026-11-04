/**
 * 跨区链条闸的服务端组装层。
 *
 * 判定规则仍只有两份：
 *   - `shared/contract-chain.ts`：解析第五列、四级判定、验收票文本；
 *   - `server/contract-chain.ts`：把「对方票是否存在 / 是否已关 / 有没有主」读成事实。
 *
 * 这里只回答三个问题，避免三处入口各抄一份规则：
 *   1. 建票时，需求声明了链条该怎么办（`judgeCreateChainGate`）；
 *   2. 派单时，这条任务该拿哪一行链条、判定结果是什么（`judgeDispatchTaskChain`）；
 *   3. 关需求时，正文该不该补一行「验收：未验收」（`acceptanceRecordForClose`）。
 *
 * 任何读失败都不吞：要么变成可读的拒绝理由，要么变成调用方会原样回传的 warning。
 */

import {
  ACCEPTANCE_COUNTERPART_LINE_PREFIX,
  ACCEPTANCE_PENDING_LINE,
  acceptanceRecordLine,
  acceptanceTicketNumberOf,
  acceptanceTicketProblem,
  hasPendingAcceptanceRecord,
  type ChainJudgment,
  type ChainLevel,
  type ParsedChain,
} from "../shared/contract-chain.ts";
import { acceptanceFactsOf, judgeTaskChain, readTicketFact, type TicketReader } from "./contract-chain.ts";
import { IMPACT_HEADING, parseImpactTable } from "../shared/impact.ts";

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

/** 影响面一行里与链条判定有关的三件事：哪一行、写的是什么、原文在哪。 */
export interface RequirementChainRow {
  readonly area: string;
  readonly chain: string;
}

/**
 * 需求正文 → 影响面的每一行（含第五列留空的行）。
 *
 * 留空行也必须带出来：目标区恰好是留空行时，调用方要先能匹配到它，
 * 才能判定「这个区没有链条」；先过滤会把目标区丢掉，退回去拿别的区的链条拦人。
 * 表坏了返回原因，不静默当成「没有链条」。
 */
export function requirementChainRows(body: unknown): { ok: true; rows: readonly RequirementChainRow[] } | { ok: false; reason: string } {
  const value = typeof body === "string" ? body : "";
  if (!value.trim()) return { ok: true, rows: [] };
  // 没写影响面节 = 没有声明任何链条（不是坏表）。只有写了节却解析不了才是格式错误。
  const hasSection = value.split(/\r?\n/).some((line) => line.trim() === IMPACT_HEADING);
  if (!hasSection) return { ok: true, rows: [] };
  const parsed = parseImpactTable(value);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return {
    ok: true,
    rows: parsed.rows.map((row) => ({ area: text(row.area), chain: text(row.chain) })),
  };
}

/**
 * 正文里写的需求引用：`Refs: #12` / `需求：#12` / `需求 #12`。
 * 只用于 RPC 建票这条历史上没有 requirementKey 入参的路径，给了显式票号时不看正文。
 */
export function requirementNumberOfBody(body: unknown): number | null {
  const value = typeof body === "string" ? body : "";
  // 必须带引用标志：`Refs: #12`、`需求：#12`、`需求 #12`。
  // 不能把「需求 3 天」「需求 2026 年」里的数字当票号——那会误读一张票再拒绝建票。
  const match = /(?:Refs:\s*#(\d+)|需求\s*[：:]\s*#?(\d+)|需求\s+#(\d+))/.exec(value);
  if (!match) return null;
  const number = Number(match[1] ?? match[2] ?? match[3]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function sameArea(area: string, target: string): boolean {
  const left = text(area).toLowerCase();
  const right = text(target).toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTail = left.split("/").filter(Boolean).pop() ?? "";
  const rightTail = right.split("/").filter(Boolean).pop() ?? "";
  return leftTail === right || rightTail === left;
}

/**
 * 一条派单任务该读哪一行链条（表已由调用方解析好）。
 *
 * 优先用任务自己的 `repoKey` 对齐影响面「区 / 仓库」列；对不上时，如果需求只声明了
 * 一条链条就用那一条；多条且对不上时按第一行判并在 warning 里点名——不假装「没有链条」
 * 放行，也不因为一行对不上就拦掉整批。
 */
function chainCellOf(
  rows: readonly RequirementChainRow[],
  targetRepoKey?: string | null,
): { readonly chain: string; readonly area: string | null; readonly warnings: readonly string[] } {
  if (!rows.length) return { chain: "", area: null, warnings: [] };

  const target = text(targetRepoKey);
  const matched = target ? rows.find((row) => sameArea(row.area, target)) : undefined;
  // 目标区匹配上了就按那一行判——它是空的就是「这个区没有链条」，不能回头拿别区的链条拦。
  if (matched) return { chain: matched.chain, area: matched.area, warnings: [] };

  // 对不上具体行时优先拿一条真声明了链条的行；全空才退回第一行。
  const first = rows.find((row) => row.chain.length > 0) ?? rows[0];
  if (!first) return { chain: "", area: null, warnings: [] };
  const warnings = rows.length > 1
    ? [`需求声明了 ${rows.length} 行影响面，任务 ${target || "（没写 repoKey）"} 对不上具体行；按「${first.area || "第一行"}」判。`]
    : [];
  return { chain: first.chain, area: first.area, warnings };
}

/** 跨仓库只看两个仓库键是否都已知且不同；不知道时按「没声明跨区」处理，不猜。 */
export function crossRepoOf(input: {
  readonly requirementRepoKey?: string | null;
  readonly targetRepoKey?: string | null;
}): boolean {
  const requirement = text(input.requirementRepoKey).toLowerCase();
  const target = text(input.targetRepoKey).toLowerCase();
  return Boolean(requirement && target && requirement !== target);
}

/** `等 #N` / `详见 #N` 读哪张票：需求票所在仓库优先，其次任务自己的仓库。 */
export function counterpartRepoKeyOf(input: {
  readonly requirementRepoKey?: string | null;
  readonly targetRepoKey?: string | null;
}): string | null {
  return text(input.requirementRepoKey) || text(input.targetRepoKey) || null;
}

/* ------------------------------------------------------------------ 派单闸 */

export interface DispatchTaskChainInput {
  readonly workspaceDir: string;
  readonly requirementBody?: string | null;
  readonly requirementRepoKey?: string | null;
  readonly targetRepoKey?: string | null;
  /** 任务标题 / 提示词，只用来认「这是不是验收票」。 */
  readonly title?: string | null;
  readonly prompt?: string | null;
  /** 授权端是否已经有工作票；只有明确为 true 才允许验收票派出去。 */
  readonly hasWorkTicket?: boolean | null;
  readonly reader?: TicketReader;
}

export type DispatchChainVerdict =
  | {
      readonly ok: true;
      readonly level: ChainLevel;
      readonly chain: ParsedChain;
      readonly chainCell: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly level: ChainLevel | null;
      readonly chain: ParsedChain | null;
      readonly chainCell: string;
      readonly warnings: readonly string[];
    };

/**
 * 验收票识别沿用既有文本约定：**标题**里出现「验收票」「验收岗位」「待授权端工作票」，
 * 标题以「验收：」开头，或提示词里明确写「待授权端工作票」。
 *
 * 提示词里随口提到「验收票 #9」不算——普通开发票也会引验收票，不能因此被当成验收任务拦掉。
 * 不新造标签。
 */
export function looksLikeAcceptanceTask(task: { readonly title?: string | null; readonly prompt?: string | null }): boolean {
  const title = text(task.title);
  const prompt = text(task.prompt);
  return /验收票|验收岗位|待授权端工作票/.test(title)
    || /^验收[:：]/.test(title)
    || /待授权端工作票/.test(prompt);
}

/**
 * 验收票正文里带着「待授权端工作票：…」= 授权端还没有可挂的工作票。
 *
 * 这个判定不读盘：任务标题 / 提示词就是验收票正文的一部分时，那一行是现成的证据。
 * 没写这一行就按「没有缺票证据」放行——不能因为读不到事实就永久卡住验收票；
 * 真缺票的验收票会把这一行写进正文（`acceptanceCounterpartLink` 的既有写法）。
 */
function counterpartWorkTicketMissing(task: { readonly title?: string | null; readonly prompt?: string | null }): boolean {
  return `${text(task.title)}\n${text(task.prompt)}`.includes(ACCEPTANCE_COUNTERPART_LINE_PREFIX);
}

function capabilityAcceptanceProblem(chain: ParsedChain): string {
  const key = text(chain.featureKey) || "（未填）";
  return `能力·授权：这张是验收票，但授权端还没有工作票，现在不能派。`
    + `先在验收票正文写一行「待授权端工作票：feature_key=${key}」，`
    + "等授权端那一区有了工作票再挂 blockedBy；权益没开时写「验收通过」是假的。";
}

/**
 * 派单时的验收票闸：本区声明了链条，就必须有一张已认领的验收票。
 *
 * 返回 null = 放行，字符串 = 拒绝理由。
 * 验收任务自己不核——它可能就是去建那张验收票的；其余任务缺票、没主、读不到都拒绝建票。
 */
async function dispatchAcceptanceProblem(
  input: DispatchTaskChainInput,
  chainCell: string,
): Promise<string | null> {
  if (!chainCell.trim() || looksLikeAcceptanceTask(input)) return null;
  const ticketNumber = acceptanceTicketNumberOf(input.requirementBody);
  if (ticketNumber === null) {
    return `${acceptanceTicketProblem(null)} 建好后在需求正文写一行「验收票 #<票号>」，再派这一区。`;
  }
  return acceptanceFactsOf(
    input.workspaceDir,
    { repoKey: counterpartRepoKeyOf(input), number: ticketNumber },
    input.reader,
  );
}

/**
 * 派单闸：一条任务一次判定。坏任务只拒这一条，不拦整批。
 *
 * `judgeTaskChain` 负责读被依赖 / 契约票；`capability` 的「授权端有没有工作票」
 * 拿不到事实时按「还没有」处理——这类任务本来就是验收票，不能先放出去再说。
 */
export async function judgeDispatchTaskChain(input: DispatchTaskChainInput): Promise<DispatchChainVerdict> {
  // 影响面表读不出来时不能当「没有链条」放行：建票闸会拒绝，派单闸如果放行，
  // 一张坏表就成了「直接走 RPC 派单」绕开检查的后门。
  const parsed = requirementChainRows(input.requirementBody);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `需求影响面表读不出来，不能判链条、也不给这一区派单：${parsed.reason}`,
      level: null,
      chain: null,
      chainCell: "",
      warnings: [],
    };
  }
  const picked = chainCellOf(parsed.rows, input.targetRepoKey);
  const warnings = [...picked.warnings];
  const counterpart = {
    area: picked.area,
    repo: text(input.requirementRepoKey) || null,
    repoKey: counterpartRepoKeyOf(input),
  };
  const judged: ChainJudgment = await judgeTaskChain(
    input.workspaceDir,
    {
      chain: picked.chain,
      crossRepo: crossRepoOf(input),
      counterpart,
    },
    input.reader,
  );
  warnings.push(...judged.warnings);

  if (!judged.ok) {
    return {
      ok: false,
      reason: picked.area ? `影响面这一行（${picked.area}）：${judged.reason}` : judged.reason,
      level: judged.level,
      chain: judged.chain,
      chainCell: picked.chain,
      warnings,
    };
  }

  // 有链条的需求必须有一张「已认领」的验收票：建这一区的票之前核一次。
  // 只按**本区那一行**要求，与建票闸的收窄规则一致：别的区有链条、本区留空时不拦本区。
  const acceptanceProblem = await dispatchAcceptanceProblem(input, picked.chain);
  if (acceptanceProblem) {
    return {
      ok: false,
      reason: acceptanceProblem,
      level: judged.level,
      chain: judged.chain,
      chainCell: picked.chain,
      warnings,
    };
  }

  const hasWorkTicket = input.hasWorkTicket
    ?? !counterpartWorkTicketMissing({ title: input.title, prompt: input.prompt });
  if (
    judged.level === "capability"
    && looksLikeAcceptanceTask({ title: input.title, prompt: input.prompt })
    && hasWorkTicket !== true
  ) {
    return {
      ok: false,
      reason: capabilityAcceptanceProblem(judged.chain),
      level: judged.level,
      chain: judged.chain,
      chainCell: picked.chain,
      warnings,
    };
  }

  return {
    ok: true,
    level: judged.level,
    chain: judged.chain,
    chainCell: picked.chain,
    warnings,
  };
}

/* ------------------------------------------------------------------ 建票闸 */

export interface CreateChainGateInput {
  readonly workspaceDir: string;
  readonly requirementBody?: string | null;
  readonly requirementRepoKey?: string | null;
  readonly targetRepoKey?: string | null;
  /** 目标区 / 模块；给了就按影响面那一行判，别拿别的区的链条拦这张票。 */
  readonly targetArea?: string | null;
  /** 票型；只有工作票（spec-ticket）要过验收票闸。 */
  readonly position?: string | null;
  readonly reader?: TicketReader;
}

export type CreateChainGateResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 建票时的两道闸：
 *   1. 需求里每条声明了链条的行都跑一次 `judgeTaskChain`（格式化 + 读被依赖 / 契约票）；
 *   2. 有链条的区域建工作票（spec-ticket）时，必须有一张已认领的验收票。
 *
 * 验收票由需求正文里的既有写法「验收票 #123」识别（不新造标签）。
 * 缺票、没主、读不到都拒绝建票；关票不在这里拦。
 */
export async function judgeCreateChainGate(input: CreateChainGateInput): Promise<CreateChainGateResult> {
  const rows = requirementChainRows(input.requirementBody);
  if (!rows.ok) return { ok: false, reason: `需求影响面表读不出来：${rows.reason}` };

  const warnings: string[] = [];
  const counterpartRepoKey = counterpartRepoKeyOf(input);
  const crossRepo = crossRepoOf(input);

  // 一张票只属于一个区：能对上目标区（或仓库）就只判那一行，别拿别的区的链条拦它的建票。
  // 对不上且需求只声明了一条时，按这一条判；对不上又有多条时才逐条保守判。
  const target = text(input.targetArea) || text(input.targetRepoKey);
  const matched = target ? rows.rows.filter((row) => sameArea(row.area, target)) : [];
  const relevantRows = matched.length ? matched : rows.rows;

  for (const row of relevantRows) {
    const judged = await judgeTaskChain(
      input.workspaceDir,
      {
        chain: row.chain,
        crossRepo,
        counterpart: { area: row.area || null, repo: text(input.requirementRepoKey) || null, repoKey: counterpartRepoKey },
      },
      input.reader,
    );
    if (!judged.ok) {
      return {
        ok: false,
        reason: `影响面这一行（${row.area || "未填区"}）：${judged.reason}`,
      };
    }
    warnings.push(...judged.warnings);
  }

  // 跨仓库但需求根本没写影响面行：只警告，不拦建票（plan 十节）。
  // 有行时 judgeChain 会按该行的空链条给出同一条警告，这里不重复。
  if (crossRepo && relevantRows.length === 0) {
    warnings.push(
      "跨仓库：需求影响面没有声明链条。只警告，不拒绝——真有依赖就补第五列"
        + "（契约：<摘要> / 等 #<票号> / 权益：feature_key=<键>，存量升级=是|否）。",
    );
  }

  if (relevantRows.some((row) => row.chain.length > 0) && text(input.position) === "spec-ticket") {
    const ticketNumber = acceptanceTicketNumberOf(input.requirementBody);
    if (ticketNumber === null) {
      return {
        ok: false,
        reason: `${acceptanceTicketProblem(null)} 先建一张验收岗位卡，或自己认领。`
          + "验收票建好后，在需求正文里写一行「验收票 #<票号>」。",
      };
    }
    const problem = await acceptanceFactsOf(
      input.workspaceDir,
      { repoKey: counterpartRepoKey, number: ticketNumber },
      input.reader,
    );
    if (problem) {
      return { ok: false, reason: `${problem} 先建一张验收岗位卡，或自己认领。` };
    }
  }

  return { ok: true, warnings: [...new Set(warnings)] };
}

/* ------------------------------------------------------------------ 关需求留痕 */

export interface AcceptanceCloseInput {
  readonly workspaceDir: string;
  readonly requirementBody?: string | null;
  readonly requirementRepoKey?: string | null;
  /** 关票日期；调用方取钟后传入，纯文本函数不自己取。 */
  readonly closedOn?: string | null;
  readonly reader?: TicketReader;
}

export interface AcceptanceCloseResult {
  /** 要追加到正文的那一行；null = 不追加（已留过痕 / 验收票已关 / 读不到票）。 */
  readonly append: string | null;
  readonly warnings: readonly string[];
}

/** 验收票读不到 / 不存在时也要留痕：票关掉之后，这是唯一还读得到的证据。 */
function unverifiedTraceLine(input: {
  readonly ticketNumber: number;
  readonly why: string;
  readonly closedOn?: string | null;
}): string {
  const closedOn = text(input.closedOn);
  const tail = closedOn ? `，${closedOn} 关闭）` : "）";
  return `${ACCEPTANCE_PENDING_LINE}（验收票 #${input.ticketNumber} ${input.why}${tail}`;
}

/**
 * 关需求票前算那一行痕迹。
 *
 * 四种结果：
 *   - 没有链条 / 已经留过痕 / 验收票已经关了 → 不追加（返回 append:null）；
 *   - 验收票仍开着 → 返回 `acceptanceRecordLine` 生成的行，由调用方写回正文；
 *   - 正文没有验收票号 → 追加一行「没有验收票」（票关掉后唯一还读得到的证据）；
 *   - 票不存在或读失败 → 追加一行「验收票 #N 不存在 / 读不到」，同时把原因放进 warnings。
 *
 * 硬挡关票只会逼人随手打勾，所以这里**没有失败分支**：读不到只进 warnings，关票照常。
 */
export async function acceptanceRecordForClose(input: AcceptanceCloseInput): Promise<AcceptanceCloseResult> {
  const body = typeof input.requirementBody === "string" ? input.requirementBody : "";
  const rows = requirementChainRows(body);
  if (!rows.ok) {
    return { append: null, warnings: [`读不出需求影响面表，关票没有追加验收痕迹：${rows.reason}`] };
  }
  if (!rows.rows.some((row) => row.chain.length > 0)) return { append: null, warnings: [] };
  if (hasPendingAcceptanceRecord(body)) return { append: null, warnings: [] };

  const ticketNumber = acceptanceTicketNumberOf(body);
  if (ticketNumber === null) {
    // 没有票号也要留痕：票关掉之后，这一行是「这张需求没验收」唯一的持久证据。
    return {
      append: acceptanceRecordLine({ ticketNumber: null, closedOn: input.closedOn }),
      warnings: ["需求声明了链条，但正文里找不到「验收票 #<票号>」；关票照常，正文补了一行「没有验收票」。"],
    };
  }

  const fact = await readTicketFact(
    input.workspaceDir,
    { repoKey: counterpartRepoKeyOf(input), number: ticketNumber },
    input.reader,
  );
  if (!fact) {
    return {
      append: unverifiedTraceLine({ ticketNumber, why: "读不到", closedOn: input.closedOn }),
      warnings: [`读不到验收票 #${ticketNumber}，关票照常，正文记了一行「读不到」。`],
    };
  }
  if (!fact.exists) {
    return {
      append: unverifiedTraceLine({ ticketNumber, why: "不存在", closedOn: input.closedOn }),
      warnings: [`验收票 #${ticketNumber} 不存在，关票照常，正文记了一行「不存在」。`],
    };
  }
  if (fact.closed) return { append: null, warnings: [] };

  return {
    append: acceptanceRecordLine({ ticketNumber, closedOn: input.closedOn }),
    warnings: [],
  };
}
