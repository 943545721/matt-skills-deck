import { stat, unlink, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { PLUGIN_ID } from "../shared/identity.ts";

/**
 * 「这个 deck MCP 进程没拿到会话身份」的运行时痕迹。
 *
 * `PASEO_AGENT_ID` 是宿主注入给会话进程的环境变量，插件写不了它。MCP 进程拿不到它时，
 * `deck_handoff` / `deck_staff_request` / 派单都会拒绝——用户看到的只是某几条工具报错，
 * 很难想到「是开这个窗口的时候没带上身份」。宿主快照里既没有环境变量也没有 MCP 配置，
 * 面板没法从会话列表反推这件事，所以由 MCP 进程自己留一份痕迹：
 *
 * - 启动时确认没有身份 → 写 `.deck/runtime/mcp-identity/<pid>.json`；
 * - 之后每次因此被拒 → 更新同一份文件里的「最近一次」；
 * - 编排状态读取时回收：进程还在的算缺口，进程没了的（窗口关了）当场删掉。
 *
 * **有身份的进程不写文件**：读取侧看到的每一份文件就是一处缺口，不用再猜。
 * 写不进去只影响可观测性，绝不影响工具调用本身——所有写盘错误都吞掉并返回 false。
 */

/** 运行时痕迹放在 `.deck/` 下：那本来就是本地状态目录，不进版本库。 */
export const IDENTITY_RUNTIME_SUBDIR = path.join(".deck", "runtime", "mcp-identity");

/** 文件格式版本：读到自己不认识的版本就当成坏文件回收（不能拿旧形状硬解）。 */
const PRESENCE_VERSION = 1;

/** 一次最多报几处：面板上是一条横幅，列三十条只会把树挤没。 */
const MAX_GAPS = 20;
/** 超过这个岁数的痕迹按陈旧处理：pid 会被系统复用，太老的文件不敢再信。 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 工具名只用来给人看，截断防止一份手改坏的文件把横幅撑爆。 */
const MAX_TOOL_CHARS = 64;

interface PresenceFile {
  readonly version: typeof PRESENCE_VERSION;
  readonly pid: number;
  readonly since: string;
  readonly lastTool: string | null;
  readonly lastAt: string | null;
}

/** 读取侧看到的一处缺口：哪个进程、从什么时候起、最近被哪个工具拒过。 */
export interface IdentityGap {
  readonly pid: number;
  readonly since: string;
  readonly lastTool: string | null;
  readonly lastAt: string | null;
}

interface PresenceOptions {
  /** 省略时读 `PASEO_AGENT_ID`；测试用它覆盖。 */
  readonly agentId?: string | null;
  readonly pid?: number;
  readonly now?: Date;
}

function identityOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_AGENT_ID?.trim() ?? "";
}

/**
 * 写不下痕迹时留一行 stderr。
 *
 * 这件事只影响可观测性，不能反过来让工具调用失败；但完全静默的话，用户会继续对着
 * 「工具莫名报错」猜，日志里也查不到为什么面板没提示。读路径上的失败（文件被删、
 * 进程刚好退出）是正常竞态，不在这里报。
 */
function warnWriteFailed(what: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[${PLUGIN_ID}] ${what}：${detail}\n`);
}

function dirOf(workspaceDir: string): string {
  return path.join(workspaceDir, IDENTITY_RUNTIME_SUBDIR);
}

function fileOf(workspaceDir: string, pid: number): string {
  return path.join(dirOf(workspaceDir), `${pid}.json`);
}

/** 进程退出时顺手删掉自己的痕迹：窗口关了就该从横幅上消失，不必等下一次回收。 */
const cleanupFiles = new Set<string>();
let cleanupRegistered = false;

function rememberCleanup(file: string): void {
  cleanupFiles.add(file);
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    for (const item of cleanupFiles) {
      try {
        unlinkSync(item);
      } catch {
        // 文件已经不在或被别的进程清掉了：退出路径上没有可做的事。
      }
    }
  });
}

async function writeAtomic(file: string, payload: PresenceFile): Promise<void> {
  // 同目录临时文件 + rename：读取侧要么读到上一版，要么读到完整的新版，不会读到半截 JSON。
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload)}\n`, "utf8");
  await rename(temp, file);
}

/**
 * MCP 进程启动时调用一次。
 *
 * 只在该进程**确实没有**身份时落盘；有身份就什么都不写（返回 false），
 * 读取侧因此可以把「存在文件」直接当成一处缺口。
 */
