import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DECK_DIR } from "../shared/local-layout.ts";

/**
 * 协调收件箱：`<工作区>/.deck/coordination.jsonl`，一行一条。
 *
 * 三种 kind 共用一份文件，因为人只有一双眼睛；分成三个文件，最后一定有两个没人打开。
 * 用 JSONL 而不是 JSON 数组：追加最便宜，坏一行也只丢一行。
 * 状态迁移走「读全量 → 换掉目标那条 → 原子重写」；原地改一行会因长度变化截断后面的
 * 内容。单写者前提下够用，并发读者按行解析 + 跳过坏行，最多丢一行而不是整份。
 */

export const COORDINATION_FILE = "coordination.jsonl";
/** 24 小时没人处置就自动取消。通道不能只靠人自觉。 */
export const COORDINATION_TTL_MS = 24 * 60 * 60 * 1000;
export const COORDINATION_KINDS = ["territory", "staffing", "contract", "lineage"] as const;
export const COORDINATION_STATES = [
  "pending", "approved-once", "consumed", "reassigned", "denied", "staffed",
  "declined", "contract-changed", "impl-changed", "superseded", "cancelled",
  // lineage 是只记不办的账：落一条「子 → 父」后就是终态，不进收件箱、不会被清扫。
  "recorded",
] as const;

export type CoordinationKind = (typeof COORDINATION_KINDS)[number];
export type CoordinationState = (typeof COORDINATION_STATES)[number];
/** `need` 只属于 staffing，`field` 只属于 contract；出现在别的 kind 上算坏记录。 */
export interface CoordinationRecord {
  at: string; kind: CoordinationKind; workspaceId: string; fromStaff: string;
  toStaff: string | null; paths: string[]; sessionAgentId: string; taskSummary: string;
  need?: string; field?: string; state: CoordinationState;
}

export interface CoordinationReadResult {
  records: CoordinationRecord[];
  /** 解析失败或形状不合法的行数；空行不算。 */
  skipped: number;
  /** 读文件本身失败（权限 / IO，非 ENOENT）；此时不能拿它做读-改-写。 */
  failed?: string;
}

export interface CoordinationPathTarget { path: string; toStaff: string | null }

export interface CoordinationRequestInput {
  kind: CoordinationKind; workspaceId: string; fromStaff: string;
  sessionAgentId: string; taskSummary: string;
  /** 缺省为当前时间；测试里显式传入。 */
  at?: string;
  /** 仅 staffing / 仅 contract。 */
  need?: string; field?: string;
  /** 一批路径共用一个目标区；entries 里每条路径可各自不同。 */
  toStaff?: string | null; entries?: readonly CoordinationPathTarget[];
  paths?: readonly string[];
  /**
   * 权限闸专用：把同键更早 pending 的路径并进来再覆盖。读取与写入在同一把锁内，
   * 并发的两次越界不会各自覆盖、把对方路径弄丢。
   */
  mergePendingPaths?: boolean;
}

export type CoordinationTransitionResult =
  | { ok: true; record: CoordinationRecord; reason?: string } | { ok: false; detail: string };
export type CoordinationRequestResult =
  | { ok: true; records: CoordinationRecord[]; superseded: number; file: string } | { ok: false; detail: string };
export type CoordinationSweepResult =
  | { ok: true; records: CoordinationRecord[]; cancelled: number; reason: string } | { ok: false; detail: string };

/** 目标可以是下标，也可以是选择器（RPC handler 通常拿到的是记录下标）。 */
export type CoordinationRef = number | ((record: CoordinationRecord, index: number) => boolean);

/* ------------------------------------------------------------------ 路径 */

function foldSegments(input: string): string {
  const leading = input.startsWith("/");
  const parts: string[] = [];
  for (const segment of input.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      const top = parts[parts.length - 1];
      if (top !== undefined && top !== "..") parts.pop();
      else if (!leading) parts.push("..");
      continue;
    }
    parts.push(segment);
  }
  return `${leading ? "/" : ""}${parts.join("/")}` || ".";
}

/**
 * 归一化到「相对工作区根」：反斜杠转 `/`、折叠 `.` / `..`。
 * 审批粒度是（会话，归一化路径），不统一写法，批准过的那次永远匹配不上下一次。
 * 大小写不在这里折叠：spec 要求按文件系统实际值，那需要 stat。
 */
