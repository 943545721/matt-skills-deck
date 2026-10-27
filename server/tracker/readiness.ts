import type { ListView, Readiness, SortKey } from "../../shared/issues.ts";

/**
 * 「可接 / 阻塞 / 认领 / 关闭」的唯一口径。
 *
 * 与 DSH `deck-derive.ts` 一致：只有**仍打开**的阻塞者才算阻塞；认领（assignees 非空）
 * 与阻塞各自成立、互不覆盖；关闭与 PR 合并都算收尾。任何地方要判「能不能接这张票」，
 * 都必须走这里，不许在界面或 MCP 里另写一份 if。
 */
export interface ReadinessFields {
  state: "OPEN" | "CLOSED";
  merged?: boolean;
  assignees: readonly string[];
  blockedBy: readonly { state: "OPEN" | "CLOSED" }[];
}

export function readinessOf(item: ReadinessFields): Readiness {
  if (item.state === "CLOSED" || item.merged === true) return "closed";
  if (item.blockedBy.some((blocker) => blocker.state === "OPEN")) return "blocked";
  if (item.assignees.length > 0) return "claimed";
  return "ready";
}

export interface BoardCounts {
  total: number;
  open: number;
  closed: number;
  ready: number;
  claimed: number;
  blocked: number;
  merged: number;
  issues: number;
  pullRequests: number;
}

type Countable = ReadinessFields & { kind: "issue" | "pull-request" };

/**
 * 计数。
 *
 * `open` 与 `closed` 互斥，`ready` / `claimed` / `blocked` 是**打开票内部的三个互斥桶**，
 * 所以 ready + claimed + blocked === open，closed 另外算。PR 合并后计入 closed 与 merged，
 * 不进三个打开桶。
 */
export function countBoard(items: readonly Countable[]): BoardCounts {
  const counts: BoardCounts = {
    total: items.length,
    open: 0,
    closed: 0,
    ready: 0,
    claimed: 0,
    blocked: 0,
    merged: 0,
    issues: 0,
    pullRequests: 0,
  };
  for (const item of items) {
    if (item.kind === "pull-request") counts.pullRequests += 1;
    else counts.issues += 1;
    if (item.merged === true) counts.merged += 1;
    const readiness = readinessOf(item);
    if (readiness === "closed") {
      counts.closed += 1;
      continue;
    }
    counts.open += 1;
    counts[readiness] += 1;
  }
  return counts;
}

export interface FilterOptions {
  view?: ListView;
  kind?: "issue" | "pull-request";
  label?: string;
}

/** 页签、KPI、标签三重筛选；都只做投影，不改入参。 */
export function filterBoard<T extends Countable & { labels: readonly { name: string }[] }>(
  items: readonly T[],
  options: FilterOptions,
): T[] {
  return items.filter((item) => {
    if (options.kind && item.kind !== options.kind) return false;
    if (options.label && !item.labels.some((label) => label.name === options.label)) return false;
    const view = options.view ?? "all";
    if (view === "all") return true;
    if (view === "open") return item.state === "OPEN" && item.merged !== true;
    if (view === "closed") return readinessOf(item) === "closed";
    if (view === "merged") return item.merged === true;
    return readinessOf(item) === view;
  });
}

/**
 * 排序。
 *
 * 地图票永远在最前（它是「这张地图有哪些票」的入口），未关闭永远在已关闭前，
 * 之后才轮到用户选的次级键。显式选择只换次级键，不动前两层——
 * 不然用户按「编号」排一次，地图就沉到底下去了。
 */
export function sortBoard<T extends Countable & { isMap: boolean; updatedAt: string; createdAt: string; number: number; title: string }>(
  items: readonly T[],
  sort: SortKey = "updated",
): T[] {
  const openRank = (item: T) => (item.state === "OPEN" && item.merged !== true ? 0 : 1);
  const mapRank = (item: T) => (item.isMap ? 0 : 1);
  return [...items].sort((left, right) => {
    if (mapRank(left) !== mapRank(right)) return mapRank(left) - mapRank(right);
    if (openRank(left) !== openRank(right)) return openRank(left) - openRank(right);
    switch (sort) {
      case "number":
        return left.number - right.number;
      case "title":
        return left.title.localeCompare(right.title);
      case "created":
        return right.createdAt.localeCompare(left.createdAt);
      case "updated":
      default:
        return right.updatedAt.localeCompare(left.updatedAt);
    }
  });
}
