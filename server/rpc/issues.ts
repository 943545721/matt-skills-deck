import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { issuesDetailRpc, issuesListRpc } from "../../shared/issues.ts";
import type { RemoteRef } from "../tracker/remote.ts";
import { getIssue, listIssues } from "../tracker/github.ts";
import { sortIssues } from "../tracker/order.ts";
import { parseRemoteUrl, readRemoteUrl } from "../tracker/remote.ts";

type ListInput = RpcInput<typeof issuesListRpc>;
type DetailInput = RpcInput<typeof issuesDetailRpc>;

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

/**
 * 工作区 → 仓库坐标。全部读路径共用这一处，保证「同一个工作区看到同一个仓库」。
 */
async function resolveRepo(workspaceDir: string): Promise<Resolved> {
  const remote = await readRemoteUrl(workspaceDir);
  if (!remote) {
    return { ok: false, reason: "no-repo", detail: "这个工作区没有可用的 git 远端（origin / upstream），先关联一个 GitHub 仓库再试" };
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

export async function listIssuesHandler(input: ListInput): Promise<RpcOutput<typeof issuesListRpc>> {
  const resolved = await resolveRepo(input.workspaceDir);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, detail: resolved.detail };
  if (resolved.ref.host !== "github") {
    return {
      ok: false,
      reason: "unsupported-host",
      detail: `当前远端是 ${resolved.ref.host}，P2 只接了 GitHub；GitLab 与本地 Markdown 后端在后续阶段补上`,
    };
  }

  const result = await listIssues(resolved.ref.owner, resolved.ref.name, input.limit ?? 100);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };

  const visible = input.includeClosed
    ? result.issues
    : result.issues.filter((issue) => issue.state === "OPEN");
  return {
    ok: true,
    repo: resolved.repo,
    issues: sortIssues(visible),
    totalCount: result.totalCount,
    fetchedAt: result.fetchedAt,
  };
}

export async function getIssueHandler(input: DetailInput): Promise<RpcOutput<typeof issuesDetailRpc>> {
  const resolved = await resolveRepo(input.workspaceDir);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, detail: resolved.detail };
  if (resolved.ref.host !== "github") {
    return {
      ok: false,
      reason: "unsupported-host",
      detail: `当前远端是 ${resolved.ref.host}，详情页 P2 只接了 GitHub`,
    };
  }

  const result = await getIssue(resolved.ref.owner, resolved.ref.name, input.number);
  if (!result.ok) {
    // 详情把 not-found 归到 gh-failed 一类给界面：两者对用户都是「这张票现在打不开」。
    return {
      ok: false,
      reason: result.reason === "gh-missing" ? "gh-missing" : "gh-failed",
      detail: result.detail,
    };
  }
  return { ok: true, repo: resolved.repo, issue: result.issue, comments: result.comments };
}
