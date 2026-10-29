import type { DeckLang } from "./requirement.ts";

/**
 * 「新建需求 / + bug」的新会话开场白。
 *
 * 结构逐字按 DSH `kernel/prompt-data.ts` 的 newWayfinder / newSpec /
 * newBugWayfinder，加上 `kernel/router.ts` 在选卡后的拼装：
 * - 探索 / 实施两张卡末尾接 `prompt.requirementPrefix`（需求描述：/ Requirement: ）；
 * - BUG 末尾接 `newBugFields` 四项必填字段。
 *
 * 工具节照抄 DSH 的三行：deck_issue_report 与 suggest_next_steps 在本仓都已注册
 * （`server/mcp/tools.ts` 的 HANDLERS 与 MCP_TOOLS），不是空调用。
 */
export interface EntryPromptInput {
  lang: DeckLang;
  repo: string;
}

const pick = <T,>(lang: DeckLang, zh: T, en: T): T => (lang === "zh" ? zh : en);

/** 探索 / 实施共用的「调查」节。 */
function investigate(lang: DeckLang, ticketScoped: boolean): string[] {
  const first = ticketScoped
    ? pick(
        lang,
        "建议先阅读本票正文、评论及仓内相关内容后再提问。",
        "It is recommended to read this ticket body, its comments, and related in-repo material before asking.",
      )
    : pick(
        lang,
        "建议先阅读仓内相关内容（文档、代码、相关 issue）后再提问。",
        "It is recommended to read related material in the repo (docs, code, related issues) before asking.",
      );
  return [
    first,
    pick(
      lang,
      "建议优先复用仓内既有相关笔记（查找与存放均循仓内习惯），复用时仅记录路径与一句话结论，不粘贴全文。",
      "It is recommended to reuse an existing related note in the repo first (where to look and where to store both follow the repo convention); record only its path plus a one-sentence conclusion, never the full text.",
    ),
    pick(
      lang,
      "确认已找到的既有笔记无法回答本次问题后，再按 /research 规则新查一次，并用一句话说明不适用的原因，新笔记路径回填至正文。",
      "Only after the existing notes you found cannot answer this question, run one new /research pass per its skill rules; state in one sentence why they do not fit, then write the new note path back into the body.",
    ),
    pick(
      lang,
      "提问前用一句话说明已查阅范围，问题本身仍按本模板原有提问格式提出。",
      "Before asking, state in one sentence what you checked; ask the question itself in this template original question format.",
    ),
  ];
}

/** 调查节整体：DSH 模板里头部 + 四条，头部跟随语言；英文 bug 版比需求版多一个 first。 */
function investigateSection(lang: DeckLang, ticketScoped: boolean): string[] {
  return [
    pick(
      lang,
      "## 调查（建议先查后问）",
      ticketScoped
        ? "## Investigate first (recommended: look before asking)"
        : "## Investigate (recommended: look before asking)",
    ),
    ...investigate(lang, ticketScoped),
  ];
}

/** DSH 三行工具节；三个入口共用同一份。 */
function entryTools(lang: DeckLang): string[] {
  return pick(
    lang,
    [
      "## 工具",
      "- [ ] issue 相关操作优先使用 deck_ 开头的工具处理",
      "- [ ] 及时使用 deck_issue_report 工具上报处理过、处理中的 issue 编号",
      "- [ ] 回复前最后一步，结合当下实际场景 按 /ask-matt 的规则，判断是否可以推荐当前最适合的技能，并且调用 suggest_next_steps 工具 进行推荐。",
    ],
    [
      "## Tools",
      "- [ ] Prefer the deck_ tools for issue operations",
      "- [ ] Report processed and in-progress issue numbers with the deck_issue_report tool in a timely manner",
      "- [ ] As the last step before replying, based on the current actual scenario and following the /ask-matt rules, determine whether the most suitable skill can be recommended, and call the suggest_next_steps tool to recommend it.",
    ],
  );
}

/** router.ts 对需求入口统一追加的 `prompt.requirementPrefix`。 */
function finish(lang: DeckLang): string {
  return pick(lang, "需求描述：", "Requirement: ");
}

