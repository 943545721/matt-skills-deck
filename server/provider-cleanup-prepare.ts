import type { PaseoApi } from "@getpaseo/client";
import { isSupportedClient, SUPPORTED_CLIENTS_LABEL } from "../shared/orchestration.ts";
import { isProtectedEnvKey } from "../shared/provider-env.ts";
import { modelArrayProblem } from "../shared/provider-models.ts";
import { readProviderConfig } from "./codex-adopt.ts";
import {
  additionalModelsExpectation,
  envOf,
  isRecord,
  normalizedAdditionalModels,
  stableJson,
  type Cleanup,
  type CleanupFailure,
  type CleanupInput,
  type CleanupPlan,
  type Preserved,
  type ProviderPatchValue,
  type Removed,
} from "./provider-cleanup-shared.ts";
import { isRemovableProviderEntry, providersRawOf, type ProviderConfigView } from "./provider-entry.ts";

type PreparedEntry = {
  ok: true;
  removed: Removed;
  protectedKeys: string[];
  preserved?: Preserved;
  patch?: ProviderPatchValue;
};
type PreparationFailure = { ok: false; result: CleanupFailure };
type PreparedPlan = { ok: true; plan: CleanupPlan } | PreparationFailure;

function invalid(detail: string): PreparationFailure {
  return { ok: false, result: { ok: false, reason: "invalid", detail } };
}

function prepareEntry(
  provider: string,
  cleanup: Cleanup,
  input: CleanupInput,
  raw: unknown,
): PreparedEntry | PreparationFailure {
  if (!isRecord(raw)) {
    return { ok: false, result: { ok: false, reason: "not-found", detail: `配置里没有 ${cleanup.entryId}` } };
  }
  const entry = raw as ProviderConfigView;
  // 只能清当前客户端自己的条目：内建 id 或 `extends: <client>` 的派生条目。
  if (cleanup.entryId !== provider && entry.extends !== provider) {
    return invalid(`${cleanup.entryId} 不属于 ${provider}`);
  }
  if (cleanup.removeEntry) return prepareEntryRemoval(cleanup, entry, input);
  return prepareKeyRemoval(cleanup, entry);
}

function prepareEntryRemoval(
  cleanup: Cleanup,
  entry: ProviderConfigView,
  input: CleanupInput,
): PreparedEntry | PreparationFailure {
  // 整条删除不写回原字段；明确确认后，旧模型或 env 的坏形状也不该挡住移除。
  if (cleanup.keys.length > 0) {
    return invalid(`${cleanup.entryId} 不能同时整条删除和删键`);
  }
  if (!isRemovableProviderEntry(entry) && input.allowNonEmpty !== true) {
    return invalid(`${cleanup.entryId} 还有模型 / 其它字段；整条删除需要明确确认`);
  }
  return {
    ok: true,
    removed: { entryId: cleanup.entryId, keys: [], entryRemoved: true },
    protectedKeys: [],
  };
}

function modelProblem(entry: ProviderConfigView, key: "models" | "additionalModels"): string | null {
  if (!Object.prototype.hasOwnProperty.call(entry, key)) return null;
  const problem = modelArrayProblem(entry[key]);
  return problem ? `${key} 有坏条目：${problem}，先手动修 config.json` : null;
}

