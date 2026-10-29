import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 「插件内」技能：写进插件包的 `templates/skills/<lang>/<slug>/`。
 *
 * 与项目内技能的区别只有归属：插件内那份随插件走，任何工作区都能安装它；
 * 项目内那份只服务当前项目。两边内容可以互相同步（安装 = 插件 → 项目，回收 = 项目 → 插件）。
 *
 * 三件事刻意保守：
 * - 主文件固定叫 `SKILL.md`；同目录的附属文件（`references/`、`examples/`）按 `extraFiles` 一起写，
 *   否则回收/新增一个多文件技能时，正文里的相对链接会在插件包里指空；
 * - 已有同名文件且内容不同就是冲突，除非显式 `overwrite`——插件包是源码，覆盖等于改别人的代码；
 * - 冲突按文件报，不按技能报：界面要能指出到底是主文件还是哪个附件对不上。
 */

export type SkillLangCode = "en" | "zh";

export const PLUGIN_LANGS: readonly SkillLangCode[] = ["zh", "en"];

/** 技能 id 会拼进路径，只认安全形状。 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function pluginSkillFile(pluginDir: string, lang: SkillLangCode, slug: string): string {
  if (!SAFE_ID.test(slug)) throw new Error(`技能 id 不合法：${slug}`);
  return path.join(pluginDir, "templates", "skills", lang, slug, "SKILL.md");
}

/** 主文件之外的附属文件：`rel` 是技能目录内的相对路径。 */
export interface SkillExtraFile {
  rel: string;
  data: Buffer;
}

/** 相对路径必须落在技能目录内：绝对路径、`..`、空段一律拒绝，不拼出目录外的路径。 */
function safeRelative(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]+/);
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export interface PluginWriteOutcome {
  ok: true;
  written: string[];
  skipped: string[];
  /** 内容不同、没有覆盖的路径。 */
  conflicts: string[];
  /** 用别的语言的正文填上的语言：界面上要提示「待翻译」，不能假装两边都有译文。 */
  pendingTranslation: SkillLangCode[];
}

export type PluginWriteResult = PluginWriteOutcome | { ok: false; reason: "invalid" | "write-failed"; detail: string };

/**
 * 把一份正文（外加可选附属文件）写进插件包的两个语言目录。
 *
 * 两个语言都写、内容相同——插件的外壳只认「同一技能在 zh/en 两侧都存在」，
 * 少一侧会在技能页里只出现一次，用户以为坏了。但用哪国语言写的是另一回事，
 * 所以 `pendingTranslation` 要把「这份其实还没翻」如实报出来。
 */
export async function writePluginSkill(input: {
  pluginDir: string;
  slug: string;
  lang: SkillLangCode;
  sourceText: string;
  /** 主文件之外的附属文件；不传就是单文件技能。 */
  extraFiles?: readonly SkillExtraFile[];
  overwrite?: boolean;
}): Promise<PluginWriteResult> {
  if (!SAFE_ID.test(input.slug)) return { ok: false, reason: "invalid", detail: `技能 id 不合法：${input.slug}` };

  const extras = input.extraFiles ?? [];
  const bad = extras.find((file) => !safeRelative(file.rel) || file.rel.replace(/\\/g, "/") === "SKILL.md");
  if (bad) {
    return { ok: false, reason: "invalid", detail: `附属文件路径不合法：${bad.rel || "(空)"}` };
  }

  const written: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const pendingTranslation: SkillLangCode[] = [];

  for (const lang of PLUGIN_LANGS) {
    const main = pluginSkillFile(input.pluginDir, lang, input.slug);
    const base = path.dirname(main);
    const files: Array<{ target: string; data: string | Buffer }> = [
      { target: main, data: input.sourceText },
      ...extras.map((file) => ({ target: path.join(base, file.rel), data: file.data })),
    ];
    let wroteHere = 0;
    for (const file of files) {
      if (existsSync(file.target)) {
        let existing: Buffer | null = null;
        try {
          existing = await readFile(file.target);
        } catch {
          existing = null;
        }
        const same = existing !== null
          && existing.equals(typeof file.data === "string" ? Buffer.from(file.data, "utf8") : file.data);
        if (same) {
          skipped.push(file.target);
          continue;
        }
        if (!input.overwrite) {
          conflicts.push(file.target);
          continue;
        }
      }
      try {
        await mkdir(path.dirname(file.target), { recursive: true });
        await writeFile(file.target, file.data);
      } catch (error) {
        return { ok: false, reason: "write-failed", detail: `${file.target}：${error instanceof Error ? error.message : String(error)}` };
      }
      written.push(file.target);
      wroteHere += 1;
    }
    if (wroteHere > 0 && lang !== input.lang) pendingTranslation.push(lang);
  }

  return { ok: true, written, skipped, conflicts, pendingTranslation };
}
