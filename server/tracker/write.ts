import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyGhError, type GhFailureReason } from "./gh-error.ts";

const execFileAsync = promisify(execFile);

export type WriteFailure = { ok: false; reason: GhFailureReason | "invalid"; detail: string };

export interface Comment {
  author: string;
  createdAt: string;
  body: string;
}

async function runGh(args: string[], timeoutMs = 20_000): Promise<{ ok: true; stdout: string } | WriteFailure> {
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: timeoutMs, maxBuffer: 8 << 20 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, ...classifyGhError(error, "试") };
  }
}

const positive = (value: number) => Number.isInteger(value) && value > 0;

/**
 * 能不能确定「第一次写没写进去」。
 *
 * 只认 4xx（408 除外）：那是服务端明确拒绝了这次请求。5xx 与超时、断连同属「可能已写入」——
 * 网关的 502/504 恰恰是上游没回话，请求很可能已经落到后端并建好了评论；
 * 408 是服务端等到自己超时，也不排除已经处理完。这几种情况下回落 CLI 就是再发一条。
 */
const definitelyRejected = (failure: WriteFailure): boolean => /HTTP (4(?!08)\d{2})/.test(failure.detail);

/**
 * 发一条评论。
 *
 * 主路走 REST（`gh api POST .../comments`），**确认被服务端拒绝**时才回落 `gh issue comment`：
 * 两条路都能成，差别只在回包。回落时拿不到服务端的真实时间戳，就按当前时间乐观回填，
 * 让界面立刻能看到自己的评论——而不是等一次刷新才发现写成功了。
 *
 * 超时/断连不回落：那种情况下评论可能已经在服务端建好了，再发一次就是重复评论。
 * 宁可报「可能已写入，先刷新确认」，也不替用户制造一条删不掉的重复评论。
 */
export async function postComment(owner: string, repo: string, issue: number, body: string): Promise<{ ok: true; comment: Comment } | WriteFailure> {
  if (!positive(issue)) return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  if (!body.trim()) return { ok: false, reason: "invalid", detail: "评论内容不能为空" };

  const rest = await runGh([
    "api",
    `repos/${owner}/${repo}/issues/${issue}/comments`,
    "--method",
    "POST",
    "-f",
    `body=${body}`,
    "--jq",
    ".",
  ]);
  if (rest.ok) {
    return { ok: true, comment: parseComment(rest.stdout, body) };
  }
  // 没装 / 没登录都意味着请求根本没发出去，不存在「可能已写入」，别拿重复评论的风险吓人。
  if (rest.reason === "gh-missing" || rest.reason === "gh-unauth") return rest;
  if (!definitelyRejected(rest)) {
    return {
      ok: false,
      reason: "gh-failed",
      detail: `评论可能已经写进去了（${rest.detail.slice(0, 300)}）；先刷新确认，不要直接重发，否则会出现重复评论`,
    };
  }

  const cli = await runGh(["issue", "comment", String(issue), "--repo", `${owner}/${repo}`, "--body", body]);
  if (!cli.ok) return cli;
  return {
    ok: true,
    comment: { author: "", createdAt: new Date().toISOString(), body },
  };
}

function parseComment(stdout: string, fallbackBody: string): Comment {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const record = (Array.isArray(parsed) ? parsed[0] : parsed) as
      | { body?: unknown; created_at?: unknown; createdAt?: unknown; user?: { login?: unknown }; author?: { login?: unknown } }
      | null;
    if (!record) return { author: "", createdAt: new Date().toISOString(), body: fallbackBody };
    const login = record.user?.login ?? record.author?.login;
    const created = record.created_at ?? record.createdAt;
    return {
      author: typeof login === "string" ? login : "",
      createdAt: typeof created === "string" ? created : new Date().toISOString(),
      body: typeof record.body === "string" ? record.body : fallbackBody,
    };
  } catch {
    return { author: "", createdAt: new Date().toISOString(), body: fallbackBody };
  }
}

