import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 把父会话的 `PASEO_AGENT_ID` 补到 MCP 子进程。
 *
 * Codex 拉起 MCP 子进程时没有继承会话环境变量，但父 codex 进程本身有这一项。
 * 身份只从当前进程树的祖先读取，不接受工具入参，也不跨进程树猜：
 * 读不到就保持空，原有 `caller-unknown` 拒绝行为不变。
 */

export const PASEO_AGENT_ID_KEY = "PASEO_AGENT_ID";

const MAX_PARENT_DEPTH = 4;

type ReadText = (file: string, encoding: "utf8") => string;

export interface ProcessTreeIdentityOptions {
  readonly procRoot?: string;
  readonly maxDepth?: number;
  readonly readText?: ReadText;
  readonly platform?: NodeJS.Platform;
}

/** 读一个 pid 的 environ，只取身份键；读不到或格式不对都返回空串。 */
function agentIdOfProcess(pid: number, procRoot: string, readText: ReadText): string {
  let raw: string;
  try {
    raw = readText(path.join(procRoot, String(pid), "environ"), "utf8");
  } catch {
    return "";
  }
  for (const entry of raw.split("\0")) {
    if (!entry.startsWith(`${PASEO_AGENT_ID_KEY}=`)) continue;
    return entry.slice(PASEO_AGENT_ID_KEY.length + 1).trim();
  }
  return "";
}

/** 读一个 pid 的父 pid；`/proc/<pid>/status` 的 PPid 行不依赖 comm 里的空格。 */
function parentPidOf(pid: number, procRoot: string, readText: ReadText): number | null {
  let raw: string;
  try {
    raw = readText(path.join(procRoot, String(pid), "status"), "utf8");
  } catch {
    return null;
  }
  const match = /^PPid:\s*(\d+)\s*$/m.exec(raw);
  if (!match) return null;
  const parent = Number(match[1]);
  return Number.isInteger(parent) && parent > 1 ? parent : null;
}

/**
 * 从 `startPid` 开始向祖先进程查找 `PASEO_AGENT_ID`。
 *
 * 只读 Linux `/proc`；其它平台没有稳定等价物，直接返回空。
 */
export function agentIdFromProcessTree(
  startPid: number,
  options: ProcessTreeIdentityOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return "";
  const procRoot = options.procRoot ?? "/proc";
  const maxDepth = options.maxDepth ?? MAX_PARENT_DEPTH;
  const readText = options.readText ?? readFileSync;
  let pid: number | null = Number.isInteger(startPid) && startPid > 0 ? startPid : null;
  for (let depth = 0; depth < maxDepth && pid !== null; depth += 1) {
    const found = agentIdOfProcess(pid, procRoot, readText);
    if (found) return found;
    pid = parentPidOf(pid, procRoot, readText);
  }
  return "";
}

/**
 * 在 MCP 启动时补齐身份；已有值永远优先，不让祖先覆盖宿主显式注入的身份。
 *
 * 返回补齐结果，供测试与需要记录的调用方使用；调用方不应把它写进 stdout。
 */
export function adoptSessionAgentId(
  options: ProcessTreeIdentityOptions & { readonly env?: NodeJS.ProcessEnv; readonly ppid?: number } = {},
): { readonly adopted: boolean; readonly agentId: string } {
  const env = options.env ?? process.env;
  const current = env[PASEO_AGENT_ID_KEY]?.trim() ?? "";
  if (current) return { adopted: false, agentId: current };
  const found = agentIdFromProcessTree(options.ppid ?? process.ppid, options);
  if (!found) return { adopted: false, agentId: "" };
  env[PASEO_AGENT_ID_KEY] = found;
  return { adopted: true, agentId: found };
}
