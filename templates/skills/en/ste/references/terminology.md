# Terminology and fixed translations

This file defines every keyword used by ste-zh. When the skill is active, translate and choose words as this table says. For words not in the table, fix your own choice in the output's 术语 section, per R1.

## 1. Chinese renderings of ASD-STE100 keywords

When discussing ASD-STE100 itself, or explaining where a rule comes from, use these renderings. At first use write 「中文（English）」; after that write Chinese only.

### 1.1 Standard and organisations

| English | Chinese | Note |
|---|---|---|
| ASD-STE100 | ASD-STE100 | Standard number; do not translate. |
| Simplified Technical English (STE) | 简化技术英语 | Leave the abbreviation STE untranslated. |
| Simplified Technical Chinese | 简化技术中文 | This skill's name for its Chinese adaptation. Not an official name. |
| ASD (AeroSpace, Security and Defence Industries Association of Europe) | 欧洲航空航天、安全与防务工业协会 | Usually write ASD only. |
| STEMG (STE Maintenance Group) | STE 维护组 | |
| Issue | 版 | Example: Issue 9 is written 「第 9 版」. |
| Standard for Technical Documentation | 技术文档标准 | Subtitle from Issue 9 onward. |
| specification | 规范 | How the document described itself before Issue 9. |
| standard | 标准 | How the document describes itself from Issue 9 onward. |

### 1.2 Parts of the standard

| English | Chinese | Note |
|---|---|---|
| writing rules | 写作规则 | |
| dictionary | 词典 | |
| approved word | 核准词 | A word the dictionary allows. |
| unapproved word / not approved | 非核准词 | A word the dictionary disallows; the dictionary gives a replacement. |
| alternative | 替代词 | |
| part of speech | 词性 | |
| approved meaning | 核准词义 | One approved word has exactly one approved meaning. |
| technical noun | 技术名词 | Replaces technical name from Issue 9 onward. |
| technical name | 技术名称 | The term used in Issue 8 and earlier. |
| technical verb | 技术动词 | |
| subject field | 学科领域 | |
| company-specific / project-specific | 公司专用 / 项目专用 | Words a company or project adds itself. |

### 1.3 Concepts in the rules

| English | Chinese | Note |
|---|---|---|
| noun cluster | 名词串 | |
| procedure / procedural writing | 步骤 / 步骤性写作 | Not translated as 「程序」, to avoid confusion with a software program. |
| descriptive writing | 描述性写作 | |
| instruction | 指令 | One action the reader must perform. |
| sentence | 句 | |
| paragraph | 段 | |
| topic | 主题 | |
| active voice | 主动语态 | |
| passive voice | 被动语态 | |
| imperative (command form) | 祈使句 | |
| simple tense | 简单时态 | Chinese has no matching grammar; used only when explaining the English rules. |
| vertical list | 竖排列表 | |
| word count | 字数 | The Chinese counting method is in R7 of SKILL.md. |
| safety instruction | 安全说明 | |
| warning | 警告 | Risk of personal injury. |
| caution | 注意 | Risk of damage to equipment or data. |
| note | 说明 | Not written as 「注释」, to avoid confusion with code comments. |
| consistency | 一致性 | |
| ambiguity | 歧义 | |

## 2. Modality words

Use only these three modality words in the whole text.

| Word | Meaning | Synonyms you must not use |
|---|---|---|
| 必须 | mandatory requirement | 应、应当、应该、需要、务必、要 |
| 不得 | prohibition | 不应、不要、避免、禁止、切勿、不允许 |
| 可以 | permitted, not required | 可、能够、允许、可选 |

This table limits modality only. Modality here means expressing a requirement, a prohibition or a permission. The following uses are outside this table:

- 「需要」 meaning that something is missing or depended on. Example: 「读者需要的证据」.
- The fixed template word 「要做」. See section 5.

Exception: when quoting a source, keep the source's wording and mark it with quotation marks.

## 3. Empty-verb replacements

The patterns below wrap an action in a noun. Replace them with the direct verb.

