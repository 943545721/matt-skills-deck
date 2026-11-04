/**
 * 需求 → 每区一张票：纯计划层。
 *
 * 只算「该建哪些票、票面长什么样、派给哪张卡」，不建票、不写盘、不开会话。
 * `confirmRequirementSplit` 只决定 `requiresConfirmation`：先给人看还是直接铺；
 * 两种取值返回的票面计划逐字相同，不是两套拆票规则。
 *
 * 拒绝分两种：全局闸（没定稿 / 没工作区 / 影响面空）返回 `{ ok:false }`，一张都不铺；
 * 区级拒绝进 `rejected` 并点名，其余区照常出计划——一个区填错不该让整张需求停工。
 * 「待核」不是拒绝，是分流：只出 `wayfinder:research` 研究票，不出工作票。
 *
 * 纯函数；影响面行的列原文直接复用 `shared/impact.ts` 的解析结果，这里只补机器字段。
 */

import {
  DECK_FINALIZE_LABEL,
  IMPACT_CONCLUSIONS,
  impactChainProblem,
  isFinalized,
  type ImpactRow as ParsedImpactRow,
} from "./impact.ts";
import { pathWithinPrefix, resolveOwner } from "./staff-guard.ts";
import type { OwnerStaff } from "./staff-guard.ts";
import type { StaffCard } from "./staff.ts";

/** 需求定稿标签只定义在 `shared/impact.ts`；这里沿用拆票层的老名字，不另写一份字面量。 */
export const REQUIREMENT_FINAL_LABEL = DECK_FINALIZE_LABEL;

/** 「待核」的区只建这一枚路线票。 */
export const RESEARCH_LABEL = "wayfinder:research";

/** 需求 → 每区一张票的 MCP 入口；清单阶段不写盘。 */
export const REQUIREMENT_DISPATCH_TOOL_NAME = "deck_requirement_dispatch";

const CONCLUSION_WORK = "要动";
const CONCLUSION_RESEARCH = "待核";
const CONCLUSION_SKIP = "不动";

/** 影响面表的结论。表里只认这三种；写别的按格式错误拒绝。 */
export type ImpactConclusion = "要动" | "待核" | "不动";

/**
 * 影响面表的一行：列原文来自 `shared/impact.ts` 的解析结果，这里只补机器字段。
 *
 * 四列固定：区 / 仓库、依据、结论、核的人；第五列 `chain` 可选。
 * `workspaceId` / `repoKey` / `pathPrefix` 给机器用：解析器只给给人看的「区 / 仓库」，
 * 拆票要拿它们去对工作区、仓库与名册。单工作区时可以省略。
 */
export interface ImpactRow extends Partial<ParsedImpactRow> {
  /** 第一列原文，用于票面与拒绝文案。 */
  readonly area: string;
  /** 这一行属于哪个工作区；省略时单工作区自动落过去。 */
  readonly workspaceId?: string | null;
  /** 多仓库工作区的仓库键；能从路径 / 领地带出来时可以省略。 */
  readonly repoKey?: string | null;
  /** 归属算法吃的路径前缀；省略 = 该工作区整片。 */
  readonly pathPrefix?: string | null;
  readonly conclusion: ImpactConclusion | string;
}

/** 拆票时的一个工作区：名册与派单窗口都按工作区各带一份，不跨区借。 */
export interface SplitWorkspace {
  readonly workspaceId: string;
  /** 显示名；省略时用 `workspaceId`。 */
  readonly name?: string;
  readonly roster: readonly StaffCard[];
  /** 这个工作区的派单窗口；批次原样带走它，不借用别区的窗口。 */
  readonly dispatcherAgentId?: string | null;
  /** 多仓库工作区的仓库清单；两个以上时票面必须落出 repoKey。 */
  readonly repos?: readonly string[];
  /** 根经理；不传 = 有根经理（默认），传 `null` = 没有。 */
  readonly rootManager?: OwnerStaff | null;
}

export interface RequirementTicket {
  readonly number: number;
  readonly body?: string;
  /** 标签可以是名字字符串，也可以是带 `name` 的对象（宿主两种形状都有）。 */
  readonly labels?: unknown;
}

export interface PlanRequirementSplitInput {
  readonly requirement: RequirementTicket;
  readonly impact: readonly ImpactRow[];
  readonly workspaces: readonly SplitWorkspace[];
  /** 定稿后、铺票前是否先列清单；默认 true。取值只影响 `requiresConfirmation`。 */
  readonly confirmRequirementSplit?: boolean;
}

