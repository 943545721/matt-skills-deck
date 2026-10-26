import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  issuesCommentRpc,
  issuesCreateRpc,
  issuesDetailRpc,
  issuesListRpc,
  issuesSetLabelsRpc,
} from "../../shared/issues.ts";
import { getIssue, listIssues } from "../tracker/github.ts";
import { sortIssues } from "../tracker/order.ts";
import { createIssue, postComment, replaceLabels } from "../tracker/write.ts";
import { record } from "../logs.ts";
import { requireGithubRepo } from "./repo-gate.ts";

type ListInput = RpcInput<typeof issuesListRpc>;
type DetailInput = RpcInput<typeof issuesDetailRpc>;
type CommentInput = RpcInput<typeof issuesCommentRpc>;
type CreateInput = RpcInput<typeof issuesCreateRpc>;
type SetLabelsInput = RpcInput<typeof issuesSetLabelsRpc>;

const MAP_LABEL = "wayfinder:map";

export async function listIssuesHandler(input: ListInput): Promise<RpcOutput<typeof issuesListRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "任务板");
  if (!gate.ok) return gate;

  // 状态过滤下推到查询：只取「最近 100 条（开+关）」再本地筛 open，会在关闭票更新频繁时
  // 把 open 视图显示成只剩几条，而 totalCount 还是全仓库的数——两个数对不上，谁都不敢信。
  const result = await listIssues(
    gate.ref.owner,
    gate.ref.name,
    input.limit ?? 100,
    input.includeClosed ? undefined : "OPEN",
  );
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };

  return {
    ok: true,
    repo: gate.repo,
    issues: sortIssues(result.issues),
    totalCount: result.totalCount,
    fetchedAt: result.fetchedAt,
  };
}

export async function getIssueHandler(input: DetailInput): Promise<RpcOutput<typeof issuesDetailRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "票面详情");
  if (!gate.ok) return gate;

  const result = await getIssue(gate.ref.owner, gate.ref.name, input.number);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason === "gh-missing" ? "gh-missing" : result.reason === "not-found" ? "not-found" : "gh-failed",
      detail: result.detail,
    };
  }
  return {
    ok: true,
    repo: gate.repo,
    issue: { ...result.issue, labelCount: result.meta.labelCount },
    comments: result.comments,
    commentCount: result.meta.commentCount,
  };
}

export async function commentIssueHandler(input: CommentInput): Promise<RpcOutput<typeof issuesCommentRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "评论");
  if (!gate.ok) return gate;

  const result = await postComment(gate.ref.owner, gate.ref.name, input.number, input.body);
  if (!result.ok) {
    record("error", "issues.comment", `#${input.number} 失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.comment", `#${input.number} 已评论`);
  return { ok: true, comment: result.comment };
}

export async function createIssueHandler(input: CreateInput): Promise<RpcOutput<typeof issuesCreateRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "新建票");
  if (!gate.ok) return gate;

  // 勾了「地图」就自动带 wayfinder:map：源仓库里地图票就是靠这个标签认出来的，
  // 让用户自己记得手打字符串迟早会漏。
  const labels = [...(input.labels ?? [])];
  if (input.isMap && !labels.includes(MAP_LABEL)) labels.push(MAP_LABEL);

  const result = await createIssue(gate.ref.owner, gate.ref.name, {
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
  const gate = await requireGithubRepo(input.workspaceDir, "改标签");
  if (!gate.ok) return gate;

  const result = await replaceLabels(gate.ref.owner, gate.ref.name, input.number, input.labels);
  if (!result.ok) {
    record("error", "issues.labels", `#${input.number} 改标签失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "issues.labels", `#${input.number} 标签改为 ${result.labels.map((label) => label.name).join("、") || "空"}`);
  return { ok: true, labels: result.labels };
}
