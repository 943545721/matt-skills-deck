import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSkillAuthorPrompt,
  buildSkillSkeleton,
  oneLine,
  slugifySkillName,
} from "../shared/skills-draft.ts";
import { draftFileOf, installSkillDraft, safeSlug, validateSkillDraft, writeSkillDraft } from "../server/skills-draft.ts";
import { parseSkillFrontmatter } from "../server/skills/frontmatter.ts";
import { readChildHandoff, writeChildHandoff } from "../server/handoff-store.ts";

/**
 * 「按需求生成技能」与子会话回传件。
 *
 * 两条护栏：草稿不能写到 `.deck/skills-draft` 之外（slug 会拼进路径），
 * 校验不过的草稿不能装进运行时目录——装上去只会静默不加载。
 */

const workspace = () => mkdtemp(path.join(tmpdir(), "deck-draft-"));

test("slug：只留安全字符，路径穿越挡在写盘之前", () => {
  assert.equal(slugifySkillName("Fix Broken Links!"), "fix-broken-links");
  assert.equal(slugifySkillName("   ").startsWith("skill-"), true);
  assert.equal(safeSlug("fix-links"), "fix-links");
  assert.equal(safeSlug("../etc/passwd"), null);
  assert.equal(safeSlug(".hidden"), null);
  assert.equal(safeSlug("bad name"), null);
  assert.equal(draftFileOf("/tmp/x", "../evil"), null);
});

test("描述压成一行：文件头里不能有换行", () => {
  const flat = oneLine("第一行\n第二行   第三行");
  assert.equal(flat.includes("\n"), false);
  assert.match(flat, /第一行 第二行 第三行/);
  assert.equal(oneLine("x".repeat(300)).length, 200);
});

test("骨架：文件头合法，正文里留着需求原文", () => {
  const text = buildSkillSkeleton({
    slug: "fix-links",
    name: "fix-links",
    description: "修复坏链接",
    requirement: "把所有文档里的坏链接修好",
    lang: "zh",
  });
  const meta = parseSkillFrontmatter(text);
  assert.deepEqual(meta, { name: "fix-links", description: "修复坏链接" });
  assert.match(text, /把所有文档里的坏链接修好/);
  assert.match(text, /这是骨架/);
});

test("生成提示词：说清文件路径、硬性要求与回话方式", () => {
  const prompt = buildSkillAuthorPrompt({
    lang: "zh",
    slug: "fix-links",
    name: "fix-links",
    file: "/w/.deck/skills-draft/fix-links/SKILL.md",
    requirement: "修坏链接",
  });
  assert.match(prompt, /\.deck\/skills-draft\/fix-links\/SKILL\.md/);
  assert.match(prompt, /name/);
  assert.match(prompt, /description/);
  assert.match(prompt, /修坏链接/);
});

test("草稿落盘 → 校验挑出没改的骨架 → 改写后通过 → 装进两个技能目录", async () => {
  const dir = await workspace();
  const created = await writeSkillDraft({ workspaceDir: dir, requirement: "给文档修坏链接", lang: "zh" });
  assert.equal(created.ok, true);
  assert.equal(existsSync(created.file), true);

  const before = await validateSkillDraft(dir, created.slug);
  assert.equal(before.ok, true);
  assert.equal(before.meta?.name, created.slug);
  assert.ok(before.problems.length > 0, "没改过的骨架不应通过校验");

  // AI 改写后的成品
  const written = [
    "---",
    `name: ${created.slug}`,
    "description: 批量检查并修好文档里的坏链接",
    "---",
    "",
    "# 修坏链接",
    "",
    "## 何时使用",
    "文档里出现 404 链接时。",
    "",
    "## 步骤",
    "1. 扫描 md 文件里的链接。",
    "2. 逐个 HEAD 请求确认状态。",
    "3. 修好后重跑一遍。",
    "",
    "## 输出",
    "一份改动列表。",
    "",
    "## 不要做",
    "- 不要改无关文件。",
    "",
  ].join("\n");
  await writeFile(created.file, written, "utf8");

  const after = await validateSkillDraft(dir, created.slug);
  assert.deepEqual(after.problems, []);

  const installed = await installSkillDraft(dir, created.slug);
  assert.equal(installed.ok, true);
  assert.equal(installed.written.length, 2);
  for (const target of installed.written) {
    assert.equal((await readFile(target, "utf8")), written);
  }

  // 再装一次：内容一致算「已是最新」，不是冲突
  const again = await installSkillDraft(dir, created.slug);
  assert.equal(again.ok, true);
  assert.equal(again.skipped.length, 2);
  assert.equal(again.conflicts.length, 0);
});

