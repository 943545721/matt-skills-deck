import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RepoDetail } from "../../shared/repo.ts";
import type { RemoteRef } from "./remote.ts";
import { resolveBackend } from "./backend.ts";
import { classifyGhError } from "./gh-error.ts";
import { classifyGlabError } from "./gitlab.ts";

const execFileAsync = promisify(execFile);

/**
 * 仓库详情的读取。
 *
 * 只读、不写、不改设置。三种后端（GitHub / GitLab / 本地）各自取数，
 * 但都映射成同一份 `RepoDetail`：界面不需要知道底下是 `gh api` 还是 `glab api`。
 *
 * 失败按 `resolveBackend` 的既有分类走，不新造话术；远端 404 单独标 `not-found`，
 * 因为「仓库被改名 / 删了 / 没权限」和「gh 请求失败」的下一步完全不同。
 */
export type RepoInfoFailure = {
  ok: false;
  reason:
    | "no-repo"
    | "unsupported-host"
    | "invalid"
    | "gh-missing"
    | "gh-unauth"
    | "gh-failed"
    | "glab-missing"
    | "glab-unauth"
    | "glab-failed"
    | "not-found"
    | "local-failed";
  detail: string;
};

export type RepoInfoResult = { ok: true; repo: RepoDetail } | RepoInfoFailure;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** GitHub 的计数都是整数；缺字段时给 null，界面据此决定显不显示，而不是当成 0。 */
function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function asTopics(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function asVisibility(value: unknown, isPrivate: unknown): RepoDetail["visibility"] {
  if (value === "public" || value === "private" || value === "internal") return value;
  if (isPrivate === true) return "private";
  return "unknown";
}

/** 纯映射，单独导出：不碰网络就能对着真实回包形状做回归。 */
export function mapGithubRepo(
  raw: unknown,
  fallbackFullName: string,
  fetchedAt: string,
): RepoDetail {
  const record = asRecord(raw) ?? {};
  const license = asRecord(record.license);
  return {
    host: "github",
    fullName: asString(record.full_name) ?? fallbackFullName,
    url: asString(record.html_url),
    description: asString(record.description),
    visibility: asVisibility(record.visibility, record.private),
    defaultBranch: asString(record.default_branch),
    language: asString(record.language),
    stars: asCount(record.stargazers_count),
    forks: asCount(record.forks_count),
    openIssues: asCount(record.open_issues_count),
    pushedAt: asString(record.pushed_at),
    createdAt: asString(record.created_at),
    license: asString(license?.spdx_id) ?? asString(license?.name),
    topics: asTopics(record.topics),
    localDir: null,
    localIssueCount: null,
    localLabelCount: null,
    fetchedAt,
  };
}

export function mapGitlabRepo(
  raw: unknown,
  fallbackFullName: string,
  fetchedAt: string,
): RepoDetail {
  const record = asRecord(raw) ?? {};
  const license = asRecord(record.license);
  return {
    host: "gitlab",
    fullName: asString(record.path_with_namespace) ?? fallbackFullName,
    url: asString(record.web_url),
    description: asString(record.description),
    visibility: asVisibility(record.visibility, undefined),
    defaultBranch: asString(record.default_branch),
    // GitLab 的项目接口不直接给主语言（要再查 languages），这里如实留空。
    language: null,
    stars: asCount(record.star_count),
    forks: asCount(record.forks_count),
    openIssues: asCount(record.open_issues_count),
    pushedAt: asString(record.last_activity_at),
    createdAt: asString(record.created_at),
    license: asString(license?.name) ?? asString(license?.nickname),
    topics: asTopics(record.topics).length ? asTopics(record.topics) : asTopics(record.tag_list),
    localDir: null,
    localIssueCount: null,
    localLabelCount: null,
    fetchedAt,
  };
}

/** 本地后端：没有远端元数据，就把 `.deck/` 的实际内容说清楚。 */
export function mapLocalRepo(
  workspaceDir: string,
  name: string,
  issueCount: number,
  labelCount: number,
  fetchedAt: string,
): RepoDetail {
  return {
    host: "local",
    fullName: name,
    url: null,
    description: null,
    visibility: "unknown",
    defaultBranch: null,
    language: null,
    stars: null,
    forks: null,
    openIssues: null,
    pushedAt: null,
    createdAt: null,
    license: null,
    topics: [],
    localDir: path.resolve(workspaceDir),
    localIssueCount: issueCount,
    localLabelCount: labelCount,
    fetchedAt,
  };
}

async function readLocalCounts(workspaceDir: string): Promise<{ issues: number; labels: number }> {
  const deck = path.join(workspaceDir, ".deck");
  let issues = 0;
  try {
    const names = await readdir(path.join(deck, "issues"));
    issues = names.filter((name) => name.endsWith(".md")).length;
  } catch {
    // 没有 .deck 就是 0 张票：本地后端本来就是按需建目录。
  }
  let labels = 0;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(deck, "labels.json"), "utf8"));
    labels = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    labels = 0;
  }
  return { issues, labels };
}

async function fetchGithub(ref: RemoteRef, fetchedAt: string): Promise<RepoInfoResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gh", ["api", `repos/${ref.owner}/${ref.name}`], {
      timeout: 20_000,
      maxBuffer: 8 << 20,
    }));
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "";
    if (/not found|http 404/i.test(stderr)) {
      return {
        ok: false,
        reason: "not-found",
        detail: `GitHub 上找不到 ${ref.owner}/${ref.name}：仓库可能改了名、被删除，或当前账号没有权限`,
      };
    }
    return { ok: false, ...classifyGhError(error, "重试") };
  }
  try {
    return {
      ok: true,
      repo: mapGithubRepo(JSON.parse(stdout), `${ref.owner}/${ref.name}`, fetchedAt),
    };
  } catch {
    return { ok: false, reason: "gh-failed", detail: "gh 返回的不是 JSON，无法解析仓库详情" };
  }
}

async function fetchGitlab(ref: RemoteRef, fetchedAt: string): Promise<RepoInfoResult> {
  const project = encodeURIComponent(`${ref.owner}/${ref.name}`);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("glab", ["api", `projects/${project}`], {
      timeout: 20_000,
      maxBuffer: 8 << 20,
    }));
  } catch (error) {
    const failure = classifyGlabError(error);
    if (/not found|404/i.test(failure.detail)) {
      return {
        ok: false,
        reason: "not-found",
        detail: `GitLab 上找不到 ${ref.owner}/${ref.name}：仓库可能改了名、被删除，或当前账号没有权限`,
      };
    }
    return { ok: false, ...failure };
  }
  try {
    return {
      ok: true,
      repo: mapGitlabRepo(JSON.parse(stdout), `${ref.owner}/${ref.name}`, fetchedAt),
    };
  } catch {
    return { ok: false, reason: "glab-failed", detail: "glab 返回的不是 JSON，无法解析仓库详情" };
  }
}

export async function readRepoInfo(workspaceDir: string, repoKey?: string): Promise<RepoInfoResult> {
  const backend = await resolveBackend(workspaceDir, "仓库详情", repoKey);
  if (!backend.ok) return backend;

  const fetchedAt = new Date().toISOString();
  if (backend.kind === "local") {
    const counts = await readLocalCounts(backend.workspaceDir);
    return {
      ok: true,
      repo: mapLocalRepo(backend.workspaceDir, backend.repo.name, counts.issues, counts.labels, fetchedAt),
    };
  }
  if (backend.kind === "gitlab") return fetchGitlab(backend.ref, fetchedAt);
  return fetchGithub(backend.ref, fetchedAt);
}
