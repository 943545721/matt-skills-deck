import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCEPTANCE_RECORD_PREFIX,
  DECK_FINALIZE_LABEL,
  finalizeProblem,
  IMPACT_COLUMNS,
  IMPACT_HEADING,
  impactChainProblem,
  impactRowProblem,
  impactSectionProblem,
  isFinalized,
  needsManualImpactTable,
  normalizeRequirementKey,
  parseImpactTable,
  requireTicketGates,
  singleAreaImpactRow,
} from "../shared/impact.ts";

const TABLE = [
  IMPACT_HEADING,
  "| 区 / 仓库 | 依据 | 结论 | 核的人 | 链条（没有就留空） |",
  "|---|---|---|---|---|",
  "| kxhyapp.com | app/common/service/MemberCouponRedemptionService.php:1 | 要动 | kxhyapp.com 的经理（2026-11-03） | 契约：POST /runtime/coupon/apply {amount} |",
  "| kxhyapp.com-saas | src/Service/ClientFeatureUpgradeService.php:11-15 | 要动 | saas 的经理（2026-11-03） | 权益：feature_key=coupon，存量升级=否 |",
  "| kxhyapp.com/apps/h5 | — | 待核 | — | |",
].join("\n");

test("常量与 plan 的固定口径一致", () => {
  assert.equal(IMPACT_HEADING, "## 影响面");
  assert.deepEqual(IMPACT_COLUMNS, ["区 / 仓库", "依据", "结论", "核的人"]);
  assert.equal(DECK_FINALIZE_LABEL, "deck:定稿");
  assert.equal(ACCEPTANCE_RECORD_PREFIX, "验收：");
});

test("解析五列表：四列固定 + 第五列链条", () => {
  const parsed = parseImpactTable(TABLE);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[0], {
    area: "kxhyapp.com",
    basis: "app/common/service/MemberCouponRedemptionService.php:1",
    conclusion: "要动",
    reviewer: "kxhyapp.com 的经理（2026-11-03）",
    chain: "契约：POST /runtime/coupon/apply {amount}",
  });
  assert.equal(parsed.rows[2].chain, "");
});

test("四列表也收：第五列可选，链条按空处理", () => {
  const body = [
    IMPACT_HEADING,
    "| 区 / 仓库 | 依据 | 结论 | 核的人 |",
    "|---|---|---|---|",
    "| 当前工作区 | 需求票本身 | 要动 | 单区，免核 |",
  ].join("\n");
  const parsed = parseImpactTable(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].chain, "");
});

test("缺「## 影响面」这一节：给可显示的原因，不抛异常", () => {
  const parsed = parseImpactTable("## 问题\n这里没有影响面。");
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /影响面/);
});

test("有标题但没有表格：拒绝", () => {
  const parsed = parseImpactTable("## 影响面\n\n先空着。");
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /没有表格/);
});

test("表头不对：拒绝并说出期望列名", () => {
  const body = [
    IMPACT_HEADING,
    "| 区域 | 依据 | 结论 | 核的人 |",
    "|---|---|---|---|",
    "| a | b | 要动 | c |",
  ].join("\n");
  const parsed = parseImpactTable(body);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /区 \/ 仓库/);
});

test("列数不对：表头三列、数据行列数对不齐都拒绝", () => {
  const tooFew = [
    IMPACT_HEADING,
    "| 区 / 仓库 | 依据 | 结论 |",
    "|---|---|---|",
    "| a | b | 要动 |",
  ].join("\n");
  const few = parseImpactTable(tooFew);
  assert.equal(few.ok, false);
  assert.match(few.reason, /4 列/);

  const misaligned = [
    IMPACT_HEADING,
    "| 区 / 仓库 | 依据 | 结论 | 核的人 |",
    "|---|---|---|---|",
    "| a | b | 要动 |",
  ].join("\n");
  const bad = parseImpactTable(misaligned);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /第 1 行有 3 格/);
});

test("依据为空：算问题（待核也一样）", () => {
  assert.match(
    impactRowProblem({ area: "a", basis: "  ", conclusion: "不动", reviewer: "" }),
    /依据/,
  );
  assert.match(
    impactRowProblem({ area: "a", basis: "", conclusion: "待核", reviewer: "" }),
    /依据/,
  );
});

