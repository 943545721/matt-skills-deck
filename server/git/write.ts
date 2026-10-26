import type { GitFailure } from "./exec.ts";
import { pathsProblem, runGit, workspaceProblem } from "./exec.ts";
import { indexFingerprint } from "./status.ts";
import type { Ticket } from "./tickets.ts";

type WriteFailure = GitFailure | { ok: false; reason: "head-moved" | "ticket-expired"; detail: string };

export async function readHead(workspaceDir: string): Promise<string | null> {
  const result = await runGit(workspaceDir, ["rev-parse", "HEAD"], { timeoutMs: 5_000, limit: 200 });
  if (!result.ok) return null;
  if (result.data.exitCode !== 0) return null;
  const oid = result.data.stdout.trim();
  return oid || null;
}

export async function listRemotes(workspaceDir: string): Promise<string[]> {
  const result = await runGit(workspaceDir, ["remote"], { limit: 4_096 });
  if (!result.ok) return [];
  return result.data.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function failed(result: { data: { stdout: string; exitCode: number } }, fallback: string): WriteFailure {
  const text = result.data.stdout.trim();
  return { ok: false, reason: "git-failed", detail: text.slice(0, 800) || fallback };
}

export async function stagePaths(workspaceDir: string, paths: readonly string[]): Promise<{ ok: true; staged: string[] } | WriteFailure> {
  const problem = pathsProblem(paths);
  if (problem) return problem;
  const result = await runGit(workspaceDir, ["add", "--", ...paths]);
  if (!result.ok) return result;
  if (result.data.exitCode !== 0) return failed(result, "git add 失败");
  return { ok: true, staged: [...paths] };
}

export async function unstagePaths(workspaceDir: string, paths: readonly string[]): Promise<{ ok: true; unstaged: string[] } | WriteFailure> {
  const problem = pathsProblem(paths);
  if (problem) return problem;
  // restore --staged 比 reset HEAD 更明确，也不会动工作区文件。
  const result = await runGit(workspaceDir, ["restore", "--staged", "--", ...paths]);
  if (!result.ok) return result;
  if (result.data.exitCode !== 0) return failed(result, "取消暂存失败");
  return { ok: true, unstaged: [...paths] };
}

/**
 * 票据签发后、写命令发出前，再确认一次「用户当初看到的状态还是不是现在这个」。
 *
 * HEAD 变了（别处提交/切分支）或索引指纹变了（别处 add），都说明这张票的确认已经过期，
 * 此时执行写命令等于替用户点了别人确认时的那个按钮。
 */
async function stillCurrent(ticket: Ticket): Promise<{ ok: true } | WriteFailure> {
  const head = await readHead(ticket.workspaceDir);
  if (head === null) {
    return { ok: false, reason: "git-failed", detail: "读不到当前 HEAD，无法确认状态，已取消" };
  }
  if (ticket.headOid && head !== ticket.headOid) {
    return { ok: false, reason: "head-moved", detail: "HEAD 在你确认之后变了，请重新预检" };
  }
  if (ticket.indexFingerprint) {
    const fingerprint = await indexFingerprint(ticket.workspaceDir);
    if (fingerprint && fingerprint !== ticket.indexFingerprint) {
      return { ok: false, reason: "head-moved", detail: "暂存区在你确认之后变了，请重新预检" };
    }
  }
  return { ok: true };
}

export interface CommitOutcome {
  ok: true;
  committed: boolean;
  headBefore: string;
  headAfter: string;
}

export async function commitWithTicket(ticket: Ticket, message: string): Promise<CommitOutcome | WriteFailure> {
  if (!message.trim()) return { ok: false, reason: "invalid", detail: "提交信息不能为空" };
  const current = await stillCurrent(ticket);
  if (!current.ok) return current;

  const result = await runGit(ticket.workspaceDir, ["commit", "-m", message], { timeoutMs: 60_000 });
  const headAfter = (await readHead(ticket.workspaceDir)) ?? "";
  if (!result.ok) return result;
  if (result.data.exitCode !== 0) {
    // 不猜成功也不重试：HEAD 不动就是没提交，动了就是提交了。
    if (headAfter && headAfter !== ticket.headOid) {
      return { ok: true, committed: true, headBefore: ticket.headOid, headAfter };
    }
    return failed(result, "git commit 失败");
  }
  if (!headAfter) {
    // 提交命令说成功了，但读不到 HEAD：如实交回空串，界面显示「结果未知」。
    return { ok: true, committed: true, headBefore: ticket.headOid, headAfter: "" };
  }
  return { ok: true, committed: true, headBefore: ticket.headOid, headAfter };
}

export async function pullWithTicket(ticket: Ticket): Promise<
  { ok: true; mode: "up-to-date" | "fast-forward" | "unknown"; headBefore: string; headAfter: string } | WriteFailure
> {
  const current = await stillCurrent(ticket);
  if (!current.ok) return current;
  const result = await runGit(ticket.workspaceDir, ["pull", "--ff-only"], { timeoutMs: 120_000 });
  const headAfter = await readHead(ticket.workspaceDir);
  if (!result.ok) return result;
  if (result.data.exitCode !== 0) return failed(result, "git pull 失败");
  if (headAfter === null) {
    return { ok: true, mode: "unknown", headBefore: ticket.headOid, headAfter: "" };
  }
  const moved = ticket.headOid && headAfter !== ticket.headOid;
  return { ok: true, mode: moved ? "fast-forward" : "up-to-date", headBefore: ticket.headOid, headAfter };
}

export async function fetchWithTicket(ticket: Ticket): Promise<{ ok: true; remote: string } | WriteFailure> {
  if (!ticket.plan.remote) return { ok: false, reason: "invalid", detail: "没有指定远端" };
  const result = await runGit(ticket.workspaceDir, ["fetch", ticket.plan.remote], { timeoutMs: 120_000 });
  if (!result.ok) return result;
  if (result.data.exitCode !== 0) return failed(result, "git fetch 失败");
  return { ok: true, remote: ticket.plan.remote };
}

export async function pushWithTicket(ticket: Ticket): Promise<
  | { ok: true; mode: "existing-upstream" | "set-upstream"; remote: string; branch: string; upToDate: boolean }
  | WriteFailure
> {
  const { remote, branch, setUpstream } = ticket.plan;
  if (!remote || !branch) return { ok: false, reason: "invalid", detail: "推送目标不完整" };
  const current = await stillCurrent(ticket);
  if (!current.ok) return current;

  const args = setUpstream ? ["push", "-u", remote, branch] : ["push", remote, branch];
  const result = await runGit(ticket.workspaceDir, args, { timeoutMs: 180_000 });
  if (!result.ok) return result;
  if (result.data.exitCode !== 0) return failed(result, "git push 失败");
  return {
    ok: true,
    mode: setUpstream ? "set-upstream" : "existing-upstream",
    remote,
    branch,
    upToDate: /up-to-date|Everything up-to-date/i.test(result.data.stdout),
  };
}

export { workspaceProblem };
