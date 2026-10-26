import type { RemoteFailure, RemoteRef } from "../tracker/remote.ts";
import { parseRemoteUrl, readRemoteUrl } from "../tracker/remote.ts";

/** 读远端失败 → 用户看得懂的一句话。三种原因的下手处不同，不要把话术合成一句。 */
const REMOTE_PROBLEMS: Record<RemoteFailure["reason"], string> = {
  "no-remote": "这个工作区没有可用的 git 远端（origin / upstream），先关联一个 GitHub 仓库再试",
  "not-a-repo": "这个工作区不是可读的 git 仓库，先确认目录里有 .git 且 git 能正常打开它",
  "git-missing": "没有找到 git 命令：装好 git 并确认它在 PATH 里，插件靠它认仓库",
};

export interface RepoOut {
  host: RemoteRef["host"];
  owner: string;
  name: string;
  webUrl: string | null;
}

type RemoteHost = RemoteRef["host"];

export type GateFailure = { ok: false; reason: "no-repo" | "unsupported-host"; detail: string };

export type Gate =
  | { ok: true; ref: RemoteRef; repo: RepoOut }
  | GateFailure;

const WEB_HOSTS: Record<RemoteHost, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  other: "",
};

/** 工作区 → 仓库坐标。读写全部路径共用这一处，保证「同一个工作区看到、写到的都是同一个仓库」。 */
export async function resolveRepo(workspaceDir: string): Promise<Gate> {
  const remote = await readRemoteUrl(workspaceDir);
  if (!remote.ok) {
    return { ok: false, reason: "no-repo", detail: REMOTE_PROBLEMS[remote.reason] };
  }
  const ref = parseRemoteUrl(remote.url);
  if (!ref) {
    return { ok: false, reason: "no-repo", detail: `无法识别远端地址：${remote.url}` };
  }
  const webHost = WEB_HOSTS[ref.host];
  return {
    ok: true,
    ref,
    repo: {
      host: ref.host,
      owner: ref.owner,
      name: ref.name,
      webUrl: webHost ? `${webHost}/${ref.owner}/${ref.name}` : null,
    },
  };
}

/**
 * 读写共用的前置：解析仓库 + 只放 GitHub 过。
 *
 * 写操作尤其需要这道闸：GitLab 的写接口没接，若不拦，用户点「提交评论」会得到
 * 一个「成功」的假象（其实什么都没发生），比明确说「这个后端还写不了」糟得多。
 */
export async function requireGithubRepo(workspaceDir: string, action: string): Promise<Gate> {
  const resolved = await resolveRepo(workspaceDir);
  if (!resolved.ok) return resolved;
  if (resolved.ref.host !== "github") {
    return {
      ok: false,
      reason: "unsupported-host",
      detail: `当前远端是 ${resolved.ref.host}，${action}只接了 GitHub；GitLab 与本地 Markdown 后端在后续阶段补上`,
    };
  }
  return resolved;
}