export function normalizeCoordinationPath(workspaceDir: string, rawPath: string): string {
  const raw = String(rawPath ?? "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  let relative = raw;
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    const root = path.resolve(workspaceDir).replace(/\\/g, "/").replace(/\/+$/, "");
    const lowerRoot = root.toLowerCase(), lowerRaw = raw.toLowerCase();
    if (lowerRaw === lowerRoot) relative = "";
    else if (lowerRaw.startsWith(`${lowerRoot}/`)) relative = raw.slice(root.length + 1);
    // 工作区外的绝对路径原样保留（带前导 `/`），不假装它在工作区里。
  }
  return foldSegments(relative);
}

export function normalizeCoordinationPaths(workspaceDir: string, paths: readonly string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const value of paths) {
    const normalized = normalizeCoordinationPath(workspaceDir, value);
    if (normalized && !seen.has(normalized)) { seen.add(normalized); out.push(normalized); }
  }
  return out;
}

/* ------------------------------------------------------------------ 文件 */

export function coordinationFileOf(workspaceDir: string): string {
  return path.join(workspaceDir, DECK_DIR, COORDINATION_FILE);
}

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** 单行解析。任何一项不合法都返回 null，由调用方计数并跳过。 */
function parseRecord(value: unknown): CoordinationRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isOneOf(raw.kind, COORDINATION_KINDS) || !isOneOf(raw.state, COORDINATION_STATES)) return null;
  if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) return null;
  for (const key of ["workspaceId", "fromStaff", "sessionAgentId", "taskSummary"]) {
    if (typeof raw[key] !== "string") return null;
  }
  if (!Array.isArray(raw.paths) || raw.paths.some((item) => typeof item !== "string")) return null;
  if (raw.toStaff !== null && typeof raw.toStaff !== "string") return null;
  const need = raw.need === undefined ? undefined : typeof raw.need === "string" ? raw.need : null;
  const field = raw.field === undefined ? undefined : typeof raw.field === "string" ? raw.field : null;
  if (need === null || (need !== undefined && raw.kind !== "staffing")) return null;
  if (field === null || (field !== undefined && raw.kind !== "contract")) return null;
  return {
    at: raw.at, kind: raw.kind, workspaceId: raw.workspaceId as string,
    fromStaff: raw.fromStaff as string, toStaff: raw.toStaff,
    paths: [...(raw.paths as string[])], sessionAgentId: raw.sessionAgentId as string,
    taskSummary: raw.taskSummary as string,
    ...(need !== undefined ? { need } : {}), ...(field !== undefined ? { field } : {}),
    state: raw.state,
  };
}

export async function readCoordination(workspaceDir: string): Promise<CoordinationReadResult> {
  const file = coordinationFileOf(workspaceDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
    return { records: [], skipped: 0, failed: `读取 ${COORDINATION_FILE} 失败：${String(error)}` };
  }
  const records: CoordinationRecord[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue; // 末尾换行与人为空行不是坏行
    try {
      const record = parseRecord(JSON.parse(line) as unknown);
      if (record) records.push(record);
      else skipped += 1;
    } catch { skipped += 1; }
  }
  return { records, skipped };
}

/** 整份原子重写：同目录临时文件再 rename，读者不会看到写了一半的收件箱。 */
async function writeAll(workspaceDir: string, records: readonly CoordinationRecord[]): Promise<void> {
  const file = coordinationFileOf(workspaceDir);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const text = records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, text, "utf8");
  await rename(temp, file);
}

/**
 * 同一进程里 RPC 与 MCP 调用可能交错；虽然约定「单写者」，但读-改-写不串行时
 * 后写者会拿旧基线覆盖前者。按文件路径挂一条 promise 链，成本很低。
 */
const writeChains = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(workspaceDir: string, task: () => Promise<T>): Promise<T> {
  const file = path.resolve(coordinationFileOf(workspaceDir));
  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(file, next);
  const cleanup = () => { if (writeChains.get(file) === next) writeChains.delete(file); };
  void next.then(cleanup, cleanup);
  return next;
}

