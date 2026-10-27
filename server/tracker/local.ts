import { readFile, readdir, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ListView } from "../../shared/issues.ts";
import type { Issue, IssueDetailResult, ListIssuesResult } from "./github.ts";
import { readinessOf } from "./readiness.ts";
import { dedupeLabels } from "./write.ts";

/**
 * 本地 Markdown 后端。
 *
 * 用途：工作区没有远端（或用户在设置里选了 local）时，任务板仍然可用——
 * 票落到 `.deck/issues/<number>.md`，评论落到同名 `.comments.json`，标签目录在 `.deck/labels.json`。
 *
 * 为什么是 Markdown 而不是 SQLite：用户随时可以用编辑器打开、用 git 提交、用 grep 找；
 * 数据库会把这些能力全部收走，而这个后端存在的意义恰恰是「没有 GitHub 也能把事记下来」。
 *
 * 所有读写都在 `.deck/` 内，路径由票号拼出（数字），不接受外部给的文件名。
 */

const DECK_DIR = ".deck";
const ISSUES_DIR = "issues";
const LABELS_FILE = "labels.json";
const MAP_LABEL = "wayfinder:map";
const DEFAULT_COLOR = "cccccc";

export type LocalFailure = { ok: false; reason: "invalid" | "local-failed" | "not-found"; detail: string };

const failure = (error: unknown): LocalFailure => ({
  ok: false,
  reason: "local-failed",
  detail: `读写 .deck/ 失败：${error instanceof Error ? error.message : String(error)}`,
});

export const localRepoName = (workspaceDir: string): string => path.basename(path.resolve(workspaceDir)) || "workspace";

const issuesDir = (workspaceDir: string) => path.join(workspaceDir, DECK_DIR, ISSUES_DIR);

const issuePath = (workspaceDir: string, number: number) => path.join(issuesDir(workspaceDir), `${number}.md`);
const commentsPath = (workspaceDir: string, number: number) => path.join(issuesDir(workspaceDir), `${number}.comments.json`);

interface LocalRecord {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  blockedBy: number[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumbers(raw: string | undefined): number[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  // 前端写的是 JSON 数组（`[1, 2]`），手写时常写成 `1, 2`；两种都认。
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => Number(item)).filter((value) => Number.isInteger(value) && value > 0);
    } catch {
      return [];
    }
  }
  return text
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * 解析一张票。
 *
 * 严格到「缺 frontmatter 就当不是票」：`.deck/issues` 里可能混进用户自己的笔记，
 * 把半截文本猜成票会让任务板出现来历不明的条目。
 */
export function parseLocalIssue(text: string, fallbackNumber: number): LocalRecord | null {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return null;
  const front = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  const fields = new Map<string, string>();
  for (const line of front.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (match) fields.set(match[1] ?? "", match[2] ?? "");
  }
  const number = Number(fields.get("number"));
  const finalNumber = Number.isInteger(number) && number > 0 ? number : fallbackNumber;
  if (!Number.isInteger(finalNumber) || finalNumber <= 0) return null;
  const now = new Date(0).toISOString();
  return {
    number: finalNumber,
    title: asString(fields.get("title"), `#${finalNumber}`) || `#${finalNumber}`,
    state: fields.get("state") === "CLOSED" ? "CLOSED" : "OPEN",
    labels: dedupeLabels(parseList(fields.get("labels"))),
    assignees: parseList(fields.get("assignees")),
    blockedBy: parseNumbers(fields.get("blockedBy")),
    createdAt: asString(fields.get("createdAt"), now) || now,
    updatedAt: asString(fields.get("updatedAt"), now) || now,
    body,
  };
}

