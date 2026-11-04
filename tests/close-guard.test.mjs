import assert from "node:assert/strict";
import { test } from "node:test";
import { closeChildrenOf, containerCloseGuard } from "../server/mcp/close-guard.ts";

/**
 * 关容器闸门是纯函数：这里只测判定，不碰后端。
 * 集成路径（真建票、真关票）在 tests/mcp-tools.test.mjs 里。
 */

const kid = (key, state, title = `票 ${key}`) => ({ key: String(key), title, state });
const readable = (...list) => ({ readable: true, list });

test("后端读子票失败的原因原样传出，不被换成通用文案", () => {
  const result = closeChildrenOf({ childrenProblem: "glab api 403 forbidden" });
  assert.equal(result.readable, false);
  assert.match(result.problem, /glab api 403 forbidden/);
});

test("详情没给子票列 = 判不了，不能当成 0 张", () => {
  const result = closeChildrenOf({});
  assert.equal(result.readable, false);
  assert.match(result.problem, /没有子票清单/);
});

test("子票清单被截断 = 判不了：总数大于读到的张数，或后端自己标了截断", () => {
  const byTotal = closeChildrenOf({ children: [{ number: 2, title: "甲", state: "CLOSED" }], childrenTotal: 3 });
  assert.equal(byTotal.readable, false);
  assert.match(byTotal.problem, /只读到 1 张（共 3 张）/);

  const byFlag = closeChildrenOf({ children: [], childrenTotal: 0, childrenTruncated: true });
  assert.equal(byFlag.readable, false);
});

test("完整清单转成闸门输入：票号转字符串，空数组仍是可读的 0 张", () => {
  assert.deepEqual(closeChildrenOf({ children: [], childrenTotal: 0 }), { readable: true, list: [] });
  assert.deepEqual(
    closeChildrenOf({ children: [{ number: 4, title: "实施乙", state: "OPEN" }], childrenTotal: 1 }),
    { readable: true, list: [{ key: "4", title: "实施乙", state: "OPEN" }] },
  );
});

test("子票清单读不回：判不了就不关，拒绝文案要说明原因", () => {
  const result = containerCloseGuard({
    kind: "map",
    key: 3,
    hasComment: true,
    children: { readable: false, problem: "板子读取超时" },
  });
  assert.equal(result.kind, "refuse");
  assert.equal(result.rule, "container-close-children-unreadable");
  assert.match(result.text, /判不了是不是全关/);
  assert.match(result.text, /板子读取超时/);
});

test("地图可以没有工单就关（放弃的探索地图），规格不行", () => {
  assert.deepEqual(
    containerCloseGuard({ kind: "map", key: 1, hasComment: true, children: readable() }),
    { kind: "ok" },
  );
  const spec = containerCloseGuard({ kind: "spec", key: 1, hasComment: true, children: readable() });
  assert.equal(spec.kind, "refuse");
  assert.equal(spec.rule, "container-close-no-children");
  assert.match(spec.text, /没有实施票就没有可核对的东西/);
  assert.match(spec.text, /\/to-tickets/);
});

test("还有没关的子票：逐张报出票号、标题、状态", () => {
  const result = containerCloseGuard({
    kind: "spec",
    key: 9,
    hasComment: true,
    children: readable(kid(2, "CLOSED"), kid(4, "OPEN", "实施乙"), kid(5, "closed")),
  });
  assert.equal(result.kind, "refuse");
  assert.equal(result.rule, "container-close-children-open");
  assert.match(result.text, /还有 1 张实施票没关/);
  assert.match(result.text, /#4（实施乙，当前 OPEN）/);
  assert.ok(!result.text.includes("#5"), "closed 小写也算已关，不能报成没关");
});

test("子票全关但没有核对评论：拒绝，并说明评论与关闭要同一次调用", () => {
  const result = containerCloseGuard({
    kind: "map",
    key: 1,
    hasComment: false,
    children: readable(kid(2, "CLOSED")),
  });
  assert.equal(result.kind, "refuse");
  assert.equal(result.rule, "container-close-no-comment");
  assert.match(result.text, /同一次调用/);
});

test("子票全关 + 带评论：放行", () => {
  assert.deepEqual(
    containerCloseGuard({ kind: "spec", key: 9, hasComment: true, children: readable(kid(2, "CLOSED"), kid(3, "CLOSED")) }),
    { kind: "ok" },
  );
});
