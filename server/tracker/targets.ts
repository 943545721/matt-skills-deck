import path from "node:path";
import type { RepoCandidate } from "../../shared/repo.ts";
import type { ProjectOwner, SkillMode, WorkspaceConfig } from "../../shared/workspace-projects.ts";
import { getSettings } from "../settings.ts";
import { localRepoName } from "./local.ts";
import { parseRemoteUrl, readRemoteUrl, webUrlFor, type RemoteRef } from "./remote.ts";
import type { RepoOut } from "./workspace-repo.ts";
import { listChildReposDetailed, probeProjectDir, readSelection, readWorkspaceConfig } from "./workspace-repo.ts";

/**
 * 工作区 → 任务板要覆盖的仓库集合。
 *
 * 与 P15 的单仓库解析不同：一个容器工作区（父目录下多个仓库）不再是「选一个」，
 * 而是「全部显示」。每个目标都带本地代码目录，Agent 拿到票就知道该去哪个目录改。
 *
 * 仍然只认 GitHub / GitLab：别的宿主列出来只会在读取时制造一次失败。
 * 本地 `.deck` 不参与合板——一个工作区只有一个 `.deck/`，它就是兜底。
 */

export interface RepoTarget {
  /** `owner/name`（GitLab 允许 `group/sub/name`）。票号只在仓库内唯一，所有入口靠它定位。 */
  key: string;
  host: "github" | "gitlab";
  owner: string;
  name: string;
  webUrl: string;
  /** 本地代码目录（绝对路径）。 */
  dir: string;
  /** 是否只读。GitHub / GitLab 都可写，能否真写由每次操作的权限闸门判断。 */
  readOnly: boolean;
  /** 解析出来的远端坐标，读路径直接用它，避免再拼一次。 */
  ref: RemoteRef;
}

export type TargetFailure = {
  ok: false;
  reason: "no-repo" | "unsupported-host" | "invalid";
  detail: string;
  /** 已经解析出来的仓库（读失败时顶栏仍要显示名字）。 */
  repo?: RepoOut;
};

export type WorkspaceTargets =
  | { ok: true; kind: "local"; workspaceDir: string; repo: RepoOut; truncated: boolean }
  | { ok: true; kind: "repos"; targets: RepoTarget[]; defaultKey: string | null; truncated: boolean };

export const keyOf = (owner: string, name: string): string => `${owner}/${name}`;

export const repoOf = (target: RepoTarget): RepoOut => ({
  host: target.host,
  owner: target.owner,
  name: target.name,
  webUrl: target.webUrl,
});

const localTargets = (workspaceDir: string, truncated = false): WorkspaceTargets => ({
  ok: true,
  kind: "local",
  workspaceDir,
  truncated,
  repo: { host: "local", owner: "", name: localRepoName(workspaceDir), webUrl: null },
});

/** 配置里写了、但当不了任务板目标的项目，带原因。 */
export interface SkippedProject {
  key: string;
  dir: string;
  reason: string;
}

export interface ProjectTargets {
  config: WorkspaceConfig;
  targets: RepoTarget[];
  skipped: SkippedProject[];
}

/** 设置里的平台；`auto` 时配置里那份 `owner/name` 只能猜一个（GitHub 是默认）。 */
const platformOf = (setting: string): "github" | "gitlab" => (setting === "gitlab" ? "gitlab" : "github");

/** `owner/name`（GitLab 可能 `group/sub/name`）→ 远端坐标。 */
function refFromRepoString(repo: string, host: "github" | "gitlab"): RemoteRef | null {
  const parts = repo.split("/").filter(Boolean);
  const name = parts[parts.length - 1];
  if (parts.length < 2 || !name) return null;
  return { host, owner: parts.slice(0, -1).join("/"), name };
}

/**
 * 把 v2 项目清单翻译成任务板目标。
 *
 * 目录里的真实远端优先，配置里的 `repo` 只是补位：远端是机器上能验证的事实，
 * 配置可能是人写错的。目录不存在的项目照样列进 `skipped`，让界面把话说清楚，
 * 而不是悄悄少一行。
 */
