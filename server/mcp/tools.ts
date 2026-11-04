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
import { repoOf, resolveWorkspaceTargets, writableRepoKeys } from "../tracker/targets.ts";
import { createLocalIssue, getLocalIssue, patchLocalIssue, postLocalComment, readLocalContainer, replaceLocalLabels, resolveLocalStore, setLocalBlockedBy, setLocalParent } from "../tracker/local.ts";
import { ensureIssueBody } from "../tracker/ensure-body.ts";
import { createGithubOperations } from "../tracker/github/operations.ts";
import { ensureLabels, labelNames, resolveCreateKind, type PositionKind } from "../../shared/issue-kind.ts";
import { markerKindAtStart, markerKindInHeader, markerLineFor } from "../../shared/issue-marker.ts";
import { anchorKeyFor } from "../../shared/anchor.ts";
import { readMdScope } from "../../shared/md-scope.ts";
import { parseMapBody } from "../tracker/map-body.ts";
import { routeFromIssues, suggestNextSteps } from "../tracker/map-route.ts";
import { createIssue, patchIssue, postComment, replaceLabels } from "../tracker/write.ts";
import { sortIssues } from "../tracker/order.ts";
import { assertLabelsReadable } from "../tracker/label-guard.ts";
import { countBoard } from "../tracker/readiness.ts";
import { closeChildrenOf, containerCloseGuard } from "./close-guard.ts";
import { containerKindOf } from "../../shared/container-kind.ts";
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
import {
  MAX_STAFF_ID_CHARS,
  MAX_STAFF_PATH_CHARS,
  buildDispatchPreamble,
  buildDispatchTicket,
  planDispatch,
  staffCardOf,
  ticketSpecOf,
  type WorkspaceRoles,
} from "../../shared/orchestration.ts";
import {
  planRequirementDispatch,
  readRequirementForDispatch,
  requirementWorkspacesOf,
  summarizeRequirementDispatch,
} from "../requirement-dispatch.ts";
import { REQUIREMENT_DISPATCH_TOOL_NAME } from "../../shared/requirement-split.ts";
import { updateWorkRouteLedger } from "../ledger.ts";
import { applyWorkRouteEvent, summarizeWorkRoute, ticketKeyOf } from "../../shared/work-route.ts";
import {
  childrenOf, landingOf, refuseCyclicBlockBatch, resolveDependencyRefs, statusOfItems, upsertCrossRepoBlockedBy,
  type DependencyScope, type EdgeEvidence,
} from "../../shared/edge-rules.ts";
import { readWorkspaceConfig } from "../tracker/workspace-repo.ts";
import { withDerivedFrom } from "../../shared/derived.ts";
import {
  REQUIREMENT_LABEL,
  isDeckLabel,
  normalizeRequirementKey,
  parseImpactTable,
  requireTicketGates,
} from "../../shared/impact.ts";
import { guardCreateTicket } from "../../shared/split-guard.ts";
import { DECK_STAFF_LABEL } from "../../shared/staff.ts";
import { planStaffRequest, STAFF_REQUEST_TOOL_NAME } from "../../shared/staff-request.ts";
import { acceptanceRecordForClose, judgeCreateChainGate, judgeDispatchTaskChain } from "../chain-gates.ts";
import type { TicketReader } from "../contract-chain.ts";
import { requestCoordination } from "../staff-territory.ts";
import { applyContractChange, diffImpactRows } from "../contract-change.ts";
import { staffIdOfSession } from "../staff-sessions.ts";
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

