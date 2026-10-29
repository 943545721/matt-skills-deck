import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { SKILL_MODES } from "./workspace-projects.ts";

/**
 * 插件设置（宿主级，跟随这台机器而不是某个工作区）。
 *
 * 后端选择决定读写落到哪，刷新间隔决定界面多久自己重读，调试日志决定 `record()`
 * 还写不写缓冲，外观决定用哪套像素皮肤。设置与行为必须一一对应，
 * 不做「存了但没人读」的装饰性开关。
 */
export const APPEARANCES = ["auto", "dark", "light", "classic"] as const;

export type Appearance = (typeof APPEARANCES)[number];

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
    /** auto 跟随宿主；dark / light 是真正的深底浅字 / 纯白底黑字；classic 是 DSH 原版两套像素皮肤。 */
    appearance: z.enum(APPEARANCES).default("auto"),
    /**
     * 技能怎么落到各项目：unified 先备份、再清空、再装；per-project 只补缺失。
     * 默认 per-project —— 老用户升级后行为不变，一个文件都不会被删。
     * 单个项目可以在 `.paseo-deck.json` 的 `skillsMode` 里覆盖这里。
     */
    skillsMode: z.enum(SKILL_MODES).default("per-project"),
  }),
});

export type DeckSettings = z.infer<typeof deckSettings.schema>;
