import assert from "node:assert/strict";
import { test } from "node:test";
import { issueActionPrompt } from "../shared/issue-action-prompts.ts";

/**
 * 票面动作提示词的门禁（照 DSH `tests/verify-prompts.ts` 的口径：条数、每种语言、
 * 关键字不能漂）。这些文本直接决定 agent 拿到票之后怎么走，少一条或少了收尾那一步，
 * 用户看到的就是「agent 又没按流程做」——不靠人肉 review 兜。
 */

const ACTIONS = ["diagnose", "fix", "discuss", "research", "prototype", "takeover", "supplement", "execute"];
const LANGS = ["zh", "en"];

test("八个动作 × 两种语言都有正文，且都以技能命令开场", () => {
  for (const lang of LANGS) {
    for (const action of ACTIONS) {
      const prompt = issueActionPrompt(action, lang, "issue");
      assert.ok(prompt.trim().length > 0, `${action}/${lang} 不能为空`);
      assert.match(prompt, /^\/[a-z-]+/m, `${action}/${lang} 要以技能命令开场`);
      assert.match(prompt, /^## /m, `${action}/${lang} 至少要有一个小节`);
      assert.ok(!prompt.includes("{"), `${action}/${lang} 不能留下未填的占位符`);
    }
  }
});

test("实施类动作明确要求收尾关票，补充信息类明确要求等待期间不关票", () => {
  assert.match(issueActionPrompt("fix", "zh", "issue"), /完成后关闭/);
  assert.match(issueActionPrompt("execute", "zh", "issue"), /完成后关闭/);
  assert.match(issueActionPrompt("fix", "en", "issue"), /close only when complete/);
  assert.match(issueActionPrompt("execute", "en", "issue"), /close only when complete/);
  assert.match(issueActionPrompt("supplement", "zh", "issue"), /等待期间不实施、不关闭票/);
  assert.match(issueActionPrompt("supplement", "en", "issue"), /Do not implement or close while waiting/);
});

test("拉取请求只看不改：不套用票面流程", () => {
  assert.match(issueActionPrompt("fix", "zh", "pull-request"), /只审查这个拉取请求/);
  assert.match(issueActionPrompt("fix", "en", "pull-request"), /Review this pull request only/);
});
