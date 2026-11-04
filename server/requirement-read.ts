/**
 * 需求派单的读票工具。
 *
 * 单独一份是为了让 `requirement-dispatch.ts` 保持在 800 行以内；
 * 规则仍只有一份：这里只把后端读回来的 issue 转成派单层需要的正文与标签。
 */

import { labelNames } from "../shared/issue-kind.ts";
import { readIssue } from "./tracker/read.ts";
import type { RequirementDispatchTicket } from "./requirement-dispatch.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 标签两种写法都收：字符串数组，或 `{ name }` 对象数组。 */
export function requirementLabelsOf(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const label of labels) {
    const name = typeof label === "string" ? label : text((label as { name?: unknown } | null)?.name);
    if (name) out.push(name);
  }
  return out;
}

/** 读需求票原文：正文与标签都要原样带进计划，定稿与影响面判断全按它们。 */
export async function readRequirementForDispatch(
  workspaceDir: string,
  number: number,
  repoKey?: string | null,
): Promise<{ readonly ok: true; readonly ticket: RequirementDispatchTicket } | { readonly ok: false; readonly detail: string }> {
  const read = await readIssue(workspaceDir, number, repoKey ? { repoKey } : {});
  if (!read.ok) return { ok: false, detail: read.detail };
  if (!read.result.ok) return { ok: false, detail: read.result.detail };
  return {
    ok: true,
    ticket: {
      number,
      body: typeof read.result.issue.body === "string" ? read.result.issue.body : "",
      labels: labelNames(read.result.issue.labels),
      repoKey: read.repoKey,
    },
  };
}
