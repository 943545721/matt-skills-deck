import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DECK_DIR } from "../shared/local-layout.ts";

/**
 * 群记录：`<工作区>/.deck/group/<workspaceId>.jsonl`，一行一条。
 *
 * 它是**索引，不是真相**：会话的 timeline / 票 / 回传件才是事实，这份文件删了
 * 只丢展示，不丢事实。所以这里不做归档、不压缩，只在写入时裁掉过期行。
 *
 * 保留策略与 plan 第六节一致：最近 5000 条 / 90 天；裁掉时留一行 `system`
 * 「更早的已裁剪」，让人知道这里不是从第一天开始的。
 */

export const GROUP_DIR = "group";
export const GROUP_RETENTION_ROWS = 5000;
export const GROUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** 一条消息在索引里只留摘要，正文仍以会话/timeline 为准。 */
export const MAX_GROUP_TEXT_CHARS = 2000;

export type GroupRecordKind = "user" | "staff" | "system";

export interface GroupRecord {
  at: string;
  /** 人（用户名）或岗位名；system 行写 "deck"。 */
  from: string;
  agentId: string;
  kind: GroupRecordKind;
  text: string;
}

export interface GroupReadResult {
  /** 从旧到新，便于群视图从上往下画。 */
  records: GroupRecord[];
  /** 坏行数；坏一行只丢一行。 */
  skipped: number;
  /** 读文件本身失败（权限 / IO，非 ENOENT）。 */
  failed?: string;
}

export interface GroupAppendInput {
  at?: string;
  from: string;
  agentId: string;
  /** `system` 由插件自己写（契约变更等）；记录解析本来就读它，这里放开类型。 */
  kind: GroupRecordKind;
  text: string;
}

export interface GroupRetentionOptions {
  now?: Date | number | string;
  maxRows?: number;
  maxAgeMs?: number;
}

/** workspaceId 来自宿主，可能带 `/`、空格或中文；目录名只留安全字符。 */
export function groupFileOf(workspaceDir: string, workspaceId: string): string {
  const safe = String(workspaceId ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return path.join(workspaceDir, DECK_DIR, GROUP_DIR, `${safe}.jsonl`);
}

function parseRecord(value: unknown): GroupRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "user" && raw.kind !== "staff" && raw.kind !== "system") return null;
  if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) return null;
  if (typeof raw.from !== "string" || typeof raw.agentId !== "string" || typeof raw.text !== "string") return null;
  return {
    at: raw.at,
    from: raw.from,
    agentId: raw.agentId,
    kind: raw.kind,
    text: raw.text.slice(0, MAX_GROUP_TEXT_CHARS),
  };
}

export async function readGroup(workspaceDir: string, workspaceId: string): Promise<GroupReadResult> {
  const file = groupFileOf(workspaceDir, workspaceId);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
    return { records: [], skipped: 0, failed: `读取群记录失败：${String(error)}` };
  }
  const records: GroupRecord[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = parseRecord(JSON.parse(line) as unknown);
      if (record) records.push(record);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

function toMillis(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : Date.parse(value);
}

/** 裁掉过期与超量的旧行；裁过就留一条 system 标记，别让人以为群只有这么点历史。 */
export function pruneGroup(
  records: readonly GroupRecord[],
  options: GroupRetentionOptions = {},
): { records: GroupRecord[]; trimmed: boolean } {
  const now = toMillis(options.now ?? Date.now());
  const maxRows = Math.max(1, Math.round(options.maxRows ?? GROUP_RETENTION_ROWS));
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? GROUP_RETENTION_MS);
  const recent = records.filter((record) => {
    const at = Date.parse(record.at);
    // 时间解析不出来时保留：宁可多留一条，也不因为一条坏时间把它删掉。
    return !Number.isFinite(at) || now - at <= maxAgeMs;
  });
  const kept = recent.slice(-maxRows);
  const trimmed = kept.length !== records.length;
  if (!trimmed) return { records: [...records], trimmed: false };
  // 每轮裁剪都会再写一次；连续两条「更早的已裁剪」没有信息量，只留最新的那条。
  const first = kept[0];
  const alreadyMarked = first?.kind === "system" && first.text === "更早的群记录已裁剪";
  return {
    records: [
      { at: new Date(now).toISOString(), from: "deck", agentId: "", kind: "system", text: "更早的群记录已裁剪" },
      ...(alreadyMarked ? kept.slice(1) : kept),
    ],
    trimmed: true,
  };
}

async function writeAll(workspaceDir: string, workspaceId: string, records: readonly GroupRecord[]): Promise<void> {
  const file = groupFileOf(workspaceDir, workspaceId);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const body = records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, body, "utf8");
  await rename(temp, file);
}

/**
 * 同一进程里可能有多个写者（群发消息、@全部 逐条落盘）；读-改-写串行，
 * 否则后写者用旧基线覆盖前者，表现为「刚才那句话没了」。
 */
const writeChains = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(workspaceId: string, workspaceDir: string, task: () => Promise<T>): Promise<T> {
  const file = path.resolve(groupFileOf(workspaceDir, workspaceId));
  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(file, next);
  const cleanup = () => {
    if (writeChains.get(file) === next) writeChains.delete(file);
  };
  void next.then(cleanup, cleanup);
  return next;
}

export type GroupAppendResult =
  | { ok: true; record: GroupRecord; trimmed: boolean }
  | { ok: false; detail: string };

/** 追加一条并执行保留策略。形状不合法就整条拒绝，不写坏行。 */
export function appendGroup(
  workspaceDir: string,
  workspaceId: string,
  input: GroupAppendInput,
  options: GroupRetentionOptions = {},
): Promise<GroupAppendResult> {
  return enqueueWrite(workspaceId, workspaceDir, async () => {
    if (!input.from.trim()) return { ok: false, detail: "from 不能为空" };
    if (!input.text.trim()) return { ok: false, detail: "text 不能为空" };
    const at = input.at ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(at))) return { ok: false, detail: "at 不是有效时间" };
    const record: GroupRecord = {
      at,
      from: input.from.trim(),
      agentId: input.agentId.trim(),
      kind: input.kind,
      text: input.text.slice(0, MAX_GROUP_TEXT_CHARS),
    };
    const read = await readGroup(workspaceDir, workspaceId);
    if (read.failed) return { ok: false, detail: read.failed };
    const pruned = pruneGroup([...read.records, record], options);
    try {
      await writeAll(workspaceDir, workspaceId, pruned.records);
    } catch (error) {
      return { ok: false, detail: `写入群记录失败：${String(error)}` };
    }
    return { ok: true, record, trimmed: pruned.trimmed };
  });
}
