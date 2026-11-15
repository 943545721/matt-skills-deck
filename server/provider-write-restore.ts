import { isDeepStrictEqual } from "node:util";
import { CODEX_SITE_PROVIDER } from "../shared/orchestration.ts";
import { record } from "./logs.ts";
import { providersRawOf, type ProviderConfigSource, type ProviderConfigView } from "./provider-entry.ts";
import { clearProviderEntryDeleted } from "./provider-tombstones.ts";

/** 宿主 ProviderProfileModelSchema 支持的字段；窗口由插件缓存与 Codex 目录保留。 */
const MODEL_FIELDS = ["id", "label", "description", "isDefault", "thinkingOptions"] as const;
const CODEX_ENTRIES = ["codex", CODEX_SITE_PROVIDER] as const;
type ProviderWrites = Record<string, Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hostModel(value: unknown): Record<string, unknown> | null {
  const item = typeof value === "string" ? { id: value, label: value } : value;
  if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return null;
  return Object.fromEntries(MODEL_FIELDS.flatMap((field) => {
    const entry = field === "label" ? item.label ?? item.id : item[field];
    return entry === undefined ? [] : [[field, entry]];
  }));
}

/** 模型顺序可变，ID、重复项及宿主支持的能力字段必须一致。 */
function sameModels(expected: unknown, actual: unknown): boolean {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return isDeepStrictEqual(expected, actual);
  if (expected.length !== actual.length) return false;
  const wanted = expected.map(hostModel);
  const live = actual.map(hostModel);
  if (wanted.some((item) => !item) || live.some((item) => !item)) return false;
  const liveById = new Map(live.map((item) => [item!.id, item]));
  if (liveById.size !== live.length || new Set(wanted.map((item) => item!.id)).size !== wanted.length) return false;
  return wanted.every((item) => isDeepStrictEqual(item, liveById.get(item!.id)));
}

function fieldMatches(field: string, expected: unknown, actual: unknown): boolean {
  if (field === "models" || field === "additionalModels") return sameModels(expected, actual);
  if (field === "env" && isRecord(expected)) {
    return isRecord(actual) && Object.entries(expected).every(([key, value]) => actual[key] === value);
  }
  return isDeepStrictEqual(expected, actual);
}

/** 连同原有字段核对：保存显示名也不能接受宿主同时丢掉地址、模型或 command。 */
function writeProblems(
  before: Record<string, ProviderConfigView>,
  writes: ProviderWrites,
  after: ProviderConfigSource | null,
): string[] {
  if (!after) return ["读回配置不可用"];
  const live = providersRawOf(after);
  return Object.entries(writes).flatMap(([id, patch]) => {
    const expected = { ...before[id], ...patch };
    const entry = live[id];
    if (!isRecord(entry)) return [id];
    return Object.entries(expected).flatMap(([field, value]) => (
      value === undefined || fieldMatches(field, value, entry[field]) ? [] : [`${id}.${field}`]
    ));
  });
}

/** 只在本次写入与必要保留内容均已读回确认后，恢复 Codex 自动维护。调用方持有配置写锁。 */
export function restoreCodexMaintenanceAfterWrite(
  provider: string,
  before: Record<string, ProviderConfigView>,
  writes: ProviderWrites,
  after: ProviderConfigSource | null,
): string[] {
  if (provider !== "codex") return [];
  const problems = writeProblems(before, writes, after);
  if (problems.length || !Object.keys(writes).length) {
    return [`codex、${CODEX_SITE_PROVIDER} 已有删除记录仍保留；本次写入尚未核验通过（${problems.join("、") || "没有写入字段"}），自动维护未恢复`];
  }
  return CODEX_ENTRIES.flatMap((id) => {
    const result = clearProviderEntryDeleted(id);
    if (result.ok) return [];
    const warning = `清除 ${id} 的删除记录失败；自动同步仍可能跳过该条目：${result.detail}`;
    record("warn", "orchestration", warning);
    return [warning];
  });
}