/**
 * 建票。
 *
 * 只带标题与正文建票，标签另发一次：REST 建票接口收不了标签数组，
 * 硬塞会变成静默丢标签——那比多一次请求糟得多。
 */
export async function createIssue(
  owner: string,
  repo: string,
  input: { title: string; body: string; labels: readonly string[] },
): Promise<{ ok: true; number: number; url: string; labels: string[]; labelsFailed: boolean } | WriteFailure> {
  const title = input.title.trim();
  if (!title) return { ok: false, reason: "invalid", detail: "标题不能为空" };
  if (title.length > 256) return { ok: false, reason: "invalid", detail: "标题过长（上限 256 字）" };

  const created = await runGh([
    "api",
    `repos/${owner}/${repo}/issues`,
    "--method",
    "POST",
    "-f",
    `title=${title}`,
    "-f",
    `body=${input.body}`,
    "--jq",
    ".",
  ]);
  if (!created.ok) return created;

  let number = 0;
  let url = "";
  try {
    const parsed: unknown = JSON.parse(created.stdout);
    const record = (Array.isArray(parsed) ? parsed[0] : parsed) as { number?: unknown; html_url?: unknown; url?: unknown } | null;
    number = typeof record?.number === "number" ? record.number : Number(record?.number);
    url = typeof record?.html_url === "string" ? record.html_url : typeof record?.url === "string" ? record.url : "";
  } catch {
    return { ok: false, reason: "gh-failed", detail: "建票回包不是合法 JSON，票可能已经建好，刷新后确认" };
  }
  if (!positive(number)) {
    return { ok: false, reason: "gh-failed", detail: "建票回包缺少票号，票可能已经建好，刷新后确认" };
  }

  const wanted = dedupeLabels(input.labels);
  if (!wanted.length) return { ok: true, number, url, labels: [], labelsFailed: false };

  const labelled = await replaceLabels(owner, repo, number, wanted);
  if (!labelled.ok) {
    // 票已经建出来了，只是标签没挂上：如实报出来，不要让用户以为整件事失败了。
    return { ok: true, number, url, labels: [], labelsFailed: true };
  }
  return { ok: true, number, url, labels: labelled.labels.map((label) => label.name), labelsFailed: false };
}

/**
 * 关闭或重开一张票。
 *
 * 「完成」在 DSH 里是注入 /implement 提示词后由 Agent 收尾；Paseo 里没有输入框可注入，
 * 所以落成一次用户明确点过的真实状态写：点了「完成」就是关票，不存在「以为关了其实没关」。
 */
export async function setIssueState(
  owner: string,
  repo: string,
  issue: number,
  state: "open" | "closed",
): Promise<{ ok: true; state: "OPEN" | "CLOSED" } | WriteFailure> {
  if (!positive(issue)) return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  const action = state === "closed" ? "close" : "reopen";
  const result = await runGh(["issue", action, String(issue), "--repo", `${owner}/${repo}`]);
  if (!result.ok) return result;
  return { ok: true, state: state === "closed" ? "CLOSED" : "OPEN" };
}

/**
 * 改标题 / 正文 / 状态。
 *
 * 只发用户明确给出的字段：REST PATCH 里没出现的字段保持原值，这正是「局部修改」
 * 需要的语义；把读到的全文再写回去反而会把并发编辑覆盖掉。
 * 返回读回值，界面与 Agent 都能确认识别到的是新内容。
 */
