import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSkillFrontmatter } from "./frontmatter.ts";
import { skillDirs } from "./install.ts";
import { pluginSkillFile, writePluginSkill, type SkillLangCode, type SkillExtraFile } from "./plugin-skills.ts";
import { readSkillTree, sameTree } from "./tree.ts";

/** 一份技能在某个客户端目录里的整棵内容；没有 `SKILL.md` 就不算技能。 */
interface ProjectSkillCopy {
  /** `SKILL.md` 的绝对路径。 */
  file: string;
  /** 主文件正文。 */
  text: string;
  /** 相对路径 → 字节，含主文件。 */
  tree: Map<string, Buffer>;
}

function readCopy(root: string, id: string): ProjectSkillCopy | null {
  const file = path.join(root, id, SKILL_FILE);
  if (!existsSync(file)) return null;
  try {
    const tree = readSkillTree(path.join(root, id));
    const text = readFileSync(file, "utf8");
    return { file, text, tree };
  } catch {
    return null;
  }
}

/** 主文件之外的文件，路径统一成 `/`，写进插件包时按相对路径还原。 */
function extraFilesOf(tree: Map<string, Buffer>): SkillExtraFile[] {
  return [...tree]
    .filter(([rel]) => rel.split(path.sep).join("/") !== SKILL_FILE)
    .map(([rel, data]) => ({ rel: rel.split(path.sep).join("/"), data }));
}

/**
 * 回收：项目里自己写的技能 → 插件包 `templates/skills/<lang>/<id>/`（主文件与 `references/`、`examples/` 等附件一起）。
 *
 * 与「安装」方向相反：安装是插件 → 项目，回收是项目 → 插件。回收之后这份技能
 * 就随插件走，别的项目也能装到它。
 *
 * 三条规矩，都是为了不偷偷丢掉东西：
 * - **只回收插件里没有的技能**（按 id）。同 id 的已经存在，那是「有差异」，该在技能页里看清再决定，不是这里的事。
 * - **两个客户端目录内容不同就不回收**：选哪份都是替人做决定，先让人把两份对齐。
 * - 插件包里已有同名文件且内容不同 → 冲突，除非显式 `overwrite`。
 */

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_FILE = "SKILL.md";

export interface ProjectSkill {
  id: string;
  /** 读到的来源文件（优先 `.claude/skills`）。 */
  file: string;
  description: string;
  /** 两个目录里都存在但内容不同：回收会丢一份，所以只报告不写。 */
  split: boolean;
}

/**
 * 项目里存在、但插件包里没有的技能。
 *
 * `bundledIds` 由调用方给（插件自带的技能清单）：同 id 的属于「版本不同」，
 * 归技能页的 `differs` 状态管，不在这里重复列一次。
 */
export function listProjectSkills(workspaceDir: string, bundledIds: readonly string[]): ProjectSkill[] {
  const known = new Set(bundledIds);
  const roots = skillDirs(workspaceDir).map((root) => root.dir);
  const seen = new Map<string, ProjectSkillCopy[]>();

  for (const dir of roots) {
    for (const id of readdirNames(dir)) {
      if (!SAFE_ID.test(id) || known.has(id)) continue;
      const copy = readCopy(dir, id);
      if (!copy) continue;
      const list = seen.get(id) ?? [];
      list.push(copy);
      seen.set(id, list);
    }
  }

  const skills: ProjectSkill[] = [];
  for (const [id, copies] of seen) {
    const first = copies[0];
    if (!first) continue;
    const meta = parseSkillFrontmatter(first.text);
    // 文件头不合法的不列：回收进插件包只会变成一个运行时读不到的目录。
    if (!meta || meta.name !== id) continue;
    skills.push({
      id,
      file: first.file,
      description: meta.description,
      // 附件也算「内容」：只有主文件相同、references 不同，同样是两份版本。
      split: copies.some((copy) => !sameTree(copy.tree, first.tree)),
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/** 目录不存在就当作「这里没有技能」：项目可能只用了一个客户端。 */
function readdirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export type AdoptResult =
  | {
      ok: true;
      id: string;
      written: string[];
      skipped: string[];
      conflicts: string[];
      /** 用别的语言正文填上的语言：界面上提示「待翻译」。 */
      pendingTranslation: SkillLangCode[];
    }
  | { ok: false; reason: "missing" | "invalid" | "split" | "write-failed"; detail: string };

/**
 * 把项目里的一份技能回收进插件包。
 *
 * 源文件固定取 `.claude/skills` 那份；只有它不存在时才用 `.agents/skills`。
 * 两份都在且内容不同 → `split`，不猜哪份是「新的」。
 */
export async function adoptProjectSkill(input: {
  workspaceDir: string;
  pluginDir: string;
  id: string;
  lang: SkillLangCode;
  overwrite?: boolean;
}): Promise<AdoptResult> {
  if (!SAFE_ID.test(input.id)) return { ok: false, reason: "invalid", detail: `技能 id 不合法：${input.id}` };

  const roots = skillDirs(input.workspaceDir).map((root) => root.dir);
  const copies: ProjectSkillCopy[] = [];
  for (const dir of roots) {
    const copy = readCopy(dir, input.id);
    if (copy) copies.push(copy);
  }
  if (!copies.length) {
    return { ok: false, reason: "missing", detail: `项目里找不到技能 ${input.id}` };
  }
  const first = copies[0]!;
  // 附件也算内容：只看主文件会放过「references 两份不同」的情况，回收就悄悄丢一份。
  if (copies.some((copy) => !sameTree(copy.tree, first.tree))) {
    return {
      ok: false,
      reason: "split",
      detail: `两个目录里的 ${input.id} 内容不同（${copies.map((copy) => copy.file).join("、")}），先把它们对齐再回收`,
    };
  }
  const meta = parseSkillFrontmatter(first.text);
  if (!meta || meta.name !== input.id) {
    return { ok: false, reason: "invalid", detail: `文件头的 name 必须是 ${input.id}：${first.file}` };
  }

  const result = await writePluginSkill({
    pluginDir: input.pluginDir,
    slug: input.id,
    lang: input.lang,
    sourceText: first.text,
    extraFiles: extraFilesOf(first.tree),
    overwrite: input.overwrite,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    id: input.id,
    written: result.written,
    skipped: result.skipped,
    conflicts: result.conflicts,
    pendingTranslation: result.pendingTranslation,
  };
}

/** 供测试与界面显示：回收会写进插件包的两个语言文件。 */
export function adoptTargetFiles(pluginDir: string, id: string): string[] {
  return [pluginSkillFile(pluginDir, "zh", id), pluginSkillFile(pluginDir, "en", id)];
}
