import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBody, parseDecisionLine, parseMapBody, truncateGist } from "../server/tracker/map-body.ts";
import { routeFromIssues, routeKindOf, suggestNextSteps } from "../server/tracker/map-route.ts";

const MAP_BODY = `<!-- wayfinder map -->
## Destination

让面板能读懂地图票，并给出下一步。

## Notes

正文里写 \`## Notes\` 这几个字不算标题。

## Decisions so far

- [先做只读](#12) — 写操作留到下一阶段，先把读路径跑通。
- **标签一起做**：否则建完票还得手点一次。
- 这行不是决策，应该被丢掉

## Not yet specified

- 移动端怎么排？
- 多远端时默认推哪个？
<!-- 内部备注，界面上不该出现 -->

## Out of scope

- GitLab 写接口
`;

test("地图正文：五个区块都解出来，注释与非决策行被丢掉", () => {
  const map = parseMapBody(MAP_BODY);
  assert.equal(map.destination, "让面板能读懂地图票，并给出下一步。");
  assert.match(map.notes, /不算标题/);
  assert.deepEqual(
    map.decisions.map((d) => [d.title, d.url]),
    [
      ["先做只读", "#12"],
      ["标签一起做", ""],
    ],
  );
  assert.equal(map.decisions[0]?.gist, "写操作留到下一阶段，先把读路径跑通。");
  // 列表符号保留（与源仓库同口径：解析层不动内容，界面渲染时再决定要不要剥掉 `- `）。
  assert.deepEqual(map.fog, ["- 移动端怎么排？", "- 多远端时默认推哪个？"]);
  assert.deepEqual(map.outOfScope, ["- GitLab 写接口"]);
});

test("地图正文：缺区块回空形状，不返回 null", () => {
  for (const input of [null, undefined, "", "随便一段没有标题的正文"]) {
    const map = parseMapBody(input);
    assert.deepEqual(map, { destination: "", notes: "", decisions: [], fog: [], outOfScope: [] });
  }
});

test("地图正文：标题粘在上一行末尾也要切开", () => {
  const map = parseMapBody("## Destination\n\n目标在这。## Not yet specified\n- 还没想好");
  assert.equal(map.destination, "目标在这。");
  assert.deepEqual(map.fog, ["- 还没想好"]);
});

test("地图正文：字面 \\n 会被还原成换行", () => {
  const body = normalizeBody("## Destination\\n\\n目标\\n## Notes\\n\\n备注");
  assert.ok(body.includes("\n## Notes"));
});

test("决策行：加粗写法里的链接只留票号当标题", () => {
  assert.deepEqual(parseDecisionLine("- **[#1057](#57)**：先做这个"), {
    title: "#1057",
    url: "#57",
    gist: "先做这个",
  });
  assert.equal(parseDecisionLine("- 普通一行"), null);
});

test("决策那句话：超长时退到完整词再补省略号", () => {
  const exact = "a".repeat(240);
  assert.equal(truncateGist(exact), exact);
  const long = `${"词 ".repeat(200)}尾`;
  const out = truncateGist(long);
  // 退到最后一个完整词（"词"）之后再加省略号，所以切出来的结果正好收在一个完整词上。
  assert.ok(out.endsWith("词…"));
  assert.ok(Array.from(out).length <= 241);
});

const issue = (number, names, state = "OPEN") => ({
  number,
  title: `票 ${number}`,
  state,
  url: `https://example.test/${number}`,
  updatedAt: "2026-10-26T00:00:00Z",
  labels: names.map((name) => ({ name, color: "cccccc" })),
  assignees: [],
  isMap: names.includes("wayfinder:map"),
});

test("路线：只收 wayfinder 子类型，剔除地图票自己，开着的排前面", () => {
  const route = routeFromIssues([
    issue(1, ["wayfinder:map"]),
    issue(2, ["wayfinder:task"], "CLOSED"),
    issue(3, ["wayfinder:task"]),
    issue(4, ["wayfinder:research"]),
    issue(5, ["bug"]),
  ]);
  assert.deepEqual(
    route.map((item) => [item.number, item.kind, item.state]),
    [
      [4, "research", "OPEN"],
      [3, "task", "OPEN"],
      [2, "task", "CLOSED"],
    ],
  );
  assert.equal(routeKindOf([{ name: "bug" }]), null);
});

test("建议：先目标、再雾、再按研究/讨论/原型/任务的次序，最多三条", () => {
  const route = routeFromIssues([
    issue(10, ["wayfinder:task"]),
    issue(11, ["wayfinder:research"]),
    issue(12, ["wayfinder:grilling"]),
  ]);
  const map = parseMapBody("## Not yet specified\n- 雾一\n- 雾二");
  const codes = suggestNextSteps({ map, route }).map((item) => item.code);
  assert.deepEqual(codes, ["no-destination", "fog-open", "research-open"]);

  const detailed = suggestNextSteps({ map, route });
  assert.equal(detailed[1]?.count, 2);
  assert.equal(detailed[2]?.number, 11);
});

test("建议：路线全关掉时说明「都完成了」，没有路线票时说明「还没拆票」", () => {
  const closed = suggestNextSteps({
    map: parseMapBody("## Destination\n\n目标明确"),
    route: routeFromIssues([issue(20, ["wayfinder:task"], "CLOSED")]),
  });
  assert.deepEqual(closed.map((item) => item.code), ["all-closed"]);

  const empty = suggestNextSteps({ map: parseMapBody("## Destination\n\n目标明确"), route: [] });
  assert.deepEqual(empty.map((item) => item.code), ["no-route"]);
});
