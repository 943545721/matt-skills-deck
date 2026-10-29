import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNewBugPrompt,
  buildNewSpecPrompt,
  buildNewWayfinderPrompt,
} from "../shared/entry-prompt.ts";
import { MCP_TOOLS } from "../server/mcp/tools.ts";

/**
 * 需求入口提示词的文本契约（对应 DSH 新建入口的三个动作，逐字照抄）。
 *
 * - 新建需求走 /wayfinder，实施讨论走 /grill-with-docs，BUG 也走 /wayfinder；
 * - {repo} 必须换成调用方给的真实仓库，不能把占位符交给用户；
 * - 需求类提示词末尾接 prompt.requirementPrefix（zh 需求描述 / en Requirement ），
 *   BUG 末尾是四项必填字段（源码 router.ts 拼的是 newBugFields 片段）；
 * - 工具节照抄 DSH 的三行：deck_issue_report 与 suggest_next_steps 在本仓都已注册，
 *   是真实调用，不是空口文案。
 */

const REPO = "acme/deck";
const LANGUAGES = ["zh", "en"];
const REGISTERED = new Set(MCP_TOOLS.map((tool) => tool.name));

const ENTRIES = [
  ["newWayfinder", buildNewWayfinderPrompt],
  ["newSpec", buildNewSpecPrompt],
  ["newBug", buildNewBugPrompt],
];

const firstLine = (text) => text.split("\n", 1)[0];

const assertEndsWithRequirementPrefix = (text, lang, label) => {
  const prefix = lang === "zh" ? "需求描述：" : "Requirement: ";
  assert.match(text, new RegExp(`\\n\\n${prefix}\\s*$`), `${label}：末尾应是 prompt.requirementPrefix`);
};

test("三个入口都写入真实仓库，不残留 {repo} 占位符", () => {
  for (const [label, build] of ENTRIES) {
    for (const lang of LANGUAGES) {
      const text = build({ lang, repo: REPO });
      assert.equal(typeof text, "string", `${label}/${lang}：必须返回文本`);
      assert.ok(text.length > 0, `${label}/${lang}：不能是空提示词`);
      assert.ok(text.includes(REPO), `${label}/${lang}：必须写进调用方给的仓库`);
      assert.ok(!text.includes("{repo}"), `${label}/${lang}：占位符必须全部替换`);
    }
  }
});

test("探索入口：/wayfinder 开头，开场白与仓库行按源码", () => {
  const zh = buildNewWayfinderPrompt({ lang: "zh", repo: REPO });
  assert.equal(firstLine(zh), "/wayfinder");
  assert.ok(zh.includes("请帮我处理一个需求（严格遵循 wayfinder 技能规则）。"));
  assert.ok(zh.includes(`仓库（已自动填入当前工作区）：${REPO}`));
  assert.ok(zh.includes("## 调查（建议先查后问）"));
  assert.ok(zh.includes("建议先阅读仓内相关内容（文档、代码、相关 issue）后再提问。"));
  assert.ok(zh.includes("## 收尾"));
  assertEndsWithRequirementPrefix(zh, "zh", "newWayfinder/zh");

  const en2 = buildNewWayfinderPrompt({ lang: "en", repo: REPO });
  assert.equal(firstLine(en2), "/wayfinder");
  assert.ok(en2.includes("Please handle a requirement (strictly follow the wayfinder skill rules)."));
  assert.ok(en2.includes(`Repo (auto-filled from the current workspace): ${REPO}`));
  assert.ok(en2.includes("## Investigate (recommended: look before asking)"));
  assert.ok(en2.includes("It is recommended to read related material in the repo (docs, code, related issues) before asking."));
  assertEndsWithRequirementPrefix(en2, "en", "newWayfinder/en");
});

test("实施入口：/grill-with-docs 开头，收尾提醒用户手动拆票", () => {
  const zh = buildNewSpecPrompt({ lang: "zh", repo: REPO });
  assert.equal(firstLine(zh), "/grill-with-docs");
  assert.ok(zh.includes("请帮我讨论一个需求（严格遵循 grill-with-docs 技能规则）。"));
  assert.ok(zh.includes(`仓库（已自动填入当前工作区）：${REPO}`));
  assert.ok(zh.includes("## 讨论收尾（下面这些动作由用户手动执行，不要替用户做）"));
  assert.ok(zh.includes("/to-spec"));
  assert.ok(zh.includes("/to-tickets"));
  assertEndsWithRequirementPrefix(zh, "zh", "newSpec/zh");

  const en = buildNewSpecPrompt({ lang: "en", repo: REPO });
  assert.equal(firstLine(en), "/grill-with-docs");
  assert.ok(en.includes("Help me discuss a requirement (strictly follow the grill-with-docs skill rules)."));
  assert.ok(en.includes(`Repo (auto-filled from the current workspace): ${REPO}`));
  assert.ok(
    en.includes("## Discussion wrap-up (the user runs the actions below manually; do not run them on their behalf)"),
  );
  assert.ok(en.includes("/to-spec"));
  assert.ok(en.includes("/to-tickets"));
  assertEndsWithRequirementPrefix(en, "en", "newSpec/en");
});

