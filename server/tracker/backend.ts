import type { RemoteRef } from "./remote.ts";
import type { RepoOut } from "./workspace-repo.ts";
import type { TargetFailure } from "./targets.ts";
import { repoOf, resolveTarget } from "./targets.ts";
import { checkGitLabWritable, type GlabFailure, type GitLabRepoPermissions } from "./gitlab.ts";

/**
 * 读路径的后端选择。
 *
 * 三个后端最终都是同一份「票面」：GitHub / GitLab 走远端，本地走 `.deck/`。
 * 多仓库工作区里，单个仓库的解析被 `tracker/targets.ts` 接管；这里只是把目标
 * 摊平成后端形状，供标签页、仓库详情、PR 列表这些单仓库入口使用。
 *
 * 写路径单独走 `resolveWritableBackend`：GitLab 已接写，但必须过权限/只读闸门。
 */
export type Backend =
  | { ok: true; kind: "github"; ref: RemoteRef; repo: RepoOut; key: string; dir: string }
  | { ok: true; kind: "gitlab"; ref: RemoteRef; repo: RepoOut; key: string; dir: string }
  | { ok: true; kind: "local"; workspaceDir: string; repo: RepoOut; key: string; dir: string }
  | TargetFailure;

export async function resolveBackend(workspaceDir: string, action = "任务板", repoKey?: string): Promise<Backend> {
  const picked = await resolveTarget(workspaceDir, repoKey, action);
  if (!picked.ok) return picked;
  if (picked.kind === "local") {
    return { ok: true, kind: "local", workspaceDir: picked.workspaceDir, repo: picked.repo, key: "local", dir: picked.workspaceDir };
  }
  const target = picked.target;
  const repo: RepoOut = { host: target.host, owner: target.owner, name: target.name, webUrl: target.webUrl };
  if (target.host === "github") {
    return { ok: true, kind: "github", ref: target.ref, repo, key: target.key, dir: target.dir };
  }
  return { ok: true, kind: "gitlab", ref: target.ref, repo, key: target.key, dir: target.dir };
}

export type WritableBackend =
  | Extract<Backend, { ok: true; kind: "github" }>
  | Extract<Backend, { ok: true; kind: "local" }>
  | (Extract<Backend, { ok: true; kind: "gitlab" }> & { permissions: GitLabRepoPermissions });

/** 写闸门的失败：解析失败（TargetFailure）与 GitLab 权限失败（GlabFailure）同形。 */
export type WritableFailure = TargetFailure | GlabFailure;

/**
 * 写路径的闸门。
 *
 * GitLab 现在可写，但每次写之前都要确认：项目没归档、issue 没关闭、
 * 当前账号至少是 Reporter（access_level ≥ 15）。权限问不出来时拒绝，不拿
 * 「大概是公开项目」去赌；本地后端写 `.deck/`，GitHub 交给现有 write.ts。
 * 多仓库工作区必须传 `repoKey`：不知道写哪个仓库时宁可拒绝。
 */
export async function resolveWritableBackend(
  workspaceDir: string,
  action: string,
  repoKey?: string,
): Promise<WritableBackend | WritableFailure> {
  const picked = await resolveTarget(workspaceDir, repoKey, action);
  if (!picked.ok) return picked;
  if (picked.kind === "local") {
    return { ok: true, kind: "local", workspaceDir: picked.workspaceDir, repo: picked.repo, key: "local", dir: picked.workspaceDir };
  }
  const target = picked.target;
  const repo = repoOf(target);
  if (target.host === "github") {
    return { ok: true, kind: "github", ref: target.ref, repo, key: target.key, dir: target.dir };
  }
  const gate = await checkGitLabWritable(target.owner, target.name, action);
  if (!gate.ok) return { ...gate, detail: `${gate.detail}（仓库 ${target.key}）` };
  return { ok: true, kind: "gitlab", ref: target.ref, repo, key: target.key, dir: target.dir, permissions: gate.permissions };
}
