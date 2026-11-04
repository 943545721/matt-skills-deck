/**
 * 把提示词填进 Paseo 聊天窗口的输入框，而不是直接发一条消息。
 *
 * 公开 SDK（@getpaseo/plugin 0.13）没有 composer / draft API，宿主只在
 * 自己的 Web bundle 里导出草稿 store。插件 bundle 通过 `globalThis.eval`
 * 在同一个 JS 世界里执行，所以可以按模块 id 取到那个 store：
 * - 写入 Zustand 草稿 store，key 为 `agent:<serverId>:<agentId>`；
 *   已挂载的输入框会立即订阅到文本，未挂载的等打开会话时再水合。
 * - 草稿写入后读回文本；读不回就返回失败，不把「没填进去」说成成功。
 *
 * 不做 DOM 兜底：0.13.2 的 composer 没有稳定的目标标识，按「最后一个可见
 * textarea」猜会把提示词填进别的会话。草稿 store 失败时由界面复制，
 * 让用户自己粘贴到正确的窗口。
 *
 * 这条边界不是公开协议，模块 id 随宿主构建而变（实测 0.13.2 是 3598、0.14.0 是 3601，
 * 桌面 App 自带的前端包还可能与 daemon 的不同）。所以按下面的顺序找：
 * 上次记住的编号 → 已知编号 → Metro 模块注册表里已初始化的导出 →
 * （仅在用户点了「自动查找」时）逐个编号试探。全找不到才返回 `no-store`，
 * 由界面翻译成一句话并给出复制兜底。
 */

/**
 * 已知的 `useDraftStore` 模块编号，按宿主版本排（实测：0.13.2 → 3598，0.14.0 → 3601）。
 *
 * 它们只是**第一候选**，不是唯一答案：编号随宿主构建变化（桌面 App 自带的前端包
 * 与 daemon 提供的 web 包也可能不同），硬编码就等于把「填输入框」押在某次构建上。
 * 查不到时按下面的顺序继续找，找不到再报错。
 */
const KNOWN_DRAFT_STORE_MODULE_IDS: readonly number[] = [3598, 3601];

/** 找到的编号记在这里：宿主没变时下次直接用，不再试探。 */
const REMEMBERED_ID_KEY = "matt-skills-deck:draftStoreModuleId";

/**
 * 逐个 require 试探的范围与节奏。
 *
 * 上限要够到真实编号：宿主 Web 包有 5600 多个模块，草稿 store 在 3598
 * （0.13.2 的 `web-ui/_expo/static/js/web/index-*.js` 实测），上限必须高于它。
 *
 * 试探会执行模块顶层代码，所以分片让出主线程，并留一个总时间预算：
 * 到点还没命中就如实报失败，不把界面卡死。
 */
const MAX_SCAN_ID = 20_000;
const SCAN_CHUNK = 250;
const SCAN_BUDGET_MS = 8_000;

interface DraftRecord {
  lifecycle?: string;
  input?: { text?: string; attachments?: readonly unknown[] };
}

interface DraftStoreState {
  drafts?: Record<string, DraftRecord | undefined>;
  editDraftText?: (input: { draftKey: string; text: string }) => void;
  saveDraftInput?: (input: {
    draftKey: string;
    draft: { text: string; attachments: readonly unknown[] };
  }) => void;
}

export interface DraftStore {
  getState(): DraftStoreState;
}

/**
 * `no-store` 时的结构化诊断。
 *
 * 这里只给数据，由界面按当前语言拼成句子——英文句子不能直接塞进中文横幅。
 * `loaderErrors` 是宿主自己报的错，原样引用；界面只负责把它套进词表。
 */
export interface StoreDiagnostics {
  /** 试过的那几个固定编号。 */
  knownIds: readonly number[];
  /** 宿主有没有暴露 `getModules`（只判存在，不判调用成败；生产包通常没有）。 */
  registry: "present" | "absent";
  /** 宿主加载器报的错，形如 `#3598: Cannot find module`。 */
  loaderErrors: readonly string[];
  /** 「自动查找」这次试探了多少个编号；没走试探就没有这一位。 */
  scanned?: number;
}

export type PrefillFailureCode =
  | "empty"
  | "missing-target"
  | "no-loader"
  | "no-store"
  | "draft-occupied"
  | "write-failed"
  | "read-back-failed";

export type PrefillResult =
  | { ok: true; via: "draft-store" }
  | {
      ok: false;
      code: PrefillFailureCode;
      /** 找 store 失败时的结构化诊断；界面按语言拼文案，不显示原始英文。 */
      diagnostics?: StoreDiagnostics;
      /** 其余失败的一句话技术说明（宿主的报错、缺哪个参数）；界面不直接显示。 */
      detail?: string;
    };

