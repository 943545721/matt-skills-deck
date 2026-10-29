import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 环境检查契约。
 *
 * 每一项只回「事实 + 一句怎么修」，不在这里执行修复：装 gh、登录、建仓库都要用户点头，
 * 插件悄悄跑一条写命令比报错更危险。客户端把 `fix` 原样交给用户复制。
 */
const checkId = z.enum([
  "node",
  "git",
  "gh",
  "gh-auth",
  "glab",
  "glab-auth",
  "workspace",
  "repo",
  "backend",
  "skills",
  "labels",
]);

const check = z.object({
  id: checkId,
  status: z.enum(["ok", "warn", "fail", "skip"]),
  detail: z.string(),
  /** 可以安全复制的下一条命令；没有明确且安全的命令时省略。 */
  fix: z.string().optional(),
});

export const envCheckRpc = defineRpc({
  name: "deck.env.check",
  input: z.object({ workspaceDir: z.string().min(1).optional() }),
  output: z.object({
    backend: z.enum(["github", "gitlab", "local", "none"]),
    checks: z.array(check),
    checkedAt: z.string(),
  }),
});

export type EnvCheck = z.infer<typeof check>;
export type EnvCheckId = z.infer<typeof checkId>;

// ---------------------------------------------------------------------------
// 项目清单视图（检查页）
// ---------------------------------------------------------------------------

/**
 * 检查页要回答的四件事，一条一行：
 * 配了几个项目、各自用什么后端、配置哪里不对、配置是不是已经跟目录对不上了。
 *
 * `problem` 与 `areaDrift` 刻意分开：前者是「这个项目当不了任务板目标」（该修），
 * 后者只是「目录结构已变，配置可能过期」（该重跑梳理）——混成一条会让人以为项目坏了。
 */
const projectView = z.object({
  key: z.string(),
  dir: z.string(),
  repo: z.string().nullable(),
  owner: z.string().nullable(),
  areas: z.array(z.string()),
  skillsMode: z.string().nullable(),
  /** 这个项目实际会用的后端；认不出仓库时为 null。 */
  backend: z.enum(["github", "gitlab", "local"]).nullable(),
  /** 目录不存在 / 不是 git 仓库 / 没有远端等，能当任务板目标时为 null。 */
  problem: z.string().nullable(),
  /** areas 在项目目录里找不到对应子目录或 workspace 项：只提示，不算错。 */
  areaDrift: z.array(z.string()),
});

const projectsReport = z.object({
  /** `v1` = 旧格式（只有 repoDir），按单项目读；`none` = 这个工作区没有配置文件。 */
  kind: z.enum(["v1", "v2", "none"]),
  /** 配置坏了才有值；没有配置文件不算错。 */
  error: z.string().nullable(),
  projects: z.array(projectView),
  /** 磁盘上有、清单里没写的仓库。只在 v2 有意义。 */
  drift: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const envProjectsRpc = defineRpc({
  name: "deck.env.projects",
  input: z.object({ workspaceDir: z.string().min(1) }),
  output: projectsReport,
});

export type WorkspaceProjectView = z.infer<typeof projectView>;
export type WorkspaceProjectsReport = z.infer<typeof projectsReport>;

/**
 * `package.json` 里 `workspaces` 声明的包目录。
 *
 * 只认字面条目：带通配符（`apps/*`）的展开需要 glob，宁可把这次判定标成「判不了」，
 * 也不要把一个正常的 monorepo 说成「配置过期」——提示错了比不提示更费人。
 */
export function workspacePackagePaths(text: string | null): { paths: string[]; undecidable: boolean } {
  if (text === null) return { paths: [], undecidable: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { paths: [], undecidable: true };
  }
  const record = (value ?? {}) as { workspaces?: unknown };
  const declared = Array.isArray(record.workspaces)
    ? record.workspaces
    : Array.isArray((record.workspaces as { packages?: unknown } | null)?.packages)
      ? ((record.workspaces as { packages: unknown[] }).packages)
      : [];
  const paths: string[] = [];
  let undecidable = false;
  for (const item of declared) {
    if (typeof item !== "string") continue;
    const entry = item.trim();
    if (!entry) continue;
    if (entry.includes("*")) {
      undecidable = true;
      continue;
    }
    paths.push(entry);
  }
  return { paths, undecidable };
}

/** areas 里哪些在目录结构里找不到对应项。空 areas 不提示：没有清单就没有「过期」可言。 */
export function areasMissingFromStructure(
  areas: readonly string[],
  structure: { dirs: readonly string[]; workspacePaths: readonly string[] },
): string[] {
  if (areas.length === 0) return [];
  const known = new Set<string>();
  for (const dir of structure.dirs) known.add(dir.trim().toLowerCase());
  for (const entry of structure.workspacePaths) {
    const full = entry.replace(/^\.\//, "").replace(/\/+$/, "").trim().toLowerCase();
    if (full) known.add(full);
    const segments = full.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) known.add(last);
  }
  return areas.filter((area) => !known.has(area.trim().toLowerCase()));
}
