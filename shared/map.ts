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
  readiness: z.enum(["ready", "claimed", "blocked", "closed"]),
  blockedBy: z.array(z.number().int()),
});

/** 四个分组永远都在，空数组表示这一组确实没有票。 */
const routeGroup = z.object({
  readiness: z.enum(["ready", "claimed", "blocked", "closed"]),
  numbers: z.array(z.number().int()),
});

/** 层级由路线内部的阻塞边推导；closed / open 是这一层的进度。 */
const routeLevel = z.object({
  level: z.number().int().min(1),
  numbers: z.array(z.number().int()),
  total: z.number().int(),
  closed: z.number().int(),
  open: z.number().int(),
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
const specBody = z.object({
  problem: z.string(), solution: z.string(), userStories: z.array(z.string()), implDecisions: z.array(z.string()),
  testDecisions: z.array(z.string()), outOfScope: z.array(z.string()), furtherNotes: z.array(z.string()),
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

/**
 * 地图页里的一条跨仓库引用。
 *
 * 数据来自读路径已经合并好的 `blockedBy`（正文隐藏区段 → 对方那张票），
 * 地图页不在自己的契约里重新解析一遍正文。
 *
 * `state` 多一个 `UNKNOWN`：对方仓库或票号读不到时不知道开还是关，按「还堵着」算；
 * `stale` 表示原因。`url` 在能拼出对方网页地址时给（配置里没有这个仓库时为 null）。
 */
const mapReference = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "UNKNOWN"]),
  stale: z.boolean(),
  url: z.string().nullable(),
});

/**
 * 认不出来的引用：写成配置里没有的项目键、缺票号之类。
 *
 * 单独一列而不是塞进 `references`：这些条目连「对方是哪张票」都定不下来，
 * 没有可点的目标；但也不能静默丢掉——人要看到「哪一行写错了、错在哪」。
 */
const invalidReference = z.object({
  /** 正文里原样写的引用，不加工。 */
  text: z.string(),
  /** 为什么认不出来（哪一项、为什么、能怎么写）。 */
  detail: z.string(),
});

const failure = z.object({
  ok: z.literal(false),
  reason: z.enum([
    "no-repo",
    "unsupported-host",
    "gh-missing",
    "gh-unauth",
    "gh-failed",
    "not-found",
    "invalid",
    "labels-truncated",
    "local-failed",
    "glab-missing",
    "glab-unauth",
    "glab-failed",
  ]),
  detail: z.string(),
});

export const mapRpc = defineRpc({
  name: "deck.map",
  input: z.object({
    workspaceDir: z.string().min(1),
    /** 地图票的票号。 */
    number: z.number().int().min(1),
    /** 地图票所属仓库；多仓库工作区必填，路线票沿用它。 */
    repoKey: z.string().min(1).max(200).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      repoKey: z.string(),
      issue: z.object({
        number: z.number().int(),
        title: z.string(),
        url: z.string(),
        state: z.enum(["OPEN", "CLOSED"]),
      }),
      map: mapBody,
      /**
       * 这张地图是从哪条需求长出来的（正文 `Derived from: #19` 那一行）。
       *
       * null 表示正文里没有这一行，不代表「没有需求」；地图页只在有值时多画一行。
       */
      derivedFrom: z.number().int().nullable(),
      containerKind: z.enum(["map", "spec"]),
      spec: specBody.nullable(),
      route: z.array(routeItem),
      groups: z.array(routeGroup),
      levels: z.array(routeLevel),
      suggestions: z.array(suggestion),
      /** 这张图上（地图票自己 + 路线票）写到的跨仓库引用，按票号排序、去重。 */
      references: z.array(mapReference),
      /** 写法认不出来的引用，原样列出并说明原因。 */
      invalidRefs: z.array(invalidReference),
    }),
    failure,
  ]),
});

export type MapReference = z.infer<typeof mapReference>;
export type InvalidMapReference = z.infer<typeof invalidReference>;
