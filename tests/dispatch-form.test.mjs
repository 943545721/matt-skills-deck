import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDispatchTask } from "../shared/dispatch-form.ts";

/**
 * 派单台表单 → `deck.orchestration.dispatch` 入参。
 *
 * 钉住的是「面板不该让用户白跑一趟」的那几条：空提示词、名册非空却没选卡、
 * 没填需求票号或票号不是正整数、区域只填一半。剩下的（链条、归属、层数）都是服务端的
 * 判定，这里不重复实现。
 */

const base = { key: "k1", prompt: "把登录接口加上验证码", requirementNumber: 42 };

test("派单台：提示词 + 需求票号是最少的一份，其余字段不填就不出现", () => {
  const result = buildDispatchTask(base);
  assert.equal(result.ok, true);
  assert.deepEqual(result.task, {
    key: "k1",
    prompt: "把登录接口加上验证码",
    requirementKey: 42,
  });
});

test("派单台：可选字段去掉首尾空白，空串等于没填", () => {
  const result = buildDispatchTask({
    ...base,
    title: "  加验证码  ",
    staffId: "  staff-back ",
    repoKey: "  ",
    pathPrefix: "",
    requirementNumber: 42,
    requirementRepoKey: "  ",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.task, {
    key: "k1",
    prompt: "把登录接口加上验证码",
    title: "加验证码",
    staff: "staff-back",
    requirementKey: 42,
  });
});

test("派单台：挂了需求就把票号与需求仓库一起带上", () => {
  const result = buildDispatchTask({
    ...base,
    requirementNumber: 42,
    requirementRepoKey: "owner/repo",
  });
  assert.equal(result.ok, true);
  assert.equal(result.task.requirementKey, 42);
  assert.equal(result.task.requirementRepoKey, "owner/repo");
});

test("派单台：区域只在真的写了东西时出现，写一半也照原样带上", () => {
  const onlyPath = buildDispatchTask({ ...base, pathPrefix: "apps/web" });
  assert.deepEqual(onlyPath.task.region, { pathPrefix: "apps/web" });

  const both = buildDispatchTask({ ...base, repoKey: "owner/repo", pathPrefix: "apps/web" });
  assert.deepEqual(both.task.region, { repoKey: "owner/repo", pathPrefix: "apps/web" });
  assert.equal(both.task.repoKey, "owner/repo", "任务级 repoKey 与 region.repoKey 一起给，服务端两个都会看");

  const neither = buildDispatchTask(base);
  assert.equal("region" in neither.task, false);
});

test("派单台：空提示词 / 空 key / 名册非空没选卡都当场拒，不用等服务器", () => {
  const emptyPrompt = buildDispatchTask({ key: "k1", prompt: "   " });
  assert.equal(emptyPrompt.ok, false);
  assert.match(emptyPrompt.problem, /提示词不能为空/);

  const emptyKey = buildDispatchTask({ key: "  ", prompt: "干活" });
  assert.equal(emptyKey.ok, false);
  assert.match(emptyKey.problem, /key 不能为空/);

  const noStaff = buildDispatchTask({ ...base, staffRequired: true });
  assert.equal(noStaff.ok, false);
  assert.match(noStaff.problem, /先选一张卡/);

  // 名册非空但选了卡 → 放行；名册为空不要求选卡。
  assert.equal(buildDispatchTask({ ...base, staffRequired: true, staffId: "staff-back" }).ok, true);
  assert.equal(buildDispatchTask({ ...base, staffRequired: false }).ok, true);
});

test("派单台：多仓库工作区没选仓库当场拒，单仓库不要求", () => {
  const missing = buildDispatchTask({ ...base, repoRequired: true });
  assert.equal(missing.ok, false);
  assert.match(missing.problem, /多个仓库/);

  // 只写路径前缀不算选了仓库：服务端要的是仓库坐标。
  assert.equal(buildDispatchTask({ ...base, repoRequired: true, pathPrefix: "apps/web" }).ok, false);
  assert.equal(buildDispatchTask({ ...base, repoRequired: true, repoKey: " owner/repo " }).ok, true);
  assert.equal(buildDispatchTask({ ...base, repoRequired: false }).ok, true);
});

test("派单台：需求票号必填，空着当场拒", () => {
  for (const requirementNumber of [undefined, null]) {
    const result = buildDispatchTask({ key: "k1", prompt: "干活", requirementNumber });
    assert.equal(result.ok, false, String(requirementNumber));
    assert.match(result.problem, /需求票号必填/);
  }
});

test("派单台：需求票号必须是正整数，0 / 小数 / 负数都拒", () => {
  for (const requirementNumber of [0, -1, 2.5]) {
    const result = buildDispatchTask({ ...base, requirementNumber });
    assert.equal(result.ok, false, String(requirementNumber));
    assert.match(result.problem, /正整数/);
  }
});

test("派单台：提示词超长当场拒", () => {
  const result = buildDispatchTask({ key: "k1", prompt: "x".repeat(100_001) });
  assert.equal(result.ok, false);
  assert.match(result.problem, /最多 100000 字/);
});
