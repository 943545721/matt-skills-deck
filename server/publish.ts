import { createHash } from "node:crypto";
import path from "node:path";

/**
 * 建仓发布：命令构造器 + dry-run + 二次确认令牌。
 *
 * 行为照 DSH `backends/github/init-project` 的流程搬：
 *   git init（已是 git 仓库则跳过）→ git add . → git commit --allow-empty
 *   → 没有 origin：`gh repo create <name> --private|--public --source=. --push`
 *   → 已有 origin：先建空远端，再 `git remote set-url`，最后 `git push -u origin HEAD`
 *
 * 本文件**只产出计划，不执行任何写操作**。执行层（若以后接）必须先调 `verifyPublishToken`
 * 做二次确认；令牌绑定工作区、仓库名、可见性与完整命令序列，计划一变就必须重新确认。
 * 令牌是防误触的确认凭证，不是权限凭证——它由计划本身确定性地算出，不持有秘密。
 * 命令一律用 argv 数组表达，绝不拼 shell 字符串去执行。
 */

export type PublishVisibility = "private" | "public";
export type PublishRoute = "create" | "existing-remote";
/** git 提交身份：missing = 明确没配；unknown = 没探测过，执行时按 commit 报错再回退。 */
export type PublishIdentity = "configured" | "missing" | "unknown";

/** DSH 身份缺失回退用的本地配置；只写这个仓库，不碰全局配置。 */
export const DEFAULT_GIT_IDENTITY = { name: "DSH User", email: "dsh@local" } as const;
export const PUBLISH_TOKEN_TTL_MS = 10 * 60_000;
const MAX_NAME_LENGTH = 100;
const SAFE_REPO_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface PublishInput {
  /** 要发布的工作区（绝对路径）。 */
  cwd: string;
  name: string;
  visibility?: PublishVisibility;
  /** 工作区是否已经是 git 仓库（调用方先探测）。 */
  isGitRepo: boolean;
  /** origin 是否已存在（调用方先探测）。 */
  hasOrigin: boolean;
  /** 当前登录的 GitHub 用户；已有 origin 时用它拼新仓库地址。 */
  owner?: string | null;
  /** 直接指定新远端地址（给了就不再按 owner/name 拼）。 */
  remoteUrl?: string | null;
  /** git 提交身份；缺省按 unknown 处理，计划里保留身份缺失回退。 */
  identity?: PublishIdentity;
}

export interface PublishCommand {
  /** 命令与参数分开：执行层直接 spawn，不经过 shell。 */
  argv: readonly string[];
  /** 这一步为什么存在，界面原样展示。 */
  why: string;
  /** 只在这个失败分支成立时执行；目前只有「提交因身份缺失失败」。 */
  when?: "commit-identity-missing";
}

export interface PublishPlan {
  ok: true;
  /** 计划绑定的工作区；令牌复算需要它，界面也可以直接展示。 */
  cwd: string;
  name: string;
  visibility: PublishVisibility;
  route: PublishRoute;
  /** 计划永远是 dry-run：字段固定为 true，避免调用方误读成「已执行」。 */
  dryRun: true;
  commands: readonly PublishCommand[];
  /** 可复制到终端的展示脚本；真正执行仍应以 commands 的 argv 为准。 */
  script: string;
  confirmToken: string;
  issuedAt: string;
  expiresAt: string;
  notes: readonly string[];
  warnings: readonly string[];
}

export type PublishFailureReason =
  | "bad-name"
  | "bad-cwd"
  | "bad-owner"
  | "inconsistent"
  | "token-mismatch"
  | "token-expired";

export interface PublishFailure {
  ok: false;
  reason: PublishFailureReason;
  detail: string;
}

export type PublishPlanResult = PublishPlan | PublishFailure;
export type PublishConfirmResult = { ok: true } | PublishFailure;

export interface PlanPublishOptions {
  /** 令牌签发时间；测试注入，生产不传。 */
  now?: number;
  /** 令牌有效期；测试注入，生产不传。 */
  ttlMs?: number;
}

/** 仓库名校验：与 DSH 同一条规则（字母/数字/._-，≤100）。返回问题描述，合法时返回 null。 */
export function repoNameProblem(raw: string): string | null {
  const name = String(raw ?? "").trim();
  if (!name) return "仓库名为空";
  if (name.length > MAX_NAME_LENGTH) return `仓库名最长 ${MAX_NAME_LENGTH} 个字符：${name}`;
  if (!SAFE_REPO_NAME.test(name)) return `仓库名仅支持字母/数字/._-：${name}`;
  if (name === "." || name === "..") return `仓库名不能是 ${name}`;
  if (name.startsWith("-")) return `仓库名不能以 - 开头（会被命令行当成选项）：${name}`;
  return null;
}

