/**
 * 跨区代码链条的服务端读事实层。
 *
 * 判定规则全部在 `shared/contract-chain.ts` 的纯函数里（不读盘、不取钟、不联网）。
 * 这里只做一件事：把「对方票是否存在 / 是否已关 / 有没有主」读成事实，交给纯函数判。
 *
 * 三条硬规矩：
 *   1. 只读判定真正需要的那一张票——`等 #N` 读被依赖票，`详见 #N` 读契约票，其余不读；
 *   2. 读失败（后端不可达、命令报错、权限不足）返回 null / ok:false，**不抛异常**，
 *      也不把「读不到」当成「已解除」；
 *   3. 票确实不存在返回 `{ exists: false }`，由纯函数给出「不存在」的拒绝文案。
 */

import {
  acceptanceCounterpartLink,
  acceptanceTicketProblem,
  chainLevelOf,
  judgeChain,
  parseChainCell,
  type AcceptanceLink,
  type AcceptanceLinkInput,
  type ChainCounterpart,
  type ChainJudgment,
  type CounterpartTicketFact,
  type ParsedChain,
} from "../shared/contract-chain.ts";
import { resolveBackend } from "./tracker/backend.ts";
import { getIssue, type IssueDetailResult } from "./tracker/github.ts";
import { getGitLabIssue } from "./tracker/gitlab.ts";
import { getLocalIssue } from "./tracker/local.ts";

/** 后端解析失败时写进 action 的名字；与判定层的语义保持一致。 */
const CHAIN_ACTION = "跨区链条";

/** 一票的引用。`repoKey` 省略 = 工作区默认仓库。 */
export interface TicketRef {
  readonly repoKey?: string | null;
  readonly number: number;
}

/**
 * 读票得到的事实。
 *
 * `exists:false` 表示后端明确回答「没有这张票」；读失败不是这个形状——读失败返回 null。
 * `assignees` 只在验收闸用得上；判定层只拿 `exists` / `closed`。
 */
export interface TicketReadFact extends CounterpartTicketFact {
  readonly assignees: readonly string[];
}

/**
 * 注入点：测试用假 reader，生产走下面的默认实现。
 *
 * 契约：票不存在返回 `{ exists:false, closed:false, assignees: [] }`；
 * 读不到（网络 / 权限 / 命令失败）返回 null 或直接抛异常，调用方会把它收敛成 null。
 */
export type TicketReader = (ref: TicketRef) => Promise<TicketReadFact | null>;

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 后端状态字段大小写不统一（GitHub 给 `CLOSED`，GitLab 回包常是小写），一律按大小写不敏感判。 */
function isClosed(state: unknown): boolean {
  return text(state).toLowerCase() === "closed";
}

function normalizeFact(fact: TicketReadFact): TicketReadFact {
  const assignees = Array.isArray(fact.assignees)
    ? fact.assignees.filter((item): item is string => typeof item === "string")
    : [];
  return Object.freeze({
    exists: fact.exists === true,
    closed: fact.closed === true,
    assignees: Object.freeze(assignees),
  });
}

/** 仓库在文案里的名字：优先 repoKey，其次调用方给的 repo / area。 */
function repoNameOf(ref: TicketRef | null | undefined, counterpart?: ChainCounterpart | null): string {
  const candidates = [ref?.repoKey, counterpart?.repo, counterpart?.area];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value) return value;
  }
  return "当前仓库";
}

