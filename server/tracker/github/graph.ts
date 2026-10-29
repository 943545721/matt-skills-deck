import type { BlockerRef } from "../../../shared/issues.ts";
import type { GhClient, GhResult } from "./client.ts";
import type { GhErrorKind } from "./errors.ts";
import { asPositiveInt, asString, edgeNodesOf, mapBlockerNodes, normalizeIssue, type NormalizedIssue } from "./normalize.ts";
import { ADD_BLOCKED_BY_MUTATION, REMOVE_BLOCKED_BY_MUTATION, issueNodeIdsQuery } from "./queries.ts";
import { parseGraphql, repoSlug, validateRepoRef, type ReadFailure, type RepoRef } from "./reads.ts";
import { listIssuesPage } from "./reads.ts";
import type { WriteFailure, WriteResult } from "./writes.ts";

/**
 * 关系边（DSH graph.ts + blocked-by-write.ts）。
 *
 * 父票与阻塞边都遵循同一条主线：**读真值 → 算差集 → 写 → 写后读回**。
 * 写路径优先新接口（GraphQL / `gh issue edit --parent`），只有上游明确说
 * 「这个能力不存在」才回落 REST；配额、鉴权、网络错误不靠换路解决。
 */

export interface GraphWriteData {
  blockedBy: BlockerRef[];
  route: "graphql" | "rest";
  optimistic?: boolean;
  cycleCheck?: "clear" | "cycle" | "unchecked";
}

export interface ParentData {
  parentKey: string | null;
}

const UNSUPPORTED_TEXT = /unsupported|not supported|doesn'?t exist|does not exist|unknown (field|argument)|no such (field|type)|can'?t query field|cannot query field/i;
const UNKNOWN_FLAG = /unknown flag|unknown shorthand flag|flag provided but not defined/i;

function fail<T>(kind: GhErrorKind | "invalid", message: string, raw = ""): WriteResult<T> {
  return { ok: false, kind, message, raw };
}

function failureOf<T>(result: Extract<GhResult, { ok: false }>, own?: string): WriteResult<T> {
  return { ok: false, kind: result.error.kind, message: own ? `${own}：${result.error.message}` : result.error.message, raw: result.error.raw };
}

function parseKey(key: string): number | null {
  const number = Number(key);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function snapshotOf(client: GhClient, repo: RepoRef, number: number): Promise<WriteResult<{ updatedAt: string; blockedBy: BlockerRef[]; title: string; state: "OPEN" | "CLOSED" }>> {
  const result = await client.rest(`repos/${repoSlug(repo)}/issues/${number}`, { jq: ".", cwd: repo.cwd });
  if (!result.ok) return failureOf(result);
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout || "null");
  } catch {
    return fail("parse", "issue 回包不是合法 JSON");
  }
  const mapped = normalizeIssue(raw, { kindHint: "issue" });
  if (!mapped) return fail("parse", `#${number} 回包缺少票号`);
  return {
    ok: true,
    data: {
      updatedAt: asString((raw as { updated_at?: unknown }).updated_at) || mapped.updatedAt,
      blockedBy: mapBlockerNodes((raw as { blocked_by?: unknown }).blocked_by),
      title: mapped.title,
      state: mapped.state,
    },
  };
}

async function readParentNumber(client: GhClient, repo: RepoRef, number: number): Promise<WriteResult<number | null>> {
  const query = `query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){ issue(number:$number){ number parent{number} } }
  }`;
  const result = await client.graphql(query, { owner: repo.owner, name: repo.name, number }, { cwd: repo.cwd });
  if (!result.ok) return failureOf(result);
  const payload = parseGraphql(result.stdout);
  const repository = payload?.data?.repository as Record<string, unknown> | null | undefined;
  const node = repository?.issue as Record<string, unknown> | null | undefined;
  if (!node) return fail("notfound", `找不到 #${number}`);
  const parent = node.parent as { number?: unknown } | null | undefined;
  return { ok: true, data: asPositiveInt(parent?.number) };
}

