import type { Issue } from "./github.ts";
import type { ParsedMapBody } from "./map-body.ts";

/**
 * 工作路线与下一步建议。
 *
 * 这两件事都只做「按现状排序 + 说一句为什么」，不猜意图、不调模型：
 * 面板给出的是可核对的事实（哪张票开着、雾里还剩几条），用户看一眼就知道下一步该点哪张。
 */

/** 路线上的票类型：去掉地图票自己，剩下的就是「要干的事」。 */
export const ROUTE_KINDS = ["research", "prototype", "grilling", "task"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** 地图票自己的标签，不算路线项。 */
const MAP_LABEL = "wayfinder:map";

export interface RouteItem {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  kind: RouteKind;
  isMap: boolean;
}

/** 标签 → 路线类型；不是路线标签就回 null。 */
export function routeKindOf(labels: readonly { name: string }[]): RouteKind | null {
  for (const kind of ROUTE_KINDS) {
    if (labels.some((label) => label.name === `wayfinder:${kind}`)) return kind;
  }
  return null;
}

/**
 * 从票列表里挑出路线项。
 *
 * 顺序是有意的：未关闭在前（关掉的只是历史），同类按票号升序（旧票先做，
 * 免得新的插队把老的饿死）。地图票自己剔除——它是地图，不是路上的事。
 */
export function routeFromIssues(issues: readonly Issue[]): RouteItem[] {
  const items: RouteItem[] = [];
  for (const issue of issues) {
    const kind = routeKindOf(issue.labels);
    if (kind === null) continue;
    if (issue.labels.some((label) => label.name === MAP_LABEL)) continue;
    items.push({ number: issue.number, title: issue.title, state: issue.state, kind, isMap: false });
  }
  const kindRank = (kind: RouteKind) => ROUTE_KINDS.indexOf(kind);
  return [...items].sort((a, b) => {
    if (a.state !== b.state) return a.state === "OPEN" ? -1 : 1;
    const rank = kindRank(a.kind) - kindRank(b.kind);
    if (rank !== 0) return rank;
    return a.number - b.number;
  });
}

/** 建议码：服务端只说「哪种情况」，文案由客户端按语言组装。 */
export type SuggestionCode =
  | "no-destination"
  | "fog-open"
  | "research-open"
  | "grilling-open"
  | "prototype-open"
  | "task-open"
  | "no-route"
  | "all-closed";

export interface Suggestion {
  code: SuggestionCode;
  /** 建议点向的具体票；没有具体票时不给。 */
  number?: number;
  count?: number;
}

const MAX_SUGGESTIONS = 3;

/**
 * 按「先定目标、再定雾、再按路线推进」的次序给建议，最多三条。
 *
 * 为什么掐在三条：一屏能读完的建议才有用，四条以上等于让人自己挑。
 */
export function suggestNextSteps(input: {
  map: ParsedMapBody;
  route: readonly RouteItem[];
}): Suggestion[] {
  const open = input.route.filter((item) => item.state === "OPEN");
  const out: Suggestion[] = [];
  const push = (suggestion: Suggestion) => {
    if (out.length < MAX_SUGGESTIONS) out.push(suggestion);
  };

  if (!input.map.destination.trim()) push({ code: "no-destination" });
  if (input.map.fog.length > 0) push({ code: "fog-open", count: input.map.fog.length });

  for (const kind of ["research", "grilling", "prototype", "task"] as const) {
    const first = open.find((item) => item.kind === kind);
    if (!first) continue;
    const count = open.filter((item) => item.kind === kind).length;
    push({ code: `${kind}-open`, number: first.number, count });
  }

  if (input.route.length === 0) push({ code: "no-route" });
  if (input.route.length > 0 && open.length === 0) push({ code: "all-closed" });

  return out.slice(0, MAX_SUGGESTIONS);
}
