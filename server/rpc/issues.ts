import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  issuesCommentRpc,
  issuesCreateRpc,
  issuesDetailRpc,
  issuesListRpc,
  issuesSetLabelsRpc,
} from "../../shared/issues.ts";
import type { RemoteRef } from "../tracker/remote.ts";
import { getIssue, listIssues } from "../tracker/github.ts";
import { sortIssues } from "../tracker/order.ts";
import { parseRemoteUrl, readRemoteUrl } from "../tracker/remote.ts";
import { createIssue, postComment, replaceLabels } from "../tracker/write.ts";

type ListInput = RpcInput<typeof issuesListRpc>;
type DetailInput = RpcInput<typeof issuesDetailRpc>;
type CommentInput = RpcInput<typeof issuesCommentRpc>;
type CreateInput = RpcInput<typeof issuesCreateRpc>;
type SetLabelsInput = RpcInput<typeof issuesSetLabelsRpc>;

interface RepoOut {
  host: RemoteRef["host"];
  owner: string;
  name: string;
  webUrl: string | null;
}

type RemoteHost = RemoteRef["host"];

type Resolved =
  | { ok: true; ref: RemoteRef; repo: RepoOut }
  | { ok: false; reason: "no-repo" | "unsupported-host"; detail: string };

const WEB_HOSTS: Record<RemoteHost, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  other: "",
};

const MAP_LABEL = "wayfinder:map";

/**
 * 工作区 → 仓库坐标。读写全部路径共用这一处，保证「同一个工作区看到、写到的都是同一个仓库」。
 */
async function resolveRepo(workspaceDir: string): Promise<Resolved> {
  const remote = await readRemoteUrl(workspaceDir);
  if (!remote) {
    return {
      ok: false,
      reason: "no-repo",
      detail: "这个工作区没有可用的 git 远端（origin / upstream），先关联一个 GitHub 仓库再试",
    };
  }
  const ref = parseRemoteUrl(remote);
  if (!ref) {
    return { ok: false, reason: "no-repo", detail: `无法识别远端地址：${remote}` };
  }
  const webHost = WEB_HOSTS[ref.host];
  return {
    ok: true,
    ref,
    repo: {
      host: ref.host,
      owner: ref.owner,
      name: ref.name,
      webUrl: webHost ? `${webHost}/${ref.owner}/${ref.name}` : null,
    },
  };
}

/**
 * 读写共用的前置：解析仓库 + 只放 GitHub 过。
 *
 * 写操作尤其需要这道闸：GitLab 的写接口没接，若不拦，用户点「提交评论」会得到
 * 一个「成功」的假象（其实什么都没发生），比明确说「这个后端还写不了」糟得多。
 */
async function requireGithubRepo(workspaceDir: string, action: string): Promise<
  { ok: true; ref: RemoteRef; repo: RepoOut } | { ok: false; reason: "no-repo" | "unsupported-host"; detail: string }
> {
  const resolved = await resolveRepo(workspaceDir);
  if (!resolved.ok) return resolved;
  if (resolved.ref.host !== "github") {
    return {
      ok: false,
      reason: "unsupported-host",
      detail: `当前远端是 ${resolved.ref.host}，${action}只接了 GitHub；GitLab 与本地 Markdown 后端在后续阶段补上`,
    };
  }
  return resolved;
}

export async function listIssuesHandler(input: ListInput): Promise<RpcOutput<typeof issuesListRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "任务板");
  if (!gate.ok) return gate;

  const result = await listIssues(gate.ref.owner, gate.ref.name, input.limit ?? 100);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };

  const visible = input.includeClosed
    ? result.issues
    : result.issues.filter((issue) => issue.state === "OPEN");
  return {
    ok: true,
    repo: gate.repo,
    issues: sortIssues(visible),
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
  return { ok: true, repo: gate.repo, issue: result.issue, comments: result.comments };
}

export async function commentIssueHandler(input: CommentInput): Promise<RpcOutput<typeof issuesCommentRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "评论");
  if (!gate.ok) return gate;

  const result = await postComment(gate.ref.owner, gate.ref.name, input.number, input.body);
  if (!result.ok) return result;
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
  if (!result.ok) return result;
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
  if (!result.ok) return result;
  return { ok: true, labels: result.labels };
}
