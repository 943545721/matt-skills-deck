import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  issuesAssignRpc,
  issuesCommentRpc,
  issuesCreateRpc,
  issuesDetailRpc,
  issuesListRpc,
  issuesSetLabelsRpc,
  issuesStateRpc,
} from "../../shared/issues.ts";
import { countBoard, filterBoard, sortBoard } from "../tracker/readiness.ts";
import { mapsDerivedFrom } from "../tracker/derived.ts";
import { mergeScopedLabels, resolveIssueProjectScope } from "../mcp/project-scope.ts";
import { assertLabelsReadable } from "../tracker/label-guard.ts";
import { createIssue, patchIssue, postComment, replaceLabels, setIssueState, takeIssue } from "../tracker/write.ts";
import {
  closeGitLabIssue,
  createGitLabIssue,
  getGitLabIssue,
  postGitLabComment,
  reopenGitLabIssue,
  setGitLabLabels,
  takeGitLabIssue,
} from "../tracker/gitlab.ts";
import { resolveWritableBackend } from "../tracker/backend.ts";
import { readBoard, readIssue } from "../tracker/read.ts";
import {
  createLocalIssue,
  localAssignUnsupported,
  patchLocalIssue,
  postLocalComment,
  replaceLocalLabels,
  setLocalIssueState,
} from "../tracker/local.ts";
import { updateGitLabIssue } from "../tracker/gitlab.ts";
import { labelNames } from "../../shared/issue-kind.ts";
import { REQUIREMENT_LABEL, normalizeRequirementKey } from "../../shared/impact.ts";
import { acceptanceRecordForClose, judgeCreateChainGate, requirementNumberOfBody } from "../chain-gates.ts";
import type { TicketReader } from "../contract-chain.ts";
import { record } from "../logs.ts";

type ListInput = RpcInput<typeof issuesListRpc>;
type DetailInput = RpcInput<typeof issuesDetailRpc>;
type CommentInput = RpcInput<typeof issuesCommentRpc>;
type CreateInput = RpcInput<typeof issuesCreateRpc>;
type SetLabelsInput = RpcInput<typeof issuesSetLabelsRpc>;
type AssignInput = RpcInput<typeof issuesAssignRpc>;
type StateInput = RpcInput<typeof issuesStateRpc>;

const MAP_LABEL = "wayfinder:map";

/** 测试注入点：读票器与时钟；生产不传，走真实后端与 `new Date()`。 */
export interface IssueHandlerOptions {
  readonly reader?: TicketReader;
  readonly now?: () => Date;
}

/**
 * RPC 注册层会把 `PluginHandlerContext` 作为第二个实参传进来；它不提供注入点。
 * 这里只认显式带 `reader` / `now` 的调用（测试直接调 handler），其余一律当没传。
 */
function handlerOptions(context: unknown): IssueHandlerOptions {
  if (!context || typeof context !== "object") return {};
  const candidate = context as { readonly reader?: unknown; readonly now?: unknown };
  return {
    ...(typeof candidate.reader === "function" ? { reader: candidate.reader as TicketReader } : {}),
    ...(typeof candidate.now === "function" ? { now: candidate.now as () => Date } : {}),
  };
}