function serializeLocalIssue(record: LocalRecord): string {
  const front = [
    `number: ${record.number}`,
    `title: ${record.title.replace(/\n/g, " ")}`,
    `state: ${record.state}`,
    `labels: ${JSON.stringify(record.labels)}`,
    `assignees: ${JSON.stringify(record.assignees)}`,
    `blockedBy: ${JSON.stringify(record.blockedBy)}`,
    `createdAt: ${record.createdAt}`,
    `updatedAt: ${record.updatedAt}`,
  ].join("\n");
  return `---\n${front}\n---\n${record.body}`;
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function readRecords(workspaceDir: string): Promise<LocalRecord[]> {
  let names: string[];
  try {
    names = await readdir(issuesDir(workspaceDir));
  } catch (error) {
    // 目录不存在 = 还没有任何本地票，这是空后端而不是故障。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: LocalRecord[] = [];
  for (const name of names) {
    const match = name.match(/^(\d+)\.md$/);
    if (!match) continue;
    const number = Number(match[1]);
    try {
      const text = await readFile(path.join(issuesDir(workspaceDir), name), "utf8");
      const parsed = parseLocalIssue(text, number);
      if (parsed) records.push(parsed);
    } catch {
      // 单张票读不了不能拖垮整块板：跳过它，其它票照常显示。
    }
  }
  return records;
}

function toIssue(record: LocalRecord, all: readonly LocalRecord[]): Issue {
  const blockedBy = record.blockedBy.map((number) => {
    const blocker = all.find((item) => item.number === number);
    return {
      number,
      title: blocker?.title ?? `#${number}`,
      state: blocker?.state ?? ("OPEN" as const),
      kind: "issue" as const,
    };
  });
  const base = {
    number: record.number,
    title: record.title,
    state: record.state,
    url: "",
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    labels: record.labels.map((name) => ({ name, color: colorOf(name) })),
    assignees: record.assignees,
    isMap: record.labels.includes(MAP_LABEL),
    kind: "issue" as const,
    merged: false,
    blockedBy,
  };
  return { ...base, readiness: readinessOf(base) };
}

/* ------------------------------------------------------------------ 标签 */

interface LabelRecord {
  name: string;
  color: string;
  description: string;
}

const colorCache = new Map<string, string>();

/**
 * 颜色解析。
 *
 * 标签目录是异步读的，而映射函数是同步的；这里用最近一次读到的快照。
 * 目录里没有的标签给默认灰色——颜色只影响观感，不影响识别。
 */
function colorOf(name: string): string {
  return colorCache.get(name) ?? DEFAULT_COLOR;
}

async function readLabelCatalog(workspaceDir: string): Promise<LabelRecord[]> {
  try {
    const raw = await readFile(path.join(workspaceDir, DECK_DIR, LABELS_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const record = item as { name?: unknown; color?: unknown; description?: unknown } | null;
      const name = asString(record?.name);
      if (!name) return [];
      return [{ name, color: asString(record?.color, DEFAULT_COLOR) || DEFAULT_COLOR, description: asString(record?.description) }];
    });
  } catch {
    return [];
  }
}

async function writeLabelCatalog(workspaceDir: string, labels: readonly LabelRecord[]): Promise<void> {
  const dir = path.join(workspaceDir, DECK_DIR);
  await mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, LABELS_FILE), `${JSON.stringify(labels, null, 2)}\n`);
}

async function refreshColorCache(workspaceDir: string): Promise<LabelRecord[]> {
  const catalog = await readLabelCatalog(workspaceDir);
  colorCache.clear();
  for (const label of catalog) colorCache.set(label.name, label.color);
  return catalog;
}

