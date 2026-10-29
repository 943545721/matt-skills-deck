import type { Gate } from "../tracker/workspace-repo.ts";
import { resolveWorkspaceRepo } from "../tracker/workspace-repo.ts";

export type { Gate, GateFailure, RepoOut } from "../tracker/workspace-repo.ts";

/**
 * 工作区 → 仓库坐标。读写全部路径共用这一处，保证「同一个工作区看到、写到的都是同一个仓库」。
 *
 * 具体解析顺序（显式选择 / 根目录 / 唯一子目录）在 `tracker/workspace-repo.ts`；
 * 这里保留入口名，调用方不需要知道底层多了一层子目录识别。
 */
export async function resolveRepo(workspaceDir: string): Promise<Gate> {
  return resolveWorkspaceRepo(workspaceDir);
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
