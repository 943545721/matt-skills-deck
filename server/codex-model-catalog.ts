import { execFile } from "node:child_process";
import { mkdir, rename, writeFile as writeFileRaw } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildCodexCatalog,
  hasReportedWindows,
  type CodexCatalogModelInput,
} from "../shared/codex-model-catalog.ts";
import { record } from "./logs.ts";

/**
 * 把接口报的模型窗口写成一份 Codex 认的模型目录文件。
 *
 * 为什么要落盘：Codex 的 `model_catalog_json` 是一个**路径**，得走命令行 `-c` 交给它
 * （`codex -c model_catalog_json="…" app-server`），会话才按这份目录算窗口与自动压缩阈值。
 * 不写这份文件，代理模型就继续按内置默认的 258k 算（详见 `shared/codex-model-catalog.ts`）。
 *
 * 为什么走 provider 的 `command` 而不是 `options`：宿主的 `CodexProviderOptionsSchema`
 * 是 `.strict()` 的，只认 `approval_policy` / `sandbox_mode` / `sandbox_workspace_write` /
 * `web_search` / `features`——往里塞 `model_catalog_json` 不是「不生效」，而是校验直接抛错、
 * Codex 会话建不起来。`command` 是宿主明说的「替换启动命令」入口，插件可以补参数。
 *
 * 三条纪律：
 * - 内置目录从 `codex debug models --bundled` 现读一次并缓存：本机装着哪个版本，
 *   就按哪个版本的形状写，不在这里硬编码 Codex 的字段；
 * - 接口没报窗口就**不写**（编一个出来等于把「不知道」换成「知道」）；
 * - 写失败只降级成告警：模型清单已经存好了，不能因为目录文件写不进去就整笔回滚。
 */

const SCOPE = "orchestration";

/** provider 条目 `options` 里的键名：Codex 读它当「本地模型目录」的路径。 */
export const CODEX_CATALOG_OPTION = "model_catalog_json";

/** 目录文件放在 Codex 自己的 home 里：和它读配置的地方同一处，路径最不容易对不上。 */
export const CODEX_CATALOG_FILE = "deck-model-catalog.json";

const BUNDLED_TIMEOUT_MS = 30_000;
const BUNDLED_CACHE_MS = 10 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;

export interface CodexCatalogDeps {
  /** 读内置目录（`codex debug models --bundled` 的回包）；测试里塞一份假的。 */
  readBundled?: () => Promise<unknown>;
  /** 写文件；测试里换成内存实现。 */
  writeFile?: (target: string, content: string) => Promise<void>;
  /** 目录文件落在哪；测试里指到临时目录。 */
  catalogPath?: () => string;
  /** 跑 codex 取回包；测试里不需要。 */
  runCodex?: (args: readonly string[]) => Promise<string>;
}

/** Codex 的 home：`CODEX_HOME` 优先，否则 `~/.codex`（宿主起 app-server 时用的也是这一份）。 */
export function codexHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.CODEX_HOME ?? "").trim();
  return configured || path.join(homedir(), ".codex");
}

export function codexCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codexHomeOf(env), CODEX_CATALOG_FILE);
}