async function issueDbId(client: GhClient, repo: RepoRef, key: string): Promise<number | null> {
  const result = await client.rest(`repos/${repoSlug(repo)}/issues/${key}`, { jq: ".id", cwd: repo.cwd });
  if (!result.ok) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function restSubIssueArgs(repo: RepoRef, parentKey: string, childId: number, remove: boolean): { path: string; method: "POST" | "DELETE"; fields: Record<string, number> } {
  const path = remove
    ? `repos/${repoSlug(repo)}/issues/${parentKey}/sub_issue`
    : `repos/${repoSlug(repo)}/issues/${parentKey}/sub_issues`;
  return { path, method: remove ? "DELETE" : "POST", fields: { sub_issue_id: childId } };
}

async function addParentRest(client: GhClient, repo: RepoRef, childKey: string, parentKey: string): Promise<WriteResult<null>> {
  const childId = await issueDbId(client, repo, childKey);
  if (childId === null) return fail("notfound", `setParent: issue ${childKey} not found`);
  const args = restSubIssueArgs(repo, parentKey, childId, false);
  const result = await client.rest(args.path, { method: args.method, fields: args.fields, cwd: repo.cwd });
  if (!result.ok) {
    if (result.error.kind === "unsupported") return failureOf(result, "setParent unsupported");
    if (/already|duplicate/i.test(result.error.raw)) return { ok: true, data: null };
    return failureOf(result, "setParent 补子票关系时出错");
  }
  return { ok: true, data: null };
}

async function removeParentRest(client: GhClient, repo: RepoRef, childKey: string, parentKey: string): Promise<WriteResult<null>> {
  const childId = await issueDbId(client, repo, childKey);
  if (childId === null) return fail("notfound", `setParent: issue ${childKey} not found`);
  const args = restSubIssueArgs(repo, parentKey, childId, true);
  const result = await client.rest(args.path, { method: args.method, fields: args.fields, cwd: repo.cwd });
  if (!result.ok) {
    if (result.error.kind === "unsupported") return failureOf(result, "setParent unsupported");
    if (/not found|404|not a sub/i.test(result.error.raw)) return { ok: true, data: null };
    return failureOf(result, "setParent 撤子票关系时出错");
  }
  return { ok: true, data: null };
}

/**
 * 设置父票（子票关系）。
 *
 * `parentKey` 为空表示撤掉当前父票。写后严格读回；读回失败按失败报
 * （与 blocked-by 不同：这里没有「乐观结果」可说——父子关系读不回来就无法确认）。
 */
export async function setParent(
  client: GhClient,
  repo: RepoRef,
  key: string,
  parentKey: string | null,
  options: { expectedUpdatedAt?: string } = {},
): Promise<WriteResult<ParentData>> {
  const bad = validateRepoRef(repo);
  if (bad) return { ok: false, kind: bad.kind === "invalid" ? "invalid" : bad.kind, message: bad.message, raw: bad.raw };
  const child = parseKey(key);
  if (child === null) return fail("invalid", `票号必须是正整数：${key}`);
  const parent = parentKey === null || parentKey === "" ? null : parseKey(parentKey);
  if (parentKey !== null && parentKey !== "" && parent === null) return fail("invalid", `父票号必须是正整数：${parentKey}`);
  if (parent === child) return fail("conflict", "一张票不能以自己为父票");

  const snapshot = await snapshotOf(client, repo, child);
  if (!snapshot.ok) return snapshot;
  if (options.expectedUpdatedAt && snapshot.data.updatedAt !== options.expectedUpdatedAt) {
    return fail("conflict", `这张票在读取后被改过（当前 updatedAt=${snapshot.data.updatedAt}），请刷新后再改父票。`);
  }
  const current = await readParentNumber(client, repo, child);
  if (!current.ok) return current;
  if (current.data === parent) return { ok: true, data: { parentKey: parent === null ? null : String(parent) } };

  if (parent === null) {
    const removed = await removeParentViaCli(client, repo, child, current.data);
    if (!removed.ok) return removed;
  } else {
    if (current.data !== null) {
      const removed = await removeParentViaCli(client, repo, child, current.data);
      if (!removed.ok) return removed;
    }
    const added = await addParentViaCli(client, repo, child, parent);
    if (!added.ok) return added;
  }

  const readback = await readParentNumber(client, repo, child);
  if (!readback.ok) {
    return fail(readback.kind === "invalid" ? "invalid" : readback.kind, `写动作已回成功（改父票），但写后读回失败：${readback.message}`, readback.raw);
  }
  if (readback.data !== parent) {
    return fail("conflict", `写动作已回成功（改父票），但写后读回不一致：父票是 ${readback.data ?? "空"}，期望 ${parent ?? "空"}`);
  }
  return { ok: true, data: { parentKey: parent === null ? null : String(parent) } };
}

async function removeParentViaCli(client: GhClient, repo: RepoRef, child: number, currentParent: number | null): Promise<WriteResult<null>> {
  const result = await client.exec(["issue", "edit", String(child), "--repo", repoSlug(repo), "--remove-parent"], { cwd: repo.cwd });
  if (result.ok) return { ok: true, data: null };
  if (UNKNOWN_FLAG.test(result.error.raw)) {
    if (currentParent === null) return { ok: true, data: null };
    return removeParentRest(client, repo, String(child), String(currentParent));
  }
  if (UNSUPPORTED_TEXT.test(result.error.raw)) return failureOf(result, "setParent unsupported");
  return failureOf(result, "setParent 撤父票时出错");
}

async function addParentViaCli(client: GhClient, repo: RepoRef, child: number, parent: number): Promise<WriteResult<null>> {
  const result = await client.exec(["issue", "edit", String(child), "--repo", repoSlug(repo), "--parent", String(parent)], { cwd: repo.cwd });
  if (result.ok) return { ok: true, data: null };
  const text = result.error.raw;
  if (UNKNOWN_FLAG.test(text)) return addParentRest(client, repo, String(child), String(parent));
  if (UNSUPPORTED_TEXT.test(text)) return failureOf(result, "setParent unsupported");
  // 目标关系已经存在：撤掉再补一次（新接口不接受重复挂载）。
  if (/already a sub-issue|already (has|have) a parent|already exists/i.test(text)) {
    const current = await readParentNumber(client, repo, child);
    if (!current.ok) return current;
    if (current.data !== null) {
      const removed = await removeParentRest(client, repo, String(child), String(current.data));
      if (!removed.ok) return removed;
    }
    const retry = await client.exec(["issue", "edit", String(child), "--repo", repoSlug(repo), "--parent", String(parent)], { cwd: repo.cwd });
    if (retry.ok) return { ok: true, data: null };
    return failureOf(retry, "setParent 补父票时出错");
  }
  return failureOf(result, "setParent 补父票时出错");
}

export interface BlockedByReadData {
  blockedBy: BlockerRef[];
  nativeKnown: boolean;
  truncated: boolean;
}

/** 读原生阻塞边（REST `/dependencies/blocked_by`）。端点不存在时 nativeKnown=false，调用方据此判 unsupported。 */
export async function readBlockedBy(client: GhClient, repo: RepoRef, number: number): Promise<WriteResult<BlockedByReadData>> {
  const result = await client.rest(`repos/${repoSlug(repo)}/issues/${number}/dependencies/blocked_by?per_page=100`, { jq: ".", cwd: repo.cwd });
  if (!result.ok) {
    if (result.error.kind === "unsupported" || /not found|404|not supported/i.test(result.error.raw)) {
      return { ok: true, data: { blockedBy: [], nativeKnown: false, truncated: false } };
    }
    return failureOf(result, "读阻塞边失败");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout || "[]");
  } catch {
    return fail("parse", "阻塞边回包不是合法 JSON");
  }
  const nodes = edgeNodesOf(raw);
  return { ok: true, data: { blockedBy: mapBlockerNodes(raw), nativeKnown: true, truncated: nodes.length >= 100 } };
}

