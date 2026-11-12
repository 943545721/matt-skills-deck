import { positiveTokenCount } from "./provider-models.ts";

/**
 * Codex 的模型目录（`model_catalog_json`）——把接口报的上下文窗口真正交给会话。
 *
 * 两件事必须分开看：
 * - **窗口是谁定的**：Codex 只认自己的模型目录。目录里查不到的模型名（代理给的
 *   `group/site8083`、`auto/gpt-6-astra` 这类）会退回内置默认值 272000 的 95%，也就是
 *   会话里那行 258k；窗口算大了，自动压缩的阈值跟着放大，真正先到顶的是接口那侧更小的
 *   上限，报出来的却是「ran out of room」。原生模型名在目录里，窗口与阈值才是对的。
 * - **谁能把它送进去**：宿主（Paseo）的 Codex 适配器只保留 id / 标签 / 思考档位
 *   （`buildCodexModelDefinition`），窗口在那一层就丢了；它给 Codex 的 `options` 是 strict
 *   校验的（多一把键就抛错），也塞不进目录。能用的入口是 codex 自己的命令行参数
 *   `-c model_catalog_json="…"`，它接在 provider 条目的「替换启动命令」上。所以插件这边
 *   既要把那份目录文件写出来，也要把这一项参数接进启动命令。
 *
 * 这个文件只放纯函数：合成目录内容、判断有没有可用的窗口。落盘与调 codex 在 server 那侧。
 */

/** 目录文件里认的模型条目：Codex 只要求 `slug`，其余字段按内置目录的形状沿用。 */
export interface CodexCatalogModelInput {
  id: string;
  label?: string;
  description?: string;
  /** 接口报的上下文窗口（`context_window` / `context_length` / `max_input_tokens`）。 */
  contextWindowMaxTokens?: number;
  defaultThinkingOptionId?: string;
  thinkingOptions?: ReadonlyArray<{ id: string; label?: string; description?: string; isDefault?: boolean }>;
}

/** 内置目录里的条目：形状由 Codex 自己的 `models` 清单决定，这里只认 `slug`。 */
type CatalogEntry = Record<string, unknown>;

/**
 * 没有同名内置条目时，借哪条当模板。
 *
 * 借的是**会话框架**（shell 类型、工具开关、基础指令），不是它的窗口——窗口一律按接口改；
 * 优先这条通用的，本机目录里没有的话退回第一条可用的内置条目。
 */
const TEMPLATE_SLUG = "gpt-6-astra";

/** 模板里必须去掉的两把键：`model_messages` 是那条模型专属的提示，`comp_hash` 是它的校验值。 */
const TEMPLATE_DROP_KEYS = ["model_messages", "comp_hash"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 接口报的窗口：只认正的有限数，别把 0、NaN 或字符串当成窗口。 */
export function reportedWindowOf(model: CodexCatalogModelInput): number | undefined {
  const value = model.contextWindowMaxTokens;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/** 这批模型里有没有接口真的报过窗口：一个都没有就别写目录（写了也只是把默认值抄一遍）。 */
export function hasReportedWindows(models: readonly CodexCatalogModelInput[]): boolean {
  return models.some((model) => reportedWindowOf(model) !== undefined);
}

/** 从 `codex debug models --bundled` 的回包（或任意同形回包）里取条目。 */
export function bundledCodexModels(payload: unknown): CatalogEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.models)
      ? (payload.models as unknown[])
      : [];
  const models: CatalogEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const slug = typeof item.slug === "string" ? item.slug.trim() : "";
    if (!slug) continue;
    models.push(cloneJson(item));
  }
  return models;
}

function reasoningLevelsOf(model: CodexCatalogModelInput): { levels: Array<Record<string, unknown>>; defaultLevel?: string } {
  const options = model.thinkingOptions ?? [];
  const levels: Array<Record<string, unknown>> = [];
  for (const option of options) {
    const effort = typeof option.id === "string" ? option.id.trim() : "";
    if (!effort) continue;
    const description = (option.description ?? option.label ?? effort).trim() || effort;
    if (levels.some((level) => level.effort === effort)) continue;
    levels.push({ effort, description });
  }
  const preferred = (model.defaultThinkingOptionId ?? "").trim();
  const flagged = options.find((option) => option.isDefault === true)?.id;
  const defaultLevel =
    levels.find((level) => level.effort === preferred)?.effort ??
    levels.find((level) => level.effort === flagged)?.effort ??
    levels[0]?.effort;
  return { levels, defaultLevel: typeof defaultLevel === "string" ? defaultLevel : undefined };
}

