import { record } from "./logs.ts";
import { clearProviderEntryDeleted, deletedProviderEntries, markProviderEntryDeleted } from "./provider-tombstones.ts";
import { SCOPE, type CleanupFailure, type Removed } from "./provider-cleanup-shared.ts";

export type RollbackNewMarks = () => void;

function rollbackNewMarks(ids: readonly string[]): void {
  for (const id of ids) {
    const rollback = clearProviderEntryDeleted(id);
    if (!rollback.ok) record("warn", SCOPE, `回滚本次新增的 ${id} 墓碑失败（${rollback.detail}）`);
  }
}

export function prepareCleanupTombstones(
  removed: readonly Removed[],
): { ok: true; rollback: RollbackNewMarks } | { ok: false; result: CleanupFailure } {
  const tombstones = deletedProviderEntries();
  if (!tombstones.ok) {
    return {
      ok: false,
      result: { ok: false, reason: "config-failed", detail: `读不到 provider 删除记录，未执行清理：${tombstones.detail}` },
    };
  }
  // 只撤销本次新建的记录，保留用户先前留下的删除意图。
  const originallyMarked = new Set(tombstones.ids);
  const newlyMarked: string[] = [];
  for (const item of removed) {
    if (!item.entryRemoved || originallyMarked.has(item.entryId)) continue;
    const marked = markProviderEntryDeleted(item.entryId);
    if (!marked.ok) {
      rollbackNewMarks(newlyMarked);
      return {
        ok: false,
        result: {
          ok: false,
          reason: "config-failed",
          detail: `没能写入 ${item.entryId} 的删除记录，已取消删除：${marked.detail}`,
        },
      };
    }
    newlyMarked.push(item.entryId);
  }
  return { ok: true, rollback: () => rollbackNewMarks(newlyMarked) };
}
