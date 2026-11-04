import type { BoardIssue } from "../../../shared/issues";

/**
 * 地图（父票）→ 子票的分组，纯计算。
 *
 * 为什么单独一个文件：这件事只跟「谁是子票」有关，与 React、与拉取无关；
 * 单独成文件才能被 node 直接测——「同一张图里少了一张票」这种错，
 * 在界面上扫一遍是看不出来的。
 *
 * 三条口径：
 * 1. 父子关系只认服务端给的 `parentKey`（GitHub 原生 sub-issue / GitLab part-of /
 *    本地 fallback 的 `DSH-PARENT`；地图的「来自需求」由服务端翻成 parentKey），
 *    不从标签或标题猜。
 * 2. `parentKey` 指向的票不在这一屏里（被筛选掉、或翻页还没拉到）时，子票留在顶层。
 *    宁可看起来是平铺，也不能让票凭空消失。
 * 3. 层数不设死：需求 → 地图 → 票就是三层，再往下也照样缩进。坏数据（自己挂自己、
 *    互相挂成环）靠「已经吐过的不再吐」兜住，一行都不吞。
 */

/** 缩进上限：再深就不是树，是数据坏了。到这一层就平铺，不吞票。 */
const MAX_DEPTH = 8;

/** 一行在屏上的身份：仓库键 + 票号。票号只在仓库内唯一，合板时必须带仓库。 */
export function rowKeyOf(item: { repoKey: string; number: number }): string {
  return `${item.repoKey}#${item.number}`;
}

export interface BoardRow {
  item: BoardIssue;
  /** 0 = 顶层；1 起是挂在父票下面的第几层，界面按它缩进。 */
  depth: number;
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

  const emit = (item: BoardIssue, depth: number): void => {
    const key = rowKeyOf(item);
    if (emitted.has(key) || suppressed.has(key)) return;
    emitted.add(key);
    const kids = childrenOf.get(key) ?? [];
    // 到缩进上限就不再往下开：接着平铺，也不吞票。
    const nest = kids.length > 0 && depth < MAX_DEPTH;
    if (nest) {
      const expanded = !collapsed.has(key);
      rows.push({ item, depth, childCount: kids.length, expanded });
      if (!expanded) {
        for (const kid of kids) suppress(kid);
        return;
      }
    } else {
      rows.push({ item, depth });
    }
    // 子票按父级顺序落位，逐层缩进。
    for (const kid of kids) emit(kid, nest ? depth + 1 : depth);
  };

  // 有父票的孩子不在顶层发：它们等父票那一轮被顺带吐出来。
  // （服务端排序把地图排在最前，父票可能排在孩子后面，所以不能只靠「先到先得」。）
  const hasScreenParent = new Set<string>();
  for (const kids of childrenOf.values()) for (const kid of kids) hasScreenParent.add(rowKeyOf(kid));

  // 顶层顺序沿用传进来的顺序（服务端已按「地图票优先 → 未关闭优先 → 最近更新」排好）。
  for (const item of items) {
    if (!hasScreenParent.has(rowKeyOf(item))) emit(item, 0);
  }
  // 兜底：互相挂成环的票谁也不算「没有父票」，刚才一轮会把它们全跳过——
  // 但界面上一行都不能少，所以没吐过的就地按顶层发一遍。
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
