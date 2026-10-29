import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { isAreaKey } from "./workspace-projects.ts";

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

// ---------------------------------------------------------------------------
// area / role 标签：名字怎么拼、颜色怎么定、一次同步该建哪些
// ---------------------------------------------------------------------------

/** 模块标签前缀。与 `.paseo-deck.json` 的 `areas` 一一对应。 */
export const AREA_LABEL_PREFIX = "area:";
/** 项目角色标签前缀。与 `.paseo-deck.json` 的 `owner` 一一对应。 */
export const ROLE_LABEL_PREFIX = "role:";

/**
 * area 键的判据直接来自配置解析器：同一个键在「能写进配置」与「能拼成标签」两处必须是同一条规则，
 * 否则会出现「配置里写了、标签建不出来」这种查半天查不出的毛病。
 */
export { isAreaKey };

export const areaLabelName = (area: string): string => `${AREA_LABEL_PREFIX}${area}`;
export const roleLabelName = (owner: string): string => `${ROLE_LABEL_PREFIX}${owner}`;

/**
 * area / role 标签的固定配色池。
 *
 * 池子是给「新造的标签」用的，不是 area 清单：插件不内置任何模块名，
 * 只保证同一个名字每次拿到同一个颜色。按名字散列取色，新增一个 area 不会改到别的 area 的颜色。
 */
export const GENERATED_LABEL_COLORS = [
  "0e8a16",
  "1d76db",
  "5319e7",
  "b60205",
  "d93f0b",
  "006b75",
  "6f42c1",
  "0b7285",
] as const;

/** 名字 → 颜色。稳定散列，只用 `charCodeAt`，跨进程也一致。 */
export function generatedLabelColor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  const color = GENERATED_LABEL_COLORS[hash % GENERATED_LABEL_COLORS.length];
  return color ?? "cccccc";
}

export interface SyncLabel {
  name: string;
  /** 6 位小写十六进制、不带井号。 */
  color: string;
  description: string;
}

export interface LabelPlan {
  /** 这个仓库该有的全部标签：标准 10 个 + area + role。 */
  labels: SyncLabel[];
  /** 跳过的那部分，逐句说清原因。跳过不是失败。 */
  skipped: string[];
  /** 配置里标为废弃的 area（标签名形态）：不建、不删，只在结果里列出来。 */
  deprecated: string[];
}

export interface LabelPlanInput {
  areas: readonly string[];
  owner: string | null;
  /** 配置里额外标为废弃的 area 键：不建标签，也不动仓库里已有的。 */
  deprecatedAreas?: readonly string[];
}

/**
 * 某个项目一次同步应该建哪些标签。
 *
 * 清单来源是这个项目的配置（项目梳理技能产出、人确认后写入），不是内置表：
 * 没有 areas 就跳过 area 部分并说明，没有 owner 就跳过 role 部分，都不算错。
 */
export function planLabels(input: LabelPlanInput): LabelPlan {
  const skipped: string[] = [];
  const areaLabels: SyncLabel[] = [];
  const deprecatedNames: string[] = [];

  const deprecatedKeys: string[] = [];
  for (const raw of input.deprecatedAreas ?? []) {
    const key = raw.trim();
    if (!isAreaKey(key) || deprecatedKeys.includes(key)) continue;
    deprecatedKeys.push(key);
    deprecatedNames.push(areaLabelName(key));
  }

  const seenAreas: string[] = [];
  for (const raw of input.areas) {
    const area = raw.trim();
    if (!isAreaKey(area)) {
      // 配置解析已经挡过一次；这里再挡一次，是为了让调用方传进来的任何清单都不会变成一次坏请求。
      skipped.push(`area「${area.slice(0, 40)}」不是合法键（小写字母数字连字符），已跳过`);
      continue;
    }
    if (seenAreas.includes(area) || deprecatedKeys.includes(area)) continue;
    seenAreas.push(area);
    const name = areaLabelName(area);
    areaLabels.push({ name, color: generatedLabelColor(name), description: `模块：${area}` });
  }

  if (input.areas.length === 0) {
    skipped.push("配置里没有 areas：area 标签已跳过（项目梳理技能确认后写进 .paseo-deck.json 再同步）");
  }

  const labels: SyncLabel[] = STANDARD_LABELS.map((label) => ({
    name: label.name,
    color: label.color.toLowerCase(),
    description: label.description,
  }));
  labels.push(...areaLabels);

  const owner = (input.owner ?? "").trim();
  if (owner) {
    const name = roleLabelName(owner);
    labels.push({ name, color: generatedLabelColor(name), description: `项目角色：${owner}` });
  } else {
    skipped.push("配置里没有 owner：role 标签已跳过");
  }

  return { labels, skipped, deprecated: deprecatedNames };
}

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

/**
 * 一个仓库的同步结果。
 *
 * 失败分两层：`error` 是整个仓库没做成（认不出远程、没登录、列表读不到），
 * `failed` 是单个标签没建成。分开是因为处置方式不同——前者要人修环境，后者只需重试那一条。
 */
const syncRepoResult = z.object({
  /** 项目键，来自 `.paseo-deck.json` 的 `projects[].key`。 */
  key: z.string(),
  /** 实际写入的 `owner/name`；认不出仓库时为空串。 */
  repo: z.string(),
  host: z.enum(["github", "gitlab"]).nullable(),
  created: z.array(z.string()),
  existing: z.array(z.string()),
  failed: z.array(z.object({ name: z.string(), detail: z.string() })),
  /** 跳过的部分（没有 areas / 没有 owner / 非法键），逐句说明。 */
  skipped: z.array(z.string()),
  /** 配置里标为废弃的 area 标签：没有创建，也没有删除。 */
  deprecated: z.array(z.string()),
  /** 整个仓库没做成时的原因；此时前面几个数组是空或部分结果。 */
  error: z.string().nullable(),
});

export type LabelSyncRepoResult = z.infer<typeof syncRepoResult>;

/**
 * 「同步标签」：按 `.paseo-deck.json` 把每个项目的标准标签 + area/role 一次建齐。
 *
 * 幂等：已经存在的标签跳过，颜色不动；配置里没有 areas 的项目只同步标准标签并说明。
 * 不做仓库范围的猜测——只按项目清单逐个执行，所以它天然是多项目工作区的动作。
 */
export const labelsSyncRpc = defineRpc({
  name: "deck.labels.sync",
  input: z.object({ workspaceDir: workspaceDirSchema }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), repos: z.array(syncRepoResult) }), failure]),
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