export async function resolveProjectTargets(
  workspaceDir: string,
  setting: string,
  config: WorkspaceConfig,
): Promise<ProjectTargets> {
  const targets: RepoTarget[] = [];
  const skipped: SkippedProject[] = [];
  const seen = new Set<string>();

  for (const project of config.projects) {
    const probe = await probeProjectDir(workspaceDir, project.dir);
    const ref = probe.ref ?? (probe.realDir && project.repo ? refFromRepoString(project.repo, platformOf(setting)) : null);

    if (!ref) {
      skipped.push({ key: project.key, dir: project.dir, reason: probe.problem ?? "没有可识别的远端，也没有写 repo" });
      continue;
    }
    if (ref.host === "other") {
      skipped.push({ key: project.key, dir: project.dir, reason: `远端是 ${ref.host}，任务板只接了 GitHub / GitLab` });
      continue;
    }
    if (setting !== "auto" && ref.host !== setting) {
      skipped.push({ key: project.key, dir: project.dir, reason: `远端是 ${ref.host}，设置要求 ${setting}` });
      continue;
    }

    const key = keyOf(ref.owner, ref.name);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      key,
      host: ref.host,
      owner: ref.owner,
      name: ref.name,
      webUrl: webUrlFor(ref) ?? `https://${ref.host}.com/${ref.owner}/${ref.name}`,
      dir: probe.realDir ?? path.join(workspaceDir, project.dir),
      readOnly: false,
      ref: { host: ref.host, owner: ref.owner, name: ref.name },
    });
  }

  return { config, targets, skipped };
}

/**
 * 解析任务板覆盖的仓库。
 *
 * 顺序：
 * 1. 设置 `local` → 只看 `.deck/`（不为一个用不上的远端跑子目录扫描）；
 * 1.5. `.paseo-deck.json` 是 v2 项目清单 → 清单说了算（人写了清单就不要再猜）；
 * 2. 工作区根目录自己是仓库 → 只认根目录（普通仓库行为不变，不把子仓库也卷进来）；
 * 3. 根目录不是仓库 → 直接子目录里所有 GitHub / GitLab 仓库；
 * 4. 一个都没有 → `auto` 回落本地 `.deck/`，显式后端则报配置错误。
 *
 * `.paseo-deck.json` 不再限制范围，只作为默认筛选 / 新建票的默认目标。
 */
