import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PLUGIN_VERSION } from "../shared/version.ts";

const execFileAsync = promisify(execFile);

interface GhProbe {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

/** 只起一次短命进程问版本；超时与最大输出都收紧，避免慢机器上把 RPC 拖住。 */
async function probeGhVersion(): Promise<{ version: string } | { error: string }> {
  try {
    const { stdout } = await execFileAsync("gh", ["--version"], { timeout: 5_000, maxBuffer: 1 << 20 });
    const firstLine = stdout.split("\n")[0]?.trim() ?? "";
    return firstLine ? { version: firstLine } : { error: "gh --version 没有输出" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 用系统自带的 which/where 解析 gh 的绝对路径，失败不影响可用性判断。 */
async function probeGhPath(): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(finder, ["gh"], { timeout: 3_000 });
    return stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

async function probeGh(): Promise<GhProbe> {
  const [version, path] = await Promise.all([probeGhVersion(), probeGhPath()]);
  if ("version" in version) {
    return { available: true, path, version: version.version, error: null };
  }
  return { available: false, path, version: null, error: version.error };
}

/**
 * 读数只回答事实，不做「装没装好」的判定：判定属于后续的环境检查页（P4），
 * 这里多一句主观结论会让两处口径打架。
 */
export async function readStatus() {
  return {
    pluginVersion: PLUGIN_VERSION,
    node: process.version,
    daemonCwd: process.cwd(),
    gh: await probeGh(),
  };
}
