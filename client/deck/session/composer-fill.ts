/**
 * 最后一公里：把提示词直接写进「当前可见」的聊天输入框。
 *
 * 为什么需要：0.13 的 composer 输入框是**非受控**的 —— 它只在挂载时读一次
 * `initialValue`（宿主 bundle 的 EditingTextInput 内部就是 `<TextInput defaultValue>`，
 * 只额外暴露命令式 `replaceText`）。草稿 store 的写入因此只对「之后才挂载」的
 * 输入框生效：新建会话、重开标签、刷新页面都能看到；**已经打开着的会话**
 * 不会重读 store，于是出现「提示已填入、框里还是空的」。
 *
 * 宿主没有对插件暴露 composer 的 replaceText（ComposerEditingSession 只给
 * fullscreen 和编辑器持有权，RewindComposerRestore 只服务宿主自己的 rewind），
 * 所以这里退一步：只改**当且仅当唯一可见**的那个输入框，并且：
 * - 只在 web / Electron 渲染进程（有 `document`）里做，原生端直接跳过；
 * - 只认 `textarea[data-composer-input]`，找不到标记才退回「可见 textarea」；
 * - 必须恰好一个可见候选，否则放弃 —— 绝不猜「最后一个 textarea」；
 * - 框里已经有别的非空文本时不动，那是用户正在写的东西；
 * - 写完读回校验，失败就返回 false；草稿 store 里的文字仍在，不影响后续打开。
 *
 * 只改 DOM 值并派发一次 `input` 事件，让宿主自己的 onChange 跑一遍，
 * 从而把文本同步回它的本地镜像和草稿 store。
 */

export type ComposerFillDecision = "fill" | "keep";

/**
 * 是否要写进输入框。
 *
 * 纯函数：`currentValue` 已经是目标文本时算成功（说明挂载时已经水合过），
 * 有别的非空内容则一律不动。
 */
export function composerFillDecision(currentValue: string, text: string): ComposerFillDecision {
  if (currentValue === text) return "keep";
  if (currentValue.trim()) return "keep";
  return text.trim() ? "fill" : "keep";
}

/** 只用到的那几个 DOM 成员；插件的 tsconfig 没有 DOM lib，这里显式声明。 */
interface ComposerInputElement {
  value: string;
  isConnected: boolean;
  getBoundingClientRect(): { width: number; height: number };
  dispatchEvent(event: unknown): boolean;
}

interface ComposerDocument {
  querySelectorAll(selector: string): ArrayLike<ComposerInputElement>;
}

interface ComposerWindow {
  getComputedStyle(element: ComposerInputElement): { display: string; visibility: string };
  Event: new (type: string, init?: { bubbles?: boolean }) => unknown;
}

function hostDocument(): ComposerDocument | null {
  const candidate = (globalThis as { document?: ComposerDocument }).document;
  return candidate && typeof candidate.querySelectorAll === "function" ? candidate : null;
}

function hostWindow(): ComposerWindow | null {
  const candidate = (globalThis as { window?: ComposerWindow }).window;
  return candidate && typeof candidate.getComputedStyle === "function" ? candidate : null;
}

function isVisible(element: ComposerInputElement, view: ComposerWindow): boolean {
  if (!element.isConnected) return false;
  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

/** 当前可见的 composer 输入框；多于或少于一个都交给调用方决定放弃。 */
export function visibleComposerInputs(): ComposerInputElement[] {
  const doc = hostDocument();
  const view = hostWindow();
  if (!doc || !view) return [];
  const marked = Array.from(doc.querySelectorAll("textarea[data-composer-input]"));
  const pool = marked.length > 0 ? marked : Array.from(doc.querySelectorAll("textarea"));
  return pool.filter((element) => isVisible(element, view));
}

function writeValue(input: ComposerInputElement, text: string): void {
  const view = hostWindow();
  const prototype = Object.getPrototypeOf(input) as object | null;
  const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : undefined;
  if (descriptor?.set) (descriptor.set as (this: unknown, value: string) => void).call(input, text);
  else input.value = text;
  if (view) input.dispatchEvent(new view.Event("input", { bubbles: true }));
}

/**
 * 轮询等待可见输入框，出现就写进去，返回是否真的写成功。
 *
 * 轮询而不是一次性检查：导航到目标会话后 composer 可能要等一帧才重新挂载。
 */
export async function fillVisibleComposer(
  text: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const intervalMs = options.intervalMs ?? 60;
  if (!hostDocument() || !text.trim()) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = visibleComposerInputs();
    if (candidates.length === 1) {
      const input = candidates[0];
      if (!input) return false;
      if (composerFillDecision(input.value ?? "", text) === "keep") return (input.value ?? "") === text;
      writeValue(input, text);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return (input.value ?? "") === text;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
