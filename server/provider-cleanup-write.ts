import type { PaseoApi } from "@getpaseo/client";
import { readProviderConfig } from "./codex-adopt.ts";
import { providersRawOf, type ProviderConfigView } from "./provider-entry.ts";
import { SCOPE, stableJson, type CleanupFailure, type CleanupPlan } from "./provider-cleanup-shared.ts";
import type { RollbackNewMarks } from "./provider-cleanup-tombstones.ts";
import { record } from "./logs.ts";
import { sessionErrorDetail } from "./session.ts";

type ConfigRead = Awaited<ReturnType<typeof readProviderConfig>>;
type ConfigValue = Extract<ConfigRead, { ok: true }>["config"];
type PatchOutcome =
  | { ok: true; recovered: false }
  | { ok: true; recovered: true; config: ConfigValue; warning: string }
  | { ok: false; result: CleanupFailure };

function entriesUnchanged(
  current: Record<string, ProviderConfigView>,
  original: Record<string, ProviderConfigView>,
  entryIds: readonly string[],
): boolean {
  return entryIds.every((entryId) => stableJson(current[entryId]) === stableJson(original[entryId]));
}

async function recoverPatchFailure(
  paseo: PaseoApi,
  plan: CleanupPlan,
  rollback: RollbackNewMarks,
  error: unknown,
): Promise<PatchOutcome> {
  const after = await readProviderConfig(paseo);
  if (!after.ok) {
    record("warn", SCOPE, `provider 清理补丁响应失败且读回不可用；保留删除记录：${after.detail}`);
    return {
      ok: false,
      result: {
        ok: false,
        reason: "verify-failed",
        detail: `写入响应失败且读回不可用；为避免自动重建，删除记录已保留：${after.detail}`,
      },
    };
  }
  const live = providersRawOf(after.config);
  const entryIds = plan.removed.map((item) => item.entryId);
  if (entriesUnchanged(live, plan.providers, entryIds)) {
    rollback();
    return { ok: false, result: { ok: false, reason: "config-failed", detail: sessionErrorDetail(error) } };
  }
  return {
    ok: true,
    recovered: true,
    config: after.config,
    warning: `宿主写入响应失败（${sessionErrorDetail(error)}）；已按读回配置核对清理结果`,
  };
}

export async function applyCleanupPatch(
  paseo: PaseoApi,
  plan: CleanupPlan,
  rollback: RollbackNewMarks,
): Promise<PatchOutcome> {
  try {
    await paseo.config.patch({
      ...(plan.removeProviders.length > 0 ? { removeProviders: plan.removeProviders } : {}),
      ...(Object.keys(plan.patches).length > 0 ? { providers: plan.patches } : {}),
    });
    return { ok: true, recovered: false };
  } catch (error) {
    return recoverPatchFailure(paseo, plan, rollback, error);
  }
}

export async function readCleanupResult(
  paseo: PaseoApi,
  patchOutcome: PatchOutcome,
): Promise<{ ok: true; providers: Record<string, ProviderConfigView>; warning?: string } | { ok: false; result: CleanupFailure }> {
  if (!patchOutcome.ok) return patchOutcome;
  if (patchOutcome.recovered) {
    return {
      ok: true,
      providers: providersRawOf(patchOutcome.config),
      warning: patchOutcome.warning,
    };
  }
  const after = await readProviderConfig(paseo);
  if (!after.ok) {
    return { ok: false, result: { ok: false, reason: "verify-failed", detail: `清完读不到配置核对：${after.detail}` } };
  }
  return { ok: true, providers: providersRawOf(after.config) };
}
