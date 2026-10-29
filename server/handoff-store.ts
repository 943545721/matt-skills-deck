import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DECK_DIR } from "../shared/local-layout.ts";
import { renderHandoff } from "../shared/session.ts";

/**
 * 子会话的回传件。位置：`<工作区>/.deck/handoffs/<agentId>.json`。
 *
 * 为什么落文件而不是只发消息：
 * - 子会话结束时父会话可能在忙着别的回合，消息发不进去也不能把成果扔掉；
 * - 插件重启、父会话归档之后，这份文件仍是可读的证据。
 * 推送只是「顺手通知」，文件才是事实来源。
 */

export const HANDOFF_DIR = "handoffs";

export interface ChildHandoffInput {
  agentId: string;
  status: "completed" | "blocked" | "failed";
  summary: string;
  done?: string[];
  nextSteps?: string[];
  files?: string[];
  blocking?: string[];
  /** 子会话自报的难度/票号，便于回传时带上上下文。 */
  ticketKey?: string;
  difficulty?: string;
  createdAt?: string;
}

export interface ChildHandoffRecord extends ChildHandoffInput {
  version: 1;
  createdAt: string;
}

export function childHandoffDirOf(workspaceDir: string): string {
  return path.join(workspaceDir, DECK_DIR, HANDOFF_DIR);
}

/** agent id 会拼进文件名：只允许安全字符，避免 `../` 把文件写到别处。 */
export function childHandoffPathOf(workspaceDir: string, agentId: string): string | null {
  const safe = agentId.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe.startsWith(".")) return null;
  return path.join(childHandoffDirOf(workspaceDir), `${safe}.json`);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

export async function writeChildHandoff(
  workspaceDir: string,
  input: ChildHandoffInput,
): Promise<{ ok: true; path: string; markdown: string } | { ok: false; detail: string }> {
  const file = childHandoffPathOf(workspaceDir, input.agentId);
  if (!file) return { ok: false, detail: `agent id 不能用作文件名：${input.agentId}` };
  const record: ChildHandoffRecord = {
    version: 1,
    agentId: input.agentId,
    status: input.status,
    summary: input.summary.trim(),
    done: strings(input.done),
    nextSteps: strings(input.nextSteps),
    files: strings(input.files),
    blocking: strings(input.blocking),
    ...(input.ticketKey?.trim() ? { ticketKey: input.ticketKey.trim() } : {}),
    ...(input.difficulty?.trim() ? { difficulty: input.difficulty.trim() } : {}),
    createdAt: input.createdAt?.trim() || new Date().toISOString(),
  };
  const markdown = renderHandoff({
    lang: "zh",
    title: record.ticketKey ? `子任务回传 ${record.ticketKey}` : "子任务回传",
    createdAt: record.createdAt,
    agentId: record.agentId,
    ...(record.ticketKey ? { ticket: { title: record.ticketKey } } : {}),
    summary: record.summary,
    done: record.done ?? [],
    nextSteps: record.nextSteps ?? [],
    risks: record.blocking ?? [],
    files: record.files ?? [],
    notes: [`状态：${record.status}`],
  });
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return { ok: true, path: file, markdown };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function readChildHandoff(
  workspaceDir: string,
  agentId: string,
): Promise<ChildHandoffRecord | null> {
  const file = childHandoffPathOf(workspaceDir, agentId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as ChildHandoffRecord;
    if (record.version !== 1 || typeof record.agentId !== "string") return null;
    // `status` / `createdAt` 是回传件的两根支柱：
    // - 没有 status，正文会渲染出「状态：undefined」；
    // - `createdAt` 坏了（缺失 / 不是时间），「旧件不算新结论」的判定会失效，旧件会被反复当新结论上报。
    // 两种情况都按「这份回传件用不了」处理，退回读本回合的时间线，而不是拿半份文件硬报。
    if (typeof record.status !== "string" || !record.status.trim()) return null;
    if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) return null;
    return record;
  } catch {
    return null;
  }
}
