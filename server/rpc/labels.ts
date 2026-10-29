import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { LabelSyncRepoResult, labelsColorsRpc, labelsListRpc, labelsSyncRpc } from "../../shared/labels.ts";
import { planLabels, reconcileLabelColors } from "../../shared/labels.ts";
import { PROJECT_CONFIG_FILE, type WorkspaceProject } from "../../shared/workspace-projects.ts";
import { githubSyncDeps, gitlabSyncDeps, listLabels, setLabelColors, syncLabels } from "../tracker/labels.ts";
import { listGitLabLabels, setGitLabLabelColors } from "../tracker/gitlab.ts";
import { listLocalLabels, setLocalLabelColors } from "../tracker/local.ts";
import { probeProjectDir, readWorkspaceConfig } from "../tracker/workspace-repo.ts";
import { resolveBackend, resolveWritableBackend } from "../tracker/backend.ts";
import { record } from "../logs.ts";

type ListInput = RpcInput<typeof labelsListRpc>;
type ColorsInput = RpcInput<typeof labelsColorsRpc>;
type SyncInput = RpcInput<typeof labelsSyncRpc>;

export async function listLabelsHandler(input: ListInput): Promise<RpcOutput<typeof labelsListRpc>> {
  const backend = await resolveBackend(input.workspaceDir, "标签配色", input.repoKey);
  if (!backend.ok) return backend;

  if (backend.kind === "local") {
    const result = await listLocalLabels(backend.workspaceDir);
    if (!result.ok) return result;
    return { ok: true, labels: result.labels };
  }
  if (backend.kind === "gitlab") {
    const result = await listGitLabLabels(backend.ref.owner, backend.ref.name);
    if (!result.ok) return result;
    return { ok: true, labels: result.labels };
  }
  const result = await listLabels(backend.ref.owner, backend.ref.name);
  if (!result.ok) return result;
  return { ok: true, labels: result.labels };
}

/**
 * 配置里写的 `owner/name` → 宿主。
 *
 * 目录里能读到远端时不用这条（远端的宿主是机器上验证过的事实）；只有在项目目录没有远端、
 * 配置又写了 repo 时兜底。GitHub 是默认平台，与 `targets.ts` 里 `platformOf` 的默认一致。
 */
function hostOfRepoString(repo: string): { host: "github" | "gitlab"; owner: string; name: string } | null {
  const parts = repo.split("/").filter(Boolean);
  const name = parts[parts.length - 1];
  if (parts.length < 2 || !name) return null;
  return { host: parts.length >= 3 ? "gitlab" : "github", owner: parts.slice(0, -1).join("/"), name };
}

/** 单个项目：算出该建哪些标签，再落到它自己的仓库上。任何一层失败都只影响这一行。 */
async function syncOneProject(workspaceDir: string, project: WorkspaceProject): Promise<LabelSyncRepoResult> {
  const plan = planLabels({ areas: project.areas, owner: project.owner, deprecatedAreas: project.deprecatedAreas });
  const base: LabelSyncRepoResult = {
    key: project.key,
    repo: project.repo ?? "",
    host: null,
    created: [],
    existing: [],
    failed: [],
    skipped: plan.skipped,
    deprecated: plan.deprecated,
    error: null,
  };

  const probe = await probeProjectDir(workspaceDir, project.dir);
  // 目录里的远端优先：它是机器上验证过的事实；配置里的 repo 只补位。
  const probed = probe.ref && probe.ref.host !== "other" ? probe.ref : null;
  const ref = probed ?? (project.repo ? hostOfRepoString(project.repo) : null);
  if (!ref) {
    return { ...base, error: probe.problem ?? "没有可识别的远端，也没有写 repo" };
  }

  const host = ref.host === "gitlab" ? "gitlab" : "github";
  const key = `${ref.owner}/${ref.name}`;
  const synced = await syncLabels(ref.owner, ref.name, plan.labels, host === "gitlab" ? gitlabSyncDeps : githubSyncDeps);
  if (!synced.ok) {
    return { ...base, repo: key, host, error: synced.detail };
  }
  return { ...base, repo: key, host, ...synced };
}

