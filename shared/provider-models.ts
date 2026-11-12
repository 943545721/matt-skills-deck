/**
 * 「模型」在宿主里到底是几份东西，以及哪个值该明文显示。
 *
 * 界面上只列**我们这个接口提供的模型**，也就是配置里声明的那些
 * （`additionalModels` / `models`）。客户端自带的模型（claude-opus-*、sonnet、haiku…）
 * 不列：那些是客户端厂商的型号，跟我们接的这条链路没关系，混在一起只会让人
 * 分不清「哪些是我这条 API 能跑的」。
 *
 * 这份清单要能改（加 / 删），所以写回时用**替换**语义；宿主自己也是从这份清单里取模型。
 *
 * 配置里有两把不同的键，语义不同：
 * - `additionalModels`：**追加**到内置列表。内置的那些删不掉，只能加。
 * - `models`：**替换**内置列表。列表里没有的模型，宿主就不认了。
 * 写的时候必须写回这个客户端原本用的那一把，否则要么不生效，要么把内置列表清空。
 *
 * 这个文件只放纯函数：识别、掩码判定、写回目标的挑选、选择集合的增删。
 */

/** 这些前缀说明这个值其实是凭据，不管键名看着多像模型键都不能明文。 */
const CREDENTIAL_PREFIX = /^(sk-|pk-|ghp_|gho_|glpat-|xox[abp]-|AKIA|Bearer\s)/i;

/** 模型 id 的形状：字母数字开头，可含 `. _ : + / - [ ]`，不含空白与引号。 */
const MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:+/[\]-]{0,63}$/;

/** Claude Code 认的模型类环境变量（含分档覆盖与老的快模型别名）。 */
export function isModelEnvKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  if (!upper.startsWith("ANTHROPIC_")) return false;
  return upper.endsWith("_MODEL");
}

/**
 * 这个键值该不该明文显示。
 *
 * 只放行模型 id 与纯数字的上下文窗口：前者限 `ANTHROPIC_*_MODEL`，后者限
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。凭据、URL、其它键一律继续走掩码 + 手动「显示」。
 */
export function isPlainModelValue(key: string, value: string, knownModels: readonly string[]): boolean {
  if (!isModelEnvKey(key)) return false;
  const text = value.trim();
  if (!text || !MODEL_ID_SHAPE.test(text)) return false;
  if (CREDENTIAL_PREFIX.test(text)) return false;
  if (knownModels.includes(text)) return true;
  // 不在列表里但形状对：可能是刚换的代理模型、宿主还没刷新到。这类只在
  // 「键名就是模型键」且长度短、无空白时放行——凭据不长这样。
  return text.length <= 64;
}

/** 一个键值在界面上的样子：`display` 是要印出来的字，`masked` 说它是不是掩码。 */
export interface EnvDisplay {
  display: string;
  masked: boolean;
}

/** 掩码：只留尾巴四位，够认出「是不是同一个」就够；短值全遮，免得尾四位就是全文。 */
export function maskValue(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `••••${text.slice(-4)}`;
}

export const CLAUDE_CODE_MAX_CONTEXT_TOKENS_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";

export function envDisplayOf(key: string, value: string, knownModels: readonly string[]): EnvDisplay {
  const text = typeof value === "string" ? value : "";
  if (!text.trim()) return { display: "", masked: false };
  if (key.trim().toUpperCase() === CLAUDE_CODE_MAX_CONTEXT_TOKENS_KEY && /^\d+$/.test(text.trim())) {
    return { display: text.trim(), masked: false };
  }
  if (isPlainModelValue(key, text, knownModels)) return { display: text.trim(), masked: false };
  return { display: maskValue(text), masked: true };
}

export type ModelListKey = "models" | "additionalModels";

/**
 * 这个客户端的模型配置放在哪把键上。
 *
 * 现存配置里 `models` 优先：它出现就说明这个客户端用的是「替换内置列表」模式，
 * 这时再往 `additionalModels` 写是写到一个不生效的地方（本机 codex 就是这样）。
 * 两把都没有时按追加处理——这是最不容易毁数据的默认。
 */
export function modelListKeyOf(raw: unknown): ModelListKey {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.models) && record.models.length > 0) return "models";
    if (Array.isArray(record.additionalModels) && record.additionalModels.length > 0) return "additionalModels";
  }
  return "additionalModels";
}

/** 从配置里读出「这个客户端自己声明的模型 id」（与内置的区分开）。 */
export function configuredModelIds(raw: unknown, key: ModelListKey): string[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const item of list) {
    const id = typeof item === "string" ? item : (item as { id?: unknown })?.id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids;
}

