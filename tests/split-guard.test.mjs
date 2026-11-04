import assert from "node:assert/strict";
import { test } from "node:test";
import { DECK_FINALIZE_LABEL as IMPACT_FINALIZE_LABEL } from "../shared/impact.ts";
import {
  DECK_FINALIZE_LABEL,
  guardCreateTicket,
} from "../shared/split-guard.ts";

const FINALIZED = [DECK_FINALIZE_LABEL];

function bodyWith(rows) {
  return [
    "## 影响面",
    "| 区 / 仓库 | 依据 | 结论 | 核的人 | 链条（没有就留空） |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

const VALID_BODY = bodyWith([
  "| kxhyapp.com | app/common/service/MemberCouponRedemptionService.php:1 | 要动 | kxhyapp.com 的经理（2026-11-03） | 契约：POST /runtime/coupon/apply |",
  "| kxhyapp.com-saas | src/Service/ClientFeatureUpgradeService.php:11-15 | 要动 | saas 的经理（2026-11-03） | 权益：feature_key=coupon，存量升级=否 |",
]);

test("定稿标签只有一份定义，split-guard 只做 re-export", () => {
  assert.equal(DECK_FINALIZE_LABEL, IMPACT_FINALIZE_LABEL);
  assert.equal(DECK_FINALIZE_LABEL, "deck:定稿");
});

test("deck: 标签在唯一入口就被拒绝", () => {
  const result = guardCreateTicket({
    kind: "issue",
    labels: ["deck:定稿"],
    requirementKey: 12,
    requirementLabels: FINALIZED,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /只能由界面/);
});

test("缺 requirementKey 在唯一入口被拒绝", () => {
  const result = guardCreateTicket({
    kind: "spec-ticket",
    requirementLabels: FINALIZED,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /requirementKey/);
});

test("单区、无链条：不写影响面也能建工作票", () => {
  const result = guardCreateTicket({
    kind: "issue",
    requirementKey: "#12",
    requirementLabels: FINALIZED,
    repos: ["kxhyapp.com"],
  });
  assert.deepEqual(result, { ok: true });
});

test("跨两个仓库：读不到正文就拒绝，并说清要补什么", () => {
  const result = guardCreateTicket({
    kind: "issue",
    requirementKey: "#12",
    requirementLabels: FINALIZED,
    repos: ["kxhyapp.com", "kxhyapp.com-saas"],
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /影响面/);
});

test("跨两个仓库且有完整影响面表：放行", () => {
  const result = guardCreateTicket({
    kind: "issue",
    requirementKey: "#12",
    requirementLabels: FINALIZED,
    repos: ["kxhyapp.com", "kxhyapp.com-saas"],
    requirementBody: VALID_BODY,
  });
  assert.deepEqual(result, { ok: true });
});

test("影响面表本身坏了：唯一入口转述解析原因", () => {
  const result = guardCreateTicket({
    kind: "issue",
    requirementKey: "#12",
    requirementLabels: FINALIZED,
    hasChain: true,
    requirementBody: "## 影响面\n| 区域 | 依据 | 结论 | 核的人 |\n|---|---|---|---|\n| a | b | 要动 | c |",
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /区 \/ 仓库/);
});

test("某一行「要动」缺核的人：拒绝时报出行号与区", () => {
  const result = guardCreateTicket({
    kind: "issue",
    requirementKey: "#12",
    requirementLabels: FINALIZED,
    hasChain: true,
    requirementBody: bodyWith([
      "| kxhyapp.com | app/x.php:1 | 要动 |  | 契约：POST /x |",
    ]),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /影响面第 1 行（kxhyapp.com）/);
  assert.match(result.detail, /核的人/);
});

test("某一行的第五列写错：拒绝", () => {
  const result = guardCreateTicket({
    kind: "issue",
    requirementKey: "#12",
    requirementLabels: FINALIZED,
    repos: ["a", "b"],
    requirementBody: bodyWith([
      "| a | a/x.php:1 | 要动 | 经理 | 契约: 半角冒号 |",
      "| b | b/y.php:1 | 不动 | 经理 | |",
    ]),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /全角/);
});

test("单区但正文已写影响面节：仍按表校验，写坏也拒", () => {
  const bad = bodyWith([
    "| 当前工作区 |  | 要动 | 单区，免核 | |",
  ]);
  const result = guardCreateTicket({
    kind: "issue",
    requirementKey: "#12",
    requirementLabels: FINALIZED,
    repos: ["kxhyapp.com"],
    requirementBody: bad,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /依据/);
});

test("行里写了链条：自动视为人工表，逐行校验", () => {
  const result = guardCreateTicket({
    kind: "issue",
    requirementKey: "#12",
    requirementLabels: FINALIZED,
    repos: ["kxhyapp.com"],
    requirementBody: bodyWith([
      "| kxhyapp.com | app/x.php:1 | 要动 | 经理 | 等 #12 |",
    ]),
  });
  assert.deepEqual(result, { ok: true });
});

test("派单走同一道闸：需求没定稿就拒绝", () => {
  const result = guardCreateTicket({
    kind: "requirement",
    labels: ["ready-for-agent"],
    action: "dispatch",
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /定稿/);
});

test("派单已定稿：放行", () => {
  const result = guardCreateTicket({
    kind: "requirement",
    labels: FINALIZED,
    action: "dispatch",
  });
  assert.deepEqual(result, { ok: true });
});
