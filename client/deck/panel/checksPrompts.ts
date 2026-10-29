import { STANDARD_LABELS } from "../../../shared/labels.ts";

/**
 * 检查页全部「注入指引」的原话。
 *
 * 逐字取自 DSH 的提示词真源，不在这里改写：
 * - cliInstall / ghAuthLogin：DSH GitHub 房间的 prompts（src/tracker/rooms/github/index.ts）。
 * - setupRun：DSH 模板 config/prompts/workspace-initialization.yaml 的 v15 原文，
 *   占位符由后端声明的 setup.* 词表键填（src/client/kernel/locale-data.ts）；
 *   各后端的取值逐字复制在下面，与 DSH 一样是「键 → 双语值」。
 * - installSkills：DSH 模板 config/prompts/repository-alignment.yaml 的 v6 原文，
 *   只把安装目标目录从「~/.agents/skills（DSH 读取目录）」改成本插件真实的
 *   「工作区 .claude/skills 与 .agents/skills」——这是宿主边界，不是改写。
 * - ensureLabels：DSH GitHub 房间的 prompts.ensureLabels，名单从 STANDARD_LABELS 现拼，
 *   与 DSH「名单唯一真源、零第二份字面量」同一口径；原稿里那条指向 DSH 源码路径的
 *   句子替换成本仓库的真实清单位置。
 * - glabAuthLogin：DSH GitLab 房间的 prompts.glabLoginFix。
 */

export type CheckGuidePrompt =
  | "cliInstall"
  | "ghAuthLogin"
  | "glabAuthLogin"
  | "installSkills"
  | "setupRun"
  | "ensureLabels";

export type DeckLang = "en" | "zh";
export type BackendId = "github" | "gitlab" | "markdown";
export type SetupLayout = "single" | "multi";

const PROMPTS: Record<"cliInstall" | "ghAuthLogin" | "glabAuthLogin", { zh: string; en: string }> = {
  cliInstall: {
    zh: "/wizard 帮用户安装gh cli 官方地址：https://cli.github.com/",
    en: "/wizard help the user install the gh CLI — official page: https://cli.github.com/",
  },
  ghAuthLogin: {
    zh: "/wizard 辅助用户完成 gh 登录：运行 gh auth login 并按提示在浏览器完成授权；结束后运行 gh auth status 确认已登录。",
    en: "Please complete gh login: run gh auth login and finish browser authorization; afterwards run gh auth status to confirm.",
  },
  // DSH gitlab 房间 prompts.glabLoginFix（检查目录里的键名是 glabAuthLogin，同一段话）。
  glabAuthLogin: {
    zh: "请完成 glab 登录（glab auth login）：按向导选择 GitLab.com → HTTPS → 浏览器授权（OAuth）；完成后 glab auth status 验证；然后请用户点「重查」。",
    en: "Complete glab login: glab auth login → GitLab.com → HTTPS → browser OAuth; verify with glab auth status; then ask the user to re-check.",
  },
};

// ---------------------------------------------------------------------------
// setupRun：DSH v15 模板原文 + 后端声明的 setup.* 词表（逐字复制，不另写）
// ---------------------------------------------------------------------------

