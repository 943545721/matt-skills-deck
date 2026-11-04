import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { MIXED_OPTIONS } from "./workspace-shape.ts";
import { PROJECT_OWNERS, SKILL_MODES, WORKSPACE_SHAPES } from "./workspace-projects.ts";

/**
 * 仓库详情。
 *
 * 任务板已经知道 `owner/name`，但那只是坐标；「这个仓库是什么」——描述、可见性、
 * 默认分支、主语言、Star / Fork、打开票数、最近推送——要另取一次。
 * 每次刷新列表都带上这些字段会让列表查询变重，所以单独开一个只读 RPC，
 * 由界面按需缓存。
 *
 * 三种后端共用同一份形状；本地后端没有远端元数据，用 `local*` 三个字段交代
 * 「目录在哪、里面有多少票和标签」，而不是留一片空白让人以为没读到。
 */
const repoDetail = z.object({
  host: z.enum(["github", "gitlab", "local", "other"]),
  fullName: z.string(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  visibility: z.enum(["public", "private", "internal", "unknown"]),
  defaultBranch: z.string().nullable(),
  /** GitHub / GitLab 的主语言；本地后端为 null。 */
  language: z.string().nullable(),
  stars: z.number().int().nullable(),
  forks: z.number().int().nullable(),
  /** GitHub 的这个数包含拉取请求（远端口径），界面上要照实写「打开的票（含 PR）」。 */
  openIssues: z.number().int().nullable(),
  pushedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  license: z.string().nullable(),
  topics: z.array(z.string()),
  /** 本地后端：`.deck/` 所在的工作区目录。 */
  localDir: z.string().nullable(),
  localIssueCount: z.number().int().nullable(),
  localLabelCount: z.number().int().nullable(),
  fetchedAt: z.string(),
});

export type RepoDetail = z.infer<typeof repoDetail>;

/**
 * 直接子目录里的仓库。
 *
 * 只列 GitHub / GitLab：任务板能读的就是这两种；没有远端的子目录列进来只会让人选了之后
 * 再看到一句「不支持」。`dir` 是目录名（单段），也是 `repoDir` 选择里存的值。
 */
const repoCandidate = z.object({
  dir: z.string(),
  host: z.enum(["github", "gitlab"]),
  owner: z.string(),
  name: z.string(),
  webUrl: z.string(),
});

export type RepoCandidate = z.infer<typeof repoCandidate>;

/**
 * 工作区下的仓库候选与当前选择。
 *
 * 根目录本身是仓库时 `rootIsRepo` 为 true，界面不显示选择条——只有「容器目录」才需要选。
 */
export const repoCandidatesRpc = defineRpc({
  name: "deck.repo.candidates",
  input: z.object({ workspaceDir: z.string().min(1) }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      rootIsRepo: z.boolean(),
      selected: z.string().nullable(),
      candidates: z.array(repoCandidate),
    }),
    z.object({ ok: z.literal(false), reason: z.enum(["workspace-missing", "scan-failed"]), detail: z.string() }),
  ]),
});

/**
 * 任务板实际覆盖的全部仓库。
 *
 * 与 `deck.issues.list` 的 `repos` 不同：那份是「本次请求读到的仓库」，按 `repoKey`
 * 筛过之后只剩一个。界面要画筛选条、要让标签页选仓库，需要的是「工作区里有哪些」，
 * 不能拿筛过的结果反推——否则一选中仓库，筛选条自己就消失了。
 *
 * `relDir` 是相对工作区的目录名（写 `.paseo-deck.json` 用）；工作区根目录本身就是仓库时
 * 为 null，表示它已经在根上，没有「子目录默认项」可设。
 */
const repoTarget = z.object({
  key: z.string(),
  host: z.enum(["github", "gitlab", "local"]),
  owner: z.string(),
  name: z.string(),
  webUrl: z.string().nullable(),
  dir: z.string(),
  relDir: z.string().nullable(),
  readOnly: z.boolean(),
});

export type RepoTargetSummary = z.infer<typeof repoTarget>;

