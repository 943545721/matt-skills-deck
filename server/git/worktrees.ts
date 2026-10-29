import { runGit } from "./exec.ts";

/**
 * `git worktree list --porcelain` 的解析与读取。
 *
 * 解析器逐字照搬 DSH 的 `src/shared/version-control/src/parse-worktrees.ts`：
 * - `-z` 与非 `-z` 双形；`-z` 下记录间以空 NUL 分隔、行以 NUL 结尾，非 `-z` 下以空行分隔。
 * - `locked` / `prunable` 既可能是裸标签，也可能带原因（原因可含空格）；未知属性忽略。
 * - 记录首行必须是 `worktree <path>`，否则整份清单判失败，不猜。
 *
 * 读取层照 DSH host 的顺序：先用 `-z`，老版本 git 不认这个开关时退回换行形态；
 * 输出被截断就明说「读不全」，不给半份列表。当前工作树先用
 * `rev-parse --show-toplevel` 按路径比对，退而按分支名、再退按 HEAD oid 比对。
 *
 * 与 DSH 的唯一适配：`runGit` 非零退出时把 stderr 并进 stdout（见 server/git/exec.ts），
 * 所以失败详情从 stdout 里取第一行，而不是 DSH 那一份里的 `stderr` 字段。
 */

export interface WorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

export interface WorktreeEntry extends WorktreeRecord {
  /** 同仓工作树里能区分开的最短路径后缀。 */
  display: string;
  current: boolean;
}

export type WorktreesReading =
  | { ok: true; worktrees: WorktreeEntry[] }
  | { ok: false; reason: "no-workspace" | "git-missing" | "git-failed" | "invalid"; detail: string };

type ParseResult = { ok: true; worktrees: WorktreeRecord[] } | { ok: false; detail: string };

function fail(detail: string): ParseResult {
  return { ok: false, detail };
}

function parseRecord(lines: string[]): WorktreeRecord | ParseResult {
  const head = lines[0];
  if (head === undefined || !head.startsWith("worktree ")) return fail("记录首行不是 worktree");
  const record: WorktreeRecord = {
    path: head.slice("worktree ".length),
    head: null,
    branch: null,
    bare: false,
    detached: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
  };
  if (!record.path) return fail("worktree 路径为空");
  for (const line of lines.slice(1)) {
    if (line.startsWith("HEAD ")) record.head = line.slice(5) || null;
    else if (line.startsWith("branch ")) record.branch = line.slice(7).replace(/^refs\/heads\//, "") || null;
    else if (line === "bare") record.bare = true;
    else if (line === "detached") record.detached = true;
    else if (line === "locked") record.locked = true;
    else if (line.startsWith("locked ")) {
      record.locked = true;
      record.lockReason = line.slice(7);
    } else if (line === "prunable") record.prunable = true;
    else if (line.startsWith("prunable ")) {
      record.prunable = true;
      record.prunableReason = line.slice(9);
    }
  }
  return record;
}

function isFailure(value: WorktreeRecord | ParseResult): value is ParseResult {
  return (value as ParseResult).ok === false;
}

export function parseWorktrees(stdout: string, useNul: boolean): ParseResult {
  const text = String(stdout);
  const records: string[][] = [];
  if (useNul) {
    const fields = text.split("\0");
    if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
    let current: string[] = [];
    for (const field of fields) {
      if (field === "") {
        if (current.length > 0) {
          records.push(current);
          current = [];
        }
        continue;
      }
      current.push(field);
    }
    if (current.length > 0) records.push(current);
  } else {
    let current: string[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line === "") {
        if (current.length > 0) {
          records.push(current);
          current = [];
        }
        continue;
      }
      current.push(line);
    }
    if (current.length > 0) records.push(current);
  }

  const parsed: WorktreeRecord[] = [];
  for (const lines of records) {
    const record = parseRecord(lines);
    if (isFailure(record)) return record;
    parsed.push(record);
  }
  return { ok: true, worktrees: parsed };
}

/** 最短唯一后缀：同仓全部工作树里从末段往左数到可区分的最少段数（DSH 定案）。 */
export function shortestUniqueSuffix(paths: string[]): number[] {
  const segments = paths.map((value) => String(value).replace(/\\/g, "/").split("/").filter((part) => part !== ""));
  return segments.map((own, index) => {
    for (let count = 1; count <= own.length; count += 1) {
      const tail = own.slice(-count).join("/").toLowerCase();
      let clash = false;
      for (let other = 0; other < segments.length; other += 1) {
        if (other === index) continue;
        const rival = segments[other];
        if (rival && rival.slice(-count).join("/").toLowerCase() === tail) {
          clash = true;
          break;
        }
      }
      if (!clash) return count;
    }
    return own.length;
  });
}