function prepareKeyRemoval(cleanup: Cleanup, entry: ProviderConfigView): PreparedEntry | PreparationFailure {
  // 删键要重写保留字段：无法安全保留坏模型时停止写入。
  for (const key of ["models", "additionalModels"] as const) {
    const problem = modelProblem(entry, key);
    if (problem) return invalid(`${cleanup.entryId} 的 ${problem}`);
  }
  const env = envOf(entry);
  const keys = [...new Set(cleanup.keys)];
  if (keys.length === 0) return invalid(`${cleanup.entryId} 没有选中的键`);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(env, key));
  if (missing.length) return invalid(`${cleanup.entryId} 里没有这些键：${missing.join("、")}`);
  // env 里手改出的非字符串原样保留；这里只负责删选中的键。
  const nextEnv = { ...env } as Record<string, string>;
  for (const key of keys) delete nextEnv[key];
  const fields = Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== "env" && key !== "models" && key !== "additionalModels"),
  );
  const preservedModels = Array.isArray(entry.models) ? entry.models : undefined;
  const preservedAdditionalModels = normalizedAdditionalModels(entry.additionalModels);
  const preserved: Preserved = {
    entryId: cleanup.entryId,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key))),
    fields,
    modelJson: stableJson(preservedModels),
    additionalModels: additionalModelsExpectation(entry.additionalModels),
  };
  // 同一个补丁里「摘掉 + 写回」，不会留下中间空窗；models 保持原样。
  const patch = {
    ...fields,
    env: nextEnv,
    ...(preservedModels !== undefined ? { models: preservedModels } : {}),
    ...(preservedAdditionalModels !== undefined ? { additionalModels: preservedAdditionalModels } : {}),
  } as ProviderPatchValue;
  return {
    ok: true,
    removed: { entryId: cleanup.entryId, keys, entryRemoved: false },
    preserved,
    patch,
    protectedKeys: keys.filter(isProtectedEnvKey),
  };
}

function buildCleanupPlan(
  provider: string,
  input: CleanupInput,
  providers: Record<string, ProviderConfigView>,
): PreparedPlan {
  const seen = new Set<string>();
  const removeProviders: string[] = [];
  const patches: Record<string, ProviderPatchValue> = {};
  const removed: Removed[] = [];
  const preserved: Preserved[] = [];
  const protectedKeys: string[] = [];
  for (const cleanup of input.cleanups) {
    if (seen.has(cleanup.entryId)) return invalid(`${cleanup.entryId} 重复出现`);
    seen.add(cleanup.entryId);
    const prepared = prepareEntry(provider, cleanup, input, providers[cleanup.entryId]);
    if (!prepared.ok) return prepared;
    removeProviders.push(cleanup.entryId);
    removed.push(prepared.removed);
    if (prepared.preserved) preserved.push(prepared.preserved);
    if (prepared.patch) patches[cleanup.entryId] = prepared.patch;
    protectedKeys.push(...prepared.protectedKeys);
  }
  if (protectedKeys.length > 0 && input.allowProtected !== true) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "protected",
        detail: `选中包含地址或凭据键：${[...new Set(protectedKeys)].join("、")}；确认后带 allowProtected 再试`,
      },
    };
  }
  return { ok: true, plan: { providers, removeProviders, patches, removed, preserved } };
}

export async function prepareProviderCleanup(paseo: PaseoApi, input: CleanupInput): Promise<PreparedPlan> {
  const provider = input.provider.trim().toLowerCase();
  // 与卡片保存同一条写入口：直接调 RPC 也只能清 Claude / Codex。
  if (!isSupportedClient(provider)) {
    return invalid(`插件只支持 ${SUPPORTED_CLIENTS_LABEL} 的注入配置：${input.provider}`);
  }
  const read = await readProviderConfig(paseo);
  if (!read.ok) {
    return { ok: false, result: { ok: false, reason: "config-failed", detail: `读不到 daemon 配置：${read.detail}` } };
  }
  return buildCleanupPlan(provider, input, providersRawOf(read.config));
}

export async function confirmCleanupSnapshot(paseo: PaseoApi, plan: CleanupPlan): Promise<CleanupFailure | null> {
  // patch 前再读一次，不用旧快照把锁外写入的新值盖回去。
  const beforePatch = await readProviderConfig(paseo);
  if (!beforePatch.ok) {
    return { ok: false, reason: "config-failed", detail: `清理前读不到配置核对：${beforePatch.detail}` };
  }
  const currentProviders = providersRawOf(beforePatch.config);
  for (const entryId of plan.removeProviders) {
    if (stableJson(currentProviders[entryId]) !== stableJson(plan.providers[entryId])) {
      return { ok: false, reason: "config-failed", detail: `配置在清理期间被改动（${entryId}），请重试` };
    }
  }
  return null;
}
