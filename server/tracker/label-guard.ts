import { getIssue } from "./github.ts";

export type LabelGuardResult =
  | { ok: true }
  | { ok: false; reason: "labels-truncated" | "not-found" | "gh-missing" | "gh-failed"; detail: string };

/**
 * 「整体替换标签」之前的不变量：这张票的现有标签必须读得全。
 *
 * PUT labels 是整体替换语义，读不全就等于把没读到的标签一起删掉。这条不变量放在领域层，
 * MCP 工具、面板 RPC 与将来任何调用方都走同一处，而不是各自记得「先查一遍再改」。
 */
export async function assertLabelsReadable(
  owner: string,
  name: string,
  number: number,
): Promise<LabelGuardResult> {
  const current = await getIssue(owner, name, number);
  if (!current.ok) return { ok: false, reason: current.reason, detail: current.detail };
  if (!current.meta.labelsTruncated) return { ok: true };
  return {
    ok: false,
    reason: "labels-truncated",
    detail: `#${number} 的标签太多，本次只读到 ${current.issue.labels.length} 个（共 ${current.meta.labelCount} 个）；整体替换会删掉没读到的标签，请改用面板或 GitHub 网页修改`,
  };
}
