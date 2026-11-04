import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceFactsOf,
  acceptanceLinkFor,
  judgeTaskChain,
  readTicketFact,
} from "../server/contract-chain.ts";

/**
 * 跨区链条的服务端读事实层。
 *
 * 全部用注入的假 reader：不碰网络、不碰真实 git、不读 `.deck/`。
 * 这里钉住的是「读事实的边界」——票不存在与读失败必须分开，
 * 读失败绝不能被 downstream 当成「已解除」或「没有验收票」。
 */

const WS = "/tmp/contract-chain-server-test-no-io";

/**
 * facts 的键是 `repoKey#number`；值：
 *   - 对象：票存在，按对象覆盖默认的 `{ exists:true, closed:false, assignees:[] }`
 *   - "missing"：后端明确回答「没有这张票」
 *   - "throw"：读失败（异常）
 *   - 缺省：读失败（返回 null）
 */
function fakeReader(facts = {}, calls = []) {
  return async (ref) => {
    calls.push({ repoKey: ref.repoKey ?? null, number: ref.number });
    const key = `${ref.repoKey ?? "default"}#${ref.number}`;
    const value = facts[key];
    if (value === "throw") throw new Error(`backend down for #${ref.number}`);
    if (value === "missing") return { exists: false, closed: false, assignees: [] };
    if (value === undefined) return null;
    return { exists: true, closed: false, assignees: [], ...value };
  };
}

/* ------------------------------------------------------------------ 三级：等 #N */

test("等 #N：对方票已关 → ok，且只读被依赖的那一张", async () => {
  const calls = [];
  const reader = fakeReader(
    { "saas#12": { closed: true, assignees: ["dev"] } },
    calls,
  );

  const verdict = await judgeTaskChain(
    WS,
    {
      chain: "等 #12",
      counterpart: { area: "saas", repo: "kxhyapp.com-saas", repoKey: "saas", detailTicket: 34 },
    },
    reader,
  );

  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, "depends");
  assert.equal(verdict.chain.waitingTicket, 12);
  assert.deepEqual(verdict.warnings, []);
  assert.deepEqual(calls, [{ repoKey: "saas", number: 12 }]);
});

test("等 #N：对方票没关 → 拒绝，文案含票号", async () => {
  const reader = fakeReader({ "saas#12": { closed: false } });

  const verdict = await judgeTaskChain(
    WS,
    { chain: "等 #12", counterpart: { area: "saas", repoKey: "saas" } },
    reader,
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /#12/);
  assert.match(verdict.reason, /还没关/);
});

test("等 #N：对方票不存在 → 拒绝（不是读失败，也不是已解除）", async () => {
  const reader = fakeReader({ "saas#99": "missing" });

  const verdict = await judgeTaskChain(
    WS,
    { chain: "等 #99", counterpart: { area: "saas", repoKey: "saas" } },
    reader,
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /#99/);
  assert.match(verdict.reason, /不存在/);
  assert.doesNotMatch(verdict.reason, /还没关/);
});

test("等 #N：reader 抛异常 → 拒绝且不崩，理由含票号 / 仓库 / 「不默认已核」", async () => {
  const reader = fakeReader({ "saas#12": "throw" });

  const verdict = await judgeTaskChain(
    WS,
    { chain: "等 #12", counterpart: { area: "saas", repoKey: "saas" } },
    reader,
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /读不到/);
  assert.match(verdict.reason, /不默认已核/);
  assert.match(verdict.reason, /#12/);
  assert.match(verdict.reason, /saas/);
  assert.equal(verdict.level, "depends");
  assert.equal(verdict.chain.kind, "depends");
  assert.equal(verdict.warnings.length, 1);
  assert.equal(verdict.warnings[0], verdict.reason);
  // 异常原文要保留在理由里，不能只剩一句笼统的「读不到」。
  assert.match(verdict.reason, /backend down/);
});

test("等 #N：reader 返回 null → 同样按读不到拒绝，不默认已核", async () => {
  const reader = fakeReader({});

  const verdict = await judgeTaskChain(
    WS,
    { chain: "等 #12", counterpart: { repoKey: "saas" } },
    reader,
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /读不到/);
  assert.match(verdict.reason, /不默认已核/);
  assert.equal(verdict.warnings.length, 1);
});

/* ------------------------------------------------------------------ 二级：详见 #N */

test("详见 #N：只读「详见」指向的那一张，不去读 waitingTicket", async () => {
  const calls = [];
  const reader = fakeReader({ "saas#34": { closed: false } }, calls);

  const verdict = await judgeTaskChain(
    WS,
    {
      chain: "详见 #34",
      counterpart: {
        area: "saas",
        repoKey: "saas",
        waitingTicket: 12,
        detailTicket: 34,
      },
    },
    reader,
  );

  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, "contract");
  assert.equal(verdict.chain.detailTicket, 34);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { repoKey: "saas", number: 34 });
});

test("详见 #N：契约票已关 → 拒绝（只认存在且开着）", async () => {
  const reader = fakeReader({ "saas#34": { closed: true } });

  const verdict = await judgeTaskChain(
    WS,
    { chain: "详见 #34", counterpart: { repoKey: "saas" } },
    reader,
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /#34/);
  assert.match(verdict.reason, /已经关了/);
});

test("详见 #N：读不到契约票 → 拒绝并带读票失败 warning", async () => {
  const reader = fakeReader({ "saas#34": "throw" });

  const verdict = await judgeTaskChain(
    WS,
    { chain: "详见 #34", counterpart: { repoKey: "saas" } },
    reader,
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /读不到/);
  assert.match(verdict.reason, /不默认已核/);
  assert.match(verdict.reason, /#34/);
  assert.equal(verdict.warnings.length, 1);
});

/* ------------------------------------------------------------------ 其它分支 */

test("第五列留空且跨仓库 → ok + 一条警告，且一张票都不读", async () => {
  const calls = [];
  const reader = fakeReader({}, calls);

  const verdict = await judgeTaskChain(
    WS,
    { chain: "", crossRepo: true, counterpart: { area: "saas" } },
    reader,
  );

  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, "unrelated");
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0], /只警告/);
  assert.match(verdict.warnings[0], /saas/);
  assert.equal(calls.length, 0);
});

