import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCEPTANCE_COUNTERPART_LINE_PREFIX,
  ACCEPTANCE_PENDING_LINE,
  CHAIN_LEVELS,
  CHAIN_LEVEL_LABELS,
  acceptanceCounterpartLink,
  acceptanceRecordLine,
  acceptanceTicketProblem,
  chainLevelOf,
  contractChangeArtifacts,
  hasPendingAcceptanceRecord,
  judgeChain,
  parseChainCell,
  readBlockedBySection,
  renderBlockedBySection,
  upsertBlockedBySection,
} from "../shared/contract-chain.ts";
import { IMPACT_HEADING, parseImpactTable } from "../shared/impact.ts";

/**
 * 跨区代码链条（plan 第 4b 批的纯函数层）。
 *
 * 这里钉住的是「上游判定」：级别判错，后面每道闸门都在保护一个错的前提。
 * 三级尤其不能把「读不到对方票」当成「已经解除」——板子上的 ready 不算数。
 */

const TABLE = [
  IMPACT_HEADING,
  "| 区 / 仓库 | 依据 | 结论 | 核的人 | 链条（没有就留空） |",
  "|---|---|---|---|---|",
  "| kxhyapp.com | app/common/service/MemberCouponRedemptionService.php:1 | 要动 | kxhyapp.com 的经理（2026-11-03） | 契约：POST /runtime/coupon/apply {amount} → {discount} |",
  "| kxhyapp.com-saas | src/Service/ClientFeatureUpgradeService.php:11-15 | 要动 | saas 的经理（2026-11-03） | 权益：feature_key=coupon，存量升级=否 |",
  "| kxhyapp.com/apps/h5 | — | 待核 | — | |",
].join("\n");

/* ---------------------------------------------------------------- 常量与解析 */

test("四级顺序与中文名和 plan 第十节那张表一致", () => {
  assert.deepEqual(CHAIN_LEVELS, ["unrelated", "contract", "depends", "capability"]);
  assert.equal(CHAIN_LEVEL_LABELS.unrelated, "无关");
  assert.equal(CHAIN_LEVEL_LABELS.contract, "有契约");
  assert.equal(CHAIN_LEVEL_LABELS.depends, "强依赖");
  assert.equal(CHAIN_LEVEL_LABELS.capability, "能力·授权");
});

test("第五列四种写法各解析成机器字段", () => {
  const empty = parseChainCell("");
  assert.equal(empty.ok, true);
  assert.equal(empty.chain.kind, "none");
  assert.equal(empty.chain.summary, null);

  const contract = parseChainCell("契约：POST /runtime/coupon/apply {amount} → {discount}");
  assert.equal(contract.ok, true);
  assert.equal(contract.chain.kind, "contract");
  assert.equal(contract.chain.summary, "POST /runtime/coupon/apply {amount} → {discount}");
  assert.equal(contract.chain.detailTicket, null);

  const capability = parseChainCell("权益：feature_key=coupon，存量升级=否");
  assert.equal(capability.ok, true);
  assert.equal(capability.chain.kind, "capability");
  assert.equal(capability.chain.featureKey, "coupon");
  assert.equal(capability.chain.upgradeExisting, false);

  // 与 impact.ts 的定稿校验同一口径：前缀后的空格也认，不能按钮放过、派单又拒。
  const spaced = parseChainCell("权益： feature_key=coupon，存量升级=是");
  assert.equal(spaced.ok, true);
  assert.equal(spaced.chain.featureKey, "coupon");

  const waiting = parseChainCell("等 #12");
  assert.equal(waiting.ok, true);
  assert.equal(waiting.chain.kind, "depends");
  assert.equal(waiting.chain.waitingTicket, 12);

  // 契约太长写不进一格：另开一张普通 issue，第五列只留「详见 #N」。
  const detail = parseChainCell("详见 #34");
  assert.equal(detail.ok, true);
  assert.equal(detail.chain.kind, "contract");
  assert.equal(detail.chain.detailTicket, 34);
  assert.equal(detail.chain.summary, null);
});

