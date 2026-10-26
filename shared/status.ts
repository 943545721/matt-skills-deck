import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * `deck.status`：面板与首页共用的环境读数。
 *
 * 为什么做成 RPC：客户端拿不到进程、PATH、daemon 工作目录这些信息，只能在服务端读。
 * 输出里刻意把「gh 不可用」表达成 `available:false` 加一句原因，而不是抛错——
 * 环境缺工具是常态（用户没装 gh），界面要能如实显示「为什么读不到票」，不能变成整页报错。
 */
export const statusRpc = defineRpc({
  name: "deck.status",
  input: z.object({}),
  output: z.object({
    pluginVersion: z.string(),
    node: z.string(),
    daemonCwd: z.string(),
    gh: z.object({
      available: z.boolean(),
      path: z.string().nullable(),
      version: z.string().nullable(),
      error: z.string().nullable(),
    }),
  }),
});
