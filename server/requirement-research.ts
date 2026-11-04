/**
 * 「待核」区的研究票：建票，但不开会话。
 *
 * 从 `requirement-dispatch.ts` 拆出来的原因不是长度：研究票只写一张票、不接派单，
 * 与「铺票 + 派单」是两件事，混在同一个文件里会让两边改一处都要读另一处。
 *
 * 「待核」不是「不建票」：这一区还没核清要不要动，票就是这件事唯一的落点。
 */

import { RESEARCH_LABEL, type ResearchTicketPlan } from "../shared/requirement-split.ts";
import { resolveWritableBackend } from "./tracker/backend.ts";
import { createGithubOperations } from "./tracker/github/operations.ts";
import { createGitLabIssue } from "./tracker/gitlab.ts";
import { createLocalIssue, resolveLocalStore } from "./tracker/local.ts";

/** 研究票只需要知道需求票在哪个仓库：跨仓库时不挂父边，票面只留 Refs。 */
export interface ResearchRequirement {
  readonly repoKey?: string | null;
}

export type ResearchTicketRunResult =
  | {
      readonly area: string;
      readonly workspaceId: string;
      readonly ok: true;
      readonly number: number;
      readonly url: string;
      readonly repoKey: string;
      readonly notes: readonly string[];
    }
  | {
      readonly area: string;
      readonly workspaceId: string;
      readonly ok: false;
      readonly detail: string;
    };

/** 区名的稳定短哈希：中文区名 slug 后全是 `area`，不加这一位会撞同一个幂等锚。 */
function anchorHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function researchAnchor(requirement: number, area: string): string {
  const slug = area.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "area";
  return `req-${requirement}-research-${slug}-${anchorHash(area)}`;
}

/** `resolveWritableBackend` 的成功分支：三个建票函数按 `kind` 各自收窄。 */
type WritableBackend = Extract<Awaited<ReturnType<typeof resolveWritableBackend>>, { ok: true }>;
type GithubBackend = Extract<WritableBackend, { kind: "github" }>;
type GitLabBackend = Extract<WritableBackend, { kind: "gitlab" }>;
type LocalBackend = Extract<WritableBackend, { kind: "local" }>;

/** 三个后端共用的票面：标题、标签、父边、注释与幂等锚。 */
interface ResearchDraft {
  readonly ticket: ResearchTicketPlan;
  readonly title: string;
  readonly labels: readonly string[];
  readonly parent: string | null;
  readonly notes: readonly string[];
  readonly anchor: string;
}

function failed(ticket: ResearchTicketPlan, detail: string): ResearchTicketRunResult {
  return { area: ticket.area, workspaceId: ticket.workspaceId, ok: false, detail };
}

function succeeded(
  draft: ResearchDraft,
  repoKey: string,
  issue: { readonly number: number; readonly url: string },
  notes: readonly string[],
): ResearchTicketRunResult {
  return {
    area: draft.ticket.area,
    workspaceId: draft.ticket.workspaceId,
    ok: true,
    number: issue.number,
    url: issue.url,
    repoKey,
    notes,
  };
}

function draftOf(backend: WritableBackend, requirement: ResearchRequirement, ticket: ResearchTicketPlan): ResearchDraft {
  // 票面标签由计划层决定（现在是 `wayfinder:research`）；这里只兜底，不另写一份规则。
  const labels = ticket.labels.length ? ticket.labels : [RESEARCH_LABEL];
  // 需求票和子票在同一个仓库才挂父边；跨仓库的父子边会把票挂到别人的同号票下面。
  const sameRepoNamespace = !requirement.repoKey || requirement.repoKey === backend.key;
  const notes: string[] = [];
  if (!sameRepoNamespace) {
    notes.push(
      `需求 #${ticket.parentNumber} 在另一个仓库（${requirement.repoKey ?? "未知"}）：父子边不能跨仓库，票面只留「需求：#${ticket.parentNumber}」`,
    );
  }
  return {
    ticket,
    title: `需求 #${ticket.parentNumber} · ${ticket.area}（待核）`,
    labels,
    parent: sameRepoNamespace ? String(ticket.parentNumber) : null,
    notes,
    anchor: researchAnchor(ticket.parentNumber, ticket.area),
  };
}

async function createGithubResearch(backend: GithubBackend, draft: ResearchDraft): Promise<ResearchTicketRunResult> {
  const created = await createGithubOperations().issueCreate(
    { owner: backend.ref.owner, name: backend.ref.name },
    {
      title: draft.title,
      body: draft.ticket.body,
      labels: draft.labels,
      ...(draft.parent ? { parentKey: draft.parent } : {}),
      idempotencyKey: draft.anchor,
    },
  );
  if (!created.ok) return failed(draft.ticket, created.message);
  const notes = [...draft.notes];
  if (created.data.labelError) notes.push(created.data.labelError);
  if (created.data.parentError) notes.push(created.data.parentError);
  return succeeded(draft, backend.key, created.data.issue, notes);
}

async function createGitLabResearch(backend: GitLabBackend, draft: ResearchDraft): Promise<ResearchTicketRunResult> {
  const created = await createGitLabIssue(backend.ref.owner, backend.ref.name, {
    title: draft.title,
    body: draft.ticket.body,
    labels: draft.labels,
    ...(draft.parent ? { parentKey: Number(draft.parent) } : {}),
    idempotencyKey: draft.anchor,
  });
  if (!created.ok) return failed(draft.ticket, created.detail);
  const notes = [...draft.notes];
  if (created.labelsFailed) notes.push("标签没挂上（票已建好）");
  return succeeded(draft, backend.key, created, notes);
}

async function createLocalResearch(backend: LocalBackend, draft: ResearchDraft): Promise<ResearchTicketRunResult> {
  const store = await resolveLocalStore(backend.workspaceDir);
  const scratch = store.primary.kind === "scratch";
  const created = await createLocalIssue(backend.workspaceDir, {
    title: draft.title,
    body: draft.ticket.body,
    labels: draft.labels,
    ...(scratch && draft.parent ? { parentKey: draft.parent } : {}),
    ...(scratch ? { idempotencyKey: draft.anchor } : {}),
  });
  if (!created.ok) return failed(draft.ticket, created.detail);
  const notes = [...draft.notes];
  if (!scratch) notes.push("本地 .deck 布局没有父子字段：研究票没挂到需求下面");
  if (created.labelsFailed) notes.push("标签没挂上（票已建好）");
  return succeeded(draft, backend.key, created, notes);
}

/** 建一张研究票；票面与工作票同源，只是没有任务、没有会话。 */
export async function createResearchTicket(
  workspaceDir: string,
  requirement: ResearchRequirement,
  ticket: ResearchTicketPlan,
): Promise<ResearchTicketRunResult> {
  const backend = await resolveWritableBackend(workspaceDir, "拆研究票", ticket.repoKey ?? undefined);
  if (!backend.ok) return failed(ticket, backend.detail);
  const draft = draftOf(backend, requirement, ticket);
  if (backend.kind === "github") return createGithubResearch(backend, draft);
  if (backend.kind === "gitlab") return createGitLabResearch(backend, draft);
  return createLocalResearch(backend, draft);
}
