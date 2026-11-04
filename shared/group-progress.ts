/**
 * 群里的进度汇总。
 *
 * 「一个需求两边都改」在群里就是一张地图加它路线上的票，再加跨仓库引用。
 * 按仓库并排：每一列是一个仓库的票，列头是开了几张、关了几张。
 * 纯函数，不读票。读票是调用方的事。
 */

export interface GroupProgressTicket {
  repoKey: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "UNKNOWN";
}

export interface GroupProgressColumn {
  repoKey: string;
  tickets: GroupProgressTicket[];
  open: number;
  closed: number;
  unknown: number;
}

export interface GroupProgress {
  columns: GroupProgressColumn[];
  open: number;
  closed: number;
  unknown: number;
}

export interface GroupProgressMap {
  repoKey: string;
  issue: { number: number; title: string; state: "OPEN" | "CLOSED" };
  route: readonly { number: number; title: string; state: "OPEN" | "CLOSED" }[];
  references: readonly { repo: string; number: number; title: string; state: "OPEN" | "CLOSED" | "UNKNOWN" }[];
}

/** 一张地图上要汇总的票：地图自己、路线上的票、跨仓库引用。 */
export function ticketsOfMap(map: GroupProgressMap): GroupProgressTicket[] {
  return [
    { repoKey: map.repoKey, number: map.issue.number, title: map.issue.title, state: map.issue.state },
    ...map.route.map((item) => ({
      repoKey: map.repoKey,
      number: item.number,
      title: item.title,
      state: item.state,
    })),
    ...map.references.map((item) => ({
      repoKey: item.repo,
      number: item.number,
      title: item.title,
      state: item.state,
    })),
  ];
}

function countsOf(tickets: readonly GroupProgressTicket[]): Pick<GroupProgressColumn, "open" | "closed" | "unknown"> {
  let open = 0;
  let closed = 0;
  let unknown = 0;
  for (const ticket of tickets) {
    if (ticket.state === "OPEN") open += 1;
    else if (ticket.state === "CLOSED") closed += 1;
    else unknown += 1;
  }
  return { open, closed, unknown };
}

/**
 * 按仓库分列。同一仓库同一票号只留第一次出现的那条。
 * 列按仓库键排序，列内按票号排序，这样两次渲染不会互换位置。
 */
export function groupProgressColumns(tickets: readonly GroupProgressTicket[]): GroupProgress {
  const seen = new Set<string>();
  const unique: GroupProgressTicket[] = [];
  for (const ticket of tickets) {
    const key = `${ticket.repoKey}#${ticket.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ticket);
  }

  const byRepo = new Map<string, GroupProgressTicket[]>();
  for (const ticket of unique) {
    const rows = byRepo.get(ticket.repoKey);
    if (rows) rows.push(ticket);
    else byRepo.set(ticket.repoKey, [ticket]);
  }

  const columns = [...byRepo.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([repoKey, rows]) => {
      const sorted = [...rows].sort((left, right) => left.number - right.number);
      return { repoKey, tickets: sorted, ...countsOf(sorted) };
    });

  const totals = countsOf(columns.flatMap((column) => column.tickets));
  return { columns, ...totals };
}