/** 真追加一行（目录不存在就创建）。调用方负责在写链里调用。 */
async function appendLine(workspaceDir: string, record: CoordinationRecord): Promise<void> {
  const file = coordinationFileOf(workspaceDir);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * 追加一条；目录不存在就创建，返回归一化后的记录（就是文件里那一行）。
 * 形状不合法直接抛错——这是程序写错了，不能静默塞进收件箱。
 */
export function appendCoordination(
  workspaceDir: string,
  record: CoordinationRecord,
): Promise<CoordinationRecord> {
  return enqueueWrite(workspaceDir, async () => {
    const parsed = parseRecord(record);
    if (!parsed) throw new Error("协调记录无效：kind / state / at / 必填字段或 need、field 的归属不合法");
    const normalized = { ...parsed, paths: normalizeCoordinationPaths(workspaceDir, parsed.paths) };
    await appendLine(workspaceDir, normalized);
    return normalized;
  });
}

/* ------------------------------------------------------------------ 血缘 */

export interface LineageInput {
  /** 子会话所在的区；`agent.created` 里就是 `agent.workspaceId`。 */
  workspaceId: string;
  childAgentId: string;
  parentAgentId: string;
  /** 缺省为当前时间；测试里显式传入。 */
  at?: string;
  /** 保留策略，缺省见 `LINEAGE_MAX_RECORDS` / `LINEAGE_MAX_AGE_MS`；测试里显式传入。 */
  retention?: LineagePruneOptions;
}

/** 血缘只留最近这么多条：一次子会话创建一行，不封顶就是只增不减的账。 */
export const LINEAGE_MAX_RECORDS = 500;
/** 血缘最多留这么久：更早的父子链已经查不到对应会话，留着只会撑大文件。 */
export const LINEAGE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface LineagePruneOptions {
  maxRecords?: number;
  maxAgeMs?: number;
  /** 测试注入；缺省当前时间。 */
  now?: Date | number | string;
}

/** 收件箱会给这两种状态出动作按钮，人手里的下标必须仍然指向同一条记录。 */
const ACTIONABLE_STATES: readonly CoordinationState[] = ["pending", "approved-once"];

/** 保留策略的边界校验：非负整数 / 非负数 / 有效时间，返回第一处问题的说明。 */
function pruneOptionProblem(options: LineagePruneOptions): string | null {
  if (options.maxRecords !== undefined && (!Number.isInteger(options.maxRecords) || options.maxRecords < 0)) {
    return "maxRecords 必须是非负整数";
  }
  if (options.maxAgeMs !== undefined && (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0)) {
    return "maxAgeMs 必须是非负数";
  }
  if (options.now !== undefined && !Number.isFinite(toMillis(options.now))) return "now 不是有效时间";
  return null;
}

/**
 * 纯裁剪：非血缘原样保留，血缘只留「最近 `maxRecords` 条且不过 `maxAgeMs`」。
 *
 * 两条约束写在实现里而不是注释里：
 * - 只删 `kind: "lineage"`。越界 / 要人手 / 契约那三种是台账，删了等于抹掉发生过的事。
 * - 只删**最后一条可处置记录之后**的血缘。收件箱按下标动作，删掉靠前的行会让界面手里
 *   的下标指到另一条记录上（`orchestration.ts` 的收件箱 handler 依赖这条不变式）。
 *   可处置记录 24 小时后全部转成 cancelled，所以这个保护窗口不会长期挡住裁剪。
 *
 * 策略不合法时原样返回：删账是不可逆动作，参数有问题时宁可一条不裁。
 */
function pruneLineage(
  records: readonly CoordinationRecord[],
  options: LineagePruneOptions,
): { records: CoordinationRecord[]; removed: number } {
  if (pruneOptionProblem(options)) return { records: [...records], removed: 0 };
  const nowMs = toMillis(options.now ?? Date.now());
  const maxRecords = options.maxRecords ?? LINEAGE_MAX_RECORDS;
  const maxAgeMs = options.maxAgeMs ?? LINEAGE_MAX_AGE_MS;

  let lastActionable = -1;
  records.forEach((record, index) => {
    if (ACTIONABLE_STATES.includes(record.state)) lastActionable = index;
  });

  const candidates = records
    .map((record, index) => ({ record, index }))
    .filter(({ record, index }) => index > lastActionable && record.kind === "lineage");
  const keepFrom = Math.max(0, candidates.length - maxRecords);
  const dropped = new Set<number>();
  candidates.forEach(({ record, index }, position) => {
    const expired = nowMs - Date.parse(record.at) > maxAgeMs;
    if (position < keepFrom || expired) dropped.add(index);
  });
  if (dropped.size === 0) return { records: [...records], removed: 0 };
  return { records: records.filter((_, index) => !dropped.has(index)), removed: dropped.size };
}

/**
 * 按保留策略裁一次血缘，返回删掉几条。单独开放给测试与手工压缩；
 * `appendLineageRecord` 自己走同一个纯函数，不嵌套写锁。
 */
export function pruneLineageRecords(
  workspaceDir: string,
  options: LineagePruneOptions = {},
): Promise<{ ok: true; removed: number } | { ok: false; detail: string }> {
  // 对外入口：坏参数明确报错，不像内部纯函数那样静默不裁——「什么都没删」必须能被分辨。
  const problem = pruneOptionProblem(options);
  if (problem) return Promise.resolve({ ok: false as const, detail: problem });
  return enqueueWrite(workspaceDir, async () => {
    const read = await readCoordination(workspaceDir);
    if (read.failed) return { ok: false as const, detail: read.failed };
    const pruned = pruneLineage(read.records, options);
    if (pruned.removed === 0) return { ok: true as const, removed: 0 };
    try { await writeAll(workspaceDir, pruned.records); }
    catch (error) { return ioFailure(error); }
    return { ok: true as const, removed: pruned.removed };
  });
}

/**
 * 记一条「子 → 父」到协调收件箱，供父窗口归档、父子边被摘掉之后仍能查到这条链。
 *
 * 为什么用同一份 `coordination.jsonl` 而不是另开文件：规格九要求「共同的记账」——人只有
 * 一双眼睛，多开一个文件最后一定没人打开。`kind: "lineage"` 记完即终态，不 pending，
 * 所以收件箱读它时会过滤掉（它不是待办），清扫也不会碰它。
 *
 * 追加与裁剪在同一次读-改-写里完成：血缘是唯一「每次建子会话就多一行」的 kind，
 * 裁剪必须跟着它走，否则文件只增不减。裁剪只碰已有的旧行，刚写的这条一定落地。
 */
export function appendLineageRecord(workspaceDir: string, input: LineageInput): Promise<CoordinationRecord> {
  const workspaceId = input.workspaceId.trim();
  const childAgentId = input.childAgentId.trim();
  const parentAgentId = input.parentAgentId.trim();
  if (!workspaceId || !childAgentId || !parentAgentId) {
    return Promise.reject(new Error("血缘记录需要 workspaceId、子会话 id 与父会话 id"));
  }
  const parsed = parseRecord({
    at: input.at ?? new Date().toISOString(),
    kind: "lineage",
    workspaceId,
    // fromStaff 是「谁发起的」：父会话生出了子会话，所以把父放这一侧。
    fromStaff: parentAgentId,
    toStaff: null,
    paths: [],
    sessionAgentId: childAgentId,
    taskSummary: `子 → 父：${childAgentId} → ${parentAgentId}`,
    state: "recorded",
  });
  if (!parsed) return Promise.reject(new Error("血缘记录无效：父 / 子 / 工作区 id 或时间不合法"));

  return enqueueWrite(workspaceDir, async () => {
    const read = await readCoordination(workspaceDir);
    // 读不出来就抛：调用方（`agent.created`）会记一条 warn，而不是当作「没有旧账」覆盖掉。
    if (read.failed) throw new Error(read.failed);
    const retention = input.retention ?? {};
    // 新这条不参与裁剪（它就是本次要落的账），所以旧账只留 `maxRecords - 1` 条：
    // 加上新这条，**可裁的那一段**正好 `maxRecords` 条（可处置记录之前的那几条仍受保护）。
    const keep = (retention.maxRecords ?? LINEAGE_MAX_RECORDS) - 1;
    const pruned = pruneLineage(read.records, { ...retention, maxRecords: Math.max(0, keep) });
    // 没什么可裁时退回纯追加：`agent.created` 每次建子会话都会走这里，
    // 整份重写一份只会变长的台账没必要，能追加就追加。
    if (pruned.removed === 0) {
      await appendLine(workspaceDir, parsed);
      return parsed;
    }
    await writeAll(workspaceDir, [...pruned.records, parsed]);
    return parsed;
  });
}

/* ------------------------------------------------------------------ 纯迁移 */

const fail = (detail: string): CoordinationTransitionResult => ({ ok: false, detail });
const ioFailure = (error: unknown) => ({
  ok: false as const,
  detail: `写入 ${COORDINATION_FILE} 失败：${String(error)}`,
});

/** 只放行规格里列出的 (kind, 起始状态)，任何一条不满足就原样返回失败。 */
function guard(
  record: CoordinationRecord,
  kind: CoordinationKind | null,
  states: readonly CoordinationState[],
  action: string,
  next: CoordinationState,
): CoordinationTransitionResult {
  if (kind !== null && record.kind !== kind) return fail(`kind 是 ${record.kind}，这个动作只适用于 ${kind}`);
  if (!states.includes(record.state)) {
    return fail(`当前状态是 ${record.state}，${action} 只允许从 ${states.join(" / ")} 出发`);
  }
  return { ok: true, record: { ...record, state: next } };
}

/** territory：pending → approved-once。 */
export const approveOnce = (r: CoordinationRecord) => guard(r, "territory", ["pending"], "批准一次", "approved-once");
/** territory：approved-once → consumed。用掉就失效，下一路径重新批准。 */
export const consumeApproval = (r: CoordinationRecord) => guard(r, "territory", ["approved-once"], "消费批准", "consumed");

/**
 * 整批批准一次：用掉一条路径，同一批准记录里的其余路径仍可用；最后一条用掉才转 consumed。
 *
 * 规格的粒度是（会话，归一化路径），但「批准这一次」放行的是整批。若第一次写就把整条
 * 记录改成 consumed，同批剩下的路径会立刻失去批准——那等于只放行了第一条。
 */
export function consumeApprovalFor(record: CoordinationRecord, normalizedPath: string): CoordinationTransitionResult {
  const guarded = consumeApproval(record);
  if (!guarded.ok) return guarded;
  if (!record.paths.includes(normalizedPath)) return fail(`批准不覆盖路径 ${normalizedPath}`);
  const remaining = record.paths.filter((path) => path !== normalizedPath);
  return remaining.length === 0 ? guarded : { ok: true, record: { ...record, paths: remaining } };
}
/** territory：pending / approved-once → reassigned。 */
export const reassignRequest = (r: CoordinationRecord) =>
  guard(r, "territory", ["pending", "approved-once"], "转派", "reassigned");

/**
 * territory：pending / approved-once → reassigned，并记下转给谁。
 *
 * 无主区（`toStaff: null`）的请求没有可转的目标，收件箱让人从名册里选一张卡；
 * 选出来的目标就是转派后的 `toStaff`——只改状态不改目标，收件箱会显示
 * 「已转派」却说不清转给了谁。
 */
export function reassignRequestTo(record: CoordinationRecord, toStaff: string): CoordinationTransitionResult {
  const result = reassignRequest(record);
  if (!result.ok) return result;
  const target = toStaff.trim();
  if (!target) return fail("转派要指定一张目标卡");
  return { ...result, record: { ...result.record, toStaff: target } };
}
/** territory：pending / approved-once → denied。 */
export const denyRequest = (r: CoordinationRecord) =>
  guard(r, "territory", ["pending", "approved-once"], "驳回", "denied");
/** staffing：pending → staffed。 */
export const staffRequest = (r: CoordinationRecord) => guard(r, "staffing", ["pending"], "派人", "staffed");
/** staffing：pending → declined。 */
export const declineRequest = (r: CoordinationRecord) => guard(r, "staffing", ["pending"], "拒绝派人", "declined");
/** contract：pending → contract-changed（两边都改时也先记这一种）。 */
export const markContractChanged = (r: CoordinationRecord) =>
  guard(r, "contract", ["pending"], "契约已改", "contract-changed");
/** contract：pending → impl-changed。 */
export const markImplChanged = (r: CoordinationRecord) =>
  guard(r, "contract", ["pending"], "实现已改", "impl-changed");
/** 任何 kind：pending → superseded。 */
export const supersedeRequest = (r: CoordinationRecord) => guard(r, null, ["pending"], "覆盖", "superseded");

/** 任何 kind：pending → cancelled。超时、目标卡被删、需求被关都走这里。 */
export function cancelRequest(record: CoordinationRecord, reason = "timeout"): CoordinationTransitionResult {
  const result = guard(record, null, ["pending"], "取消", "cancelled");
  return result.ok ? { ...result, reason } : result;
}

/* ------------------------------------------------------------------ 落盘封装 */

function indexOfRef(records: readonly CoordinationRecord[], ref: CoordinationRef): number {
  if (typeof ref === "number") {
    return Number.isInteger(ref) && ref >= 0 && ref < records.length ? ref : -1;
  }
  return records.findIndex((record, index) => ref(record, index));
}

/**
 * 读全量、迁移目标、整份写回。目标找不到或迁移非法时原样返回失败，
 * 绝不「尽量改一点」——静默改状态比不生效更难查。
 */
export function transitionCoordination(
  workspaceDir: string,
  ref: CoordinationRef,
  transition: (record: CoordinationRecord) => CoordinationTransitionResult,
): Promise<CoordinationTransitionResult & { index?: number }> {
  return enqueueWrite(workspaceDir, async () => {
    const read = await readCoordination(workspaceDir);
    if (read.failed) return fail(read.failed);
    const index = indexOfRef(read.records, ref);
    const target = read.records[index];
    if (!target) return fail("找不到这条协调记录");
    const result = transition(target);
    if (!result.ok) return result;
    const next = read.records.map((record, at) => (at === index ? result.record : record));
    try { await writeAll(workspaceDir, next); }
    catch (error) { return ioFailure(error); }
    return { ...result, index };
  });
}

export const approveCoordination = (dir: string, ref: CoordinationRef) => transitionCoordination(dir, ref, approveOnce);
export const reassignCoordination = (dir: string, ref: CoordinationRef, toStaff?: string) =>
  transitionCoordination(dir, ref, (record) =>
    toStaff ? reassignRequestTo(record, toStaff) : reassignRequest(record),
  );
export const denyCoordination = (dir: string, ref: CoordinationRef) => transitionCoordination(dir, ref, denyRequest);
export const staffCoordination = (dir: string, ref: CoordinationRef) => transitionCoordination(dir, ref, staffRequest);
export const declineCoordination = (dir: string, ref: CoordinationRef) => transitionCoordination(dir, ref, declineRequest);
export const contractChangedCoordination = (dir: string, ref: CoordinationRef) =>
  transitionCoordination(dir, ref, markContractChanged);
export const implChangedCoordination = (dir: string, ref: CoordinationRef) =>
  transitionCoordination(dir, ref, markImplChanged);
export const supersedeCoordination = (dir: string, ref: CoordinationRef) =>
  transitionCoordination(dir, ref, supersedeRequest);
export const cancelCoordination = (dir: string, ref: CoordinationRef, reason = "manual") =>
  transitionCoordination(dir, ref, (record) => cancelRequest(record, reason));

/* ------------------------------------------------------------------ 批准粒度 */

/** 粒度 =（会话，归一化路径）：换会话或换路径都要重新点。 */
export function isApprovalUsable(record: CoordinationRecord, sessionAgentId: string, normalizedPath: string): boolean {
  return record.kind === "territory" && record.state === "approved-once" &&
    record.sessionAgentId === sessionAgentId && record.paths.includes(normalizedPath);
}

export function findUsableApproval(
  records: readonly CoordinationRecord[],
  sessionAgentId: string,
  normalizedPath: string,
): CoordinationRecord | null {
  return records.find((record) => isApprovalUsable(record, sessionAgentId, normalizedPath)) ?? null;
}

/** 用掉一次批准：消掉覆盖该路径的那一条；同批其余路径仍保留批准。 */
export async function consumeCoordinationApproval(
  workspaceDir: string,
  sessionAgentId: string,
  rawPath: string,
): Promise<CoordinationTransitionResult & { index?: number }> {
  const normalized = normalizeCoordinationPath(workspaceDir, rawPath);
  return transitionCoordination(
    workspaceDir,
    (record) => isApprovalUsable(record, sessionAgentId, normalized),
    (record) => consumeApprovalFor(record, normalized),
  );
}

/* ------------------------------------------------------------------ 聚合与覆盖 */

function requestKeyOfParts(
  kind: CoordinationKind, sessionAgentId: string, toStaff: string | null, need?: string, field?: string,
): string {
  // JSON 数组而不是 NUL 拼接：外部字符串里真带 NUL 也不会让两个不同的键撞在一起。
  return JSON.stringify([kind, sessionAgentId, toStaff,
    kind === "staffing" ? need ?? null : null, kind === "contract" ? field ?? null : null]);
}

const requestKeyOf = (record: CoordinationRecord): string =>
  requestKeyOfParts(record.kind, record.sessionAgentId, record.toStaff, record.need, record.field);

function targetsOf(input: CoordinationRequestInput): CoordinationPathTarget[] {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  if (entries.length) return [...entries];
  const fallback = input.toStaff ?? null;
  const paths = Array.isArray(input.paths) ? input.paths : [];
  // staffing / contract 是「对人的请求」，可以没有文件路径；仍要一条记录。
  return paths.length ? paths.map((file) => ({ path: file, toStaff: fallback })) : [{ path: "", toStaff: fallback }];
}

/**
 * 纯聚合：同一（会话，目标区/toStaff）的一批路径合成一条。
 * 20 个文件落在别人区产生 20 条请求，人会直接放弃这个收件箱。
 * staffing / contract 再按 need / field 分桶：同区里要两种人、两个字段对不上，是两条请求。
 */
export function aggregateCoordination(workspaceDir: string, input: CoordinationRequestInput): CoordinationRecord[] {
  const at = input.at ?? new Date().toISOString();
  const groups = new Map<string, { toStaff: string | null; paths: string[]; seen: Set<string> }>();
  for (const target of targetsOf(input)) {
    const toStaff = target.toStaff ?? null;
    const key = requestKeyOfParts(input.kind, input.sessionAgentId, toStaff, input.need, input.field);
    let group = groups.get(key);
    if (!group) { group = { toStaff, paths: [], seen: new Set<string>() }; groups.set(key, group); }
    if (!target.path) continue;
    const normalized = normalizeCoordinationPath(workspaceDir, target.path);
    if (normalized && !group.seen.has(normalized)) { group.seen.add(normalized); group.paths.push(normalized); }
  }
  return [...groups.values()].map((group) => ({
    at, kind: input.kind, workspaceId: input.workspaceId, fromStaff: input.fromStaff,
    toStaff: group.toStaff, paths: group.paths, sessionAgentId: input.sessionAgentId,
    taskSummary: input.taskSummary,
    ...(input.kind === "staffing" && input.need !== undefined ? { need: input.need } : {}),
    ...(input.kind === "contract" && input.field !== undefined ? { field: input.field } : {}),
    state: "pending" as const,
  }));
}

/**
 * 外部（MCP / RPC）边界校验。校验不通过就整条拒绝，不能写一行读不回来的坏记录，
 * 也不能让 `paths` 传成字符串时抛 TypeError。
 */
function validateRequestInput(input: CoordinationRequestInput): string | null {
  if (!isOneOf(input.kind, COORDINATION_KINDS)) return `未知 kind：${String(input.kind)}`;
  for (const key of ["workspaceId", "fromStaff", "sessionAgentId", "taskSummary"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim()) return `${key} 不能为空`;
  }
  if (input.at !== undefined && (typeof input.at !== "string" || Number.isNaN(Date.parse(input.at)))) {
    return "at 不是有效时间";
  }
  if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.some((p) => typeof p !== "string"))) {
    return "paths 必须是字符串数组";
  }
  if (input.entries !== undefined && !Array.isArray(input.entries)) return "entries 必须是数组";
  for (const entry of Array.isArray(input.entries) ? input.entries : []) {
    if (!entry || typeof entry.path !== "string" || (entry.toStaff !== null && typeof entry.toStaff !== "string")) {
      return "entries 形状不合法";
    }
  }
  return null;
}

