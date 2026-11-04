/**
 * 拆票结果 → 每区一个派单批次：纯组装，不写盘、不开会话。
 *
 * 从 `requirement-dispatch.ts` 拆出来，是因为这一段只关心「票怎么变成该区自己的
 * 派单任务」；执行层（建票、建会话）与读设置是另一件事，分开后两边改一处不必读另一处。
 *
 * 各批次用各自工作区的名册 / 路由 / 预算；子会话的 `parentAgentId` 仍由 `runDispatch`
 * 落成那个工作区的派单窗口（这里不传 `callerAgentId`）。
 */

import { text } from "../shared/coerce.ts";
import {
  planDispatch,
  type ClientProfile,
  type DispatchPlan,
  type DispatchTaskInput,
  type OrchestrationSettings,
} from "../shared/orchestration.ts";
import {
  workspaceForRow,
  type ImpactRow,
  type SplitBatch,
  type SplitWorkspace,
} from "../shared/requirement-split.ts";
import type {
  RequirementDispatchBatchPlan,
  RequirementDispatchEntry,
  RequirementDispatchPlan,
} from "./requirement-dispatch.ts";

type RequirementDispatchFailure = Extract<RequirementDispatchPlan, { readonly ok: false }>;

/** 组批次只需要工作区这两块；`ResolvedWorkspace` 多出来的字段不参与计划。 */
export interface BatchWorkspace {
  readonly settings: OrchestrationSettings;
  readonly repos: readonly string[];
}

/** 只保留可放进幂等键的字符：workspaceId 里可能有 `/` 与空格。 */
function batchDispatchIdOf(base: string, workspaceId: string): string {
  const slug = workspaceId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "ws";
  return `${base}-${slug}`;
}

/**
 * 跨区时每个参与的工作区都要在影响面里占一行：漏一区就是那一区悄悄不建票，
 * 比整张需求停下来更难发现。只看「给了几个工作区」，不替人猜哪些区不受影响。
 */
export function missingImpactOf(
  number: number,
  rows: readonly ImpactRow[],
  workspaces: readonly SplitWorkspace[],
): RequirementDispatchFailure | null {
  if (workspaces.length <= 1) return null;
  const covered = new Set(
    rows
      .map((row) => workspaceForRow(row, workspaces)?.workspaceId)
      .filter((workspaceId): workspaceId is string => Boolean(workspaceId)),
  );
  const missing = workspaces.filter((workspace) => !covered.has(workspace.workspaceId));
  if (!missing.length) return null;
  return {
    ok: false,
    reason: "missing-impact",
    detail:
      `需求 #${number} 的影响面缺少这些区的行：${missing.map((workspace) => workspace.name ?? workspace.workspaceId).join(" / ")}。` +
      `每个跨到的工作区至少写一行「区 / 仓库、依据、结论、核的人」。`,
  };
}

/** 一张票变成一个该区自己的派单任务：staff / region / 需求父边都带过去。 */
function tasksOf(
  batch: SplitBatch,
  number: number,
  requirementRepoKey: string | null | undefined,
  requirementBody: string | null | undefined,
): DispatchTaskInput[] {
  return batch.tickets.map((ticket, index) => ({
    key: `req-${number}-${index + 1}`,
    title: `需求 #${number} · ${ticket.area}`,
    prompt: ticket.body,
    staff: ticket.staff.id,
    ...(ticket.repoKey ? { repoKey: ticket.repoKey } : {}),
    ...(ticket.repoKey || ticket.pathPrefix
      ? {
          region: {
            ...(ticket.repoKey ? { repoKey: ticket.repoKey } : {}),
            ...(ticket.pathPrefix ? { pathPrefix: ticket.pathPrefix } : {}),
          },
        }
      : {}),
    requirementKey: number,
    ...(requirementRepoKey ? { requirementRepoKey } : {}),
    ...(typeof requirementBody === "string" ? { requirementBody } : {}),
  }));
}

/** 按这个工作区自己的名册 / 路由 / 预算算派单计划；不借用别区的设置。 */
function dispatchPlanOf(
  batch: SplitBatch,
  workspace: BatchWorkspace,
  tasks: readonly DispatchTaskInput[],
  dispatchId: string,
  profiles: readonly ClientProfile[] | undefined,
): DispatchPlan {
  return planDispatch({
    workspaceId: batch.workspaceId,
    roles: workspace.settings.roles,
    routing: workspace.settings.routing,
    profiles: profiles ?? [],
    tasks,
    maxDepth: workspace.settings.maxDepth,
    maxChildrenPerDispatch: workspace.settings.maxChildrenPerDispatch,
    minConcurrentStaff: workspace.settings.minConcurrentStaff,
    mapBudgets: workspace.settings.mapBudgets,
    repoKeys: workspace.repos,
    // 插件自己铺票：子会话在第 1 层，调用方是根经理（第 0 层）。
    depth: 0,
    dispatchId,
  });
}

function entriesOf(
  plan: DispatchPlan,
  batch: SplitBatch,
  number: number,
  warnings: string[],
): RequirementDispatchEntry[] {
  const byKey = new Map(batch.tickets.map((ticket, index) => [`req-${number}-${index + 1}`, ticket]));
  const entries: RequirementDispatchEntry[] = [];
  for (const task of plan.tasks) {
    const ticket = byKey.get(task.key);
    if (ticket) entries.push({ ticket, task });
    else warnings.push(`${batch.workspaceName}：计划里出现了没有对应票的任务 ${task.key}，已跳过。`);
  }
  return entries;
}

export type BatchPlanOutcome =
  | { readonly kind: "batch"; readonly batch: RequirementDispatchBatchPlan }
  | { readonly kind: "fail"; readonly failure: RequirementDispatchFailure };

/** 组一个工作区的批次；没派单窗口是整张需求停下，其余拒绝逐条留给调用方展示。 */
export function batchPlanOf(input: {
  readonly batch: SplitBatch;
  readonly workspace: BatchWorkspace;
  readonly number: number;
  readonly requirementRepoKey: string | null | undefined;
  /** 需求正文；执行层链条闸要用，已经读过就不再读一次。 */
  readonly requirementBody: string | null | undefined;
  readonly baseDispatchId: string;
  readonly profiles: readonly ClientProfile[] | undefined;
  readonly warnings: string[];
}): BatchPlanOutcome {
  const { batch, workspace, number, warnings } = input;
  const dispatcher = text(batch.dispatcherAgentId);
  if (!dispatcher) {
    return {
      kind: "fail",
      failure: {
        ok: false,
        reason: "no-dispatcher",
        detail: `工作区 ${batch.workspaceId} 还没有指定派单窗口：先到「编排」里选一个会话，需求才能铺过去。`,
      },
    };
  }
  const dispatchId = batchDispatchIdOf(input.baseDispatchId, batch.workspaceId);
  const tasks = tasksOf(batch, number, input.requirementRepoKey, input.requirementBody);
  const plan = dispatchPlanOf(batch, workspace, tasks, dispatchId, input.profiles);
  const entries = entriesOf(plan, batch, number, warnings);
  warnings.push(...plan.rejected.map((item) => `${batch.workspaceName}：${item.key} 被拒——${item.detail}`));
  return {
    kind: "batch",
    batch: {
      workspaceId: batch.workspaceId,
      workspaceName: batch.workspaceName,
      dispatcherAgentId: dispatcher,
      dispatchId,
      entries,
      rejected: plan.rejected,
    },
  };
}
