/**
 * `.paseo-deck.json` 的两代格式。
 *
 * v1 只有一个 `repoDir`：选了容器目录下的某一个仓库。v2 是项目清单：一个工作区
 * 里有几个项目、各自在哪、属于哪一层、有哪些模块。v2 必须是纯增量 —— v1 文件
 * 照旧能读，读出来就是一个只有一个项目的清单，且**不写回文件**。
 *
 * 这里只做「把文件内容变成结构化清单」，不碰文件系统：目录是否存在、是不是 git
 * 仓库由服务端在读路径里判断（那是另一件事，且要能单独测）。
 */

export const PROJECT_CONFIG_FILE = ".paseo-deck.json";

/** 项目在团队里的角色。多了会分不清职责，少了装不下现在的分工（前端/后端/客户端/授权/运维）。 */
export const PROJECT_OWNERS = ["backend", "frontend", "miniapp", "license", "ops"] as const;
export type ProjectOwner = (typeof PROJECT_OWNERS)[number];

/** 技能怎么装到各项目：统一一份，还是各项目各留各的。 */
export const SKILL_MODES = ["unified", "per-project"] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

/**
 * 工作区的形态：单项目、同一产品线的多项目容器、或者一堆互不相关的仓库。
 *
 * 写进配置就表示人已经表过态，插件不再反复提示；不写则由插件依据目录与远端判断。
 */
export const WORKSPACE_SHAPES = ["single", "container", "mixed"] as const;
export type WorkspaceShape = (typeof WORKSPACE_SHAPES)[number];

/** 人对「这些项目到底算不算一套」的声明。 */
export interface WorkspaceCoordination {
  shape: WorkspaceShape | null;
  /** 一句话说明为什么这么分（「这些就是要放一起」之类）。 */
  note: string | null;
}

export interface WorkspaceProject {
  /** 项目标识，小写字母数字连字符；作标签与菜单的稳定键。 */
  key: string;
  /** 相对工作区根目录的路径（`apps/admin-web` 这种多段也允许，但不得越界）。 */
  dir: string;
  /** `owner/name`；本地 Markdown 项目为 null。 */
  repo: string | null;
  owner: ProjectOwner | null;
  /** 模块键（`api`、`admin-web`…）。由项目梳理技能产出、人确认后写进来；可以空。 */
  areas: string[];
  /**
   * 已废弃的模块键：同步标签时**不建**这些 area 标签，也从不去仓库里删已存在的。
   *
   * 项目梳理技能发现「这个模块没了」时把键挪到这里，而不是直接从 `areas` 删掉——
   * 删掉之后没人知道它曾经存在，而仓库里可能还挂着一堆旧票。
   */
  deprecatedAreas: string[];
  /** 这个项目用哪种技能模式；null = 跟随工作区设置。 */
  skillsMode: SkillMode | null;
}

export interface WorkspaceConfig {
  version: 1 | 2;
  projects: WorkspaceProject[];
  /** v2 才有的「这些项目算不算一套」的声明；没有就是 null。 */
  coordination: WorkspaceCoordination | null;
  /** 只提醒、不阻断：读出来的清单能用，但这些地方值得人看一眼。 */
  warnings: string[];
}

export type ConfigFailureReason = "bad-json" | "bad-shape" | "bad-project" | "duplicate-key";

export type ConfigParse =
  | { ok: true; config: WorkspaceConfig }
  | { ok: false; reason: ConfigFailureReason; detail: string };

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AREA_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** GitHub 是 `owner/name`，GitLab 允许 `group/sub/name`：两段或三段，不许空段。 */
const REPO_RE = /^[^/\s]+(\/[^/\s]+){1,2}$/;

/**
 * 项目键与模块键的判据，单独导出。
 *
 * 拼标签名（`area:<key>`、`role:<owner>`）的另一处也要用同一条规则；各抄一份迟早会分叉，
 * 到时候「配置里能写、标签建不出来」这种毛病极难查。
 */
export const isProjectKey = (value: string): boolean => KEY_RE.test(value);
export const isAreaKey = (value: string): boolean => AREA_RE.test(value);

