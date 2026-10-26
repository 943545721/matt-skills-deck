import type { Issue } from "./github.ts";

/**
 * 列表排序：地图票优先 → 未关闭优先 → 最近更新优先。
 *
 * 为什么地图在前：源仓库把地图当成「这张地图有哪些票」的容器，用户打开任务板
 * 第一眼要找的是地图，而不是某个细节票。这条排序只表达意图，不改变数据。
 */
export function sortIssues(issues: readonly Issue[]): Issue[] {
  const rank = (issue: Issue) => (issue.isMap ? 0 : 1);
  const openRank = (issue: Issue) => (issue.state === "OPEN" ? 0 : 1);
  return [...issues].sort((left, right) => {
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    if (openRank(left) !== openRank(right)) return openRank(left) - openRank(right);
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}
