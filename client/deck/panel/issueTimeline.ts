import type { WorkRouteEntry, WorkRouteStatus } from "../../../shared/work-route.ts";

/**
 * 一张票的经过：建票、评论、会话接手 / 状态变更、关票、最近一次变动，按时间倒序。
 *
 * 为什么单独一个文件：这一列时间要能回答「这张票经历了什么」，
 * 而它拼的是**两份**数据——远端票面（建票 / 评论 / 最近变动）和本机台账
 * （哪个会话什么时候接的手）。两份并起来容易出错在几件小事上：
 * 评论会把 GitHub 的 updatedAt 顶到同一秒（不查重就多出一行「最近变动」）、
 * 台账只留当前状态（当状态没变时不能编一次变更）、时间解析不了的行不能瞎排。
 * 这些都在这里定死，界面只负责画。
 *
 * 只写有时间的行。**没有时间的步骤不出现**：标签、指派各自的变更时间远端不提供，
 * 本地后端连关票时刻都没有——这几处宁可少一行，编一个时间比不显示更坏。
 */

export type IssueEventKind = "created" | "comment" | "session" | "closed" | "updated";

export interface IssueTimelineEvent {
  /** ISO 时刻。排序与去重都按它，解析不了的行走不到这里。 */
  at: string;
  kind: IssueEventKind;
  /** 评论作者，或台账里接手的会话 id；建票 / 最近变动为 null。 */
  who: string | null;
  /** 评论正文。截多少是显示的事，这里给原文。 */
  body: string | null;
  /** 台账行专用：这一条现在到哪一步。 */
  status: WorkRouteStatus | null;
  /** 台账行的备注。 */
  note: string | null;
}

export interface IssueTimelineInput {
  createdAt: string;
  updatedAt: string;
  /** 关票时刻；没关、或后端不给这一列时省略 / null。 */
  closedAt?: string | null;
  comments: readonly { author: string; createdAt: string; body: string }[];
  /** 已经按这张票筛过的台账条目（同一张票可能有多个会话接过）。 */
  sessions?: readonly WorkRouteEntry[];
}

function parseAt(iso: string): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : Number.NaN;
}

/**
 * 台账条目是不是这张票。
 *
 * 台账里没写仓库（`repoKey: null`）时按本地仓库 `local` 认——本地后端的票就挂在这个键下。
 * 其余情况必须整键相等：票号只在仓库内唯一，认错就是拿别的票的历史给这张票。
 */
export function isTicketOf(
  entry: Pick<WorkRouteEntry, "repoKey" | "number">,
  ticket: { repoKey: string; number: number },
): boolean {
  if (entry.number !== ticket.number) return false;
  if (entry.repoKey === ticket.repoKey) return true;
  return entry.repoKey === null && ticket.repoKey === "local";
}

export function buildIssueTimeline(input: IssueTimelineInput): IssueTimelineEvent[] {
  const events: IssueTimelineEvent[] = [];

  const created = parseAt(input.createdAt);
  if (Number.isFinite(created)) {
    events.push({ at: input.createdAt, kind: "created", who: null, body: null, status: null, note: null });
  }

  for (const comment of input.comments) {
    if (!Number.isFinite(parseAt(comment.createdAt))) continue;
    events.push({
      at: comment.createdAt,
      kind: "comment",
      who: comment.author.trim() ? comment.author.trim() : null,
      body: comment.body,
      status: null,
      note: null,
    });
  }

  // 关票时刻是远端给的，不是从 state 推的：本地后端只有 state，
  // 那里就不出这一行——「已关闭」这个事实由页头的状态徽标说，时间不编。
  const closedIso = input.closedAt ?? "";
  if (closedIso && Number.isFinite(parseAt(closedIso))) {
    events.push({ at: closedIso, kind: "closed", who: null, body: null, status: null, note: null });
  }

  for (const session of input.sessions ?? []) {
    const took = parseAt(session.createdAt);
    const moved = parseAt(session.updatedAt);
    if (Number.isFinite(took)) {
      events.push({
        at: session.createdAt,
        kind: "session",
        who: session.agentId,
        body: null,
        status: "attached",
        note: session.note,
      });
    }
    // 台账只保留「现在到哪一步」，不留每一步的时刻；updatedAt 晚于接手的时刻
    // 只能说明中途动过，所以写「以当前状态收尾」，不假装知道是哪一刻变的状态。
    if (Number.isFinite(moved) && (!Number.isFinite(took) || moved > took)) {
      events.push({
        at: session.updatedAt,
        kind: "session",
        who: session.agentId,
        body: null,
        status: session.status,
        note: session.note,
      });
    }
  }

  // 「最近变动」只在它确实晚于其它所有行时才算一条：发评论 / 改标签都会把它顶到当下，
  // 与刚发生的那一行同一秒，照抄出来就是同一条消息说两遍。
  const latest = events.reduce((max, event) => Math.max(max, parseAt(event.at)), Number.NEGATIVE_INFINITY);
  const updated = parseAt(input.updatedAt);
  if (Number.isFinite(updated) && updated > latest) {
    events.push({ at: input.updatedAt, kind: "updated", who: null, body: null, status: null, note: null });
  }

  // 倒序：最近发生的排在最上面，与板子的排序一致。同一时刻保持加入顺序（sort 稳定）。
  return events.sort((left, right) => parseAt(right.at) - parseAt(left.at));
}

/** 评论正文摘一行：时间线上只放得下这么多，完整正文在下面的评论区。 */
export function firstLine(body: string, limit = 60): string {
  const line = body.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
