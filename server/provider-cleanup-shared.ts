import type { PaseoApi } from "@getpaseo/client";
import type { RpcOutput } from "@getpaseo/plugin";
import type { orchestrationProviderCleanupRpc } from "../shared/orchestration-rpc.ts";
import type { ProviderConfigView } from "./provider-entry.ts";

export const SCOPE = "orchestration";

export type Cleanup = {
  entryId: string;
  keys: string[];
  removeEntry?: boolean;
};

export type CleanupInput = {
  provider: string;
  cleanups: Cleanup[];
  allowProtected?: boolean;
  allowNonEmpty?: boolean;
};

export type CleanupResult = RpcOutput<typeof orchestrationProviderCleanupRpc>;
export type CleanupFailure = Extract<CleanupResult, { ok: false }>;
export type Removed = Extract<CleanupResult, { ok: true }>["removed"][number];
export type ProviderPatchValue = NonNullable<Parameters<PaseoApi["config"]["patch"]>[0]["providers"]>[string];

/**
 * 追加模型清单的期望形状。
 *
 * `absent` 表示这把键本来就没有；`items` 是归一化后的对象清单——prepare 阶段
 * 已用 `modelArrayProblem` 拒绝坏数组，所以这里不需要再带一个不可达的坏形状分支。
 */
export type AdditionalModelView = { id: string; label: string; [extra: string]: unknown };
export type AdditionalModelExpectation =
  | { kind: "absent" }
  | { kind: "items"; items: AdditionalModelView[] };

export type Preserved = {
  entryId: string;
  env: Record<string, unknown>;
  fields: Record<string, unknown>;
  modelJson: string;
  additionalModels: AdditionalModelExpectation;
};

export type CleanupPlan = {
  providers: Record<string, ProviderConfigView>;
  removeProviders: string[];
  patches: Record<string, ProviderPatchValue>;
  removed: Removed[];
  preserved: Preserved[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function envOf(entry: ProviderConfigView): Record<string, unknown> {
  return isRecord(entry.env) ? entry.env : {};
}

/** 键排序后的 JSON，用来比较「读回来的还是不是同一份」。 */
export function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 宿主 patch schema 的 `additionalModels` 只收对象数组（`{ id, label }`）；
 * 手改的 config.json 里可能有字符串或缺 label 的对象。写回前补成对象，
 * 空数组保留为空数组（不能归一成 undefined，否则等于删字段）。
 */
export function normalizedAdditionalModels(value: unknown): AdditionalModelView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (typeof item === "string") {
      const id = item.trim();
      return id ? [{ id, label: id }] : [];
    }
    if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
      const id = item.id.trim();
      const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : id;
      return [{ ...item, id, label }];
    }
    return [];
  });
}

/**
 * 写前快照：把原清单归一成对象，并记住每个条目的全部字段。
 *
 * 只比 id + label 会漏掉宿主吞掉 `description` / `isDefault` / `thinkingOptions`
 * 的情况——env 键删掉了，未选中的模型元数据却没了，仍会返回成功。
 */
export function additionalModelsExpectation(value: unknown): AdditionalModelExpectation {
  if (value === undefined) return { kind: "absent" };
  return { kind: "items", items: normalizedAdditionalModels(value) ?? [] };
}

/**
 * 读回核对：原条目有的每个字段都必须原样还在。
 *
 * 宿主自己补的新字段不算丢数据，因此只核对期望条目里出现过的键；而期望里没有、
 * 读回也没有的字段不会被凭空要求。条目数量与顺序仍要求一致。
 */
export function additionalModelsPreserved(
  value: unknown,
  expected: AdditionalModelExpectation,
): boolean {
  if (expected.kind === "absent") return value === undefined;
  const actual = normalizedAdditionalModels(value);
  if (!actual || actual.length !== expected.items.length) return false;
  return expected.items.every((item, index) => {
    const other = actual[index];
    return other !== undefined &&
      Object.entries(item).every(([key, expectedValue]) => stableJson(other[key]) === stableJson(expectedValue));
  });
}
