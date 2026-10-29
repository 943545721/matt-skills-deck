/**
 * 新建票的纯决策逻辑：哪些仓库可写、默认落到哪个仓库、缺陷票能不能建。
 *
 * 放在 shared 是为了让 Node 测试直接覆盖边界；客户端只负责把结果画出来。
 */

import {
  bugLabels,
  bugMissingFields,
  type BugFields,
  type RequirementMode,
} from "./requirement.ts";

export interface NewIssueRepo {
  key: string;
  name: string;
  readOnly: boolean;
}

/** 只读目标（当前账号没有写权限）不能出现在新建目标里；能不能写由服务端每次操作的权限闸门判断。 */
export function writableNewIssueRepos(repos: readonly NewIssueRepo[]): NewIssueRepo[] {
  return repos.filter((repo) => !repo.readOnly);
}

/**
 * 当前应落在哪个仓库：用户手选的（仍可写）> 任务板当前筛选的（仍可写）> 第一个可写仓库。
 * 都不行时返回 null，由调用方决定是否禁用创建。
 */
export function activeNewIssueRepoKey(
  repos: readonly NewIssueRepo[],
  picked: string | null | undefined,
  defaultKey: string | null | undefined,
): string | null {
  const writable = writableNewIssueRepos(repos);
  const isWritable = (key: string | null | undefined): key is string =>
    Boolean(key) && writable.some((repo) => repo.key === key);
  if (isWritable(picked)) return picked;
  if (isWritable(defaultKey)) return defaultKey;
  return writable[0]?.key ?? null;
}

export interface BugSubmissionPlan {
  /** 「实际」是唯一必须有的字段；为空时不能建。 */
  canCreate: boolean;
  /** 「实际」有了、但其它字段还缺：建票时带 needs-info。 */
  incomplete: boolean;
  labels: string[];
}

export function planBugSubmission(fields: BugFields, diagnosed: boolean): BugSubmissionPlan {
  const canCreate = Boolean(fields.actual.trim());
  const incomplete = canCreate && bugMissingFields(fields).some((key) => key !== "actual");
  return { canCreate, incomplete, labels: bugLabels({ diagnosed, incomplete }) };
}

export type NewIssueMode = "issue" | RequirementMode | "bug";

/** 提交那一刻的表单快照：用来判断迟到的成功回调还能不能清空当前草稿。 */
export interface NewIssueDraft {
  title: string;
  body: string;
  labels: string;
  mode: NewIssueMode;
  bug: BugFields;
  bugDiagnosed: boolean;
  isMap: boolean;
  copyPrompt: boolean;
  /** 提交目标仓库：只换仓库也算改了草稿，迟到成功不能把新目标清掉。 */
  repoKey: string | null;
}

export function sameNewIssueDraft(a: NewIssueDraft, b: NewIssueDraft): boolean {
  return (
    a.title.trim() === b.title.trim() &&
    a.body === b.body &&
    a.labels === b.labels &&
    a.mode === b.mode &&
    a.bug.actual === b.bug.actual &&
    a.bug.expected === b.bug.expected &&
    a.bug.reproduce === b.bug.reproduce &&
    a.bug.environment === b.bug.environment &&
    a.bugDiagnosed === b.bugDiagnosed &&
    a.isMap === b.isMap &&
    a.copyPrompt === b.copyPrompt &&
    a.repoKey === b.repoKey
  );
}

/**
 * 迟到的成功回调该怎么处理当前草稿 / 提示词。
 *
 * 注意这里没有「要不要让任务板可见」的开关：票已经建出来，客户端必须无条件
 * 调用 onCreated(repoKey)，否则在别的仓库筛选下这张票永远看不到。这里只决定
 * 要不要动剪贴板与草稿。
 */
export interface LateSuccessInput {
  /** 之后又有一次提交还在进行。 */
  newerPending: boolean;
  /** 之后又有一次提交已经结束（成功或失败）。 */
  newerSettled: boolean;
  /** 之后还有一次被强制关闭、结果未知的提交。 */
  newerUnsettled: boolean;
  /** 提交时的草稿与当前表单完全一致。 */
  draftUnchanged: boolean;
  /** 这次结算后还剩几个强制关闭后未返回的请求。 */
  remainingUnsettled: number;
}