interface RequirementSource {
  readonly number: number;
  readonly repoKey: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/**
 * 读需求票正文 / 标签，供链条闸与验收票闸判定。
 * 读不到就返回可读原因——建票调用方据此拒绝，不拿空正文冒充「没有链条」。
 */
async function readRequirementSource(
  workspaceDir: string,
  number: number,
  repoKey: string,
): Promise<{ ok: true; requirement: RequirementSource } | { ok: false; reason: string }> {
  const read = await readIssue(workspaceDir, number, { repoKey });
  if (!read.ok) return { ok: false, reason: `读不到需求票 #${number}：${read.detail}` };
  if (!read.result.ok) return { ok: false, reason: `读不到需求票 #${number}：${read.result.detail}` };
  const issue = read.result.issue;
  return {
    ok: true,
    requirement: {
      number,
      repoKey: read.repoKey,
      body: typeof issue.body === "string" ? issue.body : "",
      labels: labelNames(issue.labels),
    },
  };
}

/** 关票日期只写日期，不带时区：`acceptanceRecordLine` 的既有写法就是 `YYYY-MM-DD`。 */
function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export async function listIssuesHandler(input: ListInput): Promise<RpcOutput<typeof issuesListRpc>> {
  const view = input.view ?? (input.includeClosed ? "all" : "open");
  // 状态过滤下推到查询：只取「最近 100 条（开+关）」再本地筛 open，会在关闭票更新频繁时
  // 把 open 视图显示成只剩几条，而 totalCount 还是全仓库的数——两个数对不上，谁都不敢信。
  // blocked / ready 必须在打开票里算（关闭票再也不可能可接），所以也用 open 窗口。
  const read = await readBoard(input.workspaceDir, {
    limit: input.limit ?? 100,
    includeClosed: view === "all",
    view,
    repoKey: input.repoKey,
    // 任务板行要显示 MAP / SPEC 身份，但列表本身不背正文：服务端读正文判类型，
    // 返回前剥掉，客户端只拿 containerKind。PR 页签不需要这套判断。
    identifyContainers: input.kind !== "pull-request",
  });
  if (!read.ok) return read;

  // 计数先于页签筛选：切到 PR 页签时 KPI 仍是同一口径，不会因为当前页签而变。
  // 合板时计数覆盖全部仓库；只读一个仓库时就是那一个的数。
  const afterLabel = filterBoard(read.issues, { label: input.label });
  const counts = countBoard(afterLabel);
  const visible = filterBoard(read.issues, { view, kind: input.kind, label: input.label });

  // 板子上把「地图来自哪条需求」当父子边用：需求行展开就是它建出的地图，
  // 地图行展开是它自己的子票。不另做反查、不额外读板子——正文那一行已经在手上。
  // 只在票面仍按引用讲（「来自需求 #19」），两边说的不是同一件事：一个管分组，一个管出处。
  const rows = visible.map((issue) =>
    issue.isMap && !issue.parentKey && typeof issue.derivedFrom === "number"
      ? { ...issue, parentKey: String(issue.derivedFrom) }
      : issue,
  );

  return {
    ok: true,
    repo: read.repo,
    repos: read.repos,
    failures: read.failures,
    issues: sortBoard(rows, input.sort ?? "updated"),
    totalCount: read.totalCount,
    fetchedAt: read.fetchedAt,
    hasMore: read.hasMore,
    counts,
    source: read.source,
    rateLimit: read.rateLimit,
  };
}

export async function getIssueHandler(input: DetailInput): Promise<RpcOutput<typeof issuesDetailRpc>> {
  const read = await readIssue(input.workspaceDir, input.number, { kind: input.kind, repoKey: input.repoKey });
  if (!read.ok) return read;
  const result = read.result;
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail, repo: read.repo };

  // 反查只在带 requirement 标签的票上做：每一次票面详情都去读一遍整块板子的正文太贵，
  // 而「需求票 → 它的地图」正是这一位存在的唯一用途。读不到就说读不到，不当作「没有地图」。
  const isRequirement = result.issue.labels.some((label) => label.name === "requirement");
  const reversed = isRequirement && !result.issue.isMap
    ? await mapsDerivedFrom(input.workspaceDir, {
        number: input.number,
        ...(input.repoKey ? { repoKey: input.repoKey } : {}),
      })
    : null;

  return {
    ok: true,
    repo: read.repo,
    repoKey: read.repoKey,
    issue: { ...result.issue, labelCount: result.meta.labelCount },
    comments: result.comments,
    commentCount: result.meta.commentCount,
    ...(result.parent === undefined ? {} : { parent: result.parent }),
    ...(result.children === undefined
      ? result.childrenProblem
        ? { children: [], childrenTotal: 0, childrenTruncated: true, childrenProblem: result.childrenProblem }
        : {}
      : {
          children: result.children,
          childrenTotal: result.childrenTotal ?? result.children.length,
          ...(result.childrenTruncated === true ? { childrenTruncated: true } : {}),
          ...(result.childrenProblem ? { childrenProblem: result.childrenProblem } : {}),
        }),
    ...(result.blocking === undefined ? {} : { blocking: result.blocking, blockingTruncated: result.blockingTruncated }),
    ...(reversed === null
      ? {}
      : reversed.ok
        ? { derivedMaps: reversed.maps }
        : { derivedMaps: [], derivedMapsFailed: true }),
  };
}

