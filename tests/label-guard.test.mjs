import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertLabelsReadable } from "../server/tracker/label-guard.ts";
import { fakeGh } from "./helpers/fake-gh.mjs";

/**
 * 「整体替换标签」的前置守卫。
 *
 * 这条不变量必须成立在领域层：MCP 工具和面板 RPC 都走它。所以这里测的是
 * 「读到的标签少于远端总数时拒绝」，而不是某个调用方有没有记得先查。
 */

function detailPayload(labelCount, labels) {
  const nodes = Array.from({ length: labels }, (_, index) => ({ name: `label-${index + 1}`, color: "cccccc" }));
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number: 42,
          title: "一张票",
          state: "OPEN",
          url: "https://github.com/acme/deck/issues/42",
          updatedAt: "2026-10-01T00:00:00Z",
          body: "",
          labels: { totalCount: labelCount, nodes },
          assignees: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
        },
      },
    },
  });
}

/** 把回包落到独立临时目录：同名文件不会在用例之间打架。 */
function responseFile(payload) {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-label-guard-"));
  const file = path.join(dir, "detail.json");
  writeFileSync(file, payload, "utf8");
  return file;
}

test("标签读不全：拒绝整体替换，并说清读到几个、一共几个", async () => {
  const gh = fakeGh(`cat "${responseFile(detailPayload(25, 20))}"`);
  try {
    const guard = await assertLabelsReadable("acme", "deck", 42);
    assert.equal(guard.ok, false);
    assert.equal(guard.reason, "labels-truncated");
    assert.match(guard.detail, /20 个/);
    assert.match(guard.detail, /25 个/);
  } finally {
    gh.restore();
  }
});

test("标签读全了：放行", async () => {
  const gh = fakeGh(`cat "${responseFile(detailPayload(3, 3))}"`);
  try {
    assert.deepEqual(await assertLabelsReadable("acme", "deck", 42), { ok: true });
  } finally {
    gh.restore();
  }
});

test("票不存在：把领域层的 not-found 原样透出，不吞成 labels-truncated", async () => {
  const missing = JSON.stringify({
    data: { repository: { issue: null } },
    errors: [{ message: "Could not resolve to an Issue" }],
  });
  const gh = fakeGh(`cat "${responseFile(missing)}"`);
  try {
    const guard = await assertLabelsReadable("acme", "deck", 999);
    assert.equal(guard.ok, false);
    assert.equal(guard.reason, "not-found");
  } finally {
    gh.restore();
  }
});
