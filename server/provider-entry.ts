import { CODEX_SITE_PROVIDER } from "../shared/orchestration.ts";

/**
 * daemon 配置里「一个客户端那一格」的视图。
 *
 * 这里只放**读 / 改 provider 条目**这件事：谁是真生效的那条、派生 Codex 条目算不算
 * 可用、旧式注入的地址该怎么找。编排面板、模型目录刷新、取模型、建会话的路由
 * （`server/hooks.ts`）都按这里的同一份判据，避免「界面说停用了、会话还在按站点跑」。
 */
export interface ProviderModelItemView {
  id?: string;
  label?: string;
  isDefault?: boolean;
  description?: string;
  [extra: string]: unknown;
}

export interface ProviderConfigView {
  /** 派生客户端的基座 id（宿主：非内置 id + `extends` 才会被建成 provider）。 */
  extends?: string;
  label?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  /** 追加到内置列表（宿主把两把键都当可写字段）。 */
  additionalModels?: Array<string | ProviderModelItemView>;
  /** 替换内置列表：有这把键就说明这个客户端不用追加模式。 */
  models?: Array<string | ProviderModelItemView>;
}

/** 只看 providers 那一块时需要的形状：宿主的线上视图在根级，磁盘形状在 `agents.providers`。 */
export interface ProviderConfigSource {
  providers?: Record<string, ProviderConfigView>;
  agents?: { providers?: Record<string, ProviderConfigView> };
}

/** 配置里的值可能是任何东西（人手改过 config.json）：取字符串，别的当空。 */
export function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * providers 的两种形状都要认。
 *
 * 宿主的**线上**可改配置摊在根级（`config.get().config.providers`），磁盘上的
 * `~/.paseo/config.json` 却写成 `agents.providers`。只认一种的后果不是报错，
 * 而是界面永远显示「没配过」——用户会去重配一遍。
 */
export function providersRawOf(config: ProviderConfigSource | null): Record<string, ProviderConfigView> {
  const root = config?.providers;
  if (root && typeof root === "object" && !Array.isArray(root)) return root;
  const nested = config?.agents?.providers;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return {};
}

/**
 * 面板上的客户端 id → 宿主里**真正生效**的那条配置。
 *
 * Codex 的站点启用后写在派生 provider `deck-codex` 上：内建 `codex` 的 env 不会被
 * Codex 适配器当成本次会话的 provider 配置（它只认 `extends: "codex"` 的派生条目）。
 * 所以凡是按客户端读 / 改 env 的地方都要先过这一层——直接读 `providers.codex`
 * 会读到一个空条目，界面就会说「启用了但没生效」，获取模型也会必然失败。
 */
export function providerEntryOf(
  providers: Record<string, ProviderConfigView>,
  clientId: string,
): ProviderConfigView | undefined {
  if (clientId !== "codex") return providers[clientId];
  const derived = providers[CODEX_SITE_PROVIDER];
  // 只有「能用」的派生条目才顶替内建条目：停用或缺地址时它等于没生效，
  // 界面这时要显示宿主原生那份配置，否则会一边说「已停用」一边又有会话在跑。
  return codexSiteUsable(derived) ? derived : providers[clientId];
}

/**
 * 派生 Codex 条目能不能真正顶替内建条目：继承 codex、没被停用、地址非空。
 *
 * 三个条件缺一个都等于「站点没生效」——建会话的路由（`server/hooks.ts`）与
 * 面板的读路径必须用同一条判据，否则会出现「界面说停用了、会话还在按站点跑」这类分裂。
 */
export function codexSiteUsable(entry: ProviderConfigView | undefined): boolean {
  return (
    Boolean(entry) &&
    entry?.extends === "codex" &&
    entry.enabled !== false &&
    textOf(entry?.env?.[CODEX_ADDRESS_KEY]) !== ""
  );
}

/**
 * 面板上的客户端 id 写进哪一条：Codex 一律写派生条目。
 *
 * **无条件**改道，不判断派生条目在不在：写在内建 `codex` 上的地址与凭证宿主根本不读
 * （它只认 `extends: "codex"` 的派生条目），那样写等于「配了但不生效」。
 * 派生条目还不存在时，调用方要顺手把 `extends` / `label` 补上，否则建不成。
 */
