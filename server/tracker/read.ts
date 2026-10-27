import type { ItemKind, ListView } from "../../shared/issues.ts";
import type { RepoOut } from "../rpc/repo-gate.ts";
import { resolveBackend, type Backend } from "./backend.ts";
import { getIssue, listIssues, type IssueDetailResult, type ListIssuesResult } from "./github.ts";
import { getGitLabIssue, listGitLabIssues } from "./gitlab.ts";
import { getLocalIssue, listLocalIssues } from "./local.ts";

/**
 * 读路径的统一入口。
 *
 * 面板、地图、MCP 各自处理「远端是什么后端」就会分叉；这里只回答一个问题：
 * 给定工作区，按当前设置应该读到哪一份数据。失败也带着已经认出来的 repo，
 * 顶栏才能在「读不到票」时仍显示仓库名。
 */

export interface BoardRead {
  ok: true;
  backend: Backend;
  repo: RepoOut;
  result: ListIssuesResult;
}

export interface IssueRead {
  ok: true;
  backend: Backend;
  repo: RepoOut;
  result: IssueDetailResult;
}

export interface BackendReadFailure {
  ok: false;
  reason: "no-repo" | "unsupported-host";
  detail: string;
  repo?: RepoOut;
}

export async function readBoard(
  workspaceDir: string,
  options: { limit?: number; view?: ListView; includeClosed?: boolean } = {},
): Promise<BoardRead | BackendReadFailure> {
  const backend = await resolveBackend(workspaceDir, "任务板");
  if (!backend.ok) return backend;

  let result: ListIssuesResult;
  if (backend.kind === "github") {
    result = await listIssues(backend.ref.owner, backend.ref.name, options);
  } else if (backend.kind === "gitlab") {
    result = await listGitLabIssues(backend.ref.owner, backend.ref.name, options);
  } else {
    result = await listLocalIssues(backend.workspaceDir, options);
  }
  return { ok: true, backend, repo: backend.repo, result };
}

export async function readIssue(workspaceDir: string, number: number, kind: ItemKind = "issue"): Promise<IssueRead | BackendReadFailure> {
  const backend = await resolveBackend(workspaceDir, "票面详情");
  if (!backend.ok) return backend;

  let result: IssueDetailResult;
  if (backend.kind === "github") {
    result = await getIssue(backend.ref.owner, backend.ref.name, number, kind);
  } else if (backend.kind === "gitlab") {
    result = await getGitLabIssue(backend.ref.owner, backend.ref.name, number);
  } else {
    result =
      kind === "pull-request"
        ? { ok: false, reason: "not-found", detail: "本地 Markdown 后端只存票，没有拉取请求" }
        : await getLocalIssue(backend.workspaceDir, number);
  }
  return { ok: true, backend, repo: backend.repo, result };
}
