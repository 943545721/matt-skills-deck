export type WriteOp = "commit" | "pull" | "push" | "fetch";

export interface Plan {
  remote: string;
  branch: string;
  setUpstream: boolean;
}

export interface Ticket {
  id: string;
  op: WriteOp;
  workspaceDir: string;
  headOid: string;
  indexFingerprint: string;
  plan: Plan;
  expiresAtMs: number;
}

/** 60 秒：够用户读完确认再点，又短到「回来时状态早变了」不会悄悄通过。 */
export const TICKET_TTL_MS = 60_000;

const tickets = new Map<string, Ticket>();

const purge = (now: number) => {
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAtMs <= now) tickets.delete(id);
  }
};

export function issueTicket(input: Omit<Ticket, "id" | "expiresAtMs">, now = Date.now()): Ticket {
  purge(now);
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ticket: Ticket = { ...input, id, expiresAtMs: now + TICKET_TTL_MS };
  tickets.set(id, ticket);
  return ticket;
}

export type ConsumeResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: "ticket-expired"; detail: string };

/**
 * 取票：一次有效。
 *
 * 用完即删，而不是像源仓库那样按 requestId 去重重放：面板是单人界面，
 * 重复点击的代价是「多一次预检」，而「同一张票被用两次」的代价是重复提交。
 * 宁可让用户多点一次，也不要让一张确认过的票在别处再生效一次。
 */
export function consumeTicket(id: string, op: WriteOp, workspaceDir: string, now = Date.now()): ConsumeResult {
  const ticket = tickets.get(id);
  if (!ticket) {
    return { ok: false, reason: "ticket-expired", detail: "这次操作的确认已失效，请重新点一次预检" };
  }
  tickets.delete(id);
  if (ticket.expiresAtMs <= now) {
    return { ok: false, reason: "ticket-expired", detail: "确认超过 60 秒已过期，请重新预检" };
  }
  if (ticket.op !== op) {
    return { ok: false, reason: "ticket-expired", detail: `这张票是给 ${ticket.op} 发的，不能用于 ${op}` };
  }
  if (ticket.workspaceDir !== workspaceDir) {
    return { ok: false, reason: "ticket-expired", detail: "这张票是给另一个工作区发的" };
  }
  return { ok: true, ticket };
}

/** 仅供测试使用：清空票据表，避免用例之间互相影响。 */
export function resetTickets(): void {
  tickets.clear();
}