export function providerWriteTargetOf(clientId: string): string {
  return clientId === "codex" ? CODEX_SITE_PROVIDER : clientId;
}

/**
 * 旧式 Codex 注入留下的那条地址：写在内建 `codex` 的 env 上、宿主**根本不读**。
 *
 * 存在就返回它（归一掉尾部斜杠），否则 null。这是「配了却不生效」的历史现场：
 * 地址在客户端卡片上看着是配好的，Codex 会话却走 `~/.codex/config.toml`。
 * 有它就说明该把地址搬到派生条目去（`server/codex-adopt.ts`），而不是留给用户
 * 自己发现、自己再点一遍。
 *
 * 派生条目已经在（停用 / 没地址）时返回 null：那是用户明确留下的状态，不往里塞东西。
 */
export function legacyCodexAddressOf(providers: Record<string, ProviderConfigView>): string | null {
  if (providers[CODEX_SITE_PROVIDER]) return null;
  const stale = textOf(providers.codex?.env?.[CODEX_ADDRESS_KEY]);
  return stale ? stale.replace(/\/+$/, "") : null;
}

/** 接入地址键名：Codex 适配器写死读这一个（别的名字写进去没人看）。 */
export const CODEX_ADDRESS_KEY = "OPENAI_BASE_URL";
/** 凭据键名：适配器只读这一个，自定义键名（`SUB2API_API_KEY` 之类）它不读。 */
export const CODEX_CREDENTIAL_KEY = "OPENAI_API_KEY";
/**
 * Codex 会话真正读得到的两个 env 键——宿主适配器写死的。
 *
 * 派生条目里其余 env 键没人读：写进去只会让客户端卡片上多出几行看不懂的东西
 * （用户原话：「为什么我们插件要有这个东西」）。所以插件自己造条目时只写这两个。
 */
export const CODEX_EFFECTIVE_ENV_KEYS = [CODEX_ADDRESS_KEY, CODEX_CREDENTIAL_KEY] as const;

/** 键名像不像一把凭据（`*_API_KEY` / `*_AUTH_TOKEN` / `*_TOKEN`）。只看名字，不看值。 */
export function isCredentialKey(key: string): boolean {
  return /(_API_KEY|_AUTH_TOKEN|_TOKEN)$/i.test(key);
}

/**
 * 派生条目 env 里「纯属重复」的键：键名像凭据、值又和 `OPENAI_API_KEY` 一模一样。
 *
 * 这种键是插件早先整份照抄旧配置留下的残渣（同一把钥匙写了两个名字），删掉不丢任何信息。
 * **只认值完全相同的**：值不一样就可能是另一套凭证，一个字都不动。
 */
export function redundantCredentialKeysOf(env: Record<string, unknown> | undefined): string[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  const effective = textOf(env[CODEX_CREDENTIAL_KEY]);
  if (!effective) return [];
  return Object.keys(env).filter(
    (key) =>
      !(CODEX_EFFECTIVE_ENV_KEYS as readonly string[]).includes(key) && isCredentialKey(key) && textOf(env[key]) === effective,
  );
}

/**
 * 从旧配置的 env 里摸出一把能用的凭证（Codex 站点首次启用 / 接管旧式地址时用）。
 *
 * 顺序固定：`OPENAI_API_KEY` → 其它 `*_API_KEY` → `*_AUTH_TOKEN` / `*_TOKEN`。
 * 键名只用来挑值，值永远不回给界面。
 */
export function legacyCredentialOf(env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {}).filter(([, value]) => textOf(value) !== "");
  const direct = entries.find(([key]) => key === CODEX_CREDENTIAL_KEY);
  if (direct) return textOf(direct[1]);
  const apiKey = entries.find(([key]) => /_API_KEY$/i.test(key));
  if (apiKey) return textOf(apiKey[1]);
  const token = entries.find(([key]) => /(_AUTH_TOKEN|_TOKEN)$/i.test(key));
  return token ? textOf(token[1]) : "";
}

/**
 * 配置里的模型清单 → 写入时要的形状（`{ id, label }`，宿主自己的字段原样带着）。
 *
 * 空清单返回 `undefined` 而不是 `[]`：`models` 是替换语义，写空等于「一个模型都不剩」，
 * 调用方据此决定这把键写不写。启用站点与接管旧式地址（`server/codex-adopt.ts`）
 * 都要搬这份清单，所以放在一处。
 */
