import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { WorkspaceProject } from "../../shared/workspace-projects.ts";

/**
 * 各项目仓库的 issue 模板。
 *
 * 四类模板对应四种活：后端接口、前端页面、客户端、授权计费。字段固定成五项
 * （背景 / 期望行为 / 影响范围 / 验收标准 / 依赖），是为了让不同项目建出来的票能放在一起看——
 * 少一项，接票的人就得回头问。
 *
 * 写文件只补缺失：已存在的一律不覆盖，内容不同的列成冲突交给人决定。模板是仓库里的文件，
 * 被人手改过是常态，插件不该假装自己更懂。
 */

export const ISSUE_TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";

export const ISSUE_TEMPLATE_KINDS = ["backend-api", "frontend-page", "client-app", "license-billing"] as const;
export type IssueTemplateKind = (typeof ISSUE_TEMPLATE_KINDS)[number];

interface TemplateMeta {
  name: string;
  description: string;
  /** 模板顶部的说明：写什么、不写什么。 */
  intro: string;
  /** area 字段的示例，只影响提示文案。 */
  areaExample: string;
}

const TEMPLATE_META: Record<IssueTemplateKind, TemplateMeta> = {
  "backend-api": {
    name: "后端接口",
    description: "新增或修改一个后端接口",
    intro: "接口地址、入参出参、错误码与权限要求写清楚，别让实现的人去猜。",
    areaExample: "api",
  },
  "frontend-page": {
    name: "前端页面",
    description: "新增或调整一个管理端页面",
    intro: "写清入口路径、数据来源，以及空态与错误态，页面才算说清楚。",
    areaExample: "admin-web",
  },
  "client-app": {
    name: "客户端",
    description: "小程序或客户端的功能改动",
    intro: "写清在哪个端、哪个页面，弱网与授权异常时用户看到什么。",
    areaExample: "miniapp",
  },
  "license-billing": {
    name: "授权计费",
    description: "授权、计费、卡密、订单对账相关改动",
    intro: "写清计费口径、边界条件与对账方式；金额与有效期都要能被验证。",
    areaExample: "license",
  },
};

/** YAML 双引号字符串：中文与标点原样保留，只转义会破坏结构的引号与反斜杠。 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function textBlock(id: string, label: string, description: string, placeholder: string): string[] {
  return [
    "  - type: textarea",
    `    id: ${id}`,
    "    attributes:",
    `      label: ${quoted(label)}`,
    `      description: ${quoted(description)}`,
    `      placeholder: ${quoted(placeholder)}`,
    "    validations:",
    "      required: true",
  ];
}

function inputLine(id: string, label: string, description: string): string[] {
  return [
    "  - type: input",
    `    id: ${id}`,
    "    attributes:",
    `      label: ${quoted(label)}`,
    `      description: ${quoted(description)}`,
  ];
}

/**
 * 一份 GitHub issue form。
 *
 * 字段顺序固定：先背景与期望（为什么做、做成什么样），再范围与验收（动哪里、怎么算完），
 * 最后依赖。依赖放最后是因为它常常是「先看别人把哪张票做完」。
 */
