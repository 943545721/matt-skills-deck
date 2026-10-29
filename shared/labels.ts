import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceDirSchema = z.string().min(1);

/**
 * 核心标签的唯一清单（10 个）。
 *
 * 逐字照搬 DSH 的 `CANONICAL_LABELS`：五个 triage 角色 + 五个 wayfinder 标签，
 * 名字、颜色、描述都不在这里改写。检查、补全指引与初始化命令都从这一份派生。
 *
 * 颜色只是「新建仓库时补一份默认值」的建议，不是判据：面板认标签靠名字，
 * 已经按自己的配色改过颜色的仓库不会被当成缺标签。
 */
export const STANDARD_LABELS = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  {
    name: "needs-triage",
    color: "fbca04",
    description: "Maintainer needs to evaluate this issue (unexamined, awaiting diagnosis)",
  },
  { name: "needs-info", color: "5319e7", description: "Waiting on reporter for more information" },
  { name: "ready-for-agent", color: "0e8a16", description: "Fully specified, ready for an AFK agent to implement" },
  { name: "ready-for-human", color: "b60205", description: "Requires human implementation" },
  {
    name: "wayfinder:grilling",
    color: "9D7CD8",
    description: "Open decision/discussion ticket (wayfinder grilling type) — drives the deck's discuss action",
  },
  {
    name: "wayfinder:map",
    color: "8b5cf6",
    description: "The map issue (wayfinder) — owns Notes/Decisions so far/Fog",
  },
  { name: "wayfinder:prototype", color: "f59e0b", description: "Prototype ticket (wayfinder)" },
  { name: "wayfinder:research", color: "0ea5e9", description: "Research ticket (wayfinder)" },
  { name: "wayfinder:task", color: "10b981", description: "Task ticket (wayfinder)" },
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
 * 写后读回的核对：请求成功不等于颜色真的变了（代理、缓存都可能吞掉）。
 * GitHub 与 GitLab 共用同一条口径，返回空串表示读回里根本没有这个标签。
 */
export function reconcileLabelColors(
  applied: readonly { name: string; color: string }[],
  labels: readonly { name: string; color: string }[],
): { verified: { name: string; color: string }[]; mismatched: { name: string; expected: string; actual: string }[] } {
  const seen = new Map(labels.map((label) => [label.name, label.color]));
  const verified: { name: string; color: string }[] = [];
  const mismatched: { name: string; expected: string; actual: string }[] = [];
  for (const change of applied) {
    const actual = seen.get(change.name) ?? "";
    if (actual === change.color) verified.push(change);
    else mismatched.push({ name: change.name, expected: change.color, actual });
  }
  return { verified, mismatched };
}

/**
 * 标签配色。
 *
 * 颜色统一成「6 位小写十六进制、不带井号」：GitHub 上同一批标签里大小写是混的
 * （实测 wayfinder:grilling 存的是大写 9D7CD8），不归一化就会把「颜色没变」判成变化，
 * 白发一次请求，界面上还会闪一下。
 */
export const labelsListRpc = defineRpc({
  name: "deck.labels.list",
  input: z.object({ workspaceDir: workspaceDirSchema, repoKey: z.string().min(1).max(200).optional() }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), labels: z.array(labelInfo) }),
    failure,
  ]),
});

export const labelsColorsRpc = defineRpc({
  name: "deck.labels.colors",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    repoKey: z.string().min(1).max(200).optional(),
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