/**
 * 目录必须是工作区内的相对路径。
 *
 * 拒绝绝对路径、盘符、`..` 段与反斜杠：配置写错时宁可报错，也不去读工作区外的目录。
 */
export function isSafeProjectDir(dir: string): boolean {
  if (!dir || dir.length > 200) return false;
  if (dir.startsWith("/") || dir.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(dir)) return false;
  if (dir.includes("\\") || dir.includes("\0")) return false;
  return dir.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** v1 只有 `repoDir`：项目键从目录名推，保证同一份文件每次读到同一个键。 */
function keyFromDir(dir: string): string {
  const slug = dir
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return KEY_RE.test(slug) ? slug : "project";
}

/** `fields` 只用来说明是哪一段写坏了：areas 与 deprecatedAreas 的判据是同一条。 */
function readAreas(raw: unknown, key: string, fields: string, warnings: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`项目 ${key} 的 ${fields} 不是数组，已忽略`);
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    const area = asString(item);
    if (!AREA_RE.test(area)) {
      warnings.push(`项目 ${key} 的 ${fields} 里「${area.slice(0, 40)}」不是合法模块键（小写字母数字连字符），已忽略`);
      continue;
    }
    if (!out.includes(area)) out.push(area);
  }
  return out;
}

function parseProject(raw: unknown, index: number, warnings: string[]): ParseOneResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: `projects[${index}] 不是对象` };
  }
  const item = raw as Record<string, unknown>;
  const key = asString(item.key);
  if (!KEY_RE.test(key)) {
    return { ok: false, detail: `projects[${index}].key「${key.slice(0, 40)}」不合法：小写字母或数字开头，只含小写字母、数字、连字符，最长 64` };
  }
  const dir = asString(item.dir);
  if (!isSafeProjectDir(dir)) {
    return { ok: false, detail: `项目 ${key} 的 dir「${dir.slice(0, 80)}」必须是工作区内的相对路径，且不能含「..」或反斜杠` };
  }

  const repoRaw = item.repo === undefined || item.repo === null ? "" : asString(item.repo);
  if (repoRaw && !REPO_RE.test(repoRaw)) {
    return { ok: false, detail: `项目 ${key} 的 repo「${repoRaw.slice(0, 80)}」要写成 owner/name` };
  }

  const ownerRaw = item.owner === undefined || item.owner === null ? "" : asString(item.owner);
  let owner: ProjectOwner | null = null;
  if (ownerRaw) {
    if (!(PROJECT_OWNERS as readonly string[]).includes(ownerRaw)) {
      return { ok: false, detail: `项目 ${key} 的 owner「${ownerRaw.slice(0, 40)}」只认 ${PROJECT_OWNERS.join(" / ")}` };
    }
    owner = ownerRaw as ProjectOwner;
  }

  const modeRaw = item.skillsMode === undefined || item.skillsMode === null ? "" : asString(item.skillsMode);
  let skillsMode: SkillMode | null = null;
  if (modeRaw) {
    if (!(SKILL_MODES as readonly string[]).includes(modeRaw)) {
      return { ok: false, detail: `项目 ${key} 的 skillsMode「${modeRaw.slice(0, 40)}」只认 ${SKILL_MODES.join(" / ")}` };
    }
    skillsMode = modeRaw as SkillMode;
  }

  return {
    ok: true,
    project: {
      key,
      dir,
      repo: repoRaw || null,
      owner,
      areas: readAreas(item.areas, key, "areas", warnings),
      deprecatedAreas: readAreas(item.deprecatedAreas, key, "deprecatedAreas", warnings),
      skillsMode,
    },
  };
}

type ParseOneResult = { ok: true; project: WorkspaceProject } | { ok: false; detail: string };

