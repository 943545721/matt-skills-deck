import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_STAFF_PATHS } from "../shared/staff.ts";
import {
  WHOLE_TERRITORY,
  canSaveStaffDraft,
  isTerritoryMissing,
  isWholeTerritory,
  staffCardFromDraft,
  staffDraftForNew,
  staffDraftFromCard,
  staffDraftProblem,
  territoryBannerText,
  territoryLines,
  territoryPathsOf,
  territorySummary,
  territoryText,
} from "../client/deck/surfaces/orchestration/staff-draft.ts";

/**
 * 岗位表单的草稿映射与保存闸。
 *
 * 领地必填之后，这里错一次不会报错：要么把「没配」悄悄存成「整片」，
 * 要么让人填了一半点不动保存按钮。用例只钉外部行为——给定卡或草稿，
 * 得到什么卡、能不能保存、缺的是哪一项。
 */

const card = (overrides = {}) => ({ id: "frontend", name: "前端", ...overrides });

test("整片判定：只有 ['.'] 算整片，空和普通路径都不算", () => {
  assert.equal(isWholeTerritory(["."]), true);
  assert.equal(isWholeTerritory([".", "."]), true);

  assert.equal(isWholeTerritory([]), false, "空 = 没配，不是整片");
  assert.equal(isWholeTerritory(undefined), false);
  assert.equal(isWholeTerritory(["src/web"]), false);
  assert.equal(isWholeTerritory(["", "  "]), false);
  assert.equal(isWholeTerritory([".", "src/web"]), false, "点号混着具体路径不是一个合法状态");
});

test("路径解析：去 ./ 与前导 /、去重、封顶，点号不算一行路径", () => {
  assert.deepEqual(territoryPathsOf("src/web\n./server/\n/src/web"), ["src/web", "server"]);
  assert.deepEqual(territoryPathsOf("  \n."), [], "点号只由开关表达，手敲的点不算路径");
  assert.equal(territoryPathsOf(Array.from({ length: MAX_STAFF_PATHS + 5 }, (_, i) => `p${i}`).join("\n")).length, MAX_STAFF_PATHS);
});

test("卡 → 草稿：整片卡打开开关，并且不把点号带进输入框", () => {
  const draft = staffDraftFromCard(card({ paths: ["."] }));
  assert.equal(draft.wholeTerritory, true);
  assert.equal(draft.pathsText, "", "界面上不能露出点号");
});

test("卡 → 草稿：老卡的空领地保持空，默认关开关且保存被挡", () => {
  const draft = staffDraftFromCard(card({ name: "老卡" }));
  assert.equal(draft.wholeTerritory, false);
  assert.equal(draft.pathsText, "");
  assert.equal(staffDraftProblem(draft), "territory");
  assert.equal(canSaveStaffDraft(draft), false);
});

test("名册摘要：整片、具体目录、没配三种状态分开说", () => {
  assert.deepEqual(territorySummary(["."]), { whole: true, paths: [] });
  assert.deepEqual(territorySummary(["src/web", "server"]), { whole: false, paths: ["src/web", "server"] });
  assert.deepEqual(territorySummary([]), { whole: false, paths: [] });
  assert.deepEqual(territorySummary(undefined), { whole: false, paths: [] });
});

test("卡 → 草稿：具体目录原样成行；混入的点号被滤掉", () => {
  assert.equal(staffDraftFromCard(card({ paths: ["src/web", "server"] })).pathsText, "src/web\nserver");
  const mixed = staffDraftFromCard(card({ paths: [".", "src/web"] }));
  assert.equal(mixed.wholeTerritory, false);
  assert.equal(mixed.pathsText, "src/web");
});

test("草稿 → 卡：整片写 [' . ']，没填就不留 paths 字段", () => {
  const whole = staffCardFromDraft({ ...staffDraftFromCard(card({ paths: ["."] })), name: "前端" });
  assert.deepEqual(whole.paths, ["."]);
  assert.equal(whole.id, "frontend");

  const blank = staffCardFromDraft({ ...staffDraftForNew([]), name: "前端" });
  assert.equal("paths" in blank, false, "没填领地不写空数组：那是另一份数据");
  assert.equal(blank.kind, "worker");
  assert.equal(blank.maxConcurrent, 1);
});

test("草稿 → 卡：关掉整片后手敲的点号不会被偷偷存成整片", () => {
  const draft = { ...staffDraftForNew([]), name: "前端", pathsText: "." };
  assert.equal(canSaveStaffDraft(draft), false);
  assert.equal(staffDraftProblem(draft), "territory");
  assert.equal("paths" in staffCardFromDraft(draft), false);
});

