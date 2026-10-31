/**
 * 宿主 provider 快照条目的最小视图。
 *
 * 两处都要从同一份快照里读模型 id（编排状态页、刷新宿主清单）。字段名随宿主
 * 版本变过，所以只认真正用到的几位，其余原样忽略；取模型 id 的规则也只写一遍，
 * 免得一处 trim、一处不 trim，两边数出来的模型数对不上。
 */
export interface ProviderSnapshotEntry {
  provider?: string;
  label?: string;
  status?: string;
  enabled?: boolean;
  error?: string;
  models?: Array<{ id?: string }>;
}

/** 条目里的模型 id：去首尾空白、丢掉空串。 */
export function modelIdsOf(entry: ProviderSnapshotEntry): string[] {
  return (entry.models ?? [])
    .map((model) => (model?.id ?? "").trim())
    .filter((id) => id.length > 0);
}
