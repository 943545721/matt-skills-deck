import path from "node:path";
import { z } from "zod";
import { getIssue, listIssues } from "../tracker/github.ts";
import {
  createGitLabIssue,
  getGitLabIssue,
  postGitLabComment,
  setGitLabAssignees,
  setGitLabBlockedBy,
  setGitLabLabels,
  setGitLabParent,
  updateGitLabIssue,
} from "../tracker/gitlab.ts";
import { readBoard, readIssue } from "../tracker/read.ts";
import { resolveBackend, resolveWritableBackend, type WritableBackend } from "../tracker/backend.ts";
import { repoOf, resolveWorkspaceTargets } from "../tracker/targets.ts";
import { createLocalIssue, getLocalIssue, patchLocalIssue, postLocalComment, readLocalContainer, replaceLocalLabels, resolveLocalStore, setLocalBlockedBy, setLocalParent } from "../tracker/local.ts";
import { ensureIssueBody } from "../tracker/ensure-body.ts";
import { createGithubOperations } from "../tracker/github/operations.ts";
import { ensureLabels, resolveCreateKind, type PositionKind } from "../../shared/issue-kind.ts";
import { markerKindAtStart, markerKindInHeader, markerLineFor } from "../../shared/issue-marker.ts";
import { anchorKeyFor } from "../../shared/anchor.ts";
import { readMdScope } from "../../shared/md-scope.ts";
import { parseMapBody } from "../tracker/map-body.ts";
import { routeFromIssues, suggestNextSteps } from "../tracker/map-route.ts";
import { createIssue, patchIssue, postComment, replaceLabels } from "../tracker/write.ts";
import { sortIssues } from "../tracker/order.ts";
import { assertLabelsReadable } from "../tracker/label-guard.ts";
import { countBoard } from "../tracker/readiness.ts";
import { readStatus } from "../status.ts";
import { PLUGIN_VERSION } from "../../shared/version.ts";
import {
  DECK_TOOL_ORDER, EXTENSION_TOOL_ORDER, TOOL_SPECS, appendOriginalWords, appendProgress, bodyWithinLimit,
  canonicalToolName, commentSchema, createSchema, labelsSchema, listSchema, mapLinkSchema, mapPlanSchema,
  mapSnapshotSchema, numberSchema, parseInput as asInput, parseKey, parseOriginalWordsOf, parseProgressOf,
  patchSchema, pullListSchema, reportSchema, type ToolSpec,
} from "../../shared/tool-contract.ts";
import { SUGGEST_DEFINITION, SUGGEST_TOOL_NAME, normalizeSuggestions } from "../../shared/suggestions.ts";
import { writeChildHandoff } from "../handoff-store.ts";
import { readPlanContext } from "../daemon-profiles.ts";
import { buildDispatchPreamble, planDispatch } from "../../shared/orchestration.ts";
import { updateWorkRouteLedger } from "../ledger.ts";
import { applyWorkRouteEvent, summarizeWorkRoute, ticketKeyOf } from "../../shared/work-route.ts";
import {
  childrenOf, landingOf, refuseCyclicBlockBatch, resolveDependencyRefs, statusOfItems, upsertCrossRepoBlockedBy,
  type DependencyScope, type EdgeEvidence,
} from "../../shared/edge-rules.ts";
import { readWorkspaceConfig } from "../tracker/workspace-repo.ts";
import { withDerivedFrom } from "../../shared/derived.ts";
import { mapPlanBody, mergeScopedLabels, resolveIssueProjectScope, resolveMapProject } from "./project-scope.ts";

/**
 * 给 Agent 用的 deck_* 工具。
 *
 * 这些工具与面板走同一套领域代码（`server/tracker/*`），区别只在出口：面板回 RPC，
 * 这里回 MCP 的文本内容。所以「面板上看到的票」和「Agent 读到的票」是同一份读取逻辑，
 * 不会出现两边口径不一致。
 *
 * 名字与参数表住在 `shared/tool-contract.ts`：九个 DSH 冻结工具 + 本插件扩展工具。
 * 这里只负责把每个名字接到真正的 handler 上。旧名（deck_issues_list / deck_map）由
 * `canonicalToolName` 在查找期归一，注册表里不会出现重复条目。
 *
 * 读写分开登记：只有只读工具进 preapproved 白名单，写工具一律走用户确认——
 * 一个装完就能改远端票面的插件，不该在没人按过按钮的情况下动手。
 */

export interface ToolContext { workspaceDir: string }
export interface ToolResult { text: string; isError: boolean }

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown, context: ToolContext): Promise<ToolResult>;
}

const MAP_LABEL = "wayfinder:map";

/** 本地后端的 repo 没有 owner：界面上显示工作区目录名，而不是一个空字符串。 */
const repoLabel = (repo: { host: string; owner: string; name: string }): string =>
  repo.host === "local" ? `${repo.name}（本地）` : `${repo.owner}/${repo.name}`;

