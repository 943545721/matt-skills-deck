import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "../shared/identity.ts";

interface DaemonConfig {
  plugins?: Record<string, { path?: string }>;
}

let cachedRoot: string | null = null;

export function daemonHome(): string {
  return process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
}

/**
 * 插件自身的安装目录。
 *
 * 为什么不用 import.meta：在 daemon 的插件子进程里实测 `import.meta.url` 是空字符串、
 * `process.cwd()` 是 `/`，两条常规办法都拿不到自己的位置。
 * 为什么读 config.json 而不是起 `paseo plugin ls`：daemon 加载插件时必然已经写好这份配置，
 * 一次本地文件读比再开一个子进程便宜，也不会因为 PATH 里没有 paseo 而失败。
 */
export function pluginRoot(): string {
  if (cachedRoot) return cachedRoot;
  const configPath = path.join(daemonHome(), "config.json");
  let config: DaemonConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
  } catch (error) {
    throw new Error(
      `读不到 daemon 配置 ${configPath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const directory = config.plugins?.[PLUGIN_ID]?.path;
  if (!directory) {
    throw new Error(`daemon 配置里没有 ${PLUGIN_ID} 的安装路径；插件可能还没被 daemon 记录`);
  }
  cachedRoot = directory;
  return directory;
}

/** 测试用：清掉缓存，避免同一进程里切换 PASEO_HOME 后读到旧路径。 */
export function resetPluginRootCache(): void {
  cachedRoot = null;
}