test("草稿 → 卡：具体路径归一、去重，整片开关优先于输入框里的残留", () => {
  const draft = {
    ...staffDraftFromCard(card()),
    name: "前端",
    pathsText: "src/web\n./src/web/\nserver",
  };
  assert.deepEqual(staffCardFromDraft(draft).paths, ["src/web", "server"]);

  const whole = { ...draft, wholeTerritory: true, pathsText: "src/web" };
  assert.deepEqual(staffCardFromDraft(whole).paths, ["."], "开关打开时忽略输入框内容");
});

test("能否保存：名字与领地各缺一次都说得出缺哪项", () => {
  const base = { ...staffDraftForNew([]) };
  assert.equal(staffDraftProblem(base), "name", "名字优先报");
  assert.equal(isTerritoryMissing(base), true, "名字没填时，领地提示也不能消失");

  assert.equal(staffDraftProblem({ ...base, name: "前端" }), "territory");
  assert.equal(isTerritoryMissing({ ...base, name: "前端", wholeTerritory: true }), false);
  assert.equal(
    staffDraftProblem({ ...base, name: "前端", pathsText: "  \n." }),
    "territory",
    "只有空白/点号等于没填",
  );

  assert.equal(canSaveStaffDraft({ ...base, name: "前端", pathsText: "src/web" }), true);
  assert.equal(canSaveStaffDraft({ ...base, name: "前端", wholeTerritory: true }), true);
  assert.equal(WHOLE_TERRITORY, ".");
});

test("映射不改入参：卡与草稿都原样留着", () => {
  const source = card({ paths: ["src/web"], duty: "改界面" });
  const draft = staffDraftFromCard(source);
  draft.pathsText = "changed";
  draft.name = "changed";
  assert.deepEqual(source.paths, ["src/web"]);
  assert.equal(source.name, "前端");

  const frozen = Object.freeze({ ...staffDraftFromCard(card()), name: "前端", pathsText: "src/web" });
  const built = staffCardFromDraft(frozen);
  assert.deepEqual(built.paths, ["src/web"]);
  assert.equal(frozen.pathsText, "src/web");
});

test("缺领地横幅：只列 shared 判为缺的卡，整片与具体路径都不算", () => {
  const t = (key, vars) => `${key}|${vars.n}|${vars.names}`;
  const banner = territoryBannerText(
    [
      card({ id: "frontend", name: "前端", paths: ["src/web"] }),
      card({ id: "backend", name: "后端", paths: [] }),
      card({ id: "ops", name: "运维", paths: ["."] }),
      card({ id: "qa", name: "测试", paths: ["  "] }),
      card({ id: "docs", name: "文档" }),
    ],
    t,
  );
  assert.equal(banner, "orch.staffTerritoryBanner|3|后端 · 测试 · 文档");
});

test("缺领地横幅：没有缺项就不拼文案，整块不渲染", () => {
  const never = () => assert.fail("名册没有缺项时不该调用文案函数");
  assert.equal(
    territoryBannerText(
      [card({ id: "ops", name: "运维", paths: ["."] }), card({ id: "web", name: "前端", paths: ["src/web"] })],
      never,
    ),
    null,
  );
  assert.equal(territoryBannerText([], never), null);
});

test("缺领地横幅：名字空着就用 id，不出现空白项", () => {
  const t = (key, vars) => `${key}|${vars.n}|${vars.names}`;
  assert.equal(territoryBannerText([card({ id: "worker-2", name: "   " })], t), "orch.staffTerritoryBanner|1|worker-2");
});

test("领地展示：点号只说整片，点号本身不出现在展示行里", () => {
  assert.deepEqual(territoryLines(["."]), [{ whole: true, path: "" }]);
  assert.deepEqual(territoryLines(["  .  "]), [{ whole: true, path: "" }], "首尾空白不影响整片");
  assert.deepEqual(territoryLines(["./"]), [], "整片只认一个点，`./` 归一后是空项");
  assert.deepEqual(territoryLines(["src/web", "server"]), [
    { whole: false, path: "src/web" },
    { whole: false, path: "server" },
  ]);
  assert.deepEqual(
    territoryLines([".", "src/web"]),
    [{ whole: false, path: "src/web" }],
    "点号混在具体路径里不算整片，也不把点号露出来",
  );
});

test("领地展示：空列表与空白项不占行", () => {
  assert.deepEqual(territoryLines([]), []);
  assert.deepEqual(territoryLines(undefined), []);
  assert.deepEqual(territoryLines(["", "  "]), []);
});

test("领地展示：路径归一、去重，整片行只留一条", () => {
  assert.deepEqual(territoryLines(["./src/web/", "src/web", "/server"]), [
    { whole: false, path: "src/web" },
    { whole: false, path: "server" },
  ]);
  assert.deepEqual(territoryLines([".", "./"]), [{ whole: true, path: "" }]);
});

test("领地展示文案：整片用调用方给的说法，多路径按名册分隔符连起来", () => {
  assert.equal(territoryText(["."], "整片"), "整片");
  assert.equal(territoryText(["src/web", "server"], "整片"), "src/web · server");
  assert.equal(territoryText([], "整片"), "");
});