const ok = (value: unknown): ToolResult => ({ text: JSON.stringify(value, null, 2), isError: false });
const fail = (reason: string, detail: string): ToolResult =>
  ({ text: JSON.stringify({ ok: false, reason, detail }, null, 2), isError: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 读路径的失败原因已经由领域层给出，这里只把它照原样交给 Agent，不重新措辞。 */
const failureOf = (result: { reason: string; detail: string }): ToolResult => fail(result.reason, result.detail);

/* ------------------------------------------------------------------ 写路径分派 */

/** 写工具与面板走同一道闸门：GitHub / GitLab 写远端，本地写 `.deck/`；GitLab 的权限检查在 `resolveWritableBackend`。 */
const writeComment = (backend: WritableBackend, number: number, body: string) => {
  if (backend.kind === "github") return postComment(backend.ref.owner, backend.ref.name, number, body);
  if (backend.kind === "gitlab") return postGitLabComment(backend.ref.owner, backend.ref.name, number, body);
  return postLocalComment(backend.workspaceDir, number, body);
};
const writeIssue = (backend: WritableBackend, input: { title: string; body: string; labels: readonly string[] }) => {
  if (backend.kind === "github") return createIssue(backend.ref.owner, backend.ref.name, input);
  if (backend.kind === "gitlab") return createGitLabIssue(backend.ref.owner, backend.ref.name, input);
  return createLocalIssue(backend.workspaceDir, input);
};
const writePatch = (
  backend: WritableBackend,
  number: number,
  patch: { title?: string; body?: string; state?: "open" | "closed" },
) => {
  if (backend.kind === "github") return patchIssue(backend.ref.owner, backend.ref.name, number, patch);
  if (backend.kind === "gitlab") return updateGitLabIssue(backend.ref.owner, backend.ref.name, number, patch);
  return patchLocalIssue(backend.workspaceDir, number, patch);
};
const writeLabels = (backend: WritableBackend, number: number, labels: readonly string[]) => {
  if (backend.kind === "github") return replaceLabels(backend.ref.owner, backend.ref.name, number, labels);
  if (backend.kind === "gitlab") return setGitLabLabels(backend.ref.owner, backend.ref.name, number, labels);
  return replaceLocalLabels(backend.workspaceDir, number, labels);
};
const readOne = (backend: WritableBackend, number: number) => {
  if (backend.kind === "github") return getIssue(backend.ref.owner, backend.ref.name, number);
  if (backend.kind === "gitlab") return getGitLabIssue(backend.ref.owner, backend.ref.name, number);
  return getLocalIssue(backend.workspaceDir, number);
};

/**
 * 写路径的依赖作用域。
 *
 * 只认 `.paseo-deck.json` 的项目清单：能写进正文的跨仓库引用，必须指向配置里写明的仓库。
 * 拿「目录里碰巧有个仓库」当依据，会让引用指向一张没人认的票，而且写失败也没人发现。
 */
async function dependencyScopeOf(workspaceDir: string, backend: WritableBackend): Promise<DependencyScope> {
  const read = await readWorkspaceConfig(workspaceDir);
  return {
    projects: read.ok ? read.config.projects.map((project) => ({ key: project.key, repo: project.repo })) : [],
    // 本地 Markdown 后端没有远端坐标：正文里的裸 `#12` 就是同一份 `.deck` 里的票。
    currentRepo: backend.kind === "local" ? null : backend.key,
  };
}

/* ------------------------------------------------------------------ handlers */

type ToolHandler = (args: unknown, context: ToolContext) => Promise<ToolResult>;

async function runIssueList(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(listSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const type = input.type ?? "all";
  const state = input.state ?? "open";
  const limit = input.limit ?? 50;
  const wantedLabels = (input.labels ?? []).map((label) => label.trim().toLowerCase()).filter(Boolean);
  const wantedAssignee = (input.assignee ?? "").trim().toLowerCase();
  const wantedQuery = (input.query ?? "").trim().toLowerCase();
  // 判 spec 要读正文里的票面标记，按正文筛 query 也要正文；其余情况仍取薄行，不白花额度。
  const needsBody = type === "spec" || wantedQuery.length > 0;
  // 契约上限 200 条，由读层翻页凑够（GitHub 单次请求的 first 上限是 100，超了整条查询被拒）；
  // 仓库超过 200 票时靠 hasMore 如实说明还有没取到的。
  const read = await readBoard(context.workspaceDir, {
    limit: 200,
    includeClosed: state !== "open",
    view: state === "closed" ? "closed" : state === "all" ? "all" : "open",
    repoKey: input.repo,
    withBody: needsBody,
  });
  if (!read.ok) return failureOf(read);

  // 与 DSH rowKindOf 同口径：spec 头标记优先于 wayfinder:map 标签（containerKindOf 已按此算好），
  // 标签只在没读正文时作为地图的兜底。
  const kindOf = (issue: (typeof read.issues)[number]): "map" | "spec" | "issue" => {
    if (issue.containerKind) return issue.containerKind;
    if (issue.isMap) return "map";
    if (markerKindInHeader(issue.body) === "spec") return "spec";
    return "issue";
  };
  const filtered = sortIssues(read.issues.filter((issue) => issue.kind === "issue"))
    .filter((issue) => (state === "all" ? true : state === "open" ? issue.state === "OPEN" : issue.state === "CLOSED"))
    .filter((issue) => type === "all" || kindOf(issue) === type)
    .filter((issue) => wantedLabels.every((wanted) => issue.labels.some((label) => label.name.toLowerCase() === wanted)))
    .filter((issue) => !wantedAssignee || issue.assignees.some((assignee) => assignee.toLowerCase() === wantedAssignee))
    .filter((issue) => !wantedQuery || `${issue.title}\n${issue.body ?? ""}`.toLowerCase().includes(wantedQuery));
  const page = filtered.slice(0, limit);
  return ok({
    ok: true,
    repo: read.repo ? repoLabel(read.repo) : null,
    repos: read.repos.map((repo) => ({ repo: repo.key, dir: repo.dir, readOnly: repo.readOnly })),
    failures: read.failures,
    totalCount: filtered.length,
    boardCount: read.totalCount,
    returned: page.length,
    hasMore: read.hasMore || filtered.length > page.length,
    source: read.source,
    queryScope: wantedQuery ? "title+body" : null,
    issues: page.map((issue) => ({
      repo: issue.repoKey,
      key: String(issue.number),
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      isMap: issue.isMap,
      type: kindOf(issue),
      kind: issue.isMap ? "map" : "issue",
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees,
      readiness: issue.readiness,
      blockedBy: issue.blockedBy.map((blocker) => blocker.number),
      parentKey: issue.parentKey ?? null,
      updatedAt: issue.updatedAt,
    })),
  });
}

async function runMapSnapshot(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(mapSnapshotSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const number = parseKey(input.key);
  if (number === null) return fail("invalid", `key 不是合法票号：${String(input.key)}`);
  const read = await readIssue(context.workspaceDir, number, { repoKey: input.repo });
  if (!read.ok) return failureOf(read);
  const detail = read.result;
  if (!detail.ok) return failureOf(detail);

  // 子票按父子边取（DSH：list({parentKey}) + childrenOf），不再靠 wayfinder:<kind> 标签猜；
  // 要连已关闭的子票一起读，否则进度统计里的「已关闭」永远是 0。
  const board = await readBoard(context.workspaceDir, {
    limit: 200, includeClosed: true, view: "all", repoKey: read.repoKey,
  });
  if (!board.ok) return failureOf(board);
  // 只看这张地图所在仓库的票：多仓库里同号票不该被算进来。
  const sameRepo = board.issues.filter((issue) => issue.repoKey === read.repoKey);
  const picked = childrenOf(sameRepo, detail.issue.number);
  const detailMode = input.detail ?? "full";
  const notes: string[] = [];
  if (picked.note) notes.push(picked.note);
  if (board.hasMore) notes.push("子票清单只读到板子的前 200 张票（远端还有更多）：下面的进度只按手上这些票算，偏乐观。");

  // frontierOnly 与 DSH 同口径：未关闭、认领已知且为空、阻塞者都已完成；
  // 不在清单里的阻塞者按「未完成」处理，宁可说不可接，也不误报可接。
  const stateByKey = new Map(picked.children.map((issue) => [String(issue.number), issue.state] as const));
  const shown = input.frontierOnly === true
    ? picked.children.filter((issue) =>
        issue.state === "OPEN" &&
        issue.assignees.length === 0 &&
        issue.blockedBy.every((blocker) => stateByKey.get(String(blocker.number)) === "CLOSED"))
    : picked.children;
  if (input.frontierOnly === true) {
    notes.push(`已按 frontierOnly 只回可接的 ${shown.length} 张（总数 ${picked.children.length} 张）。`);
  }

  const children = await Promise.all(
    shown.map(async (item) => {
      const base = {
        key: String(item.number),
        number: item.number,
        title: item.title,
        state: item.state,
        kind: parentKindOf(item),
        readiness: item.readiness,
        labels: item.labels.map((label) => label.name),
        assignees: item.assignees,
        blockedBy: item.blockedBy.map((blocker) => blocker.number),
        updatedAt: item.updatedAt,
      };
      if (detailMode === "thin") return base;
      const child = await readIssue(context.workspaceDir, item.number, { repoKey: read.repoKey });
      if (!child.ok) return { ...base, bodyError: child.detail };
      if (!child.result.ok) return { ...base, bodyError: child.result.detail };
      const progress = parseProgressOf(child.result.issue.body);
      return {
        ...base,
        progress: progress ? progress.percent : null,
        progressDetail: progress,
        originalWords: parseOriginalWordsOf(child.result.issue.body),
      };
    }),
  );

  // 旧 deck_map 的读法继续可用（别名一个版本）：route 仍按 wayfinder:<kind> 标签整理给面板。
  const route = routeFromIssues(shown);
  const map = parseMapBody(detail.issue.body);
  const closed = picked.children.filter((item) => item.state === "CLOSED").length;
  return ok({
    ok: true,
    repo: repoLabel(read.repo),
    repoKey: read.repoKey,
    map: { key: String(detail.issue.number), number: detail.issue.number, title: detail.issue.title, state: detail.issue.state, url: detail.issue.url, ...map },
    children,
    route,
    progress: { total: picked.children.length, closed, open: picked.children.length - closed },
    detail: detailMode,
    frontierOnly: input.frontierOnly === true,
    childrenSource: picked.filtered ? "parent" : "all",
    notes,
    nextSteps: suggestNextSteps({ map, route }),
  });
}

/** 父票读回来的对象类型：契约类型优先，后端没给类型时退回票面标记。 */
function parentKindOf(issue: { isMap: boolean; body?: string }): "map" | "spec" | "issue" {
  if (issue.isMap) return "map";
  const marker = markerKindInHeader(issue.body ?? "");
  if (marker === "spec") return "spec";
  return "issue";
}

/** 建票回执里的短类型名：GitHub 写失败的原因码原样透出，认不出的归到 gh-failed。 */
function githubWriteReason(kind: string): string {
  if (kind === "invalid" || kind === "not-found" || kind === "gh-missing" || kind === "gh-unauth" || kind === "labels-truncated") return kind;
  return "gh-failed";
}

async function runIssueCreate(args: unknown, context: ToolContext): Promise<ToolResult> {
  const raw = isRecord(args) ? args : {};
  // 兼容旧调用：isMap:true 等价于 kind=map；都不给时落到 issue（DSH 契约要求必填，工具面也标了必填）。
  const kind = typeof raw.kind === "string" ? raw.kind : raw.isMap === true ? "map" : "issue";
  const inputResult = asInput(createSchema, { ...raw, kind });
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;

  // 本地 `.scratch` 的目录名：两个词互斥、只能是单段目录名；远端后端忽略。
  const scope = readMdScope(raw);
  if (!scope.ok) return fail("invalid", scope.message + "这张票没建。");

  // label 两种写法都认：工具面发的是 wayfinder:research，旧调用可能只给 research。
  const rawLabel = input.label ?? "";
  const fullLabel = rawLabel ? (rawLabel.startsWith("wayfinder:") ? rawLabel : `wayfinder:${rawLabel}`) : undefined;
  const argued = resolveCreateKind({
    kind,
    label: fullLabel,
    labels: input.labels,
    parentKey: input.parentKey,
  });
  if (!argued.ok) return fail("invalid", String(argued.problem) + "这张票没建。");
  const position = argued.kind as PositionKind;

  const backend = await resolveWritableBackend(context.workspaceDir, "create issue", input.repo);
  if (!backend.ok) return fail(backend.reason, backend.detail);

  /* ---------------- 项目 / 模块：依据 .paseo-deck.json，定位不上就拒绝 ---------------- */
  // 放在建票之前：area 写错时宁可一个字都不写，也别先建出一张挂错模块的票。
  const projectScope = await resolveIssueProjectScope({
    workspaceDir: context.workspaceDir,
    repoKey: backend.key,
    ...(input.project ? { projectKey: input.project } : {}),
    ...(input.area ? { area: input.area } : {}),
  });
  if (!projectScope.ok) return fail("invalid", `${projectScope.detail}这张票没建。`);

  /* ---------------- 父票：先核类型，再建票 ---------------- */
  const parentRaw = String(input.parentKey ?? "").trim();
  const containerParent = parentRaw === "00" || parentRaw === "0";
  let parentNumber: number | null = null;
  if (parentRaw && !containerParent) {
    parentNumber = parseKey(parentRaw);
    if (parentNumber === null) return fail("invalid", `parentKey 不是合法票号：${parentRaw}`);
  }
  let parentLinked = false;
  if (containerParent) {
    if (backend.kind !== "local") {
      return fail("invalid", "parentKey=00 是本地 Markdown 后端的容器编号；远端后端要填真实票号。这张票没建。");
    }
    const wanted = position === "spec-ticket" ? "spec" : position === "map-ticket" ? "map" : null;
    if (wanted) {
      const container = await readLocalContainer(backend.workspaceDir, wanted, scope.effortId || undefined);
      if (!container.ok) return failureOf(container);
    } else {
      // 普通票的父只能是地图或规格：00 号按场景先挑一个，挑不到再试另一个。
      const order: ("map" | "spec")[] = scope.scene === "feature" ? ["spec", "map"] : ["map", "spec"];
      let found = false;
      for (const candidate of order) {
        const container = await readLocalContainer(backend.workspaceDir, candidate, scope.effortId || undefined);
        if (container.ok) { found = true; break; }
      }
      if (!found) return fail("not-found", "父票 00 指本地容器，但 .scratch 里既没有 map.md 也没有 spec.md。这张票没建。");
    }
    parentLinked = true;
  } else if (parentNumber !== null) {
    const parent = await readOne(backend, parentNumber);
    if (!parent.ok) return failureOf(parent);
    const parentKind = parentKindOf(parent.issue);
    const rule = argued.parent;
    if (rule === "map" && parentKind !== "map") {
      return fail("invalid", `父票 #${parentNumber} 不是探索地图（读到的是 ${parentKind}）：地图工单的父必须是探索地图。这张票没建。`);
    }
    if (rule === "spec" && parentKind !== "spec") {
      return fail("invalid", `父票 #${parentNumber} 不是规格（读到的是 ${parentKind}）：实施票的父必须是规格。这张票没建。`);
    }
    if (rule === "optional" && parentKind !== "map" && parentKind !== "spec") {
      return fail("invalid", `父票 #${parentNumber} 不是探索地图或规格（读到的是 ${parentKind}）：普通票的父只能是这两种容器。这张票没建。`);
    }
    parentLinked = true;
  }

  /* ---------------- 正文：骨架 → 类型标记 → 原话 ---------------- */
  let body = ensureIssueBody(input.body ?? "", position).body;
  if (argued.marker) {
    const markerLine = markerLineFor(argued.marker);
    if (markerLine && markerKindAtStart(body) === null) body = markerLine + body;
  }
  let originalWordsAdded = false;
  if (input.originalWords) {
    const applied = appendOriginalWords(body, input.originalWords);
    body = applied.body;
    originalWordsAdded = applied.added;
  }
  if (!bodyWithinLimit(body)) return fail("invalid", "正文超过 60KB，拒绝建票；一个字节都没有写。");

  /* ---------------- 标签 / 阻塞边 / 指派 / 幂等锚 ---------------- */
  const ensured = ensureLabels(argued.labels, position, fullLabel);
  // 自动标签只增不删：手写与被类型要求的标签先来，area / role 补在后面，同名只留一份。
  const labels = mergeScopedLabels(ensured.labels, projectScope.scope.labels);
  // 阻塞边分两路：本仓库票号走原生依赖边，跨仓库引用只能写进正文隐藏区段
  // （远端没有跨仓库原生边）。任何一项写法不合法就整组拒绝：
  // 只写了一半的阻塞集合，会让人以为「后端改完前端才能动」已经记下了。
  const dependencies = resolveDependencyRefs(input.blockedBy ?? [], await dependencyScopeOf(context.workspaceDir, backend));
  if (!dependencies.ok) return fail("invalid", `${dependencies.detail}。这张票没建。`);
  const blockedNumbers = dependencies.local;
  const crossRefs = dependencies.cross;
  const blockedKeys = blockedNumbers.map(String);
  if (crossRefs.length > 0) {
    // 建票时正文已经定稿：跨仓库行随正文一起写出去，之后不必再补一次 PUT。
    const applied = upsertCrossRepoBlockedBy(body, crossRefs);
    body = applied.body;
    if (!bodyWithinLimit(body)) return fail("invalid", "正文超过 60KB，拒绝建票；一个字节都没有写。");
  }
  const assignees = (input.assignees ?? []).map((name) => name.trim()).filter(Boolean);

  let anchor: string | undefined = input.idempotencyKey;
  if (!anchor) {
    // `.deck` 没有锚存储：自动锚只对 `.scratch` 与远端生效，遇到 .deck 就不传（显式给了仍会如实报错）。
    if (backend.kind !== "local" || (await resolveLocalStore(context.workspaceDir)).primary.kind === "scratch") {
      anchor = anchorKeyFor({
        tool: "deck_issue_create",
        sessionId: process.env.PASEO_AGENT_ID,
        workspaceKey: context.workspaceDir,
        title: input.title,
        labels,
        now: Date.now(),
      });
    }
  }

  /* ---------------- 建票：三种后端各自的真实写入口 ---------------- */
  type Created = {
    number: number; url: string; labels: string[]; reused: boolean;
    labelsFailed?: boolean; labelError?: string; parentError?: string;
    assigneeError?: string; blockedByError?: string; path?: string;
    /** 这次真的写了哪些后续字段；复用已有票时一律 false，不能把「上次建好的」说成本次写入。 */
    parentApplied: boolean;
    assigneesApplied: boolean;
    blockedByApplied: boolean;
  };

  const localDir = backend.kind === "local" ? backend.workspaceDir : context.workspaceDir;
  const createLocal = async (): Promise<Created> => {
    const localKind = (position === "bug" ? "issue" : position) as "map" | "spec" | "issue" | "map-ticket" | "spec-ticket";
    const scene = position === "map" || position === "map-ticket" || scope.scene === "effort" ? "effort" : "feature";
    const result = await createLocalIssue(localDir, {
      title: input.title,
      body,
      labels,
      kind: localKind,
      ...(scope.effortId ? (scene === "effort" ? { effort: scope.effortId } : { feature: scope.effortId }) : {}),
      ...(parentRaw ? { parentKey: containerParent ? "00" : String(parentNumber) } : {}),
      ...(anchor ? { idempotencyKey: anchor } : {}),
      ...(assignees.length ? { assignees } : {}),
      ...(blockedNumbers.length ? { blockedBy: blockedNumbers } : {}),
    });
    if (!result.ok) throw result;
    // 幂等命中时本地后端只读旧票：父票 / 指派 / 阻塞边都没有重写。
    const reused = result.reused === true;
    return {
      number: result.number,
      url: result.url,
      labels: result.labels,
      reused,
      labelsFailed: result.labelsFailed,
      parentApplied: !reused && parentRaw !== "",
      assigneesApplied: !reused && assignees.length > 0,
      blockedByApplied: !reused && blockedNumbers.length > 0,
      ...(result.path ? { path: result.path } : {}),
    };
  };

  const createGitLab = async (): Promise<Created> => {
    if (backend.kind !== "gitlab") throw new Error("backend mismatch");
    const result = await createGitLabIssue(backend.ref.owner, backend.ref.name, {
      title: input.title,
      body,
      labels,
      ...(parentNumber !== null ? { parentKey: parentNumber } : {}),
      ...(anchor ? { idempotencyKey: anchor } : {}),
    });
    if (!result.ok) throw result;
    let assigneeError: string | undefined;
    if (assignees.length) {
      const assigned = await setGitLabAssignees(backend.ref.owner, backend.ref.name, result.number, assignees);
      if (!assigned.ok) assigneeError = assigned.detail;
    }
    let blockedByError: string | undefined;
    if (blockedKeys.length) {
      // 票已经建出来了：阻塞边失败只记在该字段里，不回滚建票，也不谎称整张票没建。
      const blocked = await setGitLabBlockedBy(backend.ref.owner, backend.ref.name, result.number, blockedNumbers);
      if (!blocked.ok) blockedByError = blocked.detail;
    }
    return {
      number: result.number,
      url: result.url,
      labels: result.labels,
      reused: result.reused,
      labelsFailed: result.labelsFailed,
      // 父票行只在新建时随正文一起写；指派与阻塞边在下面无论新建还是复用都会补。
      parentApplied: !result.reused && parentNumber !== null,
      assigneesApplied: assignees.length > 0 && assigneeError === undefined,
      blockedByApplied: blockedKeys.length > 0 && blockedByError === undefined,
      ...(assigneeError ? { assigneeError } : {}),
      ...(blockedByError ? { blockedByError } : {}),
    };
  };

  const createGitHub = async (): Promise<Created> => {
    if (backend.kind !== "github") throw new Error("backend mismatch");
    const ops = createGithubOperations();
    const result = await ops.issueCreate(
      { owner: backend.ref.owner, name: backend.ref.name },
      {
        title: input.title,
        body,
        type: argued.contractType,
        labels,
        ...(parentNumber !== null ? { parentKey: String(parentNumber) } : {}),
        ...(anchor ? { idempotencyKey: anchor } : {}),
        ...(assignees.length ? { assignees } : {}),
        ...(blockedKeys.length ? { blockedBy: blockedKeys } : {}),
      },
    );
    if (!result.ok) throw { ok: false as const, reason: githubWriteReason(result.kind), detail: result.message, maybeCreated: result.maybeCreated };
    const reused = result.data.deduplicated;
    return {
      number: result.data.issue.number,
      url: result.data.issue.url,
      labels: result.data.issue.labels.map((label) => label.name),
      reused,
      labelsFailed: Boolean(result.data.labelError),
      // GitHub 的幂等命中在建票函数里提前返回：标签、指派、父票、阻塞边都没有补写。
      parentApplied: !reused && parentNumber !== null && result.data.parentError === undefined,
      assigneesApplied: !reused && assignees.length > 0 && result.data.assigneeError === undefined,
      blockedByApplied: !reused && blockedKeys.length > 0 && result.data.blockedByError === undefined,
      ...(result.data.labelError ? { labelError: result.data.labelError } : {}),
      ...(result.data.parentError ? { parentError: result.data.parentError } : {}),
      ...(result.data.assigneeError ? { assigneeError: result.data.assigneeError } : {}),
      ...(result.data.blockedByError ? { blockedByError: result.data.blockedByError } : {}),
    };
  };

  let created: Created;
  try {
    created = backend.kind === "local" ? await createLocal() : backend.kind === "gitlab" ? await createGitLab() : await createGitHub();
  } catch (error) {
    const failure = error as { ok?: false; reason?: string; detail?: string; maybeCreated?: boolean };
    if (failure?.ok === false && typeof failure.reason === "string") {
      const detail = String(failure.detail ?? "");
      return fail(failure.reason, failure.maybeCreated ? `${detail}；请求可能已送达，先刷新任务板确认，别直接重建` : detail);
    }
    throw error;
  }

  return ok({
    ok: true,
    key: String(created.number),
    number: created.number,
    url: created.url,
    kind: position,
    labels: created.labels,
    labelsFailed: created.labelsFailed === true,
    reused: created.reused,
    /** 项目 / 模块定位结果：没对上项目时为 null（单项目工作区就是这样）。 */
    projectScope: projectScope.scope.project
      ? {
          project: projectScope.scope.project.key,
          area: projectScope.scope.area,
          autoLabels: projectScope.scope.labels,
          warnings: projectScope.scope.warnings,
        }
      : null,
    ...(created.path ? { path: created.path } : {}),
    parent:
      parentRaw === ""
        ? null
        : {
            key: containerParent ? "00" : String(parentNumber),
            linked: parentLinked && created.parentApplied,
            applied: created.parentApplied,
            ...(created.parentError
              ? { note: created.parentError }
              : created.reused && !created.parentApplied
                ? { note: `复用了已有票 #${created.number}，本次没有重写父票关系；linked / applied 只表示这次没写，不代表票上没有父票，请用 deck_issue_get 核实。` }
                : {}),
          },
    assignees: assignees.length
      ? {
          requested: assignees,
          applied: created.assigneesApplied,
          failed: created.assigneeError ?? null,
          ...(created.reused && !created.assigneesApplied
            ? { note: `复用了已有票 #${created.number}，本次没有重新指派。` }
            : {}),
        }
      : null,
    blockedBy: blockedKeys.length || crossRefs.length
      ? {
          requested: [...blockedKeys, ...crossRefs],
          /** 走原生依赖边的那部分（本仓库票号）。 */
          native: blockedKeys,
          /** 写进正文隐藏区段的那部分（`owner/repo#n`）。 */
          crossRepo: crossRefs,
          /** 原生依赖边那部分是否写入；跨仓库那部分看 crossRepoWritten。 */
          applied: created.blockedByApplied,
          failed: created.blockedByError ?? null,
          ...(crossRefs.length > 0 ? { crossRepoWritten: !created.reused } : {}),
          ...(created.reused
            ? { note: `复用了已有票 #${created.number}，本次没有重写阻塞边（跨仓库引用随正文在上一次写入时已经落好）。` }
            : {}),
        }
      : null,
    ...(created.labelError ? { labelError: created.labelError } : {}),
    originalWords: input.originalWords ? { appended: originalWordsAdded } : null,
  });
}

async function runIssuePatch(args: unknown, context: ToolContext): Promise<ToolResult> {
  const raw = isRecord(args) ? args : {};
  const key = raw.key ?? raw.number;
  const normalized: Record<string, unknown> = { ...raw };
  if (key !== undefined) normalized.key = String(key);
  if (raw.state === "closed" && raw.close === undefined) normalized.close = true;
  const inputResult = asInput(patchSchema, normalized);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const number = parseKey(input.key);
  if (number === null) return fail("invalid", `key 不是合法票号：${String(input.key)}`);

  const close = input.close === true || input.state === "closed";
  // 与 DSH 同口径：close:false / state:open 就是重开，不再要求人去后端点。
  const reopen = input.close === false || input.state === "open";
  if (close && reopen) return fail("invalid", "close 与 state 互相矛盾：要么关（close:true / state:closed），要么重开（close:false / state:open）。本次什么都没动。");
  if (input.closeReason !== undefined && !close) {
    return fail("invalid", "closeReason 只能和 close:true 一起用；本次什么都没做。");
  }
  const wantedAssignees = (input.assignees ?? []).map((name) => name.trim()).filter(Boolean);
  const addLabels = (input.addLabels ?? []).map((label) => label.trim()).filter(Boolean);
  const removeLabels = (input.removeLabels ?? []).map((label) => label.trim()).filter(Boolean);
  const hasLabels = addLabels.length > 0 || removeLabels.length > 0;
  const hasBodyEdit = input.body !== undefined || input.originalWords !== undefined || input.progress !== undefined;
  const hasBlockers = input.blockedBy !== undefined;
  const hasChanges =
    input.title !== undefined || hasBodyEdit || hasLabels || input.comment !== undefined || close || reopen ||
    input.assignees !== undefined || hasBlockers;
  if (!hasChanges) {
    return fail("invalid", "至少给一个要改的字段（title / body / comment / addLabels / removeLabels / assignees / blockedBy / progress / originalWords / close）。");
  }

  const backend = await resolveWritableBackend(context.workspaceDir, "patch issue", input.repo);
  if (!backend.ok) return fail(backend.reason, backend.detail);
  if (input.assignees !== undefined && backend.kind === "local") {
    return fail("unsupported", "本地 Markdown 后端没有登录账号，无法写认领人；请直接编辑票文件里的 assignees。本次什么都没动。");
  }
  // blockedBy 是整组替换，先把每一项归一：写不合法的一整组都不写（见 resolveDependencyRefs 的注释）。
  const dependencies = hasBlockers
    ? resolveDependencyRefs(input.blockedBy ?? [], await dependencyScopeOf(context.workspaceDir, backend))
    : null;
  if (dependencies && !dependencies.ok) return fail("invalid", `${dependencies.detail}。本次什么都没动。`);
  const nativeBlockers = dependencies && dependencies.ok ? dependencies.local.map(String) : [];
  const crossRefs = dependencies && dependencies.ok ? dependencies.cross : [];
  // 只有需要「现状」的字段才读票：标签要算全集、正文追加要拿旧正文、关票要确认是不是地图。
  // 只改标题 / 直接给新正文 / 只发评论时不多打一次读请求。
  const needCurrent = hasLabels || (hasBodyEdit && input.body === undefined) || close || (hasBlockers && input.body === undefined);
  type CurrentIssue = Extract<Awaited<ReturnType<typeof readOne>>, { ok: true }>;
  let current: CurrentIssue | null = null;
  if (needCurrent) {
    const read = await readOne(backend, number);
    if (!read.ok) return failureOf(read);
    current = read;
  }
  if (current && hasLabels && current.meta.labelsTruncated) {
    return fail(
      "labels-truncated",
      `#${number} 有 ${current.meta.labelCount} 个标签，但只读到 ${current.issue.labels.length} 个；整体替换会删掉没读到的标签。`,
    );
  }
  if (current && close && current.issue.isMap && !input.comment?.trim()) {
    return fail("invalid", `关闭地图 #${number} 必须在同一次调用里带 comment（收口核对结论）。`);
  }

  let body = input.body ?? current?.issue.body ?? "";
  let originalWordsAdded = false;
  if (input.originalWords) {
    const applied = appendOriginalWords(body, input.originalWords);
    body = applied.body;
    originalWordsAdded = applied.added;
  }
  if (input.progress) body = appendProgress(body, input.progress, new Date().toISOString());
  // 跨仓库引用只能落在正文隐藏区段。整组替换时「清空」也要写回，
  // 否则删掉一个跨仓库依赖之后，那一行还留在正文里。
  let blockBodyChanged = false;
  if (hasBlockers) {
    const applied = upsertCrossRepoBlockedBy(body, crossRefs);
    body = applied.body;
    blockBodyChanged = applied.changed;
  }
  if (!bodyWithinLimit(body)) return fail("invalid", "正文超过 60KB，拒绝写入；一个字节都没有动。");

  // 关票必须先留评论：评论失败时直接停，票不会被关掉。
  let commentBody = input.comment?.trim() ?? "";
  // GitHub 有独立的关闭原因（state_reason），不要再把它塞进评论；其余后端按 DSH 的降级写法落评论。
  const nativeReason = backend.kind === "github" && close ? (input.closeReason?.trim() ?? "") : "";
  if (nativeReason.length > 120) return fail("invalid", "GitHub 的关闭原因最多 120 个字符；本次什么都没动。");
  if (input.closeReason && close && !nativeReason) {
    commentBody = commentBody ? `${commentBody}\n\n关闭原因：${input.closeReason.trim()}` : input.closeReason.trim();
  }
  let posted: { ok: true; comment: unknown } | null = null;
  if (commentBody) {
    const comment = await writeComment(backend, number, commentBody);
    if (!comment.ok) return failureOf(comment);
    posted = comment;
  }

  const patch: { title?: string; body?: string; state?: "open" | "closed" } = {};
  if (input.title !== undefined) patch.title = input.title;
  if (hasBodyEdit || blockBodyChanged) patch.body = body;
  // GitHub 的关/开走独立操作（关可以带原生原因）；其余后端仍由 patch 一次写状态。
  if ((close || reopen) && backend.kind !== "github") patch.state = close ? "closed" : "open";
  let patched: { title: string; body: string; state: "OPEN" | "CLOSED" } | null = null;
  if (Object.keys(patch).length > 0) {
    const written = await writePatch(backend, number, patch);
    if (!written.ok) return fail(written.reason, `${written.detail}${posted ? "（评论已发）" : ""}`);
    patched = written;
  }
  let stateResult: "OPEN" | "CLOSED" | null = patched?.state ?? null;
  if (backend.kind === "github" && (close || reopen)) {
    const ops = createGithubOperations();
    const repoRef = { owner: backend.ref.owner, name: backend.ref.name };
    const written = close
      ? await ops.issueClose(repoRef, String(number), nativeReason ? { reason: nativeReason } : undefined)
      : await ops.issueReopen(repoRef, String(number));
    if (!written.ok) return fail(githubWriteReason(written.kind), `${written.message}${posted ? "（评论已发）" : ""}`);
    stateResult = written.data.state;
  }

  let labels: string[] | null = null;
  let labelsFailure: string | null = null;
  if (hasLabels) {
    if (!current) return fail("invalid", `读不到 #${number} 的现有标签，拒绝整体替换。`);
    const next = new Set(current.issue.labels.map((label) => label.name));
    for (const label of addLabels) next.add(label);
    for (const label of removeLabels) next.delete(label);
    const replaced = await writeLabels(backend, number, [...next]);
    if (replaced.ok) labels = replaced.labels.map((label) => label.name);
    else if (!patched && !posted) return failureOf(replaced);
    else labelsFailure = replaced.detail;
  }

  // assignees 是整组替换（空数组 = 全部撤掉），与 DSH 的 issueAssigneesSet 同口径。
  let assignees: string[] | null = null;
  let assigneesFailure: string | null = null;
  if (input.assignees !== undefined) {
    if (backend.kind === "github") {
      const replaced = await createGithubOperations().issueAssigneesSet(
        { owner: backend.ref.owner, name: backend.ref.name },
        String(number),
        wantedAssignees,
      );
      if (replaced.ok) assignees = replaced.data.assignees;
      else if (!patched && !posted && labels === null) return fail(githubWriteReason(replaced.kind), replaced.message);
      else assigneesFailure = replaced.message;
    } else if (backend.kind === "gitlab") {
      const replaced = await setGitLabAssignees(backend.ref.owner, backend.ref.name, number, wantedAssignees);
      if (replaced.ok) assignees = replaced.assignees;
      else if (!patched && !posted && labels === null) return failureOf(replaced);
      else assigneesFailure = replaced.detail;
    }
  }

  // 原生阻塞边放在正文之后写：GitLab 回退到正文行时要读到刚写好的隐藏区段才能保留它。
  let blockedBy: string[] | null = null;
  let blockedByFailure: string | null = null;
  if (hasBlockers) {
    const evidence = await writeBlockedEdges(backend, String(number), nativeBlockers);
    const text = evidence.text ?? "阻塞边没写成，后端也没说明原因";
    if (evidence.ok) blockedBy = [...nativeBlockers, ...crossRefs];
    else if (!patched && !posted && labels === null && assignees === null) return fail("unsupported", text);
    else blockedByFailure = text;
  }

  return ok({
    ok: true,
    key: String(number),
    number,
    title: patched?.title,
    body: patched?.body,
    state: stateResult ?? undefined,
    labels,
    labelsFailed: labelsFailure !== null,
    labelsFailure,
    assignees,
    assigneesFailed: assigneesFailure !== null,
    assigneesFailure,
    ...(hasBlockers ? { blockedBy, blockedByFailed: blockedByFailure !== null, blockedByFailure } : {}),
    commented: posted !== null,
    comment: posted?.comment,
    partial: labelsFailure !== null || assigneesFailure !== null || blockedByFailure !== null,
    originalWords: input.originalWords ? { appended: originalWordsAdded } : null,
  });
}

async function runIssueReport(args: unknown, context: ToolContext): Promise<ToolResult> {
  const raw = isRecord(args) ? args : {};
  if (Object.prototype.hasOwnProperty.call(raw, "progress")) {
    return fail(
      "invalid",
      "progress 参数已退役：上报只表达「在办 / 办完」，进度请写到票面——用 deck_issue_patch 的 progress 传 { percent, note }。本次什么都没做。",
    );
  }
  const inputResult = asInput(reportSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const number = parseKey(input.key);
  if (number === null) return fail("invalid", `key 不是合法票号：${String(input.key)}`);

  // 台账只记「谁在做什么」，票面事实仍以远端为准：先读一次拿到标题与链接。
  const read = await readIssue(context.workspaceDir, number, { repoKey: input.repo });
  if (!read.ok) return fail(read.reason, read.detail);
  if (!read.result.ok) return failureOf(read.result);
  const issue = read.result.issue;
  const ticketKey = ticketKeyOf(read.repoKey, number);
  const at = new Date().toISOString();
  const note = input.note?.trim() || undefined;
  const detail = input.workRouteDetail ?? "core";
  const agentId = process.env.PASEO_AGENT_ID?.trim() || null;
  const ticket = { repoKey: read.repoKey, number, title: issue.title, url: issue.url };

  const updated = await updateWorkRouteLedger(
    (ledger) => {
      if (input.release === true) {
        return applyWorkRouteEvent(ledger, { kind: "release", ticketKey, at, ...(note ? { note } : {}) });
      }
      // DSH 语义：report = 这张票归当前会话在办。台账里还没有就先 attach，
      // 否则 progress 会被「未知票不凭空造记录」的规则静默丢弃。
      const attached = applyWorkRouteEvent(ledger, { kind: "attach", ticket, agentId, at, ...(note ? { note } : {}) });
      return applyWorkRouteEvent(attached, { kind: "progress", ticketKey, at, ...(note ? { note } : {}) });
    },
    { cwd: context.workspaceDir },
  );
  if (!updated.ok) return fail(updated.reason, updated.detail);

  const entry = updated.ledger.entries.find((item) => item.ticketKey === ticketKey);
  const summary = summarizeWorkRoute(updated.ledger);
  const rows = detail === "core" ? updated.ledger.entries.slice(0, 20) : updated.ledger.entries;
  return ok({
    ok: true,
    action: input.release === true ? "released" : "reported",
    ticket: { key: ticketKey, status: entry?.status ?? null, changed: entry !== undefined },
    workRoute: {
      detail,
      current: summary.currentTicketKey,
      active: summary.active,
      total: summary.total,
      rows: rows.map((row) => ({
        key: row.ticketKey,
        status: row.status,
        agentId: row.agentId,
        updatedAt: row.updatedAt,
        ...(detail === "standard" ? { title: row.title, note: row.note } : {}),
      })),
      truncated: rows.length < updated.ledger.entries.length,
    },
  });
}

async function runIssueGet(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(numberSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const read = await readIssue(context.workspaceDir, input.number, { repoKey: input.repo });
  if (!read.ok) return fail(read.reason, read.detail);
  const detail = read.result;
  if (!detail.ok) return failureOf(detail);
  return ok({
    ok: true,
    repo: repoLabel(read.repo),
    repoKey: read.repoKey,
    issue: {
      number: detail.issue.number,
      title: detail.issue.title,
      state: detail.issue.state,
      url: detail.issue.url,
      body: detail.issue.body,
      labels: detail.issue.labels.map((label) => label.name),
      labelCount: detail.meta.labelCount,
      labelsTruncated: detail.meta.labelsTruncated,
      assignees: detail.issue.assignees,
      isMap: detail.issue.isMap,
      containerKind: detail.issue.containerKind ?? null,
      parentKey: detail.issue.parentKey ?? null,
      progress: parseProgressOf(detail.issue.body),
      originalWords: parseOriginalWordsOf(detail.issue.body),
    },
    relations: {
      parent: detail.parent ?? null,
      children: detail.children ?? [],
      childrenTotal: detail.childrenTotal ?? detail.children?.length ?? 0,
      blockedBy: detail.issue.blockedBy,
      blocking: detail.blocking ?? [],
      blockingTruncated: detail.blockingTruncated ?? false,
    },
    comments: detail.comments,
    commentCount: detail.meta.commentCount,
    commentsTruncated: detail.meta.commentsTruncated,
  });
}

async function runIssueComment(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(commentSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const backend = await resolveWritableBackend(context.workspaceDir, "comment", input.repo);
  if (!backend.ok) return fail(backend.reason, backend.detail);
  const written = await writeComment(backend, input.number, input.body);
  if (!written.ok) return failureOf(written);
  return ok({ ok: true, number: input.number, comment: written.comment });
}

async function runIssueLabels(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(labelsSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const backend = await resolveWritableBackend(context.workspaceDir, "labels", input.repo);
  if (!backend.ok) return fail(backend.reason, backend.detail);
  // GitHub 的 PUT 是整体替换：读不全现有标签就拒绝。守卫放在领域层（面板 RPC 同一条），
  // 宁可拒绝并让人去远端改，也不做一次「成功」的静默数据丢失。本地文件没有截断问题。
  if (backend.kind === "github") {
    const guard = await assertLabelsReadable(backend.ref.owner, backend.ref.name, input.number);
    if (!guard.ok) return fail(guard.reason, guard.detail);
  }
  const replaced = await writeLabels(backend, input.number, input.labels);
  if (!replaced.ok) return failureOf(replaced);
  return ok({ ok: true, number: input.number, labels: replaced.labels.map((label) => label.name) });
}

async function runPullRequestsList(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(pullListSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const backend = await resolveBackend(context.workspaceDir, "pull requests", input.repo);
  if (!backend.ok) return fail(backend.reason, backend.detail);
  if (backend.kind !== "github") {
    return fail("unsupported-host", `Pull requests are only available on the GitHub backend; this workspace uses ${backend.kind}`);
  }
  const state = input.state ?? "open";
  const view = state === "merged" ? "merged" : state === "closed" ? "closed" : state === "all" ? "all" : "open";
  const listed = await listIssues(backend.ref.owner, backend.ref.name, {
    limit: input.limit ?? 100,
    includeClosed: state !== "open",
    view,
  });
  if (!listed.ok) return failureOf(listed);
  const pullRequests = listed.issues.filter((item) => {
    if (item.kind !== "pull-request") return false;
    if (state === "open") return item.state === "OPEN";
    if (state === "merged") return item.merged;
    if (state === "closed") return item.state === "CLOSED" && !item.merged;
    return true;
  });
  return ok({
    ok: true,
    repo: repoLabel(backend.repo),
    returned: pullRequests.length,
    hasMore: listed.hasMore,
    source: listed.source,
    pullRequests: pullRequests.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      merged: item.merged,
      url: item.url,
      labels: item.labels.map((label) => label.name),
    })),
  });
}

/** 一条边作业：顶层 key 归一成单项，或 edges 里的原样一项。 */
interface LinkJob {
  rawKey: string;
  key: string | null;
  parent?: string;
  blockedBy?: string[];
}

interface LinkItem {
  key: string;
  role: "edge";
  op: "parent" | "block";
  target: string;
  status: "ok" | "failed";
  ok: boolean;
  landing: string;
  evidence: string;
  [extra: string]: unknown;
}

/** 票号归一：`#12` / `12` 都收成正整数串；不是票号的返回 null，由调用方逐条报失败。 */
function edgeKeyOf(value: unknown): string | null {
  const text = String(value ?? "").trim().replace(/^#/, "");
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? String(number) : null;
}

const edgeItem = (op: "parent" | "block", key: string, target: string, evidence: EdgeEvidence): LinkItem => {
  const ok = evidence.ok !== false;
  const text = evidence.text || (evidence.kind === "unsupported" ? "后端原话：做不到" : "这次没有拿到能判落点的证据");
  return {
    key, role: "edge", op, target,
    status: ok ? "ok" : "failed",
    ok,
    landing: landingOf(op, evidence),
    evidence: text,
  };
};

/** 写一条父子边，返回写后读回的证据档次。每个后端都在自己的写入口里做写后读回。 */
async function writeParentEdge(backend: WritableBackend, key: string, parent: string): Promise<EdgeEvidence> {
  if (backend.kind === "github") {
    const result = await createGithubOperations().issueParentSet(
      { owner: backend.ref.owner, name: backend.ref.name }, key, parent,
    );
    if (!result.ok) return { kind: "unsupported", ok: false, text: `写这一步就没成：要把 #${parent} 写成票 #${key} 的父票（${result.message}）` };
    return { kind: "native", ok: true, text: `写后读回：票 #${key} 的父票是 #${parent}（GitHub sub-issue 原生层级）` };
  }
  if (backend.kind === "gitlab") {
    const result = await setGitLabParent(backend.ref.owner, backend.ref.name, Number(key), Number(parent));
    if (!result.ok) return { kind: "unsupported", ok: false, text: `写这一步就没成：要把 #${parent} 写成票 #${key} 的父票（${result.detail}）` };
    return { kind: "body-line", ok: true, text: `写后读回：票 #${key} 的父票是 #${parent}（写在正文的 Part of 行里）` };
  }
  const result = await setLocalParent(backend.workspaceDir, Number(key), parent);
  if (!result.ok) return { kind: "unsupported", ok: false, text: `写这一步就没成：要把 #${parent} 写成票 #${key} 的父票（${result.detail}）` };
  return result.layout === "scratch"
    ? { kind: "file-note", ok: true, text: `写后读回：票 #${key} 的父票是 #${parent}（写在票文件的 DSH-PARENT 注释里）` }
    : { kind: "file-note", ok: true, text: `写后读回：票 #${key} 的父票是 #${parent}（写在 .deck 票面的 parentKey 字段里）` };
}

/** 写一张票的整组阻塞边，返回写后读回的证据档次。 */
async function writeBlockedEdges(backend: WritableBackend, key: string, blockers: readonly string[]): Promise<EdgeEvidence> {
  if (backend.kind === "github") {
    const result = await createGithubOperations().issueBlockedBySet(
      { owner: backend.ref.owner, name: backend.ref.name }, key, blockers,
    );
    if (!result.ok) return { kind: "unsupported", ok: false, text: `写这一步就没成：要把 ${blockers.map((item) => "#" + item).join("、")} 加进票 #${key} 的 blockedBy（${result.message}）` };
    return { kind: "native", ok: true, text: `写后读回：票 #${key} 的 blockedBy 是 ${result.data.blockedBy.map((item) => "#" + item.number).join("、") || "空"}（GitHub 原生依赖边）` };
  }
  if (backend.kind === "gitlab") {
    const result = await setGitLabBlockedBy(backend.ref.owner, backend.ref.name, Number(key), blockers.map(Number));
    if (!result.ok) return { kind: "unsupported", ok: false, text: `写这一步就没成：要把 ${blockers.map((item) => "#" + item).join("、")} 加进票 #${key} 的 blockedBy（${result.detail}）` };
    return result.source === "native"
      ? { kind: "native", ok: true, text: `写后读回：票 #${key} 的 blockedBy 已写成（GitLab 原生依赖边）` }
      : { kind: "body-line", ok: true, text: `写后读回：票 #${key} 的 blockedBy 已写成（写在正文的 Blocked by 行里）` };
  }
  const result = await setLocalBlockedBy(backend.workspaceDir, Number(key), blockers.map(Number));
  if (!result.ok) return { kind: "unsupported", ok: false, text: `写这一步就没成：要把 ${blockers.map((item) => "#" + item).join("、")} 加进票 #${key} 的 blockedBy（${result.detail}）` };
  return result.layout === "scratch"
    ? { kind: "body-line", ok: true, text: `写后读回：票 #${key} 的 blockedBy 是 ${result.blockedBy.map((item) => "#" + item).join("、") || "空"}（写在 Blocked by 行里）` }
    : { kind: "file-note", ok: true, text: `写后读回：票 #${key} 的 blockedBy 是 ${result.blockedBy.map((item) => "#" + item).join("、") || "空"}（写在 .deck 票面的 blockedBy 字段里）` };
}

/**
 * 给已有票补边或改边：父子 + 阻塞。
 *
 * 写前整批成环预检、写后逐条读回并标出落点；同一张票的封锁边合并成完整集合后只写一次
 * （整批替换语义），父子边与阻塞边互不拖累：一条失败，另一条照做。
 */
async function runMapLink(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(mapLinkSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const backend = await resolveWritableBackend(context.workspaceDir, "add issue edges", input.repo);
  if (!backend.ok) return fail(backend.reason, backend.detail);

  const rawJobs: Record<string, unknown>[] = input.edges?.length
    ? input.edges.map((edge) => ({ ...edge }))
    : input.key !== undefined
      ? [{ key: input.key, ...(input.parentKey !== undefined ? { parentKey: input.parentKey } : {}), ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}) }]
      : [];

  const items: LinkItem[] = [];
  const notes: string[] = [];
  const jobs: LinkJob[] = [];
  for (const raw of rawJobs) {
    const rawKey = String(raw.key ?? "").trim();
    const key = edgeKeyOf(rawKey);
    const parentRaw = raw.parentKey === undefined ? undefined : String(raw.parentKey).trim().replace(/^#/, "");
    const parent = parentRaw === "" ? undefined : parentRaw;
    if (key === null) {
      items.push(edgeItem("parent", rawKey, parent ?? "", { kind: "missing", ok: false, text: `key 不是合法票号：${rawKey || "(空)"}` }));
      continue;
    }
    if (parent !== undefined && !/^\d+$/.test(parent)) {
      items.push(edgeItem("parent", key, parent, { kind: "missing", ok: false, text: `parentKey 不是合法票号：${parent}` }));
    }
    const blockers = Array.isArray(raw.blockedBy)
      ? raw.blockedBy.map((value) => edgeKeyOf(value))
      : undefined;
    // 有一项不是票号就整组不写：不能拿「过滤掉的空表」当成 blockedBy:[] 去清空原有边。
    const blockersValid = blockers !== undefined && !blockers.some((value) => value === null);
    if (blockers !== undefined && !blockersValid) {
      items.push(edgeItem("block", key, "", { kind: "missing", ok: false, text: "blockedBy 里有不是票号的项：这一组阻塞边没有写入" }));
    }
    jobs.push({
      rawKey,
      key,
      ...(parent !== undefined && /^\d+$/.test(parent) ? { parent } : {}),
      ...(blockersValid ? { blockedBy: blockers.filter((value): value is string => value !== null) } : {}),
    });
  }

  // 同一张票的阻塞边：整批替换语义，先把本次所有出现合并成完整集合，否则后一次写会删掉前一次。
  const mergedBlocked = new Map<string, string[]>();
  const keyOrder: string[] = [];
  const jobsByKey = new Map<string, LinkJob[]>();
  for (const job of jobs) {
    if (job.key === null) continue;
    if (!jobsByKey.has(job.key)) {
      jobsByKey.set(job.key, []);
      keyOrder.push(job.key);
    }
    jobsByKey.get(job.key)?.push(job);
    if (job.blockedBy === undefined) continue;
    if (!mergedBlocked.has(job.key)) mergedBlocked.set(job.key, []);
    const bucket = mergedBlocked.get(job.key) ?? [];
    for (const target of job.blockedBy) if (!bucket.includes(target)) bucket.push(target);
  }

  // 自环与整批成环预检：写任何一条边之前先做，被拒的票只跳过阻塞边，父子边照旧做。
  const refused = new Map<string, string>();
  for (const [key, blockers] of mergedBlocked) {
    if (blockers.includes(key)) refused.set(key, `一张票不能阻塞自己（#${key}）；这一组阻塞边没有写入。`);
  }
  if (mergedBlocked.size > 0) {
    const board = await readBoard(context.workspaceDir, {
      limit: 200, includeClosed: true, view: "all", repoKey: backend.key,
    });
    if (!board.ok) {
      notes.push(`写前成环预检没读到整图（${board.detail}），成环检查只有每个后端写入时自己那一份：同批互指的边仍可能都通过。`);
    } else {
      const graph = new Map<string, string[]>();
      for (const issue of board.issues) graph.set(String(issue.number), issue.blockedBy.map((blocker) => String(blocker.number)));
      const verdict = refuseCyclicBlockBatch({
        graph,
        keyOrder,
        blockedBy: mergedBlocked,
      });
      for (const [key, reason] of verdict) if (!refused.has(key)) refused.set(key, reason);
      if (board.hasMore) notes.push("写前成环预检只读到板子的第一页（远端还有更多票）：同批边与未读到的票之间是否成环，这次判不了。");
    }
  }

  const touched: string[] = [];
  let done = 0;
  const blockedOutcome = new Map<string, EdgeEvidence>();

  for (const key of keyOrder) {
    const group = jobsByKey.get(key) ?? [];
    for (const job of group) {
      if (job.parent !== undefined) {
        const evidence = await writeParentEdge(backend, key, job.parent);
        const item = edgeItem("parent", key, job.parent, evidence);
        items.push(item);
        if (item.ok) {
          done += 1;
          if (!touched.includes(key)) touched.push(key);
        }
      }
      if (job.blockedBy === undefined) continue;
      const refusedReason = refused.get(key);
      if (refusedReason !== undefined) {
        for (const target of job.blockedBy) {
          items.push(edgeItem("block", key, target, { kind: "missing", ok: false, text: refusedReason }));
        }
        continue;
      }
      let outcome = blockedOutcome.get(key);
      if (outcome === undefined) {
        outcome = await writeBlockedEdges(backend, key, mergedBlocked.get(key) ?? []);
        blockedOutcome.set(key, outcome);
      }
      // 这一张票的整组边已经按合并后的完整集合写过一次；同一批里重复出现的项按同一结果补明细。
      for (const target of job.blockedBy) {
        const evidence: EdgeEvidence = outcome.ok === false
          ? outcome
          : { ...outcome, text: outcome.text ?? "" };
        const item = edgeItem("block", key, target, evidence);
        items.push(item);
        if (item.ok) {
          done += 1;
          if (!touched.includes(key)) touched.push(key);
        }
      }
    }
  }

  const status = statusOfItems(items);
  if (status !== "ok") notes.push("有几条边没建成，逐条原因在上面的 items 里：别把它们当成已经建好。");
  const failed = items.filter((item) => !item.ok);
  let text = `这次要补 ${items.length} 条边，建成 ${done} 条。`;
  if (failed.length > 0) {
    const reasons = failed.slice(0, 20).map((item) => `${item.key}→${item.target || "?"}：${item.evidence.slice(0, 120)}`);
    text += `失败 ${failed.length} 条：${reasons.join("；")}`;
  }
  return {
    text: JSON.stringify({
      ok: status === "ok",
      status,
      tool: "deck_map_link",
      reason: status === "ok" ? "" : "backend-unsupported",
      workRouteDetail: input.workRouteDetail ?? null,
      text,
      data: { requested: items.length, done, jobs: rawJobs },
      items,
      notes,
      touched,
    }, null, 2),
    isError: status !== "ok",
  };
}

async function runMapPlanCreate(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(mapPlanSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const backend = await resolveWritableBackend(context.workspaceDir, "create map plan", input.repo);
  if (!backend.ok) return fail(backend.reason, backend.detail);

  // 有 v2 清单且对得上项目时，正文按该项目的 areas 生成骨架；没有清单时与以前完全一致。
  const mapProject = await resolveMapProject({
    workspaceDir: context.workspaceDir,
    repoKey: backend.key,
    ...(input.project ? { projectKey: input.project } : {}),
  });
  if (!mapProject.ok) return fail("invalid", `${mapProject.detail}这张图没建。`);

  const plainBody = ensureIssueBody(mapPlanBody({
    destination: input.destination,
    notes: input.notes,
    decisions: input.decisions,
    fog: input.fog,
    outOfScope: input.outOfScope,
    project: mapProject.project,
  }), "map").body;
  // 来源边写进正文而不是新建字段：GitHub 没有「衍生自」这种原生关系，正文固定行是这套
  // 仓库已有的做法（跨仓库依赖就是 `Blocked by:`）。建票时一起带上，省一次改正文。
  const sourceNumber = input.sourceIssue === undefined
    ? null
    : typeof input.sourceIssue === "number"
      ? input.sourceIssue
      : Number(input.sourceIssue.replace(/^#/, ""));
  const body = sourceNumber === null ? plainBody : withDerivedFrom(plainBody, sourceNumber);
  const now = Date.now();
  const localScratch = backend.kind === "local" && (await resolveLocalStore(context.workspaceDir)).primary.kind === "scratch";

  type PlanCreated = { ok: true; number: number; url: string; labels: string[]; labelsFailed: boolean; path?: string; reused?: boolean } | { ok: false; reason: string; detail: string };
  type PlaneFactory = (title: string, planBody: string, labels: string[], parentKey: number | null, anchor: string, containerName?: string) => Promise<PlanCreated>;

  // 三种后端各走各自的真实建票入口：GitHub 的父子边是原生 sub-issue，GitLab 落正文 Part of 行，
  // 本地 `.scratch` 落文件头 Parent；`.deck` 没有父子字段，沿用正文指针。
  const create: PlaneFactory = async (title, planBody, labels, parentKey, anchor, containerName) => {
    if (backend.kind === "github") {
      const ops = createGithubOperations();
      const result = await ops.issueCreate(
        { owner: backend.ref.owner, name: backend.ref.name },
        {
          title,
          body: planBody,
          type: labels.includes(MAP_LABEL) ? "map" : "issue",
          labels,
          ...(parentKey !== null ? { parentKey: String(parentKey) } : {}),
          idempotencyKey: anchor,
        },
      );
      if (!result.ok) return { ok: false, reason: githubWriteReason(result.kind), detail: result.message };
      return {
        ok: true,
        number: result.data.issue.number,
        url: result.data.issue.url,
        labels: result.data.issue.labels.map((label) => label.name),
        labelsFailed: Boolean(result.data.labelError),
      };
    }
    if (backend.kind === "gitlab") {
      const result = await createGitLabIssue(backend.ref.owner, backend.ref.name, {
        title,
        body: planBody,
        labels,
        ...(parentKey !== null ? { parentKey } : {}),
        idempotencyKey: anchor,
      });
      if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
      return { ok: true, number: result.number, url: result.url, labels: result.labels, labelsFailed: result.labelsFailed, reused: result.reused };
    }
    if (localScratch) {
      const kind = labels.includes(MAP_LABEL) ? "map" as const : "map-ticket" as const;
      const result = await createLocalIssue(backend.workspaceDir, {
        title,
        body: planBody,
        labels,
        kind,
        ...(parentKey !== null ? { parentKey: "00" } : {}),
        ...(containerName ? { effort: containerName } : {}),
        idempotencyKey: anchor,
      });
      if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
      return { ok: true, number: result.number, url: result.url, labels: result.labels, labelsFailed: result.labelsFailed, ...(result.path ? { path: result.path } : {}), reused: result.reused === true };
    }
    // `.deck`：地图是带 wayfinder:map 的普通票，子票用正文指针（与旧行为一致）。
    if (backend.kind !== "local") return { ok: false, reason: "unsupported-host", detail: "不认识的建票后端" };
    const result = await writeIssue(backend, { title, body: planBody, labels });
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
    return { ok: true, number: result.number, url: result.url, labels: result.labels, labelsFailed: result.labelsFailed };
  };

  const map = await create(
    input.title,
    body,
    [MAP_LABEL],
    null,
    anchorKeyFor({ tool: "deck_map_plan_create", sessionId: process.env.PASEO_AGENT_ID, workspaceKey: context.workspaceDir, title: input.title, labels: [MAP_LABEL], now }),
  );
  if (!map.ok) return failureOf(map);
  const container = map.path ? path.basename(path.dirname(map.path)) : "";

  const tickets: { number?: number; title: string; kind: string; url?: string; labelsFailed?: boolean; error?: string }[] = [];
  for (const [index, ticket] of input.tickets.entries()) {
    const labels = [`wayfinder:${ticket.kind}`];
    // 本地 `.scratch` 的文件头有 Parent 字段；其余后端在正文首行留一条人能读的指针
    // （GitLab 会把它规范成同一行，GitHub 另外还有原生 sub-issue 边）。
    const pointer = backend.kind === "gitlab" ? `Part of #${map.number}` : `Part of map #${map.number}.`;
    const ticketBody = localScratch
      ? ensureIssueBody(ticket.body?.trim() ?? "", "map-ticket").body
      : [pointer, "", ensureIssueBody(ticket.body?.trim() ?? "", "map-ticket").body].join("\n");
    const created = await create(
      ticket.title,
      ticketBody,
      labels,
      localScratch ? 0 : map.number,
      anchorKeyFor({ tool: "deck_map_plan_create", sessionId: process.env.PASEO_AGENT_ID, workspaceKey: context.workspaceDir, title: `${input.title}|${index}|${ticket.title}`, labels, now }),
      localScratch ? container : undefined,
    );
    if (!created.ok) {
      tickets.push({ title: ticket.title, kind: ticket.kind, error: created.detail });
      continue;
    }
    tickets.push({
      number: created.number,
      title: ticket.title,
      kind: ticket.kind,
      url: created.url,
      labelsFailed: created.labelsFailed,
    });
  }
  // 需求票那边没有可写的反向边，评论是唯一跨票可见的痕迹；写不成不算建图失败，
  // 但要在结果里说出来——静默吞掉会让人以为「链接上了」。
  const sourceComment = sourceNumber === null
    ? null
    : await writeComment(
        backend,
        sourceNumber,
        `从这张需求建了地图 #${map.number}（来源写在地图正文的 \`Derived from: #${sourceNumber}\` 一行里）。`,
      ).then((written) => (written.ok ? { ok: true } : { ok: false, detail: written.detail }));

  return ok({
    ok: true,
    map: { number: map.number, url: map.url, labelsFailed: map.labelsFailed },
    ...(sourceNumber === null ? {} : { sourceIssue: sourceNumber, sourceComment }),
    /** 正文按哪个项目的 areas 分组；没有 v2 清单、也没指定项目时为 null（正文是原来的写法）。 */
    project: mapProject.project ? { key: mapProject.project.key, areas: mapProject.project.areas } : null,
    tickets,
    failed: tickets.filter((ticket) => ticket.error).length,
  });
}

async function runNextSteps(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(numberSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const read = await readIssue(context.workspaceDir, input.number, { repoKey: input.repo });
  if (!read.ok) return fail(read.reason, read.detail);
  const detail = read.result;
  if (!detail.ok) return failureOf(detail);
  const board = await readBoard(context.workspaceDir, { limit: 100, repoKey: read.repoKey });
  if (!board.ok) return fail(board.reason, board.detail);
  const map = parseMapBody(detail.issue.body);
  const route = routeFromIssues(board.issues);
  const steps = suggestNextSteps({ map, route });
  return ok({ ok: true, nextSteps: steps, openRoute: route.filter((item) => item.state === "OPEN").length });
}

async function runProbe(_args: unknown, context: ToolContext): Promise<ToolResult> {
  const targets = await resolveWorkspaceTargets(context.workspaceDir);
  const status = await readStatus();
  let counts: ReturnType<typeof countBoard> | null = null;
  let maps: { number: number; title: string }[] = [];
  let repo: { host: string; owner: string; name: string } | null = null;
  let repoProblem: string | null = targets.ok ? null : targets.detail;
  const repos =
    targets.ok && targets.kind === "repos"
      ? targets.targets.map((target) => ({ repo: target.key, dir: target.dir, readOnly: target.readOnly }))
      : [];
  if (targets.ok) {
    const single =
      targets.kind === "local"
        ? targets.repo
        : targets.targets.length === 1 && targets.targets[0]
          ? repoOf(targets.targets[0])
          : null;
    repo = single ? { host: single.host, owner: single.owner, name: single.name } : null;
    const board = await readBoard(context.workspaceDir, { limit: 100 });
    if (board.ok) {
      const issues = board.issues.filter((item) => item.kind === "issue");
      counts = countBoard(issues);
      maps = issues.filter((item) => item.isMap).map((item) => ({ number: item.number, title: item.title }));
      if (board.failures.length > 0) {
        repoProblem = board.failures.map((failure) => `${failure.repoKey}：${failure.detail}`).join("；");
      }
    } else {
      repoProblem = board.detail;
    }
  }
  // 目标解析失败时不能假装后端是 local：读写路径都会按这次失败返回，
  // 报一个「实际用不上」的后端只会把排查方向带偏。
  const hosts = targets.ok && targets.kind === "repos" ? new Set(targets.targets.map((target) => target.host)) : null;
  const backend = targets.ok
    ? targets.kind === "local"
      ? "local"
      : hosts && hosts.size === 1
        ? [...hosts][0] ?? "none"
        : "mixed"
    : "none";
  return ok({
    ok: true,
    pluginVersion: PLUGIN_VERSION,
    node: status.node,
    repo,
    repos,
    repoProblem,
    backend,
    gh: status.gh,
    counts,
    maps,
  });
}

async function runContext(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(z.strictObject({ limit: z.number().int().min(1).max(20).optional() }), args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const limit = inputResult.data.limit ?? 5;
  const read = await readBoard(context.workspaceDir, { limit: 100 });
  if (!read.ok) return fail(read.reason, read.detail);
  const issues = read.issues.filter((item) => item.kind === "issue");
  const counts = countBoard(issues);
  const open = issues.filter((item) => item.state === "OPEN");
  /** 跨仓库阻塞者写成 `owner/repo#12`；本仓库的仍只给票号。 */
  const blockerRef = (blocker: { number: number; repo?: string }): string =>
    blocker.repo ? `${blocker.repo}#${blocker.number}` : `#${blocker.number}`;
  const brief = (item: (typeof issues)[number]) => ({
    repo: item.repoKey,
    number: item.number,
    title: item.title,
    readiness: item.readiness,
    labels: item.labels.map((label) => label.name),
    assignees: item.assignees,
    // 只列还没关的：UNKNOWN（跨仓库引用读不到对方那张票）也算还堵着，不能因为读不到就隐身。
    // 本仓库的仍只给票号（老调用方按数字读），跨仓库的另起一列带 `owner/repo#n`。
    blockedBy: item.blockedBy
      .filter((blocker) => blocker.state !== "CLOSED" && !blocker.repo)
      .map((blocker) => blocker.number),
    blockedByCrossRepo: item.blockedBy
      .filter((blocker) => blocker.state !== "CLOSED" && blocker.repo)
      .map(blockerRef),
    /** 引用失效的阻塞者单列一份：它们仍然算阻塞，但原因不是「对方还开着」。 */
    blockedByStale: item.blockedBy.filter((blocker) => blocker.stale === true).map(blockerRef),
  });
  return ok({
    ok: true,
    repo: read.repo ? repoLabel(read.repo) : null,
    repos: read.repos.map((repo) => ({ repo: repo.key, dir: repo.dir, readOnly: repo.readOnly })),
    failures: read.failures,
    counts,
    maps: open.filter((item) => item.isMap).map(brief),
    ready: open.filter((item) => item.readiness === "ready").slice(0, limit).map(brief),
    blocked: open.filter((item) => item.readiness === "blocked").slice(0, limit).map(brief),
    hasMore: read.hasMore,
    source: read.source,
  });
}

async function runSuggestNextSteps(args: unknown, _context: ToolContext): Promise<ToolResult> {
  const result = normalizeSuggestions(args);
  if (!result.ok) return fail("invalid", result.error);
  const received = isRecord(args) && Array.isArray(args.items) ? args.items.length : result.items.length;
  return ok({
    ok: true,
    tool: SUGGEST_TOOL_NAME,
    items: result.items,
    received,
    returned: result.items.length,
  });
}

/**
 * 子会话写回传件。
 *
 * agent id **只**从 `PASEO_AGENT_ID` 取，不接受入参：让子会话自报 id 就等于允许它冒名
 * 写别人的回传，而父窗口正是靠这份文件认定「这一支干完了」。拿不到就明说失败，
 * 不猜、也不退回某个默认值——猜错的代价是别人那一支的结果被覆盖。
 */
async function runHandoff(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(
    z.strictObject({
      summary: z.string().min(1),
      status: z.enum(["completed", "blocked", "failed"]).optional(),
      done: z.array(z.string()).optional(),
      nextSteps: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
      blocking: z.array(z.string()).optional(),
      ticketKey: z.string().optional(),
      difficulty: z.enum(["trivial", "normal", "hard", "critical"]).optional(),
    }),
    args,
  );
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;
  const agentId = process.env.PASEO_AGENT_ID?.trim() ?? "";
  if (!agentId) {
    return fail("no-agent-id", "拿不到本会话的 agent id（PASEO_AGENT_ID 为空），无法写下回传件");
  }
  const written = await writeChildHandoff(context.workspaceDir, {
    agentId,
    status: input.status ?? "completed",
    summary: input.summary,
    ...(input.done ? { done: input.done } : {}),
    ...(input.nextSteps ? { nextSteps: input.nextSteps } : {}),
    ...(input.files ? { files: input.files } : {}),
    ...(input.blocking ? { blocking: input.blocking } : {}),
    ...(input.ticketKey ? { ticketKey: input.ticketKey } : {}),
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
  });
  if (!written.ok) return fail("write-failed", written.detail);
  return ok({
    ok: true,
    agentId,
    path: written.path,
    status: input.status ?? "completed",
    markdown: written.markdown,
    note: "回传件已落盘；父窗口在派单钩子里收尾时会拿到它。派单场景下如果父窗口还开着，直接把它贴进对话也能保证不丢。",
  });
}

/**
 * 派单预览。
 *
 * 只读：不改宿主配置、不建会话。真正的创建仍由调用方拿这里的 `providerSpec` 调宿主
 * 自己的 `create_agent`——这样「谁派单」留在宿主手里（父会话关系、通知、权限都归它管），
 * 插件只负责「按难度选哪个客户端/模型」和「子会话该怎么回传」。
 */
async function runDispatchPlan(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(
    z.strictObject({
      tasks: z
        .array(
          z.strictObject({
            key: z.string().max(200),
            title: z.string().max(200).optional(),
            // 与 RPC 侧同一条上限：一次派 20 条超长提示词会把 create_agent 灌死。
            prompt: z.string().min(1).max(100_000),
            difficulty: z.enum(["trivial", "normal", "hard", "critical"]).optional(),
            /** 这条任务替哪张地图干活；不传就看批次上的 `map`。有预算的地图靠它数人。 */
            map: z.string().max(300).optional(),
          }),
        )
        .min(1)
        .max(20),
      /** 这一批默认替哪张地图干活；逐条任务可以用 `map` 覆盖。 */
      map: z.string().max(300).optional(),
      /**
       * 派单窗口自己所在层，主窗口=0。**必填**：缺省按 0 算等于「任何人都是第一层」，
       * 层数上限就形同虚设，链条可以无限往下接。
       */
      depth: z.number().int().min(0).max(10),
      dispatchId: z.string().optional(),
      workspaceId: z.string().optional(),
      lang: z.enum(["zh", "en"]).optional(),
    }),
    args,
  );
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;

  const read = await readPlanContext(context.workspaceDir);
  // 这里不能「告警 + 用默认值继续」：默认值里没有任何角色，每条任务都会被拒成
  // 「先加一条工作区角色」，和「文件读不出来 / 文件坏了」是两码事。直接失败，原因说准。
  if (read.readFailed) {
    return fail("settings-unreadable", `编排文件读不出来（不是「没配过」）：${read.detail ?? "未知原因"}`);
  }
  if (read.corrupt) {
    return fail("settings-corrupt", `编排文件解析失败：${read.detail ?? "格式不对"}——先修好它，不能拿默认值派单`);
  }
  const warnings: string[] = [];
  if (!read.exists) warnings.push("还没有编排设置：先到面板「编排」里指定派单窗口和难度路由");
  if (read.profileDetail) warnings.push(read.profileDetail);

  const roleIds = [...new Set(read.settings.roles.map((role) => role.workspaceId.trim()).filter(Boolean))];
  const workspaceId =
    input.workspaceId?.trim() || read.workspaceId || (roleIds.length === 1 ? roleIds[0] ?? "" : "");
  if (!workspaceId) {
    warnings.push("分不清这个工作区：多份角色绑定同时存在，请显式传 workspaceId");
  }

  const depth = input.depth;
  // 谁在派单：优先信 `PASEO_AGENT_ID`（真实调用者）。配置里的派单窗口只是默认值，
  // 任何会话都能调这个工具，标签写错窗口会让会话树与真实回传链指向两个不同会话。
  const callerAgentId = process.env.PASEO_AGENT_ID?.trim() ?? "";
  const configuredDispatcher =
    read.settings.roles.find((role) => role.workspaceId === workspaceId)?.dispatcherAgentId?.trim() ?? "";
  if (callerAgentId && configuredDispatcher && callerAgentId !== configuredDispatcher) {
    warnings.push(
      `这次是 ${callerAgentId} 在派单，不是绑定的派单窗口 ${configuredDispatcher}：标签与抬头按实际调用者写，绑定关系没改。`,
    );
  } else if (!callerAgentId) {
    warnings.push("拿不到本会话的 agent id（PASEO_AGENT_ID 为空）：标签里的父会话只能写绑定的派单窗口，可能和宿主的父子关系不一致。");
  }
  const dispatchId = input.dispatchId?.trim() || `deck-${Date.now().toString(36)}`;
  const plan = planDispatch({
    workspaceId,
    roles: read.settings.roles,
    routing: read.settings.routing,
    profiles: read.profiles,
    tasks: input.tasks,
    maxDepth: read.settings.maxDepth,
    maxChildrenPerDispatch: read.settings.maxChildrenPerDispatch,
    mapBudgets: read.settings.mapBudgets,
    ...(input.map?.trim() ? { map: input.map.trim() } : {}),
    depth,
    dispatchId,
    ...(callerAgentId ? { callerAgentId } : {}),
  });
  if (read.settings.mapBudgets.length > 0) {
    // 这一步只出计划，会话是调用方自己建的：插件数不到「现在已经开着几个」。
    // 说清楚边界——不说的后果是有人以为配了预算就等于不会再并行了。
    warnings.push(
      `地图并发预算（${read.settings.mapBudgets.map((budget) => `${budget.map}=${budget.concurrency}`).join("、")}）在这里只按本批算：` +
        "插件数不到宿主上已经开着几个子会话，硬拦发生在面板派单（RPC）那一步；你手工建会话时自己数着",
    );
  }

  const lang = input.lang ?? "zh";
  const accepted = plan.tasks.map((task) => {
    const preamble = buildDispatchPreamble({
      lang,
      dispatcherAgentId: plan.dispatcherAgentId ?? "",
      difficulty: task.difficulty,
      ...(task.key ? { ticketKey: task.key } : {}),
      depth: depth + 1,
    });
    if (task.routeFrom) {
      warnings.push(
        task.routeFrom === "default"
          ? `${task.key}（${task.difficulty}）没有配路由，也不存在 normal 兜底，用的是内置默认目标 ${task.providerSpec}`
          : `${task.key}（${task.difficulty}）没有单独配置，借用了 ${task.routeFrom} 的路由 ${task.providerSpec}`,
      );
    }
    return {
      key: task.key,
      title: task.title ?? null,
      map: task.map ?? null,
      difficulty: task.difficulty,
      provider: task.target.provider,
      model: task.target.model ?? null,
      providerSpec: task.providerSpec,
      modeId: task.target.modeId ?? null,
      thinkingOptionId: task.target.thinkingOptionId ?? null,
      labels: task.labels,
      idempotencyKey: task.idempotencyKey,
      routeFrom: task.routeFrom ?? null,
      /** 交给 `create_agent` 的 prompt：抬头 + 任务正文。 */
      prompt: `${preamble}\n\n${task.prompt}`,
    };
  });

  return ok({
    ok: true,
    dispatchId,
    workspaceId: workspaceId || null,
    dispatcherAgentId: plan.dispatcherAgentId,
    depth,
    nextDepth: depth + 1,
    tasks: accepted,
    rejected: plan.rejected,
    warnings,
    hint:
      "对每条 tasks 调宿主 create_agent：config.provider 用 providerSpec（宿主认 provider/model 这种写法，" +
      "拆开写成 provider + model 两个字段也可以）；labels 原样带上；prompt 用这里的 prompt。" +
      "子会话会成为你的子会话；它调 deck_handoff 写回结果，你结束时再据此汇报给上一级。" +
      "routeFrom 不为 null 表示这一档是借来的路由：照办也行，但要把这件事写进你给上级的汇报里。",
  });
}

const HANDLERS: Readonly<Record<string, ToolHandler>> = Object.freeze({
  deck_context: runContext,
  deck_issue_get: runIssueGet,
  deck_map_snapshot: runMapSnapshot,
  deck_issue_list: runIssueList,
  deck_issue_create: runIssueCreate,
  deck_map_plan_create: runMapPlanCreate,
  deck_map_link: runMapLink,
  deck_issue_patch: runIssuePatch,
  deck_issue_report: runIssueReport,
  deck_issue_comment: runIssueComment,
  deck_issue_labels: runIssueLabels,
  deck_pull_requests_list: runPullRequestsList,
  deck_next_steps: runNextSteps,
  deck_probe: runProbe,
  deck_handoff: runHandoff,
  deck_dispatch_plan: runDispatchPlan,
  [SUGGEST_TOOL_NAME]: runSuggestNextSteps,
});

const specFor = (name: string): ToolSpec | undefined =>
  name === SUGGEST_TOOL_NAME
    ? { description: SUGGEST_DEFINITION.description, inputSchema: SUGGEST_DEFINITION.parameters as unknown as Record<string, unknown> }
    : TOOL_SPECS[name];

export const MCP_SERVER_NAME = "matt-skills-deck";

/** 全部工具：DSH 九工具 + 本插件扩展工具；名字顺序即 tools/list 的顺序。 */
export const MCP_TOOLS: readonly ToolDefinition[] = Object.freeze(
  [...DECK_TOOL_ORDER, ...EXTENSION_TOOL_ORDER].map((name) => {
    const spec = specFor(name);
    const run = HANDLERS[name];
    if (!spec || !run) throw new Error(`工具契约缺少实现：${name}`);
    return { name, description: spec.description, inputSchema: spec.inputSchema, run };
  }),
);

/**
 * 不需要用户逐次确认的工具：只读工具（`suggest_next_steps` 同样不写任何状态），
 * 外加 `deck_handoff`——它只写 `.deck/handoffs/` 里自己名下的回传件。
 *
 * 为什么唯独这一个写工具进白名单：子会话要「把结果送回上一级」，如果每写一次都要人点确认，
 * 无人值守的派单链条就断在最后一步；而它写不进票面、写不进远端，最坏情况是多一份本地文件。
 * 改票面的写工具故意不在这个名单里。
 */
export const PREAPPROVED_TOOL_NAMES: readonly string[] = Object.freeze([
  "deck_context",
  "deck_issue_get",
  "deck_map_snapshot",
  "deck_issue_list",
  "deck_pull_requests_list",
  "deck_next_steps",
  "deck_probe",
  "deck_handoff",
  "deck_dispatch_plan",
  "suggest_next_steps",
]);

/** 旧名在查找期归一：`deck_issues_list` / `deck_map` 仍可调用，但注册表只有新名。 */
export function findTool(name: string): ToolDefinition | undefined {
  const canonical = canonicalToolName(name);
  return MCP_TOOLS.find((tool) => tool.name === canonical);
}
