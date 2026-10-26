import { runGit } from "./exec.ts";

export interface FileEntry {
  path: string;
  /** porcelain 的 XY 两列：第一列是索引区状态，第二列是工作区状态。 */
  code: string;
  staged: boolean;
}

export interface BranchInfo {
  name: string;
  upstream: string;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
}

export interface Screen {
  branch: BranchInfo;
  headOid: string;
  files: FileEntry[];
  clean: boolean;
  hasIntentToAdd: boolean;
}

/**
 * 解析 `git status --porcelain=v2 --branch -z`。
 *
 * 为什么用 v2 而不是短格式：短格式丢掉了「索引模式」这一列，而「git add -N」的
 * intent-to-add 文件正是靠索引模式 000000 认出来的——认不出它就只能给用户一句
 * 「没有可提交的东西」，那是最让人困惑的报错之一。
 */
export function parseStatus(stdout: string): Screen {
  const branch: BranchInfo = { name: "", upstream: "", upstreamGone: false, ahead: 0, behind: 0 };
  const files: FileEntry[] = [];
  let headOid = "";
  let hasIntentToAdd = false;

  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const raw = tokens[index];
    if (!raw) continue;

    if (raw.startsWith("# branch.oid ")) {
      headOid = raw.slice("# branch.oid ".length).trim();
      if (headOid === "(initial)") headOid = "";
      continue;
    }
    if (raw.startsWith("# branch.head ")) {
      branch.name = raw.slice("# branch.head ".length).trim();
      if (branch.name === "(detached)") branch.name = "";
      continue;
    }
    if (raw.startsWith("# branch.upstream ")) {
      branch.upstream = raw.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (raw.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(raw.slice("# branch.ab ".length).trim());
      if (match) {
        branch.ahead = Number.parseInt(match[1] ?? "0", 10);
        branch.behind = Number.parseInt(match[2] ?? "0", 10);
      }
      continue;
    }
    if (raw.startsWith("# ")) continue;

    if (raw.startsWith("1 ")) {
      const fields = raw.split(" ");
      const code = fields[1] ?? "";
      const indexMode = fields[4] ?? "";
      const path = fields.slice(8).join(" ");
      if (indexMode === "000000") hasIntentToAdd = true;
      files.push({ path, code, staged: isStaged(code) });
      continue;
    }
    if (raw.startsWith("2 ")) {
      const fields = raw.split(" ");
      const code = fields[1] ?? "";
      const path = fields.slice(9).join(" ");
      // 重命名条目后面紧跟一个 NUL 分隔的原路径，跳过它，否则会被当成一个新条目。
      index += 1;
      files.push({ path, code, staged: isStaged(code) });
      continue;
    }
    if (raw.startsWith("u ")) {
      const fields = raw.split(" ");
      const code = fields[1] ?? "";
      const path = fields.slice(10).join(" ");
      files.push({ path, code, staged: isStaged(code) });
      continue;
    }
    if (raw.startsWith("? ")) {
      files.push({ path: raw.slice(2), code: "??", staged: false });
      continue;
    }
    // "! " 是被忽略的文件，按定义不该出现在这里，出现了也不显示。
  }

  // upstreamGone：git 会在 tracked 分支上把 upstream 写成原名但 ab 无法计算；
  // 这里用「有 upstream 名字、但没有 ab 行」判不出来，所以交给调用方读 refs 确认，见 readScreen。
  return { branch, headOid, files, clean: files.length === 0, hasIntentToAdd };
}

function isStaged(code: string): boolean {
  const index = code[0] ?? ".";
  return index !== "." && index !== "?";
}

export type ReadScreenResult =
  | { ok: true; screen: Screen }
  | { ok: false; reason: "no-workspace" | "git-missing" | "git-failed" | "invalid"; detail: string };

/** 读一次首屏。这是所有判断与票据的唯一数据来源，别处不许再自己拼一套。 */
export async function readScreen(workspaceDir: string): Promise<ReadScreenResult> {
  const result = await runGit(
    workspaceDir,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--find-renames"],
    { limit: 4 << 20 },
  );
  if (!result.ok) return result;
  const screen = parseStatus(result.data.stdout);
  const gone = await upstreamGone(workspaceDir, screen.branch.upstream);
  return { ok: true, screen: { ...screen, branch: { ...screen.branch, upstreamGone: gone } } };
}

/**
 * 上游是否已经不存在。
 *
 * 单读 status 分不出「没有领先落后」和「上游被删了」，而这两者对推送的处置完全不同：
 * 前者正常推，后者要用 -u 重新建立跟踪。所以单独问一次 refs。
 */
async function upstreamGone(workspaceDir: string, upstream: string): Promise<boolean> {
  if (!upstream) return false;
  const result = await runGit(workspaceDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${upstream}`], {
    timeoutMs: 5_000,
    limit: 4_096,
  });
  if (!result.ok) return false;
  return result.data.exitCode !== 0 || !result.data.stdout.trim();
}

/** 索引指纹：内容变了就必须重新预检。用 ls-files 的模式+对象号，不碰工作区文件内容。 */
export async function indexFingerprint(workspaceDir: string): Promise<string | null> {
  const result = await runGit(workspaceDir, ["ls-files", "-s", "-z"], { limit: 8 << 20 });
  if (!result.ok) return null;
  if (result.data.truncated) return null;
  const entries = result.data.stdout.split("\0").filter(Boolean);
  // 不用 node:crypto 之外的哈希实现：这里只需要一个稳定的短指纹。
  let hash = 0;
  for (const entry of entries) {
    for (let index = 0; index < entry.length; index += 1) {
      hash = (hash * 31 + entry.charCodeAt(index)) | 0;
    }
  }
  return `${entries.length}:${hash.toString(16)}`;
}
