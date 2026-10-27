import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerHooks } from "./server/hooks.ts";
import { registerAll } from "./server/rpc/register.ts";
import { registerDeckSettings } from "./server/settings.ts";

/**
 * 服务端入口：只做挂载。
 *
 * 挂哪些 RPC 在 server/rpc/register.ts，生命周期钩子在 server/hooks.ts；
 * 这个文件永远只回答「怎么把插件交给宿主」这一个问题。
 */
export default function contribute(server: PluginServerContext) {
  registerDeckSettings(server);
  registerAll(server);
  registerHooks(server);
  return () => {};
}
