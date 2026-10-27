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
};

let current: DeckSettings = DEFAULT_SETTINGS;

const apply = (state: { status: string; values?: unknown }) => {
  if (state.status !== "ready" || !state.values || typeof state.values !== "object") return;
  const parsed = deckSettings.schema.safeParse(state.values);
  if (parsed.success) current = parsed.data;
};

export function registerDeckSettings(server: PluginServerContext): void {
  const handle = server.registerSettings(deckSettings);
  void handle.read().then(apply).catch(() => undefined);
  handle.subscribe(apply);
}

/** 同步快照；尚未完成首次读取时是默认值。 */
export function getSettings(): DeckSettings {
  return current;
}

/** 仅供测试：直接注入一份设置。 */
export function setSettingsForTest(next: DeckSettings): void {
  current = next;
}
