/**
 * 协调收件箱的「转给」：把一条 territory 请求真的交给目标岗位。
 *
 * 规格阀门三第 3 条要求「新建或续用它的会话」并把原文带过去——只把状态改成
 * `reassigned` 不算转派。这里优先复用目标岗位已在跑的会话；没有才按卡上的档案
 * （或 normal 档路由）新建，systemPrompt 现拼岗位职责 + 群消息 + 履历。
 *
 * 失败方向是保留 `pending`：这里只负责「有没有送到」，状态迁移由调用方在成功后做，
 * 送不到就不改状态，收件箱里还能再点一次。
 */

import type { PaseoApi } from "@getpaseo/client";
import type {
  ClientTarget,
  ModelThinkingDefault,
  RoutingRule,
  ThinkingResolutionContext,
} from "../shared/orchestration.ts";
import {
  DECK_STAFF_LABEL,
  DECK_TICKET_LABEL,
  PARENT_AGENT_ID_LABEL,
  providerSpec,
  resolveRoute,
  resolveRouteTarget,
  workspaceRolesOf,
} from "../shared/orchestration.ts";
import { matchesWorkspaceScope, truncateTitle } from "../shared/session.ts";
import { isValidStaffId, rosterOf, type StaffCard } from "../shared/staff.ts";
import { resolveOwner } from "../shared/staff-guard.ts";
import { buildGroupContext } from "./group-context.ts";
import { readGroupDirectory } from "./group-store.ts";
import { profilesOf, readDaemonConfig } from "./orchestration.ts";
import { thinkingContextOf } from "./provider-entry.ts";
import { readOrchestration } from "./orchestration-store.ts";
import { createAgent, sessionErrorDetail } from "./session.ts";
import { collectStaffHistory } from "./staff-history.ts";
import type { CoordinationRecord } from "./staff-territory.ts";

export type ReassignDelivery =
  | {
      readonly ok: true;
      readonly agentId: string;
      /** true = 新建了会话；false = 复用了已在跑的那一个。 */
      readonly created: boolean;
      readonly warnings: string[];
    }
  | { readonly ok: false; readonly detail: string };

export interface ReassignInput {
  readonly paseo: PaseoApi;
  readonly workspaceId: string;
  readonly workspaceDir: string;
  readonly record: CoordinationRecord;
  readonly card: StaffCard;
  readonly roster: readonly StaffCard[];
  readonly routing: readonly RoutingRule[];
  /** 卡片上按模型配的默认档；没显式设档位时用它。 */
  readonly modelThinking: readonly ModelThinkingDefault[];
  /** 这个工作区配的派单窗口：原会话没有父标签时用它接上回传链。 */
  readonly dispatcherAgentId?: string | null;
}

export type ReassignTargetResolution =
  | {
      readonly ok: true;
      readonly staffId: string;
      readonly card: StaffCard;
      readonly roster: readonly StaffCard[];
      readonly routing: readonly RoutingRule[];
      readonly modelThinking: readonly ModelThinkingDefault[];
      readonly dispatcherAgentId: string | null;
    }
  | { readonly ok: false; readonly reason: "read-failed" | "invalid-action"; readonly detail: string };

export type ResolvedReassignTarget = Extract<ReassignTargetResolution, { ok: true }>;

interface AgentListEntry {
  readonly id: string;
  readonly labels: Record<string, string>;
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly updatedAt?: string;
}