/** `coordination` 是人写的声明，写错就直说，不猜一个形状。 */
function readCoordination(raw: unknown): { ok: true; value: WorkspaceCoordination | null } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "coordination 必须是对象" };
  }
  const item = raw as Record<string, unknown>;
  const shapeRaw = item.shape === undefined || item.shape === null ? "" : asString(item.shape);
  let shape: WorkspaceShape | null = null;
  if (shapeRaw) {
    if (!(WORKSPACE_SHAPES as readonly string[]).includes(shapeRaw)) {
      return { ok: false, detail: `coordination.shape「${shapeRaw.slice(0, 40)}」只认 ${WORKSPACE_SHAPES.join(" / ")}` };
    }
    shape = shapeRaw as WorkspaceShape;
  }
  const note = asString(item.note).slice(0, 500);
  if (!shape && !note) return { ok: true, value: null };
  return { ok: true, value: { shape, note: note || null } };
}

/**
 * 解析一份配置对象。
 *
 * 认三种输入：v2（有 `projects`）、v1（只有 `repoDir`）、以及两者都没有的坏形状。
 * 认不出的一律报错，不猜 —— 猜错会让人以为「项目没了」。
 */
export function parseWorkspaceConfigValue(value: unknown): ConfigParse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "bad-shape", detail: "配置必须是 JSON 对象" };
  }
  const raw = value as Record<string, unknown>;
  const warnings: string[] = [];

  if (raw.projects !== undefined) {
    const version = raw.version === undefined ? 2 : raw.version;
    if (version !== 2) {
      return { ok: false, reason: "bad-shape", detail: `认不出的配置版本：${String(version).slice(0, 20)}（有 projects 时版本只能是 2）` };
    }
    if (!Array.isArray(raw.projects)) {
      return { ok: false, reason: "bad-shape", detail: "projects 必须是数组" };
    }
    const projects: WorkspaceProject[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < raw.projects.length; index += 1) {
      const parsed = parseProject(raw.projects[index], index, warnings);
      if (!parsed.ok) return { ok: false, reason: "bad-project", detail: parsed.detail };
      if (seen.has(parsed.project.key)) {
        return { ok: false, reason: "duplicate-key", detail: `项目键重复：${parsed.project.key}` };
      }
      seen.add(parsed.project.key);
      projects.push(parsed.project);
    }
    const coordination = readCoordination(raw.coordination);
    if (!coordination.ok) return { ok: false, reason: "bad-shape", detail: coordination.detail };
    if (projects.length === 0) warnings.push("projects 是空数组：这个工作区没有任何项目，界面会按单仓库模式回退");
    return { ok: true, config: { version: 2, projects, coordination: coordination.value, warnings } };
  }

  const repoDir = asString(raw.repoDir);
  if (!repoDir) {
    return { ok: false, reason: "bad-shape", detail: "配置里既没有 projects 也没有 repoDir，认不出这是哪个版本" };
  }
  if (!isSafeProjectDir(repoDir) || repoDir.includes("/")) {
    // v1 的选择只允许单段目录名（当时的写入端也只写单段），保持同一条边界。
    return { ok: false, reason: "bad-project", detail: `repoDir「${repoDir.slice(0, 80)}」必须是工作区内的单段目录名` };
  }
  return {
    ok: true,
    config: {
      version: 1,
      projects: [
        { key: keyFromDir(repoDir), dir: repoDir, repo: null, owner: null, areas: [], deprecatedAreas: [], skillsMode: null },
      ],
      // v1 没有任何「算不算一套」的声明：老文件不该凭空多出提示。
      coordination: null,
      warnings,
    },
  };
}

/** 解析文件正文。坏 JSON 单独一类，界面要能说「文件写坏了」而不是「没有项目」。 */
export function parseWorkspaceConfigText(text: string): ConfigParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: "bad-json", detail: `配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  return parseWorkspaceConfigValue(value);
}

/** 按项目键取项目；找不到给 null，调用方自己决定回退口径。 */
export function projectByKey(config: WorkspaceConfig, key: string): WorkspaceProject | null {
  return config.projects.find((project) => project.key === key) ?? null;
}

/** v1 配置是「选了一个仓库」，语义上是默认项目而不是唯一项目。 */
export function isLegacyConfig(config: WorkspaceConfig): boolean {
  return config.version === 1;
}
