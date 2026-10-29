import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeNewIssueRepoKey,
  planBugSubmission,
  planCurrentSettleNotice,
  planLateFailure,
  planLateSuccess,
  sameNewIssueDraft,
  stripMapLabelFromNonMapModes,
  writableNewIssueRepos,
} from "../shared/new-issue.ts";

const repos = [
  { key: "acme/app", name: "app", readOnly: false },
  { key: "acme/site", name: "site", readOnly: false },
  { key: "readonly/group/project", name: "project", readOnly: true },
];

const blank = { actual: "", expected: "", reproduce: "", environment: "" };
const full = { actual: "点保存没反应", expected: "保存成功", reproduce: "1. 打开票\n2. 点保存", environment: "Linux / Chrome 140" };

test("只读仓库不进新建目标", () => {
  assert.deepEqual(
    writableNewIssueRepos(repos).map((repo) => repo.key),
    ["acme/app", "acme/site"],
  );
  assert.deepEqual(writableNewIssueRepos([repos[2]]), []);
});

test("默认仓库：手选 > 当前筛选 > 第一个可写；只读的一律跳过", () => {
  assert.equal(activeNewIssueRepoKey(repos, "acme/site", "acme/app"), "acme/site");
  assert.equal(activeNewIssueRepoKey(repos, "readonly/group/project", "acme/app"), "acme/app");
  assert.equal(activeNewIssueRepoKey(repos, null, null), "acme/app");
  assert.equal(activeNewIssueRepoKey([repos[2]], null, "acme/app"), null);
  assert.equal(activeNewIssueRepoKey([], null, null), null);
});

test("「实际」为空或纯空白时不能建缺陷票", () => {
  for (const actual of ["", "   ", "\n\t"]) {
    const plan = planBugSubmission({ ...full, actual }, false);
    assert.equal(plan.canCreate, false);
    assert.equal(plan.incomplete, false);
    assert.deepEqual(plan.labels, ["bug", "needs-triage"]);
  }
});

test("只填「实际」可以建，但其它字段缺项要标 needs-info", () => {
  const plan = planBugSubmission({ ...blank, actual: "点保存没反应" }, true);
  assert.equal(plan.canCreate, true);
  assert.equal(plan.incomplete, true);
  assert.deepEqual(plan.labels, ["bug", "needs-info"]);
});

test("四个字段齐全：已诊断只带 bug，未诊断再加 needs-triage", () => {
  assert.deepEqual(planBugSubmission(full, true), {
    canCreate: true,
    incomplete: false,
    labels: ["bug"],
  });
  assert.deepEqual(planBugSubmission(full, false), {
    canCreate: true,
    incomplete: false,
    labels: ["bug", "needs-triage"],
  });
});

test("需求 / 缺陷模式移除手输的 wayfinder:map，普通标签与输入数组不变", () => {
  const labels = ["bug", "wayfinder:map", "needs-info"];
  assert.deepEqual(stripMapLabelFromNonMapModes(labels), ["bug", "needs-info"]);
  assert.deepEqual(labels, ["bug", "wayfinder:map", "needs-info"]);
  assert.deepEqual(stripMapLabelFromNonMapModes([]), []);
  assert.deepEqual(stripMapLabelFromNonMapModes(["wayfinder:map"]), []);
});

test("迟到成功只在草稿未被改过时判定为可清空", () => {
  const base = {
    title: "保存无响应",
    body: "备注",
    labels: "bug",
    mode: "bug",
    bug: { ...full },
    bugDiagnosed: false,
    isMap: false,
    copyPrompt: true,
    repoKey: "acme/app",
  };
  assert.equal(sameNewIssueDraft(base, { ...base, title: "  保存无响应  " }), true);
  assert.equal(sameNewIssueDraft(base, { ...base, body: "改过" }), false);
  assert.equal(sameNewIssueDraft(base, { ...base, bug: { ...base.bug, expected: "改过" } }), false);
  assert.equal(sameNewIssueDraft(base, { ...base, mode: "explore" }), false);
  assert.equal(sameNewIssueDraft(base, { ...base, copyPrompt: false }), false);
  // 只换目标仓库也算改了草稿，迟到成功不能清掉新目标。
  assert.equal(sameNewIssueDraft(base, { ...base, repoKey: "acme/site" }), false);
  assert.equal(sameNewIssueDraft(base, { ...base, repoKey: null }), false);
});