export function displayFor(path: string, keep: number): string {
  const segments = String(path).replace(/\\/g, "/").split("/").filter((part) => part !== "");
  // 根路径这种没有段可切的输入：显示原名，不返回空串。
  if (segments.length === 0) return String(path) || "/";
  return segments.slice(-Math.max(1, keep)).join("/");
}

/**
 * 工作树路径比对用的归一化：反斜杠与正斜杠统一、去掉结尾的斜杠、Windows 盘符只折大小写。
 * POSIX 上其余部分大小写敏感，原样保留。
 */
function sameWorktreePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const text = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
    const drive = /^([a-zA-Z]):/.exec(text);
    return drive ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  };
  return normalize(left) === normalize(right);
}

function firstLine(text: string, max = 300): string {
  const line = text.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  return line.slice(0, max);
}

async function readRef(workspaceDir: string, args: string[]): Promise<string> {
  const result = await runGit(workspaceDir, args, { timeoutMs: 5_000, limit: 4_096 });
  if (!result.ok || result.data.exitCode !== 0) return "";
  return result.data.stdout.trim();
}

/**
 * 当前工作树的真实路径。macOS 上 /tmp 是 /private/tmp 的软链，`--show-toplevel`
 * 会回解析后的路径，而 `worktree list` 登记的是传入时的原样路径——两边不解析
 * 符号链接根本比不中，所以先 realpath 再比；realpath 失败（目录没了）就用原值。
 */
async function realPathOf(path: string): Promise<string> {
  try {
    const { realpath } = await import("node:fs/promises");
    return await realpath(path);
  } catch {
    return path;
  }
}

/** 读一次工作树清单。失败时带自己的原因码，不把「读不到」当成「没有其他工作树」。 */
export async function readWorktrees(workspaceDir: string): Promise<WorktreesReading> {
  let useNul = true;
  let result = await runGit(workspaceDir, ["worktree", "list", "--porcelain", "-z"], { limit: 4 << 20 });
  if (!result.ok) return result;
  if (result.data.exitCode !== 0) {
    // 老版本 git 不认 --porcelain -z：退回换行形态，并记住这次用的是哪一种。
    useNul = false;
    result = await runGit(workspaceDir, ["worktree", "list", "--porcelain"], { limit: 4 << 20 });
    if (!result.ok) return result;
  }
  if (result.data.truncated) {
    return { ok: false, reason: "git-failed", detail: "工作树清单读不全，不返回半份列表" };
  }
  if (result.data.exitCode !== 0) {
    // runGit 失败时把 stderr 并进 stdout：错误的第一行就是 git 给的人话原因。
    return {
      ok: false,
      reason: "git-failed",
      detail: `git worktree list 失败：${firstLine(result.data.stdout) || `退出码 ${result.data.exitCode}`}`,
    };
  }

  const parsed = parseWorktrees(result.data.stdout, useNul);
  if (!parsed.ok) return { ok: false, reason: "invalid", detail: `工作树清单解析失败：${parsed.detail}` };
  const records = parsed.worktrees;
  if (records.length === 0) return { ok: true, worktrees: [] };

  const top = await readRef(workspaceDir, ["rev-parse", "--show-toplevel"]);
  let currentPath = "";
  if (top) {
    const realTop = await realPathOf(top);
    // 两种形态都比：登记值可能是未解析的软链路径，也可能是解析后的。
    const hit = records.find(
      (record) => sameWorktreePath(record.path, top) || sameWorktreePath(record.path, realTop),
    );
    currentPath = hit ? hit.path : top;
  }
  if (!currentPath) {
    // 裸仓库没有 --show-toplevel；游离头下同一提交可能挂在多棵树上，先分支再 oid，最后才按第一条。
    const branch = await readRef(workspaceDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const oid = await readRef(workspaceDir, ["rev-parse", "HEAD"]);
    const byBranch = branch && branch !== "HEAD" ? records.find((record) => record.branch === branch) : undefined;
    const byOid = oid ? records.find((record) => record.head === oid) : undefined;
    const first = records[0];
    currentPath = (byBranch ?? byOid)?.path ?? (first ? first.path : "");
  }

  const keeps = shortestUniqueSuffix(records.map((record) => record.path));
  return {
    ok: true,
    worktrees: records.map((record, index) => ({
      ...record,
      display: displayFor(record.path, keeps[index] ?? 1),
      current: currentPath !== "" && sameWorktreePath(record.path, currentPath),
    })),
  };
}
