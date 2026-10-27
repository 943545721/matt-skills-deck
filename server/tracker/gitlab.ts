import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ListView } from "../../shared/issues.ts";
import type { Issue, IssueDetailResult, ListIssuesResult } from "./github.ts";
import { readinessOf } from "./readiness.ts";

const execFileAsync = promisify(execFile);

/**
 * GitLab 只读后端（`glab api`）。
 *
 * 为什么只读：GitLab 的写接口（评论、标签、状态）与 GitHub 的参数和回包都不一样，
 * 在没有真正跑通之前放行，用户会看到「成功」而远端什么也没发生——那比明确说「暂时只读」糟得多。
 *
 * 编号空间：GitLab 的 issue 与 merge request 是两套独立编号，不像 GitHub 共用，
 * 所以这里只取 issue；界面上的「拉取请求」页签在 GitLab 下是空的，而不是把 MR 混进票号。
 */

export type GlabFailureReason = "glab-missing" | "glab-unauth" | "glab-failed";

export interface GlabFailure {
  ok: false;
  reason: GlabFailureReason;
  detail: string;
}

const UNAUTH_HINT = /glab auth login|no token|unauthorized|401/i;

export function classifyGlabError(error: unknown): { reason: GlabFailureReason; detail: string } {
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") {
    return { reason: "glab-missing", detail: "没有找到 glab 命令：装好 GitLab CLI 后执行 glab auth login" };
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" ? stderr.trim() : "";
  if (text && UNAUTH_HINT.test(text)) return { reason: "glab-unauth", detail: text.slice(0, 800) };
  if (typeof code === "number") return { reason: "glab-failed", detail: text.slice(0, 800) || `glab 退出码 ${code}，没有输出错误信息` };
  return { reason: "glab-failed", detail: text.slice(0, 800) || (error instanceof Error ? error.message : String(error)) };
}

async function runGlab(args: string[]): Promise<{ ok: true; stdout: string } | GlabFailure> {
  try {
    const { stdout } = await execFileAsync("glab", args, { timeout: 20_000, maxBuffer: 8 << 20 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, ...classifyGlabError(error) };
  }
}

const projectId = (owner: string, name: string) => encodeURIComponent(`${owner}/${name}`);

const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

interface RawGitLabIssue {
  iid?: unknown;
  title?: unknown;
  state?: unknown;
  web_url?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  description?: unknown;
  labels?: unknown;
  assignees?: Array<{ username?: unknown }> | null;
}

function mapLabels(raw: unknown): { name: string; color: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const name = typeof item === "string" ? item : asString((item as { name?: unknown } | null)?.name);
    return name ? [{ name, color: "cccccc" }] : [];
  });
}

/**
 * GitLab 的 issue 没有 blockedBy 边（相关链接不是阻塞语义），
 * 所以这些票在 GitLab 下按「无阻塞」计算；界面用 `source: "gitlab"` 提示这层差异。
 */
export function mapGitLabIssues(raw: unknown): Issue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const record = item as RawGitLabIssue | null;
    const number = Number(record?.iid);
    if (!Number.isInteger(number) || number <= 0) return [];
    const labels = mapLabels(record?.labels);
    const base = {
      number,
      title: asString(record?.title, `#${number}`) || `#${number}`,
      state: record?.state === "closed" ? ("CLOSED" as const) : ("OPEN" as const),
      url: asString(record?.web_url),
      updatedAt: asString(record?.updated_at),
      createdAt: asString(record?.created_at) || asString(record?.updated_at),
      labels,
      assignees: (Array.isArray(record?.assignees) ? record.assignees : [])
        .map((entry) => asString(entry.username))
        .filter(Boolean),
      isMap: labels.some((label) => label.name === "wayfinder:map"),
      kind: "issue" as const,
      merged: false,
      blockedBy: [],
    };
    return [{ ...base, readiness: readinessOf(base) }];
  });
}

export interface GitLabListOptions {
  limit?: number;
  view?: ListView;
  includeClosed?: boolean;
}