test("结论只认 要动 / 不动 / 待核", () => {
  assert.match(
    impactRowProblem({ area: "a", basis: "x:1", conclusion: "做", reviewer: "r" }),
    /结论/,
  );
  assert.equal(
    impactRowProblem({ area: "a", basis: "x:1", conclusion: "不动", reviewer: "" }),
    null,
  );
});

test("结论「要动」缺核的人：拒绝", () => {
  assert.match(
    impactRowProblem({ area: "a", basis: "x:1", conclusion: "要动", reviewer: "" }),
    /核的人/,
  );
  assert.equal(
    impactRowProblem({ area: "a", basis: "x:1", conclusion: "要动", reviewer: "单区，免核" }),
    null,
  );
});

test("「待核」允许没有核的人，但依据不能空", () => {
  assert.equal(
    impactRowProblem({ area: "a", basis: "x:1", conclusion: "待核", reviewer: "" }),
    null,
  );
  assert.match(
    impactRowProblem({ area: "a", basis: "", conclusion: "待核", reviewer: "" }),
    /依据/,
  );
});

test("第五列四种写法各收一次", () => {
  const valid = [
    "契约：POST /runtime/coupon/apply {amount, code} → {discount}",
    "权益：feature_key=coupon，存量升级=否",
    "等 #12",
    "详见 #34",
    "",
  ];
  for (const chain of valid) {
    assert.equal(impactChainProblem(chain), null, chain);
  }
});

