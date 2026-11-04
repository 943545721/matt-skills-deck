import { z } from "zod";

/**
 * 时间线插件行的数据契约。
 *
 * 渲染器在这里把 `item.data` 校验成结构化数据：服务端或 transformer 写错形状时
 * 宿主显示不可用占位，而不是让组件里某个 `undefined.map` 炸掉整条时间线。
 * 所有 schema 都是 strip 语义（zod 默认），多写的字段不会泄漏到组件。
 */

export const promptActionSchema = z.enum([
  "diagnose",
  "fix",
  "research",
  "takeover",
  "handoff",
  "new-requirement",
  "discuss-wayfinder",
  "discuss-grill",
  "bug",
  "custom",
]);

export const suggestionSchema = z.object({
  intro: z.string(),
  prompt: z.string(),
  reason: z.string(),
  priority: z.number().optional(),
});

export const suggestDataSchema = z.object({
  items: z.array(suggestionSchema).max(4),
  toolName: z.string().optional(),
});

export const workRouteDataSchema = z.object({
  key: z.string(),
  action: z.enum(["report", "release"]).optional(),
  note: z.string().optional(),
  title: z.string().optional(),
  repoKey: z.string().optional(),
});

const promptContextSchema = z.object({
  repoKey: z.string().optional(),
  number: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  provider: z.string().optional(),
  notes: z.string().optional(),
});

export const commandDataSchema = z.object({
  command: z.string(),
  title: z.string(),
  lines: z.array(z.string()).max(50),
  workspaceId: z.string(),
  workspaceDir: z.string(),
  agentId: z.string().optional(),
  copyText: z.string().optional(),
  openBoard: z.boolean().optional(),
  session: z
    .object({
      action: promptActionSchema,
      context: promptContextSchema,
      prompt: z.string().optional(),
    })
    .optional(),
});

export type SuggestData = z.infer<typeof suggestDataSchema>;
export type WorkRouteData = z.infer<typeof workRouteDataSchema>;
export type CommandData = z.infer<typeof commandDataSchema>;
