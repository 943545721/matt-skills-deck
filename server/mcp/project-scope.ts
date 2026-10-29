/**
 * 建票 / 建图时的「这张票属于哪个项目、哪个模块」。
 *
 * 两代配置的差别全在这里收口：v1（只有一个 `repoDir`）与「没有配置」都当作
 * 「没有项目清单」——调用方拿到的 `project` 是 null，标签一个都不加，行为与接这个
 * 功能之前一模一样。只有 v2 的 `projects[]` 里真的对得上某个项目时，才会据此加
 * `area:<k>` / `role:<owner>`。
 *
 * 定位不上就拒绝，不猜：多项目工作区里把 area 猜错，票会被挂在一个它不属于的模块上，
 * 后面按 area 筛人、筛板子全是错的，而且没人会发现自己被猜了。拒绝时把可选值列全。
 */

import { areaLabelName, isAreaKey, roleLabelName } from "../../shared/labels.ts";
import {
  PROJECT_CONFIG_FILE,
  projectByKey,
  type WorkspaceConfig,
  type WorkspaceProject,
} from "../../shared/workspace-projects.ts";
import { buildMapBody, mapSkeletonBody, parseMapBody } from "../tracker/map-body.ts";
import { readWorkspaceConfig } from "../tracker/workspace-repo.ts";

/** 读出来的 v2 清单；`why` 说明为什么没有清单（给错误信息用）。 */
type LoadedConfig = { config: WorkspaceConfig } | { why: string };

/**
 * 只认 v2 且真的有项目的那份清单。
 *
 * v1 会被解析成「只有一个项目的清单」，但那个项目没有 areas、没有 owner，
 * 拿它当依据只会凭空造出标签——所以这里明确退回「没有清单」。
 */
async function loadV2Projects(workspaceDir: string): Promise<LoadedConfig> {
  const read = await readWorkspaceConfig(workspaceDir);
  if (!read.ok) {
    const why =
      read.reason === "missing"
        ? `工作区里没有 ${PROJECT_CONFIG_FILE}`
        : `项目清单 ${PROJECT_CONFIG_FILE} 读不出来（${read.detail ?? read.reason}）`;
    return { why: `${why}，没有项目清单可用` };
  }
  const config = read.config;
  if (config.version !== 2) {
    return { why: "这个工作区用的是 v1 配置（只有一个 repoDir），里面没有项目清单" };
  }
  if (config.projects.length === 0) {
    return { why: "项目清单里没有任何项目（projects 是空数组）" };
  }
  return { config };
}

/** 目标仓库对得上哪个项目：按配置里的 `repo` 比，大小写不敏感（GitHub 的 owner/name 本就不分大小写）。 */
export function projectForRepo(projects: readonly WorkspaceProject[], repoKey: string): WorkspaceProject | null {
  const wanted = repoKey.trim().toLowerCase();
  // 本地后端没有 owner/name 这样的坐标，不去撞 `repo === null` 的项目。
  if (!wanted || wanted === "local") return null;
  return projects.find((project) => (project.repo ?? "").toLowerCase() === wanted) ?? null;
}

const projectKeys = (projects: readonly WorkspaceProject[]): string => projects.map((project) => project.key).join("、");

/** 这个项目能选的模块：登记在册的才算，废弃单列一句，别让人以为它是可选值。 */
function areaChoices(project: WorkspaceProject): string {
  const areas = project.areas.join("、");
  const deprecated = project.deprecatedAreas.length > 0 ? `；已废弃：${project.deprecatedAreas.join("、")}` : "";
  return areas ? `${areas}${deprecated}` : `（这个项目还没登记任何模块）${deprecated}`;
}

export interface IssueProjectScope {
  /** 对上的项目；没有清单或对不上时为 null。 */
  project: WorkspaceProject | null;
  /** 这次指定的模块键；没指定时为 null。 */
  area: string | null;
  /** 这次自动加的标签：只增不删，调用方负责与手写标签合并去重。 */
  labels: string[];
  /** 不阻断、但值得说一句的偏差（例如项目登记的仓库与这次写的仓库不是同一个）。 */
  warnings: string[];
}

export type IssueScopeResult = { ok: true; scope: IssueProjectScope } | { ok: false; detail: string };

const noScope = (): IssueProjectScope => ({ project: null, area: null, labels: [], warnings: [] });

