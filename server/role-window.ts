/**
 * 从编排设置里认出「这条会话是不是主窗口 / 需求窗口 / 派单窗口 / 进度窗口」。
 *
 * 后台事件（`agent.created`、权限请求）带的是会话的 `workspaceId`，不是完整的
 * `WorkspaceRoles`；按 id 精确匹配才认，匹配不到就当它没有角色槽位。
 * 事件里 id 为空（宿主偶尔不给）时退回全表扫描：只有唯一一条绑定才用，
 * 否则视为分不清——后台事件的失败方向是放行，不能靠猜杀了正常会话。
 *
 * 不缓存：用户在面板里换窗口后，下一次事件必须立刻按新的绑定判定。
 */

import { workspaceRolesOf, type OrchestrationSettings } from "../shared/orchestration.ts";
import { windowSlotsOf, type WindowSlots } from "../shared/window-gates.ts";

export type RoleSlotsLookup =
  | { readonly ok: true; readonly slots: WindowSlots }
  | { readonly ok: false; readonly reason: "workspace-ambiguous"; readonly detail: string };

const EMPTY_SLOTS: WindowSlots = {
  mainAgentId: null,
  requirementAgentId: null,
  dispatcherAgentId: null,
  progressAgentId: null,
};

export function roleSlotsFor(
  settings: OrchestrationSettings,
  workspaceId: string | null | undefined,
): RoleSlotsLookup {
  const id = workspaceId?.trim() ?? "";
  if (id) {
    const matched = settings.roles.filter((role) => role.workspaceId === id);
    if (matched.length > 1) {
      return {
        ok: false,
        reason: "workspace-ambiguous",
        detail: `工作区 ${id} 有多条角色绑定：先到「编排」里合并成一条，再判定窗口身份。`,
      };
    }
    const entry = matched[0];
    // 没有角色绑定不等于出错：这个工作区就是没配窗口，调用方按「没有槽位」放行。
    return { ok: true, slots: entry ? windowSlotsOf(workspaceRolesOf(settings, id)) : EMPTY_SLOTS };
  }

  const entries = settings.roles;
  if (entries.length === 0) return { ok: true, slots: EMPTY_SLOTS };
  if (entries.length === 1) return { ok: true, slots: windowSlotsOf(entries[0]) };
  return {
    ok: false,
    reason: "workspace-ambiguous",
    detail: `编排里有 ${entries.length} 条工作区绑定，会话没带工作区 id，分不清它属于哪一片。`,
  };
}
