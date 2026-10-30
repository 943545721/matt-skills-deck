/**
 * 「需求票 → 地图票」这条引用边的读写。
 *
 * 为什么需要它：这套模型原本只有三种关系——归属（parent）、顺序（`Blocked by:`）、
 * 类型（`wayfinder:*` 标签）。需求票只多一个 `requirement` 标签，于是「这张地图是从哪条
 * 需求长出来的」在数据里根本不存在：板子按 `parentKey` 分组，读不到这层关系，需求票就只好
 * 单独占一行。
 *
 * 为什么写成正文固定行而不是新的后端字段：GitHub 没有「衍生自」这种原生关系，GitLab 的
 * Link API 也没接。跨仓库依赖已经在用正文固定行（`Blocked by:`），照同一套做法不引入第二
 * 种机制——用编辑器能改，用 grep 能找到，人读得懂。
 *
 * 只写一行、只认一张：重复调用是覆盖，不是叠加。
 */

/** 固定前缀。解析与重写共用同一份，改这里就是改契约。 */
export const DERIVED_FROM_PREFIX = "Derived from:";

const DERIVED_FROM_LINE = /^Derived from:[ \t]*#(\d+)[ \t]*$/m;

/**
 * 地图正文里的 `Derived from: #19` → 19。
 *
 * 解析不了（没有这一行、写成 `#abc`、票号 0 或负数）一律返回 null：
 * 宁可显示「没有来源」，也不猜一个票号去挂——挂错了是把两张不相干的票连起来。
 */
export function parseDerivedFrom(body: string): number | null {
  const match = DERIVED_FROM_LINE.exec(body);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * 把来源写进地图正文。
 *
 * 已有这一行就原地换掉（保持它在原来的位置，不把它挪到别处去），没有就放在最前面：
 * 地图的五个区块靠 `## ` 标题切分，标题之前单独一行不会挤进任何区块。
 */
export function withDerivedFrom(body: string, source: number): string {
  const line = `${DERIVED_FROM_PREFIX} #${source}`;
  if (DERIVED_FROM_LINE.test(body)) return body.replace(/^Derived from:.*$/m, line);
  const rest = body.replace(/^\n+/, "");
  return rest ? `${line}\n\n${rest}` : `${line}\n`;
}