export async function listGitLabIssues(
  owner: string,
  name: string,
  options: GitLabListOptions = {},
): Promise<ListIssuesResult> {
  const view = options.view ?? (options.includeClosed ? "all" : "open");
  // merge request 不混进 issue 编号空间：合并视图在 GitLab 下就是空的。
  if (view === "merged") {
    return {
      ok: true,
      issues: [],
      totalCount: 0,
      hasMore: false,
      fetchedAt: new Date().toISOString(),
      source: "gitlab",
      rateLimit: null,
    };
  }
  const state = view === "all" ? "all" : view === "closed" ? "closed" : "opened";
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const query = `state=${state}&per_page=${limit}&order_by=updated_at&sort=desc`;
  const result = await runGlab(["api", `projects/${projectId(owner, name)}/issues?${query}`]);
  if (!result.ok) return result;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const issues = mapGitLabIssues(parsed);
    return {
      ok: true,
      issues,
      totalCount: issues.length,
      hasMore: issues.length >= limit,
      fetchedAt: new Date().toISOString(),
      source: "gitlab",
      rateLimit: null,
    };
  } catch {
    return { ok: false, reason: "glab-failed", detail: "GitLab 回包不是合法 JSON" };
  }
}

export async function getGitLabIssue(owner: string, name: string, number: number): Promise<IssueDetailResult> {
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  }
  const id = projectId(owner, name);
  const [issueResult, notesResult] = await Promise.all([
    runGlab(["api", `projects/${id}/issues/${number}`]),
    runGlab(["api", `projects/${id}/issues/${number}/notes?sort=asc&order_by=created_at&per_page=100`]),
  ]);
  if (!issueResult.ok) {
    if (issueResult.reason === "glab-failed" && /404/.test(issueResult.detail)) {
      return { ok: false, reason: "not-found", detail: `GitLab 上找不到 #${number}` };
    }
    return issueResult;
  }
  try {
    const [mapped] = mapGitLabIssues([JSON.parse(issueResult.stdout)]);
    if (!mapped) return { ok: false, reason: "not-found", detail: `GitLab 上找不到 #${number}` };
    const body = asString((JSON.parse(issueResult.stdout) as { description?: unknown } | null)?.description);
    let comments: { author: string; createdAt: string; body: string }[] = [];
    if (notesResult.ok) {
      try {
        const notes: unknown = JSON.parse(notesResult.stdout);
        comments = Array.isArray(notes)
          ? notes.flatMap((note) => {
              const record = note as { author?: { username?: unknown }; created_at?: unknown; body?: unknown; system?: unknown } | null;
              const text = asString(record?.body);
              // 系统便签（label 变更、指派等）不是人写的评论，混进来会让对话看起来很奇怪。
              if (!text || record?.system === true) return [];
              return [{ author: asString(record?.author?.username, "gitlab"), createdAt: asString(record?.created_at), body: text }];
            })
          : [];
      } catch {
        comments = [];
      }
    }
    return {
      ok: true,
      issue: { ...mapped, body },
      comments,
      meta: {
        labelCount: mapped.labels.length,
        labelsTruncated: false,
        commentCount: comments.length,
        commentsTruncated: comments.length >= 100,
        blockersTruncated: false,
      },
    };
  } catch {
    return { ok: false, reason: "glab-failed", detail: "GitLab 回包不是合法 JSON" };
  }
}

export async function listGitLabLabels(
  owner: string,
  name: string,
): Promise<{ ok: true; labels: { name: string; color: string; description: string }[] } | GlabFailure> {
  const result = await runGlab(["api", `projects/${projectId(owner, name)}/labels?per_page=100`]);
  if (!result.ok) return result;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return { ok: true, labels: [] };
    return {
      ok: true,
      labels: parsed.flatMap((item) => {
        const record = item as { name?: unknown; color?: unknown; description?: unknown } | null;
        const label = asString(record?.name);
        if (!label) return [];
        return [
          {
            name: label,
            color: asString(record?.color, "cccccc").replace(/^#/, "").toLowerCase() || "cccccc",
            description: asString(record?.description),
          },
        ];
      }),
    };
  } catch {
    return { ok: false, reason: "glab-failed", detail: "GitLab 标签回包不是合法 JSON" };
  }
}
