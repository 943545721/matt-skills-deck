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
 */
const blocker = z.object({
  number: z.number().int(),
  title: z.string(),
  state: itemState,
  kind: itemKind,
});

/**
 * 一票的处置状态，由服务端按同一口径算好再下发。
 *
 * 客户端不重算：面板、MCP、地图页三处都读这一个字段，
 * 否则「可接」在三个地方可能给出不同答案。
 */
const readiness = z.enum(["ready", "claimed", "blocked", "closed"]);

const issueSummary = z.object({
  number: z.number().int(),
  title: z.string(),
  state: itemState,
  url: z.string(),
  updatedAt: z.string(),
  createdAt: z.string(),
  labels: z.array(label),
  assignees: z.array(z.string()),
  isMap: z.boolean(),
  kind: itemKind,
  /** PR 专用：合并后 state 仍是 CLOSED，靠这一位区分「关了」和「合了」。 */
  merged: z.boolean(),
  blockedBy: z.array(blocker),
  readiness,
});

/**
 * 读路径的失败一律走 `ok:false` 返回值，不走抛异常。
 *
 * 原因：「这个工作区没配仓库」「没装 gh」都是正常状态，不是程序缺陷。
 * 用异常会让 useQuery 把它当错误、还得多接一层 error UI；用返回值则可以直接把
 * reason 映射成一句人话，和空列表并列显示。
 */
const failure = z.object({
  ok: z.literal(false),
  reason: z.enum([
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
  ]),
  detail: z.string(),
  /**
   * 已经解析出来的仓库。失败时也带上：界面顶栏靠它显示「owner/name」，
   * 只因为读列表失败就退回「未关联仓库」，会让用户以为远端没认出来。
   * 远端本身就没解析出来（no-repo / unsupported-host）时没有这个字段。
   */
  repo: repo.optional(),
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
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      repo,
      issues: z.array(issueSummary),
      totalCount: z.number().int(),
      fetchedAt: z.string(),
      /** 远端还有更多票没取：界面要提示「这是最近 N 条」。 */
      hasMore: z.boolean(),
      counts,
      /** GraphQL 被限流时回退 REST；界面据此提示「本页缺阻塞关系」。 */
      source: z.enum(["graphql", "rest", "local", "gitlab"]),
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
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      repo,
      // labelCount 是远端这张票的标签总数：大于 labels.length 说明我们只读到一部分，
      // 界面必须禁止「整体替换」（PUT 会把没读到的标签一起删掉）。
      issue: issueSummary.extend({ body: z.string(), labelCount: z.number().int() }),
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
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      number: z.number().int(),
      url: z.string(),
      labels: z.array(z.string()),
      /** 票建成了但标签没挂上：界面要分开说，别让人以为整件事失败。 */
      labelsFailed: z.boolean(),
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
