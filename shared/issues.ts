import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceDirSchema = z.string().min(1);

const repo = z.object({
  host: z.enum(["github", "gitlab", "local", "other"]),
  owner: z.string(),
  name: z.string(),
  /** 只在能推断出来时给：GitHub 是 https://github.com/owner/name，本地后端为 null。 */
  webUrl: z.string().nullable(),
});

const label = z.object({ name: z.string(), color: z.string() });

/** issue 与 pull request 在 GitHub 上共用编号空间，但它们是两张不同的票。 */
const itemKind = z.enum(["issue", "pull-request"]);
const itemState = z.enum(["OPEN", "CLOSED"]);

/**
 * 阻塞引用。
 *
 * 只收编号、标题、状态：界面要能说「被 #12 阻塞」并让人点过去，
 * 不需要把阻塞者的整份正文再取一遍（那是详情页的事）。
 *
 * `state` 多出一个 `UNKNOWN`：跨仓库引用读不到对方那张票（仓库不可达 / 票号不存在）时，
 * 不知道它是开还是关——按「还堵着」算，不能当作已经解除。界面靠 `stale` 说清原因。
 */
const blocker = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "UNKNOWN"]),
  kind: itemKind,
  /** 跨仓库引用的对方仓库（`owner/name`）；本仓库的阻塞者没有这一位。 */
  repo: z.string().optional(),
  /** 这条边从哪读来的：后端原生依赖边，还是正文隐藏区段里的 `Blocked by:` 行。 */
  source: z.enum(["native", "body"]).optional(),
  /** 引用失效：对方仓库或票号读不到。仍然算阻塞，只是不能当成「已解除」。 */
  stale: z.boolean().optional(),
});

/**
 * 一票的处置状态，由服务端按同一口径算好再下发。
 *
 * 客户端不重算：面板、MCP、地图页三处都读这一个字段，
 * 否则「可接」在三个地方可能给出不同答案。
 */
const readiness = z.enum(["ready", "claimed", "blocked", "closed"]);

/** 详情页的父子边：只带能点过去的最小字段，不把子票整份正文再取一遍。 */
const relatedIssue = z.object({
  number: z.number().int(),
  title: z.string(),
  state: itemState,
  kind: itemKind,
  containerKind: z.enum(["map", "spec"]).nullable().optional(),
});

const parentIssue = z.object({
  number: z.number().int(),
  title: z.string(),
  containerKind: z.enum(["map", "spec"]).nullable().optional(),
});

const issueSummary = z.object({
  number: z.number().int(),
  title: z.string(),
  state: itemState,
  url: z.string(),
  updatedAt: z.string(),
  createdAt: z.string(),
  /**
   * 关闭时刻（GitHub / GitLab 都给）。缺省 = 这次没取这一列，或后端不提供：
   * 本地 Markdown 后端只有 state，没有关票时间，所以那里永远是缺省。
   * 时间线靠它写「哪一刻关的」；没有就少一行，绝不拿 updatedAt 顶替。
   */
  closedAt: z.string().nullable().optional(),
  labels: z.array(label),
  assignees: z.array(z.string()),
  isMap: z.boolean(),
  /** DSH container identity when the detail/list request included enough body data. */
  containerKind: z.enum(["map", "spec"]).nullable().optional(),
  kind: itemKind,
  /** PR 专用：合并后 state 仍是 CLOSED，靠这一位区分「关了」和「合了」。 */
  merged: z.boolean(),
  blockedBy: z.array(blocker),
  readiness,
  /** 父子边：读得到时给父票号；null 表示明确没有父票；缺省表示这次没取这一列。 */
  parentKey: z.string().nullable().optional(),
});

/**
 * 合板里的一张票必须能回答「它属于哪个仓库」。
 *
 * 票号只在仓库内唯一，所以列表项带 `repoKey`；同一个 `#12` 在两个仓库里是两张不同的票，
 * 任何写操作都必须把 repoKey 一起带上。
 */