export async function resolveWorkspaceTargets(workspaceDir: string): Promise<WorkspaceTargets | TargetFailure> {
  const setting = getSettings().backend;
  if (setting === "local") return localTargets(workspaceDir);

  const configRead = await readWorkspaceConfig(workspaceDir);
  if (configRead.ok && configRead.config.version === 2) {
    const projectTargets = await resolveProjectTargets(workspaceDir, setting, configRead.config);
    if (projectTargets.targets.length > 0) {
      return { ok: true, kind: "repos", targets: projectTargets.targets, defaultKey: null, truncated: false };
    }
    if (setting !== "auto") {
      const reasons = projectTargets.skipped.map((item) => `${item.key}（${item.reason}）`).join("；");
      return {
        ok: false,
        reason: "unsupported-host",
        detail: reasons
          ? `项目清单里没有能连上 ${setting} 的项目：${reasons}`
          : `项目清单是空的（${setting}）`,
      };
    }
    // auto 且一个都连不上：不把工作区判死，继续走下面的自动识别。
  }

  const rootRemote = await readRemoteUrl(workspaceDir);
  if (rootRemote.ok) {
    const ref = parseRemoteUrl(rootRemote.url);
    if (!ref) {
      // auto 下认不出远端不该判死：本地 `.deck/` 仍然能建票、能看票（与旧行为一致）。
      if (setting === "auto") return localTargets(workspaceDir);
      return { ok: false, reason: "no-repo", detail: `无法识别远端地址：${rootRemote.url}` };
    }
    if (ref.host === "other") {
      return {
        ok: false,
        reason: "unsupported-host",
        detail: `当前远端是 ${ref.host}，任务板只接了 GitHub / GitLab / 本地 Markdown`,
      };
    }
    if (setting !== "auto" && setting !== ref.host) {
      return {
        ok: false,
        reason: "unsupported-host",
        detail: `设置要求 ${setting}，但工作区远端是 ${ref.host}；改回 auto 或换一个匹配的仓库`,
      };
    }
    const webUrl = webUrlFor(ref) ?? `https://${ref.host}.com/${ref.owner}/${ref.name}`;
    const target: RepoTarget = {
      key: keyOf(ref.owner, ref.name),
      host: ref.host,
      owner: ref.owner,
      name: ref.name,
      webUrl,
      dir: workspaceDir,
      readOnly: false,
      ref: { host: ref.host, owner: ref.owner, name: ref.name },
    };
    // 根目录本身就是仓库时没有「子目录默认项」：defaultKey 只表示用户在
    // `.paseo-deck.json` 里显式选过的子目录，免得界面多显示一行「默认仓库」。
    return { ok: true, kind: "repos", targets: [target], defaultKey: null, truncated: false };
  }
  if (rootRemote.reason === "git-missing") {
    // 没装 git 时子目录也扫不了：auto 回落本地，显式后端说明缺什么。
    if (setting === "auto") return localTargets(workspaceDir);
    return { ok: false, reason: "no-repo", detail: rootRemote.detail };
  }

  const selected = await readSelection(workspaceDir);
  const scan = await listChildReposDetailed(workspaceDir);
  let children = scan.repos;
  if (setting !== "auto") children = children.filter((child) => child.host === setting);

  if (children.length === 0) {
    if (setting === "auto") return localTargets(workspaceDir, scan.truncated);
    return {
      ok: false,
      reason: "unsupported-host",
      detail: `设置要求 ${setting}，但这个工作区下没有 ${setting} 仓库；改回 auto 或换一个匹配的工作区`,
    };
  }

  // 同一个远端可能被克隆到两个目录（clone + worktree）：key 相同就只留第一个，
  // 否则列表里每张票都会出现两次，写操作也会在两个等价目标之间犹豫。
  const seen = new Set<string>();
  const targets: RepoTarget[] = [];
  for (const child of children) {
    const key = keyOf(child.owner, child.name);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      key,
      host: child.host,
      owner: child.owner,
      name: child.name,
      webUrl: child.webUrl,
      dir: path.join(workspaceDir, child.dir),
      readOnly: false,
      ref: { host: child.host, owner: child.owner, name: child.name },
    });
  }

  const selectedTarget = selected ? targets.find((target) => target.dir === path.join(workspaceDir, selected)) : undefined;
  return { ok: true, kind: "repos", targets, defaultKey: selectedTarget?.key ?? null, truncated: scan.truncated };
}

export interface WorkspaceRepoListing {
  ok: true;
  kind: "local" | "repos";
  repos: {
    key: string;
    host: "github" | "gitlab" | "local";
    owner: string;
    name: string;
    webUrl: string | null;
    dir: string;
    relDir: string | null;
    readOnly: boolean;
  }[];
  defaultKey: string | null;
  truncated: boolean;
}

/**
 * 界面用的「工作区里有哪些仓库」。
 *
 * 与 `readBoard` 分开：板子按 `repoKey` 筛选后只剩下一个仓库，筛选条不能靠它反推。
 * 这里永远给全集，并带上写 `.paseo-deck.json` 需要的相对目录名。
 */
