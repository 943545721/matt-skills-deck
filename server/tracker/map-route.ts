import type { Readiness } from "../../shared/issues.ts";
import type { Issue } from "./github.ts";
import type { ParsedMapBody } from "./map-body.ts";
import { readinessOf } from "./readiness.ts";

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
  /** 与任务板同一口径：同一条路线票在地图里也不该显示成「可接」而列表里是「阻塞」。 */
  readiness: Readiness;
  /** 仍打开与已关闭的阻塞者都带上，界面据此画「被谁挡住」与层级。 */
  blockedBy: number[];
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
    const blockedBy = issue.blockedBy ?? [];
    items.push({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      kind,
      isMap: false,
      readiness:
        issue.readiness ??
        readinessOf({ state: issue.state, merged: issue.merged, assignees: issue.assignees ?? [], blockedBy }),
      blockedBy: blockedBy.map((blocker) => blocker.number),
    });
  }
  const kindRank = (kind: RouteKind) => ROUTE_KINDS.indexOf(kind);
  return [...items].sort((a, b) => {
    if (a.state !== b.state) return a.state === "OPEN" ? -1 : 1;
    const rank = kindRank(a.kind) - kindRank(b.kind);
    if (rank !== 0) return rank;
    return a.number - b.number;
  });
}

export const ROUTE_GROUPS = ["ready", "claimed", "blocked", "closed"] as const;

export interface RouteGroup {
  readiness: (typeof ROUTE_GROUPS)[number];
  numbers: number[];
}

/**
 * 子票按可接 / 认领 / 阻塞 / 关闭分组。
 *
 * 四个桶永远都在（哪怕是空数组）：界面固定渲染四段，用户不用因为「今天没人认领」
 * 就去猜是不是这一组没加载出来。口径直接用 `readiness`，不在这里重新判断。
 */
export function groupRoute(route: readonly RouteItem[]): RouteGroup[] {
  return ROUTE_GROUPS.map((readiness) => ({
    readiness,
    numbers: route.filter((item) => item.readiness === readiness).map((item) => item.number),
  }));
}

export interface RouteLevel {
  /** 从 1 开始：没有路线内前置的票是第 1 层。 */
  level: number;
  numbers: number[];
  total: number;
  closed: number;
  open: number;
}

/**
 * 路线分层与每层进度。
 *
 * 层级由路线**内部**的阻塞边推导：一张票的层 = 1 + 它所有路线内前置里最深的那个。
 * 只看路线内的边是有意的——地图外的前置（比如另一个仓库的票）不该把整条路线往下推一层，
 * 那会让「第 1 层」变成没人能做的票。
 *
 * 成环时（数据里偶尔会有互相 blockedBy）先把强连通分量缩成一个点再分层，
 * 环上的票得到同一层，也不会让一条坏数据把整页算到递归爆栈。
 */
export function routeLevels(route: readonly RouteItem[]): RouteLevel[] {
  const byNumber = new Map(route.map((item) => [item.number, item]));
  const blockersOf = new Map(
    route.map((item) => [item.number, item.blockedBy.filter((blocker) => byNumber.has(blocker))] as const),
  );

  // Tarjan：同一强连通分量里的票互相阻塞，缩点后就不会出现「环上层数越算越深」。
  const indexOf = new Map<number, number>();
  const lowOf = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const componentOf = new Map<number, number>();
  let counter = 0;
  let componentCount = 0;

  const connect = (node: number): void => {
    indexOf.set(node, counter);
    lowOf.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of blockersOf.get(node) ?? []) {
      if (!indexOf.has(next)) {
        connect(next);
        lowOf.set(node, Math.min(lowOf.get(node) ?? 0, lowOf.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowOf.set(node, Math.min(lowOf.get(node) ?? 0, indexOf.get(next) ?? 0));
      }
    }
    if (lowOf.get(node) === indexOf.get(node)) {
      let member = -1;
      while (member !== node) {
        member = stack.pop() ?? -1;
        if (member < 0) break;
        onStack.delete(member);
        componentOf.set(member, componentCount);
      }
      componentCount += 1;
    }
  };
  for (const item of route) if (!indexOf.has(item.number)) connect(item.number);

  const componentLevel = new Array<number>(componentCount).fill(0);
  const levelOfComponent = (component: number): number => {
    if (componentLevel[component]) return componentLevel[component];
    let deepest = 0;
    for (const item of route) {
      if (componentOf.get(item.number) !== component) continue;
      for (const blocker of blockersOf.get(item.number) ?? []) {
        const other = componentOf.get(blocker);
        if (other === undefined || other === component) continue;
        deepest = Math.max(deepest, levelOfComponent(other));
      }
    }
    componentLevel[component] = deepest + 1;
    return componentLevel[component];
  };

  const buckets = new Map<number, RouteItem[]>();
  for (const item of route) {
    const component = componentOf.get(item.number);
    const level = component === undefined ? 1 : levelOfComponent(component);
    buckets.set(level, [...(buckets.get(level) ?? []), item]);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, items]) => {
      const closed = items.filter((item) => item.state === "CLOSED").length;
      return {
        level,
        numbers: items.map((item) => item.number).sort((left, right) => left - right),
        total: items.length,
        closed,
        open: items.length - closed,
      };
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