test("BUG 入口：也走 /wayfinder，带 bug / needs-triage 与查重", () => {
  const zh = buildNewBugPrompt({ lang: "zh", repo: REPO });
  assert.equal(firstLine(zh), "/wayfinder");
  assert.ok(zh.includes("请帮我新增一个 BUG 单（按 wayfinder 技能规则处理）。"));
  assert.ok(zh.includes(`仓库：${REPO}`));
  assert.ok(zh.includes("bug 标签"));
  assert.ok(zh.includes("needs-triage"));
  assert.ok(zh.includes("## 澄清"));
  assert.ok(zh.includes("建议先阅读本票正文、评论及仓内相关内容后再提问。"));
  assert.ok(zh.includes("## 查重"));
  assert.ok(zh.includes("## 查重记录"));
  assert.ok(zh.includes("## 自查"));
  assert.ok(!/\n\n需求描述\s*$/.test(zh), "BUG 末尾是四项必填字段，不接需求描述前缀");

  const en = buildNewBugPrompt({ lang: "en", repo: REPO });
  assert.equal(firstLine(en), "/wayfinder");
  assert.ok(en.includes("Please help me file a new BUG ticket (follow the wayfinder skill rules)."));
  assert.ok(en.includes(`Repo: ${REPO}`));
  assert.ok(en.includes("bug label"));
  assert.ok(en.includes("needs-triage"));
  assert.ok(en.includes("## Clarify"));
  assert.ok(en.includes("## Investigate first (recommended: look before asking)"));
  assert.ok(en.includes("It is recommended to read this ticket body, its comments, and related in-repo material before asking."));
  assert.ok(en.includes("## Check for duplicates"));
  assert.ok(en.includes("## Duplicate check record"));
  assert.ok(en.includes("## Self-check"));
  assert.ok(!/\n\nRequirement description\s*$/.test(en), "BUG 末尾是四项必填字段，不接需求描述前缀");
});

test("BUG 入口末尾是源码的四项必填字段（中英按源码）", () => {
  const zh = buildNewBugPrompt({ lang: "zh", repo: REPO });
  assert.ok(zh.trimEnd().endsWith("环境信息（OS 版本 + 软件版本 + 运行环境）："));
  assert.ok(zh.includes("实际（现象；影响范围）："));
  assert.ok(zh.includes("期望（预期；与实际差异）："));
  assert.ok(zh.includes("复现步骤（前置条件和场景 + 编号步骤；偶发写频率）："));

  const en = buildNewBugPrompt({ lang: "en", repo: REPO });
  assert.ok(en.trimEnd().endsWith("Environment (OS version + software version + runtime):"));
  assert.ok(en.includes("Actual (symptom; impact):"));
  assert.ok(en.includes("Expected (expectation; diff from actual):"));
  assert.ok(en.includes("Reproduction (preconditions and scenario + numbered steps; flaky → frequency):"));
});

test("工具节照抄 DSH 三行：deck_issue_report 与 suggest_next_steps 是真实注册工具", () => {
  for (const [label, build] of ENTRIES) {
    for (const lang of LANGUAGES) {
      const text = build({ lang, repo: REPO });
      assert.ok(text.includes(lang === "zh" ? "## 工具" : "## Tools"), `${label}/${lang}：缺工具节`);
      assert.ok(text.includes("deck_issue_report"), `${label}/${lang}：工具节必须点名 deck_issue_report`);
      assert.ok(text.includes("suggest_next_steps"), `${label}/${lang}：工具节必须点名 suggest_next_steps`);
      assert.ok(text.includes("/ask-matt"), `${label}/${lang}：工具节保留 /ask-matt 规则引用`);

      // 提示词点名的每一个 deck_ 工具都必须是本仓真实注册的；suggest_next_steps 同口径核对。
      for (const named of new Set(text.match(/deck_[a-z_]+/g) ?? [])) {
        assert.ok(REGISTERED.has(named), `${label}/${lang}：提示词点名了未注册工具 ${named}`);
      }
      assert.ok(REGISTERED.has("suggest_next_steps"), "suggest_next_steps 必须在本仓注册");
    }
  }
});

test("BUG 查重节点名的是真实注册的 deck_issue_list / deck_issue_get", () => {
  const text = buildNewBugPrompt({ lang: "zh", repo: REPO });
  assert.ok(text.includes("deck_issue_list"));
  assert.ok(text.includes("deck_issue_get"));
  assert.ok(REGISTERED.has("deck_issue_list"));
  assert.ok(REGISTERED.has("deck_issue_get"));
});
