import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ListView } from "../../shared/issues.ts";
import { parseDerivedFrom } from "../../shared/derived.ts";
import type { ContainerDirState, DeckRecord, LocalIssueKind, LocalLayout, LocalLayoutKind, ScratchComment } from "../../shared/local-layout.ts";
import {
  DECK_DIR, ISSUES_DIR, MAP_FILE, SCRATCH_DIR, SPEC_FILE, appendScratchComment, dedupeLabelNames, findIdempotentHit,
  layoutOf, nextTicketNumber, numberOfFile, parseDeckComments, parseDeckIssue, parseScratchComments, parseScratchRecord,
  planContainerDir, planIssuePath, renderDeckIssue, renderScratchRecord, replaceScratchBody, setScratchBlockedBy,
  setScratchLabels, setScratchParent, setScratchStatus, setScratchTitle, slugify, ticketFileNamesOf,
} from "../../shared/local-layout.ts";
import { hasCycleInAdj } from "../../shared/edge-rules.ts";
import type { LabelColorValue, LabelColorsRead, LocalTrackerState } from "./config.ts";
import { readLabelColorsConfig, readLocalTrackerState, stringifyLabelColors } from "./config.ts";
import type { Issue, IssueDetailResult, ListIssuesResult } from "./github.ts";
import { readinessOf } from "./readiness.ts";
import { containerKindOf } from "../../shared/container-kind.ts";

export { parseDeckIssue as parseLocalIssue };

/**
 * 本地 Markdown 后端：`.deck` 原文布局 + `.scratch` 目录布局。
 * 读两边都读；写只写一处（已有 `.deck` 写 `.deck`，否则用户显式初始化后才写 `.scratch`）。
 * 旧布局（工作区根 `issues/`、`.scratch/issues/`）只读；不自动迁移、不删除用户文件。
 * 标签配色的改写只产出计划（`plan` 字段），落盘由主线程在用户确认后执行。
 */

const DECK_ISSUES_DIR = ISSUES_DIR;
const LABELS_FILE = "labels.json";
const MAP_LABEL = "wayfinder:map";
const DEFAULT_COLOR = "cccccc";
const LOCAL_ISSUE_KINDS: readonly LocalIssueKind[] = ["map", "spec", "issue", "map-ticket", "spec-ticket"];
const DANGEROUS_LABELS = ["__proto__", "constructor", "prototype"];
const MAX_TITLE = 256, MAX_BODY = 60_000;

export type LocalFailure = { ok: false; reason: "invalid" | "local-failed" | "not-found"; detail: string };

const failure = (error: unknown): LocalFailure => ({
  ok: false, reason: "local-failed", detail: `读写本地 Markdown 失败：${error instanceof Error ? error.message : String(error)}`,
});

const invalid = (detail: string): LocalFailure => ({ ok: false, reason: "invalid", detail });

export const localRepoName = (workspaceDir: string): string => path.basename(path.resolve(workspaceDir)) || "workspace";

/* ------------------------------------------------------------------ 文件小工具 */