const SETUP_LOCALE = {
  zh: {
    "setup.default.backendNote": "\n\n本次未指定后端，已按默认 GitHub 初始化；可在设置页随时切换",
    "setup.default.labelReqs":
      "，并确保仓库中技能所需标签齐全（triage 五角色 + wayfinder 标签 wayfinder:map / research / prototype / grilling / task），不要只建少数几个",
    "setup.default.trackerChoice": "GitHub Issues",
    "setup.default.trackerLine": "本仓库为 GitHub → 提议 GitHub Issues",
    "setup.github.backendNote": "\n\n本次已选后端：GitHub。",
    "setup.github.labelReqs":
      "，并确保仓库中技能所需标签齐全（triage 五角色 + wayfinder 标签 wayfinder:map / research / prototype / grilling / task），不要只建少数几个",
    "setup.github.trackerChoice": "GitHub Issues",
    "setup.github.trackerLine": "本仓库为 GitHub → 提议 GitHub Issues",
    "setup.gitlab.backendNote": "\n\n本次已选后端：GitLab — 请按 GitLab 模板生成 docs/agents/issue-tracker.md",
    "setup.gitlab.labelReqs":
      "，并确保仓库中技能所需标签齐全（triage 五角色 + wayfinder 标签 wayfinder:map / research / prototype / grilling / task），不要只建少数几个",
    "setup.gitlab.trackerChoice": "GitLab Issues",
    "setup.gitlab.trackerLine": "本仓库为 GitLab → 提议 GitLab Issues",
    "setup.markdown.backendNote":
      "\n\n本次已选后端：Markdown — 生成 docs/agents/issue-tracker.md 时，把技能自带的本地模板（issue-tracker-local.md）逐字复制过去，模板里每一句做法说明都保持原样，不改写、不省略、不追加；仓库里票与规格的文件格式和位置，一律以这份模板为唯一依据。建票、认领、改状态这些动作仍然用 deck 工具执行，但它们写出来的文件要与模板完全一致。生成完读回这份文档，逐句核对与模板逐字相同。",
    "setup.markdown.labelReqs": "",
    "setup.markdown.trackerChoice": "Local markdown",
    "setup.markdown.trackerLine": "本仓库为本地文件 → 提议 Local markdown",
    "setup.layout.single":
      "本仓库的域文档布局已在初始化时与用户确认为 single-context（一个仓库共用一份根目录的 GLOSSARY.md，架构决定放 docs/adr/）：请把 single-context 这一句结论写进 docs/agents/domain.md，并让 AGENTS.md 的 ## Agent skills 块里 Domain docs 那一行也用这同一个词（技能要求的写法是「一行布局摘要 ＋ See docs/agents/domain.md」）；本次初始化不创建 GLOSSARY-MAP.md 与各子项目的 GLOSSARY.md，留到第一次真正写下词条时再建。如果这个仓库里已经有旧名的 CONTEXT.md 或 CONTEXT-MAP.md（新版技能只认 GLOSSARY.md 与 GLOSSARY-MAP.md），请把它们改名为 GLOSSARY.md 与 GLOSSARY-MAP.md，并把 docs/agents/domain.md 里写着旧名的地方一起改过来",
    "setup.layout.multi":
      "本仓库的域文档布局已在初始化时与用户确认为 multi-context（子项目各一份 GLOSSARY.md，根目录一份 GLOSSARY-MAP.md）：请把 multi-context 这一句结论写进 docs/agents/domain.md，并让 AGENTS.md 的 ## Agent skills 块里 Domain docs 那一行也用这同一个词（技能要求的写法是「一行布局摘要 ＋ See docs/agents/domain.md」）；本次初始化不创建 GLOSSARY-MAP.md 与各子项目的 GLOSSARY.md，留到第一次真正写下词条时再建，届时由仓库根目录的 GLOSSARY-MAP.md 指向它们。如果这个仓库里已经有旧名的 CONTEXT.md 或 CONTEXT-MAP.md（新版技能只认 GLOSSARY.md 与 GLOSSARY-MAP.md），请把它们改名为 GLOSSARY.md 与 GLOSSARY-MAP.md，并把 docs/agents/domain.md 里写着旧名的地方一起改过来",
  },
  en: {
    "setup.default.backendNote":
      "\n\nNo backend explicitly selected, defaulting to GitHub; you can switch anytime in Settings → Backend.",
    "setup.default.labelReqs":
      ", and ensure the repo has the complete label set the skills need (the five triage-role labels + the wayfinder labels wayfinder:map / research / prototype / grilling / task) — not just a few",
    "setup.default.trackerChoice": "GitHub Issues",
    "setup.default.trackerLine": "this repo is on GitHub → propose GitHub Issues",
    "setup.github.backendNote": "\n\nSelected backend: GitHub.",
    "setup.github.labelReqs":
      ", and ensure the repo has the complete label set the skills need (the five triage-role labels + the wayfinder labels wayfinder:map / research / prototype / grilling / task) — not just a few",
    "setup.github.trackerChoice": "GitHub Issues",
    "setup.github.trackerLine": "this repo is on GitHub → propose GitHub Issues",
    "setup.gitlab.backendNote": "\n\nSelected backend: GitLab — please generate docs/agents/issue-tracker.md from the GitLab template.",
    "setup.gitlab.labelReqs":
      ", and ensure the repo has the complete label set the skills need (the five triage-role labels + the wayfinder labels wayfinder:map / research / prototype / grilling / task) — not just a few",
    "setup.gitlab.trackerChoice": "GitLab Issues",
    "setup.gitlab.trackerLine": "this repo is on GitLab → propose GitLab Issues",
    "setup.markdown.backendNote":
      "\n\nSelected backend: Markdown — when generating docs/agents/issue-tracker.md, copy the skill's bundled local template (issue-tracker-local.md) verbatim: keep every sentence of its instructions as-is, no rewriting, no omission, no additions; the file format and location of tickets and specs in this repo follow that template as the single source of truth. Creating, claiming and transitioning tickets still go through the deck tools, but the files they write must match the template exactly. After generating, read the document back and verify sentence by sentence that it matches the template verbatim.",
    "setup.markdown.labelReqs": "",
    "setup.markdown.trackerChoice": "Local markdown",
    "setup.markdown.trackerLine": "this repo is local files → propose Local markdown",
    "setup.layout.single":
      "The domain-doc layout for this repo was confirmed with the user at setup time as single-context (one GLOSSARY.md at the repo root, with architecture decisions in docs/adr/): write that single-context conclusion into docs/agents/domain.md, and make the Domain docs line in the ## Agent skills block of AGENTS.md use that same word too (the skill’s required form is “a one-line layout summary + See docs/agents/domain.md”); this setup run creates neither GLOSSARY-MAP.md nor per-subproject GLOSSARY.md files — they wait until the first real glossary entry is written. If this repo still has the old CONTEXT.md or CONTEXT-MAP.md (the current skills only look for GLOSSARY.md and GLOSSARY-MAP.md), rename them to GLOSSARY.md and GLOSSARY-MAP.md and update the old names in docs/agents/domain.md too",
    "setup.layout.multi":
      "The domain-doc layout for this repo was confirmed with the user at setup time as multi-context (one GLOSSARY.md per subproject, plus a GLOSSARY-MAP.md at the repo root): write that multi-context conclusion into docs/agents/domain.md, and make the Domain docs line in the ## Agent skills block of AGENTS.md use that same word too (the skill’s required form is “a one-line layout summary + See docs/agents/domain.md”); this setup run creates neither GLOSSARY-MAP.md nor the per-subproject GLOSSARY.md files — they wait until the first real glossary entry is written, and the GLOSSARY-MAP.md at the repo root will then point at them. If this repo still has the old CONTEXT.md or CONTEXT-MAP.md (the current skills only look for GLOSSARY.md and GLOSSARY-MAP.md), rename them to GLOSSARY.md and GLOSSARY-MAP.md and update the old names in docs/agents/domain.md too",
  },
} as const;