const boardIssue = issueSummary.extend({
  repoKey: z.string(),
  /** 只在工具显式要正文时出现（判 spec / 按正文筛 query）；界面刷新不带，别让每行多背一份正文。 */
  body: z.string().optional(),
  containerKind: z.enum(["map", "spec"]).nullable().optional(),
});

export type BoardIssue = z.infer<typeof boardIssue>;

/**
 * 板子上的一个仓库。
 *
 * `dir` 是本地代码目录：Agent 修复 / 查阅时需要的正是它，光有 `owner/name` 还要再猜一次。
 * `readOnly` 表示该仓库是否禁止写；GitLab 也可写，实际写入由每次操作的权限闸门决定。
 */
const repoSummary = repo.extend({
  key: z.string(),
  dir: z.string(),
  readOnly: z.boolean(),
});

export type RepoSummary = z.infer<typeof repoSummary>;

/**
 * 读路径的失败一律走 `ok:false` 返回值，不走抛异常。
 *
 * 原因：「这个工作区没配仓库」「没装 gh」都是正常状态，不是程序缺陷。
 * 用异常会让 useQuery 把它当错误、还得多接一层 error UI；用返回值则可以直接把
 * reason 映射成一句人话，和空列表并列显示。
 */
const failureReason = z.enum([
  "no-repo",
  "unsupported-host",
  "gh-missing",
  /** 装了 gh 但没有登录态：请求根本没到 GitHub，不能跟「远端拒绝」混成一句话。 */
  "gh-unauth",
  "gh-failed",
  "not-found",
  "invalid",
  /** 现有标签读不全：整体替换会删掉没读到的标签，所以拒绝。 */
  "labels-truncated",
  /** 本地后端写文件失败（权限、磁盘、非法的票号路径）。 */
  "local-failed",
  /** 装了 glab 但没有登录态。 */
  "glab-missing",
  "glab-unauth",
  /** glab 请求本身失败（非登录问题）。 */
  "glab-failed",
]);

export type FailureReason = z.infer<typeof failureReason>;

/** 合板里某一个仓库读取失败：不拖垮其他仓库，但要如实说清是哪一份失败。 */
const repoFailure = z.object({
  repoKey: z.string(),
  reason: failureReason,
  detail: z.string(),
});

const failure = z.object({
  ok: z.literal(false),
  reason: failureReason,
  detail: z.string(),
  /**
   * 已经解析出来的仓库。失败时也带上：界面顶栏靠它显示「owner/name」，
   * 只因为读列表失败就退回「未关联仓库」，会让用户以为远端没认出来。
   * 远端本身就没解析出来（no-repo / unsupported-host）时没有这个字段。
   */
  repo: repo.optional(),
  /**
   * 写请求可能已经送达：只出现在新建票失败时。界面不能把这种失败当成
   * 「确定没建」而提示重新提交，否则会造重复票。
   */
  maybeCreated: z.boolean().optional(),
});

const listView = z.enum(["all", "open", "closed", "ready", "blocked", "merged"]);
const sortKey = z.enum(["updated", "created", "number", "title"]);

/**
 * 计数块。
 *
 * 它描述的是「本次读到的窗口」（默认最多各 100 条），不是全仓统计——
 * 界面上必须把窗口一起说清楚，否则用户会拿一个局部数字做全仓判断。
 */
const counts = z.object({
  total: z.number().int(),
  open: z.number().int(),
  closed: z.number().int(),
  ready: z.number().int(),
  claimed: z.number().int(),
  blocked: z.number().int(),
  merged: z.number().int(),
  issues: z.number().int(),
  pullRequests: z.number().int(),
});

