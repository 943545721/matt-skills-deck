import type { PanelKey } from "../../panel/panelText.tsx";

/**
 * 编排页的左栏导航（纯数据）。
 *
 * 原来十个页签横着排一行：宽度一窄就折成两行，读起来像十个并列的操作，
 * 看不出「哪些是干活的、哪些是配置的」。这里按人要做的事分三段：
 *
 * - 干活：群、派单台、收件箱——每天点的是这三页；
 * - 配置：岗位、角色、客户端、档案、路由——改一次放很久；
 * - 历史：会话树、已归档——只在查账时打开。
 *
 * 分在 `nav.ts` 而不是组件里，是为了能单测「每一页都恰好出现一次」：
 * 少放一页，那一页就成了看不见的页面（同 2026-11-04 那次面板整个不出现）。
 */

export type OrchestrationSection =
  | "group"
  | "dispatch"
  | "inbox"
  | "staff"
  | "roles"
  | "clients"
  | "profiles"
  | "routing"
  | "tree"
  | "archived";

export interface NavItem {
  key: OrchestrationSection;
  label: PanelKey;
}

export interface NavGroup {
  key: "work" | "config" | "history";
  label: PanelKey;
  items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: "work",
    label: "orch.nav.work",
    items: [
      { key: "group", label: "orch.section.group" },
      { key: "dispatch", label: "orch.section.dispatch" },
      { key: "inbox", label: "orch.section.inbox" },
    ],
  },
  {
    key: "config",
    label: "orch.nav.config",
    items: [
      { key: "staff", label: "orch.section.staff" },
      { key: "roles", label: "orch.section.roles" },
      { key: "clients", label: "orch.section.clients" },
      { key: "profiles", label: "orch.section.profiles" },
      { key: "routing", label: "orch.section.routing" },
    ],
  },
  {
    key: "history",
    label: "orch.nav.history",
    items: [
      { key: "tree", label: "orch.section.tree" },
      { key: "archived", label: "orch.section.archived" },
    ],
  },
];

/** 打开编排页落在哪一页：群里派活是日常入口，配置不是。 */
export const DEFAULT_SECTION: OrchestrationSection = "group";

/** 导航里所有页签，按显示顺序摊平。 */
export function allNavItems(): NavItem[] {
  return NAV_GROUPS.flatMap((group) => [...group.items]);
}

/** 当前页签在导航里的标签：顶栏标题与高亮共用一份，不各写一遍。 */
export function sectionLabel(section: OrchestrationSection): PanelKey {
  const found = allNavItems().find((item) => item.key === section);
  // 类型上不可能找不到；真找不到时退成「群」，而不是让整页崩在一个标签上。
  return found ? found.label : "orch.section.group";
}