export type LateSuccessNoticeKind =
  | "still-pending"
  | "after-new-submit"
  | "newer-unsettled"
  | "cleared"
  | "kept";

export interface LateSuccessPlan {
  draft: "clear" | "keep";
  notice: LateSuccessNoticeKind;
  /** 还有结果未知的旧请求：任何提示都要带上「先确认任务板」。 */
  unseen: boolean;
  /** 是否复制旧票的技能提示词；有更新的提交时不要覆盖剪贴板。 */
  copyPrompt: boolean;
}

export function planLateSuccess(input: LateSuccessInput): LateSuccessPlan {
  const unseen = input.remainingUnsettled > 0;
  if (input.newerPending) {
    return { draft: "keep", notice: "still-pending", unseen, copyPrompt: false };
  }
  if (input.newerSettled) {
    return { draft: "keep", notice: "after-new-submit", unseen, copyPrompt: false };
  }
  if (input.newerUnsettled) {
    return { draft: "keep", notice: "newer-unsettled", unseen, copyPrompt: false };
  }
  if (input.draftUnchanged) {
    return { draft: "clear", notice: "cleared", unseen, copyPrompt: true };
  }
  return { draft: "keep", notice: "kept", unseen, copyPrompt: true };
}

/**
 * 持久提示的结构化状态：只存事实，由客户端在渲染时翻译成文案。
 * 直接存字符串会在提交结束后留下「还在提交」这类假话。
 */
export type LateNotice =
  | { kind: "force-closed" }
  /** 当前 / 迟到请求失败，但失败原因不能证明「没建」（超时、断连、5xx）。 */
  | { kind: "maybe-created" }
  | { kind: "force-closed-failed"; createdNumber: number | null }
  | { kind: "late-created"; notice: LateSuccessNoticeKind; number: number; unseen: boolean };

/**
 * 当前这次提交结束时该留下什么：还有强制关闭的旧请求没返回，或这次失败本身
 * 就可能已经建了票时，只保留「票可能已建」的未知警告；否则清掉过期旧提示。
 */
export function planCurrentSettleNotice(remainingUnsettled: number, maybeCreated = false): LateNotice | null {
  if (maybeCreated) return { kind: "maybe-created" };
  return remainingUnsettled > 0 ? { kind: "force-closed" } : null;
}

export interface LateFailureInput {
  /** 这次失败结算后还剩几个强制关闭后未返回的请求。 */
  remainingUnsettled: number;
  /** 失败本身不能证明「没建」：超时、断连、5xx 都可能已经写进去了。 */
  maybeCreated: boolean;
  /** 当前是否还有一次提交在进行。 */
  newerPending: boolean;
  /** 比这次失败的代次更新、且已经成功的建票票号。 */
  newerCreatedNumber: number | null;
}

/**
 * 强制关闭的旧请求迟到失败时该留下什么：
 * - 这次失败可能已经建票：给出专门的「先核对任务板」警告；
 * - 还有别的未知请求：继续警告；
 * - 当前还有提交在进行：交给 busy 行，别留过期提示；
 * - 之后已经建过票：不能说「可以重新提交」；
 * - 都没有：才能说可以重新提交。
 */
export function planLateFailure(input: LateFailureInput): LateNotice | null {
  if (input.maybeCreated) return { kind: "maybe-created" };
  if (input.remainingUnsettled > 0) return { kind: "force-closed" };
  if (input.newerPending) return null;
  return { kind: "force-closed-failed", createdNumber: input.newerCreatedNumber };
}

/**
 * 需求 / 缺陷票不能是地图票：手输的 wayfinder:map 会把「种子票」和正文骨架搞矛盾。
 * 普通票模式不经过这里，用户仍可用地图开关明确建地图。
 */
export function stripMapLabelFromNonMapModes(labels: readonly string[]): string[] {
  return labels.filter((label) => label !== "wayfinder:map");
}