/**
 * 把同键更早 pending 的路径并到新记录前面（权限闸的 mergePendingPaths）。
 * 旧的在前、新的在后，收件箱里读起来仍是时间顺序。
 */
function mergePendingPathsOf(
  existing: readonly CoordinationRecord[],
  incoming: readonly CoordinationRecord[],
): CoordinationRecord[] {
  const byKey = new Map(incoming.map((record) => [requestKeyOf(record), record]));
  const oldPaths = new Map<string, string[]>();
  for (const record of existing) {
    if (record.state !== "pending" || !byKey.has(requestKeyOf(record))) continue;
    oldPaths.set(requestKeyOf(record), [...record.paths]);
  }
  return incoming.map((record) => {
    const old = oldPaths.get(requestKeyOf(record)) ?? [];
    const seen = new Set(record.paths);
    return { ...record, paths: [...old.filter((path) => !seen.has(path)), ...record.paths] };
  });
}

/**
 * 落盘一次请求：先聚合，再把同会话同区更早的 pending 标成 superseded。
 * 重试不应该刷屏——旧的那条已被新的覆盖，留着只会让人重复点。
 */
export function requestCoordination(
  workspaceDir: string,
  input: CoordinationRequestInput,
): Promise<CoordinationRequestResult> {
  return enqueueWrite(workspaceDir, async () => {
    const invalid = validateRequestInput(input);
    if (invalid) return { ok: false, detail: invalid };
    const incoming = aggregateCoordination(workspaceDir, input);
    if (incoming.length === 0) return { ok: false, detail: "没有可写入的协调请求" };
    if (incoming.some((record) => !parseRecord(record))) {
      return { ok: false, detail: "聚合出的协调记录不合法" };
    }
    const read = await readCoordination(workspaceDir);
    if (read.failed) return { ok: false, detail: read.failed };
    const merged = input.mergePendingPaths ? mergePendingPathsOf(read.records, incoming) : incoming;
    const keys = new Set(merged.map(requestKeyOf));
    let superseded = 0;
    const existing = read.records.map((record) => {
      if (record.state !== "pending" || !keys.has(requestKeyOf(record))) return record;
      const result = supersedeRequest(record);
      if (!result.ok) return record;
      superseded += 1;
      return result.record;
    });
    try { await writeAll(workspaceDir, [...existing, ...merged]); }
    catch (error) { return ioFailure(error); }
    return { ok: true, records: merged, superseded, file: coordinationFileOf(workspaceDir) };
  });
}

