import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 插件设置（宿主级，跟随这台机器而不是某个工作区）。
 *
 * 三项都直接影响服务端行为：后端选择决定读写落到哪，刷新间隔决定界面多久自己重读，
 * 调试日志决定 `record()` 还写不写缓冲。设置与行为必须一一对应，
 * 不做「存了但没人读」的装饰性开关。
 */
export const deckSettings = defineSettings({
  id: "deck",
  scope: "host",
  version: 1,
  schema: z.object({
    /** auto：有 GitHub 远端走 GitHub、有 GitLab 远端走 GitLab、都没有走本地 Markdown。 */
    backend: z.enum(["auto", "github", "gitlab", "local"]).default("auto"),
    /** 0 = 不自动刷新。 */
    refreshSeconds: z.number().int().min(0).max(600).default(60),
    /** 关掉后 `record()` 不再累积日志（已有的仍可读、可清空）。 */
    debugLogging: z.boolean().default(true),
  }),
});

export type DeckSettings = z.infer<typeof deckSettings.schema>;