export function buildNewWayfinderPrompt({ lang, repo }: EntryPromptInput): string {
  return [
    "/wayfinder",
    pick(lang, "请帮我处理一个需求（严格遵循 wayfinder 技能规则）。", "Please handle a requirement (strictly follow the wayfinder skill rules)."),
    pick(lang, `仓库（已自动填入当前工作区）：${repo}`, `Repo (auto-filled from the current workspace): ${repo}`),
    "",
    ...investigateSection(lang, false),
    "",
    pick(lang, "## 收尾", "## Wrap-up"),
    "",
    ...entryTools(lang),
    "",
    finish(lang),
  ].join("\n");
}

export function buildNewSpecPrompt({ lang, repo }: EntryPromptInput): string {
  return [
    "/grill-with-docs",
    pick(lang, "请帮我讨论一个需求（严格遵循 grill-with-docs 技能规则）。", "Help me discuss a requirement (strictly follow the grill-with-docs skill rules)."),
    pick(lang, `仓库（已自动填入当前工作区）：${repo}`, `Repo (auto-filled from the current workspace): ${repo}`),
    "",
    ...investigateSection(lang, false),
    "",
    pick(lang, "## 讨论收尾（下面这些动作由用户手动执行，不要替用户做）", "## Discussion wrap-up (the user runs the actions below manually; do not run them on their behalf)"),
    pick(lang,
      "- [ ] 讨论结束、结论对齐后，提醒用户手动执行一次 /to-spec，把结论生成规格 issue。",
      "- [ ] Once the discussion is settled and the conclusion is aligned, remind the user to manually run /to-spec once to turn the conclusion into a spec issue."),
    pick(lang,
      "- [ ] 在规格 issue 生成后，再提醒用户手动执行一次 /to-tickets，把规格 issue 拆成实施 issue。",
      "- [ ] After the spec issue is created, remind the user to manually run /to-tickets once to split the spec issue into implementation issues."),
    "",
    ...entryTools(lang),
    "",
    finish(lang),
  ].join("\n");
}