function labelsOf(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function entriesOf(listed: unknown): AgentListEntry[] {
  const entries = (listed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  const out: AgentListEntry[] = [];
  for (const entry of entries) {
    const agent = (entry as { agent?: unknown } | null)?.agent;
    if (typeof agent !== "object" || agent === null) continue;
    const view = agent as Record<string, unknown>;
    const id = typeof view.id === "string" ? view.id.trim() : "";
    if (!id) continue;
    out.push({
      id,
      labels: labelsOf(view.labels),
      ...(typeof view.workspaceId === "string" ? { workspaceId: view.workspaceId } : {}),
      ...(typeof view.cwd === "string" ? { cwd: view.cwd } : {}),
      ...(typeof view.updatedAt === "string" ? { updatedAt: view.updatedAt } : {}),
    });
  }
  return out;
}

function newestFirst(a: AgentListEntry, b: AgentListEntry): number {
  return (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0);
}

/**
 * 校验转派目标：记录上没写目标时由人从名册里选。
 *
 * 读失败与「名册里没这张卡」分开报：前者是文件问题，后者是人的选择问题。
 */
export async function resolveReassignTarget(input: {
  readonly workspaceId: string;
  readonly workspaceDir: string;
  readonly requested?: string | null;
  readonly fallback?: string | null;
}): Promise<ReassignTargetResolution> {
  const staffId = (input.requested ?? "").trim() || (input.fallback ?? "").trim();
  if (!staffId) {
    return { ok: false, reason: "invalid-action", detail: "这条请求没有目标岗位：先在名册里选一张卡再转派" };
  }
  if (!isValidStaffId(staffId)) {
    return { ok: false, reason: "invalid-action", detail: `目标岗位 id 不合法：「${staffId}」` };
  }
  const read = await readOrchestration(input.workspaceDir);
  if (read.readFailed || read.corrupt) {
    return {
      ok: false,
      reason: "read-failed",
      detail: read.detail ?? (read.corrupt ? "编排文件损坏，读不出名册" : "编排文件读不出来"),
    };
  }
  // 名册按目录取：同一目录会有好几个 workspaceId，按 id 取会读成一个空名册。
  // 派单窗口仍是槽位，按 id 取。
  const binding = workspaceRolesOf(read.settings, input.workspaceId);
  const roster = rosterOf(read.settings);
  const card = roster.find((item) => item.id === staffId) ?? null;
  if (!card) {
    return {
      ok: false,
      reason: "invalid-action",
      detail: roster.length > 0
        ? `名册里没有 id 为「${staffId}」的卡：可选 ${roster.map((item) => item.id).join(" / ")}`
        : `工作区 ${input.workspaceId} 的名册是空的：先建卡再转派`,
    };
  }
  return {
    ok: true,
    staffId,
    card,
    roster,
    routing: read.settings.routing,
    modelThinking: read.settings.modelThinking,
    dispatcherAgentId: binding?.dispatcherAgentId?.trim() || null,
  };
}

/** 转派 prompt：任务原文与路径都要进去，不能只发一句「有人找你」。 */
export function reassignPromptOf(record: CoordinationRecord, card: StaffCard): string {
  const paths = record.paths.length
    ? record.paths.map((path) => `- ${path}`).join("\n")
    : "-（请求没有列出具体路径，按原任务描述处理）";
  return [
    "## 转派请求",
    `${record.fromStaff} 发起的改动落在「${card.name}」负责的区里；原会话已被拒绝并被告知先来协调。`,
    `原任务：${record.taskSummary}`,
    "涉及路径：",
    paths,
    `发起会话：${record.sessionAgentId}`,
    `请接手这项改动：先确认范围，再在「${card.name}」的区内实施；要改到别人的区时继续走协调，不要直接改。`,
  ].join("\n");
}

/** 目标卡不覆盖这些路径时留一条 warning；仍然派，因为转给谁是人做的决定。 */
function coverageWarnings(input: ReassignInput): string[] {
  const warnings: string[] = [];
  for (const path of input.record.paths) {
    const owner = resolveOwner({
      path,
      roster: input.roster,
      workspaceId: input.workspaceId,
    });
    if (!owner.ok) {
      warnings.push(`路径 ${path} 判不出归谁（${owner.detail}），这次按人的选择转给「${input.card.id}」`);
      continue;
    }
    if (owner.staff.id !== input.card.id) {
      warnings.push(`路径 ${path} 按名册归「${owner.staff.id}」，这次仍按人的选择转给「${input.card.id}」`);
    }
  }
  return warnings;
}

async function existingSessionOf(input: ReassignInput): Promise<AgentListEntry | null> {
  const listed = await input.paseo.agents.list({
    filter: { labels: { [DECK_STAFF_LABEL]: input.card.id }, includeArchived: false },
  });
  return entriesOf(listed)
    .filter((agent) => matchesWorkspaceScope(agent, input.workspaceId, input.workspaceDir))
    .sort(newestFirst)[0] ?? null;
}

async function originalLabelsOf(
  input: ReassignInput,
): Promise<{ readonly labels: Record<string, string>; readonly found: boolean }> {
  const listed = await input.paseo.agents.list({ filter: { includeArchived: true } });
  const original = entriesOf(listed).find((agent) => agent.id === input.record.sessionAgentId);
  return { labels: original?.labels ?? {}, found: Boolean(original) };
}

function clientTargetOf(
  input: ReassignInput,
  profiles: ReturnType<typeof profilesOf>,
  thinking: ThinkingResolutionContext,
): { readonly ok: true; readonly target: ClientTarget } | { readonly ok: false; readonly detail: string } {
  const rule = input.card.profileId
    ? { difficulty: "normal" as const, profileId: input.card.profileId }
    : resolveRoute({ routing: input.routing }, "normal");
  const target = resolveRouteTarget(rule, profiles, thinking);
  if (!target.ok) {
    return { ok: false, detail: `找不到「${input.card.name}」可用的客户端：${target.detail}` };
  }
  return { ok: true, target: target.target };
}

async function systemPromptOf(input: ReassignInput, warnings: string[]): Promise<string> {
  // 群属于目录：改派过去的会话要看到本群最近的对话，不能只读当前 id 那个记录文件。
  const group = await readGroupDirectory(input.workspaceDir);
  if (group.failed) warnings.push(group.failed);
  const history = await collectStaffHistory(input.paseo, {
    workspaceId: input.workspaceId,
    staffId: input.card.id,
    workspaceDir: input.workspaceDir,
  });
  warnings.push(...history.warnings);
  return buildGroupContext({
    card: input.card,
    records: group.records,
    historyText: history.text,
  }).text;
}

async function sendToExisting(
  input: ReassignInput,
  session: AgentListEntry,
  prompt: string,
): Promise<ReassignDelivery> {
  try {
    await input.paseo.agents.ref(session.id).send(prompt);
  } catch (error) {
    return { ok: false, detail: `发给「${input.card.name}」的会话 ${session.id} 失败：${sessionErrorDetail(error)}` };
  }
  return { ok: true, agentId: session.id, created: false, warnings: [] };
}

async function createForStaff(
  input: ReassignInput,
  prompt: string,
  warnings: string[],
): Promise<ReassignDelivery> {
  const config = await readDaemonConfig(input.paseo);
  const profiles = profilesOf(config);
  const client = clientTargetOf(input, profiles, thinkingContextOf(input.modelThinking, config));
  if (!client.ok) return client;

  let originalLabels: Record<string, string> = {};
  try {
    const original = await originalLabelsOf(input);
    originalLabels = original.labels;
    if (!original.found) {
      warnings.push(`找不到原会话 ${input.record.sessionAgentId}，转派会话没有沿用票号 / 父会话`);
    }
  } catch (error) {
    warnings.push(`读原会话标签失败，转派会话不带票号 / 父会话：${sessionErrorDetail(error)}`);
  }

  const labels: Record<string, string> = { [DECK_STAFF_LABEL]: input.card.id };
  const ticketKey = originalLabels[DECK_TICKET_LABEL]?.trim();
  // 只沿用形如 #12 / owner/repo#12 的票号；畸形值宁可丢掉，也不挂到一张不存在的票上。
  if (ticketKey && /^(?:[^\s#]*)#[1-9]\d*$/.test(ticketKey)) labels[DECK_TICKET_LABEL] = ticketKey;
  // 只挂工作区配的派单窗口：原会话的父会话可能是发起员工，不该被继承。
  const parentAgentId = input.dispatcherAgentId?.trim() || "";
  if (parentAgentId) labels[PARENT_AGENT_ID_LABEL] = parentAgentId;

  const systemPrompt = await systemPromptOf(input, warnings);
  const title = truncateTitle(`转派：${input.record.taskSummary}`);
  const result = await createAgent(input.paseo, {
    workspaceId: input.workspaceId,
    cwd: input.workspaceDir,
    provider: providerSpec(client.target),
    ...(client.target.modeId ? { modeId: client.target.modeId } : {}),
    ...(client.target.thinkingOptionId ? { thinkingOptionId: client.target.thinkingOptionId } : {}),
    ...(client.target.featureValues ? { featureValues: client.target.featureValues } : {}),
    prompt,
    title,
    labels,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
    ledger: false,
  });
  if (!result.ok) {
    return { ok: false, detail: `新建「${input.card.name}」的会话失败：${result.failure.detail}` };
  }
  if (result.partial) {
    return {
      ok: false,
      detail: `会话 ${result.agentId} 建出来了，但任务没发出去：${result.failure?.detail ?? "未知原因"}（请求仍是 pending，可重试）`,
    };
  }
  return { ok: true, agentId: result.agentId, created: true, warnings };
}

/** 把一条越界请求交给目标岗位：优先复用会话，没有才新建。 */
export async function deliverReassign(input: ReassignInput): Promise<ReassignDelivery> {
  try {
    const prompt = reassignPromptOf(input.record, input.card);
    const existing = await existingSessionOf(input);
    if (existing) {
      const sent = await sendToExisting(input, existing, prompt);
      return sent.ok ? { ...sent, warnings: coverageWarnings(input) } : sent;
    }
    return await createForStaff(input, prompt, coverageWarnings(input));
  } catch (error) {
    // 兜底：任何未预料的异常都收成「没送到」，调用方据此保留 pending。
    return { ok: false, detail: `派活时出错：${sessionErrorDetail(error)}` };
  }
}
