import assert from "node:assert/strict";
import { test } from "node:test";
import { activeBlockers, blockerLabel, staleBlockerLabels } from "../client/deck/format.ts";

/**
 * 板子上那行「被 #N 阻塞」报谁、不报谁。
 *
 * `blockedBy` 是历史：对方关掉了，这条边照样留在列表里。照抄一遍，一张其实已经能接的票
 * 看起来仍然堵着——这比不显示更坏。所以列表只报「还在挡路的」，完整历史留给详情页。
 */

const blocker = (number, state, extra = {}) => ({ number, title: `票 ${number}`, state, kind: "issue", ...extra });

test("只报还开着的阻塞者：对方关掉的边不再列出来", () => {
  const item = {
    readiness: "ready",
    blockedBy: [blocker(3, "CLOSED"), blocker(7, "OPEN")],
  };
  assert.deepEqual(
    activeBlockers(item).map((entry) => entry.number),
    [7],
    "已关闭的 #3 不该还挂着「阻塞」二字",
  );

  assert.deepEqual(activeBlockers({ readiness: "ready", blockedBy: [blocker(3, "CLOSED")] }), []);
});

test("读不到的跨仓库票照样算阻塞：UNKNOWN 不能当成已解除", () => {
  const item = {
    readiness: "blocked",
    blockedBy: [blocker(7, "UNKNOWN", { repo: "two/beta", source: "body", stale: true })],
  };
  const kept = activeBlockers(item);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].state, "UNKNOWN");
  assert.equal(blockerLabel(kept[0]), "two/beta#7", "跨仓库要带仓库名，否则两块板子的 #7 会看成同一条");
});

test("票自己已经关闭：等谁都没意义，整行不报", () => {
  const item = { readiness: "closed", blockedBy: [blocker(3, "OPEN")] };
  assert.deepEqual(activeBlockers(item), []);
  assert.deepEqual(staleBlockerLabels(item), [], "同一条口径：已关闭的票不提引用失效");
});

test("本仓库的阻塞者只写票号，不凭空造仓库名", () => {
  assert.equal(blockerLabel({ number: 12 }), "#12");
  assert.equal(blockerLabel({ number: 12, repo: "one/alpha" }), "one/alpha#12");
});
