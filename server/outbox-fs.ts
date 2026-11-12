import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { record } from "./logs.ts";

/**
 * outbox（交接件、窗口条子）共用的落盘动作。
 *
 * 两条队列形状一样：`<工作区>/.deck/<队列>/<box>/<id>.json`，三个箱子
 * pending / sent / failed，写要原子、搬箱子要先写后删。这里只放**与内容无关**的那半，
 * 读盘校验仍归各自的 store——每份信封的字段契约不同，合成一个泛型读法只会把校验藏起来。
 */

/** 文件在不在。只把「不存在」当 false；其余 errno（EACCES、EMFILE…）照抛——吞掉会变成重复投递。 */
export async function outboxFileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 临时文件与目标同目录，rename 才是原子的（跨盘 rename 会退化成复制）。 */
function tempPathOf(file: string): string {
  return `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = tempPathOf(file);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export interface OutboxLogMeta {
  /** 日志作用域，例如 `dispatch.handoff`。 */
  readonly scope: string;
  /** 日志里的人话名字，例如「交接件」。 */
  readonly label: string;
}

/**
 * 读一个箱子里的全部信封，按 `createdAt` 再按 id 稳定排序。
 *
 * 目录不存在算空队列；单个文件坏了跳过并留日志——一份手改坏的文件不该堵死整条队列。
 * 读目录本身失败（不是 ENOENT）同样留日志返回空：调用方每次事件都会来读，抛出去只会刷屏。
 */
export async function readOutboxBox<T>(
  dir: string,
  parse: (raw: unknown) => T | null,
  idOf: (envelope: T) => string,
  createdAtOf: (envelope: T) => string,
  meta: OutboxLogMeta,
): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    record("warn", meta.scope, `读不到${meta.label} outbox：${dir}，${messageOf(error)}`);
    return [];
  }
  const out: T[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const envelope = parse(JSON.parse(await readFile(file, "utf8")) as unknown);
      if (!envelope) {
        record("warn", meta.scope, `${meta.label}形状不对，跳过：${file}`);
        continue;
      }
      out.push(envelope);
    } catch (error) {
      record("warn", meta.scope, `${meta.label}读不出来，跳过：${file}，${messageOf(error)}`);
    }
  }
  return out.sort((a, b) => createdAtOf(a).localeCompare(createdAtOf(b)) || idOf(a).localeCompare(idOf(b)));
}

/**
 * 搬箱子：先写目标再删源，中途崩了最多多一份，不会丢。
 *
 * 目标或源路径算不出来（id 不合规）时什么都不做——那说明文件名早就不是我们写的了。
 */
export async function moveOutboxFile<T>(
  source: string | null,
  target: string | null,
  envelope: T,
  id: string,
  box: string,
  meta: OutboxLogMeta,
): Promise<void> {
  if (!target || !source) return;
  try {
    await writeJsonAtomic(target, envelope);
    await unlink(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  } catch (error) {
    record("warn", meta.scope, `${meta.label} ${id} 移到 ${box}/ 失败：${messageOf(error)}`);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