test("草稿：同名不同内容默认算冲突，不静默覆盖", async () => {
  const dir = await workspace();
  const created = await writeSkillDraft({ workspaceDir: dir, requirement: "整理会议纪要", slug: "meeting-notes", lang: "en" });
  assert.equal(created.ok, true);
  const good = [
    "---",
    "name: meeting-notes",
    "description: Turn a raw transcript into decisions and owners",
    "---",
    "",
    "## When to use",
    "After a meeting.",
    "",
    "## Steps",
    "1. Read the transcript.",
    "2. List decisions and owners.",
    "",
  ].join("\n");
  await writeFile(created.file, good, "utf8");

  const existing = path.join(dir, ".claude", "skills", "meeting-notes", "SKILL.md");
  await mkdir(path.dirname(existing), { recursive: true });
  await writeFile(existing, "---\nname: meeting-notes\ndescription: mine\n---\n\n手写的版本\n", "utf8");

  const blocked = await installSkillDraft(dir, created.slug);
  assert.equal(blocked.ok, true);
  assert.deepEqual(blocked.conflicts, [existing]);
  assert.equal((await readFile(existing, "utf8")).includes("手写的版本"), true);

  const forced = await installSkillDraft(dir, created.slug, true);
  assert.equal(forced.ok, true);
  assert.equal(forced.written.includes(existing), true);
  assert.deepEqual(forced.conflicts, []);
});

test("草稿：校验不过就不装", async () => {
  const dir = await workspace();
  const created = await writeSkillDraft({ workspaceDir: dir, requirement: "x", slug: "half-done", lang: "en" });
  assert.equal(created.ok, true);
  const broken = "---\ndescription: 没有 name\n---\n\n正文\n";
  await writeFile(created.file, broken, "utf8");
  const result = await installSkillDraft(dir, created.slug);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(existsSync(path.join(dir, ".claude", "skills", "half-done", "SKILL.md")), false);
});

test("回传件：写在 handoffs/<agentId>.json，丢了就是 null，不抛异常", async () => {
  const dir = await workspace();
  const written = await writeChildHandoff(dir, {
    agentId: "agent-abc",
    status: "blocked",
    summary: "卡在权限上",
    done: ["读完代码"],
    blocking: ["需要用户确认删除操作"],
    ticketKey: "42",
    difficulty: "hard",
  });
  assert.equal(written.ok, true);
  assert.match(written.markdown, /卡在权限上/);
  assert.match(written.markdown, /需要用户确认删除操作/);

  const record = await readChildHandoff(dir, "agent-abc");
  assert.equal(record?.status, "blocked");
  assert.deepEqual(record?.done, ["读完代码"]);
  assert.equal(record?.ticketKey, "42");

  assert.equal(await readChildHandoff(dir, "never-written"), null);
  // 路径穿越的 agent id 不会被当成文件路径
  assert.equal(await readChildHandoff(dir, "../../etc/passwd"), null);
  const bad = await writeChildHandoff(dir, { agentId: "..", status: "completed", summary: "x" });
  assert.equal(bad.ok, false);
});

test("已有草稿默认不覆盖：同名再来一次只带回路径和提示词，正文一个字不动", async () => {
  const dir = await workspace();
  const first = await writeSkillDraft({ workspaceDir: dir, requirement: "整理会议纪要", slug: "meeting-notes", lang: "zh" });
  assert.equal(first.ok, true);
  // 模拟 AI 已经把这版写好了
  await writeFile(first.file, "---\nname: meeting-notes\ndescription: 把会议记录整理成结论\n---\n\n正文\n", "utf8");

  const again = await writeSkillDraft({ workspaceDir: dir, requirement: "整理会议纪要", slug: "meeting-notes", lang: "zh" });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "exists");
  assert.equal(again.file, first.file, "还是那个文件");
  assert.match(again.prompt, /meeting-notes/, "提示词照样给：正常做法是在已有草稿上继续改");
  assert.match(await readFile(first.file, "utf8"), /把会议记录整理成结论/, "AI 写好的正文不能被骨架盖掉");
});

test("显式 overwrite 才把草稿重置成骨架，并在返回值里说明覆盖过", async () => {
  const dir = await workspace();
  const first = await writeSkillDraft({ workspaceDir: dir, requirement: "整理会议纪要", slug: "meeting-notes", lang: "zh" });
  await writeFile(first.file, "---\nname: meeting-notes\ndescription: 旧版\n---\n\n旧正文\n", "utf8");

  const reset = await writeSkillDraft({
    workspaceDir: dir,
    requirement: "整理会议纪要",
    slug: "meeting-notes",
    lang: "zh",
    overwrite: true,
  });
  assert.equal(reset.ok, true);
  assert.equal(reset.overwritten, true);
  assert.match(await readFile(first.file, "utf8"), /这是骨架/);
});

test("草稿内容本来就等于骨架时，再写一次不报「覆盖过」", async () => {
  const dir = await workspace();
  const first = await writeSkillDraft({ workspaceDir: dir, requirement: "整理会议纪要", slug: "meeting-notes", lang: "zh" });
  assert.equal(first.ok, true);
  assert.equal(first.overwritten, false, "第一次写不算覆盖");

  const again = await writeSkillDraft({
    workspaceDir: dir,
    requirement: "整理会议纪要",
    slug: "meeting-notes",
    lang: "zh",
    overwrite: true,
  });
  assert.equal(again.ok, true);
  assert.equal(again.overwritten, false, "内容一样，什么都没盖掉");
});