function numberLabel(ref: TicketRef | null | undefined): string {
  const value = ref?.number;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "（未给）";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读票结果：`fact` 为 null 时 `problem` 说明为什么读不到，供拒绝理由保留上下文。 */
interface ReadOutcome {
  readonly fact: TicketReadFact | null;
  readonly problem: string | null;
}

/** 默认实现：按后端类型分发到三张读票入口，统一收窄成一份事实。 */
async function readFromBackend(workspaceDir: string, ref: TicketRef): Promise<ReadOutcome> {
  const backend = await resolveBackend(workspaceDir, CHAIN_ACTION, text(ref.repoKey) || undefined);
  if (!backend.ok) {
    return { fact: null, problem: `解析后端失败：${backend.detail}（${backend.reason}）` };
  }

  let detail: IssueDetailResult;
  if (backend.kind === "github") {
    detail = await getIssue(backend.repo.owner, backend.repo.name, ref.number);
  } else if (backend.kind === "gitlab") {
    detail = await getGitLabIssue(backend.repo.owner, backend.repo.name, ref.number);
  } else {
    detail = await getLocalIssue(backend.workspaceDir, ref.number);
  }

  if (!detail.ok) {
    // 后端把「没有这张票」归成 not-found，其它原因才是读不到。
    // 注意：后端若把仓库配置 / 权限错误也标成 not-found，这里无法区分——那是 backend 层的口径问题。
    return detail.reason === "not-found"
      ? { fact: { exists: false, closed: false, assignees: [] }, problem: null }
      : { fact: null, problem: `读票失败：${detail.detail}（${detail.reason}）` };
  }

  return {
    fact: {
      exists: true,
      closed: isClosed(detail.issue.state),
      assignees: Array.isArray(detail.issue.assignees) ? detail.issue.assignees : [],
    },
    problem: null,
  };
}

/**
 * 统一读票：默认实现或注入的 reader。
 *
 * 任何异常都在这里收敛成 `problem`，不往上抛，也不丢掉异常原文；
 * 非法入参同样按「读不到」处理，但理由会明确写「票号无效」，不和「票不存在」混在一起。
 */
async function readTicketFactFull(
  workspaceDir: string,
  ref: TicketRef | null | undefined,
  reader?: TicketReader,
): Promise<ReadOutcome> {
  try {
    if (!ref || !validNumber(ref.number)) {
      return { fact: null, problem: `票号无效：${numberLabel(ref)}` };
    }
    if (reader) {
      const fact = await reader(ref);
      return fact
        ? { fact: normalizeFact(fact), problem: null }
        : { fact: null, problem: "reader 没有返回事实" };
    }
    return await readFromBackend(workspaceDir, ref);
  } catch (error) {
    return { fact: null, problem: `读票抛异常：${messageOf(error)}` };
  }
}

/**
 * 读一张票的「是否存在 / 是否已关」。
 *
 * 票不存在 → `{ exists:false, closed:false }`；任何读失败 → null（调用方据此拒绝，
 * 绝不能当成「已解除」）。
 */
export async function readTicketFact(
  workspaceDir: string,
  ref: TicketRef,
  reader?: TicketReader,
): Promise<CounterpartTicketFact | null> {
  const outcome = await readTicketFactFull(workspaceDir, ref, reader);
  return outcome.fact ? { exists: outcome.fact.exists, closed: outcome.fact.closed } : null;
}

export interface JudgeTaskChainInput {
  readonly chain?: string | null;
  readonly crossRepo?: boolean;
  readonly counterpart?: {
    readonly area?: string | null;
    readonly repo?: string | null;
    readonly repoKey?: string | null;
    /**
     * 只为兼容调用方的入参形状而保留：读哪张票**只认第五列解析结果**，
     * 这两个字段不参与读票，避免两处号码不一致时读错票。
     */
    readonly waitingTicket?: number | null;
    readonly detailTicket?: number | null;
  } | null;
}

interface TicketToRead {
  readonly kind: "depends" | "contract";
  readonly number: number;
}

/** 第五列决定唯一要读的那一张票；其余写法一张都不读。 */
function ticketToRead(chain: ParsedChain): TicketToRead | null {
  if (chain.kind === "depends" && chain.waitingTicket !== null) {
    return { kind: "depends", number: chain.waitingTicket };
  }
  if (chain.kind === "contract" && chain.detailTicket !== null) {
    return { kind: "contract", number: chain.detailTicket };
  }
  return null;
}

function readFailureReason(
  kind: "depends" | "contract",
  repo: string,
  number: number,
  problem: string | null,
): string {
  const target = kind === "depends"
    ? `被依赖的票 #${number}`
    : `「详见」指向的契约票 #${number}`;
  const level = kind === "depends" ? "三级（强依赖）" : "二级（有契约）";
  const detail = problem ? `（${problem}）` : "";
  return `${level}：读不到 ${repo} 的${target}${detail}，不默认已核。`
    + "先确认仓库可读、票号存在，再重试；不要按已解除派单。";
}

/**
 * 读事实 + 判定。判定本身仍由 `judgeChain` 做，这里只补它需要的对方票事实。
 *
 * 只读必要的那一张：
 *   - `等 #N`   → 读第五列给出的被依赖票；
 *   - `详见 #N` → 读第五列给出的契约票；
 *   - 其它写法  → 一张都不读（跨仓库留空只警告，由纯函数负责）。
 */
export async function judgeTaskChain(
  workspaceDir: string,
  input: JudgeTaskChainInput,
  reader?: TicketReader,
): Promise<ChainJudgment> {
  // 公开函数不抛异常：调用方传 undefined 时按「没声明链条」处理。
  const safeInput: JudgeTaskChainInput = input ?? {};
  const parsed = parseChainCell(safeInput.chain);
  if (!parsed.ok) {
    // 格式都没过，没有可读的票；让纯函数返回同一份拒绝理由。
    return judgeChain({ chain: safeInput.chain, crossRepo: safeInput.crossRepo });
  }

  const request = safeInput.counterpart ?? null;
  const counterpart: ChainCounterpart = Object.freeze({
    area: request?.area ?? null,
    repo: request?.repo ?? null,
    ticket: null,
    detailTicket: null,
  });

  const chain = parsed.chain;
  const target = ticketToRead(chain);
  if (!target) {
    return judgeChain({ chain: safeInput.chain, crossRepo: safeInput.crossRepo, counterpart });
  }

  const ref: TicketRef = { repoKey: request?.repoKey ?? null, number: target.number };
  const outcome = await readTicketFactFull(workspaceDir, ref, reader);
  if (!outcome.fact) {
    const reason = readFailureReason(
      target.kind,
      repoNameOf(ref, counterpart),
      target.number,
      outcome.problem,
    );
    return {
      ok: false,
      reason,
      level: chainLevelOf(chain),
      chain,
      warnings: [reason],
    };
  }

  const counterpartWithFact: ChainCounterpart = Object.freeze({
    ...counterpart,
    ...(target.kind === "depends" ? { ticket: outcome.fact } : { detailTicket: outcome.fact }),
  });

  return judgeChain({
    chain: safeInput.chain,
    crossRepo: safeInput.crossRepo,
    counterpart: counterpartWithFact,
  });
}

/**
 * 验收票闸：读一张票的 `exists` / `assignees`，交给 `acceptanceTicketProblem`。
 *
 * 返回 null = 通过；否则是一句可操作的拒绝理由。
 * 读不到时也返回拒绝理由（不是 null）——读不出验收票不能当成「没有验收票」放行。
 */
export async function acceptanceFactsOf(
  workspaceDir: string,
  ref: TicketRef,
  reader?: TicketReader,
): Promise<string | null> {
  const outcome = await readTicketFactFull(workspaceDir, ref, reader);
  if (!outcome.fact) {
    const why = outcome.problem ? `：${outcome.problem}` : "";
    return `读不到验收票 #${numberLabel(ref)}（仓库 ${repoNameOf(ref)}）${why}。`
      + "先确认仓库可读、票号存在，再决定要不要建票或指派；"
      + "读不到不当作「没有验收票」放行。";
  }
  const number = ref?.number;
  return acceptanceTicketProblem({
    exists: outcome.fact.exists,
    number: validNumber(number) ? number : null,
    assignees: outcome.fact.assignees,
  });
}

/**
 * 验收票挂边的服务端入口：只包装 `acceptanceCounterpartLink`，不自己造边。
 *
 * `hasWorkTicket=true` 却没给 `workTicketRef` 时，保持 shared 的拒绝文案；
 * 这里不读盘、不补票号——不知道票号就不许挂一条指向空气的边。
 * 前两个参数仅为与其它读票函数保持同形，本步骤不读票。
 */
export async function acceptanceLinkFor(
  _workspaceDir: string,
  input: AcceptanceLinkInput,
  _reader?: TicketReader,
): Promise<AcceptanceLink> {
  try {
    return acceptanceCounterpartLink(input);
  } catch (error) {
    return {
      ok: false,
      reason: `验收票挂边失败，没有写任何边：${messageOf(error)}`,
    };
  }
}