async function adjacencyFor(client: GhClient, repo: RepoRef): Promise<Map<number, number[]> | null> {
  const adjacency = new Map<number, number[]>();
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await listIssuesPage(client, { repo, kind: "issue", state: "all", limit: 200, cursor });
    if (!result.ok) return null;
    for (const issue of result.data.items) {
      adjacency.set(issue.number, issue.blockedBy.map((blocker) => blocker.number));
    }
    if (!result.data.hasMore || !result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return adjacency;
}

function hasCycle(adjacency: Map<number, number[]>, target: number, blockers: readonly number[]): boolean {
  const seen = new Set<number>();
  const stack = [...blockers];
  while (stack.length) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === target) return true;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

async function graphqlIds(client: GhClient, repo: RepoRef, keys: readonly string[]): Promise<Map<string, string> | null> {
  if (!keys.length) return new Map();
  if (keys.some((key) => !/^\d+$/.test(key))) return null;
  const result = await client.graphql(issueNodeIdsQuery(keys), { owner: repo.owner, name: repo.name }, { cwd: repo.cwd });
  if (!result.ok) return null;
  const payload = parseGraphql(result.stdout);
  const repository = payload?.data?.repository as Record<string, unknown> | null | undefined;
  if (!repository || payload?.errors) return null;
  const ids = new Map<string, string>();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const cell = repository[`i${index}`] as { id?: unknown } | undefined;
    if (key === undefined || typeof cell?.id !== "string" || !cell.id) return null;
    ids.set(key, cell.id);
  }
  return ids;
}

