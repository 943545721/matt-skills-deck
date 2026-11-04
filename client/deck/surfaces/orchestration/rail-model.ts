import type { GroupMember, GroupRoster } from "../../../../shared/group-rpc.ts";
import type { WorkRouteStatus } from "../../../../shared/work-route.ts";
import type { PanelKey } from "../../panel/panelText.tsx";

/**
 * 群页右栏的数据整形（纯函数，无 React / 宿主依赖）。
 *
 * 右栏回答三件事：这屋里坐着谁、他手上挂着什么票、他上次交了什么。
 * 三件都来自已有数据（名册、会话快照、工作票台账、交接目录），这里只负责
 * 把它们拼成一行行能直接画出来的东西——不新增接口，也不猜。
 *
 * 抽出来的原因：`railRowsOf` 的合并规则（同一个人只出现一次、已归档的会话
 * 不顶掉在跑的）出错的后果是「点错人」，而点错人是把话派给别人的会话，
 * 比界面难看严重得多。
 */

/**
 * 选中的人：发送时用 `staffId`，右栏展开时用 `agentId` 找台账与交接。
 *
 * 不带工作区：一个项目一个群，这个群里只有本目录名册上的人，没有「哪个项目的他」。
 */
export interface GroupPick {
  staffId: string;
  name: string;
  /** 他的会话；名册上有、会话还没起时为 null。 */
  agentId: string | null;
}

/** 右栏的一行。名册是主表：会话状态只是贴上去的一层。 */
export interface RailRow {
  staffId: string;
  name: string;
  kind: "manager" | "worker";
  agentId: string | null;
  status: string | null;
  archived: boolean;
}

/**
 * 一个 `staffId` 可能对应多个会话（重开过、旧的那个归档了）：
 * 优先留没归档的那条；都归档时留任意一条，行上会标「已归档」。
 */
function liveByStaff(members: readonly GroupMember[]): Map<string, GroupMember> {
  const out = new Map<string, GroupMember>();
  for (const member of members) {
    const staffId = member.staffId.trim();
    // 没挂岗位标签的会话不属于名册上的任何一个人，不能拿它顶替谁。
    if (!staffId) continue;
    const seen = out.get(staffId);
    if (!seen || (seen.archived && !member.archived)) out.set(staffId, member);
  }
  return out;
}

/**
 * 名册 → 右栏的行，保持名册自己的顺序。
 *
 * 不按人名重排：名册顺序是人在设置里排的，比字典序（中文还依赖排序规则，换台机器可能变）更可读。
 * 群 read 只给本目录的名册与会话，所以这里不需要再判断「这条会话属于哪个工作区」。
 */
export function railRowsOf(input: {
  roster: GroupRoster;
  members: readonly GroupMember[];
}): RailRow[] {
  const live = liveByStaff(input.members);
  return input.roster.staff.map((person) => {
    const member = live.get(person.staffId);
    return {
      staffId: person.staffId,
      name: person.name,
      kind: person.kind,
      agentId: member ? member.agentId : null,
      status: member && member.status ? member.status : null,
      archived: member ? member.archived : false,
    };
  });
}

/** 台账里的一行，够画「他手上挂着什么」的最小集合。 */
export interface RailTicketLine {
  ticketKey: string;
  repoKey: string | null;
  number: number;
  title: string;
  status: WorkRouteStatus;
  /** 最近一次接手这张票的会话：台账按工作区读回来，这里要按人筛。 */
  agentId: string | null;
  updatedAt: string;
}

/**
 * 这个会话名下还挂着的票（已释放 / 做完的不列在「进度」里，它们不是进度）。
 *
 * 按 `updatedAt` 倒序：最近动过的那张排在最上面。
 */
export function ticketsOfAgent(entries: readonly RailTicketLine[], agentId: string | null): RailTicketLine[] {
  if (!agentId) return [];
  return entries
    .filter((entry) => entry.agentId === agentId)
    .filter((entry) => entry.status === "attached" || entry.status === "in-progress")
    .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0));
}

/** 台账状态 → 文案。四个状态写死一张表，加状态时这里会缺一格类型检查。 */
export function routeStatusKey(status: WorkRouteStatus): PanelKey {
  switch (status) {
    case "attached":
      return "group.route.attached";
    case "in-progress":
      return "group.route.inProgress";
    case "done":
      return "group.route.done";
    case "released":
      return "group.route.released";
  }
}

/**
 * 交接文档只露开头几行。
 *
 * 右栏只有两百来像素宽，整份交接塞进去会把成员列表挤到屏幕外；但截断必须说出来
 * （`clipped`），否则「他上次就交了这么多」是假的。
 */
export function clipLines(markdown: string, maxLines: number): { text: string; clipped: boolean } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) return { text: lines.join("\n").trim(), clipped: false };
  return { text: lines.slice(0, maxLines).join("\n").trim(), clipped: true };
}