function runCodexCli(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "codex",
      [...args],
      { timeout: BUNDLED_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: process.env },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

let bundledCache: { at: number; models: unknown } | null = null;

/** 内置目录：`--bundled` 不联网、不需要登录，纯粹是本机这个版本自带的那份清单。 */
export async function readBundledCodexCatalog(deps: CodexCatalogDeps = {}): Promise<unknown> {
  const now = Date.now();
  if (bundledCache && now - bundledCache.at < BUNDLED_CACHE_MS) return bundledCache.models;
  const run = deps.runCodex ?? runCodexCli;
  const stdout = await run(["debug", "models", "--bundled"]);
  const parsed: unknown = JSON.parse(stdout);
  bundledCache = { at: now, models: parsed };
  return parsed;
}

/** 只给测试用：缓存会把一份假目录留给后面的用例。 */
export function resetCodexCatalogCache(): void {
  bundledCache = null;
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFileRaw(temp, content, "utf8");
  await rename(temp, target);
}

/** 命令行里那一项：`-c model_catalog_json="<path>"`（值按 TOML 字符串写，路径带反斜杠也不炸）。 */
export function catalogFlagArgs(catalogPath: string): string[] {
  return ["-c", `model_catalog_json=${JSON.stringify(catalogPath)}`];
}

function isCatalogArg(arg: string): boolean {
  return /^model_catalog_json\s*=/.test(arg) || /^-cmodel_catalog_json\s*=/.test(arg);
}

/**
 * 把「目录路径」接进 Codex 的启动命令。
 *
 * 宿主的 provider 条目 `command` 是**替换**语义（`argv[0]` 是二进制，其余是参数），
 * 所以这里要保留用户原来的可执行文件与参数，只替换掉我们自己那一项——重存一次不该
 * 叠一个 `-c` 上去。原本没有 `command` 时用 `codex`：宿主找它用的也是 PATH 探测，同一条路。
 */
export function codexCommandWithCatalog(existing: unknown, catalogPath: string): string[] {
  const { argv } = argvWithoutCatalog(existing);
  return [...argv, ...catalogFlagArgs(catalogPath)];
}

function argvWithoutCatalog(existing: unknown): { argv: string[]; removed: boolean } {
  const raw = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  const binary = raw[0] ?? "codex";
  const rest: string[] = [];
  let removed = false;
  for (let index = 1; index < raw.length; index += 1) {
    const arg = raw[index] as string;
    if (isCatalogArg(arg)) {
      removed = true;
      continue;
    }
    const next = raw[index + 1];
    if (arg === "-c" && typeof next === "string" && isCatalogArg(next)) {
      removed = true;
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  return { argv: [binary, ...rest], removed };
}

/**
 * 去掉我们接进去的目录参数。
 *
 * 接口换了地址、新地址还没拿到窗口时，旧的模型目录不能继续生效——它装着上一个接口的窗口，
 * 会话会按错误的上限压缩。没有这段参数时返回 `undefined`，调用方不必白白改写 `command`。
 */
export function codexCommandWithoutCatalog(existing: unknown): string[] | undefined {
  const { argv, removed } = argvWithoutCatalog(existing);
  return removed ? argv : undefined;
}

/** 从一条 `command` 里读回我们写进去的目录路径（读回校验用）。 */
export function catalogPathOfCommand(argv: unknown): string | undefined {
  if (!Array.isArray(argv)) return undefined;
  for (const arg of argv) {
    if (typeof arg !== "string" || !isCatalogArg(arg)) continue;
    const raw = arg.slice(arg.indexOf("=") + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw.slice(1, -1);
      }
    }
    return raw;
  }
  return undefined;
}

export type CodexCatalogWriteResult =
  | { ok: true; path: string; models: number }
  | { ok: false; reason: "no-window" | "no-catalog" | "write-failed"; detail: string };

/**
 * 写一份模型目录并返回它的路径。
 *
 * 调用方拿到 `ok` 才把路径写进 provider 条目的 `options`；拿不到就别动那份配置
 * ——指一个不存在的文件，Codex 会直接拒绝起会话。
 */
export async function writeCodexModelCatalog(
  models: readonly CodexCatalogModelInput[],
  deps: CodexCatalogDeps = {},
): Promise<CodexCatalogWriteResult> {
  if (!hasReportedWindows(models)) {
    return {
      ok: false,
      reason: "no-window",
      detail: "接口没报上下文窗口：不写目录文件（写了也只是把 Codex 的默认值抄一遍）",
    };
  }
  let bundled: unknown;
  try {
    bundled = await (deps.readBundled ?? readBundledCodexCatalog)();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    record("warn", SCOPE, `读 Codex 内置模型目录失败：${detail}`);
    return { ok: false, reason: "no-catalog", detail: `读不到本机 Codex 的模型目录：${detail}` };
  }
  const catalog = buildCodexCatalog(bundled, models);
  if (!catalog) {
    return { ok: false, reason: "no-catalog", detail: "内置目录为空，合成不出可用的模型目录" };
  }
  const target = (deps.catalogPath ?? codexCatalogPath)();
  try {
    await (deps.writeFile ?? writeFileAtomic)(target, `${JSON.stringify(catalog)}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    record("warn", SCOPE, `写 Codex 模型目录失败：${target} → ${detail}`);
    return { ok: false, reason: "write-failed", detail: `写不进 ${target}：${detail}` };
  }
  record("info", SCOPE, `Codex 模型目录已更新：${target}（${catalog.models.length} 个模型，含接口报的窗口）`);
  return { ok: true, path: target, models: catalog.models.length };
}
