import { canonicalToolName } from "../../../shared/tool-contract.ts";
import { SUGGEST_TOOL_NAME, normalizeSuggestions } from "../../../shared/suggestions.ts";
import type { SuggestedStep } from "../../../shared/suggestions.ts";

/**
 * 时间线纯转换。
 *
 * Paseo 的 transformer 在构建渲染模型时同步运行，历史与每条实时更新都会走一遍；
 * 所以这里不能碰网络、不能读时间、不能抛异常——同一个输入必须给出同一个输出。
 *
 * 两件事：
 * 1. `suggest_next_steps` 的 tool_call 换成建议气泡，原始工具行不再占位；
 * 2. `deck_issue_report` 成功上报换成工作路线卡，失败/未完成保留原样（错误要说给用户看）。
 *
 * 工具名可能被 provider 加上 `mcp__server__` 之类前缀，所以先取最后一段再走别名归一。
 */

export const DECK_TIMELINE_VERSION = 1;
export const DECK_SUGGEST_KIND = "deck-suggestions";
export const DECK_WORK_ROUTE_KIND = "deck-work-route";
export const DECK_COMMAND_KIND = "deck-command";

export interface TimelinePluginRow {
  type: "plugin";
  id?: string;
  kind: string;
  version: number;
  data: Record<string, unknown>;
}

export interface TimelineTransformResult {
  items: TimelinePluginRow[];
}

/** 只声明转换需要的字段：宿主传进来的 ToolCallTimelineItem 结构上兼容。 */
export interface ToolCallLike {
  type: "tool_call";
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  callId?: string;
  detail: {
    type: string;
    input?: unknown;
    output?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SuggestData {
  items: SuggestedStep[];
  toolName: string;
}

export interface WorkRouteData {
  key: string;
  action: "report" | "release";
  note?: string;
  title?: string;
  repoKey?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * provider 前缀剥掉后归一别名。
 *
 * MCP 工具的显示名常见 `mcp__deck__suggest_next_steps`；也见过用点号连接的宿主。
 * 两种都取最后一段，再交给 `canonicalToolName`（它只认旧名别名）。
 */
export function baseToolName(name: string): string {
  const tail = name.split("__").pop() ?? name;
  const dotted = tail.split(".").pop() ?? tail;
  return canonicalToolName(dotted.trim());
}

/** 工具参数有时被 provider 序列化成字符串；只在确实是 JSON 对象时解析。 */
function asInput(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 工具的文本结果通常是 JSON；只有能解析成对象时才继续判断，纯文本不能猜成功。 */
function asOutput(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function successOutput(value: unknown): Record<string, unknown> | null {
  const output = asOutput(value);
  return output && output.ok === true ? output : null;
}

function parseSuggest(item: ToolCallLike): TimelineTransformResult | undefined {
  if (baseToolName(item.name) !== SUGGEST_TOOL_NAME) return undefined;
  if (item.detail.type !== "unknown") return undefined;
  const input = asInput(item.detail.input);
  if (!input) return undefined;
  const normalized = normalizeSuggestions(input);
  if (!normalized.ok) return undefined;
  const data: SuggestData = { items: normalized.items, toolName: SUGGEST_TOOL_NAME };
  return {
    items: [{ type: "plugin", kind: DECK_SUGGEST_KIND, version: DECK_TIMELINE_VERSION, data: { ...data } }],
  };
}

function parseWorkRoute(item: ToolCallLike): TimelineTransformResult | undefined {
  if (baseToolName(item.name) !== "deck_issue_report") return undefined;
  if (item.detail.type !== "unknown") return undefined;
  const input = asInput(item.detail.input);
  if (!input) return undefined;
  const key = typeof input.key === "number" ? String(input.key) : typeof input.key === "string" ? input.key.trim().replace(/^#/, "") : "";
  if (!key) return undefined;
  const output = successOutput(item.detail.output);
  if (!output) return undefined;

  const data: WorkRouteData = {
    key,
    action: input.release === true ? "release" : "report",
    ...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim() } : {}),
    ...(typeof input.repo === "string" && input.repo.trim() ? { repoKey: input.repo.trim() } : {}),
    ...(typeof output.title === "string" && output.title.trim() ? { title: output.title.trim() } : {}),
  };
  return {
    items: [{ type: "plugin", kind: DECK_WORK_ROUTE_KIND, version: DECK_TIMELINE_VERSION, data: { ...data } }],
  };
}

/**
 * 一个 tool_call → 零/一个插件行。
 *
 * 返回 `undefined` 保留原始工具行：
 * - 正在运行、失败、取消：让用户看到真实状态，不提前显示半份结果；
 * - 不是这两个工具；
 * - 参数校验失败：建议工具本身会回错误文本，原始行就是证据。
 */
export function transformToolCall(item: ToolCallLike, phase: "streaming" | "complete"): TimelineTransformResult | undefined {
  if (phase !== "complete" || item.status !== "completed") return undefined;
  return parseSuggest(item) ?? parseWorkRoute(item);
}
