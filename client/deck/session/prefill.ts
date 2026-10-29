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
 * 这条边界不是公开协议：模块 id 在 0.13.0 / 0.13.1 / 0.13.2 都是 3598，
 * 但宿主升级仍可能改。失败时返回可解释的错误码，由界面翻译并决定复制兜底。
 */

/** 0.13.x Web bundle 里 `useDraftStore` 的模块编号。 */
const DRAFT_STORE_MODULE_ID = 3598;

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
  | { ok: false; code: PrefillFailureCode; detail: string };

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

function resolveDraftStore(): { store: DraftStore | null; code: PrefillFailureCode; detail: string } {
  const requireModule = (globalThis as { __r?: unknown }).__r;
  if (typeof requireModule !== "function") {
    return { store: null, code: "no-loader", detail: "host bundle has no Metro module loader" };
  }
  try {
    const loaded = (requireModule as (id: number) => unknown)(DRAFT_STORE_MODULE_ID) as
      | { useDraftStore?: DraftStore }
      | undefined;
    const store = loaded?.useDraftStore;
    if (!store || typeof store.getState !== "function") {
      return { store: null, code: "no-store", detail: `module ${DRAFT_STORE_MODULE_ID} has no useDraftStore` };
    }
    return { store, code: "no-store", detail: "" };
  } catch (error) {
    return {
      store: null,
      code: "no-store",
      detail: `reading the draft module failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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

/**
 * 写入目标 agent 的草稿。同步完成；调用方随后导航到该 agent 即可看到文本。
 * 传 `overwrite: true` 才会替换目标输入框里已有的非空草稿。
 */
export function prefillAgentDraft(input: {
  serverId: string;
  agentId: string;
  text: string;
  overwrite?: boolean;
}): PrefillResult {
  const text = input.text;
  if (!text.trim()) return { ok: false, code: "empty", detail: "prompt is empty" };
  const draftKey = agentDraftKey(input.serverId, input.agentId);
  if (!draftKey) {
    return { ok: false, code: "missing-target", detail: "serverId or agentId is missing" };
  }

  const resolved = resolveDraftStore();
  if (!resolved.store) return { ok: false, code: resolved.code, detail: resolved.detail };
  const written = writeDraft(resolved.store, draftKey, text, input.overwrite === true);
  if (!written.ok) {
    return {
      ok: false,
      code: written.code ?? "write-failed",
      detail: written.detail ?? "draft store rejected the write",
    };
  }
  return { ok: true, via: "draft-store" };
}
