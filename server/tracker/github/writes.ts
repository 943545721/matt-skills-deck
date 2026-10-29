import type { GhClient, GhResult } from "./client.ts";
import type { GhErrorKind } from "./errors.ts";
import { MAP_LABEL, normalizeIssue, asString, type Label, type NormalizedIssue } from "./normalize.ts";
import { repoSlug, validateRepoRef, type RepoRef } from "./reads.ts";
import { lookupByAnchor, withAnchor } from "./idempotency.ts";
import { attributeWriteFailure, readonlyMessage, type PermissionCache } from "./permissions.ts";
import { setBlockedBy, setParent } from "./graph.ts";
import type { ItemKind } from "../../../shared/issues.ts";

export interface WriteFailure {
  ok: false;
  kind: GhErrorKind | "invalid";
  message: string;
  raw: string;
  /** 请求可能已经送达：界面不能提示「重新提交」，否则会造重复票 / 重复评论。 */
  maybeCreated?: boolean;
}

export type WriteResult<T> = { ok: true; data: T } | WriteFailure;

export interface CommentData {
  id?: string;
  author: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  editedAt?: string;
}

const TITLE_MAX = 256;
const BODY_MAX = 60_000;

function invalid<T>(message: string): WriteResult<T> {
  return { ok: false, kind: "invalid", message, raw: "" };
}

function failureOf<T>(result: Extract<GhResult, { ok: false }>, maybeCreated?: boolean): WriteResult<T> {
  return {
    ok: false,
    kind: result.error.kind,
    message: result.error.message,
    raw: result.error.raw,
    ...(maybeCreated !== undefined ? { maybeCreated } : {}),
  };
}

/** 4xx（408 除外）与本地校验失败是「确定没写」；5xx / 超时 / 断连都可能已经落盘。 */
function maybeSent(result: Extract<GhResult, { ok: false }>): boolean {
  if (result.error.kind === "env" || result.error.kind === "auth" || result.error.kind === "parse") return false;
  if (result.error.kind === "network" || result.error.kind === "ratelimit") return true;
  return true;
}

function titleProblem(title: string): string | null {
  if (!title.trim()) return "标题不能为空";
  if (title.trim().length > TITLE_MAX) return `标题过长（上限 ${TITLE_MAX} 字）`;
  return null;
}

function bodyProblem(body: string | undefined): string | null {
  return typeof body === "string" && body.length > BODY_MAX ? `正文过长（上限 ${BODY_MAX} 字）` : null;
}

function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of list) {
    const name = String(value ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface IssueSnapshot extends NormalizedIssue {
  body: string;
}

/** 读当前票面（`gh issue view --json`）：写前对账与写后读回共用这一份。 */
export async function readIssueSnapshot(client: GhClient, repo: RepoRef, number: number): Promise<WriteResult<IssueSnapshot>> {
  const result = await client.exec(
    [
      "issue",
      "view",
      String(number),
      "--repo",
      repoSlug(repo),
      "--json",
      "number,title,body,state,url,createdAt,updatedAt,labels,assignees,milestone,author",
    ],
    { cwd: repo.cwd },
  );
  if (!result.ok) return failureOf(result);
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout || "null");
  } catch {
    return { ok: false, kind: "parse", message: "issue view 回包不是合法 JSON", raw: result.stdout.slice(0, 800) };
  }
  const mapped = normalizeIssue(raw, { kindHint: "issue", withBody: true });
  if (!mapped) return { ok: false, kind: "parse", message: "issue view 回包缺少票号", raw: "" };
  return { ok: true, data: { ...mapped, body: asString((raw as { body?: unknown }).body) } };
}

async function strictReadback<T>(
  client: GhClient,
  repo: RepoRef,
  number: number,
  action: string,
  verify: (snapshot: IssueSnapshot) => string | null,
): Promise<WriteResult<IssueSnapshot>> {
  const readback = await readIssueSnapshot(client, repo, number);
  if (!readback.ok) {
    return {
      ok: false,
      kind: readback.kind,
      message: `写动作已回成功（${action}），但写后读回失败：${readback.message}`,
      raw: readback.raw,
    };
  }
  const mismatch = verify(readback.data);
  if (mismatch) {
    return { ok: false, kind: "conflict", message: `写动作已回成功（${action}），但写后读回不一致：${mismatch}`, raw: "" };
  }
  return readback;
}

/** 标签入参：DSH 契约允许裸串或完整形状；写路径只取 name。 */
export type LabelInput = string | { name: string; color?: string; description?: string };
/** 指派入参：裸登录名或完整形状；写路径只取 login。 */
export type AssigneeInput = string | { login: string };

