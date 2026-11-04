import assert from "node:assert/strict";
import test from "node:test";
import { ticketLabelOf } from "../shared/orchestration.ts";

test("多仓库工作区写全 owner/repo#N，履历反查才读得到对的那张", () => {
  assert.equal(ticketLabelOf("acme/web", 12), "acme/web#12");
});

test("本地后端的合成仓库键不写进标签", () => {
  assert.equal(ticketLabelOf("local", 12), "#12");
  assert.equal(ticketLabelOf("", 12), "#12");
  assert.equal(ticketLabelOf(null, 12), "#12");
  assert.equal(ticketLabelOf(undefined, 12), "#12");
});
