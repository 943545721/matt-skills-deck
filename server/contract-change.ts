/**
 * 影响面链条变更的接线：diff 是纯函数，apply 是唯一会写盘的一层。
 *
 * plan 第十节要求「契约变了，两边都知道」。纯文本的产出（两边票面各一笔 +
 * 一条 `kind:"contract"` 协调记录）已经在 `shared/contract-chain.ts` 里；
 * 这里只负责把「旧正文 → 新正文」的差异算出来，再把产出真正送到票面、收件箱与群。
 *
 * 边界：
 * - 只有第五列声明了链条的行才算「契约变更」；没链条的行改字不触发任何通知；
 * - 任何一步写入失败都只进 `warnings`，绝不把已经成功的 `deck_issue_patch` 拖成失败；
 * - 没有影响面表 / 表里没有链条行 → 什么都不做（返回空数组 / 空结果）。
 */

import { contractChangeArtifacts } from "../shared/contract-chain.ts";
import { parseImpactChain, parseImpactTable, type ImpactRow } from "../shared/impact.ts";
import { appendGroup } from "./group-store.ts";
import { readOrchestration } from "./orchestration-store.ts";
import { requestCoordination } from "./staff-territory.ts";
import { resolveWritableBackend, type WritableBackend } from "./tracker/backend.ts";
import { postGitLabComment } from "./tracker/gitlab.ts";
import { postLocalComment } from "./tracker/local.ts";
import { readBoard } from "./tracker/read.ts";
import { postComment } from "./tracker/write.ts";

/* ------------------------------------------------------------------ 纯 diff */

