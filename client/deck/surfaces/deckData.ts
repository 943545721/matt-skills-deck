import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { BoardIssue } from "../../../shared/issues.ts";
import { issuesDetailRpc, issuesListRpc } from "../../../shared/issues.ts";
import { repoTargetsRpc } from "../../../shared/repo.ts";
import { buildAttachmentSnapshot } from "../../../shared/slash.ts";
import type { AttachmentSnapshot } from "../../../shared/slash.ts";
import type { PromptActionContext } from "../../../shared/session.ts";

/**
 * 座位层与票面之间的薄读取层。
 *
 * 只做三件事：读板、读一张票（含多仓库按号回退）、把票转成 SessionSheet 的上下文。
 * 所有失败都回 `{ok:false, error}`，让每个座位决定是显示错误还是禁用按钮；
 * 不抛异常、不编默认票。
 */

export interface BoardRead {
  issues: BoardIssue[];
  failures: Array<{ repoKey: string; reason: string; detail: string }>;
  totalCount: number;
  hasMore: boolean;
  fetchedAt: string;
}

export type BoardResult = ({ ok: true } & BoardRead) | { ok: false; error: string };

/** 只要一个 RPC 入口：客户端控件传 `client`，slash 回调传命令上下文，两者都满足。 */
export type RpcHost = Pick<PluginClientContext, "rpc">;

export interface TicketDetail {
  repoKey: string;
  issue: {
    number: number;
    title: string;
    state: "OPEN" | "CLOSED";
    url: string;
    body: string;
    labels: Array<{ name: string; color: string }>;
    assignees: string[];
    isMap: boolean;
    kind: "issue" | "pull-request";
  };
  comments: Array<{ author: string; createdAt: string; body: string }>;
  commentCount: number;
  snapshot: AttachmentSnapshot;
}

export type TicketResult = ({ ok: true } & TicketDetail) | { ok: false; error: string };

const failureText = (reason: string, detail: string): string => `${reason}: ${detail}`;

export async function readBoard(
  client: RpcHost,
  workspaceDir: string,
  options: { view?: "all" | "open" | "closed" | "ready" | "blocked" | "merged"; limit?: number } = {},
): Promise<BoardResult> {
  if (!workspaceDir) return { ok: false, error: "workspace directory unknown" };
  try {
    const result = await client.rpc(issuesListRpc, {
      workspaceDir,
      view: options.view ?? "open",
      limit: options.limit ?? 100,
    });
    if (!result.ok) return { ok: false, error: failureText(result.reason, result.detail) };
    return {
      ok: true,
      issues: result.issues,
      failures: result.failures,
      totalCount: result.totalCount,
      hasMore: result.hasMore,
      fetchedAt: result.fetchedAt,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 多仓库且没给 repoKey 时，按号逐个仓库回退；只回退「未找到」类失败，权限/网络错误不重复打。 */
async function readDetail(
  client: RpcHost,
  workspaceDir: string,
  number: number,
  repoKey?: string,
) {
  const first = await client.rpc(issuesDetailRpc, {
    workspaceDir,
    number,
    ...(repoKey ? { repoKey } : {}),
  });
  if (first.ok || repoKey) return first;
  if (first.reason !== "not-found" && first.reason !== "invalid") return first;
  const targets = await client.rpc(repoTargetsRpc, { workspaceDir });
  if (!targets.ok || targets.kind !== "repos") return first;
  for (const repo of targets.repos) {
    if (repo.key === targets.defaultKey) continue;
    const next = await client.rpc(issuesDetailRpc, { workspaceDir, number, repoKey: repo.key });
    if (next.ok) return next;
    if (next.reason !== "not-found" && next.reason !== "invalid") return next;
  }
  return first;
}

export async function readTicket(
  client: RpcHost,
  workspaceDir: string,
  number: number,
  repoKey?: string,
): Promise<TicketResult> {
  if (!workspaceDir) return { ok: false, error: "workspace directory unknown" };
  try {
    const result = await readDetail(client, workspaceDir, number, repoKey);
    if (!result.ok) return { ok: false, error: failureText(result.reason, result.detail) };
    const snapshot = buildAttachmentSnapshot({
      number: result.issue.number,
      title: result.issue.title,
      body: result.issue.body,
      url: result.issue.url,
      repoKey: result.repoKey,
      state: result.issue.state,
      labels: result.issue.labels,
      assignees: result.issue.assignees,
      comments: result.comments,
      commentCount: result.commentCount,
    });
    return {
      ok: true,
      repoKey: result.repoKey,
      issue: {
        number: result.issue.number,
        title: result.issue.title,
        state: result.issue.state,
        url: result.issue.url,
        body: result.issue.body,
        labels: result.issue.labels,
        assignees: result.issue.assignees,
        isMap: result.issue.isMap,
        kind: result.issue.kind,
      },
      comments: result.comments,
      commentCount: result.commentCount,
      snapshot,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 票 → SessionSheet 的动作上下文。lang 由调用方补。 */
export function ticketContext(issue: {
  repoKey: string;
  number: number;
  title: string;
  url: string;
}): Omit<PromptActionContext, "lang"> {
  return {
    repoKey: issue.repoKey,
    number: issue.number,
    title: issue.title,
    url: issue.url,
  };
}

export const promptProvider = (provider: string | null | undefined, model: string | null | undefined): string | null => {
  const name = provider?.trim();
  if (!name) return null;
  const chosen = model?.trim();
  return chosen ? `${name}/${chosen}` : name;
};