/**
 * 为「新建一张票」定位项目与模块，并算出该自动带上哪些标签。
 *
 * - 没有 v2 清单：给空 scope，不报错（单项目用户零变化）；但这时还传了 project/area
 *   就要明说按不了，否则人会以为标签已经加上了。
 * - 指定了 project：必须存在；area 必须在该项目自己的 areas 里（废弃的不收）。
 * - 没指定 project：拿目标仓库反查；反查不到还给了 area 就拒绝（area 属于哪个项目说不清）。
 */
export async function resolveIssueProjectScope(input: {
  workspaceDir: string;
  /** 目标仓库的键：远端是 `owner/name`，本地后端是 `local`。 */
  repoKey: string;
  projectKey?: string;
  area?: string;
}): Promise<IssueScopeResult> {
  const askedProject = (input.projectKey ?? "").trim();
  const askedArea = (input.area ?? "").trim();

  const loaded = await loadV2Projects(input.workspaceDir);
  if (!("config" in loaded)) {
    if (!askedProject && !askedArea) return { ok: true, scope: noScope() };
    return {
      ok: false,
      detail: `${loaded.why}，没法核对 project / area：先补上项目清单，或者去掉这两个参数再建。`,
    };
  }

  const located = locateProject(loaded.config, askedProject, input.repoKey, askedArea !== "");
  if (!located.ok) return located;
  const project = located.project;
  // 对不上任何项目：照旧建票，一个标签都不加——这是单项目 / 仓库不在清单里的老行为。
  if (!project) return { ok: true, scope: noScope() };

  if (askedArea) {
    const areaProblem = areaValidation(project, askedArea);
    if (areaProblem) return { ok: false, detail: areaProblem };
  }

  return {
    ok: true,
    scope: {
      project,
      area: askedArea || null,
      labels: scopedLabelsFor(project, askedArea),
      warnings: scopeWarnings(project, askedProject, input.repoKey, askedArea),
    },
  };
}

type LocateResult = { ok: true; project: WorkspaceProject | null } | { ok: false; detail: string };

/** 项目定位：显式 project 优先，其次按目标仓库反查；给了 area 却定位不上就拒绝。 */
function locateProject(
  config: WorkspaceConfig,
  askedProject: string,
  repoKey: string,
  hasArea: boolean,
): LocateResult {
  if (!askedProject) {
    const matched = projectForRepo(config.projects, repoKey);
    if (!matched && hasArea) {
      return {
        ok: false,
        detail: `仓库 ${repoKey || "(未指明)"} 对不上清单里的任何一个项目，area 不知道算哪个项目的模块：请带上 project（可选 ${projectKeys(config.projects)}）。`,
      };
    }
    return { ok: true, project: matched };
  }
  const project = projectByKey(config, askedProject);
  if (!project) {
    return {
      ok: false,
      detail: `项目键「${askedProject.slice(0, 64)}」不在 .paseo-deck.json 的清单里：可选 ${projectKeys(config.projects)}。`,
    };
  }
  return { ok: true, project };
}

/** 自动标签：模块在前、角色在后；没有 owner 就只给 area。 */
function scopedLabelsFor(project: WorkspaceProject, area: string): string[] {
  return [...(area ? [areaLabelName(area)] : []), ...(project.owner ? [roleLabelName(project.owner)] : [])];
}

/** 只提醒、不拦人的偏差：项目登记的仓库与这次写的不一致；或者干脆没选模块。 */
function scopeWarnings(project: WorkspaceProject, askedProject: string, repoKey: string, area: string): string[] {
  const warnings: string[] = [];
  const projectRepo = (project.repo ?? "").trim();
  const target = repoKey.trim();
  if (askedProject && projectRepo && target && target !== "local" && projectRepo.toLowerCase() !== target.toLowerCase()) {
    warnings.push(
      `项目 ${project.key} 登记的仓库是 ${projectRepo}，这次写的却是 ${target}：标签按项目加，但票落在了另一个仓库。`,
    );
  }
  if (!area && project.areas.length > 0) {
    warnings.push(`没有指定 area：这张票只带 role 标签，不会带 area 标签（项目 ${project.key} 可选 ${project.areas.join("、")}）。`);
  }
  return warnings;
}

/** 模块键能不能算这个项目的：不合法、已废弃、没登记都各给一句准话。 */
function areaValidation(project: WorkspaceProject, area: string): string | null {
  if (!isAreaKey(area)) {
    return `area「${area.slice(0, 40)}」不是合法模块键（小写字母或数字开头，只含小写字母、数字、连字符，最长 32）。`;
  }
  if (project.deprecatedAreas.includes(area)) {
    return `模块「${area}」在项目 ${project.key} 里已标为废弃（deprecatedAreas）：不要再往它上面挂票。可选 ${areaChoices(project)}。`;
  }
  if (!project.areas.includes(area)) {
    return `项目 ${project.key} 没有模块「${area}」：可选 ${areaChoices(project)}。模块清单来自 .paseo-deck.json 的 areas，结构变了就重跑项目梳理再改。`;
  }
  return null;
}

