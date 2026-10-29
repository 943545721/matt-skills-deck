import type { DeckLang } from "../../shared/requirement.ts";
import {
  classifyWorkspaceShape,
  surveyPromptText,
  type ShapePrompt,
  type ShapeRepo,
  type ShapeVerdict,
} from "../../shared/workspace-shape.ts";
import type { WorkspaceShape } from "../../shared/workspace-projects.ts";
import { parseRemoteUrl, readRemoteUrl } from "../tracker/remote.ts";
import { listChildReposDetailed, readWorkspaceConfig } from "../tracker/workspace-repo.ts";

/**
 * 工作区自识别的服务端出口。
 *
 * 判定逻辑本身在 `shared/workspace-shape.ts`（纯函数，好测）；这里只负责把磁盘上的
 * 事实凑齐——根目录是不是仓库、子目录里有哪些仓库、配置写了什么——再交给它。
 *
 * 「说清依据」比「猜对」更重要：判错的时候，人凭 reasons 就能看出插件看到了什么。
 */

export interface ShapeDetection extends ShapeVerdict {
  shape: WorkspaceShape;
  repos: ShapeRepo[];
  projects: { key: string; dir: string }[];
  /** 配置读不出来时的原因；没配（missing）为 null。 */
  configError: { reason: string; detail: string } | null;
  /** 子目录超过扫描上限：判定只基于前 N 个，界面要说明。 */
  truncated: boolean;
  /** 可直接粘进新会话的梳理提示词；单项目时为 null。 */
  surveyPrompt: string | null;
  prompt: ShapePrompt | null;
}

export async function detectWorkspaceShape(workspaceDir: string, lang: DeckLang = "zh"): Promise<ShapeDetection> {
  const [configRead, scan, rootRemote] = await Promise.all([
    readWorkspaceConfig(workspaceDir),
    listChildReposDetailed(workspaceDir),
    readRemoteUrl(workspaceDir),
  ]);

  // 没有远端也可能是仓库（本地尚未关联）：只有明确「不是仓库」与「没装 git」才排除。
  const rootIsRepo = !(rootRemote.ok === false && (rootRemote.reason === "not-a-repo" || rootRemote.reason === "git-missing"));
  const config = configRead.ok ? configRead.config : null;
  const repos: ShapeRepo[] = scan.repos.map((repo) => ({
    dir: repo.dir,
    host: repo.host,
    owner: repo.owner,
    name: repo.name,
  }));
  const projects = (config?.projects ?? []).map((project) => ({ key: project.key, dir: project.dir }));

  const verdict = classifyWorkspaceShape({ rootIsRepo, config, repos });
  const reasons = rootIsRepo && rootRemote.ok === false && rootRemote.reason === "no-remote"
    ? [...verdict.reasons, "工作区根目录是 git 仓库，但还没有可识别的远端"]
    : verdict.reasons;

  return {
    ...verdict,
    reasons,
    repos,
    projects,
    configError: configRead.ok || configRead.reason === "missing" ? null : { reason: configRead.reason, detail: configRead.detail },
    truncated: scan.truncated,
    surveyPrompt: verdict.prompt ? surveyPromptText({ lang, shape: verdict.shape, repos, projects }) : null,
  };
}