export interface ToolContext {
  workspaceDir: string;
  /** 测试 / 调用方注入的读票器；生产不传，走真实后端。 */
  reader?: TicketReader;
  /** 测试注入的时钟；生产不传，需要时取 `new Date()`。 */
  now?: () => Date;
}
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
    map: { key: String(detail.issue.number), number: detail.issue.number, title: detail.issue.title, state: detail.issue.state, url: detail.issue.url, derivedFrom: detail.issue.derivedFrom ?? null, ...map },
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

  /* ---------------- 建票闸：无票不干活 / 需求定稿 / deck: 私标签 ---------------- */
  // 放在写盘之前：拒绝时保证一个字节都没写，也不会先建出一张挂错需求的工作票。
  // 闸按入参判，不靠正文猜 requirementKey——正文写不写是格式问题，入参有没有是硬问题。
  const requirementNumber =
    input.requirementKey === undefined ? null : normalizeRequirementKey(input.requirementKey);
  if (input.requirementKey !== undefined && requirementNumber === null) {
    return fail("invalid", `requirementKey 不是合法票号：${String(input.requirementKey)}。这张票没建。`);
  }
  let requirementLabels: string[] | null = null;
  let requirementBody = "";
  if (requirementNumber !== null) {
    const requirement = await readOne(backend, requirementNumber);
    if (!requirement.ok) return failureOf(requirement);
    requirementLabels = labelNames(requirement.issue.labels);
    requirementBody = requirement.issue.body ?? "";
  }
  // 跨区判定要的是「这个工作区里可能动到几个仓库」，不是「这张票写进哪个仓库」：
  // 只写 repoKey 等于永远只看一个仓库，跨区缺行就永远查不出来。
  const repoListing = requirementNumber === null ? null : await writableRepoKeys(context.workspaceDir);
  const impactTable = requirementBody ? parseImpactTable(requirementBody) : null;
  const hasChain = impactTable?.ok === true && impactTable.rows.some((row) => row.chain.trim().length > 0);
  const gate = guardCreateTicket({
    kind: position,
    labels: input.labels ?? [],
    body: input.body ?? "",
    requirementKey: requirementNumber,
    staff: input.staff ?? null,
    action: "create",
    requirementLabels,
    requirementBody,
    // 没有需求票的票型（地图路线票等）不吃影响面闸：它们本来就不属于任何需求。
    ...(repoListing ? { repos: repoListing.keys, hasChain } : {}),
  });
  if (!gate.ok) return fail("invalid", `${gate.detail}这张票没建。`);

  /* ---------------- 跨区链条 / 验收票：和派单闸共用同一份判定 ---------------- */
  // 放在写盘之前：格式坏、对方票没关、验收票缺席都在这里拒绝，一个字节都不写。
  let chainWarnings: string[] = [];
  if (requirementNumber !== null) {
    const chainGate = await judgeCreateChainGate({
      workspaceDir: context.workspaceDir,
      requirementBody,
      requirementRepoKey: backend.key,
      targetRepoKey: backend.key,
      targetArea: input.area ?? backend.key,
      position,
      ...(context.reader ? { reader: context.reader } : {}),
    });
    if (!chainGate.ok) return fail("invalid", `${chainGate.reason}这张票没建。`);
    chainWarnings = [...chainGate.warnings];
  }

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
  // 岗位标签只记「这张票归哪张卡」：值必须是卡 id，回头派单与履历都按它反查。
  const staffId = (input.staff ?? "").trim();
  if (staffId) {
    // 名册非空时只认名册里的卡；写一张不存在的卡会让履历、群视图和单例锁全部对不上。
    const plan = await readPlanContext(context.workspaceDir);
    if (!plan.readFailed && !plan.corrupt) {
      const cards = plan.settings.roles.flatMap((role) => role.staff ?? []);
      if (cards.length && !cards.some((card) => card.id === staffId)) {
        return fail(
          "unknown-staff",
          `名册里没有岗位「${staffId}」：可选 ${cards.map((card) => card.id).join(" / ")}。这张票没建。`,
        );
      }
    }
    labels.push(`${DECK_STAFF_LABEL}=${staffId}`);
  }
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
    ...(chainWarnings.length ? { warnings: chainWarnings } : {}),
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
  // 正文编辑一律读旧正文：契约变更要靠「旧 vs 新」才能算出哪一行变了。
  const needCurrent = hasLabels || hasBodyEdit || close || (hasBlockers && input.body === undefined);
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
  // 关容器（地图 / 规格）前先过闸：子票读不回、还有没关的、调用里没带核对评论，三种都整笔拒绝。
  // 判据只看 `current` 与子票清单；这里不写任何东西，拒绝时票面一个字节都不动。
  if (current && close) {
    const container = containerKindOf(current.issue);
    if (container) {
      // 子票直接取详情里的那一列，不扫全板：板子会被后端截断（本地 100、GitHub 单页 100、
      // GitLab 候选 1000），按板子算会把「读不全」当成「都关完了」。
      // 只认 comment，不认 closeReason：GitHub 的 closeReason 是原生 state_reason（不进评论），
      // 其余后端最多 120 字，装不下逐张核对结论；松掉这条，agent 会拿一句原因绕过核对。
      const guard = containerCloseGuard({
        kind: container,
        key: number,
        hasComment: Boolean(input.comment?.trim()),
        children: closeChildrenOf(current),
      });
      if (guard.kind === "refuse") return fail(guard.rule, guard.text);
    }
  }

  // 写回之前留一份旧正文：契约变更的 diff 只能从这里拿「改之前」。
  const previousBody = current?.issue.body ?? "";
  let body = input.body ?? previousBody;
  // 关需求票时留一行持久痕迹：这是票关掉之后唯一还读得到的「未验收」证据。
  // 面板 RPC 与 MCP 两条关票路径都要写，否则 agent 关的票上什么都没有。
  let acceptanceClose: Awaited<ReturnType<typeof acceptanceRecordForClose>> | null = null;
  let acceptanceBodyChanged = false;
  const closesRequirement =
    current !== null
    && !containerKindOf(current.issue)
    && current.issue.labels.some((label) => label.name.toLowerCase() === REQUIREMENT_LABEL);
  if (close && closesRequirement) {
    acceptanceClose = await acceptanceRecordForClose({
      workspaceDir: context.workspaceDir,
      requirementBody: body,
      requirementRepoKey: backend.kind === "local" ? null : backend.key,
      closedOn: (context.now?.() ?? new Date()).toISOString().slice(0, 10),
      ...(context.reader ? { reader: context.reader } : {}),
    });
    if (acceptanceClose.append) {
      body = `${body.trimEnd()}\n\n${acceptanceClose.append}`;
      acceptanceBodyChanged = true;
    }
  }
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
  if (hasBodyEdit || blockBodyChanged || acceptanceBodyChanged) patch.body = body;
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

  // 正文真的变了才 diff：没有影响面表 / 没有链条行时 diff 返回空，什么都不做。
  // 通知失败只进 warnings，不回滚已经成功的 patch，也不把整次调用变成失败。
  let contractChange: Awaited<ReturnType<typeof applyContractChange>> | null = null;
  let contractChangeFailure: string | null = null;
  if (patched?.body !== undefined && patched.body !== previousBody) {
    try {
      const changes = diffImpactRows(previousBody, patched.body);
      if (changes.length) {
        const repoListing = await writableRepoKeys(context.workspaceDir);
        const currentRef = repoListing.keys.length > 1 ? `${backend.key}#${number}` : `#${number}`;
        contractChange = await applyContractChange({
          workspaceDir: context.workspaceDir,
          requirementNumber: number,
          changes,
          repoKey: backend.key,
          currentRef,
          by: process.env.PASEO_AGENT_ID?.trim() || null,
          at: (context.now?.() ?? new Date()).toISOString(),
        });
      }
    } catch (error) {
      contractChangeFailure = `契约变更通知没写成：${error instanceof Error ? error.message : String(error)}`;
    }
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
    ...(contractChange ? {
      contractChange: {
        changes: contractChange.changes,
        notes: contractChange.notes,
        coordination: contractChange.coordination,
        groupMessages: contractChange.groupMessages,
        warnings: contractChange.warnings,
      },
    } : {}),
    ...(contractChangeFailure ? { contractChangeFailure } : {}),
    ...(acceptanceClose
      ? { acceptanceRecord: { appended: acceptanceBodyChanged, warnings: acceptanceClose.warnings } }
      : {}),
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
      // 容器没给清单 ≠ 0 张：必须如实说「判不了」，不能让 agent 读成「完整但没有」。
      // 非容器（GitLab 本来就不查子票）不套这条，免得普通票被误标成截断。
      childrenTruncated: detail.childrenTruncated ?? (detail.children === undefined && Boolean(detail.issue.containerKind)),
      ...(detail.childrenProblem ? { childrenProblem: detail.childrenProblem } : {}),
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
  // `deck:` 是插件私有标签：整组替换里混进一枚就整组拒绝，不做「悄悄剔掉再写」——
  // 那会让模型以为写成功了，而那一枚恰好是定稿闸认的东西。
  const privateLabel = input.labels.find(isDeckLabel);
  if (privateLabel) {
    return fail("invalid", `标签「${privateLabel}」不能经 MCP 写：deck: 前缀只能由界面上的按钮打，模型不能给自己发许可证。`);
  }
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
  // 来源票若是一张需求，地图路线票也要按它的影响面核一遍：同一份闸，不因为
  // 入口从 deck_issue_create 换成 deck_map_plan_create 就少查一项。
  const sourceRead = sourceNumber === null ? null : await readOne(backend, sourceNumber);
  const sourceBody = sourceRead?.ok ? sourceRead.issue.body ?? "" : "";
  const sourceRepos = sourceRead?.ok ? (await writableRepoKeys(context.workspaceDir)).keys : [];
  const sourceTable = sourceBody ? parseImpactTable(sourceBody) : null;
  const sourceHasChain = sourceTable?.ok === true && sourceTable.rows.some((row) => row.chain.trim().length > 0);
  const now = Date.now();
  const localScratch = backend.kind === "local" && (await resolveLocalStore(context.workspaceDir)).primary.kind === "scratch";

  type PlanCreated = { ok: true; number: number; url: string; labels: string[]; labelsFailed: boolean; path?: string; reused?: boolean } | { ok: false; reason: string; detail: string };
  type PlaneFactory = (title: string, planBody: string, labels: string[], parentKey: number | null, anchor: string, containerName?: string) => Promise<PlanCreated>;

  // 三种后端各走各自的真实建票入口：GitHub 的父子边是原生 sub-issue，GitLab 落正文 Part of 行，
  // 本地 `.scratch` 落文件头 Parent，`.deck` 落文件头 parentKey（都从同一个 parentKey 入参出发）。
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
    // `.deck`：地图是带 wayfinder:map 的普通票；父子边同样落文件头 parentKey，
    // 正文里的 "Part of map #N" 只留给人看。
    if (backend.kind !== "local") return { ok: false, reason: "unsupported-host", detail: "不认识的建票后端" };
    const result = await createLocalIssue(backend.workspaceDir, {
      title,
      body: planBody,
      labels,
      ...(parentKey !== null ? { parentKey: String(parentKey) } : {}),
    });
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
    return { ok: true, number: result.number, url: result.url, labels: result.labels, labelsFailed: result.labelsFailed, ...(result.path ? { path: result.path } : {}), reused: result.reused === true };
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
    // 第二条建票入口也过同一份闸：地图下的工单是侦查路线票，不要求需求票，
    // 但 `deck:` 私标签等硬规则必须与 `deck_issue_create` 同口径。
    const ticketGate = guardCreateTicket({
      kind: "map-ticket",
      labels,
      body: ticketBody,
      action: "create",
      ...(sourceRead?.ok
        ? { requirementBody: sourceBody, repos: sourceRepos, hasChain: sourceHasChain }
        : {}),
    });
    if (!ticketGate.ok) {
      tickets.push({ title: ticket.title, kind: ticket.kind, error: ticketGate.detail });
      continue;
    }
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
/**
 * 调用方在名册里是不是一张员工卡：员工只干活，不派活。
 *
 * `PASEO_AGENT_ID` 是宿主的会话 id，名册卡的 id 是另一套稳定键，不能直接相等。
 * 先按卡 id 直接比（手工把卡 id 设成会话 id 的旧做法 / 测试），再查
 * `agent.created` 写的会话台账。两处都没有 = 认不出，按「不是员工」放行；
 * 这条失败方向与 `agent.created` 的追认一致，宁可漏一次也不误杀。
 */
async function callerWorkerOf(roles: WorkspaceRoles | null, callerAgentId: string, workspaceDir: string) {
  if (!callerAgentId) return null;
  const roster = roles?.staff ?? [];
  const direct = roster.find((item) => item.id === callerAgentId) ?? null;
  const staffId = direct?.id ?? (await staffIdOfSession(workspaceDir, callerAgentId));
  const card = staffId ? roster.find((item) => item.id === staffId) ?? null : null;
  return card && (card.kind ?? "worker") !== "manager" ? card : null;
}

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
            /** 派给名册里的哪张卡；名册非空时必填，没写就拒（不猜一个人）。 */
            staff: z.string().max(MAX_STAFF_ID_CHARS).optional(),
            /** 这条任务落在哪个仓库；多仓库工作区必填，单仓库不填。 */
            repoKey: z.string().max(200).optional(),
            /** 这条活落在哪片：staff 没给时按它走归属算法选卡。 */
            region: z
              .strictObject({
                repoKey: z.string().max(200).optional(),
                pathPrefix: z.string().max(MAX_STAFF_PATH_CHARS).optional(),
              })
              .optional(),
            /** 这条活挂在哪条需求票下；无票不干活，缺了就不给计划。 */
            requirementKey: z.number().int().min(1).optional(),
            /** 需求票所在的仓库；子票仓库不能代替它读需求票。 */
            requirementRepoKey: z.string().max(200).optional(),
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
  const workspaceRoles = read.settings.roles.find((role) => role.workspaceId === workspaceId) ?? null;
  // 员工卡只能干活，不能派活：先在计划阶段拒掉，别花一次建会话再去 `agent.created` 归档。
  const callerWorker = await callerWorkerOf(workspaceRoles, callerAgentId, context.workspaceDir);
  if (callerWorker) {
    return fail(
      "staff-cannot-dispatch",
      `「${callerWorker.name || callerWorker.id}」是员工卡，不能派单：只有经理能拆活。` +
        `越界、缺人手或需要别的区配合时，调 ${STAFF_REQUEST_TOOL_NAME} 写一条待处理的协调请求（task / why），由经理决定。`,
    );
  }
  const configuredDispatcher = workspaceRoles?.dispatcherAgentId?.trim() ?? "";
  if (callerAgentId && configuredDispatcher && callerAgentId !== configuredDispatcher) {
    warnings.push(
      `这次是 ${callerAgentId} 在派单，不是绑定的派单窗口 ${configuredDispatcher}：标签与抬头按实际调用者写，绑定关系没改。`,
    );
  } else if (!callerAgentId) {
    warnings.push("拿不到本会话的 agent id（PASEO_AGENT_ID 为空）：标签里的父会话只能写绑定的派单窗口，可能和宿主的父子关系不一致。");
  }
  const dispatchId = input.dispatchId?.trim() || `deck-${Date.now().toString(36)}`;
  // 多仓库工作区：先把仓库列出来，「没写 repoKey」才能在计划阶段被拒。
  // 本地单目录工作区不会触发这条闸。
  const repoListing = await writableRepoKeys(context.workspaceDir);
  const repoKeys = repoListing.keys;
  if (repoListing.detail) {
    // 读不出来 = 这条闸这一批不生效。说出来，别让人以为检查过了。
    warnings.push(`读不出这个工作区有哪些仓库，多仓库校验这一批跳过：${repoListing.detail}`);
  }
  // 两道闸：无票不干活 / 需求没 `deck:定稿` 不派。按需求票逐张读标签，
  // 同一张需求只读一次；被拦下的任务不进入计划，也不占用并发名额。
  const requirementCache = new Map<
    string,
    | { readonly labels: readonly string[]; readonly body: string; readonly repoKey: string | null }
    | { readonly detail: string }
  >();
  const preRejected: Array<{ key: string; title?: string; reason: string; detail: string }> = [];
  const gatedTasks: typeof input.tasks = [];
  for (const task of input.tasks) {
    if (task.requirementKey === undefined) {
      preRejected.push({
        key: task.key,
        ...(task.title ? { title: task.title } : {}),
        reason: "no-requirement",
        detail: "这条活没有挂需求票：无票不干活。先用 deck_issue_create 建需求，再把 requirementKey 指向它。",
      });
      continue;
    }
    const cacheKey = `${task.requirementRepoKey ?? ""}#${task.requirementKey}`;
    let requirement = requirementCache.get(cacheKey);
    if (!requirement) {
      const readRequirement = await readIssue(context.workspaceDir, task.requirementKey, {
        ...(task.requirementRepoKey ? { repoKey: task.requirementRepoKey } : {}),
      });
      if (!readRequirement.ok) {
        requirement = { detail: readRequirement.detail };
      } else if (!readRequirement.result.ok) {
        requirement = { detail: readRequirement.result.detail };
      } else {
        requirement = {
          labels: labelNames(readRequirement.result.issue.labels),
          body: typeof readRequirement.result.issue.body === "string" ? readRequirement.result.issue.body : "",
          // 预览与执行必须读同一个仓库的验收票：执行层用需求实际所在仓库，
          // 这里只拿任务自己的 repoKey 会在多仓库工作区里两处判得不一样。
          repoKey: readRequirement.repoKey ?? null,
        };
      }
      requirementCache.set(cacheKey, requirement);
    }
    if ("detail" in requirement) {
      preRejected.push({
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
      preRejected.push({
        key: task.key,
        ...(task.title ? { title: task.title } : {}),
        reason: "requirement-not-finalized",
        detail: gate.detail,
      });
      continue;
    }
    // 链条闸：一条坏任务只拒这一条。被依赖票仍开着 / 读不到 / 验收票挂不上都在这里拦下。
    const chain = await judgeDispatchTaskChain({
      workspaceDir: context.workspaceDir,
      requirementBody: requirement.body,
      requirementRepoKey: task.requirementRepoKey ?? requirement.repoKey ?? null,
      targetRepoKey: task.repoKey ?? task.region?.repoKey ?? null,
      title: task.title ?? null,
      prompt: task.prompt,
      ...(context.reader ? { reader: context.reader } : {}),
    });
    if (!chain.ok) {
      preRejected.push({
        key: task.key,
        ...(task.title ? { title: task.title } : {}),
        reason: "chain-blocked",
        detail: chain.reason,
      });
      continue;
    }
    warnings.push(...chain.warnings);
    gatedTasks.push(task);
  }

  const plan = planDispatch({
    workspaceId,
    roles: read.settings.roles,
    routing: read.settings.routing,
    profiles: read.profiles,
    tasks: gatedTasks,
    maxDepth: read.settings.maxDepth,
    maxChildrenPerDispatch: read.settings.maxChildrenPerDispatch,
    minConcurrentStaff: read.settings.minConcurrentStaff,
    mapBudgets: read.settings.mapBudgets,
    repoKeys,
    ...(input.map?.trim() ? { map: input.map.trim() } : {}),
    depth,
    dispatchId,
    ...(callerAgentId ? { callerAgentId } : {}),
  });
  if (plan.tasks.length > 0 && (workspaceRoles?.staff?.length ?? 0) === 0) {
    // 空名册不是错误：照旧按难度路由派。但要说出来——否则有人会以为自己在按人派活。
    warnings.push("这个工作区还没建岗位名册：按难度路由派单，会话上不会打 deck.staff 标；要按人派活先到「编排」里加人");
  }
  if (read.settings.mapBudgets.length > 0) {
    // 这一步只出计划，会话是调用方自己建的：插件数不到「现在已经开着几个」。
    // 说清楚边界——不说的后果是有人以为配了预算就等于不会再并行了。
    warnings.push(
      `地图并发预算（${read.settings.mapBudgets.map((budget) => `${budget.map}=${budget.concurrency}`).join("、")}）在这里只按本批算：` +
        "插件数不到宿主上已经开着几个子会话，硬拦发生在自动派单（RPC）那一步；你手工建会话时自己数着",
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
    const card = task.staffId ? staffCardOf(workspaceRoles, task.staffId) : null;
    return {
      key: task.key,
      title: task.title ?? null,
      map: task.map ?? null,
      repoKey: task.repoKey ?? null,
      staffId: task.staffId ?? null,
      staffName: card?.name ?? null,
      /**
       * 这张卡的职责提示词：建会话时写进 `config.systemPrompt`。
       *
       * claude / codex / opencode 三家都会把它接进各自的系统提示通道；AC 系（cursor）
       * 现状是不读——那种客户端下岗位职责只是个标签，别指望它约束行为。
       */
      systemPrompt: task.systemPrompt ?? null,
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
      /**
       * 这条任务该落的那张票：标题 / 正文 / 标签，纯推导，这一步一个字都不写。
       *
       * 为什么计划里就给出票：派单不能只留下一个进程。建票要人确认一次，所以由你拿着
       * 这一份去调 `deck_issue_create`——建完把 `labels["deck.ticket"]` 换成 `#<票号>`，
       * 那个标签是从会话反查票的唯一硬链接。
       */
      ticket: buildDispatchTicket(
        ticketSpecOf({
          task,
          card,
          dispatchId,
          dispatcherAgentId: plan.dispatcherAgentId ?? "",
          depth: depth + 1,
          ...(workspaceId ? { workspaceId } : {}),
        }),
      ),
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
    rejected: [...preRejected, ...plan.rejected],
    warnings,
    hint:
      "每条 tasks 要两步：先用 deck_issue_create 把它带来的 ticket（title / body / labels）建成一张票" +
      "（这一步要人确认；票上写着难度与执行客户端），拿到票号后把 labels 里的 deck.ticket 换成 #<票号>；" +
      "再对这条任务调宿主 create_agent：config.provider 用 providerSpec（宿主认 provider/model 这种写法，" +
      "拆开写成 provider + model 两个字段也可以）；labels 用换过票号的那一份；prompt 用这里的 prompt。" +
      "票建不出来就别派这条——派出去的活必须留得下记录。" +
      "子会话会成为你的子会话；它调 deck_handoff 写回结果，你结束时再据此汇报给上一级。" +
      "routeFrom 不为 null 表示这一档是借来的路由：照办也行，但要把这件事写进你给上级的汇报里。",
  });
}

/**
 * 需求 → 每区一张票 + 每区一批派单。
 *
 * 这一层只出清单：MCP 进程没有宿主连接（`ToolContext` 只有工作区目录），建票 / 建会话
 * 要由服务端的 RPC 执行。`confirm` 只决定这份清单是不是「已确认」——确认后也如实
 * 返回 `execution: "rpc"`，不假装已经铺下去。
 */
const requirementDispatchSchema = z.strictObject({
  requirementNumber: z.number().int().min(0),
  requirementRepoKey: z.string().max(200).optional(),
  confirm: z.boolean().optional(),
});

async function runRequirementDispatchTool(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(requirementDispatchSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);
  const input = inputResult.data;

  const read = await readPlanContext(context.workspaceDir);
  if (read.readFailed) {
    return fail("settings-unreadable", `编排文件读不出来（不是「没配过」）：${read.detail ?? "未知原因"}`);
  }
  if (read.corrupt) {
    return fail("settings-corrupt", `编排文件解析失败：${read.detail ?? "格式不对"}——先修好它`);
  }
  const roleIds = [...new Set(read.settings.roles.map((role) => role.workspaceId.trim()).filter(Boolean))];
  const workspaceId =
    read.workspaceId || (roleIds.length === 1 ? roleIds[0] ?? "" : "");
  const callerAgentId = process.env.PASEO_AGENT_ID?.trim() ?? "";
  const role = workspaceId
    ? read.settings.roles.find((item) => item.workspaceId === workspaceId) ?? null
    : null;
  const callerWorker = await callerWorkerOf(role, callerAgentId, context.workspaceDir);
  if (callerWorker) {
    return fail(
      "staff-cannot-dispatch",
      `「${callerWorker.name || callerWorker.id}」是员工卡，不能拆需求：只有经理能派活。` +
        `缺人手或需要别的区配合时，调 ${STAFF_REQUEST_TOOL_NAME} 写一条待处理的协调请求。`,
    );
  }

  const requirement = await readRequirementForDispatch(
    context.workspaceDir,
    input.requirementNumber,
    input.requirementRepoKey,
  );
  if (!requirement.ok) return fail("no-requirement", requirement.detail);

  const lookup = await requirementWorkspacesOf({
    workspaceDir: context.workspaceDir,
    workspaceId,
    body: requirement.ticket.body,
    // MCP 只有当前目录：至少让当前区的仓库键参与匹配；别区仍要靠服务端执行时补齐。
    workspaceDirs: workspaceId ? new Map([[workspaceId, context.workspaceDir]]) : null,
  });
  if (!lookup.ok) return fail(lookup.reason, lookup.detail);

  const plan = await planRequirementDispatch({
    requirement: requirement.ticket,
    workspaces: lookup.workspaces,
    profiles: read.profiles,
  });
  if (!plan.ok) return fail(plan.reason, plan.detail);

  const summary = summarizeRequirementDispatch(plan);
  const confirmed = input.confirm === true || read.settings.confirmRequirementSplit === false;
  const warnings = [...plan.warnings];
  if (lookup.workspaces.length > 1) {
    warnings.push(
      "MCP 进程没有宿主工作区清单：跨区清单按当前目录估算，repoKey / 名册 / 模型以服务端 RPC 执行时为准。",
    );
  }
  if (lookup.unmatchedAreas.length) {
    warnings.push(
      `这些区在 MCP 里对不上任何工作区，清单只按当前区估算：${lookup.unmatchedAreas.join(" / ")}。` +
        "执行时会由服务端按宿主工作区清单再核。",
    );
  }
  return ok({
    ok: true,
    requiresConfirmation: plan.requiresConfirmation && input.confirm !== true,
    created: false,
    execution: confirmed ? "rpc" : "list",
    summary,
    warnings,
    plan,
    batches: plan.batches,
    research: plan.research,
    hint: confirmed
      ? "清单已确认，但 MCP 进程没有宿主连接，不能建票/建会话：执行请走服务端 RPC deck.orchestration.requirement-dispatch，或从编排页确认。"
      : "先给人看这份清单：每个区的票、派给谁、用什么模型、会开几个会话。确认后再执行。",
  });
}

/**
 * 员工要人。
 *
 * 不派活、不开会话：只把一条 `kind: "staffing"` 的请求写进 `.deck/coordination.jsonl`，
 * 和越界请求同一个收件箱。谁能派活由 `agent.created` 追认，这里不冒充。
 */
const staffRequestSchema = z.strictObject({
  task: z.string().min(1).max(2_000),
  why: z.string().min(1).max(2_000),
  staff: z.string().max(MAX_STAFF_ID_CHARS).optional(),
  region: z
    .strictObject({
      repoKey: z.string().max(200).optional(),
      pathPrefix: z.string().max(MAX_STAFF_PATH_CHARS).optional(),
    })
    .optional(),
  fromStaff: z.string().max(MAX_STAFF_ID_CHARS).optional(),
});

async function runStaffRequest(args: unknown, context: ToolContext): Promise<ToolResult> {
  const inputResult = asInput(staffRequestSchema, args);
  if (!inputResult.ok) return fail("invalid", inputResult.error);

  const read = await readPlanContext(context.workspaceDir);
  if (read.readFailed) {
    return fail("settings-unreadable", `编排文件读不出来（不是「没配过」）：${read.detail ?? "未知原因"}`);
  }
  if (read.corrupt) {
    return fail("settings-corrupt", `编排文件解析失败：${read.detail ?? "格式不对"}——先修好它`);
  }
  const roleIds = [...new Set(read.settings.roles.map((role) => role.workspaceId.trim()).filter(Boolean))];
  const workspaceId = read.workspaceId || (roleIds.length === 1 ? roleIds[0] ?? "" : "");
  const role = workspaceId
    ? read.settings.roles.find((item) => item.workspaceId === workspaceId) ?? null
    : null;
  const staffIds = (role?.staff ?? []).map((card) => card.id);

  const build = planStaffRequest(inputResult.data, {
    workspaceId,
    sessionAgentId: process.env.PASEO_AGENT_ID?.trim() ?? "",
    staffIds,
  });
  if (!build.ok) return fail(build.reason, build.detail);

  // 员工可以自报 `fromStaff`，但台账记的会话 id → 卡 id 才是证据。台账认得出时就以它为准：
  // 与自报不一致直接拒绝，不能拿一张经理卡的名义发请求。
  const ledgerStaff = await staffIdOfSession(context.workspaceDir, build.request.sessionAgentId);
  if (ledgerStaff && build.request.fromStaff !== "unknown" && build.request.fromStaff !== ledgerStaff) {
    return fail(
      "unknown-staff",
      `台账记的请求人是「${ledgerStaff}」，与请求里的「${build.request.fromStaff}」不一致：不能拿别人的卡发请求。`,
    );
  }
  const request = ledgerStaff ? { ...build.request, fromStaff: ledgerStaff } : build.request;

  const written = await requestCoordination(context.workspaceDir, request);
  if (!written.ok) return fail("write-failed", written.detail);
  const record = written.records[0];
  return ok({
    ok: true,
    kind: "staffing",
    workspaceId,
    fromStaff: request.fromStaff,
    fromVerified: ledgerStaff !== null,
    toStaff: request.toStaff,
    paths: request.paths,
    state: record?.state ?? "pending",
    superseded: written.superseded,
    file: written.file,
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
  [REQUIREMENT_DISPATCH_TOOL_NAME]: runRequirementDispatchTool,
  [STAFF_REQUEST_TOOL_NAME]: runStaffRequest,
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
 * 外加两个只写本地旁路文件的工具：
 * - `deck_handoff` 写 `.deck/handoffs/` 里自己名下的回传件；
 * - `deck_staff_request` 写 `.deck/coordination.jsonl` 的协调收件箱。
 *
 * 为什么这两个写工具进白名单：子会话要「把结果送回上一级」「缺人手时叫经理」，
 * 如果每写一次都要人点确认，无人值守的派单链条就断在最后一步；而它们写不进票面、
 * 写不进远端，最坏情况是多一份本地文件。改票面的写工具故意不在这个名单里。
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
  REQUIREMENT_DISPATCH_TOOL_NAME,
  STAFF_REQUEST_TOOL_NAME,
  "suggest_next_steps",
]);

/** 旧名在查找期归一：`deck_issues_list` / `deck_map` 仍可调用，但注册表只有新名。 */
export function findTool(name: string): ToolDefinition | undefined {
  const canonical = canonicalToolName(name);
  return MCP_TOOLS.find((tool) => tool.name === canonical);
}