/**
 * 把诊断里宿主报的错拼成一行给界面引用：只取前三条，多了横幅放不下。
 * 界面只负责把它套进「加载器原话：…」，不自己拼宿主原文。
 */
export function hostLoaderErrors(diagnostics: StoreDiagnostics): string {
  return diagnostics.loaderErrors.slice(0, 3).join(" | ");
}

/**
 * 宿主界面 props 里的 `host.id` 就是草稿 key 的 serverId。
 *
 * 0.13 的 `PluginClientContext` 没有 serverId，从 client 上读只会拿到
 * undefined；宿主渲染插件界面时传入的 `host.id` 才是 installation.serverId。
 */
export function readSurfaceServerId(props: unknown): string {
  const value = (props as { host?: { id?: unknown } } | null)?.host?.id;
  return typeof value === "string" ? value.trim() : "";
}

/** 与宿主 `buildDraftStoreKey` 的 agent 分支保持一致。 */
export function agentDraftKey(serverId: string, agentId: string): string {
  const server = serverId.trim();
  const agent = agentId.trim();
  if (!server || !agent) return "";
  return `agent:${server}:${agent}`;
}

/** 宿主的 Metro 加载器：能按编号取模块，某些构建还暴露模块注册表。 */
interface ModuleLoader {
  (id: number): unknown;
  getModules?: () => unknown;
}

/** 只用到这两个方法，不依赖 DOM 的 `Storage` 类型（客户端 tsconfig 没有 DOM lib）。 */
interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage 在原生端可能没有，取的时候一律兜住。 */
function storage(): KeyValueStorage | null {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function hostLoader(): ModuleLoader | null {
  const value = (globalThis as { __r?: unknown }).__r;
  return typeof value === "function" ? (value as ModuleLoader) : null;
}

/**
 * 判断一个导出值是不是草稿 store：**按形状认，不按名字认**。
 *
 * 名字（`useDraftStore`）随宿主构建变，形状是我们真正要用到的契约：
 * `getState()` 能给出 `drafts`，并且至少有 `editDraftText` / `saveDraftInput` 之一。
 * 只按名字找会在宿主改名后全盘失效，而这时界面只会说「找不到草稿 store」。
 */
function isDraftStore(value: unknown): value is DraftStore {
  if (!value || typeof (value as DraftStore).getState !== "function") return false;
  try {
    const state = (value as DraftStore).getState();
    if (!state || typeof state !== "object") return false;
    // `drafts` 必须是「键 → 草稿」的对象：字符串 / 数组同名糊弄不过去。
    if (!state.drafts || typeof state.drafts !== "object" || Array.isArray(state.drafts)) return false;
    return typeof state.editDraftText === "function" || typeof state.saveDraftInput === "function";
  } catch {
    // getState 自己抛：不是我们能用的 store，别把它当成命中。
    return false;
  }
}

/** 一个模块的导出里有没有草稿 store：先看惯用名，再按形状扫一遍其余导出。 */
function storeOf(exported: unknown): DraftStore | null {
  const holder = exported as Record<string, unknown> | null | undefined;
  if (!holder || (typeof holder !== "object" && typeof holder !== "function")) return null;
  const named = (holder as { useDraftStore?: unknown }).useDraftStore;
  if (isDraftStore(named)) return named;
  let values: unknown[];
  try {
    values = Object.values(holder);
  } catch {
    return null; // 导出带会抛的 getter：只当没有，别把异常抛给调用方。
  }
  for (const value of values) if (isDraftStore(value)) return value;
  return null;
}

function readRememberedId(): number | null {
  try {
    const raw = storage()?.getItem(REMEMBERED_ID_KEY);
    const id = raw ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    // 读不到 localStorage（或内容不是数字）：当作没记过，退回已知编号那条路。
    return null;
  }
}

/** 记住找到的编号。存不下来不算失败——只是下次要多试一次。 */
function rememberDraftStoreId(id: number): void {
  try {
    storage()?.setItem(REMEMBERED_ID_KEY, String(id));
  } catch {
    /* 没有 localStorage（或满了）：不回写，不拦主流程。 */
  }
}

/**
 * 从 Metro 的模块注册表里找**已初始化**的草稿 store。
 *
 * 这是首选手段：只读注册表里已有的导出，不执行任何模块，也就没有副作用。
 * 宿主构建如果没有暴露 `getModules`，返回 null，交给调用方决定要不要试探。
 */
function findInRegistry(loader: ModuleLoader): { id: number; store: DraftStore } | null {
  if (typeof loader.getModules !== "function") return null;
  let registry: unknown;
  try {
    registry = loader.getModules();
  } catch {
    return null;
  }
  const entries: [unknown, unknown][] =
    registry instanceof Map
      ? [...registry.entries()]
      : registry && typeof registry === "object"
        ? Object.entries(registry as Record<string, unknown>)
        : [];
  for (const [rawId, record] of entries) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const holder = record as { publicModule?: { exports?: unknown }; exports?: unknown } | null | undefined;
    const store = storeOf(holder?.publicModule?.exports ?? holder?.exports);
    if (store) return { id, store };
  }
  return null;
}