export async function patchIssue(
  owner: string,
  repo: string,
  issue: number,
  patch: { title?: string; body?: string; state?: "open" | "closed" },
): Promise<{ ok: true; title: string; body: string; state: "OPEN" | "CLOSED" } | WriteFailure> {
  if (!positive(issue)) return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  const title = patch.title?.trim();
  if (title !== undefined && !title) return { ok: false, reason: "invalid", detail: "标题不能为空" };
  if (title !== undefined && title.length > 256) return { ok: false, reason: "invalid", detail: "标题过长（上限 256 字）" };
  if (title === undefined && patch.body === undefined && patch.state === undefined) {
    return { ok: false, reason: "invalid", detail: "至少给一个要改的字段（title / body / state）" };
  }

  const args = ["api", `repos/${owner}/${repo}/issues/${issue}`, "--method", "PATCH", "--jq", "."];
  if (title !== undefined) args.push("-f", `title=${title}`);
  if (patch.body !== undefined) args.push("-f", `body=${patch.body}`);
  if (patch.state !== undefined) args.push("-f", `state=${patch.state}`);

  const result = await runGh(args);
  if (!result.ok) return result;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const record = (Array.isArray(parsed) ? parsed[0] : parsed) as
      | { title?: unknown; body?: unknown; state?: unknown }
      | null;
    return {
      ok: true,
      title: typeof record?.title === "string" ? record.title : (title ?? ""),
      body: typeof record?.body === "string" ? record.body : (patch.body ?? ""),
      state: record?.state === "closed" ? "CLOSED" : "OPEN",
    };
  } catch {
    return { ok: true, title: title ?? "", body: patch.body ?? "", state: patch.state === "closed" ? "CLOSED" : "OPEN" };
  }
}

/**
 * 接手 / 放手：把当前登录账号加进或移出指派人。
 *
 * 登录名从 `gh api user` 读，不要求用户手打；读不到就明确失败——猜一个名字写上去
 * 等于把票指派给了别人。
 */
export async function takeIssue(
  owner: string,
  repo: string,
  issue: number,
  take: boolean,
): Promise<{ ok: true; login: string; assignees: string[] } | WriteFailure> {
  if (!positive(issue)) return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  const me = await runGh(["api", "user", "--jq", ".login"]);
  if (!me.ok) return me;
  const login = me.stdout.trim();
  if (!login) return { ok: false, reason: "gh-failed", detail: "gh 没有返回当前登录账号，无法接手这张票" };

  const edited = await runGh([
    "issue",
    "edit",
    String(issue),
    "--repo",
    `${owner}/${repo}`,
    take ? "--add-assignee" : "--remove-assignee",
    login,
  ]);
  if (!edited.ok) return edited;

  // 写成功但读不回指派列表时，至少把「已经加/移了谁」如实回给界面，不让整件事看起来失败。
  const read = await runGh(["issue", "view", String(issue), "--repo", `${owner}/${repo}`, "--json", "assignees", "--jq", "[.assignees[].login]"]);
  if (!read.ok) return { ok: true, login, assignees: take ? [login] : [] };
  try {
    const parsed: unknown = JSON.parse(read.stdout);
    const assignees = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    return { ok: true, login, assignees };
  } catch {
    return { ok: true, login, assignees: take ? [login] : [] };
  }
}

export function dedupeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const name = String(raw ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 整体替换一张票的标签。
 *
 * 用 PUT 而不是逐条增删：调用方手上就是「这张票应该有的标签全集」，
 * 逐条增删会把「先查现状再算差集」的竞态带进来。
 */
export async function replaceLabels(
  owner: string,
  repo: string,
  issue: number,
  labels: readonly string[],
): Promise<{ ok: true; labels: { name: string; color: string }[] } | WriteFailure> {
  if (!positive(issue)) return { ok: false, reason: "invalid", detail: "票号必须是正整数" };
  const wanted = dedupeLabels(labels);
  const args = ["api", `repos/${owner}/${repo}/issues/${issue}/labels`, "--method", "PUT", "--jq", "."];
  for (const name of wanted) args.push("-f", `labels[]=${name}`);

  const result = await runGh(args);
  if (!result.ok) return result;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const list = Array.isArray(parsed) ? parsed : [];
    return {
      ok: true,
      labels: list.flatMap((item) => {
        const record = item as { name?: unknown; color?: unknown } | null;
        const name = typeof record?.name === "string" ? record.name : "";
        if (!name) return [];
        return [{ name, color: typeof record?.color === "string" ? record.color : "cccccc" }];
      }),
    };
  } catch {
    // 标签写成功了但回包解析不了：按「写成功、颜色未知」回，界面刷新后会拿到真值。
    return { ok: true, labels: wanted.map((name) => ({ name, color: "cccccc" })) };
  }
}
