import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_TOOLS } from "../server/mcp/tools.ts";
import {
  buildBugBody,
  buildBugPrompt,
  buildRequirementBody,
  buildRequirementPrompt,
  bugLabels,
  bugMissingFields,
  deckLang,
  requirementLabels,
  requirementSections,
} from "../shared/requirement.ts";

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

test("中文界面出中文六节，备注落在「备注」小节", () => {
  const body = buildRequirementBody("explore", "先看看现有实现", "zh");
  assert.equal(requirementSections("explore", "zh").length, 6);
  assert.match(body, /## 待定问题/);
  assert.match(body, /<!-- 实施前把这些小节补全。 -->/);
  assert.match(body, /## 备注\n先看看现有实现/);
});

test("locale 只分中文与其它，其它一律按英文", () => {
  assert.equal(deckLang("zh-CN"), "zh");
  assert.equal(deckLang("zh"), "zh");
  assert.equal(deckLang("en-US"), "en");
  assert.equal(deckLang(undefined), "en");
});

test("缺陷正文固定四节加查重记录，缺项写明未提供", () => {
  const body = buildBugBody(
    { actual: "点保存没反应", expected: "应该保存成功", reproduce: "1. 打开票\n2. 点保存", environment: "" },
    "zh",
  );
  assert.match(body, /## 实际（现象；影响范围）\n点保存没反应/);
  assert.match(body, /## 期望（预期；与实际差异）\n应该保存成功/);
  assert.match(body, /## 复现步骤（前置条件和场景 \+ 编号步骤；偶发写频率）\n1\. 打开票\n2\. 点保存/);
  assert.match(body, /## 环境信息（OS 版本 \+ 软件版本 \+ 运行环境）\n<!-- 建票时没填；知道后补在这里。 -->/);
  assert.match(body, /## 查重记录\n<!-- 由 Agent 按「查重」提示词补全/);
});

test("bugMissingFields 按固定顺序列出缺项，空白算缺", () => {
  assert.deepEqual(bugMissingFields({ actual: "a", expected: " ", reproduce: "r", environment: "e" }), ["expected"]);
  assert.deepEqual(bugMissingFields({ actual: "", expected: "", reproduce: "", environment: "" }), [
    "actual",
    "expected",
    "reproduce",
    "environment",
  ]);
});

test("缺陷标签：没诊断挂 needs-triage，缺字段挂 needs-info", () => {
  assert.deepEqual(bugLabels({ diagnosed: false, incomplete: false }), ["bug", "needs-triage"]);
  assert.deepEqual(bugLabels({ diagnosed: true, incomplete: false }), ["bug"]);
  assert.deepEqual(bugLabels({ diagnosed: true, incomplete: true }), ["bug", "needs-info"]);
  assert.deepEqual(bugLabels({ diagnosed: false, incomplete: true }), ["bug", "needs-triage", "needs-info"]);
});

test("探索提示词以 /wayfinder 开场，带仓库、票号与链接", () => {
  const prompt = buildRequirementPrompt("explore", {
    repoKey: "acme/app",
    number: 7,
    title: "重做入口",
    url: "https://github.com/acme/app/issues/7",
    lang: "zh",
  });
  assert.equal(prompt.split("\n")[0], "/wayfinder");
  assert.match(prompt, /仓库：acme\/app/);
  assert.match(prompt, /票：#7 重做入口/);
  assert.match(prompt, /链接：https:\/\/github\.com\/acme\/app\/issues\/7/);
  assert.match(prompt, /## 收尾/);
  // 预建的票是种子，不是地图：不能让 wayfinder 把六节需求骨架硬当地图用。
  assert.match(prompt, /## 这张票/);
  assert.match(prompt, /不是地图票/);
  assert.match(prompt, /wayfinder:map/);
});

test("实施提示词以 /grill-with-docs 开场，收尾提醒用户手跑 /to-spec 与 /to-tickets", () => {
  const prompt = buildRequirementPrompt("implement", { repoKey: "acme/app", number: 8, title: "补测试", url: "u" });
  assert.equal(prompt.split("\n")[0], "/grill-with-docs");
  assert.match(prompt, /manually run \/to-spec/);
  assert.match(prompt, /manually run \/to-tickets/);
  // 「写回结论」是 Agent 的动作，不能藏在「用户手动执行」的标题下。
  assert.match(prompt, /Discussion wrap-up \(write the conclusion back first/);
  assert.match(prompt, /Write the discussion conclusion back into this ticket/);
  assert.match(prompt, /Repo: acme\/app/);
  assert.match(prompt, /Ticket: #8 补测试/);
});

test("中文实施提示词把「写回结论」与用户手动动作分开", () => {
  const prompt = buildRequirementPrompt("implement", {
    repoKey: "acme/app",
    number: 8,
    title: "补测试",
    url: "u",
    lang: "zh",
  });
  assert.match(prompt, /讨论收尾（先由你把结论写回本票；下面两个动作由用户手动执行）/);
  assert.match(prompt, /讨论结论写回本票正文或评论/);
  assert.match(prompt, /\/to-spec/);
  assert.match(prompt, /\/to-tickets/);
});

test("缺陷提示词包含澄清、查重与查重记录，默认英文也成立", () => {
  const prompt = buildBugPrompt({ repoKey: "acme/app", number: 9, title: "保存无响应", url: "u", lang: "zh" });
  assert.equal(prompt.split("\n")[0], "/wayfinder");
  assert.match(prompt, /## 澄清/);
  // 小节标题必须独占一行：曾经漏了一个展开运算符，整块被 join 成逗号串。
  assert.match(prompt, /^## 澄清$/m);
  assert.match(prompt, /^## 查重$/m);
  assert.match(prompt, /## 查重/);
  assert.match(prompt, /deck_issue_list（state=open、limit=100、repo=acme\/app）/);
  assert.match(prompt, /## 查重记录/);
  assert.match(prompt, /## 自查/);

  const english = buildBugPrompt({ repoKey: "acme/app", number: 9, title: "Save does nothing", url: "u" });
  assert.match(english, /^## Clarify$/m);
  assert.match(english, /## Check for duplicates/);
  assert.match(english, /## Duplicate check record/);
});

test("缺陷提示词写目标标签与当前标签；失败时只补目标集合且先读再改", () => {
  const ok = buildBugPrompt({
    repoKey: "acme/app",
    number: 9,
    title: "保存无响应",
    url: "u",
    lang: "zh",
    labels: ["bug", "needs-info"],
    expectedLabels: ["bug", "needs-info"],
  });
  assert.match(ok, /当前标签：bug、needs-info；目标标签：bug、needs-info/);
  assert.doesNotMatch(ok, /标签没挂上/);

  const failed = buildBugPrompt({
    repoKey: "acme/app",
    number: 9,
    title: "保存无响应",
    url: "u",
    lang: "zh",
    labels: [],
    expectedLabels: ["bug"],
    labelsFailed: true,
  });
  assert.match(failed, /目标标签：bug。/);
  // 诊断过的完整票只该带 bug：失败补救不能顺手把 needs-* 全加上。
  assert.doesNotMatch(failed, /目标标签：bug、needs-triage/);
  assert.match(failed, /deck_issue_get（number=<本票号>、repo=acme\/app）/);
  assert.match(failed, /deck_issue_labels（number=<本票号>、labels=\[完整标签集\]、repo=…）/);
  assert.match(failed, /labelsTruncated=true/);
  assert.match(failed, /gh label create/);

  const failedMissing = buildBugPrompt({
    repoKey: "acme/app",
    number: 9,
    title: "保存无响应",
    url: "u",
    lang: "zh",
    expectedLabels: ["bug", "needs-info"],
    labelsFailed: true,
  });
  assert.match(failedMissing, /目标标签：bug、needs-info。/);
});

test("没有网页链接时不输出空的链接行", () => {
  const prompt = buildRequirementPrompt("implement", { repoKey: "local/deck", number: 3, title: "本地票", url: "" });
  assert.doesNotMatch(prompt, /^Link:\s*$/m);
  assert.match(prompt, /Repo: local\/deck/);
});

test("种子票建地图 / 挂路线、标签读不全、查重写回都落到具体工具语义", () => {
  const explore = buildRequirementPrompt("explore", {
    repoKey: "acme/app",
    number: 7,
    title: "入口",
    url: "u",
    lang: "zh",
  });
  assert.match(explore, /deck_issue_create（kind=map、repo=…）/);
  assert.match(explore, /deck_map_link（key=<本票号>、parentKey=<地图号>/);
  // 补边工具只改父子 / 阻塞，不再承担路线标签；旧参数名不能残留在提示里。
  assert.match(explore, /补阻塞关系用 blockedBy/);
  assert.doesNotMatch(explore, /mapNumber=/);
  assert.doesNotMatch(explore, /只服务地图票/);
  assert.match(explore, /labelsTruncated=true 时不要调用/);
  // 用户手输的地图标签不能把六节需求骨架变成地图。
  assert.match(explore, /如果票面实际标签却有 wayfinder:map/);

  const failed = buildBugPrompt({
    repoKey: "acme/app",
    number: 9,
    title: "保存无响应",
    url: "u",
    lang: "zh",
    expectedLabels: ["bug"],
    labelsFailed: true,
  });
  assert.match(failed, /labelsTruncated=true 表示标签读不全/);
  assert.match(failed, /不要声称标签已修好/);
  assert.match(failed, /补完重新 deck_issue_get/);

  const bug = buildBugPrompt({ repoKey: "acme/app", number: 9, title: "保存无响应", url: "u", lang: "zh" });
  assert.match(bug, /只有本票或旧单实际已经带 duplicate 标签时才/);
  assert.match(bug, /不要用 deck_map_link 关联 BUG 单/);
  assert.match(bug, /deck_issue_patch（close=true）/);
  assert.match(bug, /deck_issue_patch 的 body 是整篇替换/);
  // 本地 .deck 后端能直接写新标签，不能一律让用户去 gh label create。
  assert.match(bug, /本地 \.deck 后端可以直接写入新标签/);
  // 列表地图优先，不能说成「最近 100 张」。
  assert.doesNotMatch(bug, /最近 100 张/);
  assert.match(bug, /前 100 张（地图优先）/);
});

test("提示词只点名真实注册的 deck_ 工具", () => {
  const known = new Set(MCP_TOOLS.map((tool) => tool.name));
  // 显式白名单：光是「已注册」不够，deck_issue_report 也能注册，但语义是记录工作路线，不能出现在提示词里。
  const allowed = new Set([
    "deck_issue_list",
    "deck_issue_get",
    "deck_issue_comment",
    "deck_issue_patch",
    "deck_issue_labels",
    "deck_issue_create",
    "deck_map_link",
    "deck_next_steps",
  ]);
  const input = { repoKey: "acme/app", number: 7, title: "入口", url: "u" };
  const prompts = [
    buildRequirementPrompt("explore", input),
    buildRequirementPrompt("implement", input),
    buildBugPrompt(input),
    buildBugPrompt({ ...input, expectedLabels: ["bug"], labelsFailed: true }),
    buildBugPrompt({ ...input, lang: "zh", expectedLabels: ["bug"], labelsFailed: true }),
  ];
  for (const prompt of prompts) {
    const referenced = [...prompt.matchAll(/\bdeck_[a-z_]+\b/g)].map((match) => match[0]);
    assert.ok(referenced.length > 0, "提示词至少要引用一个 deck_ 工具");
    for (const name of referenced) {
      assert.ok(known.has(name), `提示词引用了未注册的工具：${name}`);
      assert.ok(allowed.has(name), `提示词引用了不在白名单里的工具：${name}`);
    }
    assert.doesNotMatch(prompt, /suggest_next_steps/);
    assert.doesNotMatch(prompt, /deck_issue_report/);
  }

  // 示例必须带必填的 number，否则 Agent 照抄会被参数校验拒绝。
  const zhBug = prompts[4];
  assert.match(zhBug, /deck_issue_get（number=<本票号>、repo=acme\/app）/);
  assert.match(zhBug, /deck_issue_labels（number=<本票号>、labels=\[完整标签集\]、repo=…）/);
  assert.match(prompts[3], /deck_issue_get \(number=<this ticket>, repo=acme\/app\)/);
  assert.match(prompts[2], /deck_issue_get \(number=<candidate>, repo=acme\/app\)/);
});
