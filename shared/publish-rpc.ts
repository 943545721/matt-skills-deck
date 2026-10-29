import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 发布计划的 RPC 契约。
 *
 * 计划永远是 dry-run：这里只返回 argv、展示脚本、说明与确认令牌，不执行任何写命令。
 * 执行入口若以后接，必须先把同一份计划与令牌送回 `deck.publish.confirm` 复验。
 */
const publishCommand = z.object({
  argv: z.array(z.string()).min(1),
  why: z.string(),
  when: z.enum(["commit-identity-missing"]).optional(),
});

const publishSubject = z.object({
  cwd: z.string().min(1),
  name: z.string().min(1),
  visibility: z.enum(["private", "public"]),
  route: z.enum(["create", "existing-remote"]),
  commands: z.array(publishCommand).min(1),
  expiresAt: z.string().optional(),
});

const failure = z.object({
  ok: z.literal(false),
  reason: z.enum(["bad-name", "bad-cwd", "bad-owner", "inconsistent", "token-mismatch", "token-expired"]),
  detail: z.string(),
});

export const publishPlanRpc = defineRpc({
  name: "deck.publish.plan",
  input: z.object({
    cwd: z.string().min(1),
    name: z.string().min(1).max(100),
    visibility: z.enum(["private", "public"]).optional(),
    isGitRepo: z.boolean(),
    hasOrigin: z.boolean(),
    owner: z.string().nullable().optional(),
    remoteUrl: z.string().nullable().optional(),
    identity: z.enum(["configured", "missing", "unknown"]).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      cwd: z.string(),
      name: z.string(),
      visibility: z.enum(["private", "public"]),
      route: z.enum(["create", "existing-remote"]),
      dryRun: z.literal(true),
      commands: z.array(publishCommand),
      script: z.string(),
      confirmToken: z.string(),
      issuedAt: z.string(),
      expiresAt: z.string(),
      notes: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
    failure,
  ]),
});

export const publishConfirmRpc = defineRpc({
  name: "deck.publish.confirm",
  input: z.object({
    plan: publishSubject,
    token: z.string().min(1),
  }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), failure]),
});

/**
 * 真正执行建仓发布（DSH `wf.initPublish` 的等价入口）。
 *
 * 与上面的 dry-run 计划是两条路：计划只给人看与核对，执行则真的会 `git add`、
 * 提交、`gh repo create` 并 push。只有用户在向导里点下确认才会走到这里。
 * 失败档位与 DSH 房间一致：bad-name / no-git / no-gh / not-logged-in /
 * already-exists / network / permission / git-ownership / unknown。
 */
export const publishRunRpc = defineRpc({
  name: "deck.publish.run",
  input: z.object({
    workspaceDir: z.string().min(1),
    name: z.string().min(1).max(100),
    visibility: z.enum(["private", "public"]).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      owner: z.string(),
      name: z.string(),
      url: z.string(),
      route: z.enum(["created", "existing"]),
      healedOwnership: z.boolean(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum([
        "bad-name",
        "no-git",
        "no-gh",
        "not-logged-in",
        "already-exists",
        "network",
        "permission",
        "git-ownership",
        "unknown",
      ]),
      detail: z.string(),
      /** 半成功：远端仓库已经建好、只是后续推送没完成时带出来。 */
      repoUrl: z.string().optional(),
    }),
  ]),
});
