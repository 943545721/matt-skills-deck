/**
 * 群成员表要同时看见几个工作区的名册。
 *
 * 名册按工作区各存一份（`<工作区>/.deck/orchestration.json`）。
 * 这里把宿主列出的工作区逐个读出来，当前工作区放在第一位。
 * 读失败写进 `detail`：空的 `staff` 不能被界面说成「这个区没有人」。
 */

import type { OrchestrationSettings } from "../shared/orchestration.ts";
import type { StaffKind } from "../shared/staff.ts";
import { readOrchestration } from "./orchestration-store.ts";

/** 一次群读最多带多少个工作区。再多就该分页，而不是把首屏拖死。 */
const MAX_WORKSPACES = 32;

export interface GroupRosterStaffView {
  staffId: string;
  name: string;
  kind: StaffKind;
}

export interface GroupRosterView {
  workspaceId: string;
  workspaceDir: string;
  name: string;
  current: boolean;
  staff: GroupRosterStaffView[];
  detail?: string;
}

interface ListedWorkspace {
  id: string;
  dir: string;
  name: string;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function baseName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 宿主 `workspaces.list` 的条目收成「id + 目录 + 给人看的名字」。认不出的行丢掉。 */
export function workspacesFromList(value: unknown): ListedWorkspace[] {
  if (typeof value !== "object" || value === null) return [];
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: ListedWorkspace[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = textOf(row.id);
    const dir = textOf(row.workspaceDirectory) || textOf(row.projectRootPath);
    if (!id || !dir || seen.has(id)) continue;
    seen.add(id);
    const named = [row.name, row.title, row.projectDisplayName, row.projectCustomName]
      .map(textOf)
      .find(Boolean);
    out.push({ id, dir, name: clip(named || baseName(dir), 300) });
  }
  return out;
}

function staffOf(settings: OrchestrationSettings, workspaceId: string): GroupRosterStaffView[] {
  const roles = settings.roles.find((role) => role.workspaceId === workspaceId);
  return (roles?.staff ?? []).map((card) => ({
    staffId: card.id,
    name: card.name,
    kind: card.kind === "manager" ? "manager" : "worker",
  }));
}

interface WorkspaceLister {
  workspaces?: { list?: (query: Record<string, never>) => Promise<unknown> };
}

/**
 * 读群视图要展示的名册。
 *
 * 列不出来时只留当前工作区，并在 `warnings` 里说明：不能把「列失败」显示成「只有这一个区」。
 */
export async function readGroupRosters(
  paseo: object,
  current: { workspaceId: string; workspaceDir: string },
): Promise<{ rosters: GroupRosterView[]; warnings: string[] }> {
  const warnings: string[] = [];
  const fallback: ListedWorkspace = {
    id: current.workspaceId,
    dir: current.workspaceDir,
    name: clip(baseName(current.workspaceDir) || current.workspaceId, 300),
  };

  let listed: ListedWorkspace[] = [];
  const workspaces = (paseo as WorkspaceLister).workspaces;
  if (typeof workspaces?.list !== "function") {
    listed = [fallback];
  } else {
    try {
      listed = workspacesFromList(await workspaces.list({}));
    } catch (error) {
      warnings.push(`列不出工作区，成员表只显示当前这一个：${error instanceof Error ? error.message : String(error)}`);
      listed = [];
    }
  }

  if (!listed.some((entry) => entry.id === current.workspaceId)) listed.unshift(fallback);
  listed.sort((left, right) => {
    if (left.id === current.workspaceId) return -1;
    if (right.id === current.workspaceId) return 1;
    return left.name.localeCompare(right.name, "zh");
  });
  if (listed.length > MAX_WORKSPACES) {
    warnings.push(`工作区超过 ${MAX_WORKSPACES} 个，成员表只显示前 ${MAX_WORKSPACES} 个。`);
    listed = listed.slice(0, MAX_WORKSPACES);
  }

  const rosters: GroupRosterView[] = [];
  for (const entry of listed) {
    const stored = await readOrchestration(entry.dir);
    const failed = stored.readFailed || stored.corrupt;
    const detail = failed ? clip(stored.detail ?? "编排设置读不出来", 2000) : undefined;
    rosters.push({
      workspaceId: entry.id,
      workspaceDir: entry.dir,
      name: entry.name,
      current: entry.id === current.workspaceId,
      staff: failed ? [] : staffOf(stored.settings, entry.id),
      ...(detail ? { detail } : {}),
    });
  }
  return { rosters, warnings };
}
