import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerAll } from "./server/rpc/register.ts";

/**
 * 服务端入口：只做挂载。
 *
 * 挂哪些 RPC 在 server/rpc/register.ts，各域实现各归各家；这个文件永远只回答
 * 「怎么把插件交给宿主」这一个问题。
 */
export default function contribute(server: PluginServerContext) {
  registerAll(server);
  return () => {};
}
