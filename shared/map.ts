import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 地图页契约。
 *
 * 一次取回三样东西：地图票自身的五区块、路线上的票、以及按现状推出来的下一步建议。
 * 合成一条 RPC 而不是三条：它们必须来自同一次读取，否则「雾里还剩两条」和
 * 「路线里哪张开着」可能对应两个不同时刻的仓库，界面给出的建议就成了自相矛盾的说法。
 */

const routeItem = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  kind: z.enum(["research", "prototype", "grilling", "task"]),
});

const decision = z.object({
  title: z.string(),
  url: z.string(),
  gist: z.string(),
});

const mapBody = z.object({
  destination: z.string(),
  notes: z.string(),
  decisions: z.array(decision),
  fog: z.array(z.string()),
  outOfScope: z.array(z.string()),
});

/** 建议码：只说「哪种情况」，人话由客户端按当前语言组装。 */
const suggestion = z.object({
  code: z.enum([
    "no-destination",
    "fog-open",
    "research-open",
    "grilling-open",
    "prototype-open",
    "task-open",
    "no-route",
    "all-closed",
  ]),
  number: z.number().int().optional(),
  count: z.number().int().optional(),
});

const failure = z.object({
  ok: z.literal(false),
  reason: z.enum(["no-repo", "unsupported-host", "gh-missing", "gh-failed", "not-found", "invalid"]),
  detail: z.string(),
});

export const mapRpc = defineRpc({
  name: "deck.map",
  input: z.object({
    workspaceDir: z.string().min(1),
    /** 地图票的票号。 */
    number: z.number().int().min(1),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      issue: z.object({
        number: z.number().int(),
        title: z.string(),
        url: z.string(),
        state: z.enum(["OPEN", "CLOSED"]),
      }),
      map: mapBody,
      route: z.array(routeItem),
      suggestions: z.array(suggestion),
    }),
    failure,
  ]),
});