/* ------------------------------------------------------------------ 超时 / 目标消失 */

export interface CoordinationSweepOptions {
  /** 测试注入；缺省当前时间。 */
  now?: Date | number | string;
  maxAgeMs?: number;
  /** 由调用方说明原因：target-deleted / requirement-closed / 其它。 */
  reason?: string;
  /**
   * 目标卡被删 / 需求被关时由调用方给出选择器；给了 match 只处理命中的 pending，
   * 不再按 24 小时扫。两种取消走同一个函数，避免两套计时/状态逻辑。
   */
  match?: (record: CoordinationRecord, index: number) => boolean;
}

function toMillis(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : Date.parse(value);
}

/** 默认取消超过 24 小时的 pending；传 match 时只取消命中的那些（目标消失、需求关闭）。 */
export function sweepCoordination(
  workspaceDir: string,
  options: CoordinationSweepOptions = {},
): Promise<CoordinationSweepResult> {
  return enqueueWrite(workspaceDir, async () => {
    const nowMs = toMillis(options.now ?? Date.now());
    if (!Number.isFinite(nowMs)) return { ok: false as const, detail: "now 不是有效时间" };
    const maxAgeMs = options.maxAgeMs ?? COORDINATION_TTL_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      return { ok: false as const, detail: "maxAgeMs 必须是非负数" };
    }
    const reason = options.reason ?? (options.match ? "target-gone" : "timeout");
    const read = await readCoordination(workspaceDir);
    if (read.failed) return { ok: false as const, detail: read.failed };
    let cancelled = 0;
    const next = read.records.map((record, index) => {
      if (record.state !== "pending") return record;
      const hit = options.match ? options.match(record, index) : nowMs - Date.parse(record.at) >= maxAgeMs;
      if (!hit) return record;
      const result = cancelRequest(record, reason);
      if (!result.ok) return record;
      cancelled += 1;
      return result.record;
    });
    if (cancelled > 0) {
      try { await writeAll(workspaceDir, next); }
      catch (error) { return ioFailure(error); }
    }
    return { ok: true as const, records: next, cancelled, reason };
  });
}
