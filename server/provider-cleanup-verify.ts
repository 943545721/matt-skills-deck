import type { ProviderConfigView } from "./provider-entry.ts";
import {
  additionalModelsPreserved,
  envOf,
  stableJson,
  type CleanupFailure,
  type CleanupPlan,
  type Preserved,
  type Removed,
} from "./provider-cleanup-shared.ts";

function verificationFailure(detail: string): CleanupFailure {
  return { ok: false, reason: "verify-failed", detail };
}

function verifySelectedRemoval(
  providers: Record<string, ProviderConfigView>,
  removed: readonly Removed[],
): CleanupFailure | null {
  for (const item of removed) {
    if (item.entryRemoved) {
      if (providers[item.entryId]) return verificationFailure(`${item.entryId} 仍在配置里`);
      continue;
    }
    const entry = providers[item.entryId];
    if (!entry) return verificationFailure(`清理后 ${item.entryId} 不见了`);
    const env = envOf(entry);
    const still = item.keys.filter((key) => Object.prototype.hasOwnProperty.call(env, key));
    if (still.length > 0) return verificationFailure(`${item.entryId} 的 ${still.join("、")} 还在`);
  }
  return null;
}

function verifyPreservedEntry(entry: ProviderConfigView, snapshot: Preserved): CleanupFailure | null {
  const env = envOf(entry);
  for (const [key, value] of Object.entries(snapshot.env)) {
    if (stableJson(env[key]) !== stableJson(value)) {
      return verificationFailure(`清理后 ${snapshot.entryId} 的 ${key} 变了`);
    }
  }
  const record = entry as Record<string, unknown>;
  for (const [key, value] of Object.entries(snapshot.fields)) {
    if (stableJson(record[key]) !== stableJson(value)) {
      return verificationFailure(`清理后 ${snapshot.entryId} 的字段 ${key} 变了`);
    }
  }
  if (stableJson(entry.models) !== snapshot.modelJson) {
    return verificationFailure(`清理后 ${snapshot.entryId} 的模型清单变了`);
  }
  if (!additionalModelsPreserved(entry.additionalModels, snapshot.additionalModels)) {
    return verificationFailure(`清理后 ${snapshot.entryId} 的追加模型清单变了`);
  }
  return null;
}

export function verifyCleanupResult(
  providers: Record<string, ProviderConfigView>,
  plan: CleanupPlan,
): CleanupFailure | null {
  const removalFailure = verifySelectedRemoval(providers, plan.removed);
  if (removalFailure) return removalFailure;
  // 未选内容必须原样还在；按原顺序核对 env、其它字段、模型和追加模型。
  for (const snapshot of plan.preserved) {
    const entry = providers[snapshot.entryId];
    if (!entry) return verificationFailure(`清理后 ${snapshot.entryId} 不见了`);
    const preservedFailure = verifyPreservedEntry(entry, snapshot);
    if (preservedFailure) return preservedFailure;
  }
  return null;
}
