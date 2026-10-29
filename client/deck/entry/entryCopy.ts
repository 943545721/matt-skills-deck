import type { DeckLang } from "../../../shared/requirement.ts";
import type { EntryCardCopy } from "./entryCardSvg.ts";

/**
 * 「新建需求 / + bug」入口的全部界面文案，逐字照抄 DSH：
 * - 面板按钮 `panel.newWayfinder` / `panel.newBug`（config/copy/panel.yaml）；
 * - 入口浮层标题与卡面（config/copy/cards.yaml 的 card.entry.*）；
 * - 新会话占位标题（src/shared/naming-titles.ts 的 PLACEHOLDER_TITLES）。
 *
 * 卡片里的 `need` 与 `goalClear` 两张卡共用一份（DSH 的 card.entry.need /
 * card.entry.chain.goalClear 只有一套词条），所以这里填进每张卡的副本里。
 */
export interface EntryCopy {
  newRequirement: string;
  newRequirementTitle: string;
  newBug: string;
  newBugTitle: string;
  chooserTitle: string;
  close: string;
  need: string;
  goalClear: string;
  explore: EntryCardCopy;
  impl: EntryCardCopy;
  sessionTitle: { requirement: string; spec: string; bug: string };
}

const COPY: Record<DeckLang, EntryCopy> = {
  zh: {
    newRequirement: "新建需求",
    newRequirementTitle: "点一下弹出两张卡：探索地图或实施地图，由你自己选",
    newBug: "+ bug",
    newBugTitle: "新会话中打开 /wayfinder 新增 BUG 单 prompt（继承当前工作区）",
    chooserTitle: "这条需求，你现在能说清要做什么吗？",
    close: "关闭",
    need: "需求",
    goalClear: "目标明确",
    explore: {
      brow: "探索地图",
      state: "目标大而模糊",
      body: "想清楚了要做什么，没想清楚细节，也没想清楚做到什么程度。",
      need: "需求",
      goalClear: "目标明确",
    },
    impl: {
      brow: "实施地图",
      state: "目标明确清晰",
      body: "要做什么、细节和做到什么程度都想清楚了，还没写成规格。",
      need: "需求",
      goalClear: "目标明确",
    },
    sessionTitle: { requirement: "[New] 新建需求", spec: "[New] 实施地图", bug: "[New] 新建 Bug" },
  },
  en: {
    newRequirement: "New Requirement",
    newRequirementTitle: "Opens two cards: Explore map or Implementation map - you pick which route",
    newBug: "+ BUG",
    newBugTitle: "Open a /wayfinder new-BUG prompt in a new session (same workspace)",
    chooserTitle: "Can you say clearly what you want to build right now?",
    close: "Close",
    need: "Need",
    goalClear: "Goal clear",
    explore: {
      brow: "Explore map",
      state: "Big, fuzzy goal",
      body: "You know what to build, not the details or the scope.",
      need: "Need",
      goalClear: "Goal clear",
    },
    impl: {
      brow: "Implementation map",
      state: "Goal is clear",
      body: "What, details and scope are clear; only the spec is not written.",
      need: "Need",
      goalClear: "Goal clear",
    },
    sessionTitle: { requirement: "[New] New Requirement", spec: "[New] Impl map", bug: "[New] New Bug" },
  },
};

export function entryCopy(lang: DeckLang): EntryCopy {
  return COPY[lang] ?? COPY.zh;
}
