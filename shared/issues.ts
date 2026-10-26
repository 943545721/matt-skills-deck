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
const listFailure = z.object({
  ok: z.literal(false),
  reason: z.enum(["no-repo", "unsupported-host", "gh-missing", "gh-failed"]),
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
    listFailure,
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
      issue: issueSummary.extend({ body: z.string() }),
      comments: z.array(comment),
    }),
    listFailure,
  ]),
});
