import type { BoardIssue } from "../../../shared/issues";

/**
 * 任务板的「项目视图」纯计算：项目条、按 area / role 筛选。
 *
 * 放在独立文件里是为了能被 node 直接测（不 import React）：项目条上的数字必须
 * 与列表里的票同源，任何一处自己数一遍就会两头对不上。
 *
 * 全部以 `.paseo-deck.json` 的项目清单为准：清单里没写的仓库不出现在项目条上
 * （那是配置漂移，归检查页说），清单里写了但目录读不出来的项目要照常出现并写明原因——
 * 否则「项目条少了一行」会被当成项目没了。
 */

/** 项目清单里的一行，只取项目条需要的字段（结构兼容 `deck.workspace.projects` 的输出）。 */
export interface BoardProjectInput {
  key: string;
  dir: string;
  repo: string | null;
  owner: string | null;
  areas: readonly string[];
  /**
   * 解析出的目标仓库；本地后端与读不出来的目录为 null。
   *
   * 两处来源的字段不一样（RPC 给 owner/name，内部的 RepoTarget 给 key），
   * 所以这里两种都收，拼出来的是同一个 `owner/name`。
   */
  resolved: { key?: string; owner?: string; name?: string } | null;
  problem: string | null;
}

/** 仓库目标里项目条要匹配的部分（结构兼容 `deck.repo.targets` 的输出）。 */
export interface BoardRepoTargetInput {
  key: string;
  name: string;
  dir: string;
}

export interface ProjectRow {
  key: string;
  dir: string;
  owner: string | null;
  /** 板上的仓库键；对不上任何仓库时为 null（项目条上只显示 0 与原因）。 */
  repoKey: string | null;
  open: number;
  closed: number;
  ready: number;
  blocked: number;
  /** 目录读不出来之类的原因；正常时为 null。 */
  problem: string | null;
}

const tailOf = (value: string): string => {
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
};

/**
 * 项目 → 板上的仓库键。
 *
 * 优先用配置解析时得到的 `resolved.key`（机器上验证过的事实）；没有时按名称与目录兜底，
 * 只为了让人觉得「这个项目就是那一行」——猜不出来就留 null，不要硬配一个。
 */
export function projectRepoKey(
  project: BoardProjectInput,
  repos: readonly BoardRepoTargetInput[],
): string | null {
  const resolvedKey = project.resolved?.key;
  if (resolvedKey) return resolvedKey;
  if (project.resolved?.owner && project.resolved.name) return `${project.resolved.owner}/${project.resolved.name}`;
  const wantedName = project.repo ? tailOf(project.repo) : tailOf(project.dir);
  // 目录是配置自己写的路径，比名称可靠：名称对不上时也认它，不要因为改名就丢掉整行。
  const byDir = repos.find((repo) => repo.dir === project.dir || repo.dir.endsWith(`/${project.dir}`));
  if (byDir) return byDir.key;
  if (wantedName) {
    const byName = repos.find((repo) => repo.name === wantedName);
    if (byName) return byName.key;
  }
  return null;
}

/**
 * 项目条：一行一个项目，计数来自**当前窗口**的票。
 *
 * 与 KPI 同源是刻意的：窗口只有前 100 条时，项目条若去别处数一遍，就会出现
 * 「KPI 说 12 张可接，项目条加起来 15 张」这种没法解释的差。窗口外还有更多这件事
 * 由板子顶部那条提示负责，不在这里假装全量。
 */
export function projectRows(
  projects: readonly BoardProjectInput[],
  issues: readonly Pick<BoardIssue, "repoKey" | "state" | "readiness">[],
  repos: readonly BoardRepoTargetInput[],
): ProjectRow[] {
  return projects.map((project) => {
    const repoKey = projectRepoKey(project, repos);
    const mine = repoKey === null ? [] : issues.filter((issue) => issue.repoKey === repoKey);
    return {
      key: project.key,
      dir: project.dir,
      owner: project.owner,
      repoKey,
      open: mine.filter((issue) => issue.state === "OPEN").length,
      closed: mine.filter((issue) => issue.state === "CLOSED").length,
      ready: mine.filter((issue) => issue.readiness === "ready").length,
      blocked: mine.filter((issue) => issue.readiness === "blocked").length,
      problem: project.problem,
    };
  });
}

export interface Facets {
  /** 配置里出现过的全部模块键，去重后按字母序。 */
  areas: string[];
  roles: string[];
}

/** 筛选项只从配置来：标签是事实，选项是配置——不然筛出来的东西取决于恰好拉到哪些票。 */
export function availableFacets(projects: readonly Pick<BoardProjectInput, "areas" | "owner">[]): Facets {
  const areas = new Set<string>();
  const roles = new Set<string>();
  for (const project of projects) {
    for (const area of project.areas) areas.add(area);
    if (project.owner) roles.add(project.owner);
  }
  return { areas: [...areas].sort(), roles: [...roles].sort() };
}

const labelsWithPrefix = (issue: Pick<BoardIssue, "labels">, prefix: string): string[] =>
  issue.labels.filter((label) => label.name.startsWith(prefix)).map((label) => label.name.slice(prefix.length));

/** 票上的模块键（`area:<k>` 标签）；没有就空数组。 */
export const issueAreas = (issue: Pick<BoardIssue, "labels">): string[] => labelsWithPrefix(issue, "area:");
/** 票上的角色键（`role:<o>` 标签）；没有就空数组。 */
export const issueRoles = (issue: Pick<BoardIssue, "labels">): string[] => labelsWithPrefix(issue, "role:");

export interface FacetFilter {
  area: string;
  role: string;
}

/**
 * 按 area / role 叠加筛票。
 *
 * 只做「选行」：不重算状态、不改顺序。空字符串表示这一维不筛。
 */
export function filterByFacets<T extends Pick<BoardIssue, "labels">>(
  issues: readonly T[],
  filter: FacetFilter,
): readonly T[] {
  const area = filter.area.trim();
  const role = filter.role.trim();
  if (!area && !role) return issues;
  return issues.filter((issue) => {
    if (area && !issueAreas(issue).includes(area)) return false;
    if (role && !issueRoles(issue).includes(role)) return false;
    return true;
  });
}