/** 让出一帧：试探是同步执行的，分片之间必须还给宿主，否则界面会卡住。 */
const yieldToHost = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 逐个编号试探模块导出。
 *
 * 这会**执行**模块的顶层代码（可能有副作用），所以只在用户显式点了「自动查找」时做。
 * 分片执行 + 总时间预算：命中立刻停；到点还没命中就如实报失败，不把界面卡死。
 */
async function scanForStore(
  loader: ModuleLoader,
): Promise<{ hit: { id: number; store: DraftStore } | null; tried: number }> {
  const started = Date.now();
  let tried = 0;
  // 从 1 开始；编号 0 是宿主自己的入口模块，不碰。
  for (let from = 1; from <= MAX_SCAN_ID; from += SCAN_CHUNK) {
    const to = Math.min(from + SCAN_CHUNK - 1, MAX_SCAN_ID);
    for (let id = from; id <= to; id += 1) {
      tried += 1;
      try {
        const store = storeOf(loader(id));
        if (store) return { hit: { id, store }, tried };
      } catch {
        // 这个编号不是模块或加载失败：跳过，继续下一个。
      }
    }
    if (Date.now() - started > SCAN_BUDGET_MS) return { hit: null, tried };
    await yieldToHost();
  }
  return { hit: null, tried };
}

/**
 * 找 store 的结果。
 *
 * 成功与失败靠判别字段分开，不靠「store 有没有值」去猜；失败只有两种原因，
 * 诊断是唯一的事实来源，技术字符串按需从诊断派生，不再另存一份。
 */
type StoreLookup =
  | { ok: true; store: DraftStore }
  | { ok: false; code: "no-loader" | "no-store"; diagnostics?: StoreDiagnostics };

function diagnosticsOf(
  loader: ModuleLoader,
  loaderErrors: readonly string[],
  scanned?: number,
): StoreDiagnostics {
  return {
    knownIds: KNOWN_DRAFT_STORE_MODULE_IDS,
    registry: typeof loader.getModules === "function" ? "present" : "absent",
    loaderErrors,
    ...(scanned === undefined ? {} : { scanned }),
  };
}

/**
 * 只碰少量**已知编号**的那几步：记忆 → 已知编号 → 注册表。
 *
 * 前两步只 `require` 固定的那几个编号，不遍历整个编号空间。草稿 store 是宿主
 * composer 正在用的模块，通常早已初始化，这时 `require` 只是取导出；但如果这个
 * 编号这次没被初始化过（例如 localStorage 里记着旧编号），`require` 仍会执行它的
 * 顶层代码——所以这里仍然不碰未知编号，全量试探只留给用户点按钮。
 *
 * 生产包里 `getModules` 通常不存在（0.13.2 的 Web 包实测没有），所以注册表这一步
 * 在很多宿主上直接落空——这也是必须保留「自动查找」这条路的原因。
 */
function resolveDraftStoreSync(loader: ModuleLoader): { store: DraftStore | null; loaderErrors: string[] } {
  const loaderErrors: string[] = [];
  const miss = (id: number, error?: unknown): void => {
    if (error === undefined) return;
    loaderErrors.push(`#${id}: ${error instanceof Error ? error.message : String(error)}`);
  };

  // 记住的编号可能恰好就是某个已知编号：去重，别对同一个编号试两次、
  // 把同一条加载器报错记两遍。
  const candidates = new Set<number>();
  const remembered = readRememberedId();
  if (remembered !== null) candidates.add(remembered);
  for (const id of KNOWN_DRAFT_STORE_MODULE_IDS) candidates.add(id);

  for (const id of candidates) {
    try {
      const store = storeOf(loader(id));
      if (store) {
        // 记住的编号可能已失效：命中哪个就把它改写进记忆。
        rememberDraftStoreId(id);
        return { store, loaderErrors };
      }
    } catch (error) {
      /* 这个编号不是模块或这次不成立：继续下一个候选。 */
      miss(id, error);
    }
  }

  const registered = findInRegistry(loader);
  if (registered) {
    rememberDraftStoreId(registered.id);
    return { store: registered.store, loaderErrors };
  }

  return { store: null, loaderErrors };
}

/** 同步路径：记忆 / 已知编号 / 注册表，不试探任何未知编号。 */
function resolveDraftStore(): StoreLookup {
  const loader = hostLoader();
  if (!loader) return { ok: false, code: "no-loader" };
  const resolved = resolveDraftStoreSync(loader);
  if (resolved.store) return { ok: true, store: resolved.store };
  return { ok: false, code: "no-store", diagnostics: diagnosticsOf(loader, resolved.loaderErrors) };
}

