import type { PaseoAgentListResult, PaseoApi } from "@getpaseo/client";
import { matchesWorkspaceScope } from "../shared/session.ts";
import type { ArchivedAgentRow } from "../shared/orchestration-rpc.ts";
import { sessionErrorDetail } from "./session.ts";

/**
 * 已归档会话的清单。
 *
 * 为什么要有这一页：归档是宿主的软删除，默认会话列表里再也看不到那条会话，
 * 但记录和 provider 侧的会话都还在。宿主**没有**取消归档的接口，所以「恢复」
 * 实际是把 provider 会话重新 import 成一个新会话——那需要 provider 会话 id，
 * 而界面上原本没有任何地方能查到它，用户只能记住一串内部 id。
 *
 * 这里只做三件事：把本工作区已归档的会话列出来、把 provider 会话 id 摊开、
 * 把恢复命令拼好。不 import、不改宿主状态：真正恢复是用户自己执行那条命令。
 */

/** 宿主一次最多回多少条；也是我们向后翻页的步长。 */
const PAGE_LIMIT = 200;

/**
 * 一次调用最多翻几页。
 *
 * 宿主的归档列表是**跨全部工作区**的，本工作区的记录可能被别的仓库挤到后面去。
 * 只取第一页再本地过滤，会让「这个工作区有归档」凭空变成「没有」——所以往后翻，
 * 但单次调用不能无限翻：翻到上限就把 `nextCursor` 交给界面，由用户决定要不要继续读。
 */
const MAX_PAGES = 5;

/** 归档会话的标签里只带 deck 自己的那几颗回恢复命令。 */
const DECK_LABEL_PREFIX = "deck.";

/** 宿主列表里的一条会话记录（协议 `fetch_agents_response` 的 `agent`）。 */
type ListedAgent = PaseoAgentListResult["entries"][number]["agent"];

export interface ArchivedAgentsInput {
  workspaceId: string;
  workspaceDir: string;
  /** 从哪一批之后继续往前读；省略表示从最新的一条开始。 */
  cursor?: string;
}

export type ArchivedAgentsResult =
  | {
      ok: true;
      workspaceId: string;
      workspaceDir: string;
      rows: ArchivedAgentRow[];
      /** 宿主的归档还没读完（超过单次翻页上限）：清单不完整，界面要说清楚。 */
      truncated: boolean;
      /** 继续往前读的游标；没有更早的记录时为 null。 */
      nextCursor: string | null;
      warnings: string[];
    }
  | { ok: false; reason: "invalid-workspace" | "agents-failed"; detail: string };

/**
 * 命令参数里的引号处理。
 *
 * 会话 id、目录、标签值都可能带空格或引号；直接拼成一行命令，
 * 用户粘到终端里就是另一条命令。普通字符原样输出，其余一律单引号包裹。
 *
 * `#` 不在白名单里：词首的 `#` 在交互式 shell 里会被当成注释，后面整段参数消失。
 * `-` 留在白名单里（uuid 里到处都是），但**以** `-` 开头的值单靠引号救不回来——
 * 它照样被当成选项，那种情况由调用方直接拒绝，不拼命令。
 */
function shellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 恢复命令里只带 deck 自己的标签：父会话关系带不回一个已经归档的窗口。 */
function deckLabelsOf(labels: Readonly<Record<string, string>> | undefined): Array<[string, string]> {
  return Object.entries(labels ?? {})
    .filter(([key, value]) => key.startsWith(DECK_LABEL_PREFIX) && value.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
}

interface RestorePlan {
  command: string | null;
  blocked: string | null;
}

/**
 * 拼恢复命令：`paseo import <provider 会话 id> --provider <客户端> --cwd <目录>`。
 *
 * 缺任何一位都不拼半条命令——半条命令粘进终端只会报错，比没有更糟。
 * 会话 id 只认 `persistence.sessionId`：`nativeHandle` 是客户端自己的句柄
 * （Codex thread id / resume token），拿它去 import 会导错或导不回来。
 */
function restorePlanOf(agent: ListedAgent, sessionId: string | null): RestorePlan {
  if (!sessionId) {
    return {
      command: null,
      blocked: "这条记录没有 provider 会话 id（该客户端不保留会话，或记录早于这个字段）：import 不回来",
    };
  }
  const provider = agent.provider?.trim();
  if (!provider) return { command: null, blocked: "记录里没有客户端 id：不知道用哪个 provider 去 import" };
  const cwd = agent.cwd?.trim();
  if (!cwd) return { command: null, blocked: "记录里没有工作目录：import 需要 --cwd 指定在哪里接着聊" };
  if ([sessionId, provider, cwd].some((value) => value.startsWith("-"))) {
    return { command: null, blocked: "会话 id / 客户端 / 目录以 - 开头：粘进终端会被当成选项，这条路走不通" };
  }

  const parts = ["paseo", "import", shellArg(sessionId), "--provider", shellArg(provider), "--cwd", shellArg(cwd)];
  for (const [key, value] of deckLabelsOf(agent.labels)) {
    parts.push("--label", shellArg(`${key}=${value}`));
  }
  return { command: parts.join(" "), blocked: null };
}

/** 归档时间新的在前；同一时刻用 agent id 兜底，保证每次顺序一致。 */
function newerFirst(left: ArchivedAgentRow, right: ArchivedAgentRow): number {
  const at = (row: ArchivedAgentRow) => Date.parse(row.archivedAt ?? row.updatedAt ?? "");
  const diff = at(right) - at(left);
  if (Number.isFinite(diff) && diff !== 0) return diff;
  return left.agentId.localeCompare(right.agentId);
}

function toRow(agent: ListedAgent): ArchivedAgentRow {
  const sessionId = agent.persistence?.sessionId?.trim() || null;
  const plan = restorePlanOf(agent, sessionId);
  return {
    agentId: agent.id,
    title: agent.title ?? null,
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    status: agent.status ?? null,
    cwd: agent.cwd ?? null,
    archivedAt: agent.archivedAt ?? null,
    updatedAt: agent.updatedAt ?? null,
    sessionId,
    restoreCommand: plan.command,
    restoreBlocked: plan.blocked,
    providerUnavailable: agent.providerUnavailable === true,
    labels: { ...agent.labels },
  };
}

interface ArchivedPages {
  entries: ListedAgent[];
  /** 宿主一共回了多少条（含没归档的活会话）：说明「读了多久」用得上。 */
  scanned: number;
  /** 翻到上限还没读完。 */
  truncated: boolean;
  /** 继续往前读的游标；读完时为 null。 */
  nextCursor: string | null;
}

/** 从 `startCursor` 起向后翻页；读到上限就停下并把游标交出去。 */
async function readArchivedEntries(paseo: PaseoApi, startCursor?: string): Promise<ArchivedPages> {
  const entries: ListedAgent[] = [];
  // 相邻两页可能有重叠（会话在翻页途中被归档），重复的 id 只留第一次见到的那条，
  // 否则同一张票在界面上出现两行、React 的 key 也会撞。
  const seen = new Set<string>();
  let scanned = 0;
  let cursor = startCursor;
  let hasMore = false;
  let nextCursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // `includeArchived` 必须在：不加这一位，宿主只会回默认列表，这一页永远是空的。
    const listed = await paseo.agents.list({
      filter: { includeArchived: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });

    // 归档记录靠 `archivedAt` 认：不带这一位的都是还活着的会话，默认列表里本来就有。
    for (const agent of listed.entries.map((entry) => entry.agent)) {
      if (!agent?.id || !agent.archivedAt || seen.has(agent.id)) continue;
      seen.add(agent.id);
      entries.push(agent);
    }
    scanned += listed.entries.length;

    hasMore = listed.pageInfo?.hasMore === true;
    nextCursor = hasMore ? (listed.pageInfo.nextCursor ?? null) : null;
    // 读完了；或者「还有更多但没给游标」——翻不动了，只能如实说没读完。
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return { entries, scanned, truncated: hasMore, nextCursor };
}

export async function listArchivedAgents(paseo: PaseoApi, input: ArchivedAgentsInput): Promise<ArchivedAgentsResult> {
  const workspaceId = input.workspaceId?.trim() ?? "";
  const workspaceDir = input.workspaceDir?.trim() ?? "";
  if (!workspaceId || !workspaceDir) {
    return { ok: false, reason: "invalid-workspace", detail: "需要 workspaceId 与工作区目录" };
  }

  let pages: ArchivedPages;
  try {
    pages = await readArchivedEntries(paseo, input.cursor?.trim() || undefined);
  } catch (error) {
    return { ok: false, reason: "agents-failed", detail: sessionErrorDetail(error) };
  }

  // 归属按 workspaceId 认；没有 workspaceId 的旧记录再用目录兜底（同一个目录
  // 重建过工作区时 id 会变，只认 id 会让老记录凭空消失）。
  const rows = pages.entries
    .filter((agent) => matchesWorkspaceScope({ workspaceId: agent.workspaceId, cwd: agent.cwd }, workspaceId, workspaceDir))
    .map(toRow)
    .sort(newerFirst);

  const warnings: string[] = [];
  if (pages.truncated) {
    warnings.push(
      pages.nextCursor
        ? `这次只读到这里（共 ${pages.scanned} 条记录）：更早的归档还没读，可以用「读取更早的」继续往前（归档列表是跨全部工作区的）`
        : `这次只读到这里（共 ${pages.scanned} 条记录）：宿主说还有更早的记录却没给游标，翻不动了——清单不完整`,
    );
  }
  const blocked = rows.filter((row) => row.restoreBlocked !== null).length;
  if (blocked > 0) {
    warnings.push(
      `${blocked} 条已归档记录给不出恢复命令：那些记录没有存下客户端那边的会话 id（记录早于这个字段，或该客户端不保留会话），只能看那一行写的原因`,
    );
  }
  const unavailable = rows.filter((row) => row.providerUnavailable).length;
  if (unavailable > 0) {
    warnings.push(`${unavailable} 条记录的客户端现在不可用（宿主里没有这个 provider）：装回来之前 import 会失败`);
  }

  return {
    ok: true,
    workspaceId,
    workspaceDir,
    rows,
    truncated: pages.truncated,
    nextCursor: pages.nextCursor,
    warnings,
  };
}
