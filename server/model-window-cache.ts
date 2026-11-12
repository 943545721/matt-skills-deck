import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MODEL_WINDOW_CACHE_FILE,
  emptyModelWindowCache,
  normalizeModelWindowBaseUrl,
  parseModelWindowCacheChecked,
  rememberFetchedModelWindows,
  type ModelWindowCache,
  type WindowedModel,
} from "../shared/model-window-cache.ts";
import { record } from "./logs.ts";

/**
 * 接口窗口缓存落在工作区 `.deck/model-windows.json`。
 *
 * 放在工作区而不是家目录：同一台机器可能开着几个项目、接不同的接口；
 * 这份文件也不进库（`.deck/` 已在 `.gitignore`），属于运行时状态。
 *
 * 只写模型 id、接口地址与窗口；凭据一律不进这份文件。
 */

const SCOPE = "orchestration";

/**
 * 同一个工作区的缓存写入串行化。
 *
 * 写缓存是「读整份 → 改一个 provider → 整份写回」：两次拉取并发时会各自读到同一份旧快照，
 * 后写的把另一个 provider 的条目静默盖掉（rename 保证文件不坏，但内容少了）。
 * 这个进程内的队列按文件路径排队，最后一次写入一定看到前一次的结果。
 */
const cacheWriteQueues = new Map<string, Promise<unknown>>();

function enqueueCacheWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = cacheWriteQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  cacheWriteQueues.set(key, settled);
  void settled.then(() => {
    if (cacheWriteQueues.get(key) === settled) cacheWriteQueues.delete(key);
  });
  return run;
}

export interface ModelWindowCacheRead {
  cache: ModelWindowCache;
  /** 读失败时的告警；文件不存在是正常情况，不算告警。 */
  warning: string | null;
}

export function modelWindowCachePath(workspaceDir: string): string {
  return path.join(workspaceDir, ".deck", MODEL_WINDOW_CACHE_FILE);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * 读工作区里的缓存。
 *
 * 没有工作区、文件不存在、内容坏了都退回空缓存：缓存只是「让窗口活得更久」，
 * 它不该挡住保存或状态页。坏文件单独告警，用户至少知道为什么这次没有接口窗口。
 */
export async function readModelWindowCache(workspaceDir: string | undefined): Promise<ModelWindowCacheRead> {
  const dir = (workspaceDir ?? "").trim();
  if (!dir) return { cache: emptyModelWindowCache(), warning: null };
  const target = modelWindowCachePath(dir);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { cache: emptyModelWindowCache(), warning: null };
    const detail = error instanceof Error ? error.message : String(error);
    record("warn", SCOPE, `读接口窗口缓存失败：${target} → ${detail}`);
    return { cache: emptyModelWindowCache(), warning: `接口窗口缓存读不出来（${target}）：${detail}` };
  }
  try {
    const parsed = parseModelWindowCacheChecked(JSON.parse(raw));
    if (parsed.malformed) {
      record("warn", SCOPE, `接口窗口缓存形状不认识：${target}`);
      return {
        cache: parsed.cache,
        warning: `接口窗口缓存不是插件写的形状（${target}）：这次按没有缓存处理，重新获取一次模型即可覆盖`,
      };
    }
    return { cache: parsed.cache, warning: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    record("warn", SCOPE, `接口窗口缓存解析失败：${target} → ${detail}`);
    return {
      cache: emptyModelWindowCache(),
      warning: `接口窗口缓存格式不对（${target}）：${detail}；这次按没有缓存处理，重新获取一次模型即可覆盖`,
    };
  }
}

/**
 * 把一次成功拉取记进缓存，返回给界面看的告警（成功时为 null）。
 *
 * 失败不抛：模型清单已经拿到了，缓存写不进去不该让「获取模型」失败。
 * 但要回一句告警——否则用户看到「获取成功」，之后保存却悄悄丢掉窗口。
 */
export async function saveFetchedModelWindows(input: {
  workspaceDir: string | undefined;
  provider: string;
  baseUrl: string;
  models: readonly WindowedModel[];
}): Promise<string | null> {
  const dir = (input.workspaceDir ?? "").trim();
  if (!dir) {
    // 没工作区就没处落盘。别一声不吭：调用方会看到「获取成功」，之后保存却悄悄丢窗口。
    record("warn", SCOPE, `没有工作区目录：${input.provider} 的接口窗口没有缓存`);
    return "这次没有工作区目录，接口窗口没缓存下来；之后保存模型时可能拿不到窗口";
  }
  const baseUrl = normalizeModelWindowBaseUrl(input.baseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) {
    record("warn", SCOPE, `接口地址不成形：${input.provider} 的接口窗口没有缓存`);
    return "这次拿到的接口地址不成形，接口窗口没缓存下来；之后保存模型时可能拿不到窗口";
  }
  const target = modelWindowCachePath(dir);
  return enqueueCacheWrite(target, async () => {
    try {
      const existing = await readModelWindowCache(dir);
      const next = rememberFetchedModelWindows(existing.cache, {
        provider: input.provider,
        baseUrl,
        models: input.models,
      });
      await mkdir(path.dirname(target), { recursive: true });
      // 临时文件名带随机后缀：两个 provider 同时拉取时不会互相覆盖同一份临时文件。
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(temp, target);
      record("info", SCOPE, `接口窗口已缓存：${input.provider} ${baseUrl}（${next.providers[input.provider.trim()]?.models.length ?? 0} 个模型）`);
      return null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record("warn", SCOPE, `写接口窗口缓存失败：${target} → ${detail}`);
      return `模型清单已经拿到，但接口窗口没能缓存到 ${target}：${detail}；之后保存模型时可能仍拿不到窗口`;
    }
  });
}
