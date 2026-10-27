import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 更新检查。
 *
 * 只查、不装：宿主没有「安装插件」的调用面，替用户跑 `paseo plugin install` 又会绕开确认。
 * 所以这里返回当前版本、最新 tag 和一条可复制的安装命令——检查是自动的，动手仍是用户按的。
 */
export const updateCheckRpc = defineRpc({
  name: "deck.update.check",
  input: z.object({}),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      current: z.string(),
      latest: z.string().nullable(),
      updateAvailable: z.boolean(),
      tags: z.array(z.string()),
      /** 可直接粘贴到终端的安装命令；没有可用 tag 时指向默认分支。 */
      command: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["git-missing", "update-failed"]),
      detail: z.string(),
    }),
  ]),
});