test("第五列写错：全角冒号、缺字段、写别的都给明确原因", () => {
  const cases = [
    ["契约: POST /x", /全角/],
    ["契约：", /摘要/],
    ["权益：feature_key=，存量升级=否", /权益/],
    ["权益：feature_key=coupon", /权益/],
    ["权益：feature_key=coupon，存量升级=也许", /权益/],
    ["等 12", /等 #/],
    ["详见 #abc", /详见 #/],
    ["随便写点什么", /四种写法/],
  ];
  for (const [cell, expected] of cases) {
    const parsed = parseChainCell(cell);
    assert.equal(parsed.ok, false, cell);
    assert.match(parsed.reason, expected, cell);
  }
});

test("chainLevelOf：四种解析结果各自落到四级", () => {
  for (const level of CHAIN_LEVELS) {
    const cell = {
      unrelated: "",
      contract: "契约：GET /x",
      depends: "等 #9",
      capability: "权益：feature_key=coupon，存量升级=是",
    }[level];
    const parsed = parseChainCell(cell);
    assert.equal(parsed.ok, true, level);
    assert.equal(chainLevelOf(parsed.chain), level);
  }
});

/* ---------------------------------------------------------------- 四级判定 */

test("一级（无关）：第五列留空就按无关处理，不额外要材料", () => {
  const verdict = judgeChain({ chain: "" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, "unrelated");
  assert.deepEqual(verdict.warnings, []);
});

test("二级（有契约）：有摘要放行；缺摘要拒绝且理由说得清", () => {
  const ok = judgeChain({ chain: "契约：POST /runtime/coupon/apply {amount}" });
  assert.equal(ok.ok, true);
  assert.equal(ok.level, "contract");
  assert.equal(ok.chain.summary, "POST /runtime/coupon/apply {amount}");

  // 「详见 #N」也是契约：摘要放在那张普通票里，不算缺。
  const detail = judgeChain({
    chain: "详见 #34",
    counterpart: { detailTicket: { exists: true, closed: false } },
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.level, "contract");
  assert.equal(detail.chain.detailTicket, 34);

  const missing = judgeChain({ chain: "契约：" });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /摘要/);
});

test("「详见 #N」只认票号存在且开着；读不到 / 不存在 / 已关都拒绝", () => {
  const unread = judgeChain({ chain: "详见 #34" });
  assert.equal(unread.ok, false);
  assert.match(unread.reason, /还没读/);

  const absent = judgeChain({ chain: "详见 #34", counterpart: { detailTicket: { exists: false, closed: false } } });
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /不存在/);

  const closed = judgeChain({ chain: "详见 #34", counterpart: { detailTicket: { exists: true, closed: true } } });
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /已经关了/);
});

test("三级（强依赖）：对方票未关 → 拒绝；已关 → 放行", () => {
  const open = judgeChain({
    chain: "等 #12",
    counterpart: { area: "saas", ticket: { exists: true, closed: false } },
  });
  assert.equal(open.ok, false);
  assert.equal(open.level, "depends");
  assert.match(open.reason, /#12/);
  assert.match(open.reason, /还没关/);

  const closed = judgeChain({
    chain: "等 #12",
    counterpart: { area: "saas", ticket: { exists: true, closed: true } },
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.level, "depends");

  const missing = judgeChain({
    chain: "等 #12",
    counterpart: { area: "saas", ticket: { exists: false, closed: false } },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /不存在/);
});

test("三级：没读对方票时拒绝，不把「读不到」当「已解除」", () => {
  const unread = judgeChain({ chain: "等 #12" });
  assert.equal(unread.ok, false);
  assert.match(unread.reason, /还没读对方票/);

  const noFact = judgeChain({ chain: "等 #12", counterpart: { area: "saas" } });
  assert.equal(noFact.ok, false);
  assert.match(noFact.reason, /还没读对方票/);
});

test("四级（能力 / 授权）：缺 feature_key 或存量升级 → 拒绝", () => {
  for (const cell of [
    "权益：feature_key=，存量升级=否",
    "权益：feature_key=coupon",
    "权益：feature_key=coupon，存量升级=也许",
  ]) {
    const verdict = judgeChain({ chain: cell });
    assert.equal(verdict.ok, false, cell);
    assert.match(verdict.reason, /权益/, cell);
  }

  const ok = judgeChain({ chain: "权益：feature_key=coupon，存量升级=是" });
  assert.equal(ok.ok, true);
  assert.equal(ok.level, "capability");
  assert.equal(ok.chain.featureKey, "coupon");
  assert.equal(ok.chain.upgradeExisting, true);
});

test("四级：存量升级=否只警告，要求需求票明说", () => {
  const verdict = judgeChain({ chain: "权益：feature_key=coupon，存量升级=否" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, "capability");
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0], /存量升级=否/);
  assert.match(verdict.warnings[0], /明说/);
});

test("第五列格式不对时判定也拒绝，且 level / chain 不冒充某个级别", () => {
  const verdict = judgeChain({ chain: "契约: POST /x" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /全角/);
  assert.equal(verdict.level, null);
  assert.equal(verdict.chain, null);
});

test("跨仓库但没声明链条：只警告，不拒绝（钉死，防止后来改成硬拦）", () => {
  const verdict = judgeChain({ chain: "", crossRepo: true, counterpart: { area: "saas" } });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, "unrelated");
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0], /只警告/);
  assert.match(verdict.warnings[0], /不拒绝/);
  assert.match(verdict.warnings[0], /saas/);
});

test("跨仓库但已声明链条：不再重复那条警告", () => {
  const verdict = judgeChain({ chain: "契约：GET /x", crossRepo: true });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.warnings, []);
});