export async function announcePresence(
  workspaceDir: string,
  options: PresenceOptions = {},
): Promise<boolean> {
  const agentId = options.agentId === undefined ? identityOf() : (options.agentId ?? "").trim();
  if (agentId) return false;
  const pid = options.pid ?? process.pid;
  const file = fileOf(workspaceDir, pid);
  try {
    await mkdir(dirOf(workspaceDir), { recursive: true });
    await writeAtomic(file, {
      version: PRESENCE_VERSION,
      pid,
      since: (options.now ?? new Date()).toISOString(),
      lastTool: null,
      lastAt: null,
    });
    rememberCleanup(file);
    return true;
  } catch (error) {
    warnWriteFailed("记不下「本会话没有身份」的痕迹", error);
    return false;
  }
}

/**
 * 工具因为「没有会话身份」拒绝调用时调用一次。
 *
 * 保留第一次的 `since`：横幅要说的是「这个窗口从打开起就没身份」，
 * 而不是「最近一次报错是什么时候」。
 */
export async function noteIdentityRefusal(
  workspaceDir: string,
  tool: string,
  options: PresenceOptions = {},
): Promise<boolean> {
  const agentId = options.agentId === undefined ? identityOf() : (options.agentId ?? "").trim();
  if (agentId) return false;
  const pid = options.pid ?? process.pid;
  const at = (options.now ?? new Date()).toISOString();
  const file = fileOf(workspaceDir, pid);
  try {
    const existing = await readPresence(file);
    await mkdir(dirOf(workspaceDir), { recursive: true });
    await writeAtomic(file, {
      version: PRESENCE_VERSION,
      pid,
      since: existing?.since ?? at,
      lastTool: tool.slice(0, MAX_TOOL_CHARS),
      lastAt: at,
    });
    rememberCleanup(file);
    return true;
  } catch (error) {
    warnWriteFailed("记不下「这个工具因缺身份被拒」的痕迹", error);
    return false;
  }
}

/** 读一份痕迹；文件不存在、形状不对都返回 null（调用方决定要不要删）。 */
async function readPresence(file: string): Promise<PresenceFile | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== PRESENCE_VERSION) return null;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.since !== "string") return null;
  const lastTool = typeof record.lastTool === "string" ? record.lastTool : null;
  const lastAt = typeof record.lastAt === "string" ? record.lastAt : null;
  return { version: PRESENCE_VERSION, pid: record.pid, since: record.since, lastTool, lastAt };
}

/** 进程还活着吗：`EPERM` 说明是别人的进程（还活着），其余错误按已退出处理。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeQuiet(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    // 已经被删掉了：回收是尽力而为。
  }
}

/** 半截临时文件只有在写进程也没了的时候才清：别把正在写的文件的 rename 弄失败。 */
async function removeStaleTemp(file: string, now: Date): Promise<void> {
  try {
    const info = await stat(file);
    if (now.getTime() - info.mtimeMs > MAX_AGE_MS) await removeQuiet(file);
  } catch {
    // 读不到状态就留着，下一轮再说。
  }
}

/**
 * 编排状态里要显示的缺口。
 *
 * 读不到目录 = 没有缺口（不是错误）：绝大多数工作区从来不会有这份目录。
 * 回收同时做三件事：格式坏掉的文件删掉、进程没了的删掉、剩下的按打开时间倒序。
 * `isAlive` 与 `now` 可注入，测试才能在别的进程里确定性地覆盖。
 */
export async function readIdentityGaps(
  workspaceDir: string,
  options: { now?: Date; isAlive?: (pid: number) => boolean; limit?: number } = {},
): Promise<IdentityGap[]> {
  const dir = dirOf(workspaceDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const now = options.now ?? new Date();
  const isAlive = options.isAlive ?? pidAlive;
  const limit = options.limit ?? MAX_GAPS;
  const gaps: IdentityGap[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith(".tmp")) {
      await removeStaleTemp(file, now);
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const record = await readPresence(file);
    if (!record) {
      await removeQuiet(file);
      continue;
    }
    const since = Date.parse(record.since);
    const stale = !Number.isFinite(since) || now.getTime() - since > MAX_AGE_MS;
    if (stale || !isAlive(record.pid)) {
      await removeQuiet(file);
      continue;
    }
    gaps.push({ pid: record.pid, since: record.since, lastTool: record.lastTool, lastAt: record.lastAt });
  }
  gaps.sort((left, right) => Date.parse(right.since) - Date.parse(left.since));
  return gaps.slice(0, limit);
}
