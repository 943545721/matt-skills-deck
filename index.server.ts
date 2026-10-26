import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readStatus } from "./server/status";
import { statusRpc } from "./shared/status";

/**
 * 服务端入口：只做注册，不写实现。
 *
 * 约定：每个域一个文件（server/<domain>.ts），入口按域注册 RPC，与源仓库
 * 「入口只装配、实现各归各家」的口径一致，避免这个文件变成下一个千行怪物。
 */
export default function contribute(server: PluginServerContext) {
  server.handle(statusRpc, readStatus);
  return () => {};
}
