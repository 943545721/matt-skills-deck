import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClientProfile, Difficulty } from "../shared/orchestration.ts";
import { readOrchestration, type OrchestrationReadResult } from "./orchestration-store.ts";
import { daemonHome } from "./paths.ts";
import type { ProviderConfigSource } from "./provider-entry.ts";

/**
 * MCP 进程侧的 daemon 配置读取。
 *
 * 为什么在这里再读一次 `config.json`：`deck_*` 工具跑在 MCP 子进程里，没有 `paseo` 句柄，
 * 拿不到 `config.get()`。但它和 daemon 同机同用户，`<PASEO_HOME>/config.json` 读得到。
 *
 * 只读，只取编排需要的两个面（档案与 provider 条目）；写仍然只走插件 RPC——
 * 两个进程同时改同一份宿主配置，后写的会把先写的抹掉。
 */

export interface DaemonProfileRead {
  profiles: ClientProfile[];
  /**
   * 解析后的 daemon 配置原样带出：默认档上下文由 `thinkingContextOf` 从它拼，
   * MCP 侧不再手抄一份「这个客户端有哪些模型」的判据。
   */
  config: ProviderConfigSource | null;
  /** 读不到文件 / 解析失败时为 null，调用方据此决定是「没有档案」还是「读失败」。 */
  detail: string | null;
}

export function daemonConfigPath(homeDir = daemonHome()): string {
  return path.join(homeDir, "config.json");
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 磁盘上的 config.json 文本 → 配置对象；解析不了就是 null（不是空对象）。 */
function configFromText(text: string): Record<string, unknown> | null {
  try {
    return recordOf(JSON.parse(text));
  } catch {
    return null;
  }
}

/** 宿主档案 → 编排认的字段；缺 id 或 provider 的条目跳过（宿主自己也会忽略）。 */
export function profilesFromConfigText(text: string): ClientProfile[] {
  return profilesOfConfig(configFromText(text));
}

function profilesOfConfig(config: Record<string, unknown> | null): ClientProfile[] {
  const daemon = recordOf(config?.daemon);
  // 磁盘上是 `daemon.agentProfiles`；万一这份文件被按线上形状写过（根级），也认。
  const raw = Array.isArray(daemon?.agentProfiles) ? daemon.agentProfiles : config?.agentProfiles;
  if (!Array.isArray(raw)) return [];
  const profiles: ClientProfile[] = [];
  for (const item of raw) {
    const entry = recordOf(item);
    if (!entry) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    if (!id || !provider) continue;
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    const modeId = typeof entry.modeId === "string" ? entry.modeId.trim() : "";
    const thinkingOptionId = typeof entry.thinkingOptionId === "string" ? entry.thinkingOptionId.trim() : "";
    const notes = typeof entry.notes === "string" ? entry.notes.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    profiles.push({
      id,
      name: name || id,
      provider,
      ...(model ? { model } : {}),
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(entry.featureValues ? { featureValues: entry.featureValues as Record<string, unknown> } : {}),
      ...(notes ? { notes } : {}),
    });
  }
  return profiles;
}

export async function readDaemonProfiles(): Promise<DaemonProfileRead> {
  const file = daemonConfigPath();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      profiles: [],
      config: null,
      detail: `读不到 daemon 配置 ${file}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // 只解析一次：档案与 provider 条目来自同一份文件，分两次读会出现「档案是新的、清单是旧的」。
  const config = configFromText(text);
  return {
    profiles: profilesOfConfig(config),
    config: config as ProviderConfigSource | null,
    detail: null,
  };
}

export interface PlanContextRead extends OrchestrationReadResult {
  profiles: ClientProfile[];
  /** 宿主配置原样带出，供 `thinkingContextOf` 拼默认档上下文。 */
  config: ProviderConfigSource | null;
  profileDetail: string | null;
}

/** 一次拿到「这个工作区的角色/路由」+「宿主的客户端档案与 provider 条目」。 */
export async function readPlanContext(workspaceDir: string): Promise<PlanContextRead> {
  const [settings, profileRead] = await Promise.all([readOrchestration(workspaceDir), readDaemonProfiles()]);
  return {
    ...settings,
    profiles: profileRead.profiles,
    config: profileRead.config,
    profileDetail: profileRead.detail,
  };
}

/** 难度标签的落点：路由条目按难度取，这里只做名字归一。 */
export function knownDifficulty(value: unknown): Difficulty | null {
  return value === "trivial" || value === "normal" || value === "hard" || value === "critical" ? value : null;
}