test("真实影响面表逐行接判定：契约行与权益行各自走对分支", () => {
  const parsed = parseImpactTable(TABLE);
  assert.equal(parsed.ok, true);

  const contractRow = judgeChain({ chain: parsed.rows[0].chain });
  assert.equal(contractRow.ok, true);
  assert.equal(contractRow.level, "contract");

  const capabilityRow = judgeChain({ chain: parsed.rows[1].chain });
  assert.equal(capabilityRow.ok, true);
  assert.equal(capabilityRow.level, "capability");
  assert.equal(capabilityRow.chain.featureKey, "coupon");
});

/* ---------------------------------------------------------------- 跨仓库 blockedBy */

test("跨仓库 blockedBy 只写正文隐藏区段，读得回来，不建父子边", () => {
  const section = renderBlockedBySection(["two/beta#7", "three/gamma#9"]);
  assert.match(section, /^<!-- DSH-CROSS-REPO-BLOCKED-BY/);
  assert.match(section, /Blocked by: two\/beta#7, three\/gamma#9/);
  assert.match(section, /-->$/);

  // helper 只产出正文；没有任何 parent / 父子边字段。
  assert.doesNotMatch(section, /parent/i);

  const body = `正文\n\n${section}`;
  assert.deepEqual(readBlockedBySection(body), ["two/beta#7", "three/gamma#9"]);
  assert.deepEqual(readBlockedBySection("正文里没有依赖"), []);
  // 人手写的可见行也认：读不出来等于悄悄把依赖丢了。
  assert.deepEqual(readBlockedBySection("先等对方上线。\n\nBlocked by: two/beta#7"), ["two/beta#7"]);
});

test("隐藏区段幂等写入：重复写不叠加，换引用只留一段，清空整段删掉", () => {
  const first = upsertBlockedBySection("hello", ["two/beta#7"]);
  assert.equal(first.changed, true);
  assert.match(first.body, /DSH-CROSS-REPO-BLOCKED-BY/);
  assert.deepEqual(readBlockedBySection(first.body), ["two/beta#7"]);

  const again = upsertBlockedBySection(first.body, ["two/beta#7", "two/beta#7"]);
  assert.equal(again.changed, false);
  assert.equal((again.body.match(/DSH-CROSS-REPO-BLOCKED-BY/g) ?? []).length, 1);

  const replaced = upsertBlockedBySection(first.body, ["three/gamma#9"]);
  assert.deepEqual(readBlockedBySection(replaced.body), ["three/gamma#9"]);
  assert.equal((replaced.body.match(/DSH-CROSS-REPO-BLOCKED-BY/g) ?? []).length, 1);

  const cleared = upsertBlockedBySection(first.body, []);
  assert.equal(readBlockedBySection(cleared.body).length, 0);
  assert.doesNotMatch(cleared.body, /DSH-CROSS-REPO-BLOCKED-BY/);
  assert.equal(renderBlockedBySection([]), "");
});

/* ---------------------------------------------------------------- 验收票 */

test("验收票必须有主：缺票或没有 assignee 都拒绝建票", () => {
  assert.match(acceptanceTicketProblem({ exists: false }), /验收票/);
  assert.match(acceptanceTicketProblem(null), /验收票/);
  assert.match(acceptanceTicketProblem({ exists: true, assignees: [] }), /没有主/);
  assert.match(acceptanceTicketProblem({ exists: true, assignees: ["  "] }), /没有主/);
  assert.equal(acceptanceTicketProblem({ exists: true, assignees: ["qa"] }), null);
});

test("验收票只挂已存在的票：同仓库原生边、跨仓库正文区段", () => {
  const sameRepo = acceptanceCounterpartLink({
    hasWorkTicket: true,
    workTicketRef: "#42",
    crossRepo: false,
  });
  assert.equal(sameRepo.ok, true);
  assert.equal(sameRepo.kind, "native-blockedBy");
  assert.equal(sameRepo.ref, "#42");

  const crossRepo = acceptanceCounterpartLink({
    counterpart: { area: "saas", hasWorkTicket: true },
    workTicketRef: "two/beta#42",
    crossRepo: true,
  });
  assert.equal(crossRepo.ok, true);
  assert.equal(crossRepo.kind, "body-blockedBy");
  assert.match(crossRepo.section, /Blocked by: two\/beta#42/);

  // crossRepo 没传时必须按引用形状兜底：带仓库前缀的引用不能退化成原生边。
  const inferred = acceptanceCounterpartLink({ hasWorkTicket: true, workTicketRef: "two/beta#42" });
  assert.equal(inferred.ok, true);
  assert.equal(inferred.kind, "body-blockedBy");

  const projectKey = acceptanceCounterpartLink({ hasWorkTicket: true, workTicketRef: "beta#42" });
  assert.equal(projectKey.kind, "body-blockedBy");

  // 本仓库的 `#42` 仍然走原生边。
  const local = acceptanceCounterpartLink({ hasWorkTicket: true, workTicketRef: "#42" });
  assert.equal(local.kind, "native-blockedBy");
});

test("对方还在「待核」：不挂空边，改记正文一行", () => {
  const pending = acceptanceCounterpartLink({
    counterpart: { area: "saas", hasWorkTicket: false },
    workTicketRef: "two/beta#42",
    featureKey: "coupon",
  });
  assert.equal(pending.ok, true);
  assert.equal(pending.kind, "body-line");
  assert.equal(pending.line, `${ACCEPTANCE_COUNTERPART_LINE_PREFIX}feature_key=coupon`);

  // hasWorkTicket 未知（没给）也按「待核」处理：宁可记一行，也不挂空边。
  const unknown = acceptanceCounterpartLink({ featureKey: "coupon" });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.kind, "body-line");

  // 连 feature_key 都没有时也要落一行可读的话，不能返回空 blockedBy。
  const noFeature = acceptanceCounterpartLink({ counterpart: { hasWorkTicket: false } });
  assert.equal(noFeature.ok, true);
  assert.equal(noFeature.kind, "body-line");
  assert.match(noFeature.line, /还没有工作票/);
});

test("对方说有工作票却没给票号：拒绝，不造空边", () => {
  const broken = acceptanceCounterpartLink({ hasWorkTicket: true, workTicketRef: "  " });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /空边/);
});

