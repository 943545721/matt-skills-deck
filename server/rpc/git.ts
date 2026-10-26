import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  gitCheckRpc,
  gitCommitRpc,
  gitDiffRpc,
  gitFetchRpc,
  gitLogRpc,
  gitPullRpc,
  gitPushRpc,
  gitStageRpc,
  gitStatusRpc,
  gitUnstageRpc,
} from "../../shared/git.ts";
import { record } from "../logs.ts";
import { judge, REASON_TEXT } from "../git/check.ts";
import { runGit } from "../git/exec.ts";
import { indexFingerprint, readScreen } from "../git/status.ts";
import { consumeTicket, issueTicket } from "../git/tickets.ts";
import type { WriteOp } from "../git/tickets.ts";
import {
  commitWithTicket,
  fetchWithTicket,
  listRemotes,
  pullWithTicket,
  pushWithTicket,
  readHead,
  stagePaths,
  unstagePaths,
} from "../git/write.ts";

type StatusInput = RpcInput<typeof gitStatusRpc>;
type DiffInput = RpcInput<typeof gitDiffRpc>;
type LogInput = RpcInput<typeof gitLogRpc>;
type CheckInput = RpcInput<typeof gitCheckRpc>;
type StageInput = RpcInput<typeof gitStageRpc>;
type UnstageInput = RpcInput<typeof gitUnstageRpc>;
type CommitInput = RpcInput<typeof gitCommitRpc>;
type PullInput = RpcInput<typeof gitPullRpc>;
type FetchInput = RpcInput<typeof gitFetchRpc>;
type PushInput = RpcInput<typeof gitPushRpc>;

export async function gitStatusHandler(input: StatusInput): Promise<RpcOutput<typeof gitStatusRpc>> {
  const result = await readScreen(input.workspaceDir);
  if (!result.ok) return result;
  return { ok: true, ...result.screen };
}

export async function gitDiffHandler(input: DiffInput): Promise<RpcOutput<typeof gitDiffRpc>> {
  const args = input.staged
    ? ["diff", "--cached", "--no-color", "--", input.path]
    : ["diff", "--no-color", "--", input.path];
  const result = await runGit(input.workspaceDir, args, { limit: 256 * 1024 });
  if (!result.ok) return result;
  return { ok: true, diff: result.data.stdout, truncated: result.data.truncated };
}

export async function gitLogHandler(input: LogInput): Promise<RpcOutput<typeof gitLogRpc>> {
  const limit = input.limit ?? 20;
  const result = await runGit(
    input.workspaceDir,
    ["log", `-${limit}`, "--format=%H%x09%h%x09%s%x09%an%x09%aI"],
    { limit: 512 * 1024 },
  );
  if (!result.ok) return result;
  // 空仓库（还没有提交）时 git log 会非零退出，这里按空列表处理而不是报错。
  const commits = result.data.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [oid, short, subject, author, date] = line.split("\t");
      if (!oid || !short) return [];
      return [{ oid, short, subject: subject ?? "", author: author ?? "", date: date ?? "" }];
    });
  return { ok: true, commits };
}

export async function gitCheckHandler(input: CheckInput): Promise<RpcOutput<typeof gitCheckRpc>> {
  const read = await readScreen(input.workspaceDir);
  if (!read.ok) return read;
  const { screen } = read;

  const remotes = input.op === "push" || input.op === "fetch" ? await listRemotes(input.workspaceDir) : [];
  const judgement = judge({
    op: input.op,
    branch: screen.branch.name,
    upstream: screen.branch.upstream,
    upstreamGone: screen.branch.upstreamGone,
    stagedCount: screen.files.filter((file) => file.staged).length,
    hasIntentToAdd: screen.hasIntentToAdd,
    remotes,
    requestedRemote: input.remote,
  });

  if (judgement.verdict === "block") {
    return {
      ok: false,
      reason: "blocked",
      detail: judgement.reasons.map((reason) => REASON_TEXT[reason] ?? reason).join("；"),
      reasons: judgement.reasons,
    };
  }
  if (judgement.verdict === "need-choice") {
    return { ok: false, reason: "needs-choice", detail: "这个仓库有多个远端，请先选一个", candidates: judgement.candidates };
  }

  const ticket = issueTicket({
    op: input.op,
    workspaceDir: input.workspaceDir,
    headOid: screen.headOid,
    indexFingerprint: (await indexFingerprint(input.workspaceDir)) ?? "",
    plan: judgement.plan,
  });
  return {
    ok: true,
    ticketId: ticket.id,
    expiresAt: new Date(ticket.expiresAtMs).toISOString(),
    plan: judgement.plan,
  };
}

