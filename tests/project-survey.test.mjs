import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listBundledSkills } from "../server/skills/catalog.ts";
import { PROJECT_OWNERS } from "../shared/workspace-projects.ts";

/**
 * 项目梳理技能的内容口径。
 *
 * 这个技能的价值全在「读什么、说什么、不许做什么」这几句上，所以这里按条钉住：
 * 读的结构清单、依据必填、重跑只报差异、五个角色、以及「不自动写配置」。
 * 少一条它就会变成一张靠猜的固定清单，正是它要避免的东西。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const text = (lang) => readFileSync(path.join(ROOT, "templates", "skills", lang, "project-survey", "SKILL.md"), "utf8");

test("中英两份都在，目录名与 frontmatter 一致（不然不会出现在技能清单里）", () => {
  for (const lang of ["zh", "en"]) {
    const found = listBundledSkills(ROOT, lang).find((skill) => skill.id === "project-survey");
    assert.ok(found, `${lang} 侧缺少 project-survey`);
    assert.equal(found.name, "project-survey");
    assert.ok(found.description.length > 0 && found.description.length <= 200);
  }
});

test("读的结构清单覆盖各语言生态与部署、CI", () => {
  for (const file of ["package.json", "composer.json", "pnpm-workspace.yaml", "Dockerfile", ".github/workflows", "project.config.json", "pom.xml", "go.mod"]) {
    assert.ok(text("zh").includes(file), `中文版没提 ${file}`);
    assert.ok(text("en").includes(file), `英文版没提 ${file}`);
  }
});

test("每条候选必须带依据，读不出来写未确认", () => {
  assert.match(text("zh"), /路径:行号|依据/);
  assert.match(text("zh"), /未确认/);
  assert.match(text("en"), /evidence: <path>|path:line/);
  assert.match(text("en"), /unconfirmed/);
});

test("重跑只报差异，且旧项不删", () => {
  assert.match(text("zh"), /可能已废弃/);
  assert.match(text("zh"), /\.deck\/survey\//);
  assert.match(text("en"), /possibly deprecated/);
  assert.match(text("en"), /\.deck\/survey\//);
});

test("五个角色都在，和配置里的 owner 取值对齐", () => {
  for (const role of PROJECT_OWNERS) {
    assert.ok(text("zh").includes(`\`${role}\``), `中文版缺角色 ${role}`);
    assert.ok(text("en").includes(`\`${role}\``), `英文版缺角色 ${role}`);
  }
});

test("明确不自动写配置、不建标签、不删已有项", () => {
  assert.match(text("zh"), /不写 `\.paseo-deck\.json`/);
  assert.match(text("zh"), /不建标签/);
  assert.match(text("en"), /Does not write `\.paseo-deck\.json`/);
  assert.match(text("en"), /does not create labels/);
});
