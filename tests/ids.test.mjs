import assert from "node:assert/strict";
import test from "node:test";
import { DECK_CONTRIBUTION_IDS } from "../client/deck/ids.ts";

/**
 * 客户端会给每个「面」的 id 过一遍 `^[a-z][a-z0-9-]*$`（同 plugin button id 那条规则）。
 * 不合规时整个插件在界面上显示「失败」，原因只有一行 `Invalid workspace panel id: xxx`。
 * 之前写成 `deck.board`（跟着 RPC 方法名的习惯）就这么挂过一次，所以单独钉一条用例。
 */
const CLIENT_ID = /^[a-z][a-z0-9-]*$/;

test("每个面的 id 都符合客户端的 id 规则", () => {
  for (const id of DECK_CONTRIBUTION_IDS) {
    assert.match(id, CLIENT_ID, `${id} 不符合 ${CLIENT_ID}`);
  }
});

test("三个面的 id 互不相同", () => {
  assert.equal(new Set(DECK_CONTRIBUTION_IDS).size, DECK_CONTRIBUTION_IDS.length);
});