export async function gitStageHandler(input: StageInput): Promise<RpcOutput<typeof gitStageRpc>> {
  const result = await stagePaths(input.workspaceDir, input.paths);
  if (!result.ok) {
    record("error", "git.stage", `${input.paths.length} 个文件暂存失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "git.stage", `已暂存 ${input.paths.length} 个文件`);
  return { ok: true, staged: result.staged };
}

export async function gitUnstageHandler(input: UnstageInput): Promise<RpcOutput<typeof gitUnstageRpc>> {
  const result = await unstagePaths(input.workspaceDir, input.paths);
  if (!result.ok) {
    record("error", "git.unstage", `${input.paths.length} 个文件取消暂存失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "git.unstage", `已取消暂存 ${input.paths.length} 个文件`);
  return { ok: true, unstaged: result.unstaged };
}

/** 六个写处理器共用的取票 + 类型收窄。 */
function takeTicket(id: string, op: WriteOp, workspaceDir: string) {
  return consumeTicket(id, op, workspaceDir);
}

export async function gitCommitHandler(input: CommitInput): Promise<RpcOutput<typeof gitCommitRpc>> {
  const taken = takeTicket(input.ticketId, "commit", input.workspaceDir);
  if (!taken.ok) return { ok: false, reason: taken.reason, detail: taken.detail };
  const result = await commitWithTicket(taken.ticket, input.message);
  if (!result.ok) {
    record("error", "git.commit", `提交失败（${result.reason}）：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "git.commit", `已提交 ${result.headAfter.slice(0, 7) || "（HEAD 未读到）"}`);
  return { ok: true, committed: result.committed, headBefore: result.headBefore, headAfter: result.headAfter };
}

export async function gitPullHandler(input: PullInput): Promise<RpcOutput<typeof gitPullRpc>> {
  const taken = takeTicket(input.ticketId, "pull", input.workspaceDir);
  if (!taken.ok) return { ok: false, reason: taken.reason, detail: taken.detail };
  const result = await pullWithTicket(taken.ticket);
  if (!result.ok) {
    record("error", "git.pull", `拉取失败（${result.reason}）：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "git.pull", `拉取完成：${result.mode}`);
  return { ok: true, mode: result.mode, headBefore: result.headBefore, headAfter: result.headAfter };
}

export async function gitFetchHandler(input: FetchInput): Promise<RpcOutput<typeof gitFetchRpc>> {
  const taken = takeTicket(input.ticketId, "fetch", input.workspaceDir);
  if (!taken.ok) return { ok: false, reason: taken.reason, detail: taken.detail };
  const result = await fetchWithTicket(taken.ticket);
  if (!result.ok) {
    record("error", "git.fetch", `取回失败（${result.reason}）：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "git.fetch", `已取回 ${result.remote}`);
  return { ok: true, remote: result.remote };
}

export async function gitPushHandler(input: PushInput): Promise<RpcOutput<typeof gitPushRpc>> {
  const taken = takeTicket(input.ticketId, "push", input.workspaceDir);
  if (!taken.ok) return { ok: false, reason: taken.reason, detail: taken.detail };
  const result = await pushWithTicket(taken.ticket);
  if (!result.ok) {
    record("error", "git.push", `推送失败（${result.reason}）：${result.detail.slice(0, 200)}`);
    return result;
  }
  record("info", "git.push", `已推送 ${result.branch} → ${result.remote}${result.upToDate ? "（已是最新）" : ""}`);
  return { ok: true, mode: result.mode, remote: result.remote, branch: result.branch, upToDate: result.upToDate };
}

/** 供状态页复用：读一次 HEAD，读不到就给空串（不是错误，空仓库很正常）。 */
export async function currentHead(workspaceDir: string): Promise<string> {
  return (await readHead(workspaceDir)) ?? "";
}
