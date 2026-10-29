import type { GhClient } from "./client.ts";
import type { GhErrorKind } from "./errors.ts";
import { parseGraphql } from "./reads.ts";
import type { RepoRef } from "./reads.ts";
import { VIEWER_PERMISSION_QUERY } from "./queries.ts";

/**
 * 仓库权限（DSH repo-permissions.ts）。
 *
 * 为什么主路读 REST `.permissions` 而不是 GraphQL `viewerPermission`：
 * GraphQL 的枚举会把 TRIAGE 压平成 READ/WRITE 一类的粗档，而「能不能改标签」靠的正是
 * triage。REST 的 `.permissions` 有独立的 `triage` 布尔，才是标签写操作需要的真值。
 * `viewerPermission` 仅作为补充读法保留，报告里注明它的压平问题。
 */
export interface RepoPermissions {
  push: boolean;
  triage: boolean;
  admin: boolean;
  maintain: boolean;
}

export type PermissionCache = Map<string, Promise<RepoPermissions | null>>;

export function createPermissionCache(): PermissionCache {
  return new Map();
}

const SPEC = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function specOf(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/** 读 `repos/{spec}` 的 `.permissions`；两个布尔缺一个就返回 null（不猜）。 */
export async function readRepoPermissions(
  client: GhClient,
  spec: string,
  cache?: PermissionCache,
): Promise<RepoPermissions | null> {
  if (!SPEC.test(spec)) return null;
  const key = spec.toLowerCase();
  if (cache?.has(key)) return (await cache.get(key)) ?? null;
  const pending = (async () => {
    const result = await client.rest(`repos/${spec}`, { jq: ".permissions" });
    if (!result.ok) return null;
    try {
      const parsed: unknown = JSON.parse(result.stdout || "null");
      if (!parsed || typeof parsed !== "object") return null;
      const cell = parsed as { push?: unknown; triage?: unknown; admin?: unknown; maintain?: unknown };
      if (typeof cell.push !== "boolean" || typeof cell.triage !== "boolean") return null;
      return { push: cell.push, triage: cell.triage, admin: cell.admin === true, maintain: cell.maintain === true };
    } catch {
      return null;
    }
  })();
  cache?.set(key, pending);
  return pending;
}

/** 只读账号的固定话术：说清缺哪一档、要什么权限，不给用户留「再试一次」的错觉。 */
export function readonlyMessage(spec: string, names: readonly string[]): string {
  const what = names.length ? names.join("、") : "这个操作";
  return `当前账号对 ${spec} 是只读权限，不能修改${what}；需要仓库的 push 权限（标签相关还需要 triage）。请让有权限的人改，或换一个有权限的账号。`;
}

export interface ViewerPermission {
  permission: string;
  push: boolean;
  triage: boolean;
}

/**
 * GraphQL `viewerPermission` 读法（补充）。
 *
 * 注意：这个枚举不区分 TRIAGE 与 READ 之外的细档，不能拿它替代 `.permissions`。
 * 返回 null 表示读不到或形状不对。
 */
export async function readViewerPermission(client: GhClient, repo: RepoRef): Promise<ViewerPermission | null> {
  const result = await client.graphql(VIEWER_PERMISSION_QUERY, { owner: repo.owner, name: repo.name }, { cwd: repo.cwd });
  if (!result.ok) return null;
  const payload = parseGraphql(result.stdout);
  const repository = payload?.data?.repository as { viewerPermission?: unknown } | null | undefined;
  if (!repository || typeof repository.viewerPermission !== "string") return null;
  const permission = repository.viewerPermission.toUpperCase();
  return {
    permission,
    push: permission === "ADMIN" || permission === "MAINTAIN" || permission === "WRITE",
    triage: permission === "TRIAGE",
  };
}

/** 写失败归属：404 或权限话术 → 读一次权限；push=false 判 auth，push=true 说明是「真不存在」。 */
export async function attributeWriteFailure(
  client: GhClient,
  spec: string,
  kind: GhErrorKind,
  cache?: PermissionCache,
): Promise<"auth" | "notfound" | "unknown"> {
  if (kind !== "notfound" && kind !== "auth") return "unknown";
  const permissions = await readRepoPermissions(client, spec, cache);
  if (!permissions) return "notfound";
  return permissions.push ? "notfound" : "auth";
}
