import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceDirSchema = z.string().min(1);

const labelInfo = z.object({
  name: z.string(),
  /** 6 位小写十六进制、不带井号；空串 = 这个标签还没有颜色。 */
  color: z.string(),
  description: z.string(),
});

const failure = z.object({
  ok: z.literal(false),
  reason: z.enum(["no-repo", "unsupported-host", "gh-missing", "gh-failed", "invalid"]),
  detail: z.string(),
});

/**
 * 标签配色。
 *
 * 颜色统一成「6 位小写十六进制、不带井号」：GitHub 上同一批标签里大小写是混的
 * （实测 wayfinder:grilling 存的是大写 9D7CD8），不归一化就会把「颜色没变」判成变化，
 * 白发一次请求，界面上还会闪一下。
 */
export const labelsListRpc = defineRpc({
  name: "deck.labels.list",
  input: z.object({ workspaceDir: workspaceDirSchema }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), labels: z.array(labelInfo) }),
    failure,
  ]),
});

export const labelsColorsRpc = defineRpc({
  name: "deck.labels.colors",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    changes: z.array(z.object({ name: z.string().min(1), color: z.string().min(1) })).min(1).max(50),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      applied: z.array(z.object({ name: z.string(), color: z.string() })),
      failed: z.array(z.object({ name: z.string(), detail: z.string() })),
    }),
    failure,
  ]),
});
