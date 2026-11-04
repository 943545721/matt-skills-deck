import type { ArchivedAgentRow } from "../../../../shared/orchestration-rpc.ts";

/**
 * 归档清单的本地筛选。
 *
 * 为什么在客户端筛而不是再发一次 RPC：清单最多一页几百条，按 id 找是这一页的
 * 主要用途，本地点一下就该出结果；服务端那份查询只负责「把这个工作区的归档读全」。
 *
 * 比对的字段刻意比界面显示的宽：用户手里的可能是 provider 会话 id（从客户端那边
 * 抄来的），也可能是内部 agent id（从别的页面复制的），两种都得能搜到。
 */
export function mergeArchivedRows(base: readonly ArchivedAgentRow[], incoming: readonly ArchivedAgentRow[]): ArchivedAgentRow[] {
  const seen = new Set(base.map((row) => row.agentId));
  // 只按先后拼接、不再重排：两批各自是「归档时间新的在前」，后读的一批一定更早。
  return [...base, ...incoming.filter((row) => !seen.has(row.agentId))];
}

export function filterArchivedRows(rows: readonly ArchivedAgentRow[], query: string): ArchivedAgentRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.agentId, row.title ?? "", row.sessionId ?? "", row.provider ?? ""].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}
