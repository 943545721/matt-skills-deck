import type { DeckLang } from "./requirement.ts";
import type { WorkspaceConfig, WorkspaceShape } from "./workspace-projects.ts";

/**
 * 打开一个目录时，先弄明白这是哪种工作区。
 *
 * 以前只有一个答案：这个目录就是一块板子。但真实情况是三种——一个项目、同一产品线
 * 的几个项目、以及 `/www/wwwroot` 这种放了一堆互不相关仓库的大目录。第三种如果硬按
 * 「多项目」处理，四拨人的票会混在同一块板上，谁都不好找自己的。
 *
 * 判定只认能说出来的证据（配置清单、远端 owner、仓库名、根目录是不是仓库），
 * 每条结论都带依据；说不清就退到「不成套」并请人来定，不猜。
 */

export interface ShapeRepo {
  dir: string;
  host: "github" | "gitlab";
  owner: string;
  name: string;
}

export interface ShapeInput {
  /** 工作区根目录自己是不是 git 仓库。 */
  rootIsRepo: boolean;
  /** 读出来的配置；没配或读不出来时 null。 */
  config: WorkspaceConfig | null;
  /** 直接子目录里识别到的仓库。 */
  repos: ShapeRepo[];
}

/** 不成套时可选的三条去处。文案由界面按语言取，服务端只回码。 */
export const MIXED_OPTIONS = ["subset", "split", "all-with-source"] as const;
export type MixedOption = (typeof MIXED_OPTIONS)[number];

export interface ShapePrompt {
  /** survey = 多项目，先梳理一遍；mixed = 不成套，先问怎么处理。 */
  kind: "survey" | "mixed";
  title: string;
  lines: string[];
  options: MixedOption[];
}

export interface ShapeVerdict {
  shape: WorkspaceShape;
  /** 判定依据，逐条人能看懂；讲不清的以「未确认」开头。 */
  reasons: string[];
  /** 人已经表过态（写了项目清单，或写了 coordination）：不再主动提示。 */
  acknowledged: boolean;
  /** 需要提示的下一步；单项目时为 null。 */
  prompt: ShapePrompt | null;
}

const key = (repo: ShapeRepo): string => `${repo.owner}/${repo.name}`;

/** 仓库名的共同前缀用来认「同一个产品线」：`kxhyapp.com` 与 `kxhyapp.com-saas` 这类。 */
function sharedNamePrefix(a: string, b: string): string {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return a.slice(0, index);
}

/**
 * 名字关联只在「前缀有实际含义」时算证据。
 *
 * 太短的前缀（`a`、`ap`）谁都能撞上；`app-`、`web-` 这种通用前缀同理——
 * 先掐掉尾部的分隔符再数长度，`app-a` / `app-b` 就不算一家人。
 * 宁可判成不成套让人来定，也不要因为前几个字母撞上就合成一套。
 */
function nameRelated(repos: ShapeRepo[]): boolean {
  for (const [index, a] of repos.entries()) {
    for (const b of repos.slice(index + 1)) {
      const prefix = sharedNamePrefix(a.name, b.name).replace(/[-_. ]+$/, "");
      if (prefix.length >= 4 && /[a-z]/i.test(prefix)) return true;
    }
  }
  return false;
}

const ownersOf = (repos: ShapeRepo[]): string[] => [...new Set(repos.map((repo) => repo.owner))];

/**
 * 判定工作区形态。
 *
 * 顺序有讲究：**人的声明优先于机器的猜测**。写了 `coordination.shape` 就照它，
 * 配了多项清单就当多项目容器——人已经把项目列出来了，再拿目录结构去反驳没有意义。
 */
