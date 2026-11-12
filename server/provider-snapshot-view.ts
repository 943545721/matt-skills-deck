/**
 * 宿主 provider 快照条目的最小视图。
 *
 * 两处都要从同一份快照里读模型 id（编排状态页、刷新宿主清单）。字段名随宿主
 * 版本变过，所以只认真正用到的几位，其余原样忽略；取模型 id 的规则也只写一遍，
 * 免得一处 trim、一处不 trim，两边数出来的模型数对不上。
 *
 * 推理档位（`thinkingOptions` / `defaultThinkingOptionId`）也走这里：宿主报什么就留什么，
 * 插件不写死任何档位 id。快照是外部输入，形状不对就当「这个模型没有档位」，不抛错、
 * 不挡状态页。
 */
export interface ProviderSnapshotEntry {
  provider?: string;
  label?: string;
  status?: string;
  enabled?: boolean;
  error?: string;
  models?: Array<{
    id?: string;
    contextWindowMaxTokens?: number;
    label?: string;
    thinkingOptions?: unknown;
    defaultThinkingOptionId?: unknown;
  }>;
}

/** 宿主报出的一个推理档位；认不出的字段直接丢掉。 */
export interface ModelThinkingOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

/** 某个模型的档位视图。没有档位的模型不会出现在列表里。 */
export interface ModelThinking {
  id: string;
  thinkingOptions: ModelThinkingOption[];
  defaultThinkingOptionId?: string;
}

/**
 * 条目里的模型清单。
 *
 * `models` 是宿主给的外部数据：不是数组（对象、字符串、null）就当成「没有模型」，
 * 不抛错。原来直接 `entry.models ?? []` 遇到对象会在 `.map` 上炸掉，整页状态读不出来。
 */
function modelsOf(entry: ProviderSnapshotEntry | null | undefined): NonNullable<ProviderSnapshotEntry["models"]> {
  return Array.isArray(entry?.models) ? entry.models : [];
}

/** 条目里的模型 id：去首尾空白、丢掉空串。 */
export function modelIdsOf(entry: ProviderSnapshotEntry | null | undefined): string[] {
  return modelsOf(entry)
    .map((model) => (model?.id ?? "").trim())
    .filter((id) => id.length > 0);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionOf(raw: unknown): ModelThinkingOption | null {
  if (!raw || typeof raw !== "object") return null;
  const option = raw as { id?: unknown; label?: unknown; description?: unknown; isDefault?: unknown };
  const id = textOf(option.id);
  if (!id) return null;
  const label = textOf(option.label) || id;
  const description = textOf(option.description);
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(typeof option.isDefault === "boolean" ? { isDefault: option.isDefault } : {}),
  };
}

/**
 * 条目里每个模型报出的推理档位。
 *
 * 规则：模型得有非空 id；档位只收「对象 + 非空字符串 id」，label 缺失时退回 id，
 * 重复 id 只留第一个。一个可用档位都没有的模型不出现——界面据此判断「不渲染下拉」。
 * 默认档只有真的指向某个已知档位时才保留，免得界面标出一个不存在的默认值。
 */
export function modelThinkingOf(entry: ProviderSnapshotEntry | null | undefined): ModelThinking[] {
  const rows: ModelThinking[] = [];
  for (const model of modelsOf(entry)) {
    const id = textOf(model?.id);
    if (!id) continue;
    const seen = new Set<string>();
    const thinkingOptions: ModelThinkingOption[] = [];
    for (const raw of Array.isArray(model?.thinkingOptions) ? model.thinkingOptions : []) {
      const option = optionOf(raw);
      if (!option || seen.has(option.id)) continue;
      seen.add(option.id);
      thinkingOptions.push(option);
    }
    if (thinkingOptions.length === 0) continue;
    const declared = textOf(model.defaultThinkingOptionId);
    rows.push({
      id,
      thinkingOptions,
      ...(declared && seen.has(declared) ? { defaultThinkingOptionId: declared } : {}),
    });
  }
  return rows;
}
