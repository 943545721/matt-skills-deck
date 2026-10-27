import type { RepoOut } from "../rpc/repo-gate.ts";
import { resolveRepo } from "../rpc/repo-gate.ts";
import { getSettings } from "../settings.ts";
import type { RemoteRef } from "./remote.ts";
import { localRepoName } from "./local.ts";

/**
 * 读路径的后端选择。
 *
 * 设置里的 backend 是「允许的最宽范围」：auto 让远端决定，显式指定则连远端不一致都算配置错误。
 * 写路径单独走 `requireWritableBackend`——GitLab 目前只读，不能让界面以为写成功了。
 */
export type Backend =
  | { ok: true; kind: "github"; ref: RemoteRef; repo: RepoOut }
  | { ok: true; kind: "gitlab"; ref: RemoteRef; repo: RepoOut }
  | { ok: true; kind: "local"; workspaceDir: string; repo: RepoOut }
  | { ok: false; reason: "no-repo" | "unsupported-host"; detail: string };

export async function resolveBackend(workspaceDir: string, action = "任务板"): Promise<Backend> {
  const setting = getSettings().backend;
  const gate = await resolveRepo(workspaceDir);

  if (setting === "local") {
    return {
      ok: true,
      kind: "local",
      workspaceDir,
      repo: { host: "local", owner: "", name: localRepoName(workspaceDir), webUrl: null },
    };
  }

  if (!gate.ok) {
    if (setting === "auto") {
      return {
        ok: true,
        kind: "local",
        workspaceDir,
        repo: { host: "local", owner: "", name: localRepoName(workspaceDir), webUrl: null },
      };
    }
    return { ok: false, reason: "no-repo", detail: gate.detail };
  }

  if (setting !== "auto" && setting !== gate.ref.host) {
    return {
      ok: false,
      reason: "unsupported-host",
      detail: `设置要求 ${setting}，但工作区远端是 ${gate.ref.host}；改回 auto 或换一个匹配的仓库`,
    };
  }

  if (gate.ref.host === "github" || gate.ref.host === "gitlab") {
    return { ok: true, kind: gate.ref.host, ref: gate.ref, repo: gate.repo };
  }

  return {
    ok: false,
    reason: "unsupported-host",
    detail: `当前远端是 ${gate.ref.host}，${action}只接了 GitHub / GitLab / 本地 Markdown`,
  };
}

export type WritableBackend =
  | Extract<Backend, { ok: true; kind: "github" }>
  | Extract<Backend, { ok: true; kind: "local" }>;

/**
 * 写路径的闸门。
 *
 * GitLab 目前只读：如实拒绝，而不是让按钮看起来成功。
 * 本地后端可以写（就是写 `.deck/` 里的文件），所以它不算「没接」。
 */
export async function resolveWritableBackend(
  workspaceDir: string,
  action: string,
): Promise<WritableBackend | { ok: false; reason: "no-repo" | "unsupported-host"; detail: string }> {
  const backend = await resolveBackend(workspaceDir, action);
  if (!backend.ok) return backend;
  if (backend.kind === "gitlab") {
    return {
      ok: false,
      reason: "unsupported-host",
      detail: `GitLab 后端目前只读，${action}还没有接；需要写入请切到 GitHub 或本地 Markdown`,
    };
  }
  return backend;
}