export interface CreateIssueInput {
  title: string;
  body?: string;
  /** 票种（DSH 契约的 type）：map 额外挂 `wayfinder:map`；spec 与 issue 同路。 */
  type?: "issue" | "map" | "spec";
  /** 兼容工具层的 kind：PR 不走建票接口，显式拒绝而不是悄悄建成 issue。 */
  kind?: ItemKind;
  labels?: readonly LabelInput[];
  assignees?: readonly AssigneeInput[];
  /** 父票号：写完后挂到这张子票下面。 */
  parentKey?: string | null;
  /** 阻塞方票号：写完后建立 blocked-by 边。 */
  blockedBy?: readonly string[];
  /** 幂等键：同一键重复提交返回已存在的票，不再新建。 */
  idempotencyKey?: string;
}

function labelNamesOf(input: readonly LabelInput[] | undefined): string[] {
  return dedupe((input ?? []).map((entry) => (typeof entry === "string" ? entry : entry?.name ?? "")));
}

function loginNamesOf(input: readonly AssigneeInput[] | undefined): string[] {
  return dedupe((input ?? []).map((entry) => (typeof entry === "string" ? entry : entry?.login ?? "")));
}

export interface CreateIssueData {
  issue: IssueSnapshot;
  deduplicated: boolean;
  labelError?: string;
  assigneeError?: string;
  parentError?: string;
  blockedByError?: string;
}

/**
 * 建票（DSH issues-write.ts）。
 *
 * 主写只有一次 REST POST；标签、指派、父票、阻塞边都是后续独立写。
 * 后续写失败时票已经建好——必须返回 `ok:true` 并逐项报告 `*Error`，
 * 不能把整件事说成失败，否则用户会重建成两张票。
 */
export async function createIssue(client: GhClient, repo: RepoRef, input: CreateIssueInput): Promise<WriteResult<CreateIssueData>> {
  const bad = validateRepoRef(repo);
  if (bad) return { ok: false, kind: bad.kind === "invalid" ? "invalid" : bad.kind, message: bad.message, raw: bad.raw };
  const title = input.title.trim();
  const titleIssue = titleProblem(title);
  if (titleIssue) return invalid(titleIssue);
  const bodyIssue = bodyProblem(input.body);
  if (bodyIssue) return invalid(bodyIssue);
  if (input.kind === "pull-request") {
    return { ok: false, kind: "unsupported", message: "建票接口只建 issue；PR 请在 GitHub 上从分支创建。", raw: "" };
  }
  if (input.type !== undefined && input.type !== "issue" && input.type !== "map" && input.type !== "spec") {
    return invalid(`不认识的票种：${String(input.type)}`);
  }

  if (input.idempotencyKey) {
    const lookup = await lookupByAnchor(client, repo, input.idempotencyKey, { cwd: repo.cwd });
    if (!lookup.ok) return { ok: false, kind: lookup.kind === "invalid" ? "invalid" : lookup.kind, message: lookup.message, raw: lookup.raw };
    if (lookup.hit) {
      const hit = await readIssueSnapshot(client, repo, lookup.issue.number);
      const issue = hit.ok ? hit.data : ({ ...lookup.issue, body: "" } as IssueSnapshot);
      return { ok: true, data: { issue, deduplicated: true } };
    }
  }

  const body = input.idempotencyKey ? withAnchor(input.body ?? "", input.idempotencyKey) : (input.body ?? "");
  const created = await client.rest(`repos/${repoSlug(repo)}/issues`, {
    method: "POST",
    fields: { title, body },
    jq: ".",
    cwd: repo.cwd,
  });
  if (!created.ok) return failureOf(created, maybeSent(created));

  let raw: unknown;
  try {
    raw = JSON.parse(created.stdout || "null");
  } catch {
    return { ok: false, kind: "parse", message: "建票回包不是合法 JSON，票可能已经建好，刷新后确认", raw: created.stdout.slice(0, 800), maybeCreated: true };
  }
  const mapped = normalizeIssue(raw, { kindHint: "issue", withBody: true });
  if (!mapped) return { ok: false, kind: "parse", message: "建票回包缺少票号，票可能已经建好，刷新后确认", raw: "", maybeCreated: true };
  const issue: IssueSnapshot = { ...mapped, body: asString((raw as { body?: unknown }).body) || body };
  const data: CreateIssueData = { issue, deduplicated: false };

  const labels = labelNamesOf(input.labels);
  // 地图票靠标签识别（列表与详情都读 `wayfinder:map`）；与用户显式标签合并去重。
  if (input.type === "map" && !labels.includes(MAP_LABEL)) labels.push(MAP_LABEL);
  if (labels.length) {
    const labelled = await setLabels(client, repo, String(issue.number), labels);
    if (labelled.ok) data.issue = { ...issue, labels: labelled.data.labels };
    else data.labelError = `标签没挂上（票已建好）：${labelled.message}`;
  }

  const assignees = loginNamesOf(input.assignees);
  if (assignees.length) {
    const assigned = await setAssignees(client, repo, String(issue.number), assignees);
    if (assigned.ok) data.issue = { ...data.issue, assignees: assigned.data.assignees };
    else data.assigneeError = `指派没写进去（票已建好）：${assigned.message}`;
  }

  if (input.parentKey) {
    const graph = await setParent(client, repo, String(issue.number), input.parentKey);
    if (!graph.ok) data.parentError = `父票没挂上（票已建好）：${graph.message}`;
  }

  if (input.blockedBy && input.blockedBy.length) {
    const graph = await setBlockedBy(client, repo, String(issue.number), input.blockedBy);
    if (!graph.ok) data.blockedByError = `阻塞边没写进去（票已建好）：${graph.message}`;
  }

  return { ok: true, data };
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
  /** 这些字段 GitHub 的 issue edit 不支持，显式拒绝而不是悄悄忽略。 */
  milestone?: string;
  customFields?: Record<string, unknown>;
  expectedUpdatedAt?: string;
}

