export interface SkillMeta {
  name: string;
  description: string;
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * 解析技能文件头部的 `---` 块。
 *
 * 只认最简单的 `key: value` 行，因为上游 27 个技能只用到 name 与 description；
 * 写一个完整的 YAML 解析器既没必要，也会和「读到的就是作者写的那行」这个目标跑偏。
 * 解析不出 name 或 description 时返回 null，由调用方当作「这份技能不合格」处理，
 * 而不是补一个空字符串假装成功。
 */
export function parseSkillFrontmatter(text: string): SkillMeta | null {
  const block = FRONTMATTER_BLOCK.exec(text);
  if (!block) return null;

  const fields = new Map<string, string>();
  for (const line of (block[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    fields.set(key, unquote(line.slice(separator + 1).trim()));
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return null;
  return { name, description };
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  return quoted && value.length >= 2 ? value.slice(1, -1) : value;
}