export const repoTargetsRpc = defineRpc({
  name: "deck.repo.targets",
  input: z.object({ workspaceDir: z.string().min(1) }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      kind: z.enum(["local", "repos"]),
      repos: z.array(repoTarget),
      /** `.paseo-deck.json` 选定的子目录仓库；没选、或根目录本身就是仓库时为 null。 */
      defaultKey: z.string().nullable(),
      /** 子目录超过扫描上限：界面要说明「只列了前 N 个」，不能让缺失看起来像不存在。 */
      truncated: z.boolean(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["no-repo", "unsupported-host", "invalid"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 配置里的一行项目，外加磁盘上的实况。
 *
 * 「配置写了什么」与「磁盘上是什么」必须一起给：只有前者会让人以为目录还在，
 * 只有后者看不出清单漏了谁。`problem` 是 `resolved` 为 null 时的原因，界面原样显示。
 */
const workspaceProjectRow = z.object({
  key: z.string(),
  dir: z.string(),
  repo: z.string().nullable(),
  owner: z.enum(PROJECT_OWNERS).nullable(),
  areas: z.array(z.string()),
  skillsMode: z.enum(SKILL_MODES).nullable(),
  exists: z.boolean(),
  resolved: z
    .object({ host: z.enum(["github", "gitlab"]), owner: z.string(), name: z.string(), webUrl: z.string() })
    .nullable(),
  problem: z.string().nullable(),
});

/**
 * 工作区的项目清单（`.paseo-deck.json`）与磁盘实况。
 *
 * 只读。项目清单是人的决定，插件只负责把它读出来、指出对不上的地方；
 * 「扫描项目结构、产出模块与角色候选」是另一条路（项目梳理技能），不在这里做。
 */
export const workspaceProjectsRpc = defineRpc({
  name: "deck.workspace.projects",
  input: z.object({ workspaceDir: z.string().min(1) }),
  output: z.object({
    ok: z.literal(true),
    /**
     * 当前 `.paseo-deck.json` 的指纹（sha256；文件不存在是 `missing`）。
     *
     * 保存时带回来比对：两个窗口各开一份编辑器、后保存的那个会覆盖前一个，
     * 一次指纹不合就报「清单已被别处改过」，而不是悄悄盖掉。
     */
    fingerprint: z.string(),
    /** v1 是「选了一个仓库」，v2 是项目清单，none 是没配或读不出来。 */
    kind: z.enum(["v1", "v2", "none"]),
    /** 配置坏了才非 null；没配（missing）不算错。 */
    error: z.object({ reason: z.string(), detail: z.string() }).nullable(),
    projects: z.array(workspaceProjectRow),
    /** 磁盘上直接子目录里的仓库，用于漂移提示。 */
    scanned: z.array(repoCandidate),
    /** 磁盘上有、清单里没写的仓库。 */
    drift: z.array(z.string()),
    /** 配置读出来了，但有些项被忽略 / 兜底，值得人看一眼。 */
    warnings: z.array(z.string()),
  }),
});

/**
 * 清单里的一行，编辑器直接改的就这么三个字段。
 *
 * 只收人真正要决定的东西：叫什么、在哪个目录、技能怎么装。`repo` / `owner` / `areas`
 * 由项目梳理与标签同步经手，编辑器不碰——但它们已经在文件里的，保存时必须原样留着，
 * 所以服务端按下标里的键与旧文件逐行合并，而不是整份重建。
 */
const projectDraft = z.object({
  key: z.string().min(1).max(64),
  dir: z.string().min(1).max(200),
  /** `null` = 跟随工作区设置。 */
  skillsMode: z.enum(SKILL_MODES).nullable(),
});

export type ProjectDraft = z.infer<typeof projectDraft>;

/**
 * 把项目清单写回 `.paseo-deck.json`。
 *
 * 这是面板里唯一能改「工作区有哪些项目」的入口：写入前逐行校验（键名、相对路径、
 * 模式取值、键与目录都不许重复），旧文件先备份，落盘走临时文件 + rename，
 * 写完再按读路径解析一遍核对。校验不过就一个字节都不写。
 */
export const workspaceProjectsSaveRpc = defineRpc({
  name: "deck.workspace.projects.save",
  input: z.object({
    workspaceDir: z.string().min(1),
    projects: z.array(projectDraft).max(50),
    /**
     * 读到的指纹。给了就比对：对不上报 `stale`，不写。
     * 省略表示「不比对」——只给明确知道自己在覆盖旧文件的调用方用。
     */
    expectedFingerprint: z.string().optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      /** 写入的文件绝对路径。 */
      path: z.string(),
      /** 旧文件的备份路径；之前没有文件时为 null。 */
      backup: z.string().nullable(),
      /** 写完之后这份文件的指纹，界面上再保存时带回来。 */
      fingerprint: z.string(),
      projects: z.array(projectDraft),
      /** 不阻断、但要说出来的事：目录不存在、旧文件本来就读不出来、清单是空的。 */
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "stale", "write-failed"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 工作区形态：单项目 / 多项目容器 / 不成套。
 *
 * 只读判定 + 可复制的梳理提示词。判成多项目或不成套时 `prompt` 非空，
 * 界面据此主动提示；`acknowledged` 为 true 表示人已经表过态（写了项目清单或
 * `coordination.shape`），界面不要再弹。
 */
export const workspaceShapeRpc = defineRpc({
  name: "deck.workspace.shape",
  input: z.object({
    workspaceDir: z.string().min(1),
    /** 提示词用哪种语言，跟界面语言走。 */
    lang: z.enum(["zh", "en"]).optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    shape: z.enum(WORKSPACE_SHAPES),
    /** 判定依据，逐条；讲不清的地方以「未确认」开头。 */
    reasons: z.array(z.string()),
    acknowledged: z.boolean(),
    repos: z.array(z.object({ dir: z.string(), host: z.enum(["github", "gitlab"]), owner: z.string(), name: z.string() })),
    projects: z.array(z.object({ key: z.string(), dir: z.string() })),
    configError: z.object({ reason: z.string(), detail: z.string() }).nullable(),
    truncated: z.boolean(),
    surveyPrompt: z.string().nullable(),
    prompt: z
      .object({
        kind: z.enum(["survey", "mixed"]),
        title: z.string(),
        lines: z.array(z.string()),
        options: z.array(z.enum(MIXED_OPTIONS)),
      })
      .nullable(),
  }),
});

/**
 * 记下「这些项目就这么放一起」。
 *
 * 只写 `coordination.shape`：用户说过一次之后，自识别提示就该停。
 * 不顺手改项目清单、不动 v1 文件——那两件事各有各的入口。
 */
export const workspaceAcknowledgeRpc = defineRpc({
  name: "deck.workspace.acknowledge",
  input: z.object({ workspaceDir: z.string().min(1), shape: z.enum(WORKSPACE_SHAPES) }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), shape: z.enum(WORKSPACE_SHAPES) }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "no-config", "v1", "write-failed"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 选定任务板用哪个子目录仓库；`null` 表示清除选择、回到工作区根目录。
 *
 * 选择写进工作区根目录的 `.paseo-deck.json`，服务端所有读写路径都从同一处解析，
 * 所以票面、标签、地图与 MCP 工具不会各用各的仓库。
 */
export const repoSelectRpc = defineRpc({
  name: "deck.repo.select",
  input: z.object({
    workspaceDir: z.string().min(1),
    repoDir: z.string().min(1).max(100).nullable(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), selected: z.string().nullable() }),
    z.object({ ok: z.literal(false), reason: z.enum(["invalid-selection", "write-failed"]), detail: z.string() }),
  ]),
});

export const repoInfoRpc = defineRpc({
  name: "deck.repo.info",
  input: z.object({ workspaceDir: z.string().min(1), repoKey: z.string().min(1).max(200).optional() }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), repo: repoDetail }),
    z.object({
      ok: z.literal(false),
      reason: z.enum([
        "no-repo",
        "unsupported-host",
        "invalid",
        "gh-missing",
        "gh-unauth",
        "gh-failed",
        "glab-missing",
        "glab-unauth",
        "glab-failed",
        "not-found",
        "local-failed",
      ]),
      detail: z.string(),
    }),
  ]),
});

// ---------------------------------------------------------------------------
// issue 模板：按项目补齐 .github/ISSUE_TEMPLATE
// ---------------------------------------------------------------------------

/**
 * 「补齐 issue 模板」：四个表单模板落到各项目仓库的 `.github/ISSUE_TEMPLATE/`。
 *
 * 只补缺失：已存在的文件一律不覆盖，内容不同就列成冲突交给人决定——模板是仓库里的
 * 文件，被人手改过是常态，插件不该假装自己更懂。`apply: false` 只预览，
 * 预览与执行走同一份计划，不会出现「预览说 3 个、实际写 5 个」。
 */
export const workspaceTemplatesRpc = defineRpc({
  name: "deck.workspace.templates",
  input: z.object({ workspaceDir: z.string().min(1), apply: z.boolean() }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      /** 每个项目规划出的模板种类与三态计数。 */
      projects: z.array(
        z.object({
          key: z.string(),
          kinds: z.array(z.string()),
          write: z.number().int(),
          present: z.number().int(),
          conflicts: z.number().int(),
          notes: z.array(z.string()),
        }),
      ),
      /** 真正新建的文件（相对工作区的路径）；预览时为空。 */
      written: z.array(z.string()),
      /** 已存在且内容一致的。 */
      present: z.array(z.string()),
      /** 已存在但内容不同、没有覆盖的。 */
      conflicts: z.array(z.string()),
      failed: z.array(z.object({ path: z.string(), detail: z.string() })),
      notes: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["no-config", "v1", "invalid", "no-projects"]),
      detail: z.string(),
    }),
  ]),
});

export type WorkspaceTemplatesOutput = z.infer<typeof workspaceTemplatesRpc.output>;