test("迟到成功：有更新的提交时保留草稿、不动剪贴板", () => {
  const during = planLateSuccess({
    newerPending: true,
    newerSettled: false,
    newerUnsettled: false,
    draftUnchanged: true,
    remainingUnsettled: 0,
  });
  assert.deepEqual(during, {
    draft: "keep",
    notice: "still-pending",
    unseen: false,
    copyPrompt: false,
  });

  const after = planLateSuccess({
    newerPending: false,
    newerSettled: true,
    newerUnsettled: false,
    draftUnchanged: true,
    remainingUnsettled: 0,
  });
  assert.deepEqual(after, {
    draft: "keep",
    notice: "after-new-submit",
    unseen: false,
    copyPrompt: false,
  });
});

test("迟到成功：0 / 1 / 2 个未结算旧请求都算 unseen，草稿未改才清空", () => {
  for (const remainingUnsettled of [1, 2]) {
    const plan = planLateSuccess({
      newerPending: false,
      newerSettled: false,
      newerUnsettled: false,
      draftUnchanged: true,
      remainingUnsettled,
    });
    assert.equal(plan.unseen, true);
    assert.equal(plan.draft, "clear");
    assert.equal(plan.notice, "cleared");
    assert.equal(plan.copyPrompt, true);
  }

  const settled = planLateSuccess({
    newerPending: false,
    newerSettled: false,
    newerUnsettled: false,
    draftUnchanged: true,
    remainingUnsettled: 0,
  });
  assert.equal(settled.unseen, false);
  assert.equal(settled.draft, "clear");

  const edited = planLateSuccess({
    newerPending: false,
    newerSettled: false,
    newerUnsettled: false,
    draftUnchanged: false,
    remainingUnsettled: 0,
  });
  assert.equal(edited.draft, "keep");
  assert.equal(edited.notice, "kept");
  assert.equal(edited.copyPrompt, true);
});

test("迟到成功：之后还有被强制关闭的提交时，不碰当前草稿 / 剪贴板", () => {
  const plan = planLateSuccess({
    newerPending: false,
    newerSettled: false,
    newerUnsettled: true,
    draftUnchanged: true,
    remainingUnsettled: 1,
  });
  assert.deepEqual(plan, {
    draft: "keep",
    notice: "newer-unsettled",
    unseen: true,
    copyPrompt: false,
  });

  // 更新的提交已结束、又有另一个未结算：以「已结束」为准，但仍带 unseen。
  const mixed = planLateSuccess({
    newerPending: false,
    newerSettled: true,
    newerUnsettled: true,
    draftUnchanged: true,
    remainingUnsettled: 1,
  });
  assert.deepEqual(mixed, {
    draft: "keep",
    notice: "after-new-submit",
    unseen: true,
    copyPrompt: false,
  });
});

test("当前提交结束：还剩未知请求或失败可能已建票时，保留「票可能已建」警告", () => {
  assert.equal(planCurrentSettleNotice(0), null);
  assert.deepEqual(planCurrentSettleNotice(1), { kind: "force-closed" });
  assert.deepEqual(planCurrentSettleNotice(2), { kind: "force-closed" });
  // 超时 / 5xx / 通道异常：失败不能证明没建，不能清警告。
  assert.deepEqual(planCurrentSettleNotice(0, true), { kind: "maybe-created" });
});

test("强制关闭的旧请求迟到失败：结果不确定或之后已建票时不能说「可以重新提交」", () => {
  assert.deepEqual(
    planLateFailure({ remainingUnsettled: 0, maybeCreated: false, newerPending: false, newerCreatedNumber: null }),
    { kind: "force-closed-failed", createdNumber: null },
  );
  // 还有别的未知请求：先继续警告，不能宣布「可以重提」。
  assert.deepEqual(
    planLateFailure({ remainingUnsettled: 1, maybeCreated: false, newerPending: false, newerCreatedNumber: 9 }),
    { kind: "force-closed" },
  );
  // 当前还有提交在进行：交给 busy 行，旧提示不保留。
  assert.equal(
    planLateFailure({ remainingUnsettled: 0, maybeCreated: false, newerPending: true, newerCreatedNumber: null }),
    null,
  );
  assert.deepEqual(
    planLateFailure({ remainingUnsettled: 0, maybeCreated: false, newerPending: false, newerCreatedNumber: 9 }),
    { kind: "force-closed-failed", createdNumber: 9 },
  );
  // 这次失败本身就可能已经建票：即使没有别的未知请求，也要先核对任务板。
  assert.deepEqual(
    planLateFailure({ remainingUnsettled: 0, maybeCreated: true, newerPending: false, newerCreatedNumber: null }),
    { kind: "maybe-created" },
  );
  // 有更新的成功票也不能把「可能已建」说成「可以重提」。
  assert.deepEqual(
    planLateFailure({ remainingUnsettled: 0, maybeCreated: true, newerPending: false, newerCreatedNumber: 9 }),
    { kind: "maybe-created" },
  );
});
