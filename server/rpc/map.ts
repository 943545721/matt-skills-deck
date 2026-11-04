import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { InvalidMapReference, MapReference, mapRpc } from "../../shared/map.ts";
import type { BlockerRef } from "../../shared/issues.ts";
import type { DependencyScope } from "../../shared/edge-rules.ts";
import { dependencyRefOf, parseCrossRepoBlockRefs } from "../../shared/edge-rules.ts";
import { parseMapBody } from "../tracker/map-body.ts";
import { groupRoute, routeFromIssues, routeLevels, suggestNextSteps } from "../tracker/map-route.ts";
import type { RepoSummary } from "../tracker/read.ts";
import { readBoard, readIssue } from "../tracker/read.ts";
import { readWorkspaceConfig } from "../tracker/workspace-repo.ts";
import { containerKindOf } from "../../shared/container-kind.ts";
import { parseSpecBody } from "../../shared/spec-body.ts";

type MapInput = RpcInput<typeof mapRpc>;

/** 一张要被收引用的票：地图票自己，或这张图上真的画出来的路线票。 */
interface ReferenceSource {
  repoKey: string;
  body?: string;
  blockedBy: readonly BlockerRef[];
}

/**
 * 引用指向的网页地址。
 *
 * host 从工作区里的同一个仓库记录取（自建 GitLab 的 webUrl 和 github 不同）；
 * 记录里没有这个仓库时退回 github —— 引用的写法本身就是 `owner/repo#n`，
 * 拼出来的地址至少能让人点过去看看到底是哪个仓库。
 */
function referenceUrlOf(repo: string, number: number, repos: readonly RepoSummary[]): string | null {
  const record = repos.find((item) => item.key === repo);
  if (!record) return `https://github.com/${repo}/issues/${number}`;
  if (record.webUrl) return `${record.webUrl.replace(/\/+$/, "")}/issues/${number}`;
  if (record.host === "gitlab") return `https://gitlab.com/${repo}/issues/${number}`;
  return `https://github.com/${repo}/issues/${number}`;
}

/** 与读路径同一口径的解析范围：项目清单 + 当前仓库 + 工作区里能连上的仓库。 */
function scopeOf(
  repoKey: string,
  projects: readonly { key: string; repo: string | null }[],
  repoKeys: readonly string[],
): DependencyScope {
  return {
    projects,
    currentRepo: repoKey === "local" ? null : repoKey,
    repos: repoKeys,
  };
}

/**
 * 从已经合并好的 `blockedBy` 里收跨仓库引用。
 *
 * 只收 `source: "body"` 且不是本仓库的那些：原生边没有 `repo` 字段，
 * 同仓库的引用也不是「对方仓库」——那张票本来就在这张图上。
 * 数据源是读路径的合并结果，这里不重新解析正文。
 */
function mergedReferencesOf(
  sources: readonly ReferenceSource[],
  currentRepo: string,
  repos: readonly RepoSummary[],
): MapReference[] {
  const byKey = new Map<string, MapReference>();
  for (const source of sources) {
    for (const blocker of source.blockedBy) {
      if (!blocker.repo || blocker.repo === currentRepo || blocker.source !== "body") continue;
      const key = `${blocker.repo}#${blocker.number}`;
      const stale = blocker.state === "UNKNOWN" || blocker.stale === true;
      const seen = byKey.get(key);
      // 同一张对方票被多张票引用：只要有一处读到了就按读到的算，不让一次超时把它标成失效。
      if (seen && (!seen.stale || stale)) continue;
      byKey.set(key, {
        repo: blocker.repo,
        number: blocker.number,
        title: blocker.title,
        state: blocker.state,
        stale,
        url: referenceUrlOf(blocker.repo, blocker.number, repos),
      });
    }
  }
  return [...byKey.values()].sort(
    (left, right) => left.number - right.number || left.repo.localeCompare(right.repo),
  );
}

/**
 * 认不出来的引用：正文里有这一条，但 `blockedBy` 合并时被解析层丢掉了。
 *
 * 读路径把它们当「不是阻塞项」忽略是对的（不能猜仓库），可地图页不能因此装作没写过；
 * 这里用同一批纯函数再问一次「为什么认不出来」，把原因原样交给人看。
 */