| Do not use | Rewrite as |
|---|---|
| 对 X 进行修改 / 处理 / 检查 | 修改 / 处理 / 检查 X |
| 实现 X 功能 | 增加 X; or state X's concrete behaviour |
| 予以 X / 加以 X | X |
| 做好 X 工作 | X |
| 完成 X 的操作 | X |
| 将会 X | 会 X |
| 进行 X | X |
| 作出 X 决定 | 决定 X |
| 通过 X 的方式 | 用 X |
| 存在 X 问题 | State the concrete symptom |
| 有一定的 X | State the concrete amount; delete when there is no amount |

「处理」 is itself an empty verb. When you can name the concrete action, do not write 「处理」.

## 4. Status words

When writing work status, use only these words, with only the meanings in the table.

| Status word | Meaning | Do not replace with |
|---|---|---|
| 已完成 | Every action in the stated scope has run, and no known result contradicts completion of that scope. Does not imply verified. | 搞定、OK、done、基本完成 |
| 部分完成 | Only part of the stated scope is done. List what was not run and what failed. | 基本完成、大致完成 |
| 未开始 | No action has run. | 待办、TODO |
| 进行中 | The action has started and has not finished. | 处理中、跟进中 |
| 已验证 | The check for the stated scope ran and passed. State the method, result and scope. | 已测试、应该没问题 |
| 未验证 | The stated check is known not to have run. State the reason. | 理论上可行、应该可以 |
| 失败 | The action or check ran and the result does not meet the requirement. Quote the key failure output. | 有点问题、不太行 |
| 跳过 | Deliberately not run. State the reason. | 略过、忽略 |
| 阻塞 | A missing condition prevents progress. State the missing condition. | 卡住、受阻 |
| 未确认 | The fact lacks enough evidence, including whether a check ran or what it returned. State how to confirm it. | 可能、大概、应该是 |

This section is the authority for status words and completion conditions. A status must name a definite work or check scope.

- State work status and verification status separately. 「已完成」 alone never means 「已验证」.
- Acceptance conditions come from the user's request, the applicable project requirements and the task goal. When a required check did not run or failed, do not claim the whole task is complete. When only part is done, write 「部分完成」 and list what is missing.
- When code changes are done but the runtime check has not run, you may write 「已完成：代码修改。运行效果未验证。」 That covers the code change only, not the whole task.
- When a known failure exists for the same object, do not cover it with 「已完成，未验证」. State the failure and its effect on the completed scope.
- When the source has no check record, write 「未确认」 with a way to confirm. Write 「未验证」 only when the check is known not to have run.

## 5. Fixed template wording

| Word | Use | Do not replace with |
|---|---|---|
| 术语 | Section that defines specialised words | 名词解释、词汇表、定义 |
| 共同条件 | Facts or constraints that apply to every item | 前提、背景、通用约束 |
| 问题 | The current situation of one item of work | 现状、缺陷描述、痛点 |
| 要做 | The verifiable outcome one item of work must reach | 方案、措施、修复内容、TODO |
| 改动 | Files or configuration the agent changed | 变更内容、修改点、diff |
| 验证 | Checks and their results | 测试情况、自测 |
| 未做 | Work in scope that was not done | 遗留、后续、TODO |
| 现象 | The behaviour the user observed | 表现、症状 |
| 原因 | The direct source of the symptom | 根因分析、问题所在 |
| 证据 | The source location that supports a fact | 依据、出处 |
| 建议 | The next action the agent recommends | 方案、解决思路 |
| 待确认 | Items for the user to decide, or content the source lacks | 风险、TBD、遗留问题 |
| 推荐 | The option the agent recommends in a list | 建议选择、首选 |

## 6. Punctuation and mixed text

- Chinese prose uses full-width punctuation: 「，。；：（）」.
- Quote interface text or emphasise a word with corner brackets 「」.
- Put code, commands, paths and identifiers in backticks and keep their contents half-width.
- Put one half-width space between Chinese and an English word or a number. Put no space between Chinese and full-width punctuation.
