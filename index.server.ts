import type { PluginServerContext } from "@getpaseo/plugin/server";
import { disposeGithubAuth } from "./server/auth.ts";
import { registerHooks } from "./server/hooks.ts";
import { recordStartup } from "./server/logs.ts";
import { registerAll } from "./server/rpc/register.ts";
import { registerDeckSettings } from "./server/settings.ts";
import { PLUGIN_VERSION } from "./shared/version.ts";

/**
 * 服务端入口：只做挂载。
 *
 * 挂哪些 RPC 在 server/rpc/register.ts，生命周期钩子在 server/hooks.ts；
 * 这个文件永远只回答「怎么把插件交给宿主」这一个问题。
 */
export default function contribute(server: PluginServerContext) {
  // 等设置读完再记启动行：这样「调试日志关着」时不会凭空多出一条。
  const settingsReady = registerDeckSettings(server);
  void settingsReady.then(() => recordStartup({ version: PLUGIN_VERSION, node: process.version }));
  registerAll(server);
  registerHooks(server);
  // 插件卸载时别把等待授权的 gh 子进程留在后台。
  return () => disposeGithubAuth();
}
