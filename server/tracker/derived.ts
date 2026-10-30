/**
 * 反查：一条需求一共有哪些地图是从它长出来的。
 *
 * 为什么需要反查：边只写在地图票正文（`Derived from: #19`），需求票上什么都不存。
 * 这样只有一处真相，手改也只需要改一处；代价是想从需求往下看，就得把地图票的正文读一遍。
 * 地图通常只有几张，板子一次就能读完，所以这里不建缓存——缓存与正文不一致时，坏的是
 * 「我明明改过」这种最难解释的错。
 */

import type { BoardIssue } from "../../shared/issues.ts";
import { readBoard } from "./read.ts";

/** 一张从某条需求长出来的地图。只给能点过去的最小字段。 */
export interface DerivedMapRef {
  number: number;
  title: string;
  repoKey: string;
}

export interface DerivedMapsRead {
  ok: true;
  maps: DerivedMapRef[];
  /** 板子只读到第一页：远端还有票没看，这张表可能不全。 */
  truncated: boolean;
}

export interface DerivedMapsFailure {
  ok: false;
  detail: string;
}

/** 一次最多读多少张票去找地图：再多就该去做分页，而不是把首屏拖慢。 */
const SCAN_LIMIT = 100;

/**
 * 找 `derivedFrom === source` 的地图票。
 *
 * `repoKey` 给了就只读那个仓库：票号只在仓库内唯一，跨仓库扫会读出别的仓库的同号需求。
 * 读失败时返回 `ok:false` 而不是空表——「读不到」与「确实没有」在界面上必须分开说。
 */
export async function mapsDerivedFrom(
  workspaceDir: string,
  source: { number: number; repoKey?: string },
): Promise<DerivedMapsRead | DerivedMapsFailure> {
  const board = await readBoard(workspaceDir, {
    limit: SCAN_LIMIT,
    includeClosed: true,
    view: "all",
    ...(source.repoKey ? { repoKey: source.repoKey } : {}),
  });
  if (!board.ok) return { ok: false, detail: board.detail };

  const maps = board.issues
    .filter((issue: BoardIssue) => issue.isMap && issue.derivedFrom === source.number)
    .map((issue: BoardIssue) => ({ number: issue.number, title: issue.title, repoKey: issue.repoKey }));

  return { ok: true, maps, truncated: board.hasMore };
}
