import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 检查链的 RPC 契约。
 *
 * 目录与状态机在 `shared/checks.ts`，探测在 `server/checks.ts`；这里只固定线上形状。
 * `action` 故意放宽成 unknown：六种动作里有递归的 form → submitAction，
 * 在 zod 里复制一整棵判别联合，收益远小于让客户端直接 import 共享类型。
 * 服务端仍然只返回 `shared/checks.ts` 里定义的动作对象。
 */
const checkResult = z.object({
  id: z.string().min(1),
  status: z.enum(["ok", "warn", "fail", "unknown"]),
  detail: z.string().optional(),
  action: z.array(z.unknown()).optional(),
});

const guideState = z.object({
  current: z.string().nullable(),
  done: z.array(z.string()),
  blocked: z.array(z.string()),
});

export const checksRunRpc = defineRpc({
  name: "deck.checks.run",
  input: z.object({
    workspaceDir: z.string().min(1).optional(),
    backend: z.enum(["github", "gitlab", "markdown"]).optional(),
  }),
  output: z.object({
    backend: z.enum(["github", "gitlab", "markdown"]),
    checks: z.array(checkResult),
    guide: guideState,
    checkedAt: z.string(),
  }),
});