export async function listWorkspaceRepoTargets(
  workspaceDir: string,
): Promise<WorkspaceRepoListing | TargetFailure> {
  const resolved = await resolveWorkspaceTargets(workspaceDir);
  if (!resolved.ok) return resolved;

  if (resolved.kind === "local") {
    return {
      ok: true,
      kind: "local",
      repos: [
        {
          key: "local",
          host: "local",
          owner: "",
          name: resolved.repo.name,
          webUrl: null,
          dir: resolved.workspaceDir,
          relDir: null,
          readOnly: false,
        },
      ],
      defaultKey: null,
      truncated: resolved.truncated,
    };
  }

  return {
    ok: true,
    kind: "repos",
    repos: resolved.targets.map((target) => {
      const rel = path.relative(workspaceDir, target.dir);
      const relDir = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
      return {
        key: target.key,
        host: target.host,
        owner: target.owner,
        name: target.name,
        webUrl: target.webUrl,
        dir: target.dir,
        relDir,
        readOnly: target.readOnly,
      };
    }),
    defaultKey: resolved.defaultKey,
    truncated: resolved.truncated,
  };
}

export interface WorkspaceProjectRow {
  key: string;
  dir: string;
  repo: string | null;
  owner: ProjectOwner | null;
  areas: string[];
  skillsMode: SkillMode | null;
  /** 目录真实存在且落在工作区内。 */
  exists: boolean;
  /** 能连上任务板时的仓库坐标；否则 null。 */
  resolved: { host: "github" | "gitlab"; owner: string; name: string; webUrl: string } | null;
  /** `resolved` 为 null 时的原因，界面原样显示。 */
  problem: string | null;
}

export interface WorkspaceProjectListing {
  ok: true;
  kind: "v1" | "v2" | "none";
  /** 读得出来时的清单；`none` 时为 null。 */
  config: WorkspaceConfig | null;
  /** 配置坏了才非 null：`missing` 不算错（就当没配）。 */
  error: { reason: string; detail: string } | null;
  projects: WorkspaceProjectRow[];
  /** 磁盘上直接子目录里的仓库：用来提示「清单还漏了哪个」。 */
  scanned: RepoCandidate[];
  /** 配置读出来了、但清单与磁盘对不上的地方。 */
  drift: string[];
  warnings: string[];
}

/**
 * 界面用的「这个工作区里有哪些项目」。
 *
 * 与 `listWorkspaceRepoTargets` 的区别：那边只回答「任务板覆盖了哪些仓库」，这边回答
 * 「配置想说什么、磁盘上是什么」——坏掉的配置、指丢了的目录、漏写进清单的仓库都在这里
 * 说清楚，供设置页与自识别提示使用。
 */
export async function listWorkspaceProjects(workspaceDir: string): Promise<WorkspaceProjectListing> {
  const read = await readWorkspaceConfig(workspaceDir);
  const scanned = (await listChildReposDetailed(workspaceDir)).repos;

  if (!read.ok) {
    return {
      ok: true,
      kind: "none",
      config: null,
      error: read.reason === "missing" ? null : { reason: read.reason, detail: read.detail },
      projects: [],
      scanned,
      drift: [],
      warnings: [],
    };
  }

  const config = read.config;
  const setting = getSettings().backend;
  const rows: WorkspaceProjectRow[] = [];
  const drift: string[] = [];
  const configuredDirs = new Set<string>();

  for (const project of config.projects) {
    configuredDirs.add(project.dir);
    const probe = await probeProjectDir(workspaceDir, project.dir);
    const ref = probe.ref ?? (probe.realDir && project.repo ? refFromRepoString(project.repo, platformOf(setting)) : null);
    const resolved =
      ref && ref.host !== "other"
        ? {
            host: ref.host,
            owner: ref.owner,
            name: ref.name,
            webUrl: webUrlFor(ref) ?? `https://${ref.host}.com/${ref.owner}/${ref.name}`,
          }
        : null;
    rows.push({
      key: project.key,
      dir: project.dir,
      repo: project.repo,
      owner: project.owner,
      areas: project.areas,
      skillsMode: project.skillsMode,
      exists: probe.realDir !== null,
      resolved,
      problem: resolved ? null : (probe.problem ?? "没有可识别的远端，也没有写 repo"),
    });
  }

  for (const repo of scanned) {
    if (configuredDirs.has(repo.dir)) continue;
    drift.push(`磁盘上有 ${repo.dir}（${keyOf(repo.owner, repo.name)}），项目清单里没有它`);
  }

  return {
    ok: true,
    kind: config.version === 2 ? "v2" : "v1",
    config,
    error: null,
    projects: rows,
    scanned,
    drift,
    warnings: config.warnings,
  };
}