test("第五列写错：半角冒号、空摘要、错键、错票号都拒绝", () => {
  assert.match(impactChainProblem("契约: POST /x"), /全角/);
  assert.match(impactChainProblem("契约："), /摘要/);
  assert.match(impactChainProblem("权益：feature_key=，存量升级=否"), /权益/);
  assert.match(impactChainProblem("权益：feature_key=coupon，存量升级=也许"), /权益/);
  assert.match(impactChainProblem("等 12"), /等 #/);
  assert.match(impactChainProblem("详见 #abc"), /详见 #/);
  assert.match(impactChainProblem("随便写点什么"), /四种写法/);
});

test("行里的第五列格式错，也算整行问题", () => {
  assert.match(
    impactRowProblem({
      area: "a",
      basis: "x:1",
      conclusion: "要动",
      reviewer: "r",
      chain: "契约: 半角冒号",
    }),
    /全角/,
  );
});

test("deck: 标签经 MCP 写入一律拒绝", () => {
  const result = requireTicketGates({
    kind: "issue",
    labels: ["deck:定稿"],
    requirementKey: 12,
    requirementLabels: [DECK_FINALIZE_LABEL],
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /只能由界面/);
});

test("ready-for-agent 不算定稿", () => {
  const create = requireTicketGates({
    kind: "issue",
    requirementKey: 12,
    requirementLabels: ["ready-for-agent"],
  });
  assert.equal(create.ok, false);
  assert.match(create.detail, /定稿/);

  const dispatch = requireTicketGates({
    kind: "requirement",
    labels: ["ready-for-agent"],
    action: "dispatch",
  });
  assert.equal(dispatch.ok, false);
  assert.match(dispatch.detail, /定稿/);
});

test("缺 requirementKey 拒绝建工作票；给了才放行", () => {
  const missing = requireTicketGates({ kind: "spec-ticket", requirementLabels: [DECK_FINALIZE_LABEL] });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /requirementKey/);

  // 侦查路线票、缺陷收单与万能兜底票不在这道闸里：它们各有需求之前就该存在的理由。
  for (const kind of ["map-ticket", "bug", "issue"]) {
    const intake = requireTicketGates({ kind, requirementLabels: [DECK_FINALIZE_LABEL] });
    assert.deepEqual(intake, { ok: true }, kind);
  }

  const ok = requireTicketGates({
    kind: "spec-ticket",
    requirementKey: "#12",
    requirementLabels: [DECK_FINALIZE_LABEL],
  });
  assert.deepEqual(ok, { ok: true });
});

test("需求票定稿前不能派单；定稿后放行", () => {
  const before = requireTicketGates({ kind: "requirement", labels: [], action: "dispatch" });
  assert.equal(before.ok, false);
  assert.match(before.detail, /定稿/);

  const after = requireTicketGates({
    kind: "requirement",
    labels: [DECK_FINALIZE_LABEL],
    action: "dispatch",
  });
  assert.deepEqual(after, { ok: true });
});

test("建需求票本身不要求先定稿", () => {
  assert.deepEqual(requireTicketGates({ kind: "requirement", labels: [] }), { ok: true });
  assert.deepEqual(requireTicketGates({ kind: "issue", labels: ["requirement"] }), { ok: true });
});

test("真实需求票是 kind=issue + requirement 标签：同样按定稿判定", () => {
  const before = requireTicketGates({
    kind: "issue",
    labels: ["requirement", "ready-for-agent"],
    action: "dispatch",
  });
  assert.equal(before.ok, false);
  assert.match(before.detail, /定稿/);

  const after = requireTicketGates({
    kind: "issue",
    labels: ["requirement", DECK_FINALIZE_LABEL],
    action: "dispatch",
  });
  assert.deepEqual(after, { ok: true });
});

test("requirementKey 接受数字、#号与字符串；空值不收", () => {
  assert.equal(normalizeRequirementKey(12), 12);
  assert.equal(normalizeRequirementKey("#12"), 12);
  assert.equal(normalizeRequirementKey("12"), 12);
  assert.equal(normalizeRequirementKey(0), 0);
  assert.equal(normalizeRequirementKey(""), null);
  assert.equal(normalizeRequirementKey("abc"), null);
  assert.equal(normalizeRequirementKey(undefined), null);
});

test("impactSectionProblem 只看结构：没写这一节放行，写坏就报", () => {
  assert.equal(impactSectionProblem(""), null);
  assert.equal(impactSectionProblem("## 问题\n没有影响面。"), null);
  // 结构对、数据行还没填：写票过程中允许，按「未写完」处理。
  assert.equal(impactSectionProblem([IMPACT_HEADING, "| 区 / 仓库 | 依据 | 结论 | 核的人 |", "|---|---|---|---|"].join("\n")), null);
  // 写坏的三种：列名不对、多插一列、缺分隔行。
  assert.match(impactSectionProblem("## 影响面\n| 区 | 依据 | 结论 | 核的人 |\n|---|---|---|---|"), /区 \/ 仓库/);
  assert.match(
    impactSectionProblem("## 影响面\n| 区 / 仓库 | 仓库 | 依据 | 结论 | 核验人 |\n|---|---|---|---|---|"),
    /第 2 列应该是「依据」/,
  );
  assert.match(impactSectionProblem("## 影响面\n| 区 / 仓库 | 依据 | 结论 | 核的人 |"), /分隔行/);
});

test("finalizeProblem：单区没写这一节放行，跨区没写就拒，定稿要求每行都核过", () => {
  assert.equal(finalizeProblem("## 目标\n只改后端", ["kxhyapp.com"]), null);
  assert.match(finalizeProblem("## 目标\n只改后端", ["a", "b"]) ?? "", /影响面/);
  assert.equal(finalizeProblem("## 影响面\n| 区 / 仓库 | 依据 | 结论 | 核的人 |\n|---|---|---|---|", ["a", "b"]), "影响面表没有数据行：每个要动的区至少占一行。");
  assert.equal(finalizeProblem(TABLE, ["kxhyapp.com", "kxhyapp.com-saas"]), null);
  assert.match(finalizeProblem(TABLE.replace("| 要动 |", "| 动一下 |"), ["kxhyapp.com"]), /结论/);
});

test("isFinalized 只认 deck:定稿（大小写不敏感）", () => {
  assert.equal(isFinalized(["deck:定稿"]), true);
  assert.equal(isFinalized(["DECK:定稿"]), true);
  assert.equal(isFinalized(["ready-for-agent"]), false);
  assert.equal(isFinalized([]), false);
});

test("单区自动填行与判断是否需要人工填表", () => {
  assert.deepEqual(singleAreaImpactRow(), {
    area: "当前工作区",
    basis: "需求票本身",
    conclusion: "要动",
    reviewer: "单区，免核",
    chain: "",
  });
  assert.equal(impactRowProblem(singleAreaImpactRow()), null);

  assert.equal(needsManualImpactTable({ repos: ["kxhyapp.com"] }), false);
  assert.equal(needsManualImpactTable({ repos: ["kxhyapp.com", "kxhyapp.com"] }), false);
  assert.equal(needsManualImpactTable({ repos: ["a", "b"] }), true);
  assert.equal(needsManualImpactTable({ repos: [], hasChain: true }), true);
  assert.equal(needsManualImpactTable({}), false);
});