export const issuesListRpc = defineRpc({
  name: "deck.issues.list",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    /** 兼容旧入口：等价于 view=open / all。 */
    includeClosed: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    view: listView.optional(),
    /** 只看某一种票：任务列表页签给 issue，拉取请求页签给 pull-request。 */
    kind: itemKind.optional(),
    label: z.string().min(1).optional(),
    sort: sortKey.optional(),
    /** 只读一个仓库（`owner/name`）；省略表示整个工作区里的全部仓库。 */
    repoKey: z.string().min(1).max(200).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      /** 只有一个仓库时仍然给：单仓库工作区的老入口靠它显示顶栏。 */
      repo: repo.optional(),
      /** 本次板子覆盖的仓库（合板时多个）。 */
      repos: z.array(repoSummary),
      issues: z.array(boardIssue),
      /** 某个仓库读失败时只在顶部提示这一行，其余仓库照常显示。 */
      failures: z.array(repoFailure),
      totalCount: z.number().int(),
      fetchedAt: z.string(),
      /** 远端还有更多票没取：界面要提示「这是最近 N 条」。 */
      hasMore: z.boolean(),
      counts,
      /** GraphQL 被限流时回退 REST；合板里各仓库来源不一致时给 mixed。 */
      source: z.enum(["graphql", "rest", "local", "gitlab", "mixed"]),
      rateLimit: z
        .object({
          limit: z.number().int(),
          remaining: z.number().int(),
          resetAt: z.string(),
        })
        .nullable(),
    }),
    failure,
  ]),
});

const comment = z.object({
  author: z.string(),
  createdAt: z.string(),
  body: z.string(),
});

export const issuesDetailRpc = defineRpc({
  name: "deck.issues.detail",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    number: z.number().int().min(1),
    /** 不传按 issue 处理；拉取请求页签传 pull-request。编号空间共用，不能靠猜。 */
    kind: itemKind.optional(),
    /** 票属于哪个仓库。单仓库工作区可以省略；多仓库时必须带上，否则同号票会读错。 */
    repoKey: z.string().min(1).max(200).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      repo,
      /** 回显票所属仓库，界面拿它拼 `owner/name #12`。 */
      repoKey: z.string(),
      // labelCount 是远端这张票的标签总数：大于 labels.length 说明我们只读到一部分，
      // 界面必须禁止「整体替换」（PUT 会把没读到的标签一起删掉）。
      issue: issueSummary.extend({ body: z.string(), labelCount: z.number().int() }),
      /** 父容器（地图/规格）：详情页要给一条能点回去的父票入口。 */
      parent: parentIssue.nullable().optional(),
      /** 子票：只给能点过去的最小字段；完整列表由地图详情负责。 */
      children: z.array(relatedIssue).optional(),
      /** 子票总数：大于 children.length 时界面要如实说「只显示了前 N 张」。 */
      childrenTotal: z.number().int().optional(),
      /** 反向依赖：这张票正在阻塞谁。 */
      blocking: z.array(blocker).optional(),
      /** true 表示反向上游还有更多边没读回来。 */
      blockingTruncated: z.boolean().optional(),
      comments: z.array(comment),
      /** 评论总数：大于 comments.length 说明只给了最早的 100 条。 */
      commentCount: z.number().int(),
    }),
    failure,
  ]),
});

/**
 * 三条写操作。
 *
 * 写操作的失败同样走 `ok:false`：它们和读共享同一份失败话术（没远端、没 gh、无权限），
 * 分成两套只会让界面维护两份映射表。校验类错误用 `invalid`，它表示「这个输入不该发出去」，
 * 而不是「远端拒绝了」——两者的提示该不一样。
 */
export const issuesCommentRpc = defineRpc({
  name: "deck.issues.comment",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    number: z.number().int().min(1),
    body: z.string().min(1).max(60_000),
    /** PR 的评论在 DSH 里是只读的；传 pull-request 会被明确拒绝，而不是悄悄写到同号 issue。 */
    kind: itemKind.optional(),
    repoKey: z.string().min(1).max(200).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), comment }),
    failure,
  ]),
});

