import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_SECTION,
  NAV_GROUPS,
  allNavItems,
  sectionLabel,
} from "../client/deck/surfaces/orchestration/nav.ts";

/**
 * 左栏导航是「每页唯一的入口」：少写一页，那一页就成了看不见的页面；
 * 写重一页，点进去的高亮会对不上。这两件事都不会报错，所以钉成测试。
 */

const EXPECTED = [
  "group",
  "dispatch",
  "inbox",
  "staff",
  "roles",
  "clients",
  "profiles",
  "routing",
  "tree",
  "archived",
];

test("导航里每一页恰好出现一次，一页不多一页不少", () => {
  const keys = allNavItems().map((item) => item.key);
  assert.deepEqual([...keys].sort(), [...EXPECTED].sort());
  assert.equal(new Set(keys).size, keys.length, `导航里有重复的页签：${keys.join("、")}`);
});

test("分组顺序是「干活 → 配置 → 历史」，干活三页排在最前", () => {
  assert.deepEqual(
    NAV_GROUPS.map((group) => group.key),
    ["work", "config", "history"],
  );
  assert.deepEqual(
    NAV_GROUPS[0].items.map((item) => item.key),
    ["group", "dispatch", "inbox"],
  );
});

test("打开编排页落在群里，而不是落在某个配置页", () => {
  assert.equal(DEFAULT_SECTION, "group");
  assert.equal(sectionLabel(DEFAULT_SECTION), "orch.section.group");
  // 顶栏标题与左栏高亮共用这份标签：每一页都要能查到自己的那一行。
  for (const item of allNavItems()) {
    assert.equal(sectionLabel(item.key), item.label);
  }
});

test("导航上的每个文案键在中英文里都存在", () => {
  const source = readFileSync(new URL("../client/deck/panel/panelText.tsx", import.meta.url), "utf8");
  const keys = [...NAV_GROUPS.map((group) => group.label), ...allNavItems().map((item) => item.label)];
  for (const key of keys) {
    const hits = source.split(`"${key}":`).length - 1;
    assert.equal(hits, 2, `文案键 ${key} 应中英文各一条，实际 ${hits} 条`);
  }
});