/**
 * 把内置目录与接口报的能力合成一份模型目录。
 *
 * 规则只有三条：
 * - 内置目录原样留下（原生模型名不能因为这份文件而消失）；
 * - 接口报过窗口的模型按 `slug` 落到目录里：同名就改窗口/显示名，没有同名就照模板造一条；
 * - 没报窗口的模型不动——编一个窗口出来只会把「不知道」伪装成「知道」。
 */
export function buildCodexCatalog(
  bundled: unknown,
  injected: readonly CodexCatalogModelInput[],
  options: { templateSlug?: string } = {},
): { models: CatalogEntry[] } | null {
  const base = bundledCodexModels(bundled);
  const withWindows = injected.filter((model) => reportedWindowOf(model) !== undefined);
  if (withWindows.length === 0) return null;
  const template = base.find((entry) => entry.slug === (options.templateSlug ?? TEMPLATE_SLUG)) ?? base[0];
  if (!template) return null;

  const models = base.map((entry) => cloneJson(entry));
  for (const model of withWindows) {
    const window = reportedWindowOf(model);
    if (window === undefined) continue;
    const index = models.findIndex((entry) => entry.slug === model.id);
    const entry: CatalogEntry =
      index >= 0 ? cloneJson(models[index] as CatalogEntry) : makeEntryFromTemplate(template, model);
    entry.context_window = window;
    entry.max_context_window = window;
    if (model.label && model.label.trim() && model.label.trim() !== model.id) entry.display_name = model.label.trim();
    if (model.description && model.description.trim()) entry.description = model.description.trim();
    const { levels, defaultLevel } = reasoningLevelsOf(model);
    if (levels.length > 0) entry.supported_reasoning_levels = levels;
    if (defaultLevel) entry.default_reasoning_level = defaultLevel;
    if (index >= 0) models[index] = entry;
    else models.push(entry);
  }
  return { models };
}

/**
 * 照模板造一条：保留模板的会话框架（shell、工具、基础指令），换掉身份与窗口。
 *
 * 模板里那两把键必须去掉：`model_messages` 是模板模型专属的提示（安到别的模型头上就是错的），
 * `comp_hash` 是它的校验值。`base_instructions` 留着——Codex 要求这两样至少有一份。
 */
function makeEntryFromTemplate(template: CatalogEntry, model: CodexCatalogModelInput): CatalogEntry {
  const entry = cloneJson(template);
  for (const key of TEMPLATE_DROP_KEYS) delete entry[key];
  entry.slug = model.id;
  entry.display_name = (model.label ?? "").trim() || model.id;
  if (model.description && model.description.trim()) entry.description = model.description.trim();
  return entry;
}

/**
 * 配置里的模型条目（手改过的 `config.json` 也是它）→ 目录输入。
 *
 * 入参按 `unknown` 收：配置是用户可以手改的文件，形状不该由调用方用类型断言「保证」；
 * 这里逐字段判定，认不出来的一律丢掉——宁可少写一件能力，也不把一个错的值写进目录。
 */
export function catalogModelInputsOf(items: readonly unknown[]): CodexCatalogModelInput[] {
  const models: CodexCatalogModelInput[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const window = positiveTokenCount(item.contextWindowMaxTokens);
    const thinkingOptions = thinkingOptionsOf(item);
    models.push({
      id,
      ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
      ...(typeof item.description === "string" && item.description.trim() ? { description: item.description.trim() } : {}),
      ...(window === undefined ? {} : { contextWindowMaxTokens: Math.floor(window) }),
      ...(thinkingOptions === undefined ? {} : { thinkingOptions }),
      ...(typeof item.defaultThinkingOptionId === "string" && item.defaultThinkingOptionId.trim()
        ? { defaultThinkingOptionId: item.defaultThinkingOptionId.trim() }
        : {}),
    });
  }
  return models;
}

function thinkingOptionsOf(item: Record<string, unknown>): CodexCatalogModelInput["thinkingOptions"] {
  if (!Array.isArray(item.thinkingOptions)) return undefined;
  const options: Array<{ id: string; label?: string; description?: string; isDefault?: boolean }> = [];
  for (const raw of item.thinkingOptions) {
    const record = typeof raw === "string" ? { id: raw } : isRecord(raw) ? raw : null;
    const id = record && typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    options.push({
      id,
      ...(typeof record?.label === "string" && record.label.trim() ? { label: record.label.trim() } : {}),
      ...(typeof record?.description === "string" && record.description.trim() ? { description: record.description.trim() } : {}),
      ...(record?.isDefault === true ? { isDefault: true } : {}),
    });
  }
  return options.length ? options : undefined;
}