/** 改标题 / 正文：只发用户明确给出的字段；写后严格读回，读回不一致按失败报。 */
export async function updateIssue(client: GhClient, repo: RepoRef, key: string, input: UpdateIssueInput): Promise<WriteResult<IssueSnapshot>> {
  const bad = validateRepoRef(repo);
  if (bad) return { ok: false, kind: "invalid", message: bad.message, raw: "" };
  const number = Number(key);
  if (!Number.isInteger(number) || number <= 0) return invalid(`票号必须是正整数：${key}`);
  if (input.milestone !== undefined || input.customFields !== undefined) {
    return { ok: false, kind: "unsupported", message: "GitHub 的 gh issue edit 不支持 milestone / customFields，本次拒绝执行（没有写任何字段）。", raw: "" };
  }
  if (input.title === undefined && input.body === undefined) return invalid("至少给一个要改的字段（title / body）");
  const title = input.title?.trim();
  if (title !== undefined) {
    const problem = titleProblem(title);
    if (problem) return invalid(problem);
  }
  const bodyIssue = bodyProblem(input.body);
  if (bodyIssue) return invalid(bodyIssue);

  if (input.expectedUpdatedAt) {
    const current = await readIssueSnapshot(client, repo, number);
    if (!current.ok) return current;
    if (current.data.updatedAt && current.data.updatedAt !== input.expectedUpdatedAt) {
      return { ok: false, kind: "conflict", message: `这张票在读取后被改过（当前 updatedAt=${current.data.updatedAt}），请刷新后再改。`, raw: "" };
    }
  }

  const args = ["issue", "edit", String(number), "--repo", repoSlug(repo)];
  if (title !== undefined) args.push("--title", title);
  if (input.body !== undefined) args.push("--body", input.body);
  const result = await client.exec(args, { cwd: repo.cwd });
  if (!result.ok) return failureOf(result);
  return strictReadback(client, repo, number, "改标题/正文", (snapshot) => {
    if (title !== undefined && snapshot.title !== title) return `标题是「${snapshot.title}」，期望「${title}」`;
    if (input.body !== undefined && snapshot.body !== input.body) return "正文与提交内容不一致";
    return null;
  });
}

/** 关闭 / 重开：命令 + 严格读回；读回失败说清「命令已成功」。关闭可带 reason（gh --reason）。 */
export async function setIssueState(
  client: GhClient,
  repo: RepoRef,
  key: string,
  state: "open" | "closed",
  options: { reason?: string } = {},
): Promise<WriteResult<{ state: "OPEN" | "CLOSED"; issue: IssueSnapshot; reason?: string }>> {
  const bad = validateRepoRef(repo);
  if (bad) return { ok: false, kind: "invalid", message: bad.message, raw: "" };
  const number = Number(key);
  if (!Number.isInteger(number) || number <= 0) return invalid(`票号必须是正整数：${key}`);
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  if (state === "open" && reason) return invalid("重开票不能带关闭原因");
  if (reason.length > 120) return invalid("关闭原因过长（上限 120 字）");
  const args = ["issue", state === "closed" ? "close" : "reopen", String(number), "--repo", repoSlug(repo)];
  if (state === "closed" && reason) args.push("--reason", reason);
  const result = await client.exec(args, { cwd: repo.cwd });
  if (!result.ok) return failureOf(result);
  const readback = await strictReadback(client, repo, number, state === "closed" ? "关票" : "重开", (snapshot) =>
    snapshot.state === (state === "closed" ? "CLOSED" : "OPEN") ? null : `状态是 ${snapshot.state}`,
  );
  if (!readback.ok) return readback;
  return {
    ok: true,
    data: { state: readback.data.state, issue: readback.data, ...(reason ? { reason } : {}) },
  };
}

