import assert from "node:assert/strict";
import test from "node:test";
import {
  directTargetOf,
  displayTargetOf,
  liveProfileOf,
  modelChoicesOf,
  profileWithoutModel,
  withRoute,
} from "../client/deck/surfaces/orchestration/types.ts";
import { resolveRouteTarget } from "../shared/orchestration.ts";

/**
 * 路由页「点哪一行会落到谁身上」与「能点哪些模型」这两个判断。
 *
 * 用户的原话是「这个模型为什么不能选呢」——所以这里要钉住的不只是「候选从宿主来」，
 * 还有几种空清单必须分开说：客户端没了、客户端在但没报模型、压根还没选客户端。
 * 混成一句「没有模型」会把人骗去手打一个没人认的 id。
 */

const profiles = [
  { id: "fast", name: "快", provider: "claude", model: "haiku" },
  // 没写模型的档案：宿主只认 provider/model，这档派不出去。
  { id: "bare", name: "裸档案", provider: "claude" },
];

const providers = [
  { id: "claude", models: ["claude-opus-5", "claude-fable-5"] },
  { id: "codex", models: [] },
];

const row = (patch = {}) => ({
  difficulty: "normal",
  profileId: null,
  target: null,
  resolved: { ok: false, reason: "no-target", detail: "未配置" },
  ...patch,
});

test("直选：没有档案时，目标就是配置里的那条", () => {
  const target = { provider: "claude", model: "claude-opus-5" };
  assert.deepEqual(directTargetOf(row({ target }), profiles), target);
});

test("直选：档案还活着时，配置里那条被它盖住", () => {
  const target = { provider: "codex" };
  assert.equal(
    directTargetOf(row({ profileId: "fast", target }), profiles),
    null,
    "档案优先：这时点模型写回 target 会顺手删掉 profileId，把一个好好的档改成直选",
  );
});

test("直选：档案已经被删掉时，回落到配置里那条（否则就只剩手打）", () => {
  const target = { provider: "codex" };
  assert.deepEqual(directTargetOf(row({ profileId: "已删除", target }), profiles), target);
});

test("直选：档案和 target 都没有就是空", () => {
  assert.equal(directTargetOf(row(), profiles), null);
});

test("档案没写模型：指得出是哪一份档案", () => {
  assert.equal(profileWithoutModel(row({ profileId: "bare" }), profiles)?.name, "裸档案");
});

test("档案没写模型：写了模型、或档案不存在、或压根没走档案时都不算", () => {
  assert.equal(profileWithoutModel(row({ profileId: "fast" }), profiles), null);
  assert.equal(profileWithoutModel(row({ profileId: "已删除" }), profiles), null);
  assert.equal(profileWithoutModel(row({ target: { provider: "claude" } }), profiles), null);
});

test("候选：宿主报了什么就点什么", () => {
  assert.deepEqual(modelChoicesOf("claude", providers), { kind: "ok", models: ["claude-opus-5", "claude-fable-5"] });
});

test("候选：客户端在、但一个模型都没报出来（不能说成「客户端没了」）", () => {
  assert.deepEqual(modelChoicesOf("codex", providers), { kind: "ok", models: [] });
});

test("候选：宿主不认这个客户端时带上它的名字", () => {
  assert.deepEqual(modelChoicesOf("gemini", providers), { kind: "unknown-client", provider: "gemini" });
});

test("候选：还没选客户端就不谈模型", () => {
  assert.deepEqual(modelChoicesOf("   ", providers), { kind: "no-client" });
});

test("候选：宿主这一趟一个客户端都没报出来时不说「删了或改名了」", () => {
  assert.deepEqual(
    modelChoicesOf("claude", []),
    { kind: "host-empty" },
    "清单本身是空的，不能拿空集当「这个客户端已经不在了」的证据",
  );
});

test("走档案：与 resolveRouteTarget 判同一件事", () => {
  const rule = { profileId: "bare", target: { provider: "codex", model: "gpt-5" } };
  const resolved = resolveRouteTarget(rule, profiles);
  assert.equal(resolved.ok, false, "档案在、但没写模型：正本算坏，不回落");
  assert.equal(
    directTargetOf(row(rule), profiles),
    null,
    "界面这侧也不许回落到 target：两边说不到一起，用户会以为点模型能救这一档",
  );
  assert.equal(liveProfileOf(row(rule), profiles)?.id, "bare", "但要说得出坏在哪一份档案上");
});

test("走档案：profileId 带空白也认（与 resolveRouteTarget 一样先 trim）", () => {
  assert.equal(liveProfileOf(row({ profileId: "  fast  " }), profiles)?.id, "fast");
});

test("行上印的那条：解析成功了就照解析结果", () => {
  const resolved = { ok: true, via: "target", target: { provider: "claude", model: "claude-opus-5" } };
  assert.deepEqual(displayTargetOf(row({ target: resolved.target, resolved }), profiles), resolved.target);
});

test("行上印的那条：档案缺模型时印出那份档案，不印「未配置」", () => {
  const shown = displayTargetOf(row({ profileId: "bare", resolved: { ok: false, reason: "no-model", detail: "x" } }), profiles);
  assert.equal(shown?.provider, "claude", "用户明明配了一份档案，行上写「未配置」就是把他配过的事情抹掉");
});

test("行上印的那条：什么都没有才是空", () => {
  assert.equal(displayTargetOf(row(), profiles), null);
});

test("点选写回：只换模型，客户端留着；这一档不再挂档案（整条替换）", () => {
  const settings = {
    routing: [{ difficulty: "normal", profileId: "已删除", target: { provider: "claude", model: "旧模型" } }],
  };
  const next = withRoute(settings, "normal", { target: { provider: "claude", model: "claude-fable-5" } });
  assert.deepEqual(next.routing, [{ difficulty: "normal", target: { provider: "claude", model: "claude-fable-5" } }]);
});