export type PickedTarget =
  | { ok: true; kind: "local"; workspaceDir: string; repo: RepoOut }
  | { ok: true; kind: "repos"; target: RepoTarget }
  | TargetFailure;

/**
 * 从目标集合里挑一个。
 *
 * 多目标时不猜：省略 `repoKey` 就明确报错并列出可用仓库。
 * 猜错的代价是「在 A 仓库关掉了 B 仓库的同号票」，比让调用方补一个参数糟得多。
 */
export function pickTarget(targets: WorkspaceTargets, repoKey: string | undefined, action: string): PickedTarget {
  if (targets.kind === "local") {
    // 本地 .deck 只有一个仓库键。传了别的键还照写本地，等于把「owner/repo#12」写到 `.deck/12.md`。
    if (repoKey && repoKey !== "local") {
      return { ok: false, reason: "invalid", detail: `本地 .deck 后端只有仓库键 local，收到：${repoKey}` };
    }
    return { ok: true, kind: "local", workspaceDir: targets.workspaceDir, repo: targets.repo };
  }

  if (repoKey) {
    const target = targets.targets.find((item) => item.key === repoKey);
    if (!target) {
      return {
        ok: false,
        reason: "invalid",
        detail: `没有名为 ${repoKey} 的仓库；这个工作区有：${targets.targets.map((item) => item.key).join("、")}`,
      };
    }
    return { ok: true, kind: "repos", target };
  }

  const only = targets.targets.length === 1 ? targets.targets[0] : undefined;
  if (only) return { ok: true, kind: "repos", target: only };

  return {
    ok: false,
    reason: "invalid",
    detail: `${action}需要指明仓库：这个工作区有 ${targets.targets.length} 个仓库（${targets.targets
      .map((item) => item.key)
      .join("、")}），请带上 repoKey`,
  };
}

export async function resolveTarget(workspaceDir: string, repoKey: string | undefined, action: string): Promise<PickedTarget> {
  const targets = await resolveWorkspaceTargets(workspaceDir);
  if (!targets.ok) return targets;
  return pickTarget(targets, repoKey, action);
}

export type WritableTarget =
  | { ok: true; kind: "local"; key: string; workspaceDir: string; repo: RepoOut }
  | { ok: true; kind: "github"; key: string; ref: RemoteRef; repo: RepoOut; dir: string }
  | { ok: true; kind: "gitlab"; key: string; ref: RemoteRef; repo: RepoOut; dir: string };

/**
 * 只做「写哪个目标」的解析，不做权限闸门。
 *
 * 生产写路径统一走 `tracker/backend.ts` 的 `resolveWritableBackend`：GitLab 在那里
 * 会先查归档 / issue 状态 / 账号权限，问不出来就拒绝。这个函数保留给只需要目标
 * 坐标的调用方，不能拿它绕过权限检查。
 */
export async function resolveWritableTarget(
  workspaceDir: string,
  repoKey: string | undefined,
  action: string,
): Promise<WritableTarget | TargetFailure> {
  const picked = await resolveTarget(workspaceDir, repoKey, action);
  if (!picked.ok) return picked;
  if (picked.kind === "local") {
    return { ok: true, kind: "local", key: "local", workspaceDir: picked.workspaceDir, repo: picked.repo };
  }
  const target = picked.target;
  return {
    ok: true,
    kind: target.host,
    key: target.key,
    ref: target.ref,
    repo: repoOf(target),
    dir: target.dir,
  };
}