async function existsAs(target: string, kind: "dir" | "file"): Promise<boolean> {
  try {
    const info = await stat(target);
    return kind === "dir" ? info.isDirectory() : info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const dirExists = (target: string) => existsAs(target, "dir");
const fileExists = (target: string) => existsAs(target, "file");

async function readDirSafe(target: string): Promise<string[]> {
  try {
    return await readdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 临时文件与目标同目录再 rename：写完才出现，读者不会看到半份文件。 */
async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

/* ------------------------------------------------------------------ 写入队列 */

const writeChains = new Map<string, Promise<unknown>>();

function queueKey(text: string): string {
  return text.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 同一个键上的写串起来；前一个失败不影响后一个（失败也要放行队列）。 */
function withWriter<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  writeChains.set(key, next.then(() => undefined, () => undefined));
  return next;
}

const withWorkspaceWriter = <T>(workspaceDir: string, work: () => Promise<T>): Promise<T> =>
  withWriter(`workspace:${queueKey(workspaceDir)}`, work);

const withFileWriter = <T>(workspaceDir: string, file: string, work: () => Promise<T>): Promise<T> =>
  withWriter(`file:${queueKey(workspaceDir)}:${queueKey(file)}`, work);

/* ------------------------------------------------------------------ 数据结构 */

type LocalRecord = DeckRecord;

interface LocalEntry { path: string; layout: LocalLayoutKind; readOnly: boolean; record: LocalRecord }

interface ScratchUnit {
  /** `.scratch` 下的目录名；根级扁平布局用空串。 */
  name: string;
  dir: string;
  entries: string[];
  /** 根 `.scratch` 与 `issues/` 是 DSH 的旧布局，只读。 */
  legacy: boolean;
}

export interface LocalStoreState {
  workspaceDir: string; deckDir: string; scratchDir: string;
  deckActive: boolean; scratchActive: boolean;
  primary: LocalLayout; tracker: LocalTrackerState;
}

interface AllEntries {
  state: LocalStoreState;
  entries: LocalEntry[];
  byNumber: Map<number, LocalEntry>;
  /** 读不回来的票文件数：板子照常显示，但「清单是否完整」的判定必须知道它。 */
  unreadable: number;
}

const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

function hasWorkUnit(entries: readonly string[]): boolean {
  return entries.includes(MAP_FILE) || entries.includes(SPEC_FILE) || entries.includes(ISSUES_DIR);
}

async function listScratchUnits(scratchDir: string): Promise<ScratchUnit[]> {
  let dirents;
  try {
    dirents = await readdir(scratchDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // 读不了 `.scratch` 就如实报错：当成空目录会把用户的票藏起来。
    throw error;
  }
  const rootEntries = dirents.map((info) => info.name);
  const units: ScratchUnit[] = [];
  if (hasWorkUnit(rootEntries)) units.push({ name: "", dir: scratchDir, entries: rootEntries, legacy: true });
  for (const info of dirents) {
    if (!info.isDirectory() || info.name.startsWith(".")) continue;
    const dir = path.join(scratchDir, info.name);
    const entries = await readDirSafe(dir);
    if (hasWorkUnit(entries)) units.push({ name: info.name, dir, entries, legacy: false });
  }
  return units;
}

/** 工作区是否已经明确进入 `.scratch`：目录里有工作单元，或声明文件写明本地后端。 */
export async function resolveLocalStore(workspaceDir: string): Promise<LocalStoreState> {
  const deckDir = path.join(workspaceDir, DECK_DIR);
  const scratchDir = path.join(workspaceDir, SCRATCH_DIR);
  const deckActive = await dirExists(deckDir);
  const scratchExists = await dirExists(scratchDir);
  const trackerRead = await readLocalTrackerState(workspaceDir);
  if (!trackerRead.ok) throw new Error(trackerRead.detail);
  const units = scratchExists ? await listScratchUnits(scratchDir) : [];
  const scratchActive = scratchExists && (units.length > 0 || trackerRead.state.initialized);
  const primary = layoutOf(workspaceDir, deckActive || !scratchActive ? "deck" : "scratch");
  return { workspaceDir, deckDir, scratchDir, deckActive, scratchActive, primary, tracker: trackerRead.state };
}

/* ------------------------------------------------------------------ 读票 */

function scratchRecordOf(text: string, number: number, fileName: string, stamp: string): LocalRecord {
  const parsed = parseScratchRecord({ text, number, kind: "ticket", fileName, fallbackUpdatedAt: stamp });
  return { ...parsed, createdAt: parsed.createdAt || stamp, updatedAt: parsed.updatedAt || stamp, isMap: parsed.labels.includes(MAP_LABEL) };
}

/** 一次票文件扫描的结果：`skipped` 是读不回来的票文件数（坏文件不能让整块板失败，但必须被记住）。 */
interface TicketFileRead {
  entries: LocalEntry[];
  skipped: number;
}

async function readTicketFiles(issuesDir: string, readOnly: boolean): Promise<TicketFileRead> {
  const entries: LocalEntry[] = [];
  let skipped = 0;
  for (const name of ticketFileNamesOf(await readDirSafe(issuesDir))) {
    const number = numberOfFile(name);
    // 没有编号的文件（README、草稿）进不了数字票号模型：跳过，不猜一个号。
    if (number <= 0) continue;
    const target = path.join(issuesDir, name);
    try {
      const [text, info] = await Promise.all([readFile(target, "utf8"), stat(target)]);
      entries.push({ path: target, layout: "scratch", readOnly, record: scratchRecordOf(text, number, name, info.mtime.toISOString()) });
    } catch {
      // 单张票读不了不拖垮整块板：跳过它，其它票照常显示（与 .deck 的既有口径一致）。
      skipped += 1;
    }
  }
  return { entries, skipped };
}

async function readScratchTickets(units: readonly ScratchUnit[]): Promise<TicketFileRead> {
  const out: LocalEntry[] = [];
  let skipped = 0;
  for (const unit of units) {
    const read = await readTicketFiles(path.join(unit.dir, DECK_ISSUES_DIR), unit.legacy);
    out.push(...read.entries);
    skipped += read.skipped;
  }
  return { entries: out, skipped };
}

const readLegacyTickets = async (dir: string): Promise<TicketFileRead> =>
  ((await dirExists(dir)) ? readTicketFiles(dir, true) : { entries: [], skipped: 0 });

async function readDeckRecords(deckDir: string): Promise<TicketFileRead> {
  const issuesDir = path.join(deckDir, DECK_ISSUES_DIR);
  const entries: LocalEntry[] = [];
  let skipped = 0;
  for (const name of await readDirSafe(issuesDir)) {
    const match = /^(\d+)\.md$/.exec(name);
    if (!match) continue;
    const number = Number(match[1]);
    const target = path.join(issuesDir, name);
    try {
      const parsed = parseDeckIssue(await readFile(target, "utf8"), number);
      if (parsed) entries.push({ path: target, layout: "deck", readOnly: false, record: parsed });
      else skipped += 1;
    } catch {
      // 与旧实现一致：坏文件跳过，板子继续；但要计数，关容器时不能把残表当全集。
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/**
 * 双读：`.deck` + `.scratch` 工作单元 + 旧布局根 `issues/`。
 * 同号票按「主布局优先」只留一张：票号是整块板的身份，并列会让读写落错地方；被遮住的那份仍在盘上。
 */
async function readAllEntries(workspaceDir: string): Promise<AllEntries> {
  const state = await resolveLocalStore(workspaceDir);
  const units = await listScratchUnits(state.scratchDir);
  const seen = new Set<string>();
  const deckRead = await readDeckRecords(state.deckDir);
  const scratchRead = await readScratchTickets(units);
  const legacyRead = await readLegacyTickets(path.join(workspaceDir, DECK_ISSUES_DIR));
  const entries = [
    ...deckRead.entries,
    ...scratchRead.entries,
    ...legacyRead.entries,
  ].filter((entry) => {
    const key = queueKey(path.resolve(entry.path));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const priority = (entry: LocalEntry) => (entry.readOnly ? 2 : entry.layout === state.primary.kind ? 0 : 1);
  entries.sort((left, right) => priority(left) - priority(right) || left.record.number - right.record.number);
  const byNumber = new Map<number, LocalEntry>();
  for (const entry of entries) if (!byNumber.has(entry.record.number)) byNumber.set(entry.record.number, entry);
  return {
    state,
    entries: [...byNumber.values()],
    byNumber,
    unreadable: deckRead.skipped + scratchRead.skipped + legacyRead.skipped,
  };
}

async function locateEntry(workspaceDir: string, number: number): Promise<{ ok: true; entry: LocalEntry; state: LocalStoreState } | LocalFailure> {
  const all = await readAllEntries(workspaceDir);
  const entry = all.byNumber.get(number);
  if (!entry) return { ok: false, reason: "not-found", detail: `本地 Markdown 里没有 #${number}（.deck 与 .scratch 都读过了）` };
  return { ok: true, entry, state: all.state };
}

/* ------------------------------------------------------------------ 票面转换 */

function toIssue(record: LocalRecord, all: readonly LocalRecord[]): Issue {
  const blockedBy = record.blockedBy.map((number) => {
    const blocker = all.find((item) => item.number === number);
    return { number, title: blocker?.title ?? `#${number}`, state: blocker?.state ?? ("OPEN" as const), kind: "issue" as const };
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
    isMap: record.isMap === true || record.labels.includes(MAP_LABEL),
    containerKind: containerKindOf({ body: record.body, labels: record.labels.map((name) => ({ name })), isMap: record.isMap === true || record.labels.includes(MAP_LABEL) }),
    kind: "issue" as const,
    merged: false,
    blockedBy,
    ...(record.parentKey !== undefined ? { parentKey: record.parentKey } : {}),
    derivedFrom: parseDerivedFrom(record.body),
    body: record.body,
  };
  return { ...base, readiness: readinessOf(base) };
}

/* ------------------------------------------------------------------ 标签 */

interface LabelRecord {
  name: string;
  color: string;
  description: string;
}

export interface LocalLabelColorResult {
  ok: true;
  applied: { name: string; color: string }[];
  planned?: { name: string; color: string }[];
  failed: { name: string; detail: string }[];
  verified: { name: string; color: string }[];
  mismatched: { name: string; expected: string; actual: string }[];
  readbackFailed: boolean;
  plan?: { dryRun: true; path: string; text: string };
}

const colorCache = new Map<string, string>();

function normalizeColor(value: string): string {
  const text = String(value ?? "").trim().replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{6}$/.test(text) ? text : DEFAULT_COLOR;
}

function colorOf(name: string): string {
  return colorCache.get(name) ?? DEFAULT_COLOR;
}

async function readLabelCatalog(deckDir: string): Promise<LabelRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(deckDir, LABELS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 目录文件坏了只影响颜色，不影响票；按空目录继续，默认灰色。
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const record = item as { name?: unknown; color?: unknown; description?: unknown } | null;
    const name = asString(record?.name);
    if (!name) return [];
    return [{ name, color: normalizeColor(asString(record?.color, DEFAULT_COLOR) || DEFAULT_COLOR), description: asString(record?.description) }];
  });
}

async function writeLabelCatalog(deckDir: string, labels: readonly LabelRecord[]): Promise<void> {
  await writeAtomic(path.join(deckDir, LABELS_FILE), `${JSON.stringify(labels, null, 2)}\n`);
}

/** 合并 `.deck/labels.json` 与 `docs/agents/label-colors.yaml`；主布局的颜色优先。 */
async function refreshColorCache(workspaceDir: string, primary: LocalLayoutKind): Promise<LabelRecord[]> {
  const deckCatalog = await readLabelCatalog(path.join(workspaceDir, DECK_DIR));
  const docs = await readLabelColorsConfig(workspaceDir);
  const docLabels: LabelRecord[] = [];
  if (docs.ok && docs.present) {
    for (const [name, entry] of Object.entries(docs.config.colors)) {
      const value = typeof entry === "string" ? entry : entry.color;
      docLabels.push({ name, color: normalizeColor(value), description: typeof entry === "string" ? "" : (entry.description ?? "") });
    }
  }
  const groups = primary === "scratch" ? [docLabels, deckCatalog] : [deckCatalog, docLabels];
  const merged = new Map<string, LabelRecord>();
  for (const group of groups) for (const label of group) if (!merged.has(label.name)) merged.set(label.name, label);
  colorCache.clear();
  for (const [name, label] of merged) colorCache.set(name, label.color);
  return [...merged.values()];
}

function labelColorTable(docs: LabelColorsRead): Record<string, LabelColorValue> {
  const table = Object.create(null) as Record<string, LabelColorValue>;
  if (docs.ok && docs.present) for (const [name, entry] of Object.entries(docs.config.colors)) table[name] = entry;
  return table;
}

function planOnlyResult(docs: LabelColorsRead, normalized: readonly { name: string; color: string }[]): LocalLabelColorResult {
  const failed: { name: string; detail: string }[] = [];
  const planned: { name: string; color: string }[] = [];
  const none = (detail: string) => normalized.map((change) => ({ name: change.name, detail }));
  const result = (): LocalLabelColorResult => ({ ok: true, applied: [], planned, failed, verified: [], mismatched: [], readbackFailed: false });
  if (!docs.ok) return { ...result(), failed: none(`配色文件读不了：${docs.detail}`) };
  if (!docs.present) return { ...result(), failed: none("docs/agents/label-colors.yaml 不存在；这个后端不会替用户新建配色文件。") };
  if (docs.from !== "yaml") return { ...result(), failed: none("先完成 label-colors.json → label-colors.yaml 的迁移（迁移只给计划，不自动写）。") };
  if (docs.readonly) return { ...result(), failed: none("这份配色是更新的版本，只能读不能写。") };
  const table = labelColorTable(docs);
  for (const change of normalized) {
    if (!Object.prototype.hasOwnProperty.call(table, change.name)) {
      failed.push({ name: change.name, detail: "配色文件里没有这个标签；不会新建标签。" });
      continue;
    }
    const existing = table[change.name];
    table[change.name] = typeof existing === "string" ? change.color : { ...existing, color: change.color };
    planned.push(change);
  }
  if (planned.length === 0) return result();
  const encoded = stringifyLabelColors({ version: 1, colors: table });
  if (!encoded.ok) return { ...result(), planned: [], failed: [...failed, ...none(`配色拼装失败：${encoded.message}`)] };
  return { ...result(), plan: { dryRun: true, path: docs.path, text: encoded.text } };
}

/* ------------------------------------------------------------------ 列表 / 详情 */

export async function listLocalIssues(workspaceDir: string, options: { limit?: number; view?: ListView; includeClosed?: boolean } = {}): Promise<ListIssuesResult> {
  try {
    const all = await readAllEntries(workspaceDir);
    await refreshColorCache(workspaceDir, all.state.primary.kind);
    const records = all.entries.map((entry) => entry.record);
    const view = options.view ?? (options.includeClosed ? "all" : "open");
    const wanted = records.filter((record) => {
      if (view === "merged") return false;
      if (view === "closed") return record.state === "CLOSED";
      if (view === "all") return true;
      return record.state === "OPEN";
    });
    const sorted = [...wanted].sort((left, right) => {
      const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return Number.isNaN(byUpdated) || byUpdated === 0 ? right.number - left.number : byUpdated;
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
    return failure(error) as ListIssuesResult;
  }
}

async function readDeckComments(entry: LocalEntry): Promise<LocalComment[]> {
  try {
    return parseDeckComments(await readFile(entry.path.replace(/\.md$/, ".comments.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function commentsOf(entry: LocalEntry): Promise<LocalComment[]> {
  return entry.layout === "deck" ? readDeckComments(entry) : parseScratchComments(await readFile(entry.path, "utf8"));
}

export async function getLocalIssue(workspaceDir: string, number: number): Promise<IssueDetailResult> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  try {
    const all = await readAllEntries(workspaceDir);
    await refreshColorCache(workspaceDir, all.state.primary.kind);
    const entry = all.byNumber.get(number);
    if (!entry) return { ok: false, reason: "not-found", detail: `本地 Markdown 里没有 #${number}（.deck 与 .scratch 都读过了）` };
    const records = all.entries.map((item) => item.record);
    const comments = await commentsOf(entry);
    const issue = { ...toIssue(entry.record, records), body: entry.record.body };
    // 父子边：父票号只在能点回一张数字票时给；`00` 是 .scratch 的单元容器，不是可导航的票。
    const rawParent = entry.record.parentKey ?? "";
    const parentNumber = /^\d+$/.test(rawParent) && Number(rawParent) > 0 ? Number(rawParent) : null;
    const parentRecord = parentNumber === null ? undefined : all.byNumber.get(parentNumber)?.record;
    const parentIssue = parentRecord ? toIssue(parentRecord, records) : null;
    const parent = parentNumber === null
      ? null
      : {
          number: parentNumber,
          title: parentIssue?.title ?? `#${parentNumber}`,
          ...(parentIssue?.containerKind ? { containerKind: parentIssue.containerKind } : {}),
        };
    // 子票：只收显式 `DSH-PARENT` / `parentKey` 指向这张票的记录；容器票的 `00` 归属不在这里猜。
    const children = all.entries
      .filter((item) => item.record.parentKey === String(number))
      .map((item) => {
        const child = toIssue(item.record, records);
        return { number: child.number, title: child.title, state: child.state, kind: child.kind, containerKind: child.containerKind };
      });
    // 反向依赖：本地票面的 Blocked by 是显式列表，扫一遍就能给出「我阻塞了谁」。
    const blocking = all.entries
      .filter((item) => item.record.blockedBy.includes(number))
      .map((item) => {
        const blocked = toIssue(item.record, records);
        return { number: blocked.number, title: blocked.title, state: blocked.state, kind: "issue" as const };
      });
    return {
      ok: true,
      issue,
      comments,
      parent,
      // 本地每次都把全部票读出来了：空数组就是「确实没有子票」，不是「没查」。
      // 省略与空数组在关容器闸门里含义不同（省略 = 判不了，整笔拒绝）。
      children,
      childrenTotal: children.length,
      // 有票文件读不回来时，子票清单可能漏掉没关的那张：标成截断，关容器时整笔拒绝。
      childrenTruncated: all.unreadable > 0,
      blocking,
      meta: { labelCount: entry.record.labels.length, labelsTruncated: false, commentCount: comments.length, commentsTruncated: false, blockersTruncated: false },
    };
  } catch (error) {
    return failure(error) as IssueDetailResult;
  }
}

/** 容器（spec.md / map.md）不进数字票板；主线程用这个接口按名字读。 */
export interface LocalContainerRead {
  ok: true; kind: "spec" | "map"; name: string; path: string; title: string; body: string;
  labels: string[]; state: "OPEN" | "CLOSED"; readOnly: boolean; idempotencyKey: string;
}

export async function readLocalContainer(workspaceDir: string, kind: "spec" | "map", name?: string): Promise<LocalContainerRead | LocalFailure> {
  try {
    const file = kind === "spec" ? SPEC_FILE : MAP_FILE;
    const units = (await listScratchUnits(path.join(workspaceDir, SCRATCH_DIR))).filter((unit) => unit.entries.includes(file));
    if (name === undefined && units.length > 1) return invalid(`有多个目录含 ${file}（${units.map((item) => item.name || "(根)").join("、")}），请指定名字。`);
    const unit = name === undefined ? units[0] : units.find((item) => item.name === name);
    if (!unit) return { ok: false, reason: "not-found", detail: name === undefined ? `.scratch 里没有 ${file}` : `.scratch 里没有名为「${name}」且含 ${file} 的目录` };
    const target = path.join(unit.dir, file);
    const parsed = parseScratchRecord({ text: await readFile(target, "utf8"), number: 0, kind, fileName: file });
    return {
      ok: true,
      kind,
      name: unit.name,
      path: target,
      title: parsed.title,
      body: parsed.body,
      labels: parsed.labels,
      state: parsed.state,
      readOnly: unit.legacy,
      idempotencyKey: parsed.idempotencyKey,
    };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ 新建 */

export interface LocalCreateInput {
  title: string; body: string; labels: readonly string[];
  /** 省略等价于 issue；spec/map 建容器，map-ticket/spec-ticket 建子票。 */
  kind?: LocalIssueKind;
  /** 容器目录名（`.scratch/<feature>`）；`effort` 是地图语境的名字。 */
  feature?: string; effort?: string;
  parentKey?: string; idempotencyKey?: string;
  /** 建票时就带的指派与阻塞边（DSH 的 create 契约字段）；`.deck` 与 `.scratch` 都写在票面里。 */
  assignees?: readonly string[];
  blockedBy?: readonly number[];
}

export interface LocalCreateResult {
  ok: true; number: number; url: string; labels: string[];
  labelsFailed: boolean; path?: string; reused?: boolean;
}

async function createDeckIssue(state: LocalStoreState, input: LocalCreateInput): Promise<LocalCreateResult | LocalFailure> {
  // `.deck` 没有容器文件：map/spec 容器与实施票（spec-ticket）都建不出来；
  // 地图工单（map-ticket）与普通票一样是带 parentKey 的普通票，可以建。
  if (input.kind === "map" || input.kind === "spec") return invalid("spec/map 容器需要 .scratch 布局；这个工作区在写 .deck/。请先初始化 .scratch。");
  if (input.kind === "spec-ticket") return invalid(".deck 没有规格容器，实施票只能建在 .scratch 布局里。");
  if (input.idempotencyKey) return invalid("幂等键只在 .scratch 布局可用；.deck 的票号由递增序号生成，没有锚存储。");
  return withWorkspaceWriter(state.workspaceDir, async () => {
    const { entries } = await readDeckRecords(state.deckDir);
    const number = entries.reduce((max, entry) => Math.max(max, entry.record.number), 0) + 1;
    // 父子边写在文件头的 parentKey（`setLocalParent` 已按这个字段读写）；建票时一起带上，
    // 免得子票只在正文留一句 "Part of map #N"，机器读不回子票清单。
    const rawParent = input.parentKey === undefined || input.parentKey === null ? "" : String(input.parentKey).replace(/^#/, "");
    const parentNumber = rawParent === "" ? null : Number(rawParent);
    let parentRecord: LocalRecord | null = null;
    if (rawParent !== "") {
      if (!/^\d+$/.test(rawParent) || parentNumber === null || !Number.isInteger(parentNumber) || parentNumber <= 0) {
        return invalid(`父票号必须是正整数：#${rawParent}`);
      }
      parentRecord = entries.find((entry) => entry.record.number === parentNumber)?.record ?? null;
      if (!parentRecord) return invalid(`本地 Markdown 里没有父票 #${parentNumber}`);
      // 与 deck_issue_create 的契约一致：普通票 / 地图工单的父只能是地图（.deck 没有规格容器）。
      if (containerKindOf(parentRecord) !== "map") {
        return invalid(`父票 #${parentNumber} 不是探索地图（读到的是普通票）：地图工单的父必须是探索地图`);
      }
    }
    const labels = dedupeLabelNames(input.labels);
    const timestamp = new Date().toISOString();
    const record: LocalRecord = {
      number,
      title: input.title.trim(),
      state: "OPEN",
      labels,
      assignees: [...(input.assignees ?? [])],
      blockedBy: [...(input.blockedBy ?? [])],
      ...(parentNumber === null ? {} : { parentKey: String(parentNumber) }),
      createdAt: timestamp,
      updatedAt: timestamp,
      body: input.body,
    };
    await writeAtomic(path.join(state.deckDir, DECK_ISSUES_DIR, `${number}.md`), renderDeckIssue(record));
    return { ok: true, number, url: "", labels, labelsFailed: false, path: path.join(state.deckDir, DECK_ISSUES_DIR, `${number}.md`) };
  });
}

async function scratchCandidates(units: readonly ScratchUnit[]): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for (const unit of units) {
    for (const name of [SPEC_FILE, MAP_FILE]) {
      if (!unit.entries.includes(name)) continue;
      const target = path.join(unit.dir, name);
      files.push({ path: target, text: await readFile(target, "utf8") });
    }
    const issuesDir = path.join(unit.dir, DECK_ISSUES_DIR);
    for (const name of ticketFileNamesOf(await readDirSafe(issuesDir))) {
      const target = path.join(issuesDir, name);
      files.push({ path: target, text: await readFile(target, "utf8") });
    }
  }
  return files;
}

async function resolveTicketDir(state: LocalStoreState, units: readonly ScratchUnit[], kind: LocalIssueKind, input: LocalCreateInput): Promise<{ ok: true; dir: string; name: string } | LocalFailure> {
  const needed = kind === "spec-ticket" ? SPEC_FILE : kind === "map-ticket" ? MAP_FILE : "";
  const preferred = (input.effort ?? input.feature ?? "").trim();
  const writable = units.filter((unit) => !unit.legacy);
  const existing: ContainerDirState[] = units.map((unit) => ({ name: unit.name, entries: unit.entries }));
  if (preferred) {
    const unit = units.find((item) => item.name === preferred);
    if (unit) {
      if (unit.legacy) return invalid("旧布局的目录只读，不在里面建票。");
      if (needed && !unit.entries.includes(needed)) return invalid(`目录「${preferred}」里没有 ${needed}：先建容器，再建子票。`);
      return { ok: true, dir: unit.dir, name: unit.name };
    }
    if (needed) return invalid(`没有名为「${preferred}」且含 ${needed} 的目录。`);
    const plan = planContainerDir({ scratchRoot: state.scratchDir, kind: "issue", title: input.title, existing, preferredName: preferred });
    return plan.ok ? { ok: true, dir: plan.path, name: plan.name } : invalid(plan.detail);
  }
  if (needed) {
    const found = writable.filter((unit) => unit.entries.includes(needed));
    if (found.length === 1 && found[0]) return { ok: true, dir: found[0].dir, name: found[0].name };
    if (found.length === 0) return invalid(`没有含 ${needed} 的目录：先建 ${kind === "spec-ticket" ? "spec" : "map"} 容器。`);
    return invalid(`有多个目录含 ${needed}（${found.map((item) => item.name).join("、")}），请用 feature/effort 指定。`);
  }
  if (writable.length === 1 && writable[0]) return { ok: true, dir: writable[0].dir, name: writable[0].name };
  const plan = planContainerDir({ scratchRoot: state.scratchDir, kind: "issue", title: input.title, existing });
  return plan.ok ? { ok: true, dir: plan.path, name: plan.name } : invalid(plan.detail);
}

async function createScratchContainer(state: LocalStoreState, units: readonly ScratchUnit[], kind: "spec" | "map", input: LocalCreateInput): Promise<LocalCreateResult | LocalFailure> {
  const preferred = (kind === "spec" ? input.feature : input.effort)?.trim() || input.feature?.trim() || input.effort?.trim();
  const existing: ContainerDirState[] = units.map((unit) => ({ name: unit.name, entries: unit.entries }));
  const plan = planContainerDir({ scratchRoot: state.scratchDir, kind, title: input.title, existing, preferredName: preferred });
  if (!plan.ok) return invalid(plan.detail);
  const file = kind === "spec" ? SPEC_FILE : MAP_FILE;
  const target = path.join(plan.path, file);
  if (await fileExists(target)) return invalid(`目录「${plan.name}」里已经有 ${file}；不覆盖原文件。`);
  const labels = dedupeLabelNames(input.labels);
  const text = renderScratchRecord({
    kind,
    number: 0,
    title: input.title.trim(),
    body: input.body,
    labels,
    assignees: input.assignees,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date().toISOString(),
  });
  await writeAtomic(target, text);
  return { ok: true, number: 0, url: "", labels, labelsFailed: false, path: target };
}

async function createScratchIssue(state: LocalStoreState, input: LocalCreateInput): Promise<LocalCreateResult | LocalFailure> {
  const kind = input.kind ?? "issue";
  return withWorkspaceWriter(state.workspaceDir, async () => {
    const units = await listScratchUnits(state.scratchDir);
    const key = input.idempotencyKey?.trim() ?? "";
    if (key && (key.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(key))) return invalid("幂等键只能是字母、数字与 . _ : / -，上限 200 字。");
    if (key) {
      const files = await scratchCandidates(units);
      const hit = findIdempotentHit({ kind, files, idempotencyKey: key });
      if (hit) {
        const text = files.find((file) => file.path === hit.path)?.text ?? "";
        const parsed = parseScratchRecord({ text, number: hit.number, kind: kind === "spec" ? "spec" : kind === "map" ? "map" : "ticket" });
        return { ok: true, number: hit.number, url: "", labels: parsed.labels, labelsFailed: false, path: hit.path, reused: true };
      }
    }
    if (kind === "spec" || kind === "map") return createScratchContainer(state, units, kind, input);
    const target = await resolveTicketDir(state, units, kind, input);
    if (!target.ok) return target;
    const issuesDir = path.join(target.dir, DECK_ISSUES_DIR);
    const names = await readDirSafe(issuesDir);
    const number = nextTicketNumber(names);
    const targetPath = planIssuePath({ layout: { root: target.dir, kind: "scratch" }, kind, title: input.title, number, existing: names }).path;
    const labels = dedupeLabelNames(input.labels);
    const parentKey = kind === "spec-ticket" || kind === "map-ticket" ? (input.parentKey ?? "00") : input.parentKey;
    const text = renderScratchRecord({
      kind: "ticket",
      number,
      title: input.title.trim(),
      body: input.body,
      labels,
      assignees: input.assignees,
      blockedBy: input.blockedBy,
      parentKey,
      idempotencyKey: key || undefined,
      createdAt: new Date().toISOString(),
      mapTicket: kind === "map-ticket",
    });
    await writeAtomic(targetPath, text);
    return { ok: true, number, url: "", labels, labelsFailed: false, path: targetPath };
  });
}

export async function createLocalIssue(workspaceDir: string, input: LocalCreateInput): Promise<LocalCreateResult | LocalFailure> {
  const title = input.title.trim();
  if (!title) return invalid("标题不能为空");
  if (title.length > MAX_TITLE) return invalid(`标题过长（上限 ${MAX_TITLE} 字）`);
  if (input.body.length > MAX_BODY) return invalid(`正文过长（上限 ${MAX_BODY} 字）`);
  if (input.kind !== undefined && !LOCAL_ISSUE_KINDS.includes(input.kind)) return invalid(`不认识的票类型：${input.kind}`);
  try {
    const state = await resolveLocalStore(workspaceDir);
    if (state.primary.kind === "deck") return await createDeckIssue(state, input);
    return await createScratchIssue(state, input);
  } catch (error) {
    return failure(error);
  }
}

/**
 * 显式初始化 `.scratch`：建一个可写的票目录。只在用户主动触发时调用；
 * 读路径永远不会走到这里（新建工作区默认仍是 `.deck`）。
 */
export async function initializeLocalScratch(workspaceDir: string, input: { name: string }): Promise<{ ok: true; path: string; name: string; created: boolean; primary: LocalLayoutKind; notice: string } | LocalFailure> {
  const raw = String(input?.name ?? "").trim();
  if (!raw) return invalid("初始化 .scratch 需要给一个目录名（例如 backlog）");
  if (raw.includes("/") || raw.includes("\\") || raw.startsWith(".")) return invalid("目录名不能带路径分隔符，也不能以点开头。");
  try {
    return await withWorkspaceWriter(workspaceDir, async () => {
      const name = slugify(raw);
      const target = path.join(workspaceDir, SCRATCH_DIR, name);
      const created = !(await dirExists(target));
      await mkdir(path.join(target, DECK_ISSUES_DIR), { recursive: true });
      const state = await resolveLocalStore(workspaceDir);
      return {
        ok: true as const,
        path: target,
        name,
        created,
        primary: state.primary.kind,
        notice: state.primary.kind === "deck" ? "工作区已有 .deck，新票仍写 .deck；.scratch 只并行读取。" : ".scratch 已就绪，新票会写到这里。",
      };
    });
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ 写票 */

export type LocalComment = ScratchComment;

function deckRecordOrThrow(text: string, number: number): LocalRecord {
  const record = parseDeckIssue(text, number);
  if (!record) throw new Error(`.deck 里 #${number} 的票面已经不在了`);
  return record;
}

async function updateEntry(
  workspaceDir: string,
  number: number,
  update: (entry: LocalEntry, text: string) => Promise<string | false>,
): Promise<{ ok: true; state: LocalStoreState } | LocalFailure> {
  const located = await locateEntry(workspaceDir, number);
  if (!located.ok) return located;
  if (located.entry.readOnly) return invalid("旧布局的票只读，不改原文件。");
  await withFileWriter(workspaceDir, located.entry.path, async () => {
    const next = await update(located.entry, await readFile(located.entry.path, "utf8"));
    if (next !== false) await writeAtomic(located.entry.path, next);
  });
  return { ok: true, state: located.state };
}

export async function postLocalComment(workspaceDir: string, number: number, body: string): Promise<{ ok: true; comment: LocalComment } | LocalFailure> {
  if (!body.trim()) return invalid("评论内容不能为空");
  try {
    const comment = { author: "local", createdAt: new Date().toISOString(), body };
    const updated = await updateEntry(workspaceDir, number, async (entry, text) => {
      if (entry.layout === "scratch") return appendScratchComment(text, comment);
      const comments = await readDeckComments(entry);
      await writeAtomic(entry.path.replace(/\.md$/, ".comments.json"), `${JSON.stringify([...comments, comment], null, 2)}\n`);
      await writeAtomic(entry.path, renderDeckIssue({ ...deckRecordOrThrow(text, number), updatedAt: comment.createdAt }));
      return false;
    });
    return updated.ok ? { ok: true, comment } : updated;
  } catch (error) {
    return failure(error);
  }
}

export async function replaceLocalLabels(workspaceDir: string, number: number, labels: readonly string[]): Promise<{ ok: true; labels: { name: string; color: string }[] } | LocalFailure> {
  try {
    const wanted = dedupeLabelNames(labels);
    const updated = await updateEntry(workspaceDir, number, async (entry, text) => {
      if (entry.layout === "scratch") return setScratchLabels(text, wanted);
      await writeAtomic(entry.path, renderDeckIssue({ ...deckRecordOrThrow(text, number), labels: wanted, updatedAt: new Date().toISOString() }));
      return false;
    });
    if (!updated.ok) return updated;
    await refreshColorCache(workspaceDir, updated.state.primary.kind);
    return { ok: true, labels: wanted.map((name) => ({ name, color: colorOf(name) })) };
  } catch (error) {
    return failure(error);
  }
}

export async function setLocalIssueState(workspaceDir: string, number: number, state: "open" | "closed"): Promise<{ ok: true; state: "OPEN" | "CLOSED" } | LocalFailure> {
  try {
    const next = state === "closed" ? ("CLOSED" as const) : ("OPEN" as const);
    const updated = await updateEntry(workspaceDir, number, async (entry, text) => {
      if (entry.layout === "scratch") return setScratchStatus(text, next === "CLOSED");
      await writeAtomic(entry.path, renderDeckIssue({ ...deckRecordOrThrow(text, number), state: next, updatedAt: new Date().toISOString() }));
      return false;
    });
    return updated.ok ? { ok: true, state: next } : updated;
  } catch (error) {
    return failure(error);
  }
}

/** `.scratch` 票所在的工作单元目录（`<unit>/issues/NN.md` → `<unit>`）。 */
function scratchUnitOf(entry: LocalEntry): string {
  return path.dirname(path.dirname(entry.path));
}

/**
 * 父子边：写文件头（`.scratch` 的 DSH-PARENT / `.deck` 的 parentKey）。
 *
 * DSH 的父子边只在一个工作单元内成立：子票和父票必须落在同一个 `.scratch/<unit>`；
 * `parentKey=00` 指该单元的地图/规格容器（地图文件本身没有父票）。
 * 写入后重新读盘核对，读回不一致按失败报，不拿写动作的返回当证据。
 */
export async function setLocalParent(workspaceDir: string, number: number, parentKey: string | null): Promise<{ ok: true; parentKey: string | null; layout: LocalLayoutKind } | LocalFailure> {
  const parent = parentKey === null || parentKey === "" ? null : Number(String(parentKey).replace(/^#/, ""));
  if (parentKey !== null && parentKey !== "" && (!Number.isInteger(parent) || (parent as number) <= 0) && String(parentKey) !== "00") {
    return invalid(`父票号必须是正整数或 00：${String(parentKey)}`);
  }
  if (parent !== null && parent === number) return invalid("一张票不能以自己为父票");
  try {
    const located = await locateEntry(workspaceDir, number);
    if (!located.ok) return located;
    const entry = located.entry;
    const all = await readAllEntries(workspaceDir);

    let stored: string | null = parent === null ? null : String(parentKey);
    if (entry.layout === "scratch") {
      const unit = scratchUnitOf(entry);
      if (parent === 0 || String(parentKey) === "00") {
        const hasContainer = (await existsAs(path.join(unit, MAP_FILE), "file")) || (await existsAs(path.join(unit, SPEC_FILE), "file"));
        if (!hasContainer) return invalid(`这个工作单元里没有 ${MAP_FILE} / ${SPEC_FILE}，父票 00 无从查起`);
        stored = "00";
      } else if (parent !== null) {
        const target = all.byNumber.get(parent);
        if (!target) return { ok: false, reason: "not-found", detail: `本地 Markdown 里没有父票 #${parent}` };
        if (target.layout !== "scratch" || scratchUnitOf(target) !== unit) {
          return invalid(`父票 #${parent} 不在同一个工作单元里：跨目录的父子边不支持`);
        }
        stored = String(parent);
      }
    } else if (parent !== null && !all.byNumber.has(parent)) {
      return { ok: false, reason: "not-found", detail: `本地 Markdown 里没有父票 #${parent}` };
    }

    const updated = await updateEntry(workspaceDir, number, async (current, text) => {
      if (current.layout === "scratch") return setScratchParent(text, stored);
      await writeAtomic(current.path, renderDeckIssue({ ...deckRecordOrThrow(text, number), parentKey: stored, updatedAt: new Date().toISOString() }));
      return false;
    });
    if (!updated.ok) return updated;

    const back = await locateEntry(workspaceDir, number);
    if (!back.ok) return { ok: false, reason: "local-failed", detail: `写后读回 #${number} 失败：${back.detail}` };
    const actual = back.entry.record.parentKey === undefined || back.entry.record.parentKey === null ? null : String(back.entry.record.parentKey);
    const expected = stored === null ? null : stored === "00" ? "00" : String(Number(stored));
    if (actual !== expected) {
      return { ok: false, reason: "local-failed", detail: `写后读回的父票是 ${actual ?? "空"}，要的是 ${stored ?? "空"}` };
    }
    return { ok: true, parentKey: stored, layout: entry.layout };
  } catch (error) {
    return failure(error);
  }
}

/**
 * 阻塞边：整批替换语义，写隐藏注释与可见行；写入前后都核对读回的集合。
 *
 * 自环先拒；跨票成环由调用方（`deck_map_link`）先做整批预检，
 * 这里仍按「这一张票 + 现有图」再查一次，避免绕过工具直接调用时留下环。
 */
export async function setLocalBlockedBy(workspaceDir: string, number: number, blockers: readonly number[]): Promise<{ ok: true; blockedBy: number[]; layout: LocalLayoutKind } | LocalFailure> {
  const wanted = [...new Set(blockers.map((value) => Number(value)))];
  if (wanted.some((value) => !Number.isInteger(value) || value <= 0)) return invalid("阻塞者票号必须是正整数");
  if (wanted.includes(number)) return invalid("一张票不能阻塞自己");
  try {
    const all = await readAllEntries(workspaceDir);
    if (!all.byNumber.has(number)) return { ok: false, reason: "not-found", detail: `本地 Markdown 里没有 #${number}` };
    for (const target of wanted) {
      if (!all.byNumber.has(target)) return { ok: false, reason: "not-found", detail: `本地 Markdown 里没有阻塞者 #${target}` };
    }
    const graph = new Map<string, readonly string[]>();
    for (const entry of all.entries) graph.set(String(entry.record.number), entry.record.blockedBy.map(String));
    graph.set(String(number), wanted.map(String));
    if (hasCycleInAdj(graph)) return invalid("这次阻塞会形成环（沿着阻塞关系最终绕回这张票），没有写入");

    const updated = await updateEntry(workspaceDir, number, async (entry, text) => {
      if (entry.layout === "scratch") return setScratchBlockedBy(text, wanted);
      await writeAtomic(entry.path, renderDeckIssue({ ...deckRecordOrThrow(text, number), blockedBy: wanted, updatedAt: new Date().toISOString() }));
      return false;
    });
    if (!updated.ok) return updated;

    const back = await locateEntry(workspaceDir, number);
    if (!back.ok) return { ok: false, reason: "local-failed", detail: `写后读回 #${number} 失败：${back.detail}` };
    const actual = [...back.entry.record.blockedBy].sort((left, right) => left - right);
    const expected = [...wanted].sort((left, right) => left - right);
    if (actual.join(",") !== expected.join(",")) {
      return { ok: false, reason: "local-failed", detail: `写后读回的阻塞边是 ${actual.join("、") || "空"}，要的是 ${expected.join("、")}` };
    }
    return { ok: true, blockedBy: wanted, layout: all.byNumber.get(number)?.layout ?? "deck" };
  } catch (error) {
    return failure(error);
  }
}

export async function patchLocalIssue(workspaceDir: string, number: number, patch: { title?: string; body?: string; state?: "open" | "closed" }): Promise<{ ok: true; title: string; body: string; state: "OPEN" | "CLOSED" } | LocalFailure> {
  const title = patch.title?.trim();
  if (title !== undefined && !title) return invalid("标题不能为空");
  if (title !== undefined && title.length > MAX_TITLE) return invalid(`标题过长（上限 ${MAX_TITLE} 字）`);
  if (patch.body !== undefined && patch.body.length > MAX_BODY) return invalid(`正文过长（上限 ${MAX_BODY} 字）`);
  if (title === undefined && patch.body === undefined && patch.state === undefined) return invalid("至少给一个要改的字段（title / body / state）");
  try {
    let finalTitle = "";
    let finalBody = "";
    let finalState: "OPEN" | "CLOSED" = "OPEN";
    const updated = await updateEntry(workspaceDir, number, async (entry, text) => {
      finalTitle = title ?? entry.record.title;
      finalBody = patch.body ?? entry.record.body;
      finalState = patch.state === undefined ? entry.record.state : patch.state === "closed" ? "CLOSED" : "OPEN";
      if (entry.layout === "scratch") {
        let next = text;
        if (title !== undefined) next = setScratchTitle(next, title);
        if (patch.body !== undefined) next = replaceScratchBody(next, patch.body, "ticket");
        if (patch.state !== undefined) next = setScratchStatus(next, finalState === "CLOSED");
        return next;
      }
      await writeAtomic(entry.path, renderDeckIssue({ ...deckRecordOrThrow(text, number), title: finalTitle, body: finalBody, state: finalState, updatedAt: new Date().toISOString() }));
      return false;
    });
    return updated.ok ? { ok: true, title: finalTitle, body: finalBody, state: finalState } : updated;
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ 标签目录 */

export async function listLocalLabels(workspaceDir: string): Promise<{ ok: true; labels: LabelRecord[] } | LocalFailure> {
  try {
    const all = await readAllEntries(workspaceDir);
    const catalog = await refreshColorCache(workspaceDir, all.state.primary.kind);
    const used = new Set<string>();
    for (const entry of all.entries) for (const name of entry.record.labels) used.add(name);
    const merged = new Map(catalog.map((label) => [label.name, label]));
    for (const name of used) if (!merged.has(name)) merged.set(name, { name, color: DEFAULT_COLOR, description: "" });
    return { ok: true, labels: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)) };
  } catch (error) {
    return failure(error);
  }
}

export async function setLocalLabelColors(workspaceDir: string, changes: readonly { name: string; color: string }[]): Promise<LocalLabelColorResult | LocalFailure> {
  const normalized = changes.map((change) => ({ name: change.name.trim(), color: change.color.replace(/^#/, "").toLowerCase() }));
  const invalidChanges = normalized.filter((change) => !change.name || !/^[0-9a-f]{6}$/.test(change.color) || DANGEROUS_LABELS.includes(change.name));
  if (invalidChanges.length) return invalid(`颜色必须是 6 位十六进制，标签名不能是保留字：${invalidChanges.map((item) => item.name || "(空)").join("、")}`);
  try {
    const state = await resolveLocalStore(workspaceDir);
    if (state.primary.kind === "scratch") {
      // `.scratch` 布局的配色归 docs/agents/label-colors.yaml：只出计划，不落盘。
      const docs = await readLabelColorsConfig(workspaceDir);
      if (!docs.ok && docs.reason === "read-failed") return failure(docs.detail);
      return planOnlyResult(docs, normalized);
    }
    const catalog = await readLabelCatalog(state.deckDir);
    const next = new Map(catalog.map((label) => [label.name, label]));
    for (const change of normalized) next.set(change.name, { name: change.name, color: change.color, description: next.get(change.name)?.description ?? "" });
    await withWorkspaceWriter(workspaceDir, async () => writeLabelCatalog(state.deckDir, [...next.values()]));
    const readback = await listLocalLabels(workspaceDir);
    if (!readback.ok) return { ok: true, applied: normalized, planned: normalized, failed: [], verified: [], mismatched: [], readbackFailed: true };
    const actual = new Map(readback.labels.map((label) => [label.name, label.color]));
    const mismatched = normalized.filter((change) => actual.get(change.name) !== change.color).map((change) => ({ name: change.name, expected: change.color, actual: actual.get(change.name) ?? "" }));
    return { ok: true, applied: normalized, planned: normalized, failed: [], verified: normalized.filter((change) => actual.get(change.name) === change.color), mismatched, readbackFailed: false };
  } catch (error) {
    return failure(error);
  }
}

/** 本地后端没有登录账号，指派只能是明确的不支持，而不是悄悄写一个假名字。 */
export const localAssignUnsupported = (): LocalFailure => ({
  ok: false,
  reason: "invalid",
  detail: "本地 Markdown 后端没有登录账号，无法指派；请直接编辑票文件里的 assignees。",
});

/** 仅供测试：清掉进程内颜色快照，避免上一个临时目录的标签串味。 */
export function resetLocalColorCacheForTest(): void {
  colorCache.clear();
}
