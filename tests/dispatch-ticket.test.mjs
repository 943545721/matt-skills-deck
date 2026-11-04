import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildDispatchTicket } from "../shared/orchestration.ts";
import { createDispatchTicket } from "../server/tracker/dispatch-ticket.ts";
import { getLocalIssue } from "../server/tracker/local.ts";
import { DEFAULT_SETTINGS, setSettingsForTest } from "../server/settings.ts";

/**
 * 派单建的票。
 *
 * 这里钉两件事：票面写对了什么（标题 / 标签 / 正文里的客户端与难度），
 * 以及本地后端缺什么能力时必须说出来——本地 `.deck/` 没有父票与幂等锚，
 * 悄悄少写这两样，等于让人以为「重试不会重复」「地图下面能看到它」。
 */

const sandboxes = [];

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  setSettingsForTest(DEFAULT_SETTINGS);
});

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-dispatch-ticket-"));
  sandboxes.push(dir);
  setSettingsForTest({ ...DEFAULT_SETTINGS, backend: "local" });
  return dir;
}

const BASE = {
  key: "t3",
  prompt: "## 重构接口层\n\n把 `readBoard` 拆开。\n",
  difficulty: "hard",
  providerSpec: "codex/gpt-5",
  dispatchId: "dsp_1",
  dispatcherAgentId: "agent-1",
  depth: 2,
};

test("标题取任务正文第一行，去掉 Markdown 记号", () => {
  assert.equal(buildDispatchTicket(BASE).title, "重构接口层");
  assert.equal(buildDispatchTicket({ ...BASE, prompt: "- 修一下排序\n再补测试" }).title, "修一下排序");
});

test("标题过长时截断，不留一整段正文当标题", () => {
  const title = buildDispatchTicket({ ...BASE, prompt: "长".repeat(200) }).title;
  assert.equal(title.length, 72);
  assert.match(title, /…$/);
});

test("没有正文首行可用时退回一个能对上的标题，不建空标题的票", () => {
  const spec = buildDispatchTicket({ ...BASE, prompt: "   \n\n##\n" });
  assert.equal(spec.title, "派单 dsp_1 任务 t3");
});

test("标签只放难度与客户端：模型进正文，不进标签", () => {
  const spec = buildDispatchTicket(BASE);
  assert.deepEqual(spec.labels, ["difficulty:hard", "client:codex"]);
});

test("正文写清客户端、模型、难度与地图；借来的路由也写明", () => {
  const spec = buildDispatchTicket({ ...BASE, map: "943545721/matt-skills-deck#2", routeFrom: "normal" });
  assert.match(spec.body, /执行客户端：`codex`（模型 `gpt-5`）/);
  assert.match(spec.body, /难度：`hard`/);
  assert.match(spec.body, /借用 normal 档的路由/);
  assert.match(spec.body, /地图：`943545721\/matt-skills-deck#2`/);
  // 任务正文原样在最前面，不再套一层标题。
  assert.ok(spec.body.startsWith("## 重构接口层"));
});

test("本地后端真建出一张带这些标签的票", async () => {
  const ws = workspace();
  const created = await createDispatchTicket(ws, BASE);
  assert.equal(created.ok, true);
  assert.equal(created.repoKey, "local");
  assert.deepEqual(created.labels.toSorted(), ["client:codex", "difficulty:hard"]);

  const detail = await getLocalIssue(ws, created.number);
  assert.equal(detail.ok, true);
  assert.equal(detail.issue.title, "重构接口层");
  // 详情里的标签是 {name,color}；建票回包给的是名字数组，两种形状都按名字比。
  assert.deepEqual(detail.issue.labels.map((label) => label.name).toSorted(), ["client:codex", "difficulty:hard"]);
  assert.match(detail.issue.body, /派单窗口：`agent-1`/);
  assert.match(detail.issue.body, /层级：第 2 层/);
  assert.deepEqual(created.notes, []);
});

test("本地 .deck 挂不了父票、也没有幂等锚：这两件事必须写进 notes", async () => {
  const ws = workspace();
  const created = await createDispatchTicket(ws, {
    ...BASE,
    map: "#2",
    idempotencyKey: "deck-dispatch-ws-1-t3",
  });
  assert.equal(created.ok, true);
  assert.equal(created.notes.length, 2);
  assert.match(created.notes.join("\n"), /没有父子字段/);
  assert.match(created.notes.join("\n"), /没有幂等锚/);
});