function invalidReferencesOf(
  sources: readonly ReferenceSource[],
  projects: readonly { key: string; repo: string | null }[],
  repoKeys: readonly string[],
): InvalidMapReference[] {
  const byText = new Map<string, InvalidMapReference>();
  for (const source of sources) {
    const scope = scopeOf(source.repoKey, projects, repoKeys);
    for (const raw of parseCrossRepoBlockRefs(source.body)) {
      if (byText.has(raw)) continue;
      const parsed = dependencyRefOf(raw, scope);
      if (parsed.ok) continue;
      byText.set(raw, { text: raw, detail: parsed.detail });
    }
  }
  return [...byText.values()].sort((left, right) => left.text.localeCompare(right.text));
}

/** `.paseo-deck.json` 的项目清单；读不出来就当没有（写侧会因此拒绝跨仓库引用）。 */
async function projectList(workspaceDir: string): Promise<{ key: string; repo: string | null }[]> {
  const config = await readWorkspaceConfig(workspaceDir);
  return config.ok ? config.config.projects.map((project) => ({ key: project.key, repo: project.repo })) : [];
}

/**
 * 地图页的数据源。
 *
 * 地图票与路线票必须一次读完：分两次读，用户看到的就是两个时刻的仓库拼在一起，
 * 「雾里还剩两条」可能对应一张已经关掉的票。
 *
 * 数据源只在本仓库：多仓库工作区里按 `repoKey` 读板子，另一个项目的同号票不会混进路线；
 * 正文里的跨仓库引用是另一回事——它指向的是「对方那张票」，要单独列出来。
 */
export async function mapHandler(input: MapInput): Promise<RpcOutput<typeof mapRpc>> {
  const read = await readIssue(input.workspaceDir, input.number, { repoKey: input.repoKey });
  if (!read.ok) return read;
  const detail = read.result;
  if (!detail.ok) return { ok: false, reason: detail.reason, detail: detail.detail };

  // 地图正文里的编号是仓库内编号：路线必须读同一个仓库，不能把别的仓库的同号票拼进来。
  // `withBody` 只为辨认「写错的引用」：合并用的 blockedBy 不需要它，但原文要看。
  const board = await readBoard(input.workspaceDir, { limit: 100, repoKey: read.repoKey, withBody: true });
  if (!board.ok) return board;

  const map = parseMapBody(detail.issue.body);
  const containerKind = containerKindOf(detail.issue);
  const route = routeFromIssues(board.issues);

  // 引用只从「这张图上真的画出来的票」里收：地图票自己 + 路线票。
  // 板子上没进路线的票（别的标签、别的容器）不属于这一页，把它们的引用列上来只会让人误会。
  const routeNumbers = new Set(route.map((item) => item.number));
  const sources: ReferenceSource[] = [
    { repoKey: read.repoKey, body: detail.issue.body, blockedBy: detail.issue.blockedBy },
    ...board.issues
      .filter((issue) => routeNumbers.has(issue.number))
      .map((issue) => ({ repoKey: issue.repoKey, body: issue.body, blockedBy: issue.blockedBy })),
  ];
  const projects = await projectList(input.workspaceDir);
  const repoKeys = board.repos.map((item) => item.key);

  return {
    ok: true,
    repoKey: read.repoKey,
    issue: {
      number: detail.issue.number,
      title: detail.issue.title,
      url: detail.issue.url,
      state: detail.issue.state,
    },
    map,
    // 读路径已经把正文那行解析好了，地图页不必再看一遍 Markdown。
    derivedFrom: detail.issue.derivedFrom ?? null,
    containerKind: containerKind === "spec" ? "spec" : "map",
    spec: containerKind === "spec" ? parseSpecBody(detail.issue.body) : null,
    route,
    groups: groupRoute(route),
    levels: routeLevels(route),
    suggestions: suggestNextSteps({ map, route }),
    references: mergedReferencesOf(sources, read.repoKey, board.repos),
    invalidRefs: invalidReferencesOf(sources, projects, repoKeys),
  };
}
