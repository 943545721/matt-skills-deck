import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { STANDARD_LABELS } from "../shared/labels.ts";
import type { EnvCheck } from "../shared/env.ts";
import { getSettings } from "./settings.ts";
import type { DeckSettings } from "../shared/settings.ts";
import { listLabels } from "./tracker/labels.ts";
import { resolveRepo, type Gate } from "./rpc/repo-gate.ts";
import type { TargetFailure } from "./tracker/targets.ts";
import { listWorkspaceRepoTargets, type WorkspaceRepoListing } from "./tracker/targets.ts";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 检查所需的最小外部依赖面。测试注入假实现，生产用真实命令。 */
export interface EnvProbe {
  nodeVersion: string;
  run(command: string, args: string[]): Promise<ProbeResult>;
  exists(target: string): Promise<boolean>;
  resolveRepo(workspaceDir: string): Promise<Gate>;
  /** 多仓库工作区：优先用它，单仓库解析会漏掉「容器目录里有几个仓库」这个事实。 */
  resolveTargets?(workspaceDir: string): Promise<WorkspaceRepoListing | TargetFailure>;
  listLabels(owner: string, repo: string): ReturnType<typeof listLabels>;
  settings(): DeckSettings;
}

const defaultProbe: EnvProbe = {
  nodeVersion: process.version,
  async run(command, args) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 8_000, maxBuffer: 1 << 20 });
      return { ok: true, stdout, stderr: "" };
    } catch (error) {
      // 只取 stderr：`error.message` 里带着完整 argv，登录命令的参数可能含 token。
      const stderr = (error as { stderr?: unknown }).stderr;
      return { ok: false, stdout: "", stderr: typeof stderr === "string" ? stderr : "" };
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
  resolveRepo,
  resolveTargets: listWorkspaceRepoTargets,
  listLabels,
  settings: getSettings,
};