/** DSH 的 SETUP_DEFAULT_PROMPT_KEYS：后端没声明 setupPrompt 时（不该发生）用的缺省键组。 */
const SETUP_KEY_PREFIX: Record<BackendId, "github" | "gitlab" | "markdown" | "default"> = {
  github: "github",
  gitlab: "gitlab",
  markdown: "markdown",
};

function setupValue(lang: DeckLang, key: string): string {
  const table = SETUP_LOCALE[lang] as Record<string, string>;
  return table[key] ?? "";
}

/**
 * DSH v15 setupRun 原文，占位符按当前后端与布局填充。
 * 后端为空（还没选）时按 DSH 的缺省键组填（setup.default.*，其 backendNote 如实说「按默认 GitHub」）。
 */
export function setupPromptOf(backend: BackendId | null, layout: SetupLayout, lang: DeckLang): string {
  const prefix = backend ? SETUP_KEY_PREFIX[backend] : "default";
  const trackerLine = setupValue(lang, `setup.${prefix}.trackerLine`);
  const trackerChoice = setupValue(lang, `setup.${prefix}.trackerChoice`);
  const backendNote = setupValue(lang, `setup.${prefix}.backendNote`);
  const labelReqs = setupValue(lang, `setup.${prefix}.labelReqs`);
  const contextLayout = setupValue(lang, `setup.layout.${layout}`);
  if (lang === "zh") {
    return `/setup-matt-pocock-skills

初始化本仓库配置（技能套件已安装；本命令仅记录 issue tracker / 标签词汇 / 文档路径，不安装、不克隆任何技能）：
1. 按技能流程选择 issue tracker：${trackerLine}，由用户确认；
2. 初始化时按 setup-matt-pocock-skills 技能自身流程执行（issue tracker 选择 ${trackerChoice}；triage 标签保留默认五角色）${labelReqs}；后续打标签严格遵循技能规则，不额外强制任何标签；
3. 完成后核对技能真实产物：docs/agents/issue-tracker.md + triage-labels.md + domain.md 及 AGENTS.md 的 ## Agent skills 块；再复查环境检查（setup 变绿）。${contextLayout}。${backendNote}`;
  }
  return `/setup-matt-pocock-skills

Bootstrap this repo configuration (the skill suite is already installed; this command only records the issue tracker / label vocabulary / doc paths — it does not install or clone any skills):
1. Follow the skill flow to pick the issue tracker: ${trackerLine}, confirm with the user;
2. During init, follow the setup-matt-pocock-skills skill own flow (choose ${trackerChoice} as the tracker; keep the default triage-role labels)${labelReqs}; when labelling issues, strictly follow the skill rules, with no extra mandatory labels;
3. Verify the actual outputs of the setup skill: docs/agents/issue-tracker.md + triage-labels.md + domain.md and the ## Agent skills block in AGENTS.md; then re-run the environment check (setup turns green). ${contextLayout}.${backendNote}`;
}

/**
 * DSH v6 installSkills 原文。{probeList}/{probeCount} 由调用处用 `deck.skills.list` 的实际清单填。
 * 与 DSH 唯一的差异：安装目标是本插件真实写入的「工作区 .claude/skills 与 .agents/skills」，
 * 不是 DSH 读取的 ~/.agents/skills。
 */
