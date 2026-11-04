import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { GroupDelivery } from "../shared/group-rpc.ts";
import { DECK_DIR } from "../shared/local-layout.ts";

/**
 * 群发的幂等记录。
 *
 * `deck.group.send` 会建票、建会话——都是**不可撤销**的副作用。调用方在超时后
 * 重试同一句时，不能因为「上一次其实成功了、只是回包丢了」就再建一遍。
 * 所以带 `requestId` 的发消息在成功后落一行结果，重试直接回放这一行。
 *
 * 只记成功（含部分目标失败的成功）；失败没有副作用，重试本来就该重算。
 * 文件是索引，不是真相：丢了只意味着重试可能重复建票，不影响群记录与票本身。
 */

export const GROUP_REQUEST_FILE_SUFFIX = ".requests.jsonl";
export const GROUP_REQUEST_RETENTION_ROWS = 200;
export const GROUP_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredGroupSend {
  requestId: string;
  at: string;
  deliveries: GroupDelivery[];
  warnings: string[];
}

export function groupRequestFileOf(workspaceDir: string, workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200) || "workspace";
  return path.join(workspaceDir, DECK_DIR, "group", `${safe}${GROUP_REQUEST_FILE_SUFFIX}`);
}

function parseStored(value: unknown): StoredGroupSend | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.requestId !== "string" || !raw.requestId) return null;
  if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) return null;
  if (!Array.isArray(raw.deliveries) || !Array.isArray(raw.warnings)) return null;
  const deliveries = raw.deliveries.filter(
    (item): item is GroupDelivery =>
      typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string",
  );
  const warnings = raw.warnings.filter((item): item is string => typeof item === "string");
  return { requestId: raw.requestId, at: raw.at, deliveries, warnings };
}

export type GroupRequestRead =
  | { readonly ok: true; readonly hit: StoredGroupSend | null }
  | { readonly ok: false; readonly detail: string };

/**
 * 读幂等记录。
 *
 * 只有「文件不存在」能当成「这句没派过」；其余读失败必须交给调用方拒绝重试——
 * 否则一次 EACCES / EIO 就会被当成「从没派过」，重新建票、重建会话，正是幂等要防的事。
 */
export async function readGroupRequest(
  workspaceDir: string,
  workspaceId: string,
  requestId: string,
): Promise<GroupRequestRead> {
  const key = requestId.trim();
  if (!key) return { ok: true, hit: null };
  let text: string;
  try {
    text = await readFile(groupRequestFileOf(workspaceDir, workspaceId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, hit: null };
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  let hit: StoredGroupSend | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const stored = parseStored(JSON.parse(line) as unknown);
      // 同一 requestId 可能因为并发写出现多行：以最后一行为准。
      if (stored && stored.requestId === key) hit = stored;
    } catch {
      // 坏行跳过：这份文件只是索引，读不懂不影响重算。
    }
  }
  return { ok: true, hit };
}

/** 追加 + 裁剪是读改写，串行执行；并发两句群发时不会互相裁掉刚写的那一行。 */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 追加一行并顺手裁掉过期 / 超量的旧行；裁不动只回 warning，不回滚已发生的事。 */
export async function rememberGroupRequest(
  workspaceDir: string,
  workspaceId: string,
  result: StoredGroupSend,
  now: Date | number | string = Date.now(),
): Promise<{ ok: true } | { ok: false; detail: string }> {
  return enqueueWrite(() => writeGroupRequest(workspaceDir, workspaceId, result, now));
}

async function writeGroupRequest(
  workspaceDir: string,
  workspaceId: string,
  result: StoredGroupSend,
  now: Date | number | string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const file = groupRequestFileOf(workspaceDir, workspaceId);
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  const line = JSON.stringify(result);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${line}\n`, "utf8");
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
  // 时间读不出来时宁可不裁：按 NaN 比较会把所有行都判成过期，写回一份空文件。
  if (!Number.isFinite(nowMs)) return { ok: true };
  try {
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const fresh = lines.filter((entry) => {
      try {
        const parsed = JSON.parse(entry) as { at?: unknown };
        return typeof parsed.at === "string" && nowMs - Date.parse(parsed.at) <= GROUP_REQUEST_RETENTION_MS;
      } catch {
        return false;
      }
    });
    const kept = fresh.slice(-GROUP_REQUEST_RETENTION_ROWS);
    // 刚写的那一行无论时间多旧都要留下：它记录的是刚刚发生的副作用。
    if (!kept.includes(line)) kept.push(line);
    if (kept.length !== lines.length) {
      const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, `${kept.join("\n")}\n`, "utf8");
      await rename(temp, file);
    }
  } catch {
    // 裁剪失败不影响幂等本身：多留几行而已。
  }
  return { ok: true };
}
