import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 一个技能目录的完整内容：相对路径 → 字节。
 *
 * 技能不只有 `SKILL.md`：上游常见的写法是主文件 + `references/` + `examples/`，
 * 少一个附属文件，技能正文里的相对链接就断了。所以装卸、比对、回收都按整棵目录走，
 * 不再只认那一个文件。
 *
 * 点开头的条目（`.DS_Store`、`.git`）跳过：它们不是技能的一部分，装过去只会污染工作区。
 */
export function readSkillTree(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.set(rel, readFileSync(abs));
      }
    }
  };
  walk(root, "");
  return out;
}

/** 目录存在且是目录：不存在与「是文件」都当没有，由调用方给状态。 */
export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 两份内容是否逐字节一致。
 *
 * 只比 `expected` 里的文件：目标目录多出来的文件是用户自己放的笔记或别的插件的产物，
 * 不归我们管，也不该让安装状态永远显示「不一致」。
 */
export function treeMatches(expected: Map<string, Buffer>, actual: Map<string, Buffer>): boolean {
  for (const [rel, data] of expected) {
    const hit = actual.get(rel);
    if (!hit || !hit.equals(data)) return false;
  }
  return true;
}

/** 两份内容是否完全一致（文件集合与字节都相同），回收时判断两个客户端目录是否对齐用。 */
export function sameTree(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  return treeMatches(a, b);
}
