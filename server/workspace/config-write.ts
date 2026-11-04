import { createHash } from "node:crypto";
import { access, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isProjectKey,
  isSafeProjectDir,
  parseWorkspaceConfigText,
  PROJECT_CONFIG_FILE,
  SKILL_MODES,
  WORKSPACE_SHAPES,
  type SkillMode,
  type WorkspaceShape,
} from "../../shared/workspace-projects.ts";
import type { ProjectDraft } from "../../shared/repo.ts";
import { readWorkspaceConfig } from "../tracker/workspace-repo.ts";

/**
 * 往 `.paseo-deck.json` 写东西的两条路。
 *
 * 一条只记 `coordination.shape`（「这些项目就这么放一起」），一条整份写项目清单。
 * 两条共用同一套护栏：写前按读路径解析、旧文件先备份、落盘走临时文件 + rename、
 * 写完读回核对。宁可报错也不留下半份文件——这份配置一坏，任务板、标签、技能矩阵
 * 三处会同时失去依据。
 */

export type AcknowledgeResult =
  | { ok: true; shape: WorkspaceShape }
  | { ok: false; reason: "invalid" | "no-config" | "v1" | "write-failed"; detail: string };

export async function acknowledgeShape(workspaceDir: string, shape: WorkspaceShape): Promise<AcknowledgeResult> {
  if (!(WORKSPACE_SHAPES as readonly string[]).includes(shape)) {
    return { ok: false, reason: "invalid", detail: `只认 ${WORKSPACE_SHAPES.join(" / ")}，收到：${String(shape)}` };
  }

  const read = await readWorkspaceConfig(workspaceDir);
  if (!read.ok) {
    if (read.reason === "missing") {
      return {
        ok: false,
        reason: "no-config",
        detail: `还没有 ${PROJECT_CONFIG_FILE}：先写好项目清单，再记「这几个项目算一套」`,
      };
    }
    return { ok: false, reason: "invalid", detail: read.detail };
  }
  if (read.config.version !== 2) {
    return {
      ok: false,
      reason: "v1",
      detail: `${PROJECT_CONFIG_FILE} 还是 v1（只有一个 repoDir）：写成 v2 的项目清单之后，才能记下这层关系`,
    };
  }

  const file = path.join(workspaceDir, PROJECT_CONFIG_FILE);
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "invalid", detail: `${PROJECT_CONFIG_FILE} 不是一个对象` };
    }
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: "invalid", detail: `读 ${PROJECT_CONFIG_FILE} 失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const coordination = raw.coordination && typeof raw.coordination === "object" && !Array.isArray(raw.coordination)
    ? { ...(raw.coordination as Record<string, unknown>) }
    : {};
  const next = { ...raw, coordination: { ...coordination, shape } };

  const writeResult = await writeAtomically(file, `${JSON.stringify(next, null, 2)}\n`);
  if (!writeResult.ok) {
    return { ok: false, reason: "write-failed", detail: writeResult.detail };
  }
  return { ok: true, shape };
}

// ---------------------------------------------------------------------------
// 项目清单
// ---------------------------------------------------------------------------

/**
 * 配置正文的指纹。
 *
 * 面板读清单时拿到它，保存时带回来；对不上就是「别人刚改过」。用内容哈希而不是
 * mtime：编辑器保存一份内容完全相同的文件不该报冲突。
 */
export function configFingerprintOf(text: string | null): string {
  if (text === null) return "missing";
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 读一次文件正文；不存在给 `null`，其它读失败直接抛给调用方分类。 */
export async function readConfigText(workspaceDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(workspaceDir, PROJECT_CONFIG_FILE), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

export type SaveProjectsResult =
  | {
      ok: true;
      path: string;
      backup: string | null;
      fingerprint: string;
      projects: ProjectDraft[];
      warnings: string[];
    }
  | { ok: false; reason: "invalid" | "stale" | "write-failed"; detail: string };

/** 去掉首尾空白与目录尾部的斜杠：同一行在校验、比对、落盘三处都用这一份。 */
function normalizeDraft(row: ProjectDraft): ProjectDraft {
  return {
    key: row.key.trim(),
    dir: row.dir.trim().replace(/\/+$/, ""),
    skillsMode: row.skillsMode,
  };
}

/** 逐行校验：错在哪一行哪一位要说清楚，不能只回一句「格式不对」。 */
function validateDrafts(drafts: readonly ProjectDraft[]): { ok: true } | { ok: false; detail: string } {
  const keys = new Set<string>();
  const dirs = new Set<string>();
  for (let index = 0; index < drafts.length; index += 1) {
    const row = drafts[index] as ProjectDraft;
    const where = `第 ${index + 1} 行`;
    if (!isProjectKey(row.key)) {
      return { ok: false, detail: `${where}的项目键「${row.key.slice(0, 40)}」不合法：只能是小写字母、数字与连字符，1–64 位，且以字母数字开头` };
    }
    if (!isSafeProjectDir(row.dir)) {
      return { ok: false, detail: `${where}（${row.key}）的目录「${row.dir.slice(0, 80)}」必须是工作区内的相对路径，不能是绝对路径、不能有 .. 段` };
    }
    if (row.skillsMode !== null && !(SKILL_MODES as readonly string[]).includes(row.skillsMode)) {
      return { ok: false, detail: `${where}（${row.key}）的 skillsMode「${String(row.skillsMode).slice(0, 20)}」只认 ${SKILL_MODES.join(" / ")} 或 null` };
    }
    if (keys.has(row.key)) return { ok: false, detail: `项目键重复：${row.key}` };
    if (dirs.has(row.dir)) return { ok: false, detail: `项目目录重复：${row.dir}（一个目录只能挂一个项目）` };
    keys.add(row.key);
    dirs.add(row.dir);
  }
  return { ok: true };
}

/**
 * 目录存不存在的清单，只给警告用——项目可能还没 clone 下来，不算错。
 *
 * 只把「不存在」当成不存在：权限不够、句柄耗尽这些读不动的错误必须往上抛，
 * 否则会报成「目录不存在」，人被指向一个根本不对的方向。
 */
async function missingDirs(workspaceDir: string, rows: readonly ProjectDraft[]): Promise<string[]> {
  const missing: string[] = [];
  for (const row of rows) {
    try {
      await stat(path.join(workspaceDir, row.dir));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        missing.push(row.dir);
        continue;
      }
      throw error;
    }
  }
  return missing;
}

/** 写临时文件再 rename；失败时把临时文件清掉，别在工作区里留垃圾。 */
async function writeAtomically(file: string, text: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
    return { ok: true };
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 备份名带时间戳（精确到毫秒）。
 *
 * 只到秒的话，同一秒里连按两次保存会把上一份备份覆盖掉——备份的意义正是留下
 * 「改之前长什么样」，被覆盖就等于没留。毫秒仍可能撞（两次保存落在同一毫秒），
 * 所以真正落盘前还要探一个没被占用的名字，见 `backupCurrent`。
 */
function backupName(stamp: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const day = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`;
  const time = `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  return `${PROJECT_CONFIG_FILE}.bak.${day}-${time}-${pad(stamp.getMilliseconds(), 3)}`;
}

/** 探测一个还没被占用的备份名；撞了就加序号，序号在时间戳后面，仍按时间排序。 */
async function freeBackupPath(workspaceDir: string, stamp: Date): Promise<string | null> {
  const base = backupName(stamp);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    const candidate = path.join(workspaceDir, name);
    try {
      await access(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // 只有「不存在」才算这个名字空着；读不动（EACCES 等）照实往外抛，
      // 不能当成「名字可用」，否则真正的权限问题会被说成「写入失败」。
      if (code === "ENOENT" || code === "ENOTDIR") return candidate;
      throw error;
    }
  }
  return null;
}

/**
 * 把编辑器给的行合并进旧文件的骨架。
 *
 * 同一个项目键那一行，旧文件里的 `repo` / `owner` / `areas` / `deprecatedAreas` 一律搬过来
 * ——编辑器只改它认识的三格，别顺手把别人写的东西抹掉。顶层同理：`coordination`、
 * `repoDir` 这些不认识的字段一个不动。
 */
function mergeProjectRows(raw: Record<string, unknown>, rows: readonly ProjectDraft[]): Record<string, unknown> {
  const previous = Array.isArray(raw.projects) ? raw.projects : [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of previous) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const key = (item as Record<string, unknown>).key;
    if (typeof key === "string") byKey.set(key, item as Record<string, unknown>);
  }
  const projects = rows.map((row) => ({ ...(byKey.get(row.key) ?? {}), ...row }));
  return { ...raw, version: 2, projects };
}

/** 旧文件进备份；没有旧文件时不算失败，直接返回 null。 */
async function backupCurrent(
  workspaceDir: string,
  current: string | null,
  now: Date,
): Promise<{ ok: true; backup: string | null } | { ok: false; detail: string }> {
  if (current === null) return { ok: true, backup: null };
  let backup: string | null;
  try {
    backup = await freeBackupPath(workspaceDir, now);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (backup === null) {
    return { ok: false, detail: `备份名连续 50 次都被占用（${backupName(now)}），旧文件没被覆盖` };
  }
  const written = await writeAtomically(backup, current);
  if (!written.ok) return { ok: false, detail: written.detail };
  return { ok: true, backup };
}

/**
 * 读回旧正文并与调用方带来的指纹比一遍。
 *
 * 指纹对不上就是「别处刚改过」：这时候停下来，比把对方的改动盖掉要好。
 */
async function readCurrentForSave(
  workspaceDir: string,
  expectedFingerprint: string | undefined,
): Promise<{ ok: true; current: string | null; fingerprint: string } | { ok: false; reason: "stale" | "write-failed"; detail: string }> {
  let current: string | null;
  try {
    current = await readConfigText(workspaceDir);
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      detail: `读 ${PROJECT_CONFIG_FILE} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const fingerprint = configFingerprintOf(current);
  if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) {
    return {
      ok: false,
      reason: "stale",
      detail: `${PROJECT_CONFIG_FILE} 已经被别处改过（读的时候是 ${expectedFingerprint.slice(0, 12)}，现在是 ${fingerprint.slice(0, 12)}）：重新读一遍再改`,
    };
  }
  return { ok: true, current, fingerprint };
}

