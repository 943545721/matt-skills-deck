import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 「按需求生成技能」的契约与纯函数。
 *
 * 插件自己没有模型，所以不假装能直接产出最终技能：
 * 它做的是**可验的那一半**——把需求变成一份带正确文件头的骨架、算出安全的 slug、
 * 写出一段给会话用的生成提示词，然后校验 AI 改回来的文件、再按用户点头安装。
 * 每一步都能单独看见，AI 写歪了也不会自动装进 `.claude/skills`。
 */

const langSchema = z.enum(["en", "zh"]);
const workspaceDirSchema = z.string().min(1).max(4096);
const slugSchema = z.string().min(1).max(64);

export const skillsDraftRpc = defineRpc({
  name: "deck.skills.draft",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    /** 用户原话，原样收下：它是写给会话看的，不是给我们解析的。 */
    requirement: z.string().min(1).max(20_000),
    name: z.string().max(120).optional(),
    slug: slugSchema.optional(),
    lang: langSchema,
    /** 覆盖同名草稿的正文；缺省 false（已有内容不动，返回 `exists`）。 */
    overwrite: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      slug: z.string(),
      file: z.string(),
      /** 交给会话的生成提示词（已包含文件路径与校验要求）。 */
      prompt: z.string(),
      skeleton: z.string(),
      /** 这次写入是否盖掉了原有正文。 */
      overwritten: z.boolean(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "write-failed"]),
      detail: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.literal("exists"),
      /** 已有草稿仍带回路径与提示词：正常做法是在它上面继续改，而不是覆盖回骨架。 */
      slug: z.string(),
      file: z.string(),
      prompt: z.string(),
      detail: z.string(),
    }),
  ]),
});

export const skillsDraftValidateRpc = defineRpc({
  name: "deck.skills.draft.validate",
  input: z.object({ workspaceDir: workspaceDirSchema, slug: slugSchema }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      slug: z.string(),
      file: z.string(),
      meta: z.object({ name: z.string(), description: z.string() }).nullable(),
      problems: z.array(z.string()),
      /** 去掉文件头后的正文行数；0 行也算问题。 */
      bodyLines: z.number(),
    }),
    z.object({ ok: z.literal(false), reason: z.enum(["missing", "read-failed"]), detail: z.string() }),
  ]),
});

export const skillsDraftInstallRpc = defineRpc({
  name: "deck.skills.draft.install",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    slug: slugSchema,
    /** 覆盖已存在的同名技能；缺省 false（冲突只报告，不写）。 */
    overwrite: z.boolean().optional(),
    /** 装到哪儿：项目内（两个运行时目录）或插件内（插件包的两个语言目录）。缺省 project。 */
    target: z.enum(["project", "plugin"]).optional(),
    lang: langSchema,
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      slug: z.string(),
      target: z.enum(["project", "plugin"]),
      written: z.array(z.string()),
      skipped: z.array(z.string()),
      conflicts: z.array(z.string()),
      problems: z.array(z.string()),
      /** 插件内安装时，用别的语言正文填上的语言：界面上要提示「待翻译」。 */
      pendingTranslation: z.array(langSchema),
    }),
    z.object({ ok: z.literal(false), reason: z.enum(["missing", "invalid", "write-failed"]), detail: z.string() }),
  ]),
});

/* ------------------------------------------------------------------ 纯函数 */

/** 目录名只留 `a-z0-9-`：技能名会拼进文件路径，别的字符一律归一掉。 */
export function slugifySkillName(raw: string): string {
  const ascii = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return ascii || `skill-${Date.now().toString(36)}`;
}

/** 描述压成一行：文件头里不能换行，换了整块 frontmatter 就废了。 */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface SkeletonInput {
  slug: string;
  name: string;
  description: string;
  requirement: string;
  lang: "en" | "zh";
}

/**
 * 初始骨架。
 *
 * 故意写得很薄：它只是让 AI 有一个**合法的文件头**可以直接改，
 * 不是替它想好一切。正文里点明「按需求重写」，避免模型把脚手架当成成品。
 */
export function buildSkillSkeleton(input: SkeletonInput): string {
  const zh = input.lang === "zh";
  const requirement = input.requirement.trim();
  const head = [
    "---",
    `name: ${input.slug}`,
    `description: ${oneLine(input.description)}`,
    "---",
    "",
  ];
  const body = zh
    ? [
        `# ${input.name}`,
        "",
        "> 这是骨架。按下面的需求把正文重写成本技能真正要做的事，不要保留这段说明。",
        "",
        "## 何时使用",
        "",
        "（写清触发条件：什么请求该走这个技能。）",
        "",
        "## 步骤",
        "",
        "1. （先做什么）",
        "2. （再做什么）",
        "3. （怎么验证做对了）",
        "",
        "## 输出",
        "",
        "（交付什么：文件、报告、命令结果。）",
        "",
        "## 不要做",
        "",
        "- 不要改动与需求无关的文件。",
        "- 不要把没验证过的结论写成已完成。",
        "",
        "## 原始需求",
        "",
        requirement,
        "",
      ]
    : [
        `# ${input.name}`,
        "",
        "> This is a skeleton. Rewrite the body for what this skill actually has to do and drop this note.",
        "",
        "## When to use",
        "",
        "(State the trigger: which requests belong to this skill.)",
        "",
        "## Steps",
        "",
        "1. (First…)",
        "2. (Then…)",
        "3. (How to verify it worked.)",
        "",
        "## Output",
        "",
        "(What it delivers: files, a report, command output.)",
        "",
        "## Do not",
        "",
        "- Do not touch files unrelated to the requirement.",
        "- Do not present unverified work as done.",
        "",
        "## Original requirement",
        "",
        requirement,
        "",
      ];
  return [...head, ...body].join("\n");
}

/** 给会话用的生成提示词：说清文件在哪、必须保留什么、写完怎么自检。 */
export function buildSkillAuthorPrompt(input: {
  lang: "en" | "zh";
  slug: string;
  name: string;
  file: string;
  requirement: string;
}): string {
  const zh = input.lang === "zh";
  if (zh) {
    return [
      `请按下面的需求写一个技能，直接改写这份文件：`,
      "",
      `文件：\`${input.file}\``,
      `技能名（目录）：\`${input.slug}\``,
      "",
      "硬性要求：",
      "1. 头部 `---` 块必须保留 `name` 与 `description` 两个字段，`name` 保持上面这个值；",
      "2. `description` 一行说完「什么时候用」，不超过 200 字，不要换行；",
      "3. 正文写「何时使用 / 步骤 / 输出 / 不要做」四节，步骤要能照着做，不要写空话；",
      "4. 不要引用不存在的工具或路径；需要用户确认的动作要写明。",
      "",
      "需求原文：",
      "",
      input.requirement.trim(),
      "",
      "写完后回来告诉我你改了什么；我会在面板里校验并安装。",
    ].join("\n");
  }
  return [
    "Write a skill for the requirement below by rewriting this file in place:",
    "",
    `File: \`${input.file}\``,
    `Skill name (directory): \`${input.slug}\``,
    "",
    "Hard requirements:",
    "1. Keep the `---` frontmatter block with both `name` and `description`; `name` stays as given;",
    "2. `description` is one line saying when to use it, at most 200 characters, no line breaks;",
    "3. Body has When to use / Steps / Output / Do not, and the steps must be followable;",
    "4. Do not reference tools or paths that do not exist; say so where a human must confirm.",
    "",
    "Requirement:",
    "",
    input.requirement.trim(),
    "",
    "When done, tell me what you changed; I will validate and install it from the panel.",
  ].join("\n");
}
