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

/**
 * 读工作区的主远端地址。
 *
 * 没有 remote、不是 git 仓库、或者 git 不可用，一律返回 null：
 * 这三种情况对界面的意义相同（这个工作区暂时没有可读的票），没必要分成三种错误码。
 */
export async function readRemoteUrl(workspaceDir: string): Promise<string | null> {
  try {
    const { stdout: listing } = await execFileAsync("git", ["-C", workspaceDir, "remote"], {
      timeout: 5_000,
      maxBuffer: 1 << 20,
    });
    const name = pickPrimaryRemote(listing.split("\n").map((line) => line.trim()).filter(Boolean));
    if (!name) return null;
    const { stdout } = await execFileAsync("git", ["-C", workspaceDir, "remote", "get-url", name], {
      timeout: 5_000,
      maxBuffer: 1 << 20,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
