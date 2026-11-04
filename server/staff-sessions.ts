/**
 * 岗位会话台账：`agentId → 卡 id`。
 *
 * 为什么需要这份文件：`deck_dispatch_plan` 跑在 MCP 子进程里，`ToolContext` 只有
 * `workspaceDir`，读不到宿主会话的 `deck.staff` 标签。名册卡上的 id 是稳定键，
 * 宿主的 agent id 是另一套值，拿两者直接比较永远不相等。
 *
 * `agent.created` 那一刻既有完整 `PaseoApi`、又读得到标签，是唯一能看清
 * 「这个会话是哪张卡开的」的位置；它把对应关系追加到 `.deck/staff-sessions.jsonl`，
 * MCP 进程再按 `PASEO_AGENT_ID` 反查。文件是追加写的，最后一条为准。
 *
 * 失败方向是放行：文件不存在、读不出来、行坏了都只当「不知道」，不拦会话。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { record } from "./logs.ts";

/** 台账放在 `.deck` 下，与派单票、协调收件箱同一层。 */
const STAFF_SESSIONS_FILE = "staff-sessions.jsonl";

export interface StaffSessionRecord {
  readonly agentId: string;
  readonly staffId: string;
  readonly workspaceId?: string | null;
  readonly at?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fileOf(workspaceDir: string): string {
  return path.join(workspaceDir, ".deck", STAFF_SESSIONS_FILE);
}

/** 记一条对应关系；同一会话重复记时以最后一条为准。 */
export async function rememberStaffSession(
  workspaceDir: string,
  record: StaffSessionRecord,
): Promise<void> {
  const agentId = text(record.agentId);
  const staffId = text(record.staffId);
  if (!agentId || !staffId) return;
  const dir = path.join(workspaceDir, ".deck");
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    agentId,
    staffId,
    ...(text(record.workspaceId) ? { workspaceId: text(record.workspaceId) } : {}),
    at: text(record.at) || new Date().toISOString(),
  });
  await appendFile(fileOf(workspaceDir), `${line}\n`, "utf8");
}

/** 反查某个会话是哪张卡开的；不知道返回 null（调用方按「不是员工」处理）。 */
export async function staffIdOfSession(
  workspaceDir: string,
  agentId: string,
): Promise<string | null> {
  const wanted = text(agentId);
  if (!wanted) return null;
  let raw = "";
  try {
    raw = await readFile(fileOf(workspaceDir), "utf8");
  } catch (error) {
    // 没有台账不是错误：老会话、手工会话都可能没有这一行。但权限 / IO 错误
    // 会让「是不是员工」判不出来，不能一起吞掉；记 warn 后仍按放行处理。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      record(
        "warn",
        "staff-sessions",
        `读岗位会话台账失败，本次认不出调用者（${fileOf(workspaceDir)}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
  let found: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { agentId?: unknown; staffId?: unknown };
      if (text(parsed.agentId) === wanted) found = text(parsed.staffId) || null;
    } catch {
      // 坏行跳过：一份追加文件里坏一行不该让整个反查失效。
    }
  }
  return found;
}
