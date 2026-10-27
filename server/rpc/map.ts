import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { mapRpc } from "../../shared/map.ts";
import { parseMapBody } from "../tracker/map-body.ts";
import { groupRoute, routeFromIssues, routeLevels, suggestNextSteps } from "../tracker/map-route.ts";
import { readBoard, readIssue } from "../tracker/read.ts";

type MapInput = RpcInput<typeof mapRpc>;

/**
 * 地图页的数据源。
 *
 * 地图票与路线票必须一次读完：分两次读，用户看到的就是两个时刻的仓库拼在一起，
 * 「雾里还剩两条」可能对应一张已经关掉的票。
 */
export async function mapHandler(input: MapInput): Promise<RpcOutput<typeof mapRpc>> {
  const read = await readIssue(input.workspaceDir, input.number);
  if (!read.ok) return read;
  const detail = read.result;
  if (!detail.ok) return { ok: false, reason: detail.reason, detail: detail.detail };

  const board = await readBoard(input.workspaceDir, { limit: 100 });
  if (!board.ok) return board;
  if (!board.result.ok) return { ok: false, reason: board.result.reason, detail: board.result.detail };

  const map = parseMapBody(detail.issue.body);
  const route = routeFromIssues(board.result.issues);
  return {
    ok: true,
    issue: {
      number: detail.issue.number,
      title: detail.issue.title,
      url: detail.issue.url,
      state: detail.issue.state,
    },
    map,
    route,
    groups: groupRoute(route),
    levels: routeLevels(route),
    suggestions: suggestNextSteps({ map, route }),
  };
}
