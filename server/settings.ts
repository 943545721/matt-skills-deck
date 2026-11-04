import type { PluginServerContext } from "@getpaseo/plugin/server";
import { deckSettings, type DeckSettings } from "../shared/settings.ts";

/**
 * 服务端持有的当前设置。
 *
 * `registerSettings` 是宿主级、异步可订阅的；领域代码只读这里的同步快照，
 * 避免每写一条日志都去 await 一次设置读取。读取失败时回落到默认值，
 * 不让「设置文件坏了」把整个插件拖成不可用。
 */
export const DEFAULT_SETTINGS: DeckSettings = {
  backend: "auto",
  refreshSeconds: 60,
  debugLogging: true,
  appearance: "auto",
  skillsMode: "per-project",
  autoAllowPermissions: false,
};

let current: DeckSettings = DEFAULT_SETTINGS;

const apply = (state: { status: string; values?: unknown }) => {
  if (state.status !== "ready" || !state.values || typeof state.values !== "object") return;
  const parsed = deckSettings.schema.safeParse(state.values);
  if (parsed.success) current = parsed.data;
};

/**
 * 返回首次读取完成（或失败）的 promise：调用方要等到那时才能确定
 * `debugLogging` 的真实值——启动日志只有在此之后记，才不会绕过用户的开关。
 */
export function registerDeckSettings(server: PluginServerContext): Promise<void> {
  const handle = server.registerSettings(deckSettings);
  const ready = handle.read().then(apply).catch(() => undefined);
  handle.subscribe(apply);
  return ready;
}

/** 同步快照；尚未完成首次读取时是默认值。 */
export function getSettings(): DeckSettings {
  return current;
}

/** 仅供测试：直接注入一份设置。 */
export function setSettingsForTest(next: DeckSettings): void {
  current = next;
}