/** 一条影响面链条的变化；一条行可能拆成多条（例如权益项与存量升级同时改）。 */
export interface ImpactRowChange {
  /** 影响面的「区 / 仓库」列。 */
  readonly area: string;
  /** 行对齐用的仓库；当前影响面只有「区 / 仓库」一列，所以与 `area` 同值，保留字段是为了调用方语义清楚。 */
  readonly repo: string;
  /** 变了哪一项（契约摘要 / 契约在哪 / 权益项 / 存量升级 / 链条 / 新增行 / 删除行）。 */
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function tableRowsOf(body: unknown): readonly ImpactRow[] | null {
  const parsed = parseImpactTable(typeof body === "string" ? body : "");
  return parsed.ok ? parsed.rows : null;
}

/** 同「区 / 仓库」出现多次时按出现顺序对齐，避免把第二行当成第一行。 */
function indexRows(rows: readonly ImpactRow[]): Map<string, ImpactRow> {
  const out = new Map<string, ImpactRow>();
  const seen = new Map<string, number>();
  for (const row of rows) {
    const area = text(row.area);
    const occurrence = seen.get(area) ?? 0;
    seen.set(area, occurrence + 1);
    out.set(`${area}\u0000${occurrence}`, row);
  }
  return out;
}

function ticketText(ticket: number | null): string {
  return ticket === null ? "" : `#${ticket}`;
}

function yesNo(value: boolean | null): string {
  return value === null ? "" : value ? "是" : "否";
}

interface FieldChange {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

/** 同一行、两条都合法的链条：按语义字段拆开，而不是把整串丢给调用方。 */
function chainFieldChanges(oldChain: string, newChain: string): FieldChange[] {
  const before = parseImpactChain(oldChain);
  const after = parseImpactChain(newChain);
  if (!before.ok || !after.ok) {
    return [{ field: "链条", before: oldChain, after: newChain }];
  }
  const old_ = before.chain;
  const new_ = after.chain;
  if (old_.kind !== new_.kind) {
    // 契约 ↔ 权益这种换法的语义完全变了，拆字段只会误导；整格给出来更清楚。
    return [{ field: "链条", before: oldChain, after: newChain }];
  }

  const changes: FieldChange[] = [];
  switch (new_.kind) {
    case "contract":
      if (old_.summary !== new_.summary) {
        changes.push({ field: "契约摘要", before: old_.summary ?? "", after: new_.summary ?? "" });
      }
      break;
    case "detail":
      if (old_.ticket !== new_.ticket) {
        changes.push({ field: "契约在哪", before: ticketText(old_.ticket), after: ticketText(new_.ticket) });
      }
      break;
    case "capability":
      if (old_.featureKey !== new_.featureKey) {
        changes.push({ field: "权益项", before: old_.featureKey ?? "", after: new_.featureKey ?? "" });
      }
      if (old_.upgradeExisting !== new_.upgradeExisting) {
        changes.push({ field: "存量升级", before: yesNo(old_.upgradeExisting), after: yesNo(new_.upgradeExisting) });
      }
      break;
    case "waiting":
      // 「等 #N」换票号属于第五列本身变了；不额外造字段名。
      if (old_.ticket !== new_.ticket) {
        changes.push({ field: "链条", before: oldChain, after: newChain });
      }
      break;
    case "none":
      break;
  }
  // 语义没拆出差异但文本确实变了（多一个空格、换了写法）：仍然通知，别静默放过。
  return changes.length ? changes : [{ field: "链条", before: oldChain, after: newChain }];
}

/**
 * 比较两份正文里的 `## 影响面` 表，只返回「声明了链条」的行的变化。
 *
 * - 任一份没有可解析的影响面表 → 空数组（首次建表不当作契约变更）；
 * - 两边第五列都空的行 → 整行跳过，其他列改字不触发通知；
 * - 新表新增 / 删除的有链条行 → `field` 写「新增行 / 删除行」；
 * - 行按「区 / 仓库」列对齐（当前格式只有这一列，仓库就是该列）；同区多行按出现顺序对齐。
 */
/** 两边都有的行：删除、改链条；第五列两边都空的整行跳过。 */
function alignedRowChanges(oldMap: Map<string, ImpactRow>, newMap: Map<string, ImpactRow>): ImpactRowChange[] {
  const changes: ImpactRowChange[] = [];
  for (const [key, oldRow] of oldMap) {
    const newRow = newMap.get(key);
    const oldChain = text(oldRow.chain);
    const newChain = text(newRow?.chain);
    if (!oldChain && !newChain) continue;
    const area = text((newRow ?? oldRow).area);
    if (!newRow) {
      changes.push({ area, repo: area, field: "删除行", before: oldChain, after: "" });
      continue;
    }
    if (oldChain === newChain) continue;
    for (const field of chainFieldChanges(oldChain, newChain)) {
      changes.push({ area, repo: area, ...field });
    }
  }
  return changes;
}

/** 新表新增的行；只收声明了链条的。 */
function addedRowChanges(oldMap: Map<string, ImpactRow>, newMap: Map<string, ImpactRow>): ImpactRowChange[] {
  const changes: ImpactRowChange[] = [];
  for (const [key, newRow] of newMap) {
    if (oldMap.has(key)) continue;
    const chain = text(newRow.chain);
    if (!chain) continue;
    const area = text(newRow.area);
    changes.push({ area, repo: area, field: "新增行", before: "", after: chain });
  }
  return changes;
}

export function diffImpactRows(oldBody: unknown, newBody: unknown): ImpactRowChange[] {
  const oldRows = tableRowsOf(oldBody);
  const newRows = tableRowsOf(newBody);
  if (!oldRows || !newRows) return [];
  const oldMap = indexRows(oldRows);
  const newMap = indexRows(newRows);
  return [...alignedRowChanges(oldMap, newMap), ...addedRowChanges(oldMap, newMap)];
}

/* ------------------------------------------------------------------ 写盘 */

export interface ApplyContractChangeInput {
  readonly workspaceDir: string;
  /** 编排设置里的工作区 id；缺省时读 `.deck/orchestration.json`。 */
  readonly workspaceId?: string | null;
  readonly requirementNumber: number | string | null;
  readonly changes: readonly ImpactRowChange[];
  readonly by?: string | null;
  /** 缺省当前时间。 */
  readonly at?: string | null;
  /** 当前票所在仓库键；`#N` 形式的票面引用用它定位后端。 */
  readonly repoKey?: string | null;
  /** 当前票的完整引用；多仓库时传 `owner/repo#N`，缺省为 `#N`。 */
  readonly currentRef?: string | null;
  /**
   * 额外受影响票面。`null` / 未传 = 自动从板子上找引用该需求的工作票；
   * 传空数组 = 明确不找（测试或已知只有当前票时用）。
   */
  readonly counterpartRefs?: readonly string[] | null;
  /** 测试注入的会话 id；缺省 `process.env.PASEO_AGENT_ID`。 */
  readonly sessionAgentId?: string | null;
  /** 测试注入的写入口（票面评论）。 */
  readonly writeNote?: ((ref: string, body: string) => Promise<{ ok: boolean; detail?: string }>) | null;
}

export interface ContractChangeApplyResult {
  /** 本次 diff 出来的变化条数。 */
  readonly changes: number;
  /** 成功写进票面的评论条数。 */
  readonly notes: number;
  /** 写进 `.deck/coordination.jsonl` 的记录条数。 */
  readonly coordination: number;
  /** 写进群记录的条数。 */
  readonly groupMessages: number;
  /** 每一步的可读失败原因；有内容不代表 patch 失败。 */
  readonly warnings: readonly string[];
}

interface ParsedRef {
  readonly repoKey: string | null;
  readonly number: number;
}

/** `#12` / `owner/repo#12` / `local#12`；读不出返回 null，不拿 0 冒充。 */
function parseRef(ref: unknown): ParsedRef | null {
  const match = /^(?:(.*)#)?(\d+)$/.exec(text(ref));
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repoKey: text(match[1]) || null, number };
}

function writeCommentFor(backend: WritableBackend, number: number, body: string) {
  if (backend.kind === "github") return postComment(backend.ref.owner, backend.ref.name, number, body);
  if (backend.kind === "gitlab") return postGitLabComment(backend.ref.owner, backend.ref.name, number, body);
  return postLocalComment(backend.workspaceDir, number, body);
}

async function writeContractNote(
  workspaceDir: string,
  repoKey: string | null,
  ref: string,
  body: string,
): Promise<{ ok: boolean; detail?: string }> {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, detail: `票面引用「${ref}」读不出票号` };
  const backend = await resolveWritableBackend(workspaceDir, "契约变更记录", parsed.repoKey ?? repoKey ?? undefined);
  if (!backend.ok) return { ok: false, detail: backend.detail };
  const written = await writeCommentFor(backend, parsed.number, body);
  return written.ok ? { ok: true } : { ok: false, detail: written.detail };
}

/** 板子上引用这张需求的票：`Refs: #N` / `需求：#N` / `需求 #N`。 */
async function discoverCounterpartRefs(
  workspaceDir: string,
  requirementNumber: number,
  currentRef: string,
): Promise<{ refs: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  // 已关的工作票也要收到「契约变了」：两边都干完了才发现对不上，正是这条通知要防的。
  const board = await readBoard(workspaceDir, { limit: 200, includeClosed: true, view: "all", withBody: true });
  if (!board.ok) {
    return { refs: [], warnings: [`契约变更：读板子找受影响票面失败（${board.detail}），只写当前票。`] };
  }
  if (board.hasMore) {
    warnings.push("契约变更：板子只读到前 200 张票，可能漏了引用这张需求的对方票面。");
  }
  if (board.failures.length) {
    warnings.push(`契约变更：有 ${board.failures.length} 个仓库读失败，可能漏了对方票面（${board.failures.map((item) => item.repoKey).join("、")}）。`);
  }
  const n = requirementNumber;
  const pattern = new RegExp(`(?:Refs:\\s*#${n}(?!\\d)|需求\\s*[：:]\\s*#?${n}(?!\\d)|需求\\s+#${n}(?!\\d))`);
  const current = parseRef(currentRef);
  const refs: string[] = [];
  for (const issue of board.issues) {
    if (!pattern.test(issue.body ?? "")) continue;
    // 当前票自己就是需求票，不给它重复记两笔。
    if (current && issue.number === current.number && (!current.repoKey || issue.repoKey === current.repoKey)) continue;
    const ref = `${issue.repoKey}#${issue.number}`;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return { refs, warnings };
}

async function workspaceIdOf(workspaceDir: string): Promise<string | null> {
  const stored = await readOrchestration(workspaceDir);
  return text(stored.workspaceId) || null;
}

/** 一次变化在收件箱 / 群消息里的定位串：`区/仓库 · 字段`。 */
function whereOf(change: ImpactRowChange): string {
  return [text(change.repo) || text(change.area), text(change.field)].filter(Boolean).join(" · ");
}

function describeChange(change: ImpactRowChange): string {
  const where = whereOf(change);
  const before = text(change.before) || "（空）";
  const after = text(change.after) || "（空）";
  if (change.field === "新增行") return `${where}：新增「${text(change.after)}」`;
  if (change.field === "删除行") return `${where}：删除「${text(change.before)}」`;
  return `${where}：「${before}」改为「${after}」`;
}

/** 一次 apply 里不变的上下文；拆出来是为了让每个 change 的处理留在一个短函数里。 */
interface ApplyContext {
  readonly workspaceDir: string;
  readonly workspaceId: string | null;
  readonly requirementNumber: number | null;
  readonly at: string;
  readonly by: string | null;
  readonly sessionAgentId: string;
  readonly impacted: readonly string[];
  readonly repoKey: string | null;
  readonly writeNote: ((ref: string, body: string) => Promise<{ ok: boolean; detail?: string }>) | null;
}

interface ChangeOutcome {
  readonly notes: number;
  readonly coordination: number;
  readonly groupMessages: number;
  readonly warnings: readonly string[];
}

type ChangeArtifacts = Extract<ReturnType<typeof contractChangeArtifacts>, { readonly ok: true }>["artifacts"];

async function writeCoordination(
  context: ApplyContext,
  artifacts: ChangeArtifacts,
  where: string,
): Promise<{ count: number; warnings: string[] }> {
  if (!context.workspaceId) {
    return { count: 0, warnings: [`契约变更协调记录没写（${where}）：没有 workspaceId，收件箱定位不到工作区。`] };
  }
  const written = await requestCoordination(context.workspaceDir, {
    kind: "contract",
    workspaceId: context.workspaceId,
    fromStaff: "deck",
    sessionAgentId: context.sessionAgentId,
    taskSummary: artifacts.coordination.taskSummary,
    at: context.at,
    field: artifacts.coordination.field,
  });
  return written.ok
    ? { count: written.records.length, warnings: [] }
    : { count: 0, warnings: [`契约变更协调记录没写（${where}）：${written.detail}`] };
}

async function writeNotes(
  context: ApplyContext,
  artifacts: ChangeArtifacts,
  where: string,
): Promise<{ count: number; warnings: string[] }> {
  let count = 0;
  const warnings: string[] = [];
  for (const note of artifacts.notes) {
    const result = context.writeNote
      ? await context.writeNote(note.ref, note.body)
      : await writeContractNote(context.workspaceDir, context.repoKey, note.ref, note.body);
    if (result.ok) count += 1;
    else warnings.push(`契约变更记录没写到 ${note.ref}（${where}）：${result.detail ?? "未知原因"}`);
  }
  return { count, warnings };
}

async function writeGroupMessage(context: ApplyContext, change: ImpactRowChange, where: string) {
  if (!context.workspaceId) return { count: 0, warnings: [] as string[] };
  const appended = await appendGroup(context.workspaceDir, context.workspaceId, {
    kind: "system",
    from: "deck",
    agentId: "",
    text: `契约变更：需求 #${context.requirementNumber ?? "?"} ${describeChange(change)}`,
    at: context.at,
  });
  return appended.ok
    ? { count: 1, warnings: [] as string[] }
    : { count: 0, warnings: [`契约变更群消息没写（${where}）：${appended.detail}`] };
}

/**
 * 一条变化的四个落点。每一步单独结算：前一步失败不会跳过后面的，
 * 也不会把失败抛回调用方。
 */
async function applyOneChange(context: ApplyContext, change: ImpactRowChange): Promise<ChangeOutcome> {
  const where = whereOf(change);
  if (!where) {
    return { notes: 0, coordination: 0, groupMessages: 0, warnings: ["契约变更记录没生成：变化里没有可读的区 / 仓库与字段。"] };
  }
  const artifacts = contractChangeArtifacts({
    requirementKey: context.requirementNumber,
    field: where,
    reason: describeChange(change),
    impacted: context.impacted,
    at: context.at,
    by: context.by,
  });
  if (!artifacts.ok) {
    return { notes: 0, coordination: 0, groupMessages: 0, warnings: [`契约变更记录没生成（${where}）：${artifacts.reason}`] };
  }

  const coordination = await writeCoordination(context, artifacts.artifacts, where);
  const notes = await writeNotes(context, artifacts.artifacts, where);
  const group = await writeGroupMessage(context, change, where);
  return {
    notes: notes.count,
    coordination: coordination.count,
    groupMessages: group.count,
    warnings: [...coordination.warnings, ...notes.warnings, ...group.warnings],
  };
}

/**
 * 把 diff 出来的变化送到三处：两边票面评论、`.deck/coordination.jsonl` 一条
 * `kind:"contract"`、群里一条 system 消息。
 *
 * 任何一步失败都只进 `warnings`；已经成功的写入不回滚，也不会让调用方的 patch 失败。
 */
export async function applyContractChange(input: ApplyContractChangeInput): Promise<ContractChangeApplyResult> {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const warnings: string[] = [];
  if (!changes.length) return { changes: 0, notes: 0, coordination: 0, groupMessages: 0, warnings };

  const workspaceDir = text(input.workspaceDir);
  if (!workspaceDir) {
    warnings.push("契约变更记录没写成：工作区目录为空。");
    return { changes: changes.length, notes: 0, coordination: 0, groupMessages: 0, warnings };
  }

  const rawNumber = typeof input.requirementNumber === "number" ? input.requirementNumber : Number(input.requirementNumber);
  const requirementNumber = Number.isInteger(rawNumber) && rawNumber > 0 ? rawNumber : null;
  const currentRef = text(input.currentRef) || (requirementNumber === null ? "" : `#${requirementNumber}`);

  let counterpartRefs: string[];
  if (Array.isArray(input.counterpartRefs)) {
    counterpartRefs = input.counterpartRefs.map((ref) => text(ref)).filter(Boolean);
  } else if (requirementNumber !== null) {
    const found = await discoverCounterpartRefs(workspaceDir, requirementNumber, currentRef);
    counterpartRefs = found.refs;
    warnings.push(...found.warnings);
  } else {
    counterpartRefs = [];
  }

  const context: ApplyContext = {
    workspaceDir,
    workspaceId: text(input.workspaceId) || (await workspaceIdOf(workspaceDir)),
    requirementNumber,
    at: text(input.at) || new Date().toISOString(),
    by: text(input.by) || null,
    sessionAgentId: text(input.sessionAgentId ?? process.env.PASEO_AGENT_ID) || "",
    impacted: [...new Set([currentRef, ...counterpartRefs].filter(Boolean))],
    repoKey: text(input.repoKey) || null,
    writeNote: input.writeNote ?? null,
  };

  let notes = 0;
  let coordination = 0;
  let groupMessages = 0;
  for (const change of changes) {
    const outcome = await applyOneChange(context, change);
    notes += outcome.notes;
    coordination += outcome.coordination;
    groupMessages += outcome.groupMessages;
    warnings.push(...outcome.warnings);
  }
  return { changes: changes.length, notes, coordination, groupMessages, warnings };
}
