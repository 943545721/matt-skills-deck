import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceDirSchema = z.string().min(1);

/**
 * 版本管理契约。
 *
 * 写操作全部要票：`deck.git.check` 先做一次只读预检，把「HEAD 是谁、索引指纹是什么、推到哪」
 * 记进一张 60 秒有效的票据；`commit` / `pull` / `push` / `fetch` 必须带着票据来。
 *
 * 这不是形式主义：Paseo 的面板可以在用户切走之后继续跑，没有票据就可能出现
 * 「用户看的是 A 状态的确认，实际提交的是 B 状态」。有票之后，状态变了就作废，写不出去。
 */
const failure = z.object({
  ok: z.literal(false),
  reason: z.enum([
    "no-workspace",
    "git-missing",
    "git-failed",
    "invalid",
    "blocked",
    "ticket-expired",
    "head-moved",
    "needs-choice",
  ]),
  detail: z.string(),
  /** 被挡住时逐条列出原因码，界面照原样显示，不要自己再翻译一遍。 */
  reasons: z.array(z.string()).optional(),
  /** 需要用户选远端时给出候选。 */
  candidates: z.array(z.string()).optional(),
});

const fileEntry = z.object({
  path: z.string(),
  /** porcelain 的 XY 两列编码，例如 M、??、A，界面按它选颜色。 */
  code: z.string(),
  staged: z.boolean(),
});

const branchInfo = z.object({
  name: z.string(),
  upstream: z.string(),
  upstreamGone: z.boolean(),
  ahead: z.number().int(),
  behind: z.number().int(),
});

export const gitStatusRpc = defineRpc({
  name: "deck.git.status",
  input: z.object({ workspaceDir: workspaceDirSchema }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      branch: branchInfo,
      headOid: z.string(),
      files: z.array(fileEntry),
      clean: z.boolean(),
      /** 一些仓库在 index 里有「打算加」的空文件，提交会被 git 拒绝，提前说清楚。 */
      hasIntentToAdd: z.boolean(),
    }),
    failure,
  ]),
});

export const gitDiffRpc = defineRpc({
  name: "deck.git.diff",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    path: z.string().min(1),
    staged: z.boolean().optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), diff: z.string(), truncated: z.boolean() }),
    failure,
  ]),
});

export const gitLogRpc = defineRpc({
  name: "deck.git.log",
  input: z.object({ workspaceDir: workspaceDirSchema, limit: z.number().int().min(1).max(100).optional() }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      commits: z.array(
        z.object({
          oid: z.string(),
          short: z.string(),
          subject: z.string(),
          author: z.string(),
          date: z.string(),
        }),
      ),
    }),
    failure,
  ]),
});

const writeOp = z.enum(["commit", "pull", "push", "fetch"]);

const plan = z.object({
  remote: z.string(),
  branch: z.string(),
  setUpstream: z.boolean(),
});

export const gitCheckRpc = defineRpc({
  name: "deck.git.check",
  input: z.object({ workspaceDir: workspaceDirSchema, op: writeOp, remote: z.string().optional() }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      ticketId: z.string(),
      expiresAt: z.string(),
      plan,
    }),
    failure,
  ]),
});

export const gitStageRpc = defineRpc({
  name: "deck.git.stage",
  input: z.object({ workspaceDir: workspaceDirSchema, paths: z.array(z.string().min(1)).min(1).max(200) }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), staged: z.array(z.string()) }), failure]),
});

export const gitUnstageRpc = defineRpc({
  name: "deck.git.unstage",
  input: z.object({ workspaceDir: workspaceDirSchema, paths: z.array(z.string().min(1)).min(1).max(200) }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), unstaged: z.array(z.string()) }), failure]),
});

export const gitCommitRpc = defineRpc({
  name: "deck.git.commit",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    ticketId: z.string().min(1),
    message: z.string().min(1).max(8_000),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), committed: z.boolean(), headBefore: z.string(), headAfter: z.string() }),
    failure,
  ]),
});

export const gitPullRpc = defineRpc({
  name: "deck.git.pull",
  input: z.object({ workspaceDir: workspaceDirSchema, ticketId: z.string().min(1) }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      /** up-to-date / fast-forward / unknown：读不到 HEAD 时回 unknown，绝不猜成 up-to-date。 */
      mode: z.enum(["up-to-date", "fast-forward", "unknown"]),
      headBefore: z.string(),
      headAfter: z.string(),
    }),
    failure,
  ]),
});

export const gitFetchRpc = defineRpc({
  name: "deck.git.fetch",
  input: z.object({ workspaceDir: workspaceDirSchema, ticketId: z.string().min(1) }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), remote: z.string() }), failure]),
});

export const gitPushRpc = defineRpc({
  name: "deck.git.push",
  input: z.object({ workspaceDir: workspaceDirSchema, ticketId: z.string().min(1) }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      mode: z.enum(["existing-upstream", "set-upstream"]),
      remote: z.string(),
      branch: z.string(),
      upToDate: z.boolean(),
    }),
    failure,
  ]),
});