export const issuesCreateRpc = defineRpc({
  name: "deck.issues.create",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    title: z.string().min(1).max(256),
    body: z.string().max(60_000).optional(),
    labels: z.array(z.string().min(1)).optional(),
    /** 地图票：勾上就自动带 wayfinder:map，和源仓库的 `type: map` 同义。 */
    isMap: z.boolean().optional(),
    /** DSH 的六种票型；本地 Markdown 后端用它决定落 `.scratch` 的哪个容器。 */
    kind: z.enum(["map", "map-ticket", "spec", "spec-ticket", "bug", "issue"]).optional(),
    /** `.scratch/<name>` 容器名；spec 用 feature，map 用 effort。 */
    feature: z.string().min(1).max(80).optional(),
    effort: z.string().min(1).max(80).optional(),
    /** 子票挂在哪张父票下（`map-ticket` / `spec-ticket`）。面板 RPC 只在本地后端生效，远端会明确拒绝。 */
    parentKey: z.string().min(1).max(40).optional(),
    /** 同一次提交的重试：本地 `.scratch` 用它回查；面板 RPC 的远端路径会明确拒绝。 */
    idempotencyKey: z.string().min(1).max(200).optional(),
    /** 目标仓库。工作区里只有一个仓库时可以省略；多个时必填（不猜）。 */
    repoKey: z.string().min(1).max(200).optional(),
    /**
     * 票属于哪个项目、哪个模块（`.paseo-deck.json` v2 的键）。
     *
     * 与服务端同一条校验口径（`resolveIssueProjectScope`）：项目必须存在、模块必须登记在册，
     * 自动加的 `area:*` / `role:*` 由服务端并进 labels——界面自己拼标签就会和服务端判得不一样。
     */
    project: z.string().min(1).max(64).optional(),
    area: z.string().min(1).max(32).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      number: z.number().int(),
      /** 新票落在哪个仓库。 */
      repoKey: z.string(),
      url: z.string(),
      labels: z.array(z.string()),
      /** 票建成了但标签没挂上：界面要分开说，别让人以为整件事失败。 */
      labelsFailed: z.boolean(),
      /** 本地 Markdown 后端新建的文件路径。 */
      path: z.string().optional(),
      /** 幂等回查命中了已有的票，这次没有新建。 */
      reused: z.boolean().optional(),
    }),
    failure,
  ]),
});

export const issuesSetLabelsRpc = defineRpc({
  name: "deck.issues.labels.replace",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    number: z.number().int().min(1),
    /** 整体替换语义：这里就是「这张票应该有的标签全集」。 */
    labels: z.array(z.string().min(1)),
    kind: itemKind.optional(),
    repoKey: z.string().min(1).max(200).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), labels: z.array(label) }),
    failure,
  ]),
});

/** 接管 / 放手：把自己加进（或移出）指派人。 */
export const issuesAssignRpc = defineRpc({
  name: "deck.issues.assign",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    number: z.number().int().min(1),
    take: z.boolean(),
    repoKey: z.string().min(1).max(200).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), login: z.string(), assignees: z.array(z.string()) }),
    failure,
  ]),
});

/** 关闭 / 重开：源仓库的「完成」动作在 Paseo 里落成一次真实的状态写。 */
export const issuesStateRpc = defineRpc({
  name: "deck.issues.state",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    number: z.number().int().min(1),
    state: z.enum(["open", "closed"]),
    repoKey: z.string().min(1).max(200).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), state: itemState }),
    failure,
  ]),
});

export type IssueSummary = z.infer<typeof issueSummary>;
export type BlockerRef = z.infer<typeof blocker>;
export type Readiness = z.infer<typeof readiness>;
export type ListView = z.infer<typeof listView>;
export type SortKey = z.infer<typeof sortKey>;
export type ItemKind = z.infer<typeof itemKind>;