/**
 * 同步标签：按 `.paseo-deck.json` 的项目清单，逐个仓库补齐标准 + area + role 标签。
 *
 * 只认 v2 清单：v1 只有一个「默认仓库」，没有 areas 也没有多个 repo，拿它来同步会让人以为
 * 已经处理过整个工作区。配置坏掉时直接报错，不猜。
 */
export async function syncLabelsHandler(input: SyncInput): Promise<RpcOutput<typeof labelsSyncRpc>> {
  const read = await readWorkspaceConfig(input.workspaceDir);
  if (!read.ok) {
    if (read.reason === "missing") {
      return {
        ok: false,
        reason: "no-repo",
        detail: `工作区里没有 ${PROJECT_CONFIG_FILE}：先写 v2 项目清单（或先跑项目梳理技能），再同步标签`,
      };
    }
    return { ok: false, reason: "invalid", detail: `读 ${PROJECT_CONFIG_FILE} 失败：${read.detail}` };
  }
  if (read.config.version !== 2) {
    return {
      ok: false,
      reason: "no-repo",
      detail: `${PROJECT_CONFIG_FILE} 是单项目 v1（只有 repoDir）：同步标签需要 v2 清单里的 repo 与 areas`,
    };
  }

  const repos: LabelSyncRepoResult[] = [];
  for (const project of read.config.projects) {
    repos.push(await syncOneProject(input.workspaceDir, project));
  }

  const created = repos.reduce((sum, row) => sum + row.created.length, 0);
  const failed = repos.reduce((sum, row) => sum + row.failed.length, 0);
  const errors = repos.filter((row) => row.error !== null).length;
  record(
    failed || errors ? "warn" : "info",
    "labels.sync",
    `同步标签：${repos.length} 个项目，新建 ${created} 个，失败 ${failed} 个，整体失败 ${errors} 个`,
  );
  return { ok: true, repos };
}

export async function setLabelColorsHandler(input: ColorsInput): Promise<RpcOutput<typeof labelsColorsRpc>> {
  // 改色是写操作：与其它 GitLab 写路径共用权限闸门，未知权限不放行。
  const backend = await resolveWritableBackend(input.workspaceDir, "标签配色", input.repoKey);
  if (!backend.ok) return backend;

  if (backend.kind === "gitlab") {
    const written = await setGitLabLabelColors(backend.ref.owner, backend.ref.name, input.changes);
    if (!written.ok) {
      record("error", "labels.colors", `GitLab 改色失败：${written.detail.slice(0, 200)}`);
      return written;
    }
    const failed = written.failed.map((item) => ({ name: item.name, detail: item.detail }));
    // 与 GitHub 同一条口径：PUT 成功只代表请求被接受，读回一致才算改好。
    if (!written.applied.length) {
      return { ok: true, applied: [], failed, verified: [], mismatched: [], readbackFailed: false };
    }
    const reread = await listGitLabLabels(backend.ref.owner, backend.ref.name);
    if (!reread.ok) {
      record("warn", "labels.colors", `GitLab 改色 ${written.applied.length} 个请求成功，但读回失败`);
      return { ok: true, applied: written.applied, failed, verified: [], mismatched: [], readbackFailed: true };
    }
    const { verified, mismatched } = reconcileLabelColors(written.applied, reread.labels);
    record(
      failed.length || mismatched.length ? "warn" : "info",
      "labels.colors",
      `GitLab 改色 ${written.applied.length} 个成功、${failed.length} 个失败、${verified.length} 个读回一致`,
    );
    return { ok: true, applied: written.applied, failed, verified, mismatched, readbackFailed: false };
  }

  const result =
    backend.kind === "local"
      ? await setLocalLabelColors(backend.workspaceDir, input.changes)
      : await setLabelColors(backend.ref.owner, backend.ref.name, input.changes);
  if (!result.ok) {
    record("error", "labels.colors", `改色失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record(
    result.failed.length || result.mismatched.length || result.readbackFailed ? "warn" : "info",
    "labels.colors",
    `改色 ${result.applied.length} 个成功、${result.failed.length} 个失败、${result.verified.length} 个读回一致${
      result.readbackFailed ? "（读回失败，未确认）" : ""
    }`,
  );
  return {
    ok: true,
    applied: result.applied,
    failed: result.failed,
    verified: result.verified,
    mismatched: result.mismatched,
    readbackFailed: result.readbackFailed,
  };
}