type MutationStatus = "ok" | "already" | "absent" | "cycle" | "unsupported" | "failed";

async function edgeMutation(client: GhClient, repo: RepoRef, mutation: string, payloadKey: string, issueId: string, blockingId: string): Promise<{ status: MutationStatus; raw: string; kind: GhErrorKind }> {
  const result = await client.graphql(mutation, { issueId, blockingIssueId: blockingId }, { method: "POST", cwd: repo.cwd });
  let graphErrors: unknown = null;
  let root: Record<string, unknown> | null = null;
  if (result.ok) {
    root = parseGraphql(result.stdout) as Record<string, unknown> | null;
    graphErrors = root && typeof root === "object" ? (root as { errors?: unknown }).errors : null;
  }
  const text = (result.ok ? "" : result.error.raw) + " " + (graphErrors ? JSON.stringify(graphErrors) : "");
  const data = root && typeof root === "object" ? (root.data as Record<string, unknown> | undefined) : undefined;
  if (result.ok && !graphErrors && data?.[payloadKey]) return { status: "ok", raw: text.slice(0, 300), kind: "network" };
  if (UNSUPPORTED_TEXT.test(text)) return { status: "unsupported", raw: text.slice(0, 300), kind: "unsupported" };
  if (/cycle|circular/i.test(text)) return { status: "cycle", raw: text.slice(0, 300), kind: "conflict" };
  if (/already (been )?(taken|blocked|exists)|duplicate/i.test(text)) return { status: "already", raw: text.slice(0, 300), kind: "conflict" };
  if (/not (currently )?blocked|no such (blocking )?relationship|not blocked by|isn'?t blocked/i.test(text)) return { status: "absent", raw: text.slice(0, 300), kind: "notfound" };
  return { status: "failed", raw: text.slice(0, 300), kind: result.ok ? "network" : result.error.kind };
}

interface EdgePhase {
  ok: boolean;
  fellBack: boolean;
  doneAdd: Set<string>;
  doneRemove: Set<string>;
  message?: string;
  kind?: GhErrorKind;
}

async function writeEdgesGraphql(client: GhClient, repo: RepoRef, key: string, toAdd: readonly string[], toRemove: readonly string[], ids: Map<string, string>): Promise<EdgePhase> {
  const doneAdd = new Set<string>();
  const doneRemove = new Set<string>();
  const issueId = ids.get(key) ?? "";
  for (const blocker of toRemove) {
    const outcome = await edgeMutation(client, repo, REMOVE_BLOCKED_BY_MUTATION, "removeBlockedBy", issueId, ids.get(blocker) ?? "");
    if (outcome.status === "ok" || outcome.status === "absent" || outcome.status === "already") {
      doneRemove.add(blocker);
      continue;
    }
    if (outcome.status === "unsupported") return { ok: false, fellBack: true, doneAdd, doneRemove };
    if (outcome.status === "cycle") return { ok: false, fellBack: false, doneAdd, doneRemove, message: `阻塞关系会形成环：${outcome.raw}`, kind: "conflict" };
    return { ok: false, fellBack: false, doneAdd, doneRemove, message: `setBlockedBy 撤阻塞边时出错：${outcome.raw}`, kind: outcome.kind };
  }
  for (const blocker of toAdd) {
    const outcome = await edgeMutation(client, repo, ADD_BLOCKED_BY_MUTATION, "addBlockedBy", issueId, ids.get(blocker) ?? "");
    if (outcome.status === "ok" || outcome.status === "already") {
      doneAdd.add(blocker);
      continue;
    }
    if (outcome.status === "unsupported") return { ok: false, fellBack: true, doneAdd, doneRemove };
    if (outcome.status === "cycle") return { ok: false, fellBack: false, doneAdd, doneRemove, message: `阻塞关系会形成环：${outcome.raw}`, kind: "conflict" };
    return { ok: false, fellBack: false, doneAdd, doneRemove, message: `setBlockedBy 补阻塞边时出错：${outcome.raw}`, kind: outcome.kind };
  }
  return { ok: true, fellBack: false, doneAdd, doneRemove };
}

async function writeEdgesRest(client: GhClient, repo: RepoRef, key: string, toAdd: readonly string[], toRemove: readonly string[], doneAdd: Set<string>, doneRemove: Set<string>, nativeKnown: boolean): Promise<WriteResult<"rest">> {
  const pendingAdd = toAdd.filter((blocker) => !doneAdd.has(blocker));
  const pendingRemove = toRemove.filter((blocker) => !doneRemove.has(blocker));
  const ids = new Map<string, number>();
  for (const blocker of [...new Set([...pendingAdd, ...pendingRemove])]) {
    const id = await issueDbId(client, repo, blocker);
    if (id === null) return fail("notfound", `setBlockedBy: issue ${blocker} not found`);
    ids.set(blocker, id);
  }
  for (const blocker of pendingRemove) {
    const blockingId = ids.get(blocker);
    if (blockingId === undefined) return fail("notfound", `setBlockedBy: issue ${blocker} not found`);
    const result = await client.rest(`repos/${repoSlug(repo)}/issues/${key}/dependencies/blocked_by/${blockingId}`, { method: "DELETE", cwd: repo.cwd });
    if (result.ok) continue;
    const text = result.error.raw;
    if (result.error.kind === "unsupported" || (!nativeKnown && /not found|404/i.test(text))) {
      return fail("unsupported", `setBlockedBy unsupported：${result.error.message}`, text);
    }
    if (/not found|404/i.test(text)) continue;
    return failureOf(result, "setBlockedBy 撤阻塞边时出错");
  }
  for (const blocker of pendingAdd) {
    const blockingId = ids.get(blocker);
    if (blockingId === undefined) return fail("notfound", `setBlockedBy: issue ${blocker} not found`);
    const result = await client.rest(`repos/${repoSlug(repo)}/issues/${key}/dependencies/blocked_by`, {
      method: "POST",
      fields: { issue_id: blockingId },
      cwd: repo.cwd,
    });
    if (result.ok) continue;
    const text = result.error.raw;
    if (result.error.kind === "unsupported" || /unsupported|not found|404.*dependencies/i.test(text)) {
      return fail("unsupported", `setBlockedBy unsupported：${result.error.message}`, text);
    }
    if (/cycle|circular/i.test(text)) return fail("conflict", `阻塞关系会形成环：${text.slice(0, 200)}`, text);
    if (/already been taken|already exists|already exist|duplicate/i.test(text)) continue;
    return failureOf(result, "setBlockedBy 补阻塞边时出错");
  }
  return { ok: true, data: "rest" };
}

/**
 * 设置阻塞边（整体替换语义）：读当前 → 自环/成环检查 → GraphQL mutation → 明确不支持才 REST。
 * 写后读回失败时返回**乐观结果** `optimistic:true`：写命令都成功了，只是读不回来；
 * 这时报失败会让用户重试，而重试会重复提交同一批边。
 */
export async function setBlockedBy(
  client: GhClient,
  repo: RepoRef,
  key: string,
  blockers: readonly string[],
  options: { expectedUpdatedAt?: string } = {},
): Promise<WriteResult<GraphWriteData>> {
  const bad = validateRepoRef(repo);
  if (bad) return { ok: false, kind: bad.kind === "invalid" ? "invalid" : bad.kind, message: bad.message, raw: bad.raw };
  const target = parseKey(key);
  if (target === null) return fail("invalid", `票号必须是正整数：${key}`);
  const wanted = [...new Set(blockers.map((value) => String(value).trim()).filter(Boolean))];
  if (wanted.some((value) => parseKey(value) === null)) return fail("invalid", "阻塞方票号必须都是正整数");
  if (wanted.some((value) => Number(value) === target)) return fail("conflict", "一张票不能阻塞自己");

  const snapshot = await snapshotOf(client, repo, target);
  if (!snapshot.ok) return snapshot;
  if (options.expectedUpdatedAt && snapshot.data.updatedAt !== options.expectedUpdatedAt) {
    return fail("conflict", `这张票在读取后被改过（当前 updatedAt=${snapshot.data.updatedAt}），请刷新后再改阻塞边。`);
  }

  const adjacency = await adjacencyFor(client, repo);
  if (adjacency && hasCycle(adjacency, target, wanted.map(Number))) {
    return fail("conflict", `阻塞关系会形成环：${wanted.map((value) => `#${value}`).join("、")} 已经（间接）依赖 #${target}`);
  }
  const cycleCheck: "clear" | "unchecked" = adjacency ? "clear" : "unchecked";

  const current = await readBlockedBy(client, repo, target);
  if (!current.ok) return current;
  if (current.data.truncated) return fail("unsupported", "当前阻塞边超过 100 条，读取被截断；为避免误删，本次不写。");
  const currentKeys = new Set(current.data.blockedBy.map((blocker) => String(blocker.number)));
  const wantedSet = new Set(wanted);
  const toAdd = wanted.filter((value) => !currentKeys.has(value));
  const toRemove = [...currentKeys].filter((value) => !wantedSet.has(value));

  let route: "graphql" | "rest" = "rest";
  if (toAdd.length || toRemove.length) {
    const ids = await graphqlIds(client, repo, [...new Set([key, ...toAdd, ...toRemove])]);
    if (ids) {
      const phase = await writeEdgesGraphql(client, repo, key, toAdd, toRemove, ids);
      if (phase.ok) {
        route = "graphql";
      } else if (phase.fellBack) {
        const rest = await writeEdgesRest(client, repo, key, toAdd, toRemove, phase.doneAdd, phase.doneRemove, current.data.nativeKnown);
        if (!rest.ok) return rest;
        route = "rest";
      } else {
        return fail(phase.kind ?? "network", phase.message ?? "setBlockedBy 写阻塞边失败");
      }
    } else {
      const rest = await writeEdgesRest(client, repo, key, toAdd, toRemove, new Set(), new Set(), current.data.nativeKnown);
      if (!rest.ok) return rest;
      route = "rest";
    }
  }

  const readback = await readBlockedBy(client, repo, target);
  if (!readback.ok) {
    return {
      ok: true,
      data: {
        blockedBy: wanted.map((value) => ({ number: Number(value), title: `#${value}`, state: "OPEN", kind: "issue" as const })),
        route,
        optimistic: true,
        cycleCheck,
      },
    };
  }
  const actual = readback.data.blockedBy.map((blocker) => String(blocker.number)).sort();
  const expected = [...wanted].sort();
  if (actual.join(",") !== expected.join(",")) {
    return fail("conflict", `写动作已回成功（改阻塞边），但写后读回不一致：远端是 [${actual.join("、")}]，期望 [${expected.join("、")}]`, "");
  }
  return { ok: true, data: { blockedBy: readback.data.blockedBy, route, cycleCheck } };
}