export function buildNewBugPrompt({ lang, repo }: EntryPromptInput): string {
  return [
    "/wayfinder",
    pick(lang, "请帮我新增一个 BUG 单（按 wayfinder 技能规则处理）。", "Please help me file a new BUG ticket (follow the wayfinder skill rules)."),
    pick(lang, `仓库：${repo}`, `Repo: ${repo}`),
    pick(lang,
      "新建的单子必须带上 bug 标签；如果还没有经过诊断，同时带上 needs-triage 标签。远端后端按原生标签方式打标签，本地 Markdown 后端在正文加标签行（例如 Labels: bug, needs-triage）。",
      "New tickets must carry the bug label; if not yet triaged, also carry needs-triage. On remote backends use native labels; on the local Markdown backend add a Labels line (e.g. Labels: bug, needs-triage)."),
    "",
    "",
    pick(lang, "## 澄清", "## Clarify"),
    pick(lang,
      "- [ ] 有假设先用 grilling 澄清，不默认；已给的不重问；四项全空时不建单、先回问报告人，有现象但字段不全则建单并标 needs-info",
      "- [ ] If you hold assumptions, settle them with the grilling skill — never assume; never re-ask what is given; if all four fields are empty, do NOT file — ask the reporter first; if the symptom is present but other fields are missing, file and label needs-info"),
    "",
    ...investigateSection(lang, true),
    "",
    pick(lang, "## 查重", "## Check for duplicates"),
    ...pick(lang, [
      "- [ ] 收齐「实际」后，扫一遍工具能看见的全部 BUG 单：先调 deck_issue_list（state=open、labels=['bug']、limit=200）一次取全，再调一次（state=closed、labels=['bug']、limit=200）一次取全；看返回的编号、标题、标签和更新时间，不要只看前几条。",
      "- [ ] 这两次是全扫，不要用关键词搜索代替：同一个问题可能用完全不同的说法描述，关键词会漏。",
      "- [ ] 标题像的再调 deck_issue_get 看正文；工具回执说清单可能不全时，把这句记下来。",
      "- [ ] 有命中时不要自己先下结论：把最多 3 张候选（编号、标题、像在哪里）列给报告人，问一句「这些是不是同一个问题」，等到回答再决定。",
      "- [ ] 报告人确认是同一问题、旧单还开着：不建新单，在旧单下评论补充这次的现象和复现步骤；旧单不关闭。",
      "- [ ] 报告人确认是同一问题、旧单已关闭：按回归处理，建新单并在正文写明「回归：原单 #编号」，关联旧单。",
      "- [ ] 报告人确认不是，或没有命中：建新单，正文写明看过的候选和报告人的回答。",
      "- [ ] 报告人不确定：把旧单链接发给报告人再看一眼；仍不能判断时按新建处理并关联候选、标 needs-info。",
      "- [ ] 两次扫描与查重记录是建单的前置条件：缺任何一步，先补完再建单；工具本身报错时，把错误写进查重记录再建单。",
    ], [
      "- [ ] Once \"Actual\" is filled in, scan every BUG ticket the tools can see: call deck_issue_list (state=open, labels=['bug'], limit=200) to take them all, then call it again (state=closed, labels=['bug'], limit=200) to take them all. Read the returned key, title, labels and updated time; do not look only at the first few.",
      "- [ ] These two calls are full scans; do not replace them with keyword search — the same problem can be described in completely different words, and keywords will miss it.",
      "- [ ] Open the body with deck_issue_get only when a title looks similar. If the tool says the list may be incomplete, keep that sentence.",
      "- [ ] When something looks similar, do not decide on your own: show the reporter up to 3 candidates (key, title, why it looks similar) and ask \"are these the same problem\"; wait for the answer before deciding.",
      "- [ ] The reporter confirms the same problem and the old ticket is still open: do NOT file a new ticket; comment on the old ticket with this report's symptom and reproduction steps; do not close the old ticket.",
      "- [ ] The reporter confirms the same problem but the old ticket is closed: treat it as a regression, file a new ticket, write \"Regression of #key\" into the body, and link the old ticket.",
      "- [ ] The reporter says it is not the same, or nothing matched: file a new ticket and write the candidates you looked at and the reporter's answer into the body.",
      "- [ ] The reporter is unsure: send the old ticket link for a look; if it is still undecidable, file and link the candidates, label needs-info.",
      "- [ ] The two scans and the duplicate-check record are prerequisites for filing: finish any missing step before filing; if the tool itself errors, write the error into the duplicate-check record and then file.",
    ]),
    "",
    pick(lang, "## 查重记录", "## Duplicate check record"),
    ...pick(lang, [
      "- [ ] 新单正文固定加一节「## 查重记录」，没有命中也要写；按实际查重过程填，不要编造。",
      "- [ ] 扫描：查了哪些状态与标签、各拿到多少张；工具说清单可能不全，就写在这里。",
      "- [ ] 命中：候选的编号与标题；没有就写「无」。",
      "- [ ] 报告人确认：报告人怎么回答的。",
      "- [ ] 结论：新建 / 关联哪张旧单 / 按回归新建。",
    ], [
      "- [ ] Always add a \"## Duplicate check record\" section to the new ticket body, even when nothing matched; fill it from the actual check, never fabricate.",
      "- [ ] Scanned: which states and labels you looked at, and how many tickets each returned; if the tool says the list may be incomplete, write that here.",
      "- [ ] Hits: candidate keys and titles; write \"none\" when nothing matched.",
      "- [ ] Reporter confirmed: what the reporter answered.",
      "- [ ] Conclusion: new ticket / linked to which old ticket / filed as a regression.",
    ]),
    "",
    pick(lang, "## 自查", "## Self-check"),
    pick(lang,
      "- [ ] 逐项核对无遗漏；查重记录已写进正文（或已在旧单评论）；结束前写明真实状态",
      "- [ ] Check every box with no gaps; duplicate-check record written into the body (or already commented on the old ticket); true state written before finishing"),
    "",
    ...entryTools(lang),
    "",
    pick(lang,
      "以下四项均为必填；四项全空时不要建单，先回问报告人补齐。",
      "The four fields below are required; if all four are empty, do not file — ask the reporter to complete them first."),
    "",
    pick(lang, "实际（现象；影响范围）：", "Actual (symptom; impact):"),
    pick(lang, "期望（预期；与实际差异）：", "Expected (expectation; diff from actual):"),
    pick(lang, "复现步骤（前置条件和场景 + 编号步骤；偶发写频率）：", "Reproduction (preconditions and scenario + numbered steps; flaky → frequency):"),
    pick(lang, "环境信息（OS 版本 + 软件版本 + 运行环境）：", "Environment (OS version + software version + runtime):"),
  ].join("\n");
}
