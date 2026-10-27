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
import { assertLabelsReadable } from "../tracker/label-guard.ts";
import { createIssue, postComment, replaceLabels, setIssueState, takeIssue } from "../tracker/write.ts";
import { resolveWritableBackend } from "../tracker/backend.ts";
import { readBoard, readIssue } from "../tracker/read.ts";
import {
  createLocalIssue,
  localAssignUnsupported,
  postLocalComment,
  replaceLocalLabels,
  setLocalIssueState,
} from "../tracker/local.ts";
import { record } from "../logs.ts";

type ListInput = RpcInput<typeof issuesListRpc>;
type DetailInput = RpcInput<typeof issuesDetailRpc>;
type CommentInput = RpcInput<typeof issuesCommentRpc>;
type CreateInput = RpcInput<typeof issuesCreateRpc>;
type SetLabelsInput = RpcInput<typeof issuesSetLabelsRpc>;
type AssignInput = RpcInput<typeof issuesAssignRpc>;
type StateInput = RpcInput<typeof issuesStateRpc>;

const MAP_LABEL = "wayfinder:map";

export async function listIssuesHandler(input: ListInput): Promise<RpcOutput<typeof issuesListRpc>> {
  const view = input.view ?? (input.includeClosed ? "all" : "open");
  // 状态过滤下推到查询：只取「最近 100 条（开+关）」再本地筛 open，会在关闭票更新频繁时
  // 把 open 视图显示成只剩几条，而 totalCount 还是全仓库的数——两个数对不上，谁都不敢信。
  // blocked / ready 必须在打开票里算（关闭票再也不可能可接），所以也用 open 窗口。
  const read = await readBoard(input.workspaceDir, {
    limit: input.limit ?? 100,
    includeClosed: view === "all",
    view,
  });
  if (!read.ok) return read;
  const result = read.result;
  // 失败也带上仓库：顶栏据此显示 owner/name，只有远端没解析出来时才退回「未关联仓库」。
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail, repo: read.repo };

  // 计数先于页签筛选：切到 PR 页签时 KPI 仍是同一口径，不会因为当前页签而变。
  const afterLabel = filterBoard(result.issues, { label: input.label });
  const counts = countBoard(afterLabel);
  const visible = filterBoard(result.issues, { view, kind: input.kind, label: input.label });

  return {
    ok: true,
    repo: read.repo,
    issues: sortBoard(visible, input.sort ?? "updated"),
    totalCount: result.totalCount,
    fetchedAt: result.fetchedAt,
    hasMore: result.hasMore,
    counts,
    source: result.source,
    rateLimit: result.rateLimit,
  };
}

export async function getIssueHandler(input: DetailInput): Promise<RpcOutput<typeof issuesDetailRpc>> {
  const read = await readIssue(input.workspaceDir, input.number, input.kind ?? "issue");
  if (!read.ok) return read;
  const result = read.result;
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail, repo: read.repo };
  return {
    ok: true,
    repo: read.repo,
    issue: { ...result.issue, labelCount: result.meta.labelCount },
    comments: result.comments,
    commentCount: result.meta.commentCount,
  };
}

export async function commentIssueHandler(input: CommentInput): Promise<RpcOutput<typeof issuesCommentRpc>> {
  const backend = await resolveWritableBackend(input.workspaceDir, "评论");
  if (!backend.ok) return backend;
  // PR 的评论在源仓库是只读的：不能因为编号空间共用，就把一条针对 PR 的评论写到同号 issue 上。
  if (input.kind === "pull-request") {
    return { ok: false, reason: "invalid", detail: "拉取请求的评论是只读的，请到 GitHub 上回复" };
  }

  const result =
    backend.kind === "local"
      ? await postLocalComment(backend.workspaceDir, input.number, input.body)
      : await postComment(backend.ref.owner, backend.ref.name, input.number, input.body);
  if (!result.ok) {
    record("error", "issues.comment", `#${input.number} 失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.comment", `#${input.number} 已评论`);
  return { ok: true, comment: result.comment };
}

export async function createIssueHandler(input: CreateInput): Promise<RpcOutput<typeof issuesCreateRpc>> {
  const backend = await resolveWritableBackend(input.workspaceDir, "新建票");
  if (!backend.ok) return backend;

  // 勾了「地图」就自动带 wayfinder:map：源仓库里地图票就是靠这个标签认出来的，
  // 让用户自己记得手打字符串迟早会漏。
  const labels = [...(input.labels ?? [])];
  if (input.isMap && !labels.includes(MAP_LABEL)) labels.push(MAP_LABEL);

  const result =
    backend.kind === "local"
      ? await createLocalIssue(backend.workspaceDir, { title: input.title, body: input.body ?? "", labels })
      : await createIssue(backend.ref.owner, backend.ref.name, {
          title: input.title,
          body: input.body ?? "",
          labels,
        });
  if (!result.ok) {
    record("error", "issues.create", `新建失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record(result.labelsFailed ? "warn" : "info", "issues.create", `#${result.number} 已建${result.labelsFailed ? "（标签未挂上）" : ""}`);
  return {
    ok: true,
    number: result.number,
    url: result.url,
    labels: result.labels,
    labelsFailed: result.labelsFailed,
  };
}

export async function setIssueLabelsHandler(input: SetLabelsInput): Promise<RpcOutput<typeof issuesSetLabelsRpc>> {
  const backend = await resolveWritableBackend(input.workspaceDir, "改标签");
  if (!backend.ok) return backend;
  if (input.kind === "pull-request") {
    return { ok: false, reason: "invalid", detail: "拉取请求的标签是只读的，请到 GitHub 上修改" };
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
  const guard = await assertLabelsReadable(backend.ref.owner, backend.ref.name, input.number);
  if (!guard.ok) {
    record("warn", "issues.labels", `#${input.number} 拒绝改标签：${guard.detail.slice(0, 200)}`);
    return guard;
  }

  const result = await replaceLabels(backend.ref.owner, backend.ref.name, input.number, input.labels);
  if (!result.ok) {
    record("error", "issues.labels", `#${input.number} 改标签失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.labels", `#${input.number} 标签改为 ${result.labels.map((label) => label.name).join("、") || "空"}`);
  return { ok: true, labels: result.labels };
}

export async function assignIssueHandler(input: AssignInput): Promise<RpcOutput<typeof issuesAssignRpc>> {
  const backend = await resolveWritableBackend(input.workspaceDir, "接手");
  if (!backend.ok) return backend;
  if (backend.kind === "local") return localAssignUnsupported();

  const result = await takeIssue(backend.ref.owner, backend.ref.name, input.number, input.take);
  if (!result.ok) {
    record("error", "issues.assign", `#${input.number} ${input.take ? "接手" : "放手"}失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.assign", `#${input.number} ${input.take ? `已指派给 ${result.login}` : `已移除 ${result.login}`}`);
  return result;
}

export async function setIssueStateHandler(input: StateInput): Promise<RpcOutput<typeof issuesStateRpc>> {
  const backend = await resolveWritableBackend(input.workspaceDir, "关票");
  if (!backend.ok) return backend;

  const result =
    backend.kind === "local"
      ? await setLocalIssueState(backend.workspaceDir, input.number, input.state)
      : await setIssueState(backend.ref.owner, backend.ref.name, input.number, input.state);
  if (!result.ok) {
    record("error", "issues.state", `#${input.number} 状态改为 ${input.state} 失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.state", `#${input.number} 已${input.state === "closed" ? "关闭" : "重开"}`);
  return result;
}