/** 评论：先 REST；**任何**失败都回落 gh issue comment（DSH 原行为，报告里注明重复风险）。 */
export async function addComment(client: GhClient, repo: RepoRef, key: string, body: string): Promise<WriteResult<CommentData>> {
  const bad = validateRepoRef(repo);
  if (bad) return { ok: false, kind: "invalid", message: bad.message, raw: "" };
  const number = Number(key);
  if (!Number.isInteger(number) || number <= 0) return invalid(`票号必须是正整数：${key}`);
  if (typeof body !== "string" || !body.trim()) return invalid("评论内容不能为空");
  if (body.length > BODY_MAX) return invalid(`评论过长（上限 ${BODY_MAX} 字）`);

  const rest = await client.rest(`repos/${repoSlug(repo)}/issues/${number}/comments`, {
    method: "POST",
    fields: { body },
    jq: ".",
    cwd: repo.cwd,
  });
  if (!rest.ok) {
    const fallback = await client.exec(["issue", "comment", String(number), "--repo", repoSlug(repo), "--body", body], { cwd: repo.cwd });
    if (!fallback.ok) return failureOf(fallback);
    return { ok: true, data: optimisticComment(body) };
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(rest.stdout || "null");
    if (Array.isArray(raw)) raw = raw[0];
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return { ok: true, data: optimisticComment(body) };
  const node = raw as Record<string, unknown>;
  const author = asString((node.author as { login?: unknown } | undefined)?.login) || asString((node.user as { login?: unknown } | undefined)?.login);
  const createdAt = asString(node.createdAt) || asString(node.created_at) || new Date().toISOString();
  const editedAt = asString(node.editedAt) || asString(node.edited_at);
  return {
    ok: true,
    data: {
      ...(node.id !== undefined ? { id: String(node.id) } : {}),
      author,
      authorAssociation: asString(node.authorAssociation) || asString(node.author_association),
      body: asString(node.body) || body,
      createdAt,
      updatedAt: asString(node.updatedAt) || asString(node.updated_at) || createdAt,
      ...(editedAt ? { editedAt } : {}),
    },
  };
}

function optimisticComment(body: string): CommentData {
  const now = new Date().toISOString();
  return { author: "", authorAssociation: "", body, createdAt: now, updatedAt: now };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((value) => set.has(value));
}

export interface LabelData {
  labels: Label[];
}

/**
 * 整体替换标签：先算差集，再一次性 `gh issue edit`；写后严格读回。
 *
 * 失败归属：404 或权限话术时读一次 `.permissions`；没有 push 就如实说「只读」，
 * 不要把「没权限」伪装成「标签不存在」。
 */
export async function setLabels(
  client: GhClient,
  repo: RepoRef,
  key: string,
  labels: readonly string[],
  options: { expectedUpdatedAt?: string; cache?: PermissionCache } = {},
): Promise<WriteResult<LabelData>> {
  const bad = validateRepoRef(repo);
  if (bad) return { ok: false, kind: "invalid", message: bad.message, raw: "" };
  const number = Number(key);
  if (!Number.isInteger(number) || number <= 0) return invalid(`票号必须是正整数：${key}`);
  const wanted = dedupe(labels);
  if (wanted.some((label) => /[\r\n]/.test(label))) return invalid("标签名不能包含换行");

  const current = await readIssueSnapshot(client, repo, number);
  if (!current.ok) return current;
  if (options.expectedUpdatedAt && current.data.updatedAt !== options.expectedUpdatedAt) {
    return { ok: false, kind: "conflict", message: `这张票在读取后被改过（当前 updatedAt=${current.data.updatedAt}），请刷新后再改标签。`, raw: "" };
  }
  const existing = current.data.labels.map((label) => label.name);
  const toAdd = wanted.filter((name) => !existing.includes(name));
  const toRemove = existing.filter((name) => !wanted.includes(name));
  if (toAdd.length === 0 && toRemove.length === 0) return { ok: true, data: { labels: current.data.labels } };

  const args = ["issue", "edit", String(number), "--repo", repoSlug(repo)];
  for (const name of toRemove) args.push("--remove-label", name);
  for (const name of toAdd) args.push("--add-label", name);
  const result = await client.exec(args, { cwd: repo.cwd });
  if (!result.ok) {
    if (result.error.kind === "notfound" || result.error.kind === "auth") {
      const verdict = await attributeWriteFailure(client, repoSlug(repo), result.error.kind, options.cache);
      if (verdict === "auth") return { ok: false, kind: "auth", message: readonlyMessage(repoSlug(repo), ["标签"]), raw: result.error.raw };
    }
    return failureOf(result);
  }
  const readback = await strictReadback(client, repo, number, "改标签", (snapshot) =>
    sameSet(snapshot.labels.map((label) => label.name), wanted) ? null : `远端标签是 [${snapshot.labels.map((label) => label.name).join("、")}]`,
  );
  if (!readback.ok) return readback;
  return { ok: true, data: { labels: readback.data.labels } };
}

/** 增一个标签：读当前 + 整体替换；不让「加标签」变成「删掉别的标签」。 */
export async function addLabel(client: GhClient, repo: RepoRef, key: string, label: string): Promise<WriteResult<LabelData>> {
  const number = Number(key);
  if (!Number.isInteger(number) || number <= 0) return invalid(`票号必须是正整数：${key}`);
  const current = await readIssueSnapshot(client, repo, number);
  if (!current.ok) return current;
  return setLabels(client, repo, key, [...current.data.labels.map((entry) => entry.name), label]);
}

/** 指派：只发差集；写后严格读回，集合不一致按失败报。 */
export async function setAssignees(client: GhClient, repo: RepoRef, key: string, assignees: readonly string[]): Promise<WriteResult<{ assignees: string[] }>> {
  const bad = validateRepoRef(repo);
  if (bad) return { ok: false, kind: "invalid", message: bad.message, raw: "" };
  const number = Number(key);
  if (!Number.isInteger(number) || number <= 0) return invalid(`票号必须是正整数：${key}`);
  const wanted = dedupe(assignees);
  if (wanted.some((login) => !/^[A-Za-z0-9-]+$/.test(login))) return invalid("指派账号只能包含字母、数字与连字符");
  const current = await readIssueSnapshot(client, repo, number);
  if (!current.ok) return current;
  const existing = current.data.assignees;
  const toAdd = wanted.filter((login) => !existing.includes(login));
  const toRemove = existing.filter((login) => !wanted.includes(login));
  if (toAdd.length === 0 && toRemove.length === 0) return { ok: true, data: { assignees: existing } };

  const args = ["issue", "edit", String(number), "--repo", repoSlug(repo)];
  for (const login of toRemove) args.push("--remove-assignee", login);
  for (const login of toAdd) args.push("--add-assignee", login);
  const result = await client.exec(args, { cwd: repo.cwd });
  if (!result.ok) return failureOf(result);
  const readback = await strictReadback(client, repo, number, "改指派", (snapshot) =>
    sameSet(snapshot.assignees, wanted) ? null : `远端指派是 [${snapshot.assignees.join("、")}]`,
  );
  if (!readback.ok) return readback;
  return { ok: true, data: { assignees: readback.data.assignees } };
}

export interface ReportInput {
  title: string;
  whatHappened: string;
  expected?: string;
  steps?: readonly string[];
  labels?: readonly string[];
  idempotencyKey?: string;
}

/** 报告 = 结构化正文 + 一次建票；不另开第二套写路径。 */
export async function reportIssue(client: GhClient, repo: RepoRef, input: ReportInput): Promise<WriteResult<CreateIssueData>> {
  if (!input.whatHappened.trim()) return invalid("whatHappened 不能为空");
  const sections = [`## 发生了什么\n\n${input.whatHappened.trim()}`];
  if (input.expected?.trim()) sections.push(`## 期望\n\n${input.expected.trim()}`);
  if (input.steps && input.steps.length) {
    sections.push(`## 复现步骤\n\n${input.steps.map((step, index) => `${index + 1}. ${step.trim()}`).join("\n")}`);
  }
  return createIssue(client, repo, {
    title: input.title,
    body: sections.join("\n\n"),
    labels: input.labels,
    idempotencyKey: input.idempotencyKey,
  });
}
