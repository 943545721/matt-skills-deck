import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceDirSchema = z.string().min(1);

/**
 * wayfinder 的五个标准标签。
 *
 * 颜色只是「新建仓库时补一份默认值」的建议，不是判据：面板认标签靠名字，
 * 已经按自己的配色改过颜色的仓库不会被当成缺标签。
 */
export const STANDARD_LABELS = [
  { name: "wayfinder:map", color: "6e7781", description: "一张地图：目标与路线" },
  { name: "wayfinder:research", color: "1d76db", description: "先研究清楚再动手" },
  { name: "wayfinder:prototype", color: "8250df", description: "做最小原型验证一个假设" },
  { name: "wayfinder:grilling", color: "d876e3", description: "把开放问题讨论成一个决定" },
  { name: "wayfinder:task", color: "0e8a16", description: "可以直接实施的任务" },
] as const;

const labelInfo = z.object({
  name: z.string(),
  /** 6 位小写十六进制、不带井号；空串 = 这个标签还没有颜色。 */
  color: z.string(),
  description: z.string(),
});

const failure = z.object({
  ok: z.literal(false),
  reason: z.enum([
    "no-repo",
    "unsupported-host",
    "gh-missing",
    "gh-unauth",
    "gh-failed",
    "invalid",
    "not-found",
    "local-failed",
    "glab-missing",
    "glab-unauth",
    "glab-failed",
  ]),
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
      /** 读回核对一致的标签。 */
      verified: z.array(z.object({ name: z.string(), color: z.string() })),
      /** 请求成功但读回颜色不一致。 */
      mismatched: z.array(z.object({ name: z.string(), expected: z.string(), actual: z.string() })),
      /** 读回失败：applied 只是「请求成功」，不能当成已确认。 */
      readbackFailed: z.boolean(),
    }),
    failure,
  ]),
});
