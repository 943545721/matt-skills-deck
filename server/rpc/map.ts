import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { mapRpc } from "../../shared/map.ts";
import { parseMapBody } from "../tracker/map-body.ts";
import { groupRoute, routeFromIssues, routeLevels, suggestNextSteps } from "../tracker/map-route.ts";
import { readBoard, readIssue } from "../tracker/read.ts";
import { containerKindOf } from "../../shared/container-kind.ts";
import { parseSpecBody } from "../../shared/spec-body.ts";

type MapInput = RpcInput<typeof mapRpc>;

/**
 * 地图页的数据源。
 *
 * 地图票与路线票必须一次读完：分两次读，用户看到的就是两个时刻的仓库拼在一起，
 * 「雾里还剩两条」可能对应一张已经关掉的票。
 */
export async function mapHandler(input: MapInput): Promise<RpcOutput<typeof mapRpc>> {
  const read = await readIssue(input.workspaceDir, input.number, { repoKey: input.repoKey });
  if (!read.ok) return read;
  const detail = read.result;
  if (!detail.ok) return { ok: false, reason: detail.reason, detail: detail.detail };

  // 地图正文里的编号是仓库内编号：路线必须读同一个仓库，不能把别的仓库的同号票拼进来。
  const board = await readBoard(input.workspaceDir, { limit: 100, repoKey: read.repoKey });
  if (!board.ok) return board;

  const map = parseMapBody(detail.issue.body);
  const containerKind = containerKindOf(detail.issue);
  const route = routeFromIssues(board.issues);
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
    containerKind: containerKind === "spec" ? "spec" : "map",
    spec: containerKind === "spec" ? parseSpecBody(detail.issue.body) : null,
    route,
    groups: groupRoute(route),
    levels: routeLevels(route),
    suggestions: suggestNextSteps({ map, route }),
  };
}
