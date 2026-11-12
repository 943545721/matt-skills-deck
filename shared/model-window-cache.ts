import { positiveTokenCount } from "./provider-models.ts";

/**
 * 接口报过的模型上下文窗口，按工作区留一份。
 *
 * 为什么不能只靠宿主配置：宿主保存 provider 模型时会裁掉 `contextWindowMaxTokens`
 * （实测 `~/.paseo/config.json` 里只剩 id / label / thinkingOptions）。于是窗口只在
 * 「保存那一刻」存在，重启面板就看不到，Codex 目录也只能按裁剪后的清单重建。
 *
 * 这份缓存只存**窗口**：模型 id、接口地址与数值，不存凭据、不存标签。
 * 读的时候按 provider + 当前接口地址匹配——换了接口就不拿旧接口的窗口来套。
 *
 * 这个文件只放纯函数：解析、合并、按地址取窗口。落盘在 server 那侧。
 */

export const MODEL_WINDOW_CACHE_VERSION = 1;
export const MODEL_WINDOW_CACHE_FILE = "model-windows.json";
export const MODEL_WINDOW_CACHE_MAX_PROVIDERS = 100;
export const MODEL_WINDOW_CACHE_MAX_MODELS = 500;
export const MODEL_WINDOW_ID_MAX = 200;
export const MODEL_WINDOW_BASE_URL_MAX = 4096;
export const MODEL_WINDOW_PROVIDER_MAX = 120;

export interface CachedModelWindow {
  id: string;
  contextWindowMaxTokens: number;
}

export interface ProviderModelWindows {
  /** 这份窗口对应哪条接口地址；换了地址就不该继续套用。 */
  baseUrl: string;
  models: CachedModelWindow[];
}

export interface ModelWindowCache {
  version: typeof MODEL_WINDOW_CACHE_VERSION;
  providers: Record<string, ProviderModelWindows>;
}

/** 缓存只关心这两个字段；模型定义、配置条目都能直接传进来。 */
export interface WindowedModel {
  id: string;
  contextWindowMaxTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 地址归一：去掉首尾空白与尾部斜杠（`https://a.test/` 与 `https://a.test` 是同一条）。
 *
 * 同时剥掉 URL 里的 userinfo、查询串与片段：有人会把密钥写在
 * `https://user:pass@gw/v1?key=…` 里，而这份缓存的承诺是「不写凭据」。
 * 缓存只拿它当匹配键，剥掉之后不影响请求本身（请求仍用配置里的原地址）。
 */
export function normalizeModelWindowBaseUrl(raw: string): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text) return "";
  const withoutQuery = text.replace(/[?#].*$/, "");
  // userinfo 可能带 `@`（密码里也允许），所以取第一个 `/` 之前最后一个 `@`。
  const withoutUser = withoutQuery.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/]*@/, "$1");
  return withoutUser.replace(/\/+$/, "");
}

/** 这些键在普通对象上会改到原型：从外部文件读进来时一律丢掉。 */
function isUnsafeProviderKey(provider: string): boolean {
  return provider === "__proto__" || provider === "constructor" || provider === "prototype";
}

export function emptyModelWindowCache(): ModelWindowCache {
  return { version: MODEL_WINDOW_CACHE_VERSION, providers: {} };
}

/** 只留正的有限窗口，取整；同一个 id 只认第一次出现的有效窗口。 */
function modelWindowsOf(raw: readonly unknown[]): CachedModelWindow[] {
  const models: CachedModelWindow[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || id.length > MODEL_WINDOW_ID_MAX || seen.has(id)) continue;
    const window = positiveTokenCount(item.contextWindowMaxTokens);
    if (window === undefined) continue;
    const tokens = Math.floor(window);
    // 不足 1 的值取整后是 0：写进配置等于「窗口是 0」，宁可不记这个模型。
    if (tokens < 1) continue;
    seen.add(id);
    models.push({ id, contextWindowMaxTokens: tokens });
    if (models.length >= MODEL_WINDOW_CACHE_MAX_MODELS) break;
  }
  return models;
}

/**
 * 读盘形状 → 可用的缓存。坏条目一律丢掉：本地文件也可能被手改，
 * 一条畸形记录不该让整个工作区都按错误窗口跑。
 */
