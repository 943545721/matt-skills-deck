import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  repoCandidatesRpc,
  repoInfoRpc,
  repoSelectRpc,
  repoTargetsRpc,
  workspaceAcknowledgeRpc,
  workspaceProjectsRpc,
  workspaceProjectsSaveRpc,
  workspaceShapeRpc,
} from "../../shared/repo.ts";
import { readRepoInfo } from "../tracker/repo-info.ts";
import { listWorkspaceProjects, listWorkspaceRepoTargets } from "../tracker/targets.ts";
import { acknowledgeShape, saveProjectList } from "../workspace/config-write.ts";
import { detectWorkspaceShape } from "../workspace/shape.ts";
import { readRepoCandidates, writeSelection } from "../tracker/workspace-repo.ts";

type RepoInfoInput = RpcInput<typeof repoInfoRpc>;
type RepoCandidatesInput = RpcInput<typeof repoCandidatesRpc>;
type RepoSelectInput = RpcInput<typeof repoSelectRpc>;
type RepoTargetsInput = RpcInput<typeof repoTargetsRpc>;
type WorkspaceProjectsInput = RpcInput<typeof workspaceProjectsRpc>;
type WorkspaceProjectsSaveInput = RpcInput<typeof workspaceProjectsSaveRpc>;
type WorkspaceShapeInput = RpcInput<typeof workspaceShapeRpc>;
type WorkspaceAcknowledgeInput = RpcInput<typeof workspaceAcknowledgeRpc>;

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
 * 项目清单与磁盘实况。
 *
 * 读是只读的：界面用它画「这些项目都在这」的列表、显示配置错误与漂移提示。
 * 写清单走下面那条单独的 RPC，人在面板里按下保存才发生。
 */
export async function workspaceProjectsHandler(
  input: WorkspaceProjectsInput,
): Promise<RpcOutput<typeof workspaceProjectsRpc>> {
  return listWorkspaceProjects(input.workspaceDir);
}

/**
 * 保存项目清单（v2）：面板里唯一能改「工作区有哪些项目」的动作。
 *
 * 校验、备份、原子写、写完读回全在 `saveProjectList` 里做；这里只转一手。
 * 失败按返回码下发（invalid / stale / write-failed），不抛异常——
 * 界面要能逐条说清「哪一行哪一位不合规」，而不是弹一句 500。
 */
export async function workspaceProjectsSaveHandler(
  input: WorkspaceProjectsSaveInput,
): Promise<RpcOutput<typeof workspaceProjectsSaveRpc>> {
  return saveProjectList(input.workspaceDir, input.projects, input.expectedFingerprint);
}

/**
 * 工作区形态判定：只读，不写配置、不装技能、不建票。
 *
 * 判成多项目或不成套时带上可复制的梳理提示词，界面用它做「主动提示」，
 * 由人决定要不要真的跑一遍。
 */
export async function workspaceShapeHandler(
  input: WorkspaceShapeInput,
): Promise<RpcOutput<typeof workspaceShapeRpc>> {
  return { ok: true, ...(await detectWorkspaceShape(input.workspaceDir, input.lang ?? "zh")) };
}

/**
 * 记下工作区形态的判定：唯一会写 `.paseo-deck.json` 的第二条 RPC（第一条是 v1 的选仓库）。
 *
 * 只改 `coordination`，其它字段原样保留；v1 文件拒绝——那份格式里没有地方放这个声明。
 */
export async function workspaceAcknowledgeHandler(
  input: WorkspaceAcknowledgeInput,
): Promise<RpcOutput<typeof workspaceAcknowledgeRpc>> {
  return acknowledgeShape(input.workspaceDir, input.shape);
}
