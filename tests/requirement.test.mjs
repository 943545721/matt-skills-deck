import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequirementBody, requirementLabels, requirementSections } from "../shared/requirement.ts";

test("探索与实施各有六个不同的小节，数量固定", () => {
  const explore = requirementSections("explore");
  const implement = requirementSections("implement");
  assert.equal(explore.length, 6);
  assert.equal(implement.length, 6);
  assert.notDeepEqual(explore, implement);
  assert.ok(explore.includes("Options"));
  assert.ok(implement.includes("Test plan"));
});

test("生成的正文含全部小节与占位注释，备注原样附在最后", () => {
  const body = buildRequirementBody("implement", "  先改 server，再补测试  ");
  for (const title of requirementSections("implement")) assert.match(body, new RegExp(`## ${title}`));
  assert.match(body, /<!-- Fill this in before implementation\. -->/);
  assert.match(body, /## Notes\n先改 server，再补测试/);
});

test("没有备注时不凭空加一个空的 Notes 小节", () => {
  const body = buildRequirementBody("explore", "   ");
  assert.doesNotMatch(body, /## Notes/);
});

test("需求票统一带 requirement 标签，不抢 wayfinder 路线标签", () => {
  assert.deepEqual(requirementLabels(), ["requirement"]);
});
