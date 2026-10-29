import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  repoCandidatesRpc,
  repoInfoRpc,
  repoSelectRpc,
  repoTargetsRpc,
  workspaceProjectsRpc,
} from "../../shared/repo.ts";
import { readRepoInfo } from "../tracker/repo-info.ts";
import { listWorkspaceProjects, listWorkspaceRepoTargets } from "../tracker/targets.ts";
import { readRepoCandidates, writeSelection } from "../tracker/workspace-repo.ts";

type RepoInfoInput = RpcInput<typeof repoInfoRpc>;
type RepoCandidatesInput = RpcInput<typeof repoCandidatesRpc>;
type RepoSelectInput = RpcInput<typeof repoSelectRpc>;
type RepoTargetsInput = RpcInput<typeof repoTargetsRpc>;
type WorkspaceProjectsInput = RpcInput<typeof workspaceProjectsRpc>;

/**
 * 工作区实际覆盖的仓库全集。
 *
 * 界面拿它画筛选条、给标签页选仓库、决定默认筛选；票列表按 `repoKey` 筛过之后
 * 只剩一个仓库，不能反推全集。
 */
export async function repoTargetsHandler(
  input: RepoTargetsInput,
): Promise<RpcOutput<typeof repoTargetsRpc>> {
  return listWorkspaceRepoTargets(input.workspaceDir);
}

/**
 * 仓库详情的 RPC 出口。
 *
 * 只读：不写设置、不碰远端。失败按返回值下发，不抛异常——
 * 「没关联仓库」「gh 没登录」都是可解释的状态，界面要和任务板错误卡片用同一套话术。
 */
export async function repoInfoHandler(input: RepoInfoInput): Promise<RpcOutput<typeof repoInfoRpc>> {
  return readRepoInfo(input.workspaceDir, input.repoKey);
}

/** 子目录仓库候选：只读，不写选择文件。 */
export async function repoCandidatesHandler(
  input: RepoCandidatesInput,
): Promise<RpcOutput<typeof repoCandidatesRpc>> {
  return readRepoCandidates(input.workspaceDir);
}

/**
 * 选定 / 清除任务板用的子目录仓库。
 *
 * 唯一会往工作区写文件的一条 RPC：只写 `.paseo-deck.json`，内容只有一个单层目录名，
 * 路径越界、目录不存在、不是 git 仓库都拒绝。失败不抛异常，界面照常显示。
 */
export async function repoSelectHandler(input: RepoSelectInput): Promise<RpcOutput<typeof repoSelectRpc>> {
  return writeSelection(input.workspaceDir, input.repoDir);
}

/**
 * 项目清单与磁盘实况：只读，不写配置。
 *
 * 界面用它画「这些项目都在这」的列表、显示配置错误与漂移提示；
 * 写清单是人的事（或项目梳理技能给人确认后由人落笔），这里不代劳。
 */
export async function workspaceProjectsHandler(
  input: WorkspaceProjectsInput,
): Promise<RpcOutput<typeof workspaceProjectsRpc>> {
  return listWorkspaceProjects(input.workspaceDir);
}