/** `v22.20.0` → [22,20]；认不出就按 0 算，避免「版本检查」把插件判死。 */
function nodeVersionOf(raw: string): [number, number] {
  const match = /v?(\d+)\.(\d+)/.exec(raw);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

const NODE_MINIMUM: [number, number] = [22, 18];

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

type Backend = "github" | "gitlab" | "local" | "none";

/**
 * 判定「实际会用哪个后端」。
 *
 * `auto` 只在仓库认出来之后才有意义：没有远端就是本地 Markdown（数据落在 `.deck/`），
 * 而不是「什么都不支持」——那会让一个刚 `git init` 的工作区连票都建不了。
 */
export function effectiveBackend(setting: DeckSettings["backend"], host: string): Backend {
  if (setting !== "auto") return setting;
  if (host === "github") return "github";
  if (host === "gitlab") return "gitlab";
  return "local";
}

/**
 * 逐项环境检查。
 *
 * 顺序是有依赖的：先确认工具在不在，再问登录态；仓库认不出来时，标签检查直接跳过——
 * 对着一片空白报「缺标签」只会让人以为还有别的问题没修。
 */
/**
 * 本地任务板里到底有没有票。
 *
 * 只看 `.deck` 目录在不在不够：`.deck/orchestration.json` 和 `.deck/handoffs/`
 * 也放在那儿，那是插件状态，不是票。`.deck/issues/` 只在第一次建票时创建
 * （`server/tracker/local.ts:690`），所以它存在就等于有票；`.scratch/` 是技能集的
 * 原生布局，它出现就说明用户在写本地票。
 */
async function localBoardOf(probe: EnvProbe, workspaceDir: string): Promise<string | null> {
  if (await probe.exists(path.join(workspaceDir, ".deck", "issues"))) return ".deck/issues/";
  if (await probe.exists(path.join(workspaceDir, ".scratch"))) return ".scratch/";
  return null;
}

export async function collectEnvChecks(
  workspaceDir: string | undefined,
  probe: EnvProbe = defaultProbe,
): Promise<{ backend: Backend; checks: EnvCheck[] }> {
  const checks: EnvCheck[] = [];
  const [major, minor] = nodeVersionOf(probe.nodeVersion);
  const nodeOk = major > NODE_MINIMUM[0] || (major === NODE_MINIMUM[0] && minor >= NODE_MINIMUM[1]);
  checks.push({
    id: "node",
    status: nodeOk ? "ok" : "fail",
    detail: nodeOk ? probe.nodeVersion : `${probe.nodeVersion}（需要 22.18 或更高）`,
    ...(nodeOk ? {} : { fix: "升级 Node 到 22.18+，然后重启 Paseo" }),
  });

  const git = await probe.run("git", ["--version"]);
  checks.push({
    id: "git",
    status: git.ok ? "ok" : "fail",
    detail: git.ok ? firstLine(git.stdout) : "没有找到 git 命令",
    ...(git.ok ? {} : { fix: "安装 git 并确认它在 PATH 里" }),
  });

  const gh = await probe.run("gh", ["--version"]);
  checks.push({
    id: "gh",
    status: gh.ok ? "ok" : "fail",
    detail: gh.ok ? firstLine(gh.stdout) : "没有找到 gh 命令",
    ...(gh.ok ? {} : { fix: "安装 GitHub CLI（https://cli.github.com/），再运行 gh auth login" }),
  });

  if (gh.ok) {
    const auth = await probe.run("gh", ["auth", "status"]);
    checks.push({
      id: "gh-auth",
      status: auth.ok ? "ok" : "fail",
      detail: auth.ok ? "已登录" : firstLine(auth.stderr) || "gh 没有登录",
      ...(auth.ok ? {} : { fix: "gh auth login" }),
    });
  } else {
    checks.push({ id: "gh-auth", status: "skip", detail: "gh 不可用，跳过登录检查" });
  }

  const settings = probe.settings();
  let host = "";
  let gate: Gate | null = null;
  let listing: WorkspaceRepoListing | TargetFailure | null = null;
  /** 目标解析失败：后端行要按失败原因说真话，而不是继续报一个用不上的后端。 */
  let targetFailure: TargetFailure | null = null;
  /** 认出了远端（含多个仓库）：后面的迁移提示与标签检查都靠它。 */
  let remoteKnown = false;
  /** 只有一个 GitHub 仓库时才检查标签——多仓库各有一份标签，不能拿其中一个代表全部。 */
  let singleGithub: { owner: string; name: string } | null = null;
  let targetCount = 0;
  if (!workspaceDir) {
    checks.push({ id: "workspace", status: "warn", detail: "没有工作区，仓库相关检查已跳过" });
    checks.push({ id: "repo", status: "skip", detail: "没有工作区" });
  } else {
    const workspaceExists = await probe.exists(workspaceDir);
    checks.push({
      id: "workspace",
      status: workspaceExists ? "ok" : "fail",
      detail: workspaceDir,
      ...(workspaceExists ? {} : { fix: "在 Paseo 里打开一个真实存在的目录" }),
    });
    listing = probe.resolveTargets ? await probe.resolveTargets(workspaceDir) : null;
    if (listing) {
      if (!listing.ok) {
        targetFailure = listing;
        checks.push({
          id: "repo",
          status: "fail",
          detail: listing.detail,
          // 显式后端配错时，「去加一个 origin」不是修法：远端可能好好的，只是宿主对不上。
          fix:
            listing.reason === "unsupported-host"
              ? "把远端改到 GitHub 或 GitLab；或在设置里改回 auto / 选本地 Markdown"
              : "git remote add origin <仓库地址>；或运行 git init 后使用本地后端",
        });
      } else if (listing.kind === "local") {
        checks.push({
          id: "repo",
          status: settings.backend === "local" ? "ok" : "warn",
          detail: "本地 Markdown（数据在 .deck/），没有识别到 GitHub / GitLab 仓库",
          fix: "git remote add origin <仓库地址>，或在设置里确认后端",
        });
      } else {
        remoteKnown = true;
        targetCount = listing.repos.length;
        const hosts = [...new Set(listing.repos.map((item) => item.host))];
        host = hosts.length === 1 ? (hosts[0] ?? "") : "mixed";
        const only = listing.repos.length === 1 ? listing.repos[0] : undefined;
        if (only?.host === "github") singleGithub = { owner: only.owner, name: only.name };
        checks.push({
          id: "repo",
          status: "ok",
          detail: `${hosts.join(" + ")} · ${listing.repos.map((item) => item.key).join("、")}${
            listing.truncated ? "（子目录超过 30 个，只扫了前 30 个）" : ""
          }`,
        });
      }
    } else {
      gate = await probe.resolveRepo(workspaceDir);
      if (gate.ok) {
        remoteKnown = true;
        targetCount = 1;
        host = gate.ref.host;
        if (gate.ref.host === "github") singleGithub = { owner: gate.ref.owner, name: gate.ref.name };
        checks.push({
          id: "repo",
          status: gate.ref.host === "other" ? "warn" : "ok",
          detail: `${gate.ref.host} · ${gate.ref.owner}/${gate.ref.name}`,
          ...(gate.ref.host === "other" ? { fix: "把远端改到 GitHub 或 GitLab，或在设置里选本地后端" } : {}),
        });
      } else {
        checks.push({
          id: "repo",
          status: "fail",
          detail: gate.detail,
          fix: "git remote add origin <仓库地址>；或运行 git init 后使用本地后端",
        });
      }
    }
  }

  // 多仓库混合宿主时，「后端」不是一个值：按仓库路由；GitLab 的写能力由每次操作的权限闸门判断。
  const backend: Backend = targetFailure
    ? // auto 解析失败时读写都会失败；显式后端则把配置值报出来，并在详情里说明它解析不到。
      settings.backend === "auto"
      ? "none"
      : settings.backend
    : host === "mixed"
      ? settings.backend === "auto"
        ? "github"
        : settings.backend
      : effectiveBackend(settings.backend, host);
  const forcedMismatch =
    settings.backend !== "auto" &&
    (listing
      ? listing.ok && listing.kind === "repos" && listing.repos.some((item) => item.host !== settings.backend)
      : gate?.ok === true && settings.backend !== host);
  // 迁移前置检查：切换后端不会搬数据，所以至少要把「切过去会看不见什么」先说清楚。
  // 判据必须是「有票」，不是「有 .deck 目录」——编排状态与回传件也写在那里
  // （`.deck/orchestration.json`、`.deck/handoffs/`），它们不是票，按目录存在判会误报。
  const localBoard = workspaceDir ? await localBoardOf(probe, workspaceDir) : null;
  const migrationNotes: string[] = [];
  if (backend !== "local" && localBoard) migrationNotes.push(`工作区里已有 ${localBoard} 本地票，当前后端不会显示它们`);
  if (backend === "local" && remoteKnown) migrationNotes.push(`远端是 ${host}，本地后端只显示 .deck/ 里的票`);
  if (host === "mixed") migrationNotes.push(`共 ${targetCount} 个仓库，票按仓库分别路由`);
  const baseDetail = targetFailure
    ? settings.backend === "auto"
      ? `仓库解析失败，当前后端不可用：${targetFailure.detail}`
      : `设置要求 ${settings.backend}，但工作区解析不到可用仓库：${targetFailure.detail}`
    : forcedMismatch
      ? `设置要求 ${settings.backend}，但工作区远端是 ${host}`
      : host === "mixed"
        ? "GitHub + GitLab（多仓库合板）"
        : backend === "local"
          ? "本地 Markdown（数据在 .deck/）"
          : backend;
  const backendFix = targetFailure
    ? settings.backend === "auto"
      ? "git remote add origin <仓库地址>；或把远端改到 GitHub / GitLab；或在设置里选本地 Markdown"
      : `在设置里把后端改回 auto，或换一个 ${settings.backend} 仓库`
    : forcedMismatch
      ? `在设置里把后端改回 auto，或换一个 ${settings.backend} 仓库`
      : null;
  checks.push({
    id: "backend",
    status: targetFailure || forcedMismatch ? "fail" : migrationNotes.length ? "warn" : "ok",
    detail: [baseDetail, ...migrationNotes].join("；"),
    ...(backendFix ? { fix: backendFix } : {}),
  });

  if (backend === "gitlab" || host === "mixed") {
    const glab = await probe.run("glab", ["--version"]);
    checks.push({
      id: "glab",
      status: glab.ok ? "ok" : "fail",
      detail: glab.ok ? firstLine(glab.stdout) : "没有找到 glab 命令",
      ...(glab.ok ? {} : { fix: "安装 GitLab CLI（glab），再运行 glab auth login" }),
    });
    if (glab.ok) {
      const auth = await probe.run("glab", ["auth", "status"]);
      checks.push({
        id: "glab-auth",
        status: auth.ok ? "ok" : "fail",
        detail: auth.ok ? "已登录" : firstLine(auth.stderr) || "glab 没有登录",
        ...(auth.ok ? {} : { fix: "glab auth login" }),
      });
    } else {
      checks.push({ id: "glab-auth", status: "skip", detail: "glab 不可用，跳过登录检查" });
    }
  }

  if (!workspaceDir) {
    checks.push({ id: "skills", status: "skip", detail: "没有工作区" });
  } else {
    const claudeSkills = path.join(workspaceDir, ".claude", "skills");
    const agentsSkills = path.join(workspaceDir, ".agents", "skills");
    const [hasClaude, hasAgents] = await Promise.all([probe.exists(claudeSkills), probe.exists(agentsSkills)]);
    checks.push({
      id: "skills",
      status: hasClaude || hasAgents ? "ok" : "warn",
      detail: hasClaude
        ? ".claude/skills"
        : hasAgents
          ? ".agents/skills"
          : "这个工作区还没安装过技能",
      ...(hasClaude || hasAgents ? {} : { fix: "打开「技能」页，选一个技能安装到本工作区" }),
    });
  }

  if (backend === "github" && gh.ok && singleGithub) {
    const labels = await probe.listLabels(singleGithub.owner, singleGithub.name);
    if (!labels.ok) {
      checks.push({ id: "labels", status: "warn", detail: `读不到标签：${labels.detail.slice(0, 160)}` });
    } else {
      const names = new Set(labels.labels.map((label) => label.name));
      const missing = STANDARD_LABELS.filter((label) => !names.has(label.name));
      const firstMissing = missing[0];
      checks.push({
        id: "labels",
        status: missing.length ? "warn" : "ok",
        detail: missing.length
          ? `缺少 ${missing.map((label) => label.name).join("、")}`
          : `${STANDARD_LABELS.length} 个核心标签齐全`,
        ...(firstMissing
          ? {
              fix: `gh label create "${firstMissing.name}" --color ${firstMissing.color} --repo ${singleGithub.owner}/${singleGithub.name}`,
            }
          : {}),
      });
    }
  } else {
    checks.push({ id: "labels", status: "skip", detail: "只在 GitHub 后端检查标签" });
  }

  return { backend, checks };
}