/** 一份模型清单（就是「我们这个接口提供哪些模型」）里加一个 id（去重、不改入参）。 */
export function addModelId(ids: readonly string[], id: string): string[] {
  const text = id.trim();
  if (!text || ids.includes(text)) return [...ids];
  return [...ids, text];
}

/** 从清单里移除一个 id；不在清单里的原样返回一份新数组。 */
export function removeModelId(ids: readonly string[], id: string): string[] {
  return ids.filter((item) => item !== id);
}

/** 按关键词筛清单，大小写不敏感。返回新数组。 */
export function filterModelIds(ids: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...ids];
  return ids.filter((id) => id.toLowerCase().includes(needle));
}

/* ---------------------------------------------------------------- 从接口拉模型 */

/**
 * 从客户端 env 推出「去哪里问模型清单」与「带什么凭据」。
 *
 * 只认 env 里已经配好的那对：`*_BASE_URL` + `*_API_KEY` / `*_AUTH_TOKEN` / `*_TOKEN`。
 * 不读任何别处的配置，也不落任何东西——这只是把已经存在的那对取出来拼一个请求。
 */
export interface EndpointAuth {
  /** Base URL，已去掉末尾斜杠。 */
  baseUrl: string;
  /** 该发的认证头。同一个值只进 header，不进日志、不回客户端。 */
  headers: Record<string, string>;
  /** 用的是哪个键，报错时能说清「缺什么」。 */
  credentialKey: string;
  baseUrlKey: string;
}

const URL_KEY = /BASE_URL$/i;
const TOKEN_KEY = /(_AUTH_TOKEN|_API_KEY|_TOKEN)$/i;

