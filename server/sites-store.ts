/**
 * 站点表的落盘层。
 *
 * 位置：`<PASEO_HOME 或 ~/.paseo>/matt-skills-deck/sites.json`（与工作路线台账同一个数据目录）。
 * 不写用户仓库：里面是凭证明文，进被 git 跟踪的目录等于泄漏。
 *
 * 三条约束（与台账一致）：
 * - 原子写：临时文件 + rename，读到一半崩溃不会留下半篇 JSON。
 * - 单写者：写路线在进程内串行（读 → 改 → 写），避免两次点击互相覆盖。
 * - 坏文件不静默覆盖：解析失败就报错，不拿空表继续——空表意味着「所有客户端都没站点」。
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { EMPTY_SITE_BOOK, normalizeBook, type SiteBook } from "../shared/sites.ts";
import { ledgerRoot } from "./ledger.ts";

export type SiteBookRead =
  | { ok: true; book: SiteBook; dropped: number }
  | { ok: false; detail: string };

/** 站点表文件位置；`homeDir` 只给测试用（与 `PASEO_HOME` 同义）。 */
export function sitesFile(homeDir?: string): string {
  return path.join(ledgerRoot(homeDir), "sites.json");
}

export async function readSiteBook(homeDir?: string): Promise<SiteBookRead> {
  const file = sitesFile(homeDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, book: EMPTY_SITE_BOOK, dropped: 0 };
    }
    return { ok: false, detail: `${file}：${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      detail: `${file} 解析失败：${error instanceof Error ? error.message : String(error)}（修好它或删掉重来，不能当空表处理）`,
    };
  }
  const { book, dropped } = normalizeBook(parsed);
  return { ok: true, book, dropped };
}

/** 写路线串行：两次点击同一份文件不会读到彼此写了一半的状态。 */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * 读 → 改 → 写。
 *
 * `mutator` 必须是纯的（返回新书，不改入参）；传进来的书已经过归一化，
 * 所以手写坏的条目不会在写回时被当成合法内容留下来。
 */
export async function updateSiteBook(
  mutator: (book: SiteBook) => SiteBook,
  homeDir?: string,
): Promise<SiteBookRead> {
  const run = async (): Promise<SiteBookRead> => {
    const read = await readSiteBook(homeDir);
    if (!read.ok) return read;
    const next = mutator(read.book);
    const file = sitesFile(homeDir);
    const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      return { ok: false, detail: `写不进去 ${file}：${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, book: next, dropped: read.dropped };
  };
  const staged = writeQueue.then(run, run);
  writeQueue = staged.catch(() => undefined);
  return staged;
}
