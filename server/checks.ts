import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  catalogFor,
  checksById,
  guideState,
  type BackendId,
  type CheckPredicate,
  type CheckResult,
  type CheckStatus,
  type GuideState,
} from "../shared/checks.ts";
import { STANDARD_LABELS } from "../shared/labels.ts";
import { getSettings } from "./settings.ts";
import { listLabels as listRepoLabels } from "./tracker/labels.ts";
import { parseRemoteUrl, readRemoteUrl, type RemoteRef } from "./tracker/remote.ts";

/**
 * 检查执行层：只探测、不修复。
 *
 * 目录与引导状态机在 `shared/checks.ts`（纯逻辑，客户端可 import）；
 * 这里负责把「问什么」落到本机的命令、文件与主目录上。所有外部调用都走 `ChecksProbe`，
 * 测试注入假探测即可覆盖全部分支，不会碰真实 PATH、真实网络或用户的仓库。
 */

const execFileAsync = promisify(execFile);

export interface ProbeRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type RemoteReading =
  | { ok: true; url: string }
  | { ok: false; reason: "no-remote" | "not-a-repo" | "git-missing" | string; detail: string };

export type LabelReading =
  | { ok: true; labels: readonly { name: string }[] }
  | { ok: false; detail: string };

/** 检查所需的最小外部依赖面；测试注入假实现，生产用下面的 defaultChecksProbe。 */
export interface ChecksProbe {
  run(command: string, args: string[]): Promise<ProbeRun>;
  exists(target: string): Promise<boolean>;
  readDir(target: string): Promise<string[] | null>;
  /** 环境变量只回答「有没有」，检查详情不打印值（可能含 token）。 */
  env(key: string): string | null;
  homeDir(): string | null;
  dirWritable(target: string): Promise<boolean>;
  /** 工作区可选：给了就同时查工作区里的两个技能根。 */
  skillInstalled(skill: string, workspaceDir?: string): Promise<boolean>;
  readRemote(workspaceDir: string): Promise<RemoteReading>;
  listLabels(owner: string, name: string): Promise<LabelReading>;
  settingsBackend(): "auto" | "github" | "gitlab" | "local";
}

/** 技能安装位置：工作区与用户级各两处，与 server/skills/install.ts 的目标根一致。 */
export const SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

export function skillProbeRoots(workspaceDir: string | undefined): string[] {
  const roots: string[] = [];
  if (workspaceDir) roots.push(...SKILL_ROOTS.map((root) => path.join(workspaceDir, root)));
  const home = homedir();
  if (home) roots.push(...SKILL_ROOTS.map((root) => path.join(home, root)));
  return roots;
}