export async function listLocalLabels(
  workspaceDir: string,
): Promise<{ ok: true; labels: LabelRecord[] } | LocalFailure> {
  try {
    const catalog = await refreshColorCache(workspaceDir);
    const used = new Set<string>();
    for (const record of await readRecords(workspaceDir)) for (const name of record.labels) used.add(name);
    const merged = new Map(catalog.map((label) => [label.name, label]));
    for (const name of used) if (!merged.has(name)) merged.set(name, { name, color: DEFAULT_COLOR, description: "" });
    return { ok: true, labels: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (error) {
    return failure(error);
  }
}

export async function setLocalLabelColors(
  workspaceDir: string,
  changes: readonly { name: string; color: string }[],
): Promise<
  | {
      ok: true;
      applied: { name: string; color: string }[];
      failed: { name: string; detail: string }[];
      verified: { name: string; color: string }[];
      mismatched: { name: string; expected: string; actual: string }[];
      readbackFailed: boolean;
    }
  | LocalFailure
> {
  const normalized = changes.map((change) => ({
    name: change.name.trim(),
    color: change.color.replace(/^#/, "").toLowerCase(),
  }));
  const invalid = normalized.filter((change) => !change.name || !/^[0-9a-f]{6}$/.test(change.color));
  if (invalid.length) {
    return { ok: false, reason: "invalid", detail: `颜色必须是 6 位十六进制：${invalid.map((item) => item.name || "(空)").join("、")}` };
  }
  try {
    const catalog = await readLabelCatalog(workspaceDir);
    const next = new Map(catalog.map((label) => [label.name, label]));
    for (const change of normalized) {
      const existing = next.get(change.name);
      next.set(change.name, {
        name: change.name,
        color: change.color,
        description: existing?.description ?? "",
      });
    }
    await writeLabelCatalog(workspaceDir, [...next.values()]);

    // 读回核对：本地写入理论上不会失败，但「请求成功」和「磁盘上确实变了」是两件事。
    const readback = await listLocalLabels(workspaceDir);
    if (!readback.ok) {
      return { ok: true, applied: normalized, failed: [], verified: [], mismatched: [], readbackFailed: true };
    }
    const actual = new Map(readback.labels.map((label) => [label.name, label.color]));
    const verified: { name: string; color: string }[] = [];
    const mismatched: { name: string; expected: string; actual: string }[] = [];
    for (const change of normalized) {
      if (actual.get(change.name) === change.color) verified.push(change);
      else mismatched.push({ name: change.name, expected: change.color, actual: actual.get(change.name) ?? "" });
    }
    return { ok: true, applied: normalized, failed: [], verified, mismatched, readbackFailed: false };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ 读取 */

export interface LocalListOptions {
  limit?: number;
  view?: ListView;
  includeClosed?: boolean;
}

export async function listLocalIssues(workspaceDir: string, options: LocalListOptions = {}): Promise<ListIssuesResult> {
  try {
    await refreshColorCache(workspaceDir);
    const records = await readRecords(workspaceDir);
    const view = options.view ?? (options.includeClosed ? "all" : "open");
    const wanted = records.filter((record) => {
      if (view === "merged") return false; // 本地没有 PR，合并视图就是空的。
      if (view === "closed") return record.state === "CLOSED";
      if (view === "all") return true;
      // open / ready / blocked 都只在打开的票里算。
      return record.state === "OPEN";
    });
    const sorted = [...wanted].sort((a, b) => {
      const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      return Number.isNaN(byUpdated) || byUpdated === 0 ? b.number - a.number : byUpdated;
    });
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    const visible = sorted.slice(0, limit);
    return {
      ok: true,
      issues: visible.map((record) => toIssue(record, records)),
      totalCount: sorted.length,
      hasMore: sorted.length > visible.length,
      fetchedAt: new Date().toISOString(),
      source: "local",
      rateLimit: null,
    };
  } catch (error) {
    return failure(error);
  }
}

interface LocalComment {
  author: string;
  createdAt: string;
  body: string;
}

async function readComments(workspaceDir: string, number: number): Promise<LocalComment[]> {
  try {
    const raw = await readFile(commentsPath(workspaceDir, number), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const record = item as { author?: unknown; createdAt?: unknown; body?: unknown } | null;
      const body = asString(record?.body);
      if (!body) return [];
      return [
        {
          author: asString(record?.author, "local"),
          createdAt: asString(record?.createdAt),
          body,
        },
      ];
    });
  } catch {
    return [];
  }
}

export async function getLocalIssue(workspaceDir: string, number: number): Promise<IssueDetailResult> {
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  }
  try {
    await refreshColorCache(workspaceDir);
    const records = await readRecords(workspaceDir);
    const record = records.find((item) => item.number === number);
    if (!record) return { ok: false, reason: "not-found", detail: `\`.deck/issues\` 里没有 #${number}` };
    const comments = await readComments(workspaceDir, number);
    return {
      ok: true,
      issue: { ...toIssue(record, records), body: record.body },
      comments,
      meta: {
        labelCount: record.labels.length,
        labelsTruncated: false,
        commentCount: comments.length,
        commentsTruncated: false,
        blockersTruncated: false,
      },
    };
  } catch (error) {
    return failure(error) as IssueDetailResult;
  }
}

/* ------------------------------------------------------------------ 写入 */

const now = () => new Date().toISOString();

async function writeRecord(workspaceDir: string, record: LocalRecord): Promise<void> {
  await mkdir(issuesDir(workspaceDir), { recursive: true });
  await writeAtomic(issuePath(workspaceDir, record.number), serializeLocalIssue(record));
}

export async function createLocalIssue(
  workspaceDir: string,
  input: { title: string; body: string; labels: readonly string[] },
): Promise<{ ok: true; number: number; url: string; labels: string[]; labelsFailed: boolean } | LocalFailure> {
  const title = input.title.trim();
  if (!title) return { ok: false, reason: "invalid", detail: "标题不能为空" };
  if (title.length > 256) return { ok: false, reason: "invalid", detail: "标题过长（上限 256 字）" };
  try {
    await refreshColorCache(workspaceDir);
    const records = await readRecords(workspaceDir);
    const number = records.reduce((max, record) => Math.max(max, record.number), 0) + 1;
    const labels = dedupeLabels(input.labels);
    const timestamp = now();
    await writeRecord(workspaceDir, {
      number,
      title,
      state: "OPEN",
      labels,
      assignees: [],
      blockedBy: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      body: input.body,
    });
    return { ok: true, number, url: "", labels, labelsFailed: false };
  } catch (error) {
    return failure(error);
  }
}

export async function postLocalComment(
  workspaceDir: string,
  number: number,
  body: string,
): Promise<{ ok: true; comment: LocalComment } | LocalFailure> {
  if (!body.trim()) return { ok: false, reason: "invalid", detail: "评论内容不能为空" };
  try {
    const records = await readRecords(workspaceDir);
    const record = records.find((item) => item.number === number);
    if (!record) return { ok: false, reason: "not-found", detail: `\`.deck/issues\` 里没有 #${number}` };
    const comments = await readComments(workspaceDir, number);
    const comment = { author: "local", createdAt: now(), body };
    await mkdir(issuesDir(workspaceDir), { recursive: true });
    await writeAtomic(commentsPath(workspaceDir, number), `${JSON.stringify([...comments, comment], null, 2)}\n`);
    await writeRecord(workspaceDir, { ...record, updatedAt: comment.createdAt });
    return { ok: true, comment };
  } catch (error) {
    return failure(error);
  }
}

export async function replaceLocalLabels(
  workspaceDir: string,
  number: number,
  labels: readonly string[],
): Promise<{ ok: true; labels: { name: string; color: string }[] } | LocalFailure> {
  try {
    const catalog = await refreshColorCache(workspaceDir);
    const records = await readRecords(workspaceDir);
    const record = records.find((item) => item.number === number);
    if (!record) return { ok: false, reason: "not-found", detail: `\`.deck/issues\` 里没有 #${number}` };
    const wanted = dedupeLabels(labels);
    await writeRecord(workspaceDir, { ...record, labels: wanted, updatedAt: now() });
    const known = new Map(catalog.map((label) => [label.name, label.color]));
    return { ok: true, labels: wanted.map((name) => ({ name, color: known.get(name) ?? DEFAULT_COLOR })) };
  } catch (error) {
    return failure(error);
  }
}

export async function setLocalIssueState(
  workspaceDir: string,
  number: number,
  state: "open" | "closed",
): Promise<{ ok: true; state: "OPEN" | "CLOSED" } | LocalFailure> {
  try {
    const records = await readRecords(workspaceDir);
    const record = records.find((item) => item.number === number);
    if (!record) return { ok: false, reason: "not-found", detail: `\`.deck/issues\` 里没有 #${number}` };
    const next = state === "closed" ? ("CLOSED" as const) : ("OPEN" as const);
    await writeRecord(workspaceDir, { ...record, state: next, updatedAt: now() });
    return { ok: true, state: next };
  } catch (error) {
    return failure(error);
  }
}

/**
 * 只改给出的字段，其余保持原样。
 *
 * 与 GitHub 的 PATCH 同口径：标题去空白后不能为空、上限 256 字；一个字段都没给就拒绝，
 * 而不是写一次「什么都没变」却更新了 updatedAt。
 */
export async function patchLocalIssue(
  workspaceDir: string,
  number: number,
  patch: { title?: string; body?: string; state?: "open" | "closed" },
): Promise<{ ok: true; title: string; body: string; state: "OPEN" | "CLOSED" } | LocalFailure> {
  const title = patch.title?.trim();
  if (title !== undefined && !title) return { ok: false, reason: "invalid", detail: "标题不能为空" };
  if (title !== undefined && title.length > 256) return { ok: false, reason: "invalid", detail: "标题过长（上限 256 字）" };
  if (title === undefined && patch.body === undefined && patch.state === undefined) {
    return { ok: false, reason: "invalid", detail: "至少给一个要改的字段（title / body / state）" };
  }
  try {
    const records = await readRecords(workspaceDir);
    const record = records.find((item) => item.number === number);
    if (!record) return { ok: false, reason: "not-found", detail: `\`.deck/issues\` 里没有 #${number}` };
    const next: LocalRecord = {
      ...record,
      title: title ?? record.title,
      body: patch.body ?? record.body,
      state: patch.state === undefined ? record.state : patch.state === "closed" ? "CLOSED" : "OPEN",
      updatedAt: now(),
    };
    await writeRecord(workspaceDir, next);
    return { ok: true, title: next.title, body: next.body, state: next.state };
  } catch (error) {
    return failure(error);
  }
}

/** 本地后端没有登录账号，指派只能是明确的不支持，而不是悄悄写一个假名字。 */
export const localAssignUnsupported = (): LocalFailure => ({
  ok: false,
  reason: "invalid",
  detail: "本地 Markdown 后端没有登录账号，无法指派；请在 .deck/issues/ 里手动编辑 assignees",
});

/** 仅供测试：清掉进程内颜色快照，避免上一个临时目录的标签串味。 */
export function resetLocalColorCacheForTest(): void {
  colorCache.clear();
}
