import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  WORK_ROUTE_MAX_AGE_DAYS,
  WORK_ROUTE_MAX_ENTRIES,
  emptyWorkRouteLedger,
  parseWorkRouteLedger,
  pruneWorkRouteLedger,
  serializeWorkRouteLedger,
  type WorkRouteLedger,
} from "../shared/work-route.ts";
import { daemonHome } from "./paths.ts";

/**
 * 工作路线台账的落盘层。
 *
 * 位置固定在 `<PASEO_HOME 或 ~/.paseo>/matt-skills-deck/`，不写用户仓库：
 * 台账是插件自己的运行状态，混进被 git 跟踪的目录会变成噪声甚至泄漏会话信息。
 *
 * 三条约束：
 * - 原子写：临时文件 + rename，读到一半崩溃不会留下半篇 JSON。
 * - 单写者：每份台账一把 `.lock`，读-改-写全程持锁，避免多会话并发互相覆盖。
 * - 损坏可恢复：坏文件改名留档，再从空台账起步，绝不静默覆盖。
 */

const DATA_DIR_NAME = "matt-skills-deck";
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 5;
const HANDOFF_MAX_AGE_DAYS = 30;
const HANDOFF_MAX_FILES = 50;

export interface LedgerScopeOptions {
  /** 工作区目录；没有 agent 作用域时用它区分不同的工作区台账。 */
  cwd?: string;
  /** 显式 agent id；缺省读 `PASEO_AGENT_ID`。传 null 表示强制按工作区。 */
  agentId?: string | null;
  /** 覆盖 Paseo 数据目录（与 PASEO_HOME 同义；台账在其下 `matt-skills-deck/`）。 */
  homeDir?: string;
}

export interface LedgerScope {
  kind: "agent" | "workspace";
  /** 作用域标识：agent id，或 `目录名-哈希`。 */
  id: string;
  /** 台账 JSON 的绝对路径。 */
  file: string;
  /** 该作用域的 handoff 文档目录。 */
  handoffDir: string;
}

export function ledgerRoot(homeDir?: string): string {
  return path.join(homeDir ?? daemonHome(), DATA_DIR_NAME);
}

function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function slugOf(value: string, max = 40): string {
  const slug = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "scope";
}

/**
 * 作用域解析：有 `PASEO_AGENT_ID` 就按 agent，否则按工作区。
 *
 * 工作区必须显式给 `cwd`：daemon 里的 `process.cwd()` 是 `/`，拿它当工作区
 * 会让所有工作区共用一份台账，且没有任何报错。
 */