export function modelObjectsOf(
  items: Array<string | ProviderModelItemView> | undefined,
): Array<ProviderModelItemView & { id: string; label: string }> | undefined {
  // 人手改过的 config.json 里这把键可能是任何东西：不是数组就当没有，别让 `.flatMap` 抛 TypeError
  // 把整条读路径（客户端页、建会话）带崩。
  const list = Array.isArray(items) ? items : [];
  const kept = list.flatMap((item): Array<ProviderModelItemView & { id: string; label: string }> => {
    // 逐项也要挡：`[null]`、`[42]` 同样是手改出来的形状，读 `.id` 会直接 TypeError。
    if (typeof item === "string") {
      const id = item.trim();
      return id ? [{ id, label: id }] : [];
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return [];
    const label = (typeof item.label === "string" ? item.label.trim() : "") || id;
    return [{ ...item, id, label }];
  });
  return kept.length ? kept : undefined;
}

/**
 * 把 `wanted` 里缺的模型补到 `existing` 后面，**已有的一条不删**。
 *
 * 用途：内建 `codex` 的清单要和真正生效的派生条目对齐（宿主的模型选择器按条目各显示一份，
 * 只写一份就会出现「这个窗口看得到、换个项目的新窗口就没了」）。但对齐**不能删**东西——
 * 用户可能在 Paseo 自己的设置里给内建那一行加过模型，插件悄悄删掉就是替人做决定。
 * 保存模型清单是用户显式的改动（那条路径是整份替换），读状态自愈只补不删。
 */
export function withMissingModels(
  existing: Array<string | ProviderModelItemView> | undefined,
  wanted: ReadonlyArray<ProviderModelItemView & { id: string; label: string }>,
): Array<ProviderModelItemView & { id: string; label: string }> {
  const items = modelObjectsOf(existing) ?? [];
  const ids = new Set(items.map((item) => item.id));
  return [...items, ...wanted.filter((item) => !ids.has(item.id))];
}

/**
 * 用户显式保存模型清单时，内建条目那份该写成什么：`wanted` 为准，但**不删**内建条目独有的模型。
 *
 * 三个参数各管一件事：
 * - `existing`：内建条目现在那份（`codex.models` / `codex.additionalModels`）；
 * - `wanted`：用户这次在面板里勾的（面板读的是派生条目，`models` 是替换语义——取消勾选就得删）；
 * - `previous`：派生条目**改之前**那份。它上面的模型是插件自己照写过去的，用户取消勾选，
 *   内建那一行也该跟着消失；而内建条目上既不在 `wanted`、又不在 `previous` 里的模型，是用户
 *   自己在 Paseo 设置里加的，面板上根本看不见——整份替换把它删掉是替人做决定。
 */
export function mirroredModelsOf(
  existing: Array<string | ProviderModelItemView> | undefined,
  wanted: ReadonlyArray<ProviderModelItemView & { id: string; label: string }>,
  previous: Array<string | ProviderModelItemView> | undefined,
): Array<ProviderModelItemView & { id: string; label: string }> {
  const wantedIds = new Set(wanted.map((item) => item.id));
  const previousIds = new Set((modelObjectsOf(previous) ?? []).map((item) => item.id));
  const seen = new Set<string>();
  const kept: Array<ProviderModelItemView & { id: string; label: string }> = [];
  for (const item of modelObjectsOf(existing) ?? []) {
    // 手改过的 config.json 里可能有同一个模型写两遍：顺手收成一个，不然选择器里两行同名，
    // 而且每次保存都只能重复报一句「去 config.json 删」。
    if (seen.has(item.id)) continue;
    if (!wantedIds.has(item.id) && previousIds.has(item.id)) continue;
    seen.add(item.id);
    kept.push(item);
  }
  // `isDefault` 跟着内建条目自己的来：照搬派生条目的默认会造出两个默认模型，选择器行为就飘了。
  let defaultTaken = kept.some((item) => item.isDefault === true);
  const added: Array<ProviderModelItemView & { id: string; label: string }> = [];
  for (const item of wanted) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const { isDefault, ...rest } = item;
    if (isDefault === true && !defaultTaken) {
      defaultTaken = true;
      added.push({ ...rest, isDefault: true });
    } else {
      added.push(rest);
    }
  }
  return [...kept, ...added];
}
