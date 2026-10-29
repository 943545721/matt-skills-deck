import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DECK_DIR } from "../shared/local-layout.ts";
import {
  buildSkillAuthorPrompt,
  buildSkillSkeleton,
  oneLine,
  slugifySkillName,
} from "../shared/skills-draft.ts";
import { parseSkillFrontmatter } from "./skills/frontmatter.ts";
import { SKILL_TARGET_ROOTS } from "./skills/install.ts";
import { writePluginSkill, type SkillLangCode } from "./skills/plugin-skills.ts";

/**
 * 「按需求生成技能」的落盘与校验。
 *
 * 草稿固定写在 `<工作区>/.deck/skills-draft/<slug>/SKILL.md`，**不**直接进
 * `.claude/skills`：那里是运行时真在加载的地方，AI 写坏了会立刻影响下一次会话。
 * 草稿区可见、可改、可丢，装不装由人按按钮决定。
 */

export const DRAFT_DIR = "skills-draft";
const SKILL_FILE = "SKILL.md";
const MAX_SKILL_BYTES = 60_000;

/** slug 只允许安全字符：它会拼进路径，`../` 之类必须在写盘前就挡掉。 */
export function safeSlug(raw: string): string | null {
  const slug = raw.trim();
  if (!slug || slug.startsWith(".") || slug.includes("/") || slug.includes("\\")) return null;
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug) ? slug : null;
}

export function draftFileOf(workspaceDir: string, slug: string): string | null {
  const safe = safeSlug(slug);
  if (!safe) return null;
  return path.join(workspaceDir, DECK_DIR, DRAFT_DIR, safe, SKILL_FILE);
}

export type DraftWriteResult =
  | { ok: true; slug: string; file: string; prompt: string; skeleton: string; overwritten: boolean }
  | {
      ok: false;
      reason: "invalid" | "write-failed";
      detail: string;
    }
  | {
      /**
       * 同名草稿已经存在，且内容不是这份骨架：不覆盖。
       *
       * 仍然带回 `file` / `prompt`——用户手里的正常动作是「让会话在**已有草稿**上继续改」，
       * 而不是把 AI 写好的一版退回去。要重来必须显式 `overwrite`。
       */
      ok: false;
      reason: "exists";
      slug: string;
      file: string;
      prompt: string;
      detail: string;
    };

export async function writeSkillDraft(input: {
  workspaceDir: string;
  requirement: string;
  name?: string;
  slug?: string;
  lang: "zh" | "en";
  /** 覆盖已有草稿正文；缺省 false（已有内容原样保留）。 */
  overwrite?: boolean;
}): Promise<DraftWriteResult> {
  const requirement = input.requirement.trim();
  if (!requirement) return { ok: false, reason: "invalid", detail: "需求不能为空" };
  if (requirement.length > MAX_SKILL_BYTES) {
    return { ok: false, reason: "invalid", detail: `需求过长（上限 ${MAX_SKILL_BYTES} 字节）` };
  }
  const requested = input.slug?.trim();
  const slug = requested ? safeSlug(requested) : slugifySkillName(input.name?.trim() || requirement);
  if (!slug) {
    return { ok: false, reason: "invalid", detail: `技能名不合法：${requested}（只允许 a-z 0-9 . _ -）` };
  }
  const file = draftFileOf(input.workspaceDir, slug);
  if (!file) return { ok: false, reason: "invalid", detail: "技能名不合法" };

  const name = oneLine(input.name?.trim() || slug, 80);
  const description = oneLine(requirement, 200);
  const skeleton = buildSkillSkeleton({ slug, name, description, requirement, lang: input.lang });
  const prompt = buildSkillAuthorPrompt({ lang: input.lang, slug, name, file, requirement });

  // 已有草稿默认不动：这个面板的产物是 AI 改过的正文，用骨架盖掉一次就白干一版。
  const existedBefore = existsSync(file);
  let existing: string | null = null;
  if (existedBefore) {
    try {
      existing = await readFile(file, "utf8");
    } catch {
      existing = null;
    }
    // 读不到内容就不敢断言「会丢东西」，交给下面的写入报错；读得到且不是这份骨架才拒。
    if (!input.overwrite && existing !== null && existing !== skeleton) {
      return {
        ok: false,
        reason: "exists",
        slug,
        file,
        prompt,
        detail: `草稿已存在且内容不同：${file}（要重新生成骨架必须显式覆盖）`,
      };
    }
  }

  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, skeleton, "utf8");
    // 原来那份内容就等于骨架时，这次写入什么都没盖掉，别报「已覆盖」。
    return { ok: true, slug, file, prompt, skeleton, overwritten: existedBefore && existing !== skeleton };
  } catch (error) {
    return { ok: false, reason: "write-failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

export type DraftValidateResult =
  | {
      ok: true;
      slug: string;
      file: string;
      meta: { name: string; description: string } | null;
      problems: string[];
      bodyLines: number;
    }
  | { ok: false; reason: "missing" | "read-failed"; detail: string };

/** 校验一份草稿：文件头、描述长度、正文是否还是空骨架。 */
export async function validateSkillDraft(workspaceDir: string, slug: string): Promise<DraftValidateResult> {
  const file = draftFileOf(workspaceDir, slug);
  if (!file) return { ok: false, reason: "missing", detail: `技能名不合法：${slug}` };
  if (!existsSync(file)) return { ok: false, reason: "missing", detail: `找不到草稿：${file}` };
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return { ok: false, reason: "read-failed", detail: error instanceof Error ? error.message : String(error) };
  }

  const problems: string[] = [];
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) problems.push(`文件超过 ${MAX_SKILL_BYTES} 字节`);
  const meta = parseSkillFrontmatter(text);
  if (!meta) {
    problems.push("文件头缺少 name 或 description（必须是开头的一段 `---` 块）");
  } else {
    if (meta.name !== slug) problems.push(`文件头 name 是 ${meta.name}，与目录名 ${slug} 不一致`);
    if (meta.description.length > 200) problems.push("description 超过 200 字，压缩成「什么时候用」一句话");
    if (meta.description.includes("\n")) problems.push("description 里有换行");
  }
  const body = text.replace(/^---[\s\S]*?---\r?\n/, "");
  const bodyLines = body.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  if (bodyLines < 4) problems.push("正文只有骨架：还没有写「何时使用 / 步骤 / 输出 / 不要做」");
  if (body.includes("> 这是骨架")) problems.push("正文里还留着骨架说明，删掉它");

  return { ok: true, slug, file, meta: meta ? { name: meta.name, description: meta.description } : null, problems, bodyLines };
}

