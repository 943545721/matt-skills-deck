import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { issueAttachmentSearchRpc } from "../../shared/slash.ts";
import { buildAttachmentSnapshot, type AttachmentCommentInput } from "../../shared/slash.ts";
import type { BoardIssue } from "../../shared/issues.ts";
import { readBoard, readIssue } from "../tracker/read.ts";
import { record } from "../logs.ts";

type AttachmentInput = RpcInput<typeof issueAttachmentSearchRpc>;

/**
 * `/deck` 附件源的服务端搜索。
 *
 * 宿主的附件源契约只把 `{query}` 交给插件（没有 workspace 上下文），
 * 但 handler 拿得到 `context.paseo`：从工作区目录反向解析出项目根，
 * 每个项目根读一次任务板，再按票号或标题匹配。同一项目下的多个 worktree
 * 共用同一个 projectRootPath，所以这里按项目去重，不会为每个 worktree 重读一遍。
 *
 * 匹配只读薄行；真正要交给会话的正文与评论，只对最终入选的那几条读详情。
 * 任何一条读失败都不伪造快照：跳过该条，并在日志里留原因。
 */

/** 一次搜索最多回多少条：附件选择器是给人挑的，不是任务板列表。 */
const ATTACHMENT_LIMIT = 20;
/** 读板与读详情的并发度：与任务板读路径一致，不把远端额度一次打满。 */
const CONCURRENCY = 4;

interface ProjectRoot {
  dir: string;
  name: string;
}

function projectRootsOf(entries: readonly { projectRootPath: string; name?: string }[]): ProjectRoot[] {
  const seen = new Set<string>();
  const roots: ProjectRoot[] = [];
  for (const entry of entries) {
    const dir = entry.projectRootPath.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    roots.push({ dir, name: entry.name ?? dir });
  }
  return roots;
}

/** 票号匹配：`12` 或 `#12` 只认这一张；其余当标题子串。 */
function numberQuery(query: string): number | null {
  const match = /^#?(\d+)$/.exec(query.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function matches(issue: BoardIssue, query: string, number: number | null): boolean {
  if (number !== null) return issue.number === number;
  if (!query) return true;
  return issue.title.toLowerCase().includes(query.toLowerCase());
}

async function boardOf(root: ProjectRoot): Promise<BoardIssue[]> {
  const read = await readBoard(root.dir, { limit: 100, includeClosed: true, view: "all" });
  if (!read.ok) {
    record("warn", "attachment.search", `${root.name} 读板失败：${read.detail.slice(0, 160)}`);
    return [];
  }
  return read.issues.filter((issue) => issue.kind === "issue");
}

async function inBatches<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(index, index + CONCURRENCY).map(worker))));
  }
  return out;
}

export async function searchIssueAttachmentsHandler(
  input: AttachmentInput,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof issueAttachmentSearchRpc>> {
  const listed = await context.paseo.workspaces.list({});
  const roots = projectRootsOf(listed.entries);
  if (roots.length === 0) return { items: [] };

  const query = input.query.trim();
  const number = numberQuery(query);
  const boards = await inBatches(roots, async (root) => ({ root, issues: await boardOf(root) }));

  type Match = { root: ProjectRoot; issue: BoardIssue };
  const seen = new Set<string>();
  const matched: Match[] = [];
  for (const board of boards) {
    for (const issue of board.issues) {
      if (!matches(issue, query, number)) continue;
      const key = `${issue.repoKey}#${issue.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push({ root: board.root, issue });
    }
  }
  matched.sort((left, right) => right.issue.updatedAt.localeCompare(left.issue.updatedAt));
  const selected = matched.slice(0, ATTACHMENT_LIMIT);

  const items = await inBatches(selected, async ({ root, issue }) => {
    const read = await readIssue(root.dir, issue.number, { repoKey: issue.repoKey });
    if (!read.ok) {
      record("warn", "attachment.search", `#${issue.number} 详情失败：${read.detail.slice(0, 160)}`);
      return null;
    }
    if (!read.result.ok) {
      record("warn", "attachment.search", `#${issue.number} 详情失败：${read.result.detail.slice(0, 160)}`);
      return null;
    }
    const detail = read.result;
    const comments: AttachmentCommentInput[] = detail.comments.map((comment) => ({
      author: comment.author,
      createdAt: comment.createdAt,
      body: comment.body,
    }));
    return buildAttachmentSnapshot({
      number: detail.issue.number,
      title: detail.issue.title,
      body: detail.issue.body,
      url: detail.issue.url,
      repoKey: read.repoKey,
      state: detail.issue.state,
      labels: detail.issue.labels,
      assignees: detail.issue.assignees,
      comments,
      commentCount: detail.meta.commentCount,
    });
  });

  return { items: items.filter((item): item is NonNullable<typeof item> => item !== null) };
}