/** 只增不删地合并标签：手写的先来，自动加的按顺序补在后面，同名只留一份。 */
export function mergeScopedLabels(labels: readonly string[], extra: readonly string[]): string[] {
  const out: string[] = [];
  for (const label of [...labels, ...extra]) {
    const name = label.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export type MapProjectResult = { ok: true; project: WorkspaceProject | null } | { ok: false; detail: string };

/**
 * 为「建一张地图」定位所属项目。
 *
 * 显式给了 project 就必须存在；没给就按目标仓库反查。没有 v2 清单时给 null，
 * 调用方据此退回原来的正文写法——不拿「目录名像某个项目」之类的东西凑一个。
 */
export async function resolveMapProject(input: {
  workspaceDir: string;
  repoKey: string;
  projectKey?: string;
}): Promise<MapProjectResult> {
  const asked = (input.projectKey ?? "").trim();
  const loaded = await loadV2Projects(input.workspaceDir);
  if (!("config" in loaded)) {
    if (!asked) return { ok: true, project: null };
    return { ok: false, detail: `${loaded.why}，没法把这张图归到项目「${asked.slice(0, 64)}」：先补上项目清单，或者去掉 project 再建。` };
  }
  if (!asked) return { ok: true, project: projectForRepo(loaded.config.projects, input.repoKey) };
  const project = projectByKey(loaded.config, asked);
  if (!project) {
    return {
      ok: false,
      detail: `项目键「${asked.slice(0, 64)}」不在 .paseo-deck.json 的清单里：可选 ${projectKeys(loaded.config.projects)}。`,
    };
  }
  return { ok: true, project };
}

/**
 * `parseMapBody` 把列表项的 `- ` 符号原样留着（与写侧同口径），再交给 `buildMapBody` 之前
 * 必须先剥掉——否则会写出 `- - pages：…`，读回来就是一坨多出来的横线。
 */
const stripBullet = (line: string): string => line.replace(/^-\s*/, "").trim();

/**
 * 地图正文：有项目就按该项目的 areas 生成骨架，没有就原样走 `buildMapBody`。
 *
 * 骨架里的东西（按模块分组的决策位与雾、本图只覆盖哪个项目、跨项目引用怎么写）是
 * 这个功能的全部价值，所以要保留；调用方自己给的 notes / decisions / fog / outOfScope
 * 也不能丢。做法是先让 `mapSkeletonBody` 造句，再用 `parseMapBody` 读回它自己的五个区块
 * ——读写是同一对函数（有测试钉住），读回来的形状就是面板上看到的形状，比在这里
 * 再抄一份骨架文案可靠。代价是 Notes 里的换行会被读成空格（解析层按段落合并），
 * 内容不丢，只是合成一段。
 */
export function mapPlanBody(input: {
  destination: string;
  notes?: string | undefined;
  decisions?: readonly { title: string; url?: string | undefined; gist?: string | undefined }[] | undefined;
  fog?: readonly string[] | undefined;
  outOfScope?: readonly string[] | undefined;
  project: WorkspaceProject | null;
}): string {
  if (!input.project) {
    return buildMapBody({
      destination: input.destination,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.decisions !== undefined ? { decisions: input.decisions } : {}),
      ...(input.fog !== undefined ? { fog: input.fog } : {}),
      ...(input.outOfScope !== undefined ? { outOfScope: input.outOfScope } : {}),
    });
  }
  const skeleton = parseMapBody(
    mapSkeletonBody({
      destination: input.destination,
      areas: input.project.areas,
      project: { key: input.project.key, dir: input.project.dir },
    }),
  );
  const noteParts = [skeleton.notes.trim(), (input.notes ?? "").trim()].filter(Boolean);
  return buildMapBody({
    destination: skeleton.destination,
    notes: noteParts.join("\n"),
    // 人写的决策排在前面、模块占位排在后面：占位是给还没想清楚的地方留位，不是结论。
    decisions: [...(input.decisions ?? []), ...skeleton.decisions],
    fog: [...(input.fog ?? []).map(stripBullet).filter(Boolean), ...skeleton.fog.map(stripBullet).filter(Boolean)],
    outOfScope: [
      ...(input.outOfScope ?? []).map(stripBullet).filter(Boolean),
      ...skeleton.outOfScope.map(stripBullet).filter(Boolean),
    ],
  });
}
