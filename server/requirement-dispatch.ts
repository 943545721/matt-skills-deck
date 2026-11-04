/**
 * 需求 → 每区一张票 + 每区一个派单批次。
 *
 * 这一层只做组装，不重写任何既有规则：
 * - 拆票规则在 `shared/requirement-split.ts`（含「无 deck:定稿不拆」「待核只出研究票」
 *   「区里没员工不回落」等闸）；
 * - 派单规则在 `shared/orchestration.ts` 的 `planDispatch`（难度路由、幂等、预算、父子回传）；
 * - 真正建票 / 建会话仍走 `runDispatch`，所以「先建票再建会话」这件事没有第二条实现。
 *
 * 跨工作区时每个批次各读自己那份 `.deck/orchestration.json`，用自己的名册、路由与
 * 派单窗口；子会话的 `parentAgentId` 永远是那个工作区的派单窗口（`runDispatch` 在
 * 没传 `callerAgentId` 时就是这么写的），不会改成子会话自己所在的工作区。
 *
 * 两种确认：`confirmRequirementSplit !== false`（默认）只出清单，一张票、一个会话都不建；
 * `false` 时直接铺。两种取值下算出来的票面与批次完全相同，区别只在 `run` 是否动手。
 */

import type { PaseoApi } from "@getpaseo/client";
import {
  IMPACT_HEADING,
  needsManualImpactTable,
  parseImpactTable,
  singleAreaImpactRow,
} from "../shared/impact.ts";
import {
  planRequirementSplit,
  RESEARCH_LABEL,
  uniqueRepos,
  workspaceForRow,
  type ImpactRow,
  type RejectedImpactArea,
  type RequirementSplitResult,
  type RequirementTicket,
  type ResearchTicketPlan,
  type SplitTicketPlan,
  type SplitWorkspace,
} from "../shared/requirement-split.ts";
import {
  type ClientProfile,
  type DispatchRejected,
  type DispatchTask,
  type OrchestrationSettings,
} from "../shared/orchestration.ts";
import type { StaffCard } from "../shared/staff.ts";
import { guardCreateTicket } from "../shared/split-guard.ts";
import { requirementLabelsOf } from "./requirement-read.ts";
import { readOrchestration } from "./orchestration-store.ts";
import { runDispatch, type DispatchOutcomeResult } from "./orchestration.ts";
import { writableRepoKeys } from "./tracker/targets.ts";
import { createResearchTicket, type ResearchTicketRunResult } from "./requirement-research.ts";
import { batchPlanOf, missingImpactOf } from "./requirement-batch-plan.ts";

/** 一个参与拆分的工作区。名册 / 派单窗口 / 仓库都可以由调用方预读后传入。 */
export interface RequirementDispatchWorkspace {
  readonly workspaceId: string;
  readonly workspaceDir: string;
  /** 显示名；省略时用 workspaceId。 */
  readonly name?: string;
  /** 预读的名册；不给就从该工作区的编排文件里读。 */
  readonly roster?: readonly StaffCard[];
  /** 预读的派单窗口；不给就按编排文件。 */
  readonly dispatcherAgentId?: string | null;
  /** 预读的仓库清单；不给就按工作区配置 / 目录扫描。 */
  readonly repos?: readonly string[];
}

/** 需求票：正文与标签都要原样带进来，定稿与影响面判断全按它们。 */
export interface RequirementDispatchTicket extends RequirementTicket {
  /** 需求票所在仓库；跨仓库时不挂父边，只在票面留 Refs。 */
  readonly repoKey?: string | null;
}

export interface RequirementDispatchInput {
  readonly requirement: RequirementDispatchTicket;
  readonly workspaces: readonly RequirementDispatchWorkspace[];
  /**
   * 预解析的影响面行（含 workspaceId / repoKey / pathPrefix 这些机器字段）。
   * 不给时从 `requirement.body` 的 `## 影响面` 表解析。
   */
  readonly impact?: readonly ImpactRow[];
  /** 默认 true（先出清单）；false 时直接铺。 */
  readonly confirmRequirementSplit?: boolean;
  /** 批次前缀；同一需求重试时复用可让远端幂等锚生效。 */
  readonly dispatchId?: string;
  /** 客户端档案；不给时只按路由里的 provider/model 预览。 */
  readonly profiles?: readonly ClientProfile[];
  readonly lang?: "zh" | "en";
}