function commitCommand(): PublishCommand {
  return {
    argv: ["git", "commit", "-m", "initial commit", "--allow-empty"],
    why: "建立第一个提交；--allow-empty 让空目录也能发布",
  };
}

/** 身份缺失回退：commit 报 author identity unknown 时才执行，不提前改用户的 git 配置。 */
function identityFallbackCommands(): PublishCommand[] {
  return [
    {
      argv: ["git", "config", "user.email", DEFAULT_GIT_IDENTITY.email],
      why: "提交身份缺失时写本仓库的 user.email",
      when: "commit-identity-missing",
    },
    {
      argv: ["git", "config", "user.name", DEFAULT_GIT_IDENTITY.name],
      why: "提交身份缺失时写本仓库的 user.name",
      when: "commit-identity-missing",
    },
    {
      ...commitCommand(),
      why: "补好身份后重试一次提交",
      when: "commit-identity-missing",
    },
  ];
}

/** 单个 argv 的 shell 展示写法；执行层不读这个字符串。 */
export function shellQuote(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function renderPublishScript(commands: readonly PublishCommand[], cwd?: string): string {
  const lines: string[] = [];
  if (cwd) lines.push(`# 在 ${cwd} 下执行（dry-run 计划，尚未执行）`);
  for (const command of commands) {
    if (command.when === "commit-identity-missing") {
      lines.push("# 仅在提交因身份缺失失败时执行：");
    }
    lines.push(`# ${command.why}`);
    lines.push(command.argv.map(shellQuote).join(" "));
  }
  return lines.join("\n");
}

/** 令牌的确定性输入：只含会改变执行结果的字段，刻意不含时间与说明文字。 */
export interface PublishTokenSubject {
  cwd: string;
  name: string;
  visibility: PublishVisibility;
  route: PublishRoute;
  commands: readonly PublishCommand[];
}

export function publishTokenOf(subject: PublishTokenSubject): string {
  const canonical = JSON.stringify({
    v: 1,
    cwd: subject.cwd,
    name: subject.name,
    visibility: subject.visibility,
    route: subject.route,
    commands: subject.commands.map((command) => [command.argv, command.when ?? ""]),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

/**
 * 二次确认：令牌必须与这份计划逐字段一致，且没有过期。
 * 计划在确认之后被改过（换仓库、换可见性、换命令）都会得到 token-mismatch。
 */
export function verifyPublishToken(
  plan: PublishTokenSubject & { expiresAt?: string },
  token: string,
  options: { now?: number } = {},
): PublishConfirmResult {
  if (typeof token !== "string" || token.trim() === "") {
    return { ok: false, reason: "token-mismatch", detail: "确认令牌为空：请先看一遍发布计划再确认" };
  }
  if (plan.expiresAt) {
    const expiresAt = Date.parse(plan.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return { ok: false, reason: "token-mismatch", detail: "确认令牌的过期时间不合法" };
    }
    if ((options.now ?? Date.now()) > expiresAt) {
      return { ok: false, reason: "token-expired", detail: "确认令牌已过期：计划可能已经过时，请重新生成" };
    }
  }
  const expected = publishTokenOf(plan);
  if (expected !== token.trim()) {
    return { ok: false, reason: "token-mismatch", detail: "确认令牌与当前计划不一致：计划改过，请重新确认" };
  }
  return { ok: true };
}

/** 校验并规范化后的发布目标；命令构造与说明只依赖它，不再回看原始入参。 */
interface PublishTarget {
  cwd: string;
  name: string;
  visibility: PublishVisibility;
  identity: PublishIdentity;
  isGitRepo: boolean;
  route: PublishRoute;
  remoteUrl: string;
}

function normalizePublishInput(input: PublishInput): { ok: true; target: PublishTarget } | PublishFailure {
  const cwd = String(input.cwd ?? "").trim();
  if (!cwd) return { ok: false, reason: "bad-cwd", detail: "没有工作区目录，不知道要发布哪个目录" };
  if (!path.isAbsolute(cwd)) return { ok: false, reason: "bad-cwd", detail: `工作区目录必须是绝对路径：${cwd}` };

  const nameProblem = repoNameProblem(input.name);
  if (nameProblem) return { ok: false, reason: "bad-name", detail: nameProblem };
  const name = input.name.trim();
  const { isGitRepo, hasOrigin } = input;
  if (hasOrigin && !isGitRepo) {
    return { ok: false, reason: "inconsistent", detail: "探测结果自相矛盾：目录不是 git 仓库，却读到了 origin" };
  }

  const owner = input.owner ? String(input.owner).trim() : "";
  const explicitRemote = input.remoteUrl ? String(input.remoteUrl).trim() : "";
  if (!explicitRemote && owner && !SAFE_OWNER.test(owner)) {
    return { ok: false, reason: "bad-owner", detail: `GitHub 用户名/组织名不合法：${owner}` };
  }
  const remoteUrl = explicitRemote || (owner ? `https://github.com/${owner}/${name}.git` : "");
  if (hasOrigin && !remoteUrl) {
    return {
      ok: false,
      reason: "bad-owner",
      detail: "已有 origin，但不知道新仓库地址：拿不到当前登录用户，也没有指定 remoteUrl",
    };
  }

  return {
    ok: true,
    target: {
      cwd,
      name,
      visibility: input.visibility === "public" ? "public" : "private",
      identity: input.identity ?? "unknown",
      isGitRepo,
      route: hasOrigin ? "existing-remote" : "create",
      remoteUrl,
    },
  };
}

function buildPublishCommands(target: PublishTarget): PublishCommand[] {
  const commands: PublishCommand[] = [];
  if (!target.isGitRepo) {
    commands.push({ argv: ["git", "init"], why: "目录还不是 git 仓库，先建本地仓库" });
  }
  commands.push({ argv: ["git", "add", "."], why: "把工作区内容加入暂存区" });
  commands.push(commitCommand());
  if (target.identity !== "configured") commands.push(...identityFallbackCommands());

  const visibilityFlag = target.visibility === "public" ? "--public" : "--private";
  if (target.route === "create") {
    commands.push({
      argv: ["gh", "repo", "create", target.name, visibilityFlag, "--source=.", "--push"],
      why: "在 GitHub 上新建仓库，并把当前分支推上去",
    });
    return commands;
  }
  commands.push({
    argv: ["gh", "repo", "create", target.name, visibilityFlag],
    why: "origin 已存在：先新建一个空远端仓库（不接管当前远端）",
  });
  commands.push({
    argv: ["git", "remote", "set-url", "origin", target.remoteUrl],
    why: "把 origin 指到刚建好的仓库",
  });
  commands.push({ argv: ["git", "push", "-u", "origin", "HEAD"], why: "推送当前分支并建立上游" });
  return commands;
}

function publishGuidance(target: PublishTarget): { notes: string[]; warnings: string[] } {
  const notes = [
    "本计划是 dry-run：只列出命令，不执行任何写操作。",
    "执行前必须把整份计划给用户看一遍，并用 confirmToken 做二次确认。",
    `仓库名仅支持字母/数字/._- 且不超过 ${MAX_NAME_LENGTH} 个字符。`,
    "git commit 使用 --allow-empty：目录为空也能建出第一个提交。",
  ];
  const warnings: string[] = [];
  if (target.identity === "missing") {
    warnings.push(`没有配置 git 提交身份：会先写本仓库的 ${DEFAULT_GIT_IDENTITY.email} / ${DEFAULT_GIT_IDENTITY.name} 再重试提交。`);
  } else if (target.identity === "unknown") {
    warnings.push("无法确认 git 提交身份：若 commit 报 author identity unknown，会按兜底配置重试一次。");
  }
  if (target.route === "existing-remote") {
    warnings.push("origin 已存在：会新建一个空远端，再把 origin 改指过去；旧远端的提交不会被自动迁移。");
  }
  if (target.visibility === "public") warnings.push("公开仓库：发布后任何人都能看到其中的内容。");
  return { notes, warnings };
}

/**
 * 生成发布计划。返回的 commands 有序、可逐条展示；调用方必须先把整份计划交给用户确认，
 * 再拿 confirmToken 调 `verifyPublishToken`，两次都通过才允许执行。
 */
export function planPublish(input: PublishInput, options: PlanPublishOptions = {}): PublishPlanResult {
  const normalized = normalizePublishInput(input);
  if (!normalized.ok) return normalized;
  const target = normalized.target;
  const commands = buildPublishCommands(target);
  const { notes, warnings } = publishGuidance(target);
  const issuedAtMs = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? PUBLISH_TOKEN_TTL_MS;
  const subject: PublishTokenSubject = {
    cwd: target.cwd,
    name: target.name,
    visibility: target.visibility,
    route: target.route,
    commands,
  };

  return {
    ok: true,
    cwd: target.cwd,
    name: target.name,
    visibility: target.visibility,
    route: target.route,
    dryRun: true,
    commands,
    script: renderPublishScript(commands, target.cwd),
    confirmToken: publishTokenOf(subject),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
    notes,
    warnings,
  };
}
