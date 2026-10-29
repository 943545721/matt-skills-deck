import assert from "node:assert/strict";
import { test } from "node:test";
import { childrenOf, EDGE_LANDING, landingOf, statusOfItems } from "../shared/edge-rules.ts";

/**
 * 边规则是 DSH `edge-landing.ts` / `dependency-graph.ts` 的纯函数移植：
 * 子票筛选、落点映射、整批状态都不碰后端，先在这里钉住口径。
 */

test("childrenOf：带 parentKey 时按父票精确筛，顺序不变", () => {
  const rows = [
    { number: 2, parentKey: "1" },
    { number: 3, parentKey: "1" },
    { number: 4, parentKey: "9" },
    { number: 5, parentKey: null },
  ];
  const picked = childrenOf(rows, 1);
  assert.equal(picked.filtered, true);
  assert.deepEqual(picked.children.map((row) => row.number), [2, 3]);
  assert.equal(picked.note, "");
});

test("childrenOf：整批没有任何父子信息时原样回全部，并说明为什么", () => {
  const rows = [{ number: 2 }, { number: 3, parentKey: null }, { number: 4, parentKey: "" }];
  const picked = childrenOf(rows, 1);
  assert.equal(picked.filtered, false);
  assert.deepEqual(picked.children.map((row) => row.number), [2, 3, 4]);
  assert.match(picked.note, /没带父子信息/);
  assert.match(picked.note, /deck_issue_get/);
});

test("落点：证据档次决定说法，判不出来不许升成原生边", () => {
  assert.equal(landingOf("parent", { kind: "native" }), EDGE_LANDING.NATIVE_PARENT);
  assert.equal(landingOf("block", { kind: "native" }), EDGE_LANDING.NATIVE_BLOCK);
  assert.equal(landingOf("parent", { kind: "body-line" }), EDGE_LANDING.BODY_LINE);
  assert.equal(landingOf("block", { kind: "file-note" }), EDGE_LANDING.FILE_NOTE);
  assert.equal(landingOf("parent", { kind: "contract" }), EDGE_LANDING.CONTRACT_PARENT_FIELD);
  assert.equal(landingOf("block", { kind: "contract" }), EDGE_LANDING.CONTRACT_BLOCK_FIELD);
  assert.equal(landingOf("parent", { kind: "missing" }), EDGE_LANDING.READ_BACK_MISSING);
  assert.equal(landingOf("parent", { kind: "unsupported" }), EDGE_LANDING.UNSUPPORTED);
  assert.equal(landingOf("parent", {}), EDGE_LANDING.UNKNOWN);
});

test("整批状态：全成 ok、全败 unsupported、成败都有 partial", () => {
  assert.equal(statusOfItems([]), "ok");
  assert.equal(statusOfItems([{ status: "ok" }]), "ok");
  assert.equal(statusOfItems([{ status: "failed" }]), "unsupported");
  assert.equal(statusOfItems([{ status: "ok" }, { status: "failed" }]), "partial");
});