export function parseModelWindowCache(raw: unknown): ModelWindowCache {
  if (!isRecord(raw) || raw.version !== MODEL_WINDOW_CACHE_VERSION || !isRecord(raw.providers)) {
    return emptyModelWindowCache();
  }
  const providers: Record<string, ProviderModelWindows> = {};
  let count = 0;
  for (const [rawProvider, entry] of Object.entries(raw.providers)) {
    if (count >= MODEL_WINDOW_CACHE_MAX_PROVIDERS) break;
    const provider = rawProvider.trim();
    if (!provider || provider.length > MODEL_WINDOW_PROVIDER_MAX || isUnsafeProviderKey(provider) || !isRecord(entry)) continue;
    // 先归一、再按上限截断：反过来时，超长地址被截在 userinfo 中间会留下半截凭据。
    const baseUrl = normalizeModelWindowBaseUrl(typeof entry.baseUrl === "string" ? entry.baseUrl : "").slice(
      0,
      MODEL_WINDOW_BASE_URL_MAX,
    );
    if (!baseUrl) continue;
    providers[provider] = {
      baseUrl,
      models: Array.isArray(entry.models) ? modelWindowsOf(entry.models) : [],
    };
    count += 1;
  }
  return { version: MODEL_WINDOW_CACHE_VERSION, providers };
}

export interface ModelWindowCacheParse {
  cache: ModelWindowCache;
  /** 文件读得出 JSON，但形状不是这一版写的（版本不符 / `providers` 不是对象）。 */
  malformed: boolean;
}

/**
 * 带形状判定的解析。
 *
 * [`parseModelWindowCache`] 对不认识的形状一律退回空缓存，这对外是安全的；
 * 但读盘那侧需要分清「文件里本来就没有」和「文件看不懂」——后者要告警。
 */
export function parseModelWindowCacheChecked(raw: unknown): ModelWindowCacheParse {
  const known = isRecord(raw) && raw.version === MODEL_WINDOW_CACHE_VERSION && isRecord(raw.providers);
  return { cache: parseModelWindowCache(raw), malformed: !known };
}

/**
 * 记下一次接口拉取的结果：同一个 provider 整条替换，旧的窗口不会被留下来。
 *
 * 接口这次一个窗口都没报时也写一条空清单——那表示「这条接口现在没有可用窗口」，
 * 而不是「继续沿用上次的」。
 */
export function rememberFetchedModelWindows(
  cache: ModelWindowCache,
  input: { provider: string; baseUrl: string; models: readonly unknown[] },
): ModelWindowCache {
  const provider = input.provider.trim();
  const baseUrl = normalizeModelWindowBaseUrl(input.baseUrl);
  if (!provider || provider.length > MODEL_WINDOW_PROVIDER_MAX || isUnsafeProviderKey(provider) || !baseUrl) return cache;
  return {
    version: MODEL_WINDOW_CACHE_VERSION,
    providers: {
      ...cache.providers,
      [provider]: {
        baseUrl: baseUrl.slice(0, MODEL_WINDOW_BASE_URL_MAX),
        models: modelWindowsOf(input.models),
      },
    },
  };
}

/** 当前接口地址下缓存过的窗口；地址对不上就当没有缓存。 */
export function cachedModelWindowsOf(
  cache: ModelWindowCache,
  provider: string,
  baseUrl: string,
): readonly CachedModelWindow[] {
  const id = provider.trim();
  const base = normalizeModelWindowBaseUrl(baseUrl);
  if (!id || !base || isUnsafeProviderKey(id)) return [];
  const entry = cache.providers[id];
  if (!entry || normalizeModelWindowBaseUrl(entry.baseUrl) !== base) return [];
  return entry.models;
}

/** 按模型 id 索引窗口；调用方用它填配置或快照里缺失的能力字段。 */
export function modelWindowMap(cached: readonly CachedModelWindow[]): ReadonlyMap<string, number> {
  return new Map(cached.map((model) => [model.id, model.contextWindowMaxTokens]));
}

/**
 * 用缓存里的窗口覆盖/补齐这批模型。
 *
 * 缓存是最近一次接口回复，优先级高于宿主保存的定义与旧快照；
 * 缓存里没有的模型原样保留，不编造窗口。
 *
 * `preferExisting` 里的模型跳过缓存：那是本次调用刚从接口带回来的定义，
 * 比缓存新（缓存写入失败时尤其明显），不能让旧缓存把它覆盖回去。
 */
export function withCachedWindows<T extends WindowedModel>(
  models: readonly T[],
  cached: readonly CachedModelWindow[],
  preferExisting?: ReadonlySet<string>,
): T[] {
  if (cached.length === 0) return [...models];
  const windows = modelWindowMap(cached);
  return models.map((model) => {
    if (preferExisting?.has(model.id)) return model;
    const window = windows.get(model.id);
    return window === undefined ? model : ({ ...model, contextWindowMaxTokens: window } as T);
  });
}