export interface RequirementDispatchEntry {
  readonly ticket: SplitTicketPlan;
  /** 已按这个工作区的路由解析好的任务（含 staff / region / provider / model）。 */
  readonly task: DispatchTask;
}

export interface RequirementDispatchBatchPlan {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly dispatcherAgentId: string;
  readonly dispatchId: string;
  readonly entries: readonly RequirementDispatchEntry[];
  /** 这个批次里被派单规则拒掉的（名册、region、预算等）。 */
  readonly rejected: readonly DispatchRejected[];
}

export type RequirementDispatchRejectReason =
  | "no-requirement"
  | "bad-impact"
  | "missing-impact"
  | "unknown-workspace"
  | "not-finalized"
  | "empty-impact"
  | "no-workspace"
  | "settings-unreadable"
  | "settings-corrupt"
  | "no-dispatcher";

export type RequirementDispatchPlan =
  | {
      readonly ok: true;
      readonly requiresConfirmation: boolean;
      readonly requirementNumber: number;
      readonly batches: readonly RequirementDispatchBatchPlan[];
      readonly research: readonly ResearchTicketPlan[];
      readonly rejected: readonly RejectedImpactArea[];
      readonly skipped: readonly string[];
      readonly warnings: string[];
    }
  | { readonly ok: false; readonly reason: RequirementDispatchRejectReason; readonly detail: string };

interface ResolvedWorkspace {
  readonly input: RequirementDispatchWorkspace;
  readonly split: SplitWorkspace;
  readonly settings: OrchestrationSettings;
  readonly repos: readonly string[];
}