test("第五列格式不对 → 直接拒绝，不读任何票", async () => {
  const calls = [];
  const reader = fakeReader({}, calls);

  const verdict = await judgeTaskChain(
    WS,
    { chain: "契约: POST /x", counterpart: { repoKey: "saas", waitingTicket: 12 } },
    reader,
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.level, null);
  assert.equal(verdict.chain, null);
  assert.equal(calls.length, 0);
});

test("readTicketFact：票不存在 → exists:false；读失败 → null（两者不混）", async () => {
  const missing = await readTicketFact(
    WS,
    { repoKey: "saas", number: 99 },
    fakeReader({ "saas#99": "missing" }),
  );
  assert.deepEqual(missing, { exists: false, closed: false });

  const broken = await readTicketFact(
    WS,
    { repoKey: "saas", number: 12 },
    fakeReader({ "saas#12": "throw" }),
  );
  assert.equal(broken, null);

  const closed = await readTicketFact(
    WS,
    { repoKey: "saas", number: 12 },
    fakeReader({ "saas#12": { closed: true } }),
  );
  assert.deepEqual(closed, { exists: true, closed: true });
});

/* ------------------------------------------------------------------ 入参健壮性 */

test("公开函数对 undefined / 非法票号不抛异常，也不冒充「票不存在」", async () => {
  // 传 undefined：读票函数返回 null，判定函数按「没声明链条」处理。
  await assert.doesNotReject(() => readTicketFact(WS, undefined));
  assert.equal(await readTicketFact(WS, undefined), null);
  await assert.doesNotReject(() => acceptanceFactsOf(WS, undefined));

  const problem = await acceptanceFactsOf(WS, undefined);
  assert.match(problem, /读不到/);
  assert.match(problem, /票号无效/);
  assert.match(problem, /不当作/);

  const verdict = await judgeTaskChain(WS, undefined);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, "unrelated");

  // 非法票号明确写「票号无效」，不和「票不存在」混。
  const invalid = await acceptanceFactsOf(WS, { repoKey: "saas", number: 0 });
  assert.match(invalid, /票号无效/);
  assert.doesNotMatch(invalid, /不存在/);

  await assert.doesNotReject(() => acceptanceLinkFor(WS, undefined));
  const link = await acceptanceLinkFor(WS, undefined);
  assert.equal(link.ok, false);
});

/* ------------------------------------------------------------------ 验收票 */

test("验收票没有 assignee → 拒绝；有 assignee → 通过（null）", async () => {
  const noOwner = await acceptanceFactsOf(
    WS,
    { repoKey: "saas", number: 7 },
    fakeReader({ "saas#7": { assignees: [] } }),
  );
  assert.match(noOwner, /没有主/);

  const blankOwner = await acceptanceFactsOf(
    WS,
    { repoKey: "saas", number: 7 },
    fakeReader({ "saas#7": { assignees: ["  "] } }),
  );
  assert.match(blankOwner, /没有主/);

  const owned = await acceptanceFactsOf(
    WS,
    { repoKey: "saas", number: 7 },
    fakeReader({ "saas#7": { assignees: ["qa"] } }),
  );
  assert.equal(owned, null);
});

test("验收票不存在 → 拒绝建验收票；读失败 → 可操作拒绝理由（不是 null）", async () => {
  const missing = await acceptanceFactsOf(
    WS,
    { repoKey: "saas", number: 7 },
    fakeReader({ "saas#7": "missing" }),
  );
  assert.match(missing, /验收票/);
  assert.doesNotMatch(missing, /没有主/);

  const broken = await acceptanceFactsOf(
    WS,
    { repoKey: "saas", number: 7 },
    fakeReader({ "saas#7": "throw" }),
  );
  assert.ok(broken);
  assert.match(broken, /读不到/);
  assert.match(broken, /#7/);
  assert.match(broken, /saas/);
});

test("acceptanceLinkFor：说有工作票却没给票号 → 保持 shared 的拒绝文案，不造边", async () => {
  const link = await acceptanceLinkFor(WS, { hasWorkTicket: true, workTicketRef: "  " });
  assert.equal(link.ok, false);
  assert.match(link.reason, /空边/);
  assert.equal("kind" in link, false);
});

test("acceptanceLinkFor：给了票号就按 shared 的规则挂原生边 / 正文区段", async () => {
  const native = await acceptanceLinkFor(WS, { hasWorkTicket: true, workTicketRef: "#42", crossRepo: false });
  assert.equal(native.ok, true);
  assert.equal(native.kind, "native-blockedBy");

  const cross = await acceptanceLinkFor(WS, { hasWorkTicket: true, workTicketRef: "two/beta#42" });
  assert.equal(cross.ok, true);
  assert.equal(cross.kind, "body-blockedBy");
});