/** 往目录里写一个临时探针再删掉：跨 OS 唯一可靠的「可写」判据；目录不存在时直接判不可写。 */
async function writeProbe(target: string): Promise<boolean> {
  let created: string | null = null;
  try {
    created = await mkdtemp(path.join(target, ".deck-write-probe-"));
    return true;
  } catch {
    return false;
  } finally {
    if (created) await rm(created, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const defaultChecksProbe: ChecksProbe = {
  async run(command, args) {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, { timeout: 8_000, maxBuffer: 1 << 20 });
      return { ok: true, stdout, stderr };
    } catch (error) {
      const record = error as { stdout?: unknown; stderr?: unknown };
      // 只取输出：error.message 里带着完整 argv，可能包含凭据。
      return {
        ok: false,
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        stderr: typeof record.stderr === "string" ? record.stderr : "",
      };
    }
  },
  async exists(target) {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  },
  async readDir(target) {
    try {
      return await readdir(target);
    } catch {
      return null;
    }
  },
  env(key) {
    const value = process.env[key];
    return value && value.trim() ? value : null;
  },
  homeDir() {
    try {
      return homedir() || null;
    } catch {
      return null;
    }
  },
  dirWritable: writeProbe,
  async skillInstalled(skill, workspaceDir) {
    for (const root of skillProbeRoots(workspaceDir)) {
      try {
        await access(path.join(root, skill, "SKILL.md"));
        return true;
      } catch {
        // 继续找下一个根
      }
    }
    return false;
  },
  readRemote: readRemoteUrl,
  async listLabels(owner, name) {
    const result = await listRepoLabels(owner, name);
    return result.ok ? { ok: true, labels: result.labels } : { ok: false, detail: result.detail };
  },
  settingsBackend: () => getSettings().backend,
};

type Outcome = { status: CheckStatus; detail?: string };

/** 一次评估里共享的上下文：远端只读一次、同一个命令只问一次。 */
export interface PredicateContext {
  workspaceDir?: string;
  probe: ChecksProbe;
  remote: RemoteReading | null;
  commands: Map<string, boolean>;
}

export interface EvaluateChecksOptions {
  workspaceDir?: string;
  /** 不给就按设置与远端自动判定。 */
  backend?: BackendId;
}

export interface ChecksReport {
  backend: BackendId;
  checks: CheckResult[];
  guide: GuideState;
  checkedAt: string;
}

function firstLine(text: string, max = 200): string {
  const line = text.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function resolveTargetPath(workspaceDir: string | undefined, target: string): string | null {
  if (path.isAbsolute(target)) return target;
  return workspaceDir ? path.join(workspaceDir, target) : null;
}

async function commandAvailable(ctx: PredicateContext, command: string): Promise<boolean> {
  const cached = ctx.commands.get(command);
  if (cached !== undefined) return cached;
  const result = await ctx.probe.run(command, ["--version"]);
  ctx.commands.set(command, result.ok);
  return result.ok;
}

/** 远端坐标；失败时把「为什么问不到」原样交出去，不猜一个仓库。 */
function remoteRefOf(ctx: PredicateContext): { ref: RemoteRef } | { failure: Outcome } {
  if (!ctx.workspaceDir) return { failure: { status: "unknown", detail: "没有工作区，无法解析远端" } };
  if (!ctx.remote) return { failure: { status: "unknown", detail: "没有读取远端" } };
  if (!ctx.remote.ok) return { failure: { status: "fail", detail: ctx.remote.detail } };
  const ref = parseRemoteUrl(ctx.remote.url);
  if (!ref) return { failure: { status: "fail", detail: `远端地址认不出：${ctx.remote.url}` } };
  if (ref.host === "other") return { failure: { status: "fail", detail: `远端不是 GitHub / GitLab：${ctx.remote.url}` } };
  return { ref };
}

async function evaluatePrimitive(
  check: Extract<CheckPredicate, { kind: "primitive" }>,
  ctx: PredicateContext,
): Promise<Outcome> {
  switch (check.primitive) {
    case "commandExists": {
      const ok = await commandAvailable(ctx, check.command);
      return ok
        ? { status: "ok", detail: `${check.command} 可用` }
        : { status: "fail", detail: `没有找到 ${check.command} 命令` };
    }
    case "fileExists": {
      const target = resolveTargetPath(ctx.workspaceDir, check.path);
      if (!target) return { status: "unknown", detail: `没有工作区，无法检查 ${check.path}` };
      return (await ctx.probe.exists(target))
        ? { status: "ok", detail: check.path }
        : { status: "fail", detail: `没有找到 ${check.path}` };
    }
    case "env": {
      return ctx.probe.env(check.key)
        ? { status: "ok", detail: `已设置 ${check.key}` }
        : { status: "fail", detail: `没有设置 ${check.key}` };
    }
    case "skillProbe": {
      return (await ctx.probe.skillInstalled(check.skill, ctx.workspaceDir))
        ? { status: "ok", detail: `技能 ${check.skill} 已安装` }
        : { status: "fail", detail: `技能 ${check.skill} 未安装（.claude/skills / .agents/skills 下都没有 SKILL.md）` };
    }
    case "homeDir": {
      const home = ctx.probe.homeDir();
      return home ? { status: "ok", detail: "用户主目录可解析" } : { status: "fail", detail: "用户主目录不可解析" };
    }
    case "dirWritable": {
      const target = resolveTargetPath(ctx.workspaceDir, check.path);
      if (!target) return { status: "unknown", detail: `没有工作区，无法检查 ${check.path}` };
      return (await ctx.probe.dirWritable(target))
        ? { status: "ok", detail: `${check.path} 可写` }
        : { status: "fail", detail: `${check.path} 不存在或不可写` };
    }
  }
}

async function evaluateRepoAccess(backendId: BackendId, ctx: PredicateContext): Promise<Outcome> {
  const remote = remoteRefOf(ctx);
  if ("failure" in remote) return remote.failure;
  if (remote.ref.host !== backendId) {
    return { status: "fail", detail: `当前远端是 ${remote.ref.host}，不是 ${backendId}` };
  }
  const command = backendId === "github" ? "gh" : "glab";
  if (!(await commandAvailable(ctx, command))) {
    return { status: "unknown", detail: `没有找到 ${command} 命令，无法确认仓库是否可达` };
  }
  const args =
    backendId === "github"
      ? ["api", `repos/${remote.ref.owner}/${remote.ref.name}`, "--jq", ".full_name"]
      : ["api", `projects/${encodeURIComponent(`${remote.ref.owner}/${remote.ref.name}`)}`, "--jq", ".path_with_namespace"];
  const result = await ctx.probe.run(command, args);
  if (!result.ok) {
    const detail = firstLine(result.stderr || result.stdout) || "命令失败";
    return { status: "fail", detail: `读不到仓库（可能未登录或没有权限）：${detail}` };
  }
  return { status: "ok", detail: firstLine(result.stdout) || `${remote.ref.owner}/${remote.ref.name}` };
}

async function evaluateLabels(ctx: PredicateContext): Promise<Outcome> {
  const remote = remoteRefOf(ctx);
  if ("failure" in remote) return remote.failure;
  if (remote.ref.host !== "github") return { status: "unknown", detail: "标签只在 GitHub 仓库上检查" };
  if (!(await commandAvailable(ctx, "gh"))) return { status: "unknown", detail: "没有找到 gh 命令，无法确认标签" };
  const listed = await ctx.probe.listLabels(remote.ref.owner, remote.ref.name);
  if (!listed.ok) return { status: "fail", detail: `读不到标签：${firstLine(listed.detail)}` };
  const names = new Set(listed.labels.map((label) => label.name));
  const missing = STANDARD_LABELS.filter((label) => !names.has(label.name));
  if (missing.length > 0) {
    return { status: "warn", detail: `缺少 ${missing.length} 个标签：${missing.map((label) => label.name).join("、")}` };
  }
  return { status: "ok", detail: `${STANDARD_LABELS.length} 个核心标签齐全` };
}

/** 本地 Markdown 的三项：工作区、可写目录、容器目录可读。只读探测，不创建任何目录。 */
async function evaluateMarkdown(
  id: "workspace" | "scratchWritable" | "containersReadable",
  ctx: PredicateContext,
): Promise<Outcome> {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) return { status: "unknown", detail: "没有工作区" };
  const deckDir = path.join(workspaceDir, ".deck");
  const scratchDir = path.join(workspaceDir, ".scratch");
  const dataDirs = [deckDir, scratchDir];
  if (id === "workspace") {
    if (!(await ctx.probe.exists(workspaceDir))) return { status: "fail", detail: `工作区不存在：${workspaceDir}` };
    for (const dir of dataDirs) {
      if ((await ctx.probe.exists(dir)) && (await ctx.probe.readDir(dir)) === null) {
        return { status: "fail", detail: `读不出数据目录：${path.basename(dir)}` };
      }
    }
    return { status: "ok", detail: "工作区可读取" };
  }
  if (id === "scratchWritable") {
    const target = (await ctx.probe.exists(deckDir))
      ? deckDir
      : (await ctx.probe.exists(scratchDir))
        ? scratchDir
        : workspaceDir;
    return (await ctx.probe.dirWritable(target))
      ? { status: "ok", detail: `${path.basename(target) || target} 可写` }
      : { status: "fail", detail: `${path.basename(target) || target} 不可写` };
  }
  let present = 0;
  for (const dir of dataDirs) {
    if (!(await ctx.probe.exists(dir))) continue;
    present += 1;
    if ((await ctx.probe.readDir(dir)) === null) {
      return { status: "fail", detail: `读不出容器目录：${path.basename(dir)}` };
    }
  }
  return { status: "ok", detail: present > 0 ? `${present} 个容器目录可读` : "没有容器目录" };
}

async function evaluateBackend(
  check: Extract<CheckPredicate, { kind: "backend" }>,
  ctx: PredicateContext,
): Promise<Outcome> {
  switch (check.id) {
    case "repoRemote": {
      if (!ctx.workspaceDir) return { status: "unknown", detail: "没有工作区，无法解析远端" };
      if (!ctx.remote) return { status: "unknown", detail: "没有读取远端" };
      if (!ctx.remote.ok) return { status: "fail", detail: ctx.remote.detail };
      const ref = parseRemoteUrl(ctx.remote.url);
      if (!ref) return { status: "fail", detail: `远端地址认不出：${ctx.remote.url}` };
      if (ref.host === "other") return { status: "fail", detail: `远端不是 GitHub / GitLab：${ctx.remote.url}` };
      return { status: "ok", detail: `${ref.host} · ${ref.owner}/${ref.name}` };
    }
    case "repoAccess":
      return evaluateRepoAccess(check.backendId, ctx);
    case "labels":
      return evaluateLabels(ctx);
    case "workspace":
    case "scratchWritable":
    case "containersReadable":
      return evaluateMarkdown(check.id, ctx);
  }
}

async function evaluateAuth(command: "gh" | "glab", ctx: PredicateContext): Promise<Outcome> {
  if (!(await commandAvailable(ctx, command))) {
    return { status: "unknown", detail: `没有找到 ${command} 命令，无法确认登录态` };
  }
  const result = await ctx.probe.run(command, ["auth", "status"]);
  if (result.ok) return { status: "ok", detail: "已登录" };
  const detail = firstLine(result.stderr || result.stdout) || `${command} 没有登录`;
  // 只有「确实没登录」才是 fail；超时 / 断网这类问不出来的失败按 unknown 报，
  // 不能把离线机器说成没登录，再把人引到登录按钮上。
  const notSignedIn =
    /not logged (?:in|into)|no (?:github|gitlab) hosts|no accounts|not authenticated|no token|invalid (?:token|api key)|gh auth login|glab auth login|\b401\b/i.test(
      `${result.stderr}\n${result.stdout}`,
    );
  return notSignedIn
    ? { status: "fail", detail }
    : { status: "unknown", detail: `${command} auth status 没问出结论：${detail}` };
}

/** 执行一条谓词。导出它是为了单测能单独覆盖六种原语，不必绕过目录。 */
export async function evaluatePredicate(check: CheckPredicate, ctx: PredicateContext): Promise<Outcome> {
  if (check.kind === "primitive") return evaluatePrimitive(check, ctx);
  if (check.kind === "backend") return evaluateBackend(check, ctx);
  return evaluateAuth(check.id === "ghAuth" ? "gh" : "glab", ctx);
}

async function detectBackend(
  probe: ChecksProbe,
  remote: RemoteReading | null,
): Promise<BackendId> {
  const setting = probe.settingsBackend();
  if (setting === "github" || setting === "gitlab") return setting;
  if (setting === "local") return "markdown";
  if (!remote?.ok) return "markdown";
  const ref = parseRemoteUrl(remote.url);
  if (ref?.host === "github") return "github";
  if (ref?.host === "gitlab") return "gitlab";
  return "markdown";
}

/**
 * 跑一遍十项检查，并把结果交给六步引导状态机。
 *
 * 顺序按目录：通用项在前，后端项在后。`gh:authed` 依赖 `gh:installed` 的结论，
 * 所以命令可用性在同一次评估里缓存——不重复起进程，也不会出现「上面说没装、下面说没登录」。
 */
export async function evaluateChecks(
  options: EvaluateChecksOptions = {},
  probe: ChecksProbe = defaultChecksProbe,
): Promise<ChecksReport> {
  const workspaceDir = options.workspaceDir;
  const remote = workspaceDir ? await probe.readRemote(workspaceDir) : null;
  const backend = options.backend ?? (await detectBackend(probe, remote));
  const ctx: PredicateContext = { workspaceDir, probe, remote, commands: new Map() };
  const checks: CheckResult[] = [];
  for (const item of catalogFor(backend)) {
    const outcome = await evaluatePredicate(item.check, ctx);
    checks.push({
      id: item.id,
      status: outcome.status,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.status === "ok" ? {} : { action: item.onFail }),
    });
  }
  return {
    backend,
    checks,
    guide: guideState(checksById(checks), backend),
    checkedAt: new Date().toISOString(),
  };
}