/** 用户点了「自动查找」时的路径：先走同步那几步，再分片试探整个编号空间。 */
async function resolveDraftStoreWithScan(): Promise<StoreLookup> {
  const loader = hostLoader();
  if (!loader) return { ok: false, code: "no-loader" };
  const resolved = resolveDraftStoreSync(loader);
  if (resolved.store) return { ok: true, store: resolved.store };

  const scanned = await scanForStore(loader);
  if (scanned.hit) {
    rememberDraftStoreId(scanned.hit.id);
    return { ok: true, store: scanned.hit.store };
  }
  return { ok: false, code: "no-store", diagnostics: diagnosticsOf(loader, resolved.loaderErrors, scanned.tried) };
}

interface WriteResult {
  ok: boolean;
  code?: PrefillFailureCode;
  detail?: string;
}

function writeDraft(
  store: DraftStore,
  draftKey: string,
  text: string,
  overwrite: boolean,
): WriteResult {
  try {
    const state = store.getState();
    const current = state.drafts?.[draftKey];
    const currentText = current?.input?.text ?? "";
    if (!overwrite && current?.lifecycle === "active" && currentText.trim() && currentText !== text) {
      return {
        ok: false,
        code: "draft-occupied",
        detail: "the target chat input already has a draft",
      };
    }
    if (current?.lifecycle === "active") {
      // 活动草稿只能用 editDraftText：saveDraftInput 会把已有附件清空。
      if (typeof state.editDraftText !== "function") {
        return { ok: false, code: "write-failed", detail: "draft store has no edit method" };
      }
      state.editDraftText({ draftKey, text });
    } else if (typeof state.saveDraftInput === "function") {
      state.saveDraftInput({ draftKey, draft: { text, attachments: [] } });
    } else {
      return { ok: false, code: "write-failed", detail: "draft store has no write method" };
    }

    // 读回校验：方法存在但 no-op、或 key 被改写的宿主版本不能报成功。
    // composer 只显示 active 草稿，所以文本相同但 lifecycle 不是 active 也算没写进去。
    const written = store.getState().drafts?.[draftKey];
    if (written?.lifecycle !== "active" || written?.input?.text !== text) {
      return { ok: false, code: "read-back-failed", detail: "draft store did not keep an active draft" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: "write-failed",
      detail: `draft store write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface PrefillInput {
  serverId: string;
  agentId: string;
  text: string;
  overwrite?: boolean;
}

/** 校验目标并写出草稿；解析 store 这一步由两条入口各自决定怎么做。 */
function writeResolvedDraft(lookup: StoreLookup, input: PrefillInput, draftKey: string): PrefillResult {
  if (!lookup.ok) {
    return { ok: false, code: lookup.code, diagnostics: lookup.diagnostics };
  }
  const written = writeDraft(lookup.store, draftKey, input.text, input.overwrite === true);
  if (!written.ok) {
    return {
      ok: false,
      code: written.code ?? "write-failed",
      detail: written.detail ?? "draft store rejected the write",
    };
  }
  return { ok: true, via: "draft-store" };
}

/** 空文案与缺目标这两种失败，两条入口报法一样。 */
function targetFailure(input: PrefillInput, draftKey: string): PrefillResult | null {
  if (!input.text.trim()) return { ok: false, code: "empty", detail: "prompt is empty" };
  if (!draftKey) return { ok: false, code: "missing-target", detail: "serverId or agentId is missing" };
  return null;
}

/**
 * 写入目标 agent 的草稿。同步完成；调用方随后导航到该 agent 即可看到文本。
 * 传 `overwrite: true` 才会替换目标输入框里已有的非空草稿。
 *
 * 这条路**不试探**模块：找不到就返回 `no-store`，由界面给出「自动查找」按钮。
 */
export function prefillAgentDraft(input: PrefillInput): PrefillResult {
  const draftKey = agentDraftKey(input.serverId, input.agentId);
  const failure = targetFailure(input, draftKey);
  if (failure) return failure;
  return writeResolvedDraft(resolveDraftStore(), input, draftKey);
}

/**
 * 同上，但找不到时逐个编号试探宿主模块。
 *
 * 试探会执行模块顶层代码（可能副作用），所以单独一条异步入口，只有用户点了
 * 「自动查找草稿 store」才走这里；分片执行，不卡界面。
 */
export async function prefillAgentDraftWithScan(input: PrefillInput): Promise<PrefillResult> {
  const draftKey = agentDraftKey(input.serverId, input.agentId);
  const failure = targetFailure(input, draftKey);
  if (failure) return failure;
  return writeResolvedDraft(await resolveDraftStoreWithScan(), input, draftKey);
}
