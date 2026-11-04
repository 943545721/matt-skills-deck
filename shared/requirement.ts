/**
 * 需求票与缺陷票的正文骨架，以及交给 Agent 的技能提示词。
 *
 * 需求票的六节是「起点」：用户写的备注原样附在后面，不塞进某一个小节里假装已经想清楚了。
 * 技能提示词对应 DSH 新建入口里的 `/wayfinder` 与 `/grill-with-docs`：
 * Paseo 插件不能替用户开会话，所以这里只产出文本，由用户复制后粘到会话里。
 *
 * 纯函数，客户端生成正文、测试校验形状都用这一份。
 */

import { IMPACT_CHAIN_COLUMN, IMPACT_COLUMNS, IMPACT_HEADING } from "./impact.ts";

export type RequirementMode = "explore" | "implement";
export type DeckLang = "zh" | "en";

/** App 的 locale 可能是 `zh-CN` / `en-US`；这里只分两种，其它语言按英文出。 */
export function deckLang(locale: string | undefined): DeckLang {
  return locale && locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const pick = <T,>(lang: DeckLang, zh: T, en: T): T => (lang === "zh" ? zh : en);

const SECTIONS: Record<RequirementMode, Record<DeckLang, readonly string[]>> = {
  explore: {
    en: ["Problem", "Goals and non-goals", "Constraints", "Options", "Recommendation", "Open questions"],
    zh: ["问题", "目标与非目标", "约束", "备选方案", "建议", "待定问题"],
  },
  implement: {
    en: ["Context", "Goal", "Scope", "Steps", "Test plan", "Risks and rollback"],
    zh: ["背景", "目标", "范围", "步骤", "测试计划", "风险与回滚"],
  },
};

const PLACEHOLDER: Record<DeckLang, string> = {
  en: "<!-- Fill this in before implementation. -->",
  zh: "<!-- 实施前把这些小节补全。 -->",
};

export function requirementSections(mode: RequirementMode, lang: DeckLang = "en"): readonly string[] {
  return SECTIONS[mode][lang];
}

/** 影响面表头：四列固定，第五列可选。空表不允许定稿，由 `finalizeProblem` 拦。 */
function impactTableSkeleton(): string[] {
  const header = [...IMPACT_COLUMNS, IMPACT_CHAIN_COLUMN];
  return [IMPACT_HEADING, `| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ""];
}

export function buildRequirementBody(mode: RequirementMode, notes: string, lang: DeckLang = "en"): string {
  const skeleton = [
    ...requirementSections(mode, lang).flatMap((title) => [`## ${title}`, PLACEHOLDER[lang], ""]),
    // 影响面不是第七节「想法」，是派单与定稿读的机器可读表：需求票从一开始就带着它。
    ...impactTableSkeleton(),
  ];
  const trimmed = notes.trim();
  if (!trimmed) return skeleton.join("\n");
  return [...skeleton, `## ${pick(lang, "备注", "Notes")}`, trimmed, ""].join("\n");
}

/**
 * 表单选「探索 / 实施需求」后真正提交的正文。
 *
 * 已经出现任何 `## ` 小节就原样提交：用户可能自己重写了骨架，
 * 再套一层会把他的正文塞进「备注」，看起来像被改写。
 * 全是散文（或空）时当作备注，套进六节 + 影响面表。
 */
export function planRequirementBody(mode: RequirementMode, notes: string, lang: DeckLang = "en"): string {
  return /^##\s/m.test(notes) ? notes : buildRequirementBody(mode, notes, lang);
}

/** 需求标签与手填标签合并；去重不分大小写，用户手写了 `Requirement` 也不再重复一遍。 */
export function mergeRequirementLabels(labels: readonly string[]): string[] {
  const merged = labels.map((label) => label.trim()).filter(Boolean);
  for (const label of requirementLabels()) {
    if (!merged.some((item) => item.toLowerCase() === label.toLowerCase())) merged.push(label);
  }
  return merged;
}

/** 需求票统一带 `requirement`：不抢 wayfinder 路线标签，路线仍由地图显式挂。 */
export function requirementLabels(): string[] {
  return ["requirement"];
}

/** DSH 的四个 BUG 字段；「实际」是唯一必须有内容的，其它缺项会标 needs-info。 */
export interface BugFields {
  actual: string;
  expected: string;
  reproduce: string;
  environment: string;
}

const BUG_HEADINGS: Record<DeckLang, Record<keyof BugFields | "dedup", string>> = {
  en: {
    actual: "Actual (symptom; impact)",
    expected: "Expected (expectation; diff from actual)",
    reproduce: "Reproduction (preconditions and scenario + numbered steps; flaky → frequency)",
    environment: "Environment (OS version + software version + runtime)",
    dedup: "Duplicate check record",
  },
  zh: {
    actual: "实际（现象；影响范围）",
    expected: "期望（预期；与实际差异）",
    reproduce: "复现步骤（前置条件和场景 + 编号步骤；偶发写频率）",
    environment: "环境信息（OS 版本 + 软件版本 + 运行环境）",
    dedup: "查重记录",
  },
};

const BUG_MISSING: Record<DeckLang, string> = {
  en: "<!-- Not provided at filing; add it here when it is known. -->",
  zh: "<!-- 建票时没填；知道后补在这里。 -->",
};

/** 查重由 Agent 做：立项时先留一节空位，避免事后忘了写。 */
const BUG_DEDUP_PLACEHOLDER: Record<DeckLang, string> = {
  en: "<!-- Filled by the agent from the duplicate-check prompt: what was scanned, hits, reporter confirmation, conclusion. -->",
  zh: "<!-- 由 Agent 按「查重」提示词补全：扫描范围、命中候选、报告人确认、结论。 -->",
};

export function bugMissingFields(fields: BugFields): (keyof BugFields)[] {
  const order: (keyof BugFields)[] = ["actual", "expected", "reproduce", "environment"];
  return order.filter((key) => !fields[key].trim());
}

export function buildBugBody(fields: BugFields, lang: DeckLang = "en"): string {
  const headings = BUG_HEADINGS[lang];
  const value = (text: string): string => text.trim() || BUG_MISSING[lang];
  return [
    `## ${headings.actual}`,
    value(fields.actual),
    "",
    `## ${headings.expected}`,
    value(fields.expected),
    "",
    `## ${headings.reproduce}`,
    value(fields.reproduce),
    "",
    `## ${headings.environment}`,
    value(fields.environment),
    "",
    `## ${headings.dedup}`,
    BUG_DEDUP_PLACEHOLDER[lang],
    "",
  ].join("\n");
}

export function bugLabels(options: { diagnosed: boolean; incomplete: boolean }): string[] {
  const labels = ["bug"];
  // 没诊断过先挂 needs-triage；缺字段再挂 needs-info，和 DSH 的标签口径一致。
  if (!options.diagnosed) labels.push("needs-triage");
  if (options.incomplete) labels.push("needs-info");
  return labels;
}

export interface SkillPromptInput {
  repoKey: string;
  number: number;
  title: string;
  url: string;
  lang?: DeckLang;
}

export interface BugPromptInput extends SkillPromptInput {
  /** 建票接口实际挂上的标签；缺省表示没传（测试或旧调用）。 */
  labels?: readonly string[];
  /** 建票时本应挂上的标签（含用户手输）：标签失败时只补这些，不要多补。 */
  expectedLabels?: readonly string[];
  /** 建票成功但标签没挂上：提示词要如实说，并让 Agent 先补齐。 */
  labelsFailed?: boolean;
}

function ticketHead(input: SkillPromptInput, lang: DeckLang, skill: string, ask: string): string[] {
  const head = [
    skill,
    ask,
    pick(lang, `仓库：${input.repoKey}`, `Repo: ${input.repoKey}`),
    pick(lang, `票：#${input.number} ${input.title}`, `Ticket: #${input.number} ${input.title}`),
  ];
  // 本地 `.deck` 后端没有网页链接：不要留一条空的「链接：」让 Agent 去猜。
  if (input.url.trim()) head.push(pick(lang, `链接：${input.url}`, `Link: ${input.url}`));
  head.push("");
  return head;
}

/** DSH「调查（建议先查后问）」；两条提示词共用。 */
function investigate(lang: DeckLang): string[] {
  return pick(
    lang,
    [
      "## 调查（建议先查后问）",
      "- [ ] 建议先阅读本票正文、评论及仓内相关内容后再提问。",
      "- [ ] 建议优先复用仓内既有相关笔记（查找与存放均循仓内习惯），复用时仅记录路径与一句话结论，不粘贴全文。",
      "- [ ] 确认已找到的既有笔记无法回答本次问题后，再按 /research 规则新查一次，并用一句话说明不适用的原因，新笔记路径回填至正文。",
      "- [ ] 提问前用一句话说明已查阅范围，问题本身仍按本模板原有提问格式提出。",
      "",
    ],
    [
      "## Investigate first (recommended: look before asking)",
      "- [ ] Read this ticket body, its comments, and related in-repo material before asking.",
      "- [ ] Reuse an existing related note in the repo first (where to look and where to store both follow the repo convention); record only its path plus a one-sentence conclusion, never the full text.",
      "- [ ] Only after the existing notes you found cannot answer this question, run one new /research pass per its skill rules; state in one sentence why they do not fit, then write the new note path back into the body.",
      "- [ ] Before asking, state in one sentence what you checked; ask the question itself in this template original question format.",
      "",
    ],
  );
}

/**
 * 旧版票级提示词（buildRequirementPrompt / buildBugBody）共用的工具节。
 *
 * 只点名本工作区真实注册的工具（`server/mcp/tools.ts`）。DSH 入口提示词的三行工具节
 * 已逐字迁到 shared/entry-prompt.ts——`deck_issue_report` 与 `suggest_next_steps`
 * 在本仓都已注册，不是空调用。这里保留的是票级提示词自己的旧口径：技能推荐写进回复，
 * 且不在本票上调用只服务地图的 `deck_next_steps`。
 */
export function requirementTools(lang: DeckLang): string[] {
  return pick(
    lang,
    [
      "## 工具",
      "- [ ] issue 相关操作优先使用 deck_ 工具（deck_issue_list / deck_issue_get / deck_issue_comment / deck_issue_patch / deck_issue_labels；建票或建地图用 deck_issue_create，补父子 / 阻塞边用 deck_map_link）。",
      "- [ ] 多仓库工作区里，读写票都带上 repo（owner/name），不要只凭票号猜仓库。",
      "- [ ] 本地 .deck 工作区也走 deck_ 工具，不要改用 gh 建票 / 改票；本地板上看不到 gh 的写入。",
      "- [ ] deck_issue_labels 是整体替换：先 deck_issue_get 读全现有标签，labels 传完整集合；labelsTruncated=true 时不要调用，按工具返回的提示去面板 / GitHub 网页补齐标签后重读。GitHub 后端只接受仓库里已有的标签，缺标签时先让用户创建（gh label create），不要反复重试；本地 .deck 后端可以直接写入新标签。",
      "- [ ] deck_issue_patch 的 body 是整篇替换：先 deck_issue_get 读原文，再传追加 / 修改后的完整正文，不要只传新增的那一段。",
      "- [ ] deck_issue_create 建地图时传 kind=map（自动加 wayfinder:map）；deck_map_link 只补边、不改标签：key 是要改的票，parentKey 挂父票，blockedBy 整批替换这张票的阻塞者。路线类型标签用 deck_issue_labels 单独补；查重关联不要用它。写前会做整批成环预检，写后逐条读回并标出落点。",
      "- [ ] 回复前最后一步，按 /ask-matt 的规则判断当前最适合的技能，并在回复里直接写出来；不要在本票上调用只服务地图的 deck_next_steps（新建地图票后可以用它推进那张地图）。",
    ],
    [
      "## Tools",
      "- [ ] Prefer the deck_ tools for issue operations (deck_issue_list / deck_issue_get / deck_issue_comment / deck_issue_patch / deck_issue_labels; use deck_issue_create to create a ticket or map, and deck_map_link to add parent / blockedBy edges).",
      "- [ ] In a multi-repository workspace, pass repo (owner/name) for every issue read or write; never guess the repository from the number alone.",
      "- [ ] In a local .deck workspace use the deck_ tools too; do not switch to gh for creates or edits, because the local board will not see those writes.",
      "- [ ] deck_issue_labels replaces the full set: read all current labels with deck_issue_get first, then pass the complete set; when labelsTruncated=true do not call it — follow the tool's guidance, add the labels via the panel / GitHub web UI, then re-read. On the GitHub backend it only accepts labels that already exist, so ask the user to create a missing label (gh label create) instead of retrying; the local .deck backend can write new labels directly.",
      "- [ ] deck_issue_patch replaces the whole body: read the original with deck_issue_get first, then pass the complete body with your addition or edit, not just the new fragment.",
      "- [ ] When creating a map with deck_issue_create, pass kind=map (it adds wayfinder:map automatically); deck_map_link only changes edges, never labels: key is the ticket to change, parentKey attaches a parent, blockedBy replaces that ticket's whole blocker set. Add route-kind labels separately with deck_issue_labels; do not use it to link duplicate reports. Every batch is cycle-checked before writing, and every edge is read back and reports where it landed.",
      "- [ ] As the last step before replying, apply the /ask-matt rules to decide the most suitable skill and state it in the reply; do not call deck_next_steps on this ticket (you may use it on the map ticket you create).",
    ],
  );
}

/**
 * 需求票的技能提示词。
 *
 * 探索走 `/wayfinder`，实施走 `/grill-with-docs`；实施这张票已经建好，
 * 所以收尾只提醒用户手动执行 `/to-spec` 与 `/to-tickets`，不替用户拆票。
 */
export function buildRequirementPrompt(mode: RequirementMode, input: SkillPromptInput): string {
  const lang = input.lang ?? "en";
  if (mode === "explore") {
    return [
      ...ticketHead(
        input,
        lang,
        "/wayfinder",
        pick(lang, "请帮我处理这张需求票（严格遵循 wayfinder 技能规则）。", "Please handle this requirement ticket (strictly follow the wayfinder skill rules)."),
      ),
      ...pick(
        lang,
        [
          "## 这张票",
          "- [ ] 建票界面没有勾地图，本票不是地图票，正文也不是地图骨架；如果票面实际标签却有 wayfinder:map（例如用户手输），先和用户确认，不要直接把六节正文当地图骨架。",
          "- [ ] 按 wayfinder 规则绘制地图时，用 deck_issue_create（kind=map、repo=…）新建地图票；再用 deck_map_link（key=<本票号>、parentKey=<地图号>、repo=…）把本票挂到地图下；本票还缺路线类型标签时，用 deck_issue_labels 整体补 wayfinder:<kind>（先 deck_issue_get 读全现有标签）。补阻塞关系用 blockedBy。它拒绝时按返回的 items 逐条原因处理，不要反复重试。",
          "- [ ] 最后把地图链接与一句话结论回填到本票（评论或正文），并告诉用户本票要保留还是关闭；不要为了省一步把本票改造成地图票。",
          "",
        ],
        [
          "## This ticket",
          "- [ ] The new-issue form did not mark this as a map, so this is not a map ticket and its body is not a map skeleton; if its actual labels do carry wayfinder:map (for example the user typed it), confirm with the user instead of treating the six-section body as a map.",
          "- [ ] When drawing a map per the wayfinder rules, create the map with deck_issue_create (kind=map, repo=…); then attach this ticket under it with deck_map_link (key=<this ticket>, parentKey=<map>, repo=…). If this ticket still lacks its route-kind label, add wayfinder:<kind> with deck_issue_labels (read all current labels with deck_issue_get first). Use blockedBy for dependency edges. If it refuses, handle the per-item reasons in the reply instead of retrying.",
          "- [ ] Finally write the map link and a one-sentence conclusion back into this ticket (comment or body), and tell the user whether to keep or close it; do not turn this ticket into the map just to save a step.",
          "",
        ],
      ),
      ...investigate(lang),
      ...pick(
        lang,
        [
          "## 收尾",
          "- [ ] 结束时：建了地图就给链接；判断不需要地图就说明原因；用户没决定前默认保留本票，不要擅自关闭。",
          "",
        ],
        [
          "## Wrap-up",
          "- [ ] Finish by giving the map link if a map was created; explain why no map is needed if you decided so; keep this ticket open by default until the user decides, and never close it unilaterally.",
          "",
        ],
      ),
      ...requirementTools(lang),
    ].join("\n");
  }
  return [
    ...ticketHead(
      input,
      lang,
      "/grill-with-docs",
      pick(lang, "请帮我讨论这张需求票（严格遵循 grill-with-docs 技能规则）。", "Please discuss this requirement ticket (strictly follow the grill-with-docs skill rules)."),
    ),
    ...investigate(lang),
    ...pick(
      lang,
      [
        "## 讨论收尾（先由你把结论写回本票；下面两个动作由用户手动执行）",
        "- [ ] 讨论结论写回本票正文或评论，不要只留在会话里。",
        "- [ ] 讨论结束、结论对齐后，提醒用户手动执行一次 /to-spec，把结论生成规格 issue。",
        "- [ ] 在规格 issue 生成后，再提醒用户手动执行一次 /to-tickets，把规格 issue 拆成实施 issue。",
        "",
      ],
      [
        "## Discussion wrap-up (write the conclusion back first; the user runs the two actions below manually)",
        "- [ ] Write the discussion conclusion back into this ticket body or a comment; do not leave it only in the session.",
        "- [ ] Once the discussion is settled and the conclusion is aligned, remind the user to manually run /to-spec once to turn the conclusion into a spec issue.",
        "- [ ] After the spec issue is created, remind the user to manually run /to-tickets once to split the spec issue into implementation issues.",
        "",
      ],
    ),
    ...requirementTools(lang),
  ].join("\n");
}

/** 缺陷票的技能提示词：查重放在「这张票已经建好」之后，命中时按重复 / 回归处理。 */
export function buildBugPrompt(input: BugPromptInput): string {
  const lang = input.lang ?? "en";
  const actualLabels = (input.labels ?? []).filter((label) => label.trim());
  const expectedLabels = (input.expectedLabels ?? []).filter((label) => label.trim());
  const targetText = expectedLabels.length
    ? expectedLabels.join(lang === "zh" ? "、" : ", ")
    : pick(lang, "bug（再按诊断 / 缺项补 needs-triage 或 needs-info）", "bug (plus needs-triage or needs-info as appropriate)");
  const labelLines = input.labelsFailed
    ? pick(
        lang,
        [
          `- [ ] 建票时标签没挂上。目标标签：${targetText}。`,
          `- [ ] 先调 deck_issue_get（number=<本票号>、repo=${input.repoKey}）读当前标签；labelsTruncated=true 时不要调 deck_issue_labels。`,
          "- [ ] labelsTruncated=true 表示标签读不全：不要声称标签已修好；让用户去远端补目标标签（GitHub 可先 gh label create），补完重新 deck_issue_get 再继续。",
          "- [ ] 只补目标集合里缺的标签，用 deck_issue_labels（number=<本票号>、labels=[完整标签集]、repo=…）；它整体替换，labels 必须带上读到的现有标签。",
          "- [ ] GitHub 后端缺某个目标标签时，deck_issue_labels 不会创建它：不要反复重试，告诉用户先创建该标签（gh label create），再回来补；本地 .deck 后端可以直接写入。",
          "",
        ],
        [
          `- [ ] Labels failed at creation. Target labels: ${targetText}.`,
          `- [ ] First call deck_issue_get (number=<this ticket>, repo=${input.repoKey}) to read the current labels; do not call deck_issue_labels when labelsTruncated=true.`,
          "- [ ] labelsTruncated=true means the labels cannot be read in full: do not claim they are fixed; ask the user to add the target labels on the remote (gh label create first on GitHub), then re-read with deck_issue_get before continuing.",
          "- [ ] Add only the missing target labels with deck_issue_labels (number=<this ticket>, labels=[complete set], repo=…); it replaces the full set, so include the existing labels you read.",
          "- [ ] On the GitHub backend, deck_issue_labels does not create labels that are missing in the repository: do not retry, ask the user to create the label first (gh label create), then add it; the local .deck backend can write new labels directly.",
          "",
        ],
      )
    : pick(
        lang,
        [
          `- [ ] 当前标签：${actualLabels.length ? actualLabels.join("、") : "（接口没返回标签，先调 deck_issue_get 核对）"}；目标标签：${targetText}。以票面实际标签为准。`,
          "",
        ],
        [
          `- [ ] Current labels: ${actualLabels.length ? actualLabels.join(", ") : "(not returned; call deck_issue_get to verify)"}; target labels: ${targetText}. Treat the ticket's actual labels as the source of truth.`,
          "",
        ],
      );
  return [
    ...ticketHead(
      input,
      lang,
      "/wayfinder",
      pick(lang, "请帮我处理这张 BUG 单（按 wayfinder 技能规则处理）。", "Please handle this BUG ticket (follow the wayfinder skill rules)."),
    ),
    ...labelLines,
    ...pick(
      lang,
      [
        "## 澄清",
        "- [ ] 有假设先用 grilling 澄清，不默认；已给的不重问；缺项按 needs-info 处理（以票面实际标签为准）。",
        "",
      ],
      [
        "## Clarify",
        "- [ ] If you hold assumptions, settle them with the grilling skill — never assume; never re-ask what is given; missing fields are treated as needs-info (following the ticket's actual labels).",
        "",
      ],
    ),
    ...investigate(lang),
    ...pick(
      lang,
      [
        "## 查重",
        `- [ ] 收齐「实际」后，扫一遍工具能看见的 BUG 单：先调 deck_issue_list（state=open、limit=100、repo=${input.repoKey}）取回列表，再调一次（state=closed、limit=100、repo=${input.repoKey}）。`,
        "- [ ] 这个工具没有标签筛选：对返回的每张票看 labels 里有没有 bug，别把 PR 或非 bug 票算进去。",
        "- [ ] 也没有翻页：返回 hasMore=true 或 totalCount 大于本次条数时，说明只扫到前 100 张（地图优先）；把「扫描可能不全」写进查重记录。",
        "- [ ] 列表先放地图票，再按状态，最后按更新时间；前 100 条不保证覆盖最新非地图票。没有更新时间字段，不要声称看过更新时间。",
        `- [ ] 标题像的再调 deck_issue_get（number=<候选号>、repo=${input.repoKey}）看正文；工具回执说清单可能不全时，把这句记下来。`,
        "- [ ] 有命中时不要自己先下结论：把最多 3 张候选（仓库 + 编号、标题、像在哪里）列给报告人，问一句「这些是不是同一个问题」，等到回答再决定。",
        "- [ ] 报告人确认是同一问题、旧单还开着：用 deck_issue_comment 在旧单下评论补充这次的现象和复现步骤；用 deck_issue_patch（close=true）关闭本票；只有本票或旧单实际已经带 duplicate 标签时才用 deck_issue_labels 加上，没看到就不要加，也不要为了标重复去创建标签或另建新单。",
        "- [ ] 报告人确认是同一问题、旧单已关闭：按回归处理，先 deck_issue_get 读本票正文，再用 deck_issue_patch 传完整正文，在正文里写明「回归：原单 #编号」并写上旧单 URL；关联就是评论或正文里的 URL / #编号，不要用 deck_map_link 关联 BUG 单，本票保留。",
        "- [ ] 报告人确认不是，或没有命中：保留本票，在「查重记录」里写明看过的候选和报告人的回答。",
        "- [ ] 报告人不确定：把旧单链接发给报告人再看一眼；仍不能判断时保留本票，在评论或正文里写下候选 URL / #编号（同样不要用 deck_map_link），并给本票补 needs-info。",
        "",
        "## 查重记录",
        "- [ ] 本票正文固定有一节「## 查重记录」，按实际查重过程填，不要编造；写正文时先 deck_issue_get 读原文，再用 deck_issue_patch 传完整正文，或直接写进评论。",
        "- [ ] 扫描：查了哪些状态与仓库、各拿到多少张、hasMore 是否为 true；工具说清单可能不全，就写在这里。",
        "- [ ] 命中：候选的仓库 + 编号与标题；没有就写「无」。",
        "- [ ] 报告人确认：报告人怎么回答的。",
        "- [ ] 结论：保留 / 重复并关闭 / 按回归保留。",
        "",
        "## 自查",
        "- [ ] 逐项核对无遗漏；查重记录已写进正文（或已在旧单评论）；结束前写明真实状态",
        "",
      ],
      [
        "## Check for duplicates",
        `- [ ] Once "Actual" is complete, scan the BUG tickets the tools can see: call deck_issue_list (state=open, limit=100, repo=${input.repoKey}) for the list, then call it again (state=closed, limit=100, repo=${input.repoKey}).`,
        "- [ ] The tool has no label filter: check each returned ticket's labels for bug; do not count pull requests or non-bug tickets.",
        "- [ ] It has no pagination either: when hasMore=true or totalCount is greater than the returned count, only the first 100 were scanned (map tickets first); record \"scan may be incomplete\" in the duplicate-check record.",
        "- [ ] The list puts map tickets first, then orders by state and finally by updated time; the first 100 do not necessarily cover the newest non-map tickets. There is no updated-time field, so do not claim you looked at updated times.",
        `- [ ] Open the body with deck_issue_get (number=<candidate>, repo=${input.repoKey}) only when a title looks similar. If the tool says the list may be incomplete, keep that sentence.`,
        "- [ ] When something looks similar, do not decide on your own: show the reporter up to 3 candidates (repo + number, title, why it looks similar) and ask \"are these the same problem\"; wait for the answer before deciding.",
        "- [ ] Same problem and the old ticket is still open: use deck_issue_comment to add this report's symptom and reproduction steps to the old ticket; close this ticket with deck_issue_patch (close=true); add a duplicate label with deck_issue_labels only if this ticket or the old one already carries one — if you did not see it, do not add it, never create it just to mark a duplicate, and do not file another ticket.",
        "- [ ] Same problem but the old ticket is closed: treat it as a regression. Read this ticket body with deck_issue_get first, then use deck_issue_patch with the complete body, writing \"Regression of #number\" and the old ticket URL into it. Linking means a URL / #number in a comment or the body; do not use deck_map_link for BUG links. Keep this ticket open.",
        "- [ ] Not the same, or nothing matched: keep this ticket and write the candidates you looked at and the reporter's answer into the duplicate-check record.",
        "- [ ] The reporter is unsure: send the old ticket link for a look; if it is still undecidable, keep this ticket, write the candidate URL / #number into a comment or the body (again without deck_map_link), and add needs-info to this ticket.",
        "",
        "## Duplicate check record",
        "- [ ] This ticket body always has a \"## Duplicate check record\" section; fill it from the actual check, never fabricate. Read the original body with deck_issue_get first, then use deck_issue_patch with the complete body, or write it into a comment.",
        "- [ ] Scanned: which states and repository, how many each returned, and whether hasMore was true; if the tool says the list may be incomplete, write that here.",
        "- [ ] Hits: candidate repo + number and titles; write \"none\" when nothing matched.",
        "- [ ] Reporter confirmed: what the reporter answered.",
        "- [ ] Conclusion: kept / duplicate and closed / kept as a regression.",
        "",
        "## Self-check",
        "- [ ] Check every box with no gaps; duplicate-check record written into the body (or already commented on the old ticket); true state written before finishing",
        "",
      ],
    ),
    ...requirementTools(lang),
  ].join("\n");
}
