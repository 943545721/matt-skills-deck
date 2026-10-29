import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkGuidePromptOf,
  ensureLabelsPromptOf,
  installSkillsPromptOf,
  setupPromptOf,
} from "../client/deck/panel/checksPrompts.ts";
import { STANDARD_LABELS } from "../shared/labels.ts";

/**
 * 检查页注入文本的拼裝：占位符必须被真实值填满，DSH 原文的标志句不许在搬运中走样。
 * 这里只测纯函数，不碰会话与 RPC。
 */

const SKILLS = ["wayfinder", "setup-matt-pocock-skills", "ask-matt"];

test("setupRun：v15 模板按后端与布局填占位符", () => {
  const zh = setupPromptOf("github", "multi", "zh");
  assert.ok(zh.startsWith("/setup-matt-pocock-skills"));
  assert.match(zh, /本仓库为 GitHub → 提议 GitHub Issues/);
  assert.match(zh, /multi-context/);
  assert.match(zh, /GLOSSARY-MAP\.md/);
  assert.match(zh, /本次已选后端：GitHub。/);
  assert.ok(!zh.includes("{trackerLine}"), "占位符必须全部被填掉");
  assert.ok(!zh.includes("{contextLayout}"));

  const en = setupPromptOf("gitlab", "single", "en");
  assert.match(en, /this repo is on GitLab → propose GitLab Issues/);
  assert.match(en, /single-context/);
  assert.match(en, /Selected backend: GitLab/);

  // markdown 后端：labelReqs 为空串，tracker 行换本地措辞
  const md = setupPromptOf("markdown", "single", "zh");
  assert.match(md, /本仓库为本地文件 → 提议 Local markdown/);
  assert.match(md, /issue-tracker-local\.md/);

  // 未选后端：走 default 键组，明说按默认 GitHub
  const def = setupPromptOf(null, "single", "zh");
  assert.match(def, /已按默认 GitHub 初始化/);
});

test("installSkills：v6 五步结构与探针清单", () => {
  const zh = installSkillsPromptOf(SKILLS, "zh");
  assert.match(zh, /这 3 个技能已全部就位：wayfinder \/ setup-matt-pocock-skills \/ ask-matt/);
  assert.match(zh, /mattpocock\/skills/);
  assert.match(zh, /\.claude\/skills 与 \.agents\/skills/);
  assert.match(zh, /不要装进用户级目录/);
  assert.ok(!zh.includes("{probeList}"));
  assert.ok(!zh.includes("{probeCount}"));

  const en = installSkillsPromptOf(SKILLS, "en");
  assert.match(en, /these 3 skills are all present/);
  assert.match(en, /Install skills/);
});

test("ensureLabels：名单从 STANDARD_LABELS 现拼", () => {
  const zh = ensureLabelsPromptOf("zh");
  assert.match(zh, new RegExp(`共 ${STANDARD_LABELS.length} 个`));
  for (const label of STANDARD_LABELS) {
    assert.ok(zh.includes(label.name), `缺标签 ${label.name}`);
  }
  assert.match(zh, /STANDARD_LABELS 为唯一清单/);
  const en = ensureLabelsPromptOf("en");
  assert.match(en, new RegExp(`${STANDARD_LABELS.length} total`));
});

test("一句话指引：cliInstall / ghAuthLogin / glabAuthLogin", () => {
  assert.match(checkGuidePromptOf("cliInstall", "zh"), /cli\.github\.com/);
  assert.match(checkGuidePromptOf("ghAuthLogin", "en"), /gh auth login/);
  assert.match(checkGuidePromptOf("glabAuthLogin", "zh"), /glab auth login/);
  assert.match(checkGuidePromptOf("glabAuthLogin", "en"), /glab auth status/);
});
