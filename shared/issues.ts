import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceDirSchema = z.string().min(1);

const repo = z.object({
  host: z.enum(["github", "gitlab", "other"]),
  owner: z.string(),
  name: z.string(),
  /** 只在能推断出来时给：GitHub 是 https://github.com/owner/name。 */
  webUrl: z.string().nullable(),
});

const label = z.object({ name: z.string(), color: z.string() });

const issueSummary = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  url: z.string(),
  updatedAt: z.string(),
  labels: z.array(label),
  assignees: z.array(z.string()),
  isMap: z.boolean(),
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
  reason: z.enum(["no-repo", "unsupported-host", "gh-missing", "gh-failed", "not-found", "invalid"]),
  detail: z.string(),
});

export const issuesListRpc = defineRpc({
  name: "deck.issues.list",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    includeClosed: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      repo,
      issues: z.array(issueSummary),
      totalCount: z.number().int(),
      fetchedAt: z.string(),
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
  input: z.object({ workspaceDir: workspaceDirSchema, number: z.number().int().min(1) }),
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
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), labels: z.array(label) }),
    failure,
  ]),
});