export function installSkillsPromptOf(names: readonly string[], lang: DeckLang): string {
  const probeList = names.join(" / ");
  const probeCount = String(names.length);
  if (lang === "zh") {
    return `请为本插件安装 Matt Pocock 的 skills 技能套件（mattpocock/skills）：

1. 先检查：确认当前工作区的 .claude/skills 下这 ${probeCount} 个技能已全部就位：${probeList}。已全部就位 → 直接汇报已装技能清单并结束，不要重复安装；
2. 有缺失则安装：优先用本插件面板上的「安装技能」按钮（插件自带的安装器，把技能写进工作区的 .claude/skills 与 .agents/skills，两个 agent 目录都覆盖）；若按钮不可用，回退：克隆 https://github.com/mattpocock/skills，把 skills/engineering 与 skills/productivity 目录下的全部技能复制到工作区的 .claude/skills 与 .agents/skills；
3. 安装目标是当前工作区的技能目录（.claude/skills 与 .agents/skills）—— 不要装进用户级目录（如 ~/.claude/skills），也不要装进与本工作区无关的其他目录；
4. 安装后复验：第 1 步的 ${probeCount} 个技能已全部就位；
5. 完成后汇报安装结果与已装技能清单（用第 1 步的完整清单，不要只列 10 项）。`;
  }
  return `Install the Matt Pocock skills collection (mattpocock/skills) for this plugin:

1. Check first: confirm these ${probeCount} skills are all present under the current workspace's .claude/skills: ${probeList}. If all are present, report the installed skill list and stop — do not reinstall;
2. If any are missing, install: prefer the "Install skills" button on this plugin's panel (the plugin's own installer writes the skills into the workspace's .claude/skills and .agents/skills, covering both agent directories); if the button is unavailable, fall back: clone https://github.com/mattpocock/skills and copy all skills from skills/engineering and skills/productivity into the workspace's .claude/skills and .agents/skills;
3. Install into the current workspace's skill directories (.claude/skills and .agents/skills) — not into user-level directories (e.g. ~/.claude/skills), and not into directories unrelated to this workspace;
4. After install, re-verify: all ${probeCount} skills from step 1 are in place;
5. When done, report the result and the installed skill list (use the full list from step 1, not just the first 10).`;
}

/**
 * DSH GitHub 房间 prompts.ensureLabels 原文，名单从 STANDARD_LABELS 现拼。
 * 唯一改动：DSH 原稿里的「色值/描述以 src/tracker/contract/canonical-labels.ts 为唯一清单」
 * 指向的是 DSH 源码路径；这里换成本仓库的真实清单位置 shared/labels.ts 的 STANDARD_LABELS。
 */
export function ensureLabelsPromptOf(lang: DeckLang): string {
  const names = STANDARD_LABELS.map((label) => label.name).join(", ");
  const total = String(STANDARD_LABELS.length);
  if (lang === "zh") {
    return `请为当前仓库补全缺失的核心标签（共 ${total} 个）：

必备标签：${names}

步骤：
- [ ] 先看现在有哪些标签：调 deck_context 拿当前后端与仓库，票上带了哪些标签用 deck_issue_get 读
- [ ] 缺哪个补哪个：调 deck_issue_patch 并把缺的标签名放进 addLabels —— 它按当前后端自己的方式打标签，已经有的不会重复建，成没成逐条回报
- [ ] 补完再调一次 deck_context 核对标签已齐

色值/描述以 shared/labels.ts 的 STANDARD_LABELS 为唯一清单，检查项逐字比对名字。

只读仓库补不上标签（建标签要 push，给票打标要 triage 及以上）：这时先 fork 到自己名下，再把工作区 origin 指向 fork；插件只认 origin，不代改配置。`;
  }
  return `Please complete the missing canonical labels (${total} total):

Required labels: ${names}

Steps:
- [ ] See what labels exist now: call deck_context for the current backend and repo; read which labels a ticket carries with deck_issue_get
- [ ] Add whatever is missing: call deck_issue_patch with the missing names in addLabels — it applies labels the way the current backend does, never creates duplicates, and reports each one
- [ ] Re-check with deck_context until the labels are complete

Colors/descriptions are single-sourced in shared/labels.ts (STANDARD_LABELS); the check compares names verbatim.

A read-only repo cannot take labels (creating labels needs push, labeling tickets needs triage or higher): fork it to your own account first, then point the workspace origin at the fork. The plugin only reads origin and never rewrites your config.`;
}

/** 一句话指引（cliInstall / ghAuthLogin / glabAuthLogin 三条不带占位符的原话）。 */
export function checkGuidePromptOf(
  id: "cliInstall" | "ghAuthLogin" | "glabAuthLogin",
  lang: DeckLang,
): string {
  return PROMPTS[id][lang];
}