export function resolveLedgerScope(options: LedgerScopeOptions = {}): LedgerScope {
  const root = ledgerRoot(options.homeDir);
  const explicit = options.agentId !== undefined ? options.agentId : process.env.PASEO_AGENT_ID ?? null;
  const agentId = explicit?.trim();
  if (agentId) {
    const id = `${slugOf(agentId, 48)}-${shortHash(agentId)}`;
    return {
      kind: "agent",
      id,
      file: path.join(root, "agents", `${id}.json`),
      handoffDir: path.join(root, "handoffs", `agent-${id}`),
    };
  }
  const cwd = options.cwd?.trim();
  if (!cwd) {
    throw new Error("没有 PASEO_AGENT_ID，也没有工作区目录：无法决定台账作用域");
  }
  const id = `${slugOf(path.basename(cwd) || "workspace", 32)}-${shortHash(cwd)}`;
  return {
    kind: "workspace",
    id,
    file: path.join(root, "workspaces", `${id}.json`),
    handoffDir: path.join(root, "handoffs", `workspace-${id}`),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

// ---------------------------------------------------------------------------
// 锁与原子写
// ---------------------------------------------------------------------------

interface LockHandle {
  path: string;
}

async function acquireLock(lockPath: string): Promise<{ ok: true; lock: LockHandle } | { ok: false; detail: string }> {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
      } finally {
        closeSync(fd);
      }
      return { ok: true, lock: { path: lockPath } };
    } catch (error) {
      if (errorCodeOf(error) !== "EEXIST") {
        return { ok: false, detail: `创建锁失败：${messageOf(error)}` };
      }
      try {
        const stat = statSync(lockPath);
        // 陈旧锁：持锁进程崩溃后文件会一直留着；超过上限就直接接管。
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (errorCodeOf(statError) === "ENOENT") continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        return { ok: false, detail: `等待台账锁超时（${LOCK_WAIT_MS}ms）` };
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

function releaseLock(lock: LockHandle): void {
  try {
    const content = JSON.parse(readFileSync(lock.path, "utf8")) as { pid?: unknown };
    // 只删自己的锁：避免接管过陈旧锁后，把别人新建的锁误删。
    if (content.pid !== process.pid) return;
    unlinkSync(lock.path);
  } catch {
    // 锁已经不在或读不出来；没有需要恢复的状态。
  }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  // 不做 fsync：这里要的是「进程崩溃不留半篇文件」，rename 已经保证；
  // 掉电丢最后一次写入可以接受，而 overlayfs 上 fsync 单次约 300ms，会拖慢每次发送。
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件删不掉时保留现场，真正的错误在下一条抛出。
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 台账读写
// ---------------------------------------------------------------------------

export type LedgerReadResult =
  | {
      ok: true;
      scope: LedgerScope;
      ledger: WorkRouteLedger;
      /** 文件损坏、已改名留档并从空台账起步。 */
      recovered: boolean;
      /** 解析时丢弃的坏记录条数。 */
      dropped: number;
      corruptPath: string | null;
    }
  | { ok: false; reason: "scope-missing" | "read-failed"; detail: string };

function readScoped(scope: LedgerScope): LedgerReadResult {
  let text: string;
  try {
    text = readFileSync(scope.file, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") {
      return {
        ok: true,
        scope,
        ledger: emptyWorkRouteLedger(new Date().toISOString()),
        recovered: false,
        dropped: 0,
        corruptPath: null,
      };
    }
    return { ok: false, reason: "read-failed", detail: messageOf(error) };
  }
  const parsed = parseWorkRouteLedger(text);
  if (parsed.ok) {
    return { ok: true, scope, ledger: parsed.ledger, recovered: false, dropped: parsed.dropped, corruptPath: null };
  }
  const corruptPath = `${scope.file}.corrupt-${Date.now()}`;
  try {
    renameSync(scope.file, corruptPath);
  } catch (error) {
    return { ok: false, reason: "read-failed", detail: `台账损坏且无法留档：${messageOf(error)}` };
  }
  return {
    ok: true,
    scope,
    ledger: emptyWorkRouteLedger(new Date().toISOString()),
    recovered: true,
    dropped: 0,
    corruptPath,
  };
}

export async function readWorkRouteLedger(options: LedgerScopeOptions = {}): Promise<LedgerReadResult> {
  let scope: LedgerScope;
  try {
    scope = resolveLedgerScope(options);
  } catch (error) {
    return { ok: false, reason: "scope-missing", detail: messageOf(error) };
  }
  return readScoped(scope);
}

export type LedgerUpdateResult =
  | {
      ok: true;
      scope: LedgerScope;
      ledger: WorkRouteLedger;
      recovered: boolean;
      dropped: number;
      corruptPath: string | null;
    }
  | { ok: false; reason: "scope-missing" | "read-failed" | "lock-timeout" | "write-failed"; detail: string };

/**
 * 读-改-写。
 *
 * 修改函数必须是纯函数；它在持锁期间执行，抛错就不落盘，原文件保持不变。
 * 写完后回读比对条目数与 `updatedAt`，避免「rename 成功但内容不是预期」还报成功。
 */
export async function updateWorkRouteLedger(
  mutate: (ledger: WorkRouteLedger) => WorkRouteLedger,
  options: LedgerScopeOptions = {},
): Promise<LedgerUpdateResult> {
  let scope: LedgerScope;
  try {
    scope = resolveLedgerScope(options);
  } catch (error) {
    return { ok: false, reason: "scope-missing", detail: messageOf(error) };
  }
  const lockPath = `${scope.file}.lock`;
  const acquired = await acquireLock(lockPath);
  if (!acquired.ok) return { ok: false, reason: "lock-timeout", detail: acquired.detail };
  try {
    const current = readScoped(scope);
    if (!current.ok) return current;
    let next: WorkRouteLedger;
    try {
      next = mutate(current.ledger);
    } catch (error) {
      return { ok: false, reason: "write-failed", detail: `台账修改函数抛错：${messageOf(error)}` };
    }
    const pruned = pruneWorkRouteLedger(next, {
      now: Date.now(),
      maxAgeDays: WORK_ROUTE_MAX_AGE_DAYS,
      maxEntries: WORK_ROUTE_MAX_ENTRIES,
    });
    try {
      writeAtomic(scope.file, serializeWorkRouteLedger(pruned));
    } catch (error) {
      return { ok: false, reason: "write-failed", detail: messageOf(error) };
    }
    const verify = readScoped(scope);
    if (
      !verify.ok ||
      verify.ledger.entries.length !== pruned.entries.length ||
      verify.ledger.updatedAt !== pruned.updatedAt
    ) {
      return { ok: false, reason: "write-failed", detail: "写入后回读与预期不一致" };
    }
    return {
      ok: true,
      scope,
      ledger: verify.ledger,
      recovered: current.recovered,
      dropped: current.dropped,
      corruptPath: current.corruptPath,
    };
  } finally {
    releaseLock(acquired.lock);
  }
}

// ---------------------------------------------------------------------------
// Handoff 文档
// ---------------------------------------------------------------------------

export interface HandoffSaveOptions extends LedgerScopeOptions {
  /** 文件名里用的人类可读片段（通常是 handoff 标题）。 */
  title?: string;
  /** 覆盖时间戳，测试用；缺省当前时间。 */
  now?: Date;
}

export type HandoffSaveResult =
  | { ok: true; scope: LedgerScope; path: string; name: string }
  | { ok: false; reason: "scope-missing" | "write-failed"; detail: string };

function stampOf(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}`;
}

function pruneHandoffs(directory: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".md"));
  } catch {
    return;
  }
  const cutoff = now.getTime() - HANDOFF_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const files = names.flatMap((name) => {
    const file = path.join(directory, name);
    try {
      const stat = statSync(file);
      return [{ name, file, mtimeMs: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  files.forEach((file, index) => {
    const tooOld = file.mtimeMs < cutoff;
    const tooMany = index >= HANDOFF_MAX_FILES;
    if (!tooOld && !tooMany) return;
    try {
      unlinkSync(file.file);
    } catch {
      // 清理失败不影响本次保存；下次再试。
    }
  });
}

/** 保存交接文档。文件名同时带时间戳与内容哈希：同一秒内容相同就覆盖，不同则并存。 */
export async function saveHandoff(markdown: string, options: HandoffSaveOptions = {}): Promise<HandoffSaveResult> {
  let scope: LedgerScope;
  try {
    scope = resolveLedgerScope(options);
  } catch (error) {
    return { ok: false, reason: "scope-missing", detail: messageOf(error) };
  }
  const now = options.now ?? new Date();
  const slug = slugOf(options.title ?? "handoff", 32);
  const hash = shortHash(markdown);
  const name = `${stampOf(now)}-${slug}-${hash}.md`;
  const file = path.join(scope.handoffDir, name);
  try {
    mkdirSync(scope.handoffDir, { recursive: true });
    writeAtomic(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  } catch (error) {
    return { ok: false, reason: "write-failed", detail: messageOf(error) };
  }
  pruneHandoffs(scope.handoffDir, now);
  return { ok: true, scope, path: file, name };
}

export interface HandoffFile {
  name: string;
  path: string;
  size: number;
  /** ISO 时间。 */
  modifiedAt: string;
}

export type HandoffListResult =
  | { ok: true; scope: LedgerScope; files: HandoffFile[] }
  | { ok: false; reason: "scope-missing" | "read-failed"; detail: string };

export async function listHandoffs(
  options: LedgerScopeOptions & { limit?: number } = {},
): Promise<HandoffListResult> {
  let scope: LedgerScope;
  try {
    scope = resolveLedgerScope(options);
  } catch (error) {
    return { ok: false, reason: "scope-missing", detail: messageOf(error) };
  }
  let names: string[];
  try {
    names = readdirSync(scope.handoffDir).filter((name) => name.endsWith(".md"));
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return { ok: true, scope, files: [] };
    return { ok: false, reason: "read-failed", detail: messageOf(error) };
  }
  const files = names.flatMap((name) => {
    const file = path.join(scope.handoffDir, name);
    try {
      const stat = statSync(file);
      return [{ name, path: file, size: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() }];
    } catch {
      return [];
    }
  });
  files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return { ok: true, scope, files: files.slice(0, options.limit ?? 20) };
}

export type HandoffReadResult =
  | { ok: true; scope: LedgerScope; name: string; path: string; markdown: string }
  | { ok: false; reason: "scope-missing" | "invalid-name" | "not-found" | "read-failed"; detail: string };

/** 只接受目录内的纯文件名；`../`、绝对路径、子目录一律拒绝。 */
export async function readHandoff(name: string, options: LedgerScopeOptions = {}): Promise<HandoffReadResult> {
  let scope: LedgerScope;
  try {
    scope = resolveLedgerScope(options);
  } catch (error) {
    return { ok: false, reason: "scope-missing", detail: messageOf(error) };
  }
  const safe = name.trim();
  if (!safe || safe.includes("/") || safe.includes("\\") || safe.includes("..") || !safe.endsWith(".md")) {
    return { ok: false, reason: "invalid-name", detail: "handoff 文件名必须是目录内的 .md 文件名" };
  }
  const file = path.join(scope.handoffDir, safe);
  try {
    const markdown = readFileSync(file, "utf8");
    return { ok: true, scope, name: safe, path: file, markdown };
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") {
      return { ok: false, reason: "not-found", detail: "没有这份 handoff" };
    }
    return { ok: false, reason: "read-failed", detail: messageOf(error) };
  }
}
