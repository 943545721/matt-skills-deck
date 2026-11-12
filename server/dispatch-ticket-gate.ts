/**
 * 执行层（`runDispatch`）的票门：无票不干活、需求没定稿不派。
 *
 * MCP 的 `deck_dispatch_plan` 早就逐条查这两件事，但 RPC / 需求拆票走的是
 * `runDispatch`，绕开 MCP 就直接派了。这里把同一口径钉在执行层，两条入口才一致。
 *
 * 预筛必须发生在 `planDispatch` 之前：被拦下的任务不进计划，也就不占并发名额。
 * 同一张需求只读一次；读不出来就拒这一条，不猜它定没定稿。
 */

import { requireTicketGates } from "../shared/impact.ts";
import { labelNames } from "../shared/issue-kind.ts";
import { readIssue } from "./tracker/read.ts";

export interface TicketGatedTask {
  readonly key: string;
  readonly title?: string;
  readonly requirementKey?: number;
  readonly requirementRepoKey?: string;
  /**
   * 内部调用方（需求拆票）刚读过的需求正文 / 标签：直接信这份，不再按票号重读。
   * RPC 入参不暴露这两位，所以远端调用方仍然只能靠读票。
   */
  readonly requirementBody?: string;
  readonly requirementLabels?: readonly string[];
}

export interface DispatchRequirement {
  readonly labels: readonly string[];
  readonly body: string;
  readonly repoKey: string | null;
}

export type RequirementLookup = DispatchRequirement | { readonly detail: string };

export interface DispatchTicketRejection {
  key: string;
  title?: string;
  reason: "no-requirement" | "requirement-unreadable" | "requirement-not-finalized";
  detail: string;
}

export interface DispatchTicketGateResult<T extends TicketGatedTask> {
  /** 通过票门的任务，原样保留顺序；只有它们会进计划。 */
  gated: T[];
  rejected: DispatchTicketRejection[];
  /** 读过的需求，按 `repoKey#number` 缓存；链条闸复用同一份，不重读。 */
  requirements: Map<string, RequirementLookup>;
}

/** 同一张需求票的缓存键；仓库不同则同号票是两张票。 */
export function dispatchRequirementKeyOf(task: TicketGatedTask): string {
  return `${task.requirementRepoKey ?? ""}#${task.requirementKey ?? ""}`;
}

async function readRequirement(
  workspaceDir: string,
  task: TicketGatedTask,
): Promise<RequirementLookup> {
  const read = await readIssue(workspaceDir, task.requirementKey as number, {
    ...(task.requirementRepoKey ? { repoKey: task.requirementRepoKey } : {}),
  });
  if (!read.ok) return { detail: read.detail };
  if (!read.result.ok) return { detail: read.result.detail };
  return {
    labels: labelNames(read.result.issue.labels),
    body: typeof read.result.issue.body === "string" ? read.result.issue.body : "",
    // 链条闸要按需求实际所在仓库判定：拿任务自己的 repoKey 会把同号票认错。
    repoKey: read.repoKey ?? null,
  };
}

export async function gateDispatchTasks<T extends TicketGatedTask>(
  workspaceDir: string,
  tasks: readonly T[],
): Promise<DispatchTicketGateResult<T>> {
  const requirements = new Map<string, RequirementLookup>();
  const gated: T[] = [];
  const rejected: DispatchTicketRejection[] = [];

  for (const task of tasks) {
    if (task.requirementKey === undefined) {
      rejected.push({
        key: task.key,
        ...(task.title ? { title: task.title } : {}),
        reason: "no-requirement",
        detail: "这条活没有挂需求票：无票不干活。先建一张需求票，再把票号填进 requirementKey。",
      });
      continue;
    }

    const cacheKey = dispatchRequirementKeyOf(task);
    let requirement = requirements.get(cacheKey);
    if (!requirement) {
      requirement = Array.isArray(task.requirementLabels)
        ? {
            labels: task.requirementLabels,
            body: task.requirementBody ?? "",
            repoKey: task.requirementRepoKey ?? null,
          }
        : await readRequirement(workspaceDir, task);
      requirements.set(cacheKey, requirement);
    }
    if ("detail" in requirement) {
      rejected.push({
        key: task.key,
        ...(task.title ? { title: task.title } : {}),
        reason: "requirement-unreadable",
        detail: `读不出需求 #${task.requirementKey} 的标签，不能确认它定稿了：${requirement.detail}`,
      });
      continue;
    }

    const gate = requireTicketGates({
      kind: "spec-ticket",
      labels: [],
      requirementKey: task.requirementKey,
      requirementLabels: [...requirement.labels],
      action: "dispatch",
    });
    if (!gate.ok) {
      rejected.push({
        key: task.key,
        ...(task.title ? { title: task.title } : {}),
        reason: "requirement-not-finalized",
        detail: gate.detail,
      });
      continue;
    }
    gated.push(task);
  }

  return { gated, rejected, requirements };
}
