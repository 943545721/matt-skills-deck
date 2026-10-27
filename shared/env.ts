import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 环境检查契约。
 *
 * 每一项只回「事实 + 一句怎么修」，不在这里执行修复：装 gh、登录、建仓库都要用户点头，
 * 插件悄悄跑一条写命令比报错更危险。客户端把 `fix` 原样交给用户复制。
 */
const checkId = z.enum([
  "node",
  "git",
  "gh",
  "gh-auth",
  "glab",
  "glab-auth",
  "workspace",
  "repo",
  "backend",
  "skills",
  "labels",
]);

const check = z.object({
  id: checkId,
  status: z.enum(["ok", "warn", "fail", "skip"]),
  detail: z.string(),
  /** 可以安全复制的下一条命令；没有明确且安全的命令时省略。 */
  fix: z.string().optional(),
});

export const envCheckRpc = defineRpc({
  name: "deck.env.check",
  input: z.object({ workspaceDir: z.string().min(1).optional() }),
  output: z.object({
    backend: z.enum(["github", "gitlab", "local", "none"]),
    checks: z.array(check),
    checkedAt: z.string(),
  }),
});

export type EnvCheck = z.infer<typeof check>;
export type EnvCheckId = z.infer<typeof checkId>;
