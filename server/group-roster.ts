/**
 * 本群的名册：**只有当前这个目录**那一份。
 *
 * 一个项目一个群。名册存在 `<目录>/.deck/orchestration.json` 里，所以「这个群里有谁」
 * 就是那个文件里这个目录的名册——宿主里别的目录（别的项目）的名册不属于这个群，
 * 一条也不列。以前这里会去宿主 `workspaces.list` 把所有工作区的名册都读出来并排放，
 * 结果同一个界面上混着几个项目的成员，点错人就是把活派到了别人的项目里。
 *
 * 同一目录会攒出好几个 workspaceId（每次重开一个），卡由 `rosterOf` 合并去重；
 * 读失败写进 `detail`：空的 `staff` 不能被界面说成「这个群没有人」。
 */

import type { OrchestrationSettings } from "../shared/orchestration.ts";
import { rosterOf, type StaffKind } from "../shared/staff.ts";
import { readOrchestration } from "./orchestration-store.ts";

export interface GroupRosterStaffView {
  staffId: string;
  name: string;
  kind: StaffKind;
}

export interface GroupRosterView {
  staff: GroupRosterStaffView[];
  detail?: string;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function staffOf(settings: OrchestrationSettings): GroupRosterStaffView[] {
  // 名册按目录算：这个文件里所有 workspaceId 的卡合起来，就是这个群的人。
  return rosterOf(settings).map((card) => ({
    staffId: card.id,
    name: card.name,
    kind: card.kind === "manager" ? "manager" : "worker",
  }));
}

/** 读这个目录的名册。读不出来时 `staff` 为空 + `detail` 说明原因，不假装「没人」。 */
export async function readGroupRoster(workspaceDir: string): Promise<GroupRosterView> {
  const stored = await readOrchestration(workspaceDir);
  if (stored.readFailed || stored.corrupt) {
    return { staff: [], detail: clip(stored.detail ?? "编排设置读不出来", 2000) };
  }
  return { staff: staffOf(stored.settings) };
}