test("关需求票：生成「验收：未验收（…#N）」持久记录，缺票也照常生成", () => {
  const withTicket = acceptanceRecordLine({ ticketNumber: "#123", closedOn: "2026-11-03" });
  assert.equal(withTicket, "验收：未验收（验收票 #123 仍开着，2026-11-03 关闭）");
  assert.match(acceptanceRecordLine({ ticketNumber: 123 }), /验收票 #123 仍开着/);

  // 没有验收票也不抛、不拒绝关票：只留一条可搜索的痕。
  const noTicket = acceptanceRecordLine({ closedOn: "2026-11-03" });
  assert.equal(noTicket, "验收：未验收（没有验收票，2026-11-03 关闭）");
  assert.ok(noTicket.startsWith(ACCEPTANCE_PENDING_LINE));

  // 给了票号但读不出来：如实记，不静默退化成「没有验收票」。
  const unreadable = acceptanceRecordLine({ ticketNumber: "abc" });
  assert.equal(unreadable, "验收：未验收（验收票编号不可读「abc」）");
  assert.ok(unreadable.startsWith(ACCEPTANCE_PENDING_LINE));
});

test("板上「未验收」标记读正文里那一行，票关着也读得到", () => {
  const body = "正文\n验收：未验收（验收票 #123 仍开着，2026-11-03 关闭）\n";
  assert.equal(hasPendingAcceptanceRecord(body), true);
  assert.equal(hasPendingAcceptanceRecord("正文\n验收：通过（#123）"), false);
  assert.equal(hasPendingAcceptanceRecord(null), false);
});

/* ---------------------------------------------------------------- 契约变更记录 */

test("影响面那行变更：两边票面各一条 + 一条 kind:contract，不造群消息", () => {
  const result = contractChangeArtifacts({
    requirementKey: "#12",
    field: "契约摘要",
    reason: "coupon/apply 的 discount 字段改名",
    impacted: ["kxhyapp.com#12", "kxhyapp.com-saas#13"],
    at: "2026-11-03",
    by: "saas 的经理",
  });
  assert.equal(result.ok, true);

  const { notes, coordination } = result.artifacts;
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((note) => note.ref), ["kxhyapp.com#12", "kxhyapp.com-saas#13"]);
  for (const note of notes) {
    assert.match(note.body, /契约摘要/);
    assert.match(note.body, /discount 字段改名/);
    assert.match(note.body, /Refs: #12/);
  }

  assert.equal(coordination.kind, "contract");
  assert.equal(coordination.field, "契约摘要");
  assert.match(coordination.taskSummary, /discount 字段改名/);
  assert.equal(coordination.at, "2026-11-03");
  assert.equal("groupMessage" in result.artifacts, false);
});

test("契约变更：重复 impacted 去重；没给票号 / 时间 / 记录人时仍可用", () => {
  const result = contractChangeArtifacts({
    field: "契约摘要",
    reason: "字段改名",
    impacted: ["a#1", "a#1", "b#2"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.artifacts.notes.map((note) => note.ref), ["a#1", "b#2"]);
  assert.equal(result.artifacts.coordination.at, null);
  assert.equal(result.artifacts.coordination.by, null);
  assert.doesNotMatch(result.artifacts.notes[0].body, /Refs:/);
});

test("契约变更缺字段 / 缺原因 / 没有受影响票面：明确拒绝", () => {
  const noField = contractChangeArtifacts({ field: " ", reason: "x", impacted: ["a#1"] });
  assert.equal(noField.ok, false);
  assert.match(noField.reason, /字段/);

  const noReason = contractChangeArtifacts({ field: "契约摘要", reason: "", impacted: ["a#1"] });
  assert.equal(noReason.ok, false);
  assert.match(noReason.reason, /为什么/);

  const noRefs = contractChangeArtifacts({ field: "契约摘要", reason: "x", impacted: [] });
  assert.equal(noRefs.ok, false);
  assert.match(noRefs.reason, /受影响/);
});
