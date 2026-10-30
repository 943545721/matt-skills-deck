import type { BoardIssue } from "../../../shared/issues";

/**
 * 地图（父票）→ 子票的分组，纯计算。
 *
 * 为什么单独一个文件：这件事只跟「谁是子票」有关，与 React、与拉取无关；
 * 单独成文件才能被 node 直接测——「同一张图里少了一张票」这种错，
 * 在界面上扫一遍是看不出来的。
 *
 * 四条口径：
 * 1. 父子关系只认服务端给的 `parentKey`（GitHub 原生 sub-issue / GitLab part-of /
 *    本地 fallback 的 `DSH-PARENT`），不从标签或标题猜。
 * 2. `parentKey` 指向的票不在这一屏里（被筛选掉、或翻页还没拉到）时，子票留在顶层。
 *    宁可看起来是平铺，也不能让票凭空消失。
 * 3. 只认一层：子票自己的子票压平在它下面，不再多缩进一级。
 *    真正的层级与每层进度在地图页看，列表不重复那件事。
 * 4. 坏数据（自己挂自己、互相挂成环）不吞掉任何一行，只是不缩进。
 */

/** 一行在屏上的身份：仓库键 + 票号。票号只在仓库内唯一，合板时必须带仓库。 */
export function rowKeyOf(item: { repoKey: string; number: number }): string {
  return `${item.repoKey}#${item.number}`;
}

export interface BoardRow {
  item: BoardIssue;
  /** 1 = 子票：界面上缩进并画一道竖线。 */
  depth: 0 | 1;
  /** 只出现在「当前屏上还有子票」的父行：子票张数（按当前筛选算）。 */
  childCount?: number;
  /** 父行才有：现在是否展开。折叠时子票不出现在 rows 里。 */
  expanded?: boolean;
}

/**
 * 父票号 → 整行的键。
 *
 * GitHub 的 `parent{number}` 只给数字（同一个仓库），跨仓库引用才会带 `owner/repo#N`。
 * 两种都收：认错了会让子票挂到别的仓库的同号票上去，那是最坏的一种错。
 */
function parentRowKey(parentKey: string, item: BoardIssue): string {
  const trimmed = parentKey.trim();
  return trimmed.includes("#") ? trimmed : `${item.repoKey}#${trimmed}`;
}

export function groupRows(items: readonly BoardIssue[], collapsed: ReadonlySet<string>): BoardRow[] {
  const present = new Set(items.map(rowKeyOf));
  const childrenOf = new Map<string, BoardIssue[]>();
  for (const item of items) {
    const parent = item.parentKey?.trim();
    if (!parent) continue;
    const key = parentRowKey(parent, item);
    // 父票不在这一屏：留在顶层（口径 2）。
    if (!present.has(key)) continue;
    // 自己挂自己：坏数据，不挂（口径 4）。
    if (key === rowKeyOf(item)) continue;
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(item);
    else childrenOf.set(key, [item]);
  }

  const rows: BoardRow[] = [];
  // 已经被当作某张父票的子票吐出去的行，不再单独出现一次。
  const emitted = new Set<string>();
  // 被折叠起来的子树：不发出去，但也不能让外层循环把它们当成顶层票再发一遍。
  const suppressed = new Set<string>();

  const suppress = (item: BoardIssue): void => {
    const key = rowKeyOf(item);
    if (suppressed.has(key)) return;
    suppressed.add(key);
    for (const kid of childrenOf.get(key) ?? []) suppress(kid);
  };

  const emit = (item: BoardIssue, depth: 0 | 1): void => {
    const key = rowKeyOf(item);
    if (emitted.has(key) || suppressed.has(key)) return;
    emitted.add(key);
    const kids = childrenOf.get(key) ?? [];
    if (depth === 0 && kids.length > 0) {
      const expanded = !collapsed.has(key);
      rows.push({ item, depth, childCount: kids.length, expanded });
      if (!expanded) {
        for (const kid of kids) suppress(kid);
        return;
      }
    } else {
      rows.push({ item, depth });
    }
    // 子票按父级顺序落位；孙票压平到 depth 1（口径 3）。
    for (const kid of kids) emit(kid, 1);
  };

  // 顶层顺序沿用传进来的顺序（服务端已按「地图票优先 → 未关闭优先 → 最近更新」排好）。
  // 子票已经在父票那一轮吐过，这里跳过。
  for (const item of items) emit(item, 0);
  return rows;
}

/** 当前屏上有子票的父票键：给「全部收起 / 全部展开」用。 */
export function parentKeys(items: readonly BoardIssue[]): string[] {
  const present = new Set(items.map(rowKeyOf));
  const keys = new Set<string>();
  for (const item of items) {
    const parent = item.parentKey?.trim();
    if (!parent) continue;
    const key = parentRowKey(parent, item);
    if (present.has(key) && key !== rowKeyOf(item)) keys.add(key);
  }
  return [...keys];
}