export async function commentIssueHandler(input: CommentInput): Promise<RpcOutput<typeof issuesCommentRpc>> {
  const backend = await resolveWritableBackend(input.workspaceDir, "评论", input.repoKey);
  if (!backend.ok) return backend;
  // PR 的评论在源仓库是只读的：不能因为编号空间共用，就把一条针对 PR 的评论写到同号 issue 上。
  if (input.kind === "pull-request") {
    return { ok: false, reason: "invalid", detail: "拉取请求的评论是只读的，请到远端网页上回复" };
  }

  const result =
    backend.kind === "local"
      ? await postLocalComment(backend.workspaceDir, input.number, input.body)
      : backend.kind === "gitlab"
        ? await postGitLabComment(backend.ref.owner, backend.ref.name, input.number, input.body)
        : await postComment(backend.ref.owner, backend.ref.name, input.number, input.body);
  if (!result.ok) {
    record("error", "issues.comment", `#${input.number} 失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.comment", `#${input.number} 已评论`);
  return { ok: true, comment: result.comment };
}

export async function createIssueHandler(
  input: CreateInput,
  context?: unknown,
): Promise<RpcOutput<typeof issuesCreateRpc>> {
  const options = handlerOptions(context);
  const backend = await resolveWritableBackend(input.workspaceDir, "新建票", input.repoKey);
  if (!backend.ok) return backend;

  // 面板 RPC 的远端建票路径没有幂等回查与父票写入：静默丢掉会让调用方以为写了。
  if (backend.kind !== "local" && (input.parentKey || input.idempotencyKey)) {
    return {
      ok: false,
      reason: "invalid",
      detail: "面板建票的远端路径不支持 parentKey / idempotencyKey（MCP 的 deck_issue_create 支持）；这次没有建票。",
      repo: backend.repo,
    };
  }

  // 项目 / 模块先核对再写：项目不存在、模块没登记或已废弃都要当场拒绝，
  // 不能写成一张挂着错标签的票——按 area 筛人和筛板子的人不会发现自己被筛错了。
  const scope = await resolveIssueProjectScope({
    workspaceDir: input.workspaceDir,
    repoKey: backend.key,
    ...(input.project ? { projectKey: input.project } : {}),
    ...(input.area ? { area: input.area } : {}),
  });
  if (!scope.ok) {
    record("warn", "issues.create", `定位项目/模块失败：${scope.detail.slice(0, 200)}`);
    return { ok: false, reason: "invalid", detail: scope.detail, repo: backend.repo };
  }
  for (const warning of scope.scope.warnings) record("warn", "issues.create", warning);

  // 勾了「地图」就自动带 wayfinder:map：源仓库里地图票就是靠这个标签认出来的，
  // 让用户自己记得手打字符串迟早会漏。DSH 的 kind=map 与旧的 isMap 同义。
  const labels = [...(input.labels ?? [])];
  if ((input.isMap === true || input.kind === "map") && !labels.includes(MAP_LABEL)) labels.push(MAP_LABEL);
  const scopedLabels = mergeScopedLabels(labels, scope.scope.labels);

  // 链条闸：需求里声明了链条就逐行判定；工作票挂在有链条的区域时还要求已认领的验收票。
  // 只在这张票真的挂在某条需求下时才跑——历史上没有 requirementKey 的普通建票不因此被拦。
  let chainWarnings: string[] = [];
  const explicitRequirement = input.requirementKey === undefined
    ? null
    : normalizeRequirementKey(input.requirementKey);
  if (input.requirementKey !== undefined && explicitRequirement === null) {
    return {
      ok: false,
      reason: "invalid",
      detail: `requirementKey「${String(input.requirementKey)}」不是有效票号；这张票没建。`,
      repo: backend.repo,
    };
  }
  const requirementNumber = explicitRequirement ?? requirementNumberOfBody(input.body);
  if (requirementNumber !== null) {
    const requirementRepoKey = input.requirementRepoKey ?? backend.key;
    const loaded = await readRequirementSource(input.workspaceDir, requirementNumber, requirementRepoKey);
    if (!loaded.ok) {
      record("warn", "issues.create", loaded.reason);
      return { ok: false, reason: "invalid", detail: `${loaded.reason}这张票没建。`, repo: backend.repo };
    }
    const chainGate = await judgeCreateChainGate({
      workspaceDir: input.workspaceDir,
      requirementBody: loaded.requirement.body,
      requirementRepoKey: loaded.requirement.repoKey,
      targetRepoKey: backend.key,
      targetArea: input.area ?? backend.key,
      position: input.kind ?? null,
      ...(options.reader ? { reader: options.reader } : {}),
    });
    if (!chainGate.ok) {
      record("warn", "issues.create", `链条闸拒绝：${chainGate.reason.slice(0, 200)}`);
      return { ok: false, reason: "invalid", detail: `${chainGate.reason}这张票没建。`, repo: backend.repo };
    }
    chainWarnings = [...chainGate.warnings];
    for (const warning of chainWarnings) record("warn", "issues.create", warning);
  }

  const remoteInput = { title: input.title, body: input.body ?? "", labels: scopedLabels };
  // 本地后端的 bug 就是普通 issue；map/spec 及其子票才决定容器与子目录。
  const localKind = input.kind === "bug" ? "issue" : input.kind;
  const localInput = {
    ...remoteInput,
    ...(localKind ? { kind: localKind } : {}),
    ...(input.feature ? { feature: input.feature } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.parentKey ? { parentKey: input.parentKey } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
  const result =
    backend.kind === "local"
      ? await createLocalIssue(backend.workspaceDir, localInput)
      : backend.kind === "gitlab"
        ? await createGitLabIssue(backend.ref.owner, backend.ref.name, remoteInput)
        : await createIssue(backend.ref.owner, backend.ref.name, remoteInput);
  if (!result.ok) {
    record("error", "issues.create", `新建失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record(result.labelsFailed ? "warn" : "info", "issues.create", `#${result.number} 已建${result.labelsFailed ? "（标签未挂上）" : ""}`);
  // `path` / `reused` 只有本地 `.scratch` 后端才回：`in` 收窄在联合类型上拿到的是 unknown，
  // 这里按真实类型再判一次，别把任意对象塞进 string 字段。
  const localPath = "path" in result && typeof result.path === "string" ? result.path : undefined;
  const localReused = "reused" in result && typeof result.reused === "boolean" ? result.reused : undefined;
  return {
    ok: true,
    number: result.number,
    repoKey: backend.key,
    url: result.url,
    labels: result.labels,
    labelsFailed: result.labelsFailed,
    ...(localPath === undefined ? {} : { path: localPath }),
    ...(localReused === undefined ? {} : { reused: localReused }),
    ...(chainWarnings.length ? { warnings: chainWarnings } : {}),
  };
}

export async function setIssueLabelsHandler(input: SetLabelsInput): Promise<RpcOutput<typeof issuesSetLabelsRpc>> {
  const backend = await resolveWritableBackend(input.workspaceDir, "改标签", input.repoKey);
  if (!backend.ok) return backend;
  if (input.kind === "pull-request") {
    return { ok: false, reason: "invalid", detail: "拉取请求的标签是只读的，请到远端网页上修改" };
  }

  if (backend.kind === "local") {
    const result = await replaceLocalLabels(backend.workspaceDir, input.number, input.labels);
    if (!result.ok) {
      record("error", "issues.labels", `#${input.number} 改标签失败：${result.detail.slice(0, 200)}`);
      return result;
    }
    record("info", "issues.labels", `#${input.number} 标签改为 ${result.labels.map((label) => label.name).join("、") || "空"}`);
    return { ok: true, labels: result.labels };
  }

  // 与 MCP 出口同一条不变量：PUT 是整体替换，读不全现有标签就不许改。
  // 这里走 issue 详情，也就顺带挡住了「编号其实是 PR」的误写：PR 在 issue(number) 下不存在。
  if (backend.kind === "gitlab") {
    const guard = await getGitLabIssue(backend.ref.owner, backend.ref.name, input.number);
    if (!guard.ok) {
      record("warn", "issues.labels", `#${input.number} 拒绝改标签：${guard.detail.slice(0, 200)}`);
      return { ok: false, reason: guard.reason, detail: guard.detail };
    }
    if (guard.meta.labelsTruncated) {
      const detail = `#${input.number} 的标签太多，本次只读到 ${guard.issue.labels.length} 个（共 ${guard.meta.labelCount} 个）；整体替换会删掉没读到的标签`;
      record("warn", "issues.labels", `#${input.number} 拒绝改标签：标签读不全`);
      return { ok: false, reason: "labels-truncated", detail };
    }
  } else {
    const guard = await assertLabelsReadable(backend.ref.owner, backend.ref.name, input.number);
    if (!guard.ok) {
      record("warn", "issues.labels", `#${input.number} 拒绝改标签：${guard.detail.slice(0, 200)}`);
      return guard;
    }
  }

  const result =
    backend.kind === "gitlab"
      ? await setGitLabLabels(backend.ref.owner, backend.ref.name, input.number, input.labels)
      : await replaceLabels(backend.ref.owner, backend.ref.name, input.number, input.labels);
  if (!result.ok) {
    record("error", "issues.labels", `#${input.number} 改标签失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.labels", `#${input.number} 标签改为 ${result.labels.map((label) => label.name).join("、") || "空"}`);
  return { ok: true, labels: result.labels };
}

export async function assignIssueHandler(input: AssignInput): Promise<RpcOutput<typeof issuesAssignRpc>> {
  const backend = await resolveWritableBackend(input.workspaceDir, "接手", input.repoKey);
  if (!backend.ok) return backend;
  if (backend.kind === "local") return localAssignUnsupported();

  const result =
    backend.kind === "gitlab"
      ? await takeGitLabIssue(backend.ref.owner, backend.ref.name, input.number, input.take)
      : await takeIssue(backend.ref.owner, backend.ref.name, input.number, input.take);
  if (!result.ok) {
    record("error", "issues.assign", `#${input.number} ${input.take ? "接手" : "放手"}失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.assign", `#${input.number} ${input.take ? `已指派给 ${result.login}` : `已移除 ${result.login}`}`);
  return result;
}

export async function setIssueStateHandler(
  input: StateInput,
  context?: unknown,
): Promise<RpcOutput<typeof issuesStateRpc>> {
  const options = handlerOptions(context);
  const backend = await resolveWritableBackend(input.workspaceDir, "关票", input.repoKey);
  if (!backend.ok) return backend;

  // 关需求前先把正文与「挂着的验收票」读一遍：关票后票面仍要留下未验收痕迹。
  // 读失败不挡关票——但必须变成 warning，不能当成「没有需求这回事」。
  const warnings: string[] = [];
  let pendingRecord: { readonly body: string; readonly append: string } | null = null;
  if (input.state === "closed") {
    const read = await readIssue(input.workspaceDir, input.number, {
      ...(input.repoKey ? { repoKey: input.repoKey } : {}),
    });
    if (!read.ok) {
      warnings.push(`关票前读不到这张票（${read.detail}），没有追加验收痕迹。`);
    } else if (!read.result.ok) {
      warnings.push(`关票前读不到这张票（${read.result.detail}），没有追加验收痕迹。`);
    } else {
      const issue = read.result.issue;
      const isRequirement = labelNames(issue.labels).some((name) => name.toLowerCase() === REQUIREMENT_LABEL);
      if (isRequirement) {
        const body = typeof issue.body === "string" ? issue.body : "";
        const judged = await acceptanceRecordForClose({
          workspaceDir: input.workspaceDir,
          requirementBody: body,
          requirementRepoKey: read.repoKey,
          closedOn: formatDay((options.now ?? (() => new Date()))()),
          ...(options.reader ? { reader: options.reader } : {}),
        });
        warnings.push(...judged.warnings);
        if (judged.append) pendingRecord = { body, append: judged.append };
      }
    }
  }

  const result =
    backend.kind === "local"
      ? await setLocalIssueState(backend.workspaceDir, input.number, input.state)
      : backend.kind === "gitlab"
        ? input.state === "closed"
          ? await closeGitLabIssue(backend.ref.owner, backend.ref.name, input.number)
          : await reopenGitLabIssue(backend.ref.owner, backend.ref.name, input.number)
        : await setIssueState(backend.ref.owner, backend.ref.name, input.number, input.state);
  if (!result.ok) {
    record("error", "issues.state", `#${input.number} 状态改为 ${input.state} 失败：${result.detail.slice(0, 200)}`);
    return result;
  }

  // 关票已经成功：痕迹写不进去只提示，不回滚、不把「已关」说成失败。
  if (pendingRecord) {
    const body = `${pendingRecord.body.replace(/\s+$/, "")}\n\n${pendingRecord.append}\n`;
    const patched =
      backend.kind === "local"
        ? await patchLocalIssue(backend.workspaceDir, input.number, { body })
        : backend.kind === "gitlab"
          ? await updateGitLabIssue(backend.ref.owner, backend.ref.name, input.number, { body })
          : await patchIssue(backend.ref.owner, backend.ref.name, input.number, { body });
    if (!patched.ok) {
      const warning = `票已关闭，但验收痕迹没写成：${patched.detail.slice(0, 200)}`;
      warnings.push(warning);
      record("warn", "issues.state", `#${input.number} ${warning}`);
    } else {
      record("info", "issues.state", `#${input.number} 已在正文追加「${pendingRecord.append}」`);
    }
  }

  record("info", "issues.state", `#${input.number} 已${input.state === "closed" ? "关闭" : "重开"}`);
  return {
    ok: true,
    state: result.state,
    ...(warnings.length ? { warnings } : {}),
  };
}
