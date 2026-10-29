import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DECK_DIR } from "../shared/local-layout.ts";
import {
  DEFAULT_ORCHESTRATION,
  normalizeOrchestration,
  type OrchestrationSettings,
} from "../shared/orchestration.ts";

/**
 * 编排设置的落盘位置：`<工作区>/.deck/orchestration.json`。
 *
 * 为什么按工作区存而不是宿主级：
 * - 角色绑定（哪个窗口是主沟通窗口）天然是「这个仓库的这套会话」；
 * - 两个入口都要读它——插件 RPC 与 `deck_*` MCP 工具（后者只有 workspaceDir，
 *   没有 daemon 连接），落在工作区里两边读到的是同一份。
 *
 * 文件坏了不阻断使用：读不出来就回落默认值，并把「读失败」如实报给调用方，
 * 不让一个手改坏的 JSON 把整个编排页弄成白屏。
 */

export const ORCHESTRATION_FILE = "orchestration.json";

export interface OrchestrationReadResult {
  settings: OrchestrationSettings;
  file: string;
  exists: boolean;
  /** 文件存在但解析失败时为真；此时 `settings` 是默认值。 */
  corrupt: boolean;
  /**
   * 读文件本身失败（权限 / IO），不是「没配过」。
   *
   * 必须与 `exists: false` 分开：把权限错误说成「还没配过」，界面上会显示默认值并提示
   * 「先加一条工作区角色」——原因看反了，怎么改都不会好。
   */
  readFailed?: boolean;
  detail?: string;
  /**
   * 这份文件属于哪个工作区 id。
   *
   * 为什么写在文件里：角色绑定按 `workspaceId` 索引，而 MCP 子进程只有 `workspaceDir`。
   * 插件保存时把 id 一并写下来，工具端就不必再猜「这条角色是哪个工作区的」。
   */
  workspaceId: string | null;
}

export function orchestrationFileOf(workspaceDir: string): string {
  return path.join(workspaceDir, DECK_DIR, ORCHESTRATION_FILE);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function readOrchestration(workspaceDir: string): Promise<OrchestrationReadResult> {
  const file = orchestrationFileOf(workspaceDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { settings: DEFAULT_ORCHESTRATION, file, exists: false, corrupt: false, workspaceId: null };
    return {
      settings: DEFAULT_ORCHESTRATION,
      file,
      exists: false,
      corrupt: false,
      readFailed: true,
      workspaceId: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = recordOf(parsed);
    if (!record) throw new Error("orchestration.json 顶层不是对象");
    const rawId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    return { settings: normalizeOrchestration(record), file, exists: true, corrupt: false, workspaceId: rawId || null };
  } catch (error) {
    return {
      settings: DEFAULT_ORCHESTRATION,
      file,
      exists: true,
      corrupt: true,
      workspaceId: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type OrchestrationWriteResult =
  | { ok: true; file: string }
  | { ok: false; detail: string };

/**
 * 原子写：先写临时文件再 rename。
 *
 * 中途崩溃不会留下半个 JSON——编排文件里存着「谁是派单窗口」，
 * 读到半截就等于派单对象丢了，比整体失败更难查。
 */
export async function writeOrchestration(
  workspaceDir: string,
  settings: OrchestrationSettings,
  options: { workspaceId?: string | null } = {},
): Promise<OrchestrationWriteResult> {
  const file = orchestrationFileOf(workspaceDir);
  // 没显式给 workspaceId 就沿用文件里原有的：没有 id 的副作用只是 MCP 端要用户多传一个参数，
  // 但把它写成 null 会把之前记下的 id 抹掉，等于每次保存都退回半残状态。
  const workspaceId =
    options.workspaceId !== undefined ? options.workspaceId : (await readOrchestration(workspaceDir)).workspaceId;
  const payload = JSON.stringify(
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...(workspaceId ? { workspaceId } : {}),
      ...settings,
    },
    null,
    2,
  );
  // 带随机后缀：同进程内两次并发写（界面队列之外还有工具端）不能用同一个临时文件名互相截断。
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temp, `${payload}\n`, "utf8");
    await rename(temp, file);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
