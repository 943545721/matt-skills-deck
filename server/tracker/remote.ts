import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RemoteRef {
  host: "github" | "gitlab" | "other";
  /** GitHub 恒为一段；GitLab 允许子组，所以可能是 `group/subgroup`。 */
  owner: string;
  name: string;
}

const HOST_ALIASES: Record<string, "github" | "gitlab"> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
};

/**
 * 把 git remote 的地址解析成仓库坐标。
 *
 * 为什么自己解析而不是问 gh：`gh` 只认 GitHub，而我们要在同一个入口支持 GitLab；
 * 且用户在没装 gh 时也应该能看到「这个工作区对应哪个仓库」，而不是一片空白。
 * 认不出的形态返回 null，交给上层报「没有可用的仓库」——不猜。
 */
export function parseRemoteUrl(raw: string): RemoteRef | null {
  const url = raw.trim().replace(/\.git$/i, "");
  if (!url) return null;

  let host: string | undefined;
  let pathPart: string | undefined;

  // scp 风格：git@github.com:owner/name
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
  if (scp && !url.includes("://")) {
    host = scp[1];
    pathPart = scp[2];
  } else {
    // 协议风格：https://host/owner/name、ssh://git@host:22/owner/name
    const proto = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
    if (proto) {
      host = proto[1];
      pathPart = proto[2];
    }
  }

  if (!host || !pathPart) return null;
  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const name = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join("/");
  if (!name || !owner) return null;

  return { host: HOST_ALIASES[host.toLowerCase()] ?? "other", owner, name };
}

/**
 * 从 remote 名字列表里挑一条主远端。
 *
 * 为什么不是一个 origin 到底：真实仓库里很常见「origin 指向自己的 fork，upstream 指向上游」，
 * 也常见只剩 upstream 的克隆。硬绑 origin 会让这些工作区直接读不到票，
 * 而用户看到的解释是「没有仓库」——错得让人没处下手。
 */
export function pickPrimaryRemote(names: readonly string[]): string | null {
  if (names.includes("origin")) return "origin";
  if (names.includes("upstream")) return "upstream";
  return names[0] ?? null;
}

export type RemoteFailure = { ok: false; reason: "no-remote" | "not-a-repo" | "git-missing"; detail: string };

/**
 * 读工作区的主远端地址。
 *
 * 三种失败分开报，而不是一律 null：它们对用户是三种不同的下手处（关联远端 / 换目录 / 装 git），
 * 混成一句「这个工作区没有票」会让人往错的方向排查——尤其是「PATH 里没有 git」，
 * 那时所有会话都静默拿不到工具，日志却说是「没有远端」。
 */
export async function readRemoteUrl(workspaceDir: string): Promise<{ ok: true; url: string } | RemoteFailure> {
  try {
    const { stdout: listing } = await execFileAsync("git", ["-C", workspaceDir, "remote"], {
      timeout: 5_000,
      maxBuffer: 1 << 20,
    });
    const name = pickPrimaryRemote(listing.split("\n").map((line) => line.trim()).filter(Boolean));
    if (!name) return { ok: false, reason: "no-remote", detail: `这个仓库没有配置远端（origin / upstream）：${workspaceDir}` };
    const { stdout } = await execFileAsync("git", ["-C", workspaceDir, "remote", "get-url", name], {
      timeout: 5_000,
      maxBuffer: 1 << 20,
    });
    const url = stdout.trim();
    if (!url) return { ok: false, reason: "no-remote", detail: `远端 ${name} 没有地址：${workspaceDir}` };
    return { ok: true, url };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "git-missing", detail: "没有找到 git 命令：装好 git 并确认它在 PATH 里" };
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim().slice(0, 300) : error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "not-a-repo", detail: `读不到 git 远端（${detail.slice(0, 200)}）` };
  }
}