/** 一张工作票的计划：父票挂回需求，正文带 `Refs: #<需求票>`。 */
export interface SplitTicketPlan {
  readonly workspaceId: string; readonly area: string; readonly repoKey: string | null;
  readonly pathPrefix: string; readonly parentNumber: number; readonly labels: readonly string[];
  readonly body: string; readonly staff: StaffCard;
}

/** 「待核」区的研究票：不建工作票、不建会话。 */
export interface ResearchTicketPlan {
  readonly workspaceId: string; readonly area: string; readonly repoKey: string | null;
  readonly pathPrefix: string; readonly parentNumber: number; readonly labels: readonly string[];
  readonly body: string;
}

/** 一个工作区一批：跨工作区时各批独立，各用各的派单窗口与名册。 */
export interface SplitBatch {
  readonly workspaceId: string; readonly workspaceName: string;
  readonly dispatcherAgentId: string | null; readonly roster: readonly StaffCard[];
  readonly tickets: SplitTicketPlan[];
}

export type AreaRejectReason =
  | "unknown-workspace" | "missing-repo-key" | "bad-conclusion"
  | "empty-basis" | "bad-chain"
  | "missing-reviewer" | "no-worker";

export interface RejectedImpactArea {
  readonly area: string; readonly workspaceId: string | null;
  readonly reason: AreaRejectReason; readonly detail: string;
}

export type SplitRejectReason = "not-finalized" | "empty-impact" | "no-workspace";

export type RequirementSplitResult =
  | {
      readonly ok: true;
      /** 由输入开关决定；两种取值下的计划完全相同。 */
      readonly requiresConfirmation: boolean;
      readonly batches: SplitBatch[];
      readonly research: ResearchTicketPlan[];
      /** 区级拒绝，已点名；其余区不受影响。 */
      readonly rejected: RejectedImpactArea[];
      /** 结论「不动」的区：不建票也不研究，留一行让人看得见。 */
      readonly skipped: string[];
    }
  | { readonly ok: false; readonly reason: SplitRejectReason; readonly detail: string };

