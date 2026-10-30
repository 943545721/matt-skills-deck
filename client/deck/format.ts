import type { BlockerRef } from "../../shared/issues.ts";

/**
 * 标签配色直接取仓库里配置的十六进制值，再用亮度决定字色。
 * 不统一成主题色：标签色本身是用户表达（谁负责、处于什么环节），抹平它等于丢掉信息。
 */
export function readableText(hex: string): "#000000" | "#ffffff" {
  const raw = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return "#000000";
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#000000" : "#ffffff";
}

/**
 * 阻塞者的显示名：跨仓库项带 `owner/repo#12`，本仓库项只写 `#12`。
 * 只给票号的话，同一块板子上两个仓库的 #12 会看起来是同一条边。
 */
export function blockerLabel(blocker: Pick<BlockerRef, "number" | "repo">): string {
  return blocker.repo ? `${blocker.repo}#${blocker.number}` : `#${blocker.number}`;
}

/**
 * 「引用失效」的阻塞者：跨仓库那张票读不到。
 *
 * 仍然算阻塞（readiness 已经是 blocked），这里只负责把原因说出来——
 * 否则用户只会看到一张卡在「阻塞」的票，却不知道要去哪个仓库确认。
 */
export function staleBlockerLabels(item: { blockedBy: readonly BlockerRef[]; readiness: string }): string[] {
  if (item.readiness === "closed") return [];
  return item.blockedBy.filter((blocker) => blocker.stale === true).map(blockerLabel);
}

/**
 * 还在挡路的阻塞者：板子那行「被 #3 阻塞」只报这些。
 *
 * `blockedBy` 是一份历史，对方关掉了不会从列表里消失。照抄一遍的话，一张其实已经
 * 能接的票看起来仍然堵着——这比不显示更坏。两种情况不报：
 * 票自己已经关闭（等谁都没意义），以及那位阻塞者已经关掉（阻塞已解除）。
 * 完整的依赖历史留在详情页，那里逐条带状态。
 */
export function activeBlockers(item: { blockedBy: readonly BlockerRef[]; readiness: string }): BlockerRef[] {
  if (item.readiness === "closed") return [];
  return item.blockedBy.filter((blocker) => blocker.state !== "CLOSED");
}
