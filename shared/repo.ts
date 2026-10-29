import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