/** 这个 env 里的接入地址：键名以 `BASE_URL` 结尾且值像 URL。地址不是机密，界面直接印。 */
export function baseUrlOf(env: Record<string, string>): { key: string; value: string } | null {
  for (const [key, value] of Object.entries(env)) {
    if (!URL_KEY.test(key)) continue;
    const text = (value ?? "").trim();
    if (!/^https?:\/\//i.test(text)) continue;
    return { key, value: text.replace(/\/+$/, "") };
  }
  return null;
}

/** 这些键里装的是凭据（只有键名与有没有值对外，值本身永远走掩码）。 */
export function credentialKeysOf(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((key) => TOKEN_KEY.test(key) && (env[key] ?? "").trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * 这个客户端真正在读的接入地址键。
 *
 * 不能只取 env 里第一个 `*_BASE_URL`：Claude 还认 `ANTHROPIC_BEDROCK_BASE_URL` /
 * `ANTHROPIC_VERTEX_BASE_URL`，它们排在前面时 `ANTHROPIC_BASE_URL` 换了也检测不到。
 * 问接口要模型清单、按地址查窗口缓存、判断「换没换接口」必须用**同一个**判断，
 * 否则清单是从 A 地址拉的、窗口却按 B 地址找，缓存永远对不上。
 */
const PROVIDER_BASE_URL_KEYS: Record<string, string> = {
  claude: "ANTHROPIC_BASE_URL",
  codex: "OPENAI_BASE_URL",
};

/** 不认识的客户端返回 undefined，调用方退回「第一个像地址的键」。 */
export function providerBaseUrlKey(provider: string): string | undefined {
  return PROVIDER_BASE_URL_KEYS[provider.trim().toLowerCase()];
}

/**
 * 拿配置里那对（地址 + 凭据）去问接口。
 *
 * `preferredBaseUrlKey` 由 [`providerBaseUrlKey`] 给出：首选键上真有 http(s) 地址就用它，
 * 否则退回第一个像地址的键（用户在派生条目上只写了别的地址键时仍然能取清单）。
 */
export function endpointAuthOf(env: Record<string, string>, preferredBaseUrlKey?: string): EndpointAuth | null {
  const preferred = preferredBaseUrlKey ? (env[preferredBaseUrlKey] ?? "").trim() : "";
  const chosen = /^https?:\/\//i.test(preferred) ? baseUrlOf({ [preferredBaseUrlKey as string]: preferred }) : baseUrlOf(env);
  if (!chosen) return null;
  const baseUrlKey: string = chosen.key;
  const baseUrl = chosen.value;

  let credentialKey: string | null = null;
  let credential = "";
  for (const [key, value] of Object.entries(env)) {
    if (!TOKEN_KEY.test(key)) continue;
    const text = (value ?? "").trim();
    if (!text) continue;
    credentialKey = key;
    credential = text;
    // `ANTHROPIC_API_KEY` 走 `x-api-key`，其它（`*_AUTH_TOKEN` / `*_API_KEY`）走 Bearer。
    break;
  }
  if (!credentialKey) return null;

  const headers: Record<string, string> =
    /^ANTHROPIC_API_KEY$/i.test(credentialKey)
      ? { "x-api-key": credential, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${credential}` };
  return { baseUrl, headers, credentialKey, baseUrlKey };
}

/**
 * 模型清单在哪几个路径上问。Base 已经带 `/v1` 就别再拼一遍
 * （`https://x/v1/v1/models` 是 404 的常见来源）。
 */
export function modelListUrls(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  if (/\/v\d+$/i.test(base)) return [`${base}/models`];
  return [`${base}/v1/models`, `${base}/models`];
}

/**
 * 认常见模型目录回包形状，并保留代理报告的上下文窗口与推理档位。
 * 能力字段名按 OpenAI 兼容代理的常见写法读取；缺失或格式错误的字段直接忽略。
 */
export interface ProviderModelDefinition {
  id: string;
  label: string;
  description?: string;
  contextWindowMaxTokens?: number;
  thinkingOptions?: Array<{ id: string; label: string; description?: string; isDefault?: boolean }>;
  defaultThinkingOptionId?: string;
}

/**
 * Claude Code 的上下文窗口：当前注入模型优先；当前模型没报窗口时取清单里的最小值，
 * 避免任何已配置模型在压缩触发前先撞到接口上限。没有任何窗口就返回 undefined，不写 env。
 */
export function claudeCodeContextWindowOf(
  models: readonly Pick<ProviderModelDefinition, "id" | "contextWindowMaxTokens">[],
  currentModel: string | undefined,
): number | undefined {
  const selected = models.find((model) => model.id === currentModel?.trim());
  const preferred = positiveTokenCount(selected?.contextWindowMaxTokens);
  if (preferred !== undefined) return preferred;
  const windows = models
    .map((model) => positiveTokenCount(model.contextWindowMaxTokens))
    .filter((value): value is number => value !== undefined);
  return windows.length ? Math.min(...windows) : undefined;
}

/** 取第一个正的有限数（各家的能力字段拼写不一样，但含义就这一个）。 */
export function positiveTokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

const MODEL_LABEL_MAX = 200;
const MODEL_DESCRIPTION_MAX = 2000;
const THINKING_OPTION_ID_MAX = 120;
const THINKING_OPTIONS_MAX = 100;

function thinkingOptionsOf(item: Record<string, unknown>) {
  const raw = item.supported_reasoning_levels ?? item.reasoning_levels ?? item.thinkingOptions;
  if (!Array.isArray(raw)) return undefined;
  const options = raw.flatMap((entry) => {
    const value = typeof entry === "string" ? entry : entry && typeof entry === "object"
      ? String((entry as Record<string, unknown>).effort ?? (entry as Record<string, unknown>).id ?? "")
      : "";
    const id = value.trim().slice(0, THINKING_OPTION_ID_MAX);
    return id ? [{ id, label: id }] : [];
  }).slice(0, THINKING_OPTIONS_MAX);
  return options.length ? options : undefined;
}

/** Parse model ids and capability metadata without assuming one vendor's field spelling. */
export function parseModelList(payload: unknown): ProviderModelDefinition[] {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? (record?.data as unknown[])
      : Array.isArray(record?.models)
        ? (record?.models as unknown[])
        : [];
  const models: ProviderModelDefinition[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const id =
      typeof item === "string"
        ? item
        : row?.id ?? row?.name ?? row?.model;
    if (typeof id !== "string") continue;
    const text = id.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const label = typeof row?.display_name === "string" ? row.display_name.trim().slice(0, MODEL_LABEL_MAX) : "";
    const description = typeof row?.description === "string" ? row.description.trim().slice(0, MODEL_DESCRIPTION_MAX) : "";
    const contextWindowMaxTokens = positiveTokenCount(row?.context_window, row?.context_length, row?.max_input_tokens);
    const thinkingOptions = row ? thinkingOptionsOf(row) : undefined;
    models.push({
      id: text,
      label: label || text,
      ...(description ? { description } : {}),
      ...(contextWindowMaxTokens ? { contextWindowMaxTokens } : {}),
      ...(thinkingOptions ? { thinkingOptions } : {}),
    });
  }
  return models;
}