export function issueTemplateText(kind: IssueTemplateKind): string {
  const meta = TEMPLATE_META[kind];
  const lines = [
    `name: ${quoted(meta.name)}`,
    `description: ${quoted(meta.description)}`,
    "labels: []",
    "body:",
    "  - type: markdown",
    "    attributes:",
    `      value: ${quoted(meta.intro)}`,
    ...textBlock("background", "背景", "为什么现在要做这件事：现状、问题、相关链接。", "从一句能复述的问题开始，不要从方案开始。"),
    ...textBlock("expected", "期望行为", "做完之后，谁在什么场景下看到什么、拿到什么。", "描述结果，不描述实现。"),
    ...inputLine(
      "area",
      "影响范围（area）",
      `填 area 标签名，例如 area:${meta.areaExample}；这个项目可用的清单在 .paseo-deck.json 的 areas 里。`,
    ),
    ...textBlock("acceptance", "验收标准", "一条一行，每条都要能被验证：跑什么、看到什么。", "两条以上；「能用」不算验收标准。"),
    ...inputLine("blocked-by", "依赖（Blocked by）", "在正文里写一行 Blocked by: #12, #34；没有依赖就写「无」。"),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * area 键里的词 → 模板类型。
 *
 * 这不是 area 清单：清单来自项目配置（项目梳理技能产出、人确认后写入），
 * 这里只回答「这个名字更像哪一类工作」。命中多类就都写（`auth-api` 两类都像）。
 *
 * 词只收「这个词本身就说明工作性质」的：`auth` / `account` / `order` 都是普通业务模块，
 * 归接口；授权计费只留 license / billing / payment / 卡密 / 额度这些真的在谈钱的词——
 * 把 `auth` 算成计费，会给一个登录模块写出一份对账模板。
 */
const AREA_KIND_HINTS: readonly { kind: IssueTemplateKind; words: readonly string[] }[] = [
  {
    kind: "license-billing",
    words: [
      "license",
      "licenses",
      "licence",
      "licences",
      "billing",
      "bill",
      "bills",
      "pay",
      "payment",
      "payments",
      "subscription",
      "subscriptions",
      "quota",
      "quotas",
      "cardkey",
      "card-key",
      "recharge",
    ],
  },
  {
    kind: "backend-api",
    words: [
      "api",
      "server",
      "backend",
      "service",
      "controller",
      "db",
      "database",
      "worker",
      "job",
      "task",
      "queue",
      "auth",
      "account",
      "accounts",
      "session",
      "user",
      "users",
      "order",
      "orders",
    ],
  },
  {
    kind: "frontend-page",
    words: ["web", "admin", "page", "ui", "view", "dashboard", "console", "portal", "form"],
  },
  {
    kind: "client-app",
    words: ["app", "miniapp", "mini", "client", "wechat", "wx", "mobile", "h5", "uniapp"],
  },
];

/** 没命中任何 area 时的兜底：项目角色是配置里写死的五个值之一。 */
const OWNER_KIND: Record<string, IssueTemplateKind | null> = {
  backend: "backend-api",
  frontend: "frontend-page",
  miniapp: "client-app",
  license: "license-billing",
  // 运维没有对应模板：这四类都是业务票，给运维硬套一类只会制造错票。
  ops: null,
};

/**
 * 这个项目该写哪几份模板。
 *
 * 先按 areas 的关键词匹配（一个项目的多个 area 可以命中多类），一个都没命中时按 owner 兜底；
 * 兜底也没有就是空数组——不写模板不是错，只是这个项目暂时没有对应的工作类型。
 */
export function templateKindsForProject(project: { owner: string | null; areas: readonly string[] }): IssueTemplateKind[] {
  const matched = new Set<IssueTemplateKind>();
  for (const area of project.areas) {
    const tokens = area
      .toLowerCase()
      .split(/[-_.]/)
      .filter(Boolean);
    for (const hint of AREA_KIND_HINTS) {
      if (tokens.some((token) => hint.words.includes(token))) matched.add(hint.kind);
    }
  }
  if (matched.size === 0 && project.owner) {
    const fallback = OWNER_KIND[project.owner];
    if (fallback) matched.add(fallback);
  }
  return ISSUE_TEMPLATE_KINDS.filter((kind) => matched.has(kind));
}

export interface TemplatePlanRow {
  kind: IssueTemplateKind;
  /** 相对工作区的路径（`api/.github/ISSUE_TEMPLATE/backend-api.yml`）。 */
  path: string;
  content: string;
}

export interface TemplatePlan {
  projectKey: string;
  kinds: IssueTemplateKind[];
  /** 需要新建的。 */
  write: TemplatePlanRow[];
  /** 已经存在、内容和我们要写的一致。 */
  present: TemplatePlanRow[];
  /** 已经存在但内容不同：不覆盖，交给人决定。 */
  conflicts: TemplatePlanRow[];
  /** 不写模板的原因。 */
  notes: string[];
}

function templatePath(projectDir: string, kind: IssueTemplateKind): string {
  const dir = projectDir.replace(/\/+$/, "");
  return `${dir}/${ISSUE_TEMPLATE_DIR}/${kind}.yml`;
}

/**
 * 一个项目的模板落盘计划（纯函数）。
 *
 * `readFile` 由调用方注入：测试不必造真实文件树，生产传 `readFileSync` 的薄封装。
 */
export function planIssueTemplates(input: {
  project: { key: string; dir: string; owner: string | null; areas: readonly string[] };
  readFile(relPath: string): string | null;
}): TemplatePlan {
  const kinds = templateKindsForProject(input.project);
  const plan: TemplatePlan = { projectKey: input.project.key, kinds, write: [], present: [], conflicts: [], notes: [] };
  if (kinds.length === 0) {
    plan.notes.push(
      `项目 ${input.project.key} 没有对应的 issue 模板（owner=${input.project.owner ?? "未填"}，areas 也没命中四类之一）`,
    );
    return plan;
  }
  for (const kind of kinds) {
    const row: TemplatePlanRow = { kind, path: templatePath(input.project.dir, kind), content: issueTemplateText(kind) };
    const existing = input.readFile(row.path);
    if (existing === null) plan.write.push(row);
    else if (existing === row.content) plan.present.push(row);
    else plan.conflicts.push(row);
  }
  return plan;
}

export interface TemplateWriteOutcome {
  plans: TemplatePlan[];
  /** 真正新建的文件（相对路径）。 */
  written: string[];
  /** 已存在且内容不同、没有覆盖的文件。 */
  conflicts: string[];
  failed: { path: string; detail: string }[];
}

/**
 * 各项目的模板计划（只读盘，不写盘）。
 *
 * 单独抽出来是为了让界面能先「预览」再决定写：补模板会往别人的仓库里加文件，
 * 预览与执行必须是同一份判断，否则预览说 3 个、实际写 5 个。
 */
export function planWorkspaceTemplates(
  workspaceDir: string,
  projects: readonly Pick<WorkspaceProject, "key" | "dir" | "owner" | "areas">[],
): TemplatePlan[] {
  return projects.map((project) =>
    planIssueTemplates({
      project,
      readFile: (relPath) => {
        try {
          return readFileSync(path.join(workspaceDir, ...relPath.split("/")), "utf8");
        } catch {
          return null;
        }
      },
    }),
  );
}

/**
 * 把模板写进各项目仓库。
 *
 * 用 `wx` 打开：即便两个进程同时跑，第二个也写不进去——冲突进 `conflicts`，绝不覆盖。
 * 一个文件失败只记一条，继续写后面的，最后一起交出去。
 */
export async function writeIssueTemplates(
  workspaceDir: string,
  projects: readonly WorkspaceProject[],
): Promise<TemplateWriteOutcome> {
  const plans = planWorkspaceTemplates(workspaceDir, projects);

  const written: string[] = [];
  const conflicts = plans.flatMap((plan) => plan.conflicts.map((row) => row.path));
  const failed: { path: string; detail: string }[] = [];

  for (const plan of plans) {
    for (const row of plan.write) {
      const target = path.join(workspaceDir, ...row.path.split("/"));
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, row.content, { encoding: "utf8", flag: "wx" });
        written.push(row.path);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "EEXIST") {
          conflicts.push(row.path);
          continue;
        }
        failed.push({ path: row.path, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return { plans, written, conflicts, failed };
}