export function classifyWorkspaceShape(input: ShapeInput): ShapeVerdict {
  const { rootIsRepo, config, repos } = input;
  const declared = config?.coordination?.shape ?? null;

  if (declared) {
    return {
      shape: declared,
      reasons: [
        `配置里声明了 coordination.shape = ${declared}`,
        config?.coordination?.note ? `说明：${config.coordination.note}` : "没有写说明",
      ],
      acknowledged: true,
      prompt: null,
    };
  }

  const configured = config?.projects ?? [];
  if (config?.version === 2 && configured.length >= 2) {
    return {
      shape: "container",
      reasons: [
        `.paseo-deck.json 里列了 ${configured.length} 个项目：${configured.map((item) => item.key).join("、")}`,
        "人已经把项目列进清单，按多项目容器处理",
      ],
      acknowledged: true,
      prompt: null,
    };
  }

  if (repos.length <= 1) {
    const only = repos[0];
    const single = rootIsRepo
      ? "工作区根目录自己就是 git 仓库"
      : only
        ? `只有一个子仓库 ${key(only)}`
        : "没有识别到任何子仓库";
    return { shape: "single", reasons: [single], acknowledged: false, prompt: null };
  }

  const owners = ownersOf(repos);
  const list = repos.map((repo) => `${repo.dir}（${key(repo)}）`).join("、");

  if (owners.length === 1) {
    return {
      shape: "container",
      reasons: [`识别到 ${repos.length} 个仓库：${list}`, `全部属于同一个 owner：${owners[0]}`, "同一 owner 视作同一套项目，但仍建议梳理一遍再开工"],
      acknowledged: false,
      prompt: {
        kind: "survey",
        title: "这是多项目工作区，建议先梳理一遍",
        lines: [
          `识别到 ${repos.length} 个仓库：${list}`,
          "它们还没有写进 .paseo-deck.json，模块与角色也还没确认。",
          "建议调用项目梳理技能（/project-survey）扫一遍，产出 area / role 候选，确认后写进配置。",
          "插件不会自己执行、也不会自己写配置。",
        ],
        options: [],
      },
    };
  }

  if (nameRelated(repos)) {
    return {
      shape: "container",
      reasons: [`识别到 ${repos.length} 个仓库：${list}`, `owner 不同（${owners.join("、")}），但仓库名有共同前缀，暂按同一产品线处理（这条判断只是可能）`, "若其实互不相关，请把 coordination.shape 改成 mixed"],
      acknowledged: false,
      prompt: {
        kind: "survey",
        title: "这是多项目工作区，建议先梳理一遍",
        lines: [
          `识别到 ${repos.length} 个仓库：${list}`,
          "仓库名有共同前缀，按同一产品线处理；owner 不一致，这条判断只是「可能」。",
          "建议先调用项目梳理技能（/project-survey）扫一遍，再决定怎么用。",
        ],
        options: [],
      },
    };
  }

  return {
    shape: "mixed",
    reasons: [`识别到 ${repos.length} 个仓库：${list}`, `它们分属 ${owners.length} 个不同 owner（${owners.join("、")}），仓库名也没有共同前缀`, "未确认：这些目录是不是一套项目，只有人知道"],
    acknowledged: false,
    prompt: {
      kind: "mixed",
      title: "这些仓库看起来不成套",
      lines: [
        `识别到 ${repos.length} 个仓库：${list}`,
        "它们没有共同来源，硬合成一块板会让人找不到自己的票。",
        "先定怎么处理，插件不会自己改配置、不会装技能、不会建票。",
      ],
      options: [...MIXED_OPTIONS],
    },
  };
}

/**
 * 给人粘贴进新会话的梳理提示词。
 *
 * 与 `entry-prompt.ts` 的做法一致：服务端拼好整段话，界面只负责复制，
 * 免得同一段要求在中英两处各写一遍还不一样。
 */
export function surveyPromptText(input: {
  lang: DeckLang;
  shape: WorkspaceShape;
  repos: ShapeRepo[];
  projects: { key: string; dir: string }[];
}): string {
  const { lang, shape, repos, projects } = input;
  const repoList = repos.map((repo) => `${repo.dir}（${repo.owner}/${repo.name}）`).join(lang === "zh" ? "、" : ", ");
  const projectList = projects.map((item) => `${item.key} → ${item.dir}`).join(lang === "zh" ? "、" : ", ");

  if (lang === "zh") {
    const head =
      shape === "mixed"
        ? "这个工作区里放了好几个看起来互不相关的仓库。在把它们放进同一块任务板之前，先判断它们是不是一套项目。"
        : "这是一个多项目工作区，先梳理一遍再开工。";
    return [
      head,
      "",
      `仓库：${repoList || "未识别到"}`,
      projectList ? `已配置的项目：${projectList}` : "还没有写进 .paseo-deck.json 的项目清单。",
      "",
      "请调用 /project-survey：",
      "1. 逐个读项目的 package.json / composer.json / workspace 配置 / Dockerfile / CI，列出模块（area）与角色（role）候选；",
      "2. 每条候选都带依据路径（`路径:行号` 或目录），读不出来就写「未确认」；",
      `3. ${shape === "mixed" ? "先判断这些仓库是不是一套项目，不是的话按「只纳入其中几个 / 拆成两个工作区 / 全部纳入但各自标来源」三选一给出建议；" : "给出这份工作区的项目清单与各自的 area / role 候选；"}`,
      "4. 只给候选与依据，不要写 .paseo-deck.json、不要建标签，等我确认。",
    ].join("\n");
  }

  const head =
    shape === "mixed"
      ? "This workspace holds several repos that look unrelated. Before putting them on one board, work out whether they are actually one set of projects."
      : "This is a multi-project workspace. Survey it before starting work.";
  return [
    head,
    "",
    `Repos: ${repoList || "none found"}`,
    projectList ? `Configured projects: ${projectList}` : "No project list in .paseo-deck.json yet.",
    "",
    "Please invoke /project-survey:",
    "1. Read each project's package.json / composer.json / workspace config / Dockerfile / CI, and list module (area) and role candidates;",
    "2. Give an evidence path for every candidate (`path:line` or a directory); write \"unconfirmed\" when it cannot be read;",
    `3. ${shape === "mixed" ? "First decide whether these repos are one set of projects; if not, recommend one of: include only a subset, split into two workspaces, include all with per-project source labels;" : "Produce the workspace's project list with each project's area / role candidates;"}`,
    "4. Candidates and evidence only — do not write .paseo-deck.json, do not create labels, wait for my confirmation.",
  ].join("\n");
}