/**
 * 原子写配置，然后真的读回来一次。
 *
 * 文件被截断、目录换挂这类事，只有读回来才看得见；回读内容与要写的不一致就当失败。
 */
async function writeConfigVerified(workspaceDir: string, text: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const written = await writeAtomically(path.join(workspaceDir, PROJECT_CONFIG_FILE), text);
  if (!written.ok) return { ok: false, detail: written.detail };

  let onDisk: string | null;
  try {
    onDisk = await readConfigText(workspaceDir);
  } catch (error) {
    return { ok: false, detail: `写完回读失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const expected = configFingerprintOf(text);
  const actual = configFingerprintOf(onDisk);
  if (actual !== expected) {
    return {
      ok: false,
      detail: `写完回读的内容与要写的不一致（期望 ${expected.slice(0, 12)}，实际 ${actual.slice(0, 12)}）：请检查 ${PROJECT_CONFIG_FILE}`,
    };
  }
  return { ok: true };
}

/**
 * 整份写项目清单。
 *
 * 顺序固定：规范化 → 校验 → 读旧文件 → 比指纹 → 算警告 → 合并 → 自查 → 备份 → 原子写 → 读回核对。
 * 任何一步不过就停，且一律停在「旧文件原样还在」这一侧。
 */
export async function saveProjectList(
  workspaceDir: string,
  drafts: readonly ProjectDraft[],
  expectedFingerprint?: string,
  now: Date = new Date(),
): Promise<SaveProjectsResult> {
  const rows = drafts.map(normalizeDraft);
  const checked = validateDrafts(rows);
  if (!checked.ok) return { ok: false, reason: "invalid", detail: checked.detail };

  const read = await readCurrentForSave(workspaceDir, expectedFingerprint);
  if (!read.ok) return read;

  const warnings: string[] = [];
  const raw = parseExisting(read.current, warnings);

  let missing: string[];
  try {
    missing = await missingDirs(workspaceDir, rows);
  } catch (error) {
    return { ok: false, reason: "write-failed", detail: `检查项目目录失败，没写新内容：${error instanceof Error ? error.message : String(error)}` };
  }

  const text = `${JSON.stringify(mergeProjectRows(raw, rows), null, 2)}\n`;

  // 落盘前先按读路径解析一遍：生成的东西自己都读不回来，就别写进用户的工作区。
  const verify = parseWorkspaceConfigText(text);
  if (!verify.ok) {
    return { ok: false, reason: "invalid", detail: `生成的清单自己都读不回来（${verify.reason}）：${verify.detail}` };
  }

  const backedUp = await backupCurrent(workspaceDir, read.current, now);
  if (!backedUp.ok) {
    return { ok: false, reason: "write-failed", detail: `备份 ${PROJECT_CONFIG_FILE} 失败，没写新内容：${backedUp.detail}` };
  }

  const written = await writeConfigVerified(workspaceDir, text);
  if (!written.ok) return { ok: false, reason: "write-failed", detail: `写 ${PROJECT_CONFIG_FILE} 失败：${written.detail}` };

  return {
    ok: true,
    path: path.join(workspaceDir, PROJECT_CONFIG_FILE),
    backup: backedUp.backup,
    fingerprint: configFingerprintOf(text),
    projects: rows,
    warnings: [...warnings, ...collectWarnings(rows, missing)],
  };
}

/** 清单本身写得进去、但值得说一声的地方：空清单会退回单仓库，目录还没建则矩阵会标出来。 */
function collectWarnings(rows: readonly ProjectDraft[], missing: readonly string[]): string[] {
  const warnings: string[] = [];
  if (rows.length === 0) warnings.push("清单是空的：界面会按单仓库模式回退");
  if (missing.length) warnings.push(`目录还不存在：${missing.join("、")}（可以先建项目，之后技能矩阵会标出来）`);
  return warnings;
}

/** 旧文件读成对象骨架；坏 JSON / 不是对象时回车一份空骨架，并留一句警告。 */
function parseExisting(current: string | null, warnings: string[]): Record<string, unknown> {
  if (current === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    // 坏 JSON 允许覆盖（否则界面里永远修不好），但要说出来，备份也已经在下面落好。
    warnings.push(`原来的 ${PROJECT_CONFIG_FILE} 不是合法 JSON：已整份替换（旧文件留在备份里）`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`原来的 ${PROJECT_CONFIG_FILE} 不是一个对象：已整份替换（旧文件留在备份里）`);
    return {};
  }
  return parsed as Record<string, unknown>;
}
