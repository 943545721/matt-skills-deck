import type { PaseoApi } from "@getpaseo/client";
import { record } from "./logs.ts";
import { withProviderConfigWriteLock } from "./provider-config-lock.ts";
import { confirmCleanupSnapshot, prepareProviderCleanup } from "./provider-cleanup-prepare.ts";
import { SCOPE, type CleanupInput, type CleanupResult } from "./provider-cleanup-shared.ts";
import { prepareCleanupTombstones } from "./provider-cleanup-tombstones.ts";
import { verifyCleanupResult } from "./provider-cleanup-verify.ts";
import { applyCleanupPatch, readCleanupResult } from "./provider-cleanup-write.ts";

/**
 * 按用户勾选清理注入源。
 *
 * 宿主对 provider 的补丁是深合并，`env: { KEY: undefined }` 删不掉键；删键时先用
 * `removeProviders` 摘掉条目，再在同一补丁的 `providers` 中写回保留字段。整条删除
 * 只摘掉、不写回；两种操作都在写后读回核对。
 *
 * 地址与凭据键需要 `allowProtected` 确认；非空或字段格式异常的条目也支持整条删除，
 * 需要 `allowNonEmpty` 明确确认会连同模型、command 和其它字段一起移除。
 *
 * 两个并发保护：
 * - 本插件的 provider 写入口共用 `provider-config-lock`，清理 / 卡片保存 / 站点启用排队执行；
 * - patch 前再读一次配置，affected 条目与首次读不一致就以可重试错误失败——落在锁外的
 *   写入（例如直接改 config.json）不会用旧快照把新值盖掉。
 */
export function cleanupProviderSource(paseo: PaseoApi, input: CleanupInput): Promise<CleanupResult> {
  return withProviderConfigWriteLock(() => runCleanup(paseo, input));
}

async function runCleanup(paseo: PaseoApi, input: CleanupInput): Promise<CleanupResult> {
  const prepared = await prepareProviderCleanup(paseo, input);
  if (!prepared.ok) return prepared.result;
  const { plan } = prepared;
  const snapshotFailure = await confirmCleanupSnapshot(paseo, plan);
  if (snapshotFailure) return snapshotFailure;
  const tombstones = prepareCleanupTombstones(plan.removed);
  if (!tombstones.ok) return tombstones.result;
  const patched = await applyCleanupPatch(paseo, plan, tombstones.rollback);
  const after = await readCleanupResult(paseo, patched);
  if (!after.ok) return after.result;
  const verificationFailure = verifyCleanupResult(after.providers, plan);
  if (verificationFailure) return verificationFailure;
  record(
    "info",
    SCOPE,
    `已清理 provider 配置：${plan.removed
      .map((item) => (item.entryRemoved ? `${item.entryId}（整条）` : `${item.entryId} 的 ${item.keys.join("、")}`))
      .join("；")}`,
  );
  return {
    ok: true,
    provider: input.provider,
    removed: plan.removed,
    ...(after.warning ? { warnings: [after.warning] } : {}),
  };
}
