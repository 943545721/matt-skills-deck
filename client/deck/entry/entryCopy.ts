import type { DeckLang } from "../../../shared/requirement.ts";
import type { EntryCardCopy } from "./entryCardSvg.ts";

/**
 * 「新建需求 / 探讨需求 / + bug」入口的界面文案；卡面文案源自 DSH，但已按两扇门的语义改写：
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
  discussRequirement: string;
  discussRequirementTitle: string;
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
    newRequirementTitle: "打开建票表单，类型预选「探索需求」；真的建出一张需求票",
    discussRequirement: "探讨需求",
    discussRequirementTitle: "开一个新会话谈需求：边谈边建地图，或只谈不建票",
    newBug: "+ bug",
    newBugTitle: "新会话中打开 /wayfinder 新增 BUG 单 prompt（继承当前工作区）",
    chooserTitle: "这次先谈，怎么谈？",
    close: "关闭",
    need: "需求",
    goalClear: "目标明确",
    explore: {
      brow: "边谈边建地图",
      state: "会产出地图和路线票",
      body: "跑 /wayfinder：边谈边把地图和路线票建出来。目标大而模糊时走这条。",
      need: "需求",
      goalClear: "目标明确",
    },
    impl: {
      brow: "只谈",
      state: "暂不建票",
      body: "跑 /grill-with-docs：谈完你自己跑 /to-spec、/to-tickets。目标已经清晰时走这条。",
      need: "需求",
      goalClear: "目标明确",
    },
    sessionTitle: { requirement: "[New] 探讨需求", spec: "[New] 只谈需求", bug: "[New] 新建 Bug" },
  },
  en: {
    newRequirement: "New Requirement",
    newRequirementTitle: "Opens the ticket form with Explore requirement preselected; creates a real requirement ticket",
    discussRequirement: "Discuss Requirement",
    discussRequirementTitle: "Open a new session to talk it through: build a map as you talk, or talk only",
    newBug: "+ BUG",
    newBugTitle: "Open a /wayfinder new-BUG prompt in a new session (same workspace)",
    chooserTitle: "How do you want to talk this through?",
    close: "Close",
    need: "Need",
    goalClear: "Goal clear",
    explore: {
      brow: "Talk and build a map",
      state: "Produces a map and route tickets",
      body: "Runs /wayfinder: talk and build the map and route tickets as you go. Use it while the goal is still fuzzy.",
      need: "Need",
      goalClear: "Goal clear",
    },
    impl: {
      brow: "Talk only",
      state: "No tickets yet",
      body: "Runs /grill-with-docs: afterwards you run /to-spec and /to-tickets yourself. Use it when the goal is clear.",
      need: "Need",
      goalClear: "Goal clear",
    },
    sessionTitle: { requirement: "[New] Discuss Requirement", spec: "[New] Talk Only", bug: "[New] New Bug" },
  },
};

export function entryCopy(lang: DeckLang): EntryCopy {
  return COPY[lang] ?? COPY.zh;
}