export type DraftInstallResult =
  | {
      ok: true;
      slug: string;
      /** 装到哪儿去了：项目内（两个运行时目录）还是插件内（插件包的两个语言目录）。 */
      target: "project" | "plugin";
      written: string[];
      skipped: string[];
      conflicts: string[];
      problems: string[];
      /** 插件内安装时，用别的语言正文填上的语言；项目内安装恒为空。 */
      pendingTranslation: SkillLangCode[];
    }
  | { ok: false; reason: "missing" | "invalid" | "write-failed"; detail: string };

/**
 * 把草稿装出去：项目内（两个运行时目录）或插件内（插件包的两个语言目录）。
 *
 * 校验不过就不装：装一个头部缺字段的技能，运行时只会静默不加载，用户更难发现问题。
 * 已存在且内容不同的文件默认算冲突（与内置技能安装同一条规矩），要覆盖必须显式传 overwrite。
 *
 * `target` 缺省 `project`：装进插件包等于改插件源码，必须是显式选择。
 */
export async function installSkillDraft(
  workspaceDir: string,
  slug: string,
  overwrite = false,
  options: { target?: "project" | "plugin"; lang?: SkillLangCode; pluginDir?: string } = {},
): Promise<DraftInstallResult> {
  const check = await validateSkillDraft(workspaceDir, slug);
  if (!check.ok) return { ok: false, reason: check.reason === "missing" ? "missing" : "write-failed", detail: check.detail };
  if (check.problems.length) {
    return { ok: false, reason: "invalid", detail: `草稿没通过校验：${check.problems.join("；")}` };
  }
  const source = check.file;
  let sourceText: string;
  try {
    sourceText = await readFile(source, "utf8");
  } catch (error) {
    return { ok: false, reason: "write-failed", detail: error instanceof Error ? error.message : String(error) };
  }

  const target = options.target ?? "project";
  if (target === "plugin") {
    if (!options.lang || !options.pluginDir) {
      return { ok: false, reason: "invalid", detail: "写进插件内需要语言与插件目录" };
    }
    const result = await writePluginSkill({
      pluginDir: options.pluginDir,
      slug,
      lang: options.lang,
      sourceText,
      overwrite,
    });
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
    return {
      ok: true,
      slug,
      target,
      written: result.written,
      skipped: result.skipped,
      conflicts: result.conflicts,
      problems: [],
      pendingTranslation: result.pendingTranslation,
    };
  }

  const written: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  for (const root of SKILL_TARGET_ROOTS) {
    const target = path.join(workspaceDir, root, slug, SKILL_FILE);
    if (existsSync(target)) {
      let existing: string | null = null;
      try {
        existing = await readFile(target, "utf8");
      } catch {
        existing = null;
      }
      if (existing === sourceText) {
        skipped.push(target);
        continue;
      }
      if (!overwrite) {
        conflicts.push(target);
        continue;
      }
    }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      written.push(target);
    } catch (error) {
      return { ok: false, reason: "write-failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true, slug, target, written, skipped, conflicts, problems: [], pendingTranslation: [] };
}
