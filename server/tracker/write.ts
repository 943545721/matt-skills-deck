import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WriteFailure = { ok: false; reason: "gh-missing" | "gh-failed" | "invalid"; detail: string };

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
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "gh-missing", detail: "没有找到 gh 命令：装好后执行 gh auth login 再试" };
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim().slice(0, 800) : error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "gh-failed", detail };
  }
}

const positive = (value: number) => Number.isInteger(value) && value > 0;

/**
 * 能不能确定「第一次写没写进去」。
 *
 * gh api 被服务端拒绝时，回包里带 HTTP 状态码；超时、断连、进程被杀则没有——
 * 那两种情况服务端可能已经把评论存下来了，此时回落 CLI 就是再发一条。
 */
const definitelyRejected = (failure: WriteFailure): boolean => /HTTP \d{3}/.test(failure.detail);

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
  if (rest.reason === "gh-missing") return rest;
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
