import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { mapRpc } from "../../shared/map.ts";
import { getIssue, listIssues } from "../tracker/github.ts";
import { parseMapBody } from "../tracker/map-body.ts";
import { routeFromIssues, suggestNextSteps } from "../tracker/map-route.ts";
import { requireGithubRepo } from "./repo-gate.ts";

type MapInput = RpcInput<typeof mapRpc>;

/**
 * 地图页的数据源。
 *
 * 地图票与路线票必须一次读完：分两次读，用户看到的就是两个时刻的仓库拼在一起，
 * 「雾里还剩两条」可能对应一张已经关掉的票。
 */
export async function mapHandler(input: MapInput): Promise<RpcOutput<typeof mapRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "地图");
  if (!gate.ok) return gate;

  const detail = await getIssue(gate.ref.owner, gate.ref.name, input.number);
  if (!detail.ok) {
    return {
      ok: false,
      reason: detail.reason === "gh-missing" ? "gh-missing" : detail.reason === "not-found" ? "not-found" : "gh-failed",
      detail: detail.detail,
    };
  }

  const board = await listIssues(gate.ref.owner, gate.ref.name, 100);
  if (!board.ok) return { ok: false, reason: board.reason, detail: board.detail };

  const map = parseMapBody(detail.issue.body);
  const route = routeFromIssues(board.issues);
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
    suggestions: suggestNextSteps({ map, route }),
  };
}
