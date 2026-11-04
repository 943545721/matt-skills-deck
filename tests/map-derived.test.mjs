import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { mapHandler } from "../server/rpc/map.ts";
import { mapsDerivedFrom } from "../server/tracker/derived.ts";
import { groupRows } from "../client/deck/board/groupRows.ts";
import { listIssuesHandler } from "../server/rpc/issues.ts";
import { createLocalIssue, getLocalIssue, setLocalIssueState } from "../server/tracker/local.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";

/**
 * 「地图是从哪条需求长出来的」这一位要一路走到地图页。
 *
 * 它在地图正文里只占一行（`Derived from: #19`），因此有三处容易断：
 * 读路径没解析、RPC 契约没带、界面拿不到。这里钉前两处，界面靠类型检查。
 */

const sandboxes = [];

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  setSettingsForTest(DEFAULT_SETTINGS);
});

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-map-derived-"));
  sandboxes.push(dir);
  setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "local" });
  return dir;
}

const MAP_BODY = ["## Destination", "", "先把边接上。", "", "## Notes", "", "备注。", ""].join("\n");

/** 建一张需求 + 两张地图：一张写了来源，一张没写。 */
async function seed(ws) {
  const requirement = await createLocalIssue(ws, { title: "需求：来源边", body: "问题一节。", labels: ["requirement"] });
  const withSource = await createLocalIssue(ws, {
    title: "地图（有来源）",
    body: `Derived from: #${requirement.number}\n\n${MAP_BODY}`,
    labels: ["wayfinder:map"],
  });
  const withoutSource = await createLocalIssue(ws, {
    title: "地图（无来源）",
    body: MAP_BODY,
    labels: ["wayfinder:map"],
  });
  return { requirement, withSource, withoutSource };
}

test("地图页拿到 derivedFrom：正文里写了来源就给票号", async () => {
  const ws = workspace();
  const { requirement, withSource } = await seed(ws);

  const result = await mapHandler({ workspaceDir: ws, number: withSource.number });
  assert.equal(result.ok, true);
  assert.equal(result.derivedFrom, requirement.number);
});

test("正文里没有这一行时是 null，不是缺省（界面据此区分「没写」与「没读」）", async () => {
  const ws = workspace();
  const { withoutSource } = await seed(ws);

  const result = await mapHandler({ workspaceDir: ws, number: withoutSource.number });
  assert.equal(result.ok, true);
  assert.equal(result.derivedFrom, null);
});

test("票面详情也带着这一位：需求票点得进去，地图票显示「来自需求」", async () => {
  const ws = workspace();
  const { requirement, withSource } = await seed(ws);

  const detail = await getLocalIssue(ws, withSource.number);
  assert.equal(detail.ok, true);
  assert.equal(detail.issue.derivedFrom, requirement.number);

  // 需求票自己不写这一行：它那一侧靠反查。
  const source = await getLocalIssue(ws, requirement.number);
  assert.equal(source.issue.derivedFrom, null);
});

test("反查那一侧仍然对得上：需求 → 建出的地图", async () => {
  const ws = workspace();
  const { requirement, withSource } = await seed(ws);

  const reversed = await mapsDerivedFrom(ws, { number: requirement.number });
  assert.equal(reversed.ok, true);
  assert.deepEqual(reversed.maps.map((map) => map.number), [withSource.number]);
});

test("任务板上地图挂在需求下面：需求展开就是地图，地图展开是它的子票", async () => {
  const ws = workspace();
  const { requirement, withSource } = await seed(ws);
  await setLocalIssueState(ws, withSource.number, "CLOSED");

  const board = await listIssuesHandler({ workspaceDir: ws, view: "all" });
  assert.equal(board.ok, true);

  const mapRow = board.issues.find((issue) => issue.number === withSource.number);
  // 板子把引用边翻成父子边：地图的 parentKey 指向需求，分组自己去缩进。
  assert.equal(mapRow?.parentKey, String(requirement.number));

  const rows = groupRows(board.issues, new Set());
  const depthOf = (number) => rows.find((row) => row.item.number === number)?.depth;
  assert.equal(depthOf(requirement.number), 0);
  assert.equal(depthOf(withSource.number), 1);
});

test("正文里没有来源的地图仍然在顶层，不凭空挂到别人下面", async () => {
  const ws = workspace();
  const { withoutSource } = await seed(ws);

  const board = await listIssuesHandler({ workspaceDir: ws, view: "all" });
  assert.equal(board.ok, true);
  const row = board.issues.find((issue) => issue.number === withoutSource.number);
  assert.equal(row?.parentKey ?? null, null);
});