interface ResolvedImpact {
  readonly ok: true;
  readonly rows: readonly ImpactRow[];
}
interface FailedImpact {
  readonly ok: false;
  readonly reason: RequirementDispatchRejectReason;
  readonly detail: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 影响面「区 / 仓库」列与别名是否指同一件事。
 *
 * 仓库键通常是 `owner/name`，人可能只写 `name`；工作区名也可能带路径。
 * 两端都比一次首段与末段，避免 `billing` 对不上 `acme/billing` 后退回当前区。
 */
function sameArea(area: string, alias: string): boolean {
  if (area === alias) return true;
  const areaParts = area.split("/").filter(Boolean);
  const aliasParts = alias.split("/").filter(Boolean);
  return (
    areaParts[0] === alias ||
    aliasParts[0] === area ||
    areaParts[areaParts.length - 1] === alias ||
    aliasParts[aliasParts.length - 1] === area
  );
}

/**
 * 把需求正文的影响面表补成拆票层要的 `ImpactRow[]`。
 *
 * 表里只有给人看的「区 / 仓库」；机器字段这样补：
 * - `workspaceId` 交给 `workspaceForRow`（单工作区自动落，多工作区按 id / 名字 / 仓库名匹配）；
 * - `repoKey` 先看人写的，其次看第一列是不是仓库键；
 * - `pathPrefix` 先看人写的，其次用第一列当路径前缀——名册的 `paths` 也是人写的目录，
 *   两者对不上时拆票层会以 `no-worker` 点名，而不是悄悄派给别处。
 */
function impactRowsOf(input: RequirementDispatchInput, workspaces: readonly SplitWorkspace[]): ResolvedImpact | FailedImpact {
  const body = typeof input.requirement.body === "string" ? input.requirement.body : "";
  const sectionWritten = body.split(/\r?\n/).some((line) => line.trim() === IMPACT_HEADING);
  const allRepos = [...new Set(workspaces.flatMap((workspace) => uniqueRepos(workspace)))];
  const manual = needsManualImpactTable({
    repos: allRepos,
    // 单工作区、没声明链条时允许自动填一行；声明了链条这里不猜，交给表校验。
    hasChain: false,
  });

  if (!sectionWritten && (manual || workspaces.length > 1)) {
    return {
      ok: false,
      reason: "missing-impact",
      detail:
        `需求 #${input.requirement.number} 跨了多个区 / 仓库，但正文没有「${IMPACT_HEADING}」表：` +
        "按区写清 区 / 仓库、依据、结论、核的人，再拆票。",
    };
  }

  let parsed: readonly ImpactRow[];
  if (sectionWritten) {
    const table = parseImpactTable(body);
    if (!table.ok) return { ok: false, reason: "bad-impact", detail: table.reason };
    // 解析器只产给人看的四列；机器字段由下面这段补，不会丢原文。
    parsed = table.rows as readonly ImpactRow[];
  } else {
    parsed = [singleAreaImpactRow()];
  }

  return { ok: true, rows: parsed.map((row) => impactRowOf(row, allRepos, workspaces, sectionWritten)) };
}

/** 给人看的四列 → 拆票层要的机器字段；原文不丢，只在缺省时补。 */
function impactRowOf(
  row: ImpactRow,
  allRepos: readonly string[],
  workspaces: readonly SplitWorkspace[],
  sectionWritten: boolean,
): ImpactRow {
  const area = text(row.area);
  const explicitRepo = text(row.repoKey);
  const explicitPrefix = text(row.pathPrefix);
  // 第一列能对上仓库键时，它是「仓库」不是「路径」。
  const repoHit = explicitRepo
    ? explicitRepo
    : allRepos.find((repo) => repo.toLowerCase() === area.toLowerCase()) ?? "";
  // 单区自动行（区 = 「当前工作区」）不拿来当路径；
  // 人工表里只有写成 `web/src` 这种真路径才当领地，纯区名不猜目录。
  const workspace = workspaceForRow({ ...row, area }, workspaces);
  const namedWorkspace =
    workspace !== null &&
    (area === workspace.workspaceId || area === workspace.name);
  const derivedPrefix =
    sectionWritten && !repoHit && !namedWorkspace && area.includes("/") ? area : "";
  return {
    ...row,
    area,
    ...(workspace && !text(row.workspaceId) ? { workspaceId: workspace.workspaceId } : {}),
    ...(repoHit ? { repoKey: repoHit } : {}),
    ...(explicitPrefix || derivedPrefix ? { pathPrefix: explicitPrefix || derivedPrefix } : {}),
  };
}

async function resolveWorkspaces(
  inputs: readonly RequirementDispatchWorkspace[],
): Promise<{ ok: true; resolved: ResolvedWorkspace[] } | { ok: false; reason: RequirementDispatchRejectReason; detail: string }> {
  const resolved: ResolvedWorkspace[] = [];
  for (const input of inputs) {
    const stored = await readOrchestration(input.workspaceDir);
    if (stored.readFailed) {
      return {
        ok: false,
        reason: "settings-unreadable",
        detail: `工作区 ${input.workspaceId} 的编排文件读不出来（不是「没配过」）：${stored.detail ?? "未知原因"}`,
      };
    }
    if (stored.corrupt) {
      return {
        ok: false,
        reason: "settings-corrupt",
        detail: `工作区 ${input.workspaceId} 的编排文件解析失败：${stored.detail ?? "格式不对"}——先修好再拆需求。`,
      };
    }
    const role = stored.settings.roles.find((item) => item.workspaceId === input.workspaceId);
    const roster = input.roster ? [...input.roster] : (role?.staff ?? []);
    const dispatcher =
      input.dispatcherAgentId !== undefined
        ? text(input.dispatcherAgentId)
        : text(role?.dispatcherAgentId);
    const repos =
      input.repos !== undefined
        ? [...input.repos]
        : (await writableRepoKeys(input.workspaceDir)).keys;
    resolved.push({
      input,
      settings: stored.settings,
      repos,
      split: {
        workspaceId: input.workspaceId,
        ...(input.name ? { name: input.name } : {}),
        roster,
        dispatcherAgentId: dispatcher || null,
        repos,
      },
    });
  }
  return { ok: true, resolved };
}

/**
 * 从编排文件里带出这次真正参与的工作区。
 *
 * 一个工作区目录里的角色绑定可以有好几条（同一份 `.paseo-deck.json` 下注册了多个
 * 宿主工作区）。全都塞进计划会让「只动一个区」的需求也被要求给每个区写影响面行，
 * 所以只留下影响面点名的那些；没写影响面时只算调用方自己那一个。
 */
export async function requirementWorkspacesOf(input: {
  readonly workspaceDir: string;
  readonly workspaceId?: string | null;
  readonly body?: string | null;
  /**
   * 宿主工作区 id → 目录。RPC 层有 PaseoApi，能列出真实目录；MCP 层没有，
   * 不传时退回 `workspaceDir`（只用于出清单，不执行）。
   */
  readonly workspaceDirs?: ReadonlyMap<string, string> | null;
  /** 宿主工作区 id → 显示名 / 项目名 / 目录名；影响面「区 / 仓库」列可以写这些。 */
  readonly workspaceAliases?: ReadonlyMap<string, readonly string[]> | null;
}): Promise<
  | {
      readonly ok: true;
      readonly workspaceId: string;
      readonly workspaces: readonly RequirementDispatchWorkspace[];
      /** 影响面里对不上任何工作区别名的行；MCP 只能提示，RPC 可拿宿主清单再核。 */
      readonly unmatchedAreas: readonly string[];
    }
  | { readonly ok: false; readonly reason: RequirementDispatchRejectReason; readonly detail: string }
> {
  const stored = await readOrchestration(input.workspaceDir);
  if (stored.readFailed) {
    return {
      ok: false,
      reason: "settings-unreadable",
      detail: `读不出编排设置（不是「没配过」）：${stored.detail ?? "未知原因"}`,
    };
  }
  if (stored.corrupt) {
    return {
      ok: false,
      reason: "settings-corrupt",
      detail: `编排文件解析失败：${stored.detail ?? "格式不对"}——先修好它再拆需求。`,
    };
  }

  // 宿主清单里可能有当前编排文件没绑定的工作区：跨区需求按影响面点名时，
  // 不能因为「本文件没这条角色」就把那一区静默并进当前区。
  const ids = [
    ...new Set([
      ...stored.settings.roles.map((role) => role.workspaceId.trim()).filter(Boolean),
      ...(input.workspaceDirs ? [...input.workspaceDirs.keys()] : []),
      ...(input.workspaceAliases ? [...input.workspaceAliases.keys()] : []),
    ]),
  ];
  const current =
    text(input.workspaceId) ||
    text(stored.workspaceId) ||
    (ids.length === 1 ? ids[0] ?? "" : "");
  if (!ids.length && !current) {
    return {
      ok: false,
      reason: "no-workspace",
      detail: "这个工作区还没有角色绑定：先到「编排」里选一个工作区、加一条角色。",
    };
  }

  const body = typeof input.body === "string" ? input.body : "";
  const table = body.split(/\r?\n/).some((line) => line.trim() === IMPACT_HEADING)
    ? parseImpactTable(body)
    : null;
  // 「不动」的区不建票，也不该决定这次挑哪些工作区；其余结论文本都参与匹配。
  const areas = table?.ok
    ? table.rows
        .filter((row) => text(row.conclusion) !== "不动")
        .map((row) => text(row.area).toLowerCase())
        .filter(Boolean)
    : [];
  // 影响面「区 / 仓库」列给人写，可能写 id、显示名、项目名或目录名；只比 id 会让
  // 一个真实跨区需求退化成「单工作区自动落当前区」。命中后把命中的别名记成 name，
  // 后面 `workspaceForRow` 才能把同一行再对回这个工作区。
  const matchedName = new Map<string, string>();
  const matchedAreas = new Set<string>();
  for (const id of ids) {
    // 仓库键也是「区 / 仓库」列常写的东西；只比显示名会让 `billing` 这类行对不上，
    // 整张需求退化成只在当前区铺票。目录拿得到就顺手把仓库键并进别名。
    const dir = text(input.workspaceDirs?.get(id));
    const repos = dir ? (await writableRepoKeys(dir)).keys : [];
    const aliases = [id, ...(input.workspaceAliases?.get(id) ?? []), ...repos]
      .map((alias) => text(alias).toLowerCase())
      .filter(Boolean);
    const hit = areas.find((area) => aliases.some((alias) => sameArea(area, alias)));
    if (hit) {
      matchedName.set(id, hit);
      matchedAreas.add(hit);
    }
  }
  const named = ids.filter((id) => matchedName.has(id));
  const chosen = [...new Set(named.length ? named : [current || ids[0] || ""])].filter(Boolean);

  const workspaces: RequirementDispatchWorkspace[] = [];
  for (const workspaceId of chosen) {
    // 有宿主清单就按 id 找真实目录：跨区批次要在各自的目录里建票、开会话，
    // 全用调用方 cwd 会把别的区的票建到错的地方。MCP 没有宿主清单，仍退回 cwd。
    const listed = text(input.workspaceDirs?.get(workspaceId));
    const fallback = input.workspaceDirs ? (workspaceId === current ? input.workspaceDir : "") : input.workspaceDir;
    const workspaceDir = listed || fallback;
    if (!workspaceDir) {
      return {
        ok: false,
        reason: "unknown-workspace",
        detail:
          `影响面点到了工作区 ${workspaceId}，但宿主里找不到它的目录：先在 Paseo 里打开这个工作区，` +
          `否则票和会话会落到错的目录。`,
      };
    }
    workspaces.push({ workspaceId, workspaceDir, name: matchedName.get(workspaceId) ?? workspaceId });
  }

  const unmatchedAreas = areas.filter((area) => !matchedAreas.has(area));
  // 候选工作区不止一个、表里又有对不上的行：不能再默认「都在当前区」。
  // 否则区名写错、或点到不在宿主清单里的区/仓库时，执行层会静默只在当前区铺票。
  if (ids.length > 1 && unmatchedAreas.length) {
    return {
      ok: false,
      reason: "unknown-workspace",
      detail:
        `影响面这些区对不上任何工作区：${unmatchedAreas.join(" / ")}。` +
        "跨区需求的「区 / 仓库」要写成工作区 id、显示名或仓库名；写错的区不能猜成当前区。",
    };
  }
  return { ok: true, workspaceId: current, workspaces, unmatchedAreas };
}

/** 读需求票原文的实现在 `requirement-read.ts`；这里保留原导出，调用方不用改。 */
export { readRequirementForDispatch } from "./requirement-read.ts";

/** 清单里的一行：每个区派给谁、用什么客户端、会开几个会话。 */
export interface RequirementDispatchSummaryRow {
  readonly kind: "work" | "research";
  readonly workspaceId: string;
  readonly area: string;
  readonly repoKey: string | null;
  readonly pathPrefix: string | null;
  readonly staffId: string | null;
  readonly staffName: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly providerSpec: string | null;
  readonly sessions: number;
}

/** 把计划压成给人看的清单；不写盘、不改计划。 */
export function summarizeRequirementDispatch(
  plan: Extract<RequirementDispatchPlan, { readonly ok: true }>,
): RequirementDispatchSummaryRow[] {
  const rows: RequirementDispatchSummaryRow[] = [];
  for (const batch of plan.batches) {
    for (const entry of batch.entries) {
      rows.push({
        kind: "work",
        workspaceId: batch.workspaceId,
        area: entry.ticket.area,
        repoKey: entry.task.repoKey ?? entry.ticket.repoKey,
        pathPrefix: entry.ticket.pathPrefix || null,
        staffId: entry.ticket.staff.id,
        staffName: entry.ticket.staff.name,
        provider: entry.task.target.provider,
        model: entry.task.target.model ?? null,
        providerSpec: entry.task.providerSpec,
        sessions: 1,
      });
    }
  }
  for (const ticket of plan.research) {
    rows.push({
      kind: "research",
      workspaceId: ticket.workspaceId,
      area: ticket.area,
      repoKey: ticket.repoKey,
      pathPrefix: ticket.pathPrefix || null,
      staffId: null,
      staffName: null,
      provider: null,
      model: null,
      providerSpec: null,
      sessions: 0,
    });
  }
  return rows;
}

type RequirementDispatchFailure = Extract<RequirementDispatchPlan, { readonly ok: false }>;

type PlannedBatches =
  | { readonly ok: true; readonly batches: RequirementDispatchBatchPlan[] }
  | { readonly ok: false; readonly failure: RequirementDispatchFailure };

/** 没显式传就按各工作区的「铺票前要我确认」：所有区都关掉才直接铺。 */
function confirmationOf(
  input: RequirementDispatchInput,
  resolved: readonly ResolvedWorkspace[],
): boolean {
  // 有任何一区没表态（默认 true）就先出清单。安全方向永远是「先给人看」。
  return (
    input.confirmRequirementSplit ??
    !resolved.every((item) => item.settings.confirmRequirementSplit === false)
  );
}

function planBatchesOf(input: {
  readonly split: Extract<RequirementSplitResult, { readonly ok: true }>;
  readonly resolved: readonly ResolvedWorkspace[];
  readonly number: number;
  readonly requirementRepoKey: string | null | undefined;
  /** 需求正文：执行层链条闸按它判，不再重读票。 */
  readonly requirementBody: string;
  readonly baseDispatchId: string;
  readonly profiles: readonly ClientProfile[] | undefined;
  readonly warnings: string[];
}): PlannedBatches {
  const byWorkspace = new Map(input.resolved.map((item) => [item.input.workspaceId, item]));
  const batches: RequirementDispatchBatchPlan[] = [];
  for (const batch of input.split.batches) {
    const workspace = byWorkspace.get(batch.workspaceId);
    if (!workspace) {
      input.warnings.push(`工作区 ${batch.workspaceId} 的拆票批次找不到工作区配置，整批跳过。`);
      continue;
    }
    const outcome = batchPlanOf({
      batch,
      workspace,
      number: input.number,
      requirementRepoKey: input.requirementRepoKey,
      requirementBody: input.requirementBody,
      baseDispatchId: input.baseDispatchId,
      profiles: input.profiles,
      warnings: input.warnings,
    });
    if (outcome.kind === "fail") return { ok: false, failure: outcome.failure };
    batches.push(outcome.batch);
  }
  return { ok: true, batches };
}

/** 纯计划：读设置、拆票、把每区票变成该区自己的派单任务；不写票、不开会话。 */
export async function planRequirementDispatch(input: RequirementDispatchInput): Promise<RequirementDispatchPlan> {
  const number = input.requirement.number;
  if (!Number.isInteger(number) || number < 0) {
    return { ok: false, reason: "no-requirement", detail: "拿不到需求票号：无票不干活，先建一条需求票。" };
  }
  const resolved = await resolveWorkspaces(input.workspaces);
  if (!resolved.ok) return resolved;

  const splitWorkspaces = resolved.resolved.map((item) => item.split);
  const impact = impactRowsOf(input, splitWorkspaces);
  if (!impact.ok) return impact;

  const missingImpact = missingImpactOf(number, impact.rows, splitWorkspaces);
  if (missingImpact) return missingImpact;

  const split = planRequirementSplit({
    requirement: input.requirement,
    impact: impact.rows,
    workspaces: splitWorkspaces,
    confirmRequirementSplit: confirmationOf(input, resolved.resolved),
  });
  if (!split.ok) return split;

  const warnings: string[] = [];
  const planned = planBatchesOf({
    split,
    resolved: resolved.resolved,
    number,
    requirementRepoKey: input.requirement.repoKey,
    requirementBody: typeof input.requirement.body === "string" ? input.requirement.body : "",
    baseDispatchId: text(input.dispatchId) || `req-${number}`,
    profiles: input.profiles,
    warnings,
  });
  if (!planned.ok) return planned.failure;

  return {
    ok: true,
    requiresConfirmation: split.requiresConfirmation,
    requirementNumber: number,
    batches: planned.batches,
    research: split.research,
    rejected: split.rejected,
    skipped: split.skipped,
    warnings,
  };
}

export interface RequirementDispatchBatchResult {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly dispatcherAgentId: string;
  /** 票面闸拦下的：这些区一张票、一个会话都不会建。 */
  readonly blocked: readonly { readonly area: string; readonly detail: string }[];
  readonly results: readonly DispatchOutcomeResult[];
}

export type RequirementDispatchRunResult =
  | {
      readonly ok: true;
      readonly requiresConfirmation: boolean;
      /** true 表示真的建了票 / 会话；确认模式下是 false。 */
      readonly created: boolean;
      readonly plan: RequirementDispatchPlan & { readonly ok: true };
      readonly batches: readonly RequirementDispatchBatchResult[];
      /** 「待核」区的研究票（只建票，不开会话）。 */
      readonly research: readonly ResearchTicketRunResult[];
    }
  | Extract<RequirementDispatchPlan, { readonly ok: false }>;

/**
 * 研究票单独闸一次：它也是「插件自己建的票」，不走旁路。
 *
 * 这里不再传 `requirementBody` / `repos`：影响面表已经在拆票层逐行核过，
 * 再拿整张需求复检一次会让别的区一条坏行拦住全部研究票。票级闸（定稿、
 * requirementKey、标签）仍在这里。
 */
async function runOneResearchTicket(input: {
  readonly ticket: ResearchTicketPlan;
  readonly workspace: RequirementDispatchWorkspace;
  readonly requirement: RequirementDispatchTicket;
  readonly number: number;
  readonly requirementLabels: readonly string[];
}): Promise<ResearchTicketRunResult> {
  const { ticket, workspace } = input;
  const gate = guardCreateTicket({
    kind: "issue",
    labels: ticket.labels.length ? ticket.labels : [RESEARCH_LABEL],
    body: ticket.body,
    requirementKey: input.number,
    requirementLabels: input.requirementLabels,
    action: "create",
  });
  if (!gate.ok) return { area: ticket.area, workspaceId: ticket.workspaceId, ok: false, detail: gate.detail };
  try {
    return await createResearchTicket(workspace.workspaceDir, input.requirement, ticket);
  } catch (error) {
    return {
      area: ticket.area,
      workspaceId: ticket.workspaceId,
      ok: false,
      detail: `研究票没建：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 建票闸 + 过滤出可以派单的任务；被拦的逐条留着，不整批作废。
 *
 * 不传整张需求正文：拆票层已经逐行核过影响面，任一区的坏行只会在那一区被
 * `planRequirementSplit` 拒掉；这里再复检整张表会把所有批次一起拦住。
 */
function gateEntries(input: {
  readonly entries: readonly RequirementDispatchEntry[];
  readonly number: number;
  readonly requirementLabels: readonly string[];
}): { readonly blocked: { area: string; detail: string }[]; readonly dispatchable: DispatchTask[] } {
  const blocked: { area: string; detail: string }[] = [];
  const dispatchable: DispatchTask[] = [];
  for (const entry of input.entries) {
    // 三条建票入口共用同一份闸（split-guard）：插件自己铺票也不开旁路。
    // 执行层只做票级闸；影响面已在拆票层逐行核过，这里不再复检整张需求正文。
    const gate = guardCreateTicket({
      kind: "issue",
      labels: [],
      body: entry.ticket.body,
      requirementKey: input.number,
      requirementLabels: input.requirementLabels,
      action: "create",
    });
    if (!gate.ok) blocked.push({ area: entry.ticket.area, detail: gate.detail });
    else dispatchable.push(entry.task);
  }
  return { blocked, dispatchable };
}

async function dispatchBatchTasks(
  paseo: PaseoApi,
  workspaceDir: string,
  batch: RequirementDispatchBatchPlan,
  tasks: readonly DispatchTask[],
  lang: "zh" | "en" | undefined,
) {
  if (!tasks.length) return null;
  return runDispatch(paseo, {
    workspaceId: batch.workspaceId,
    workspaceDir,
    tasks: tasks.map((task) => ({
      key: task.key,
      ...(task.title ? { title: task.title } : {}),
      prompt: task.prompt,
      difficulty: task.difficulty,
      ...(task.map ? { map: task.map } : {}),
      ...(task.staffId ? { staff: task.staffId } : {}),
      ...(task.repoKey ? { repoKey: task.repoKey } : {}),
      ...(task.region ? { region: task.region } : {}),
      ...(task.requirementKey ? { requirementKey: task.requirementKey } : {}),
      ...(task.requirementRepoKey ? { requirementRepoKey: task.requirementRepoKey } : {}),
      ...(typeof task.requirementBody === "string" ? { requirementBody: task.requirementBody } : {}),
    })),
    depth: 1,
    dispatchId: batch.dispatchId,
    ...(lang ? { lang } : {}),
  });
}

async function runOneBatch(input: {
  readonly paseo: PaseoApi;
  readonly batch: RequirementDispatchBatchPlan;
  readonly workspace: RequirementDispatchWorkspace;
  readonly number: number;
  readonly requirementLabels: readonly string[];
  readonly lang: "zh" | "en" | undefined;
}): Promise<RequirementDispatchBatchResult> {
  const { batch, workspace } = input;
  const { blocked, dispatchable } = gateEntries({
    entries: batch.entries,
    number: input.number,
    requirementLabels: input.requirementLabels,
  });
  const dispatched = await dispatchBatchTasks(input.paseo, workspace.workspaceDir, batch, dispatchable, input.lang);
  const base = {
    workspaceId: batch.workspaceId,
    workspaceName: batch.workspaceName,
    dispatcherAgentId: batch.dispatcherAgentId,
  };
  if (!dispatched) return { ...base, blocked, results: [] };
  if (!dispatched.ok) {
    blocked.push({ area: "*", detail: dispatched.detail });
    return { ...base, blocked, results: [] };
  }
  return { ...base, blocked, results: dispatched.results };
}

/**
 * 铺票 + 派单。
 *
 * `confirmRequirementSplit` 为 true（默认）时只返回清单，**一个字节都不写**；
 * 为 false 时逐批调 `runDispatch`：先建票、再建会话，失败逐条保留、不整批回滚。
 */
export async function runRequirementDispatch(
  paseo: PaseoApi,
  input: RequirementDispatchInput,
): Promise<RequirementDispatchRunResult> {
  const plan = await planRequirementDispatch(input);
  if (!plan.ok) return plan;
  if (plan.requiresConfirmation) {
    return { ok: true, requiresConfirmation: true, created: false, plan, batches: [], research: [] };
  }

  const requirementLabels = requirementLabelsOf(input.requirement.labels);
  const byWorkspace = new Map(input.workspaces.map((workspace) => [workspace.workspaceId, workspace]));

  // 「待核」的区只建研究票：不派单、不开会话，但票必须留下。
  const research: ResearchTicketRunResult[] = [];
  for (const ticket of plan.research) {
    const workspace = byWorkspace.get(ticket.workspaceId);
    if (!workspace) {
      research.push({
        area: ticket.area,
        workspaceId: ticket.workspaceId,
        ok: false,
        detail: `找不到工作区 ${ticket.workspaceId} 的目录，研究票没建`,
      });
      continue;
    }
    research.push(
      await runOneResearchTicket({
        ticket,
        workspace,
        requirement: input.requirement,
        number: plan.requirementNumber,
        requirementLabels,
      }),
    );
  }

  const batches: RequirementDispatchBatchResult[] = [];
  for (const batch of plan.batches) {
    const workspace = byWorkspace.get(batch.workspaceId);
    if (!workspace || batch.entries.length === 0) continue;
    batches.push(
      await runOneBatch({
        paseo,
        batch,
        workspace,
        number: plan.requirementNumber,
        requirementLabels,
        lang: input.lang,
      }),
    );
  }

  const created =
    research.some((item) => item.ok) ||
    batches.some((batch) => batch.results.some((result) => result.ok || result.ticket != null));
  return { ok: true, requiresConfirmation: false, created, plan, batches, research };
}