type RowOutcome =
  | { readonly kind: "ticket"; readonly ticket: SplitTicketPlan }
  | { readonly kind: "research"; readonly research: ResearchTicketPlan }
  | { readonly kind: "skipped"; readonly area: string }
  | { readonly kind: "rejected"; readonly rejected: RejectedImpactArea };

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 仓库清单去空去重：`["web","web"]` 是一个仓库，不是两个。 */
export function uniqueRepos(workspace: SplitWorkspace): string[] {
  const out: string[] = [];
  for (const repo of workspace.repos ?? []) {
    const key = textOf(repo);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** 行属于哪个工作区：显式 id 优先；单工作区自动落；多工作区再按第一列 / 仓库名各对一次。 */
export function workspaceForRow(row: ImpactRow, workspaces: readonly SplitWorkspace[]): SplitWorkspace | null {
  const wanted = textOf(row.workspaceId);
  if (wanted) return workspaces.find((workspace) => workspace.workspaceId === wanted) ?? null;
  if (workspaces.length === 1) return workspaces[0] ?? null;
  for (const raw of [textOf(row.area), textOf(row.repoKey)]) {
    const needle = raw.toLowerCase();
    if (!needle) continue;
    const hit = workspaces.find(
      (workspace) =>
        workspace.workspaceId.toLowerCase() === needle ||
        (workspace.name ?? "").toLowerCase() === needle ||
        uniqueRepos(workspace).some((repo) => repo.toLowerCase() === needle),
    );
    if (hit) return hit;
  }
  return null;
}

function needsRepoKey(workspace: SplitWorkspace): boolean {
  return uniqueRepos(workspace).length > 1;
}

/**
 * 票面 repoKey：优先人给的；没给就由路径 / 经理领地带出。
 *
 * 单个仓库的工作区直接落那个仓库（容器工作区也算）；多仓库时取路径覆盖到的最长
 * 仓库键，取不出（路径为空或同时覆盖多个）才算真缺，交给调用方点名拒绝。
 */
function repoKeyOf(row: ImpactRow, workspace: SplitWorkspace, ownerPrefix: string): string | null {
  const given = textOf(row.repoKey);
  if (given) return given;
  const repos = uniqueRepos(workspace);
  if (repos.length === 1) return repos[0] ?? null;
  if (!repos.length) return null;
  const path = textOf(row.pathPrefix) || ownerPrefix;
  let best: string | null = null;
  for (const repo of repos) {
    if (!pathWithinPrefix(path, repo)) continue;
    if (!best || repo.length > best.length) best = repo;
  }
  return best;
}

function workBody(input: { requirement: number; row: ImpactRow; reviewer: string }): string {
  const { requirement, row, reviewer } = input;
  const lines = [
    `由需求 #${requirement} 的影响面表拆出。`,
    "",
    `- 区 / 仓库：${row.area}`,
    `- 结论：${CONCLUSION_WORK}`,
  ];
  const basis = textOf(row.basis);
  if (basis) lines.push(`- 依据：${basis}`);
  lines.push(`- 核的人：${reviewer}`);
  const chain = textOf(row.chain);
  if (chain) lines.push(`- 链条：${chain}`);
  lines.push("", `Refs: #${requirement}`);
  return lines.join("\n");
}

function researchBody(input: { requirement: number; row: ImpactRow }): string {
  const { requirement, row } = input;
  return [
    `需求 #${requirement} 的影响面这一区还没核：这块要不要动、依据在哪。`,
    "",
    `- 区 / 仓库：${row.area}`,
    `- 依据：${textOf(row.basis) || "—"}`,
    `- 结论：${CONCLUSION_RESEARCH}`,
    "",
    `Refs: #${requirement}`,
  ].join("\n");
}

function rejectRow(
  row: ImpactRow,
  workspace: SplitWorkspace | null,
  reason: AreaRejectReason,
  detail: string,
): RowOutcome {
  return {
    kind: "rejected",
    rejected: {
      area: row.area,
      workspaceId: workspace?.workspaceId ?? (textOf(row.workspaceId) || null),
      reason,
      detail,
    },
  };
}

/** 「要动」的区找员工。命中经理不回落；找不到员工时把经理名字写进拒绝原因。 */
function workerForRow(
  row: ImpactRow,
  workspace: SplitWorkspace,
): { readonly worker: StaffCard; readonly prefix: string; readonly managerPrefix: string } | { readonly detail: string } {
  const owner = resolveOwner({
    path: textOf(row.pathPrefix),
    roster: workspace.roster,
    workspaceId: workspace.workspaceId,
    rootManager: workspace.rootManager,
  });
  if (owner.ok && owner.layer === "worker" && owner.staff.id !== null) {
    return { worker: owner.staff, prefix: owner.matchedPrefix, managerPrefix: owner.managerPrefix };
  }
  if (owner.ok) {
    return { detail: `影响面这一行（${row.area}）没有员工卡覆盖：这片归${owner.staff.name}自己，不回落成把工作票派给经理。先补一张负责这片的员工卡。` };
  }
  return { detail: `影响面这一行（${row.area}）没有员工卡覆盖：${owner.detail}` };
}

/** 「待核」的区只出研究票；repoKey 推不出就点名拒绝。 */
function planResearchRow(
  row: ImpactRow,
  workspace: SplitWorkspace,
  requirementNumber: number,
  pathPrefix: string,
): RowOutcome {
  const repoKey = repoKeyOf(row, workspace, pathPrefix);
  if (needsRepoKey(workspace) && !repoKey) {
    return rejectRow(row, workspace, "missing-repo-key", `工作区 ${workspace.workspaceId} 有多个仓库：${row.area} 这一行推不出 repoKey，研究票落不到仓库。`);
  }
  return {
    kind: "research",
    research: {
      workspaceId: workspace.workspaceId, area: row.area, repoKey, pathPrefix,
      parentNumber: requirementNumber, labels: [RESEARCH_LABEL],
      body: researchBody({ requirement: requirementNumber, row }),
    },
  };
}

/**
 * 一行的分诊：工作区 → 结论分流 → 依据 / 核的人 / 归属 → 票面或拒绝。
 *
 * 「依据为空」放在结论分支之后判：结论写错时先说结论，别让人补了依据又被另一句拦回来；
 * 但「不动」的区不要求依据——它本来就不建票。
 */
function planRow(
  row: ImpactRow,
  workspaces: readonly SplitWorkspace[],
  requirementNumber: number,
): RowOutcome {
  const workspace = workspaceForRow(row, workspaces);
  if (!workspace) {
    return rejectRow(row, null, "unknown-workspace", `影响面这一行（${row.area || "未填区"}）对不上任何工作区；补齐工作区再拆。`);
  }
  const conclusion = textOf(row.conclusion);
  if (conclusion === CONCLUSION_SKIP) return { kind: "skipped", area: row.area };
  if (!IMPACT_CONCLUSIONS.includes(conclusion)) {
    return rejectRow(row, workspace, "bad-conclusion", `影响面这一行（${row.area}）的结论「${row.conclusion}」不认识：只认 要动 / 待核 / 不动。`);
  }
  if (!textOf(row.basis)) {
    return rejectRow(row, workspace, "empty-basis", `影响面这一行（${row.area}）「依据」为空：先写这次在那个区读到的原文，没有依据就不算结论。`);
  }
  const chainProblem = impactChainProblem(row.chain);
  if (chainProblem) {
    return rejectRow(row, workspace, "bad-chain", `影响面这一行（${row.area}）：${chainProblem}`);
  }
  const pathPrefix = textOf(row.pathPrefix);
  if (conclusion === CONCLUSION_RESEARCH) {
    return planResearchRow(row, workspace, requirementNumber, pathPrefix);
  }
  const reviewer = textOf(row.reviewer);
  if (!reviewer) {
    return rejectRow(row, workspace, "missing-reviewer", `影响面这一行（${row.area}）结论是「要动」但「核的人」为空：这一区不建票，先补上谁核的。`);
  }
  const found = workerForRow(row, workspace);
  if (!("worker" in found)) return rejectRow(row, workspace, "no-worker", found.detail);
  // 员工没填 paths 时它是「整片」，自己带不出仓库；退回经理命中的那片再推。
  // 容器工作区（一个目录里多个仓库）靠这一步落 repoKey，不然会被误报 missing-repo-key。
  const repoKey = repoKeyOf(row, workspace, found.prefix || found.managerPrefix);
  if (needsRepoKey(workspace) && !repoKey) {
    return rejectRow(row, workspace, "missing-repo-key", `工作区 ${workspace.workspaceId} 有多个仓库：${row.area} 这一行推不出 repoKey，票落不到仓库。`);
  }
  return {
    kind: "ticket",
    ticket: {
      workspaceId: workspace.workspaceId, area: row.area, repoKey, pathPrefix,
      parentNumber: requirementNumber, labels: [],
      body: workBody({ requirement: requirementNumber, row, reviewer }),
      staff: found.worker,
    },
  };
}

/**
 * 按影响面表拆票。
 *
 * 调用顺序：全局闸 → 逐行分诊 → 按工作区组批 → 研究票另列。
 */
export function planRequirementSplit(input: PlanRequirementSplitInput): RequirementSplitResult {
  const requirement = input.requirement;

  // 全局闸一：没定稿就不拆。标签可能是对象，大小写由 `isFinalized` 统一。
  if (!isFinalized(requirement.labels)) {
    return {
      ok: false,
      reason: "not-finalized",
      detail: `需求 #${requirement.number} 还没定稿：先把六节谈完、影响面核完，再点定稿。`,
    };
  }
  if (!input.workspaces.length) {
    return {
      ok: false,
      reason: "no-workspace",
      detail: `需求 #${requirement.number} 找不到可拆的工作区：先给这个工作区建名册，再拆票。`,
    };
  }
  if (!input.impact.length) {
    return {
      ok: false,
      reason: "empty-impact",
      detail: `需求 #${requirement.number} 的影响面表是空的：先补齐每区的依据与结论，再拆票。`,
    };
  }

  const outcomes = input.impact.map((row) => planRow(row, input.workspaces, requirement.number));
  const rejected = outcomes.flatMap((outcome) => (outcome.kind === "rejected" ? [outcome.rejected] : []));
  const research = outcomes.flatMap((outcome) => (outcome.kind === "research" ? [outcome.research] : []));
  const skipped = outcomes.flatMap((outcome) => (outcome.kind === "skipped" ? [outcome.area] : []));

  const byWorkspace = new Map<string, SplitTicketPlan[]>();
  for (const outcome of outcomes) {
    if (outcome.kind !== "ticket") continue;
    const tickets = byWorkspace.get(outcome.ticket.workspaceId) ?? [];
    tickets.push(outcome.ticket);
    byWorkspace.set(outcome.ticket.workspaceId, tickets);
  }

  // 组批按工作区输入顺序，不按行顺序；重复的 workspaceId 只出一次，免得重复建票。
  const batches: SplitBatch[] = [];
  const seen = new Set<string>();
  for (const workspace of input.workspaces) {
    if (seen.has(workspace.workspaceId)) continue;
    seen.add(workspace.workspaceId);
    const tickets = byWorkspace.get(workspace.workspaceId);
    if (!tickets?.length) continue;
    batches.push({
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.name ?? workspace.workspaceId,
      dispatcherAgentId: textOf(workspace.dispatcherAgentId) || null,
      roster: workspace.roster,
      tickets,
    });
  }

  return {
    ok: true,
    requiresConfirmation: input.confirmRequirementSplit !== false,
    batches,
    research,
    rejected,
    skipped,
  };
}
