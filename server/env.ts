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

  let host = "";
  let gate: Gate | null = null;
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
    gate = await probe.resolveRepo(workspaceDir);
    if (gate.ok) {
      host = gate.ref.host;
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

  const settings = probe.settings();
  const backend = effectiveBackend(settings.backend, host);
  const forcedMismatch = settings.backend !== "auto" && gate?.ok === true && settings.backend !== host;
  // 迁移前置检查：切换后端不会搬数据，所以至少要把「切过去会看不见什么」先说清楚。
  const localBoard = workspaceDir ? await probe.exists(path.join(workspaceDir, ".deck")) : false;
  const migrationNotes: string[] = [];
  if (backend !== "local" && localBoard) migrationNotes.push("工作区里已有 .deck/ 本地票，当前后端不会显示它们");
  if (backend === "local" && gate?.ok === true) migrationNotes.push(`远端是 ${host}，本地后端只显示 .deck/ 里的票`);
  if (backend === "gitlab") migrationNotes.push("GitLab 后端目前只读，写操作会如实拒绝");
  const baseDetail = forcedMismatch
    ? `设置要求 ${settings.backend}，但工作区远端是 ${host}`
    : backend === "local"
      ? "本地 Markdown（数据在 .deck/）"
      : backend;
  checks.push({
    id: "backend",
    status: forcedMismatch ? "fail" : migrationNotes.length ? "warn" : "ok",
    detail: [baseDetail, ...migrationNotes].join("；"),
    ...(forcedMismatch ? { fix: `在设置里把后端改回 auto，或换一个 ${settings.backend} 仓库` } : {}),
  });

  if (backend === "gitlab") {
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

  const githubRepo = gate?.ok === true ? gate.ref : null;
  if (backend === "github" && gh.ok && githubRepo?.host === "github") {
    const labels = await probe.listLabels(githubRepo.owner, githubRepo.name);
    if (!labels.ok) {
      checks.push({ id: "labels", status: "warn", detail: `读不到标签：${labels.detail.slice(0, 160)}` });
    } else {
      const names = new Set(labels.labels.map((label) => label.name));
      const missing = STANDARD_LABELS.filter((label) => !names.has(label.name));
      const firstMissing = missing[0];
      checks.push({
        id: "labels",
        status: missing.length ? "warn" : "ok",
        detail: missing.length ? `缺少 ${missing.map((label) => label.name).join("、")}` : "五个 wayfinder 标签齐全",
        ...(firstMissing
          ? {
              fix: `gh label create "${firstMissing.name}" --color ${firstMissing.color} --repo ${githubRepo.owner}/${githubRepo.name}`,
            }
          : {}),
      });
    }
  } else {
    checks.push({ id: "labels", status: "skip", detail: "只在 GitHub 后端检查标签" });
  }

  return { backend, checks };
}
