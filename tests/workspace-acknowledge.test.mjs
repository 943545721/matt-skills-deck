import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acknowledgeShape } from "../server/workspace/config-write.ts";

/**
 * 「不再提示」写进配置的那一步。
 *
 * 两个边界最重要：只加/改 `coordination`，其它字段一个都不许动；
 * v1 与坏文件一律拒绝，绝不覆盖——覆盖了就变成「用户的项目清单没了」。
 */

const tmp = () => mkdtempSync(path.join(tmpdir(), "deck-ack-"));
const file = (root) => path.join(root, ".paseo-deck.json");
const read = (root) => JSON.parse(readFileSync(file(root), "utf8"));

test("v2 清单：只加 coordination.shape，项目与其它字段原样保留", async () => {
  const root = tmp();
  const original = {
    version: 2,
    projects: [{ key: "api", dir: "mall-api", owner: "backend", areas: ["orders"] }],
    extra: { note: "别动我" },
  };
  writeFileSync(file(root), JSON.stringify(original, null, 2));

  const result = await acknowledgeShape(root, "container");
  assert.equal(result.ok, true, JSON.stringify(result));
  const written = read(root);
  assert.deepEqual(written.projects, original.projects);
  assert.deepEqual(written.extra, original.extra);
  assert.deepEqual(written.coordination, { shape: "container" });
});

test("已有 coordination：只改 shape，note 留着", async () => {
  const root = tmp();
  writeFileSync(
    file(root),
    JSON.stringify({ version: 2, projects: [{ key: "api", dir: "api" }], coordination: { shape: "mixed", note: "先这么放" } }),
  );
  assert.equal((await acknowledgeShape(root, "container")).ok, true);
  assert.deepEqual(read(root).coordination, { shape: "container", note: "先这么放" });
});

test("没有配置文件 / v1 文件：拒绝，且一个字节都不改", async () => {
  const empty = tmp();
  const missing = await acknowledgeShape(empty, "container");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "no-config");

  const legacy = tmp();
  const text = '{\n  "repoDir": "alpha"\n}\n';
  writeFileSync(file(legacy), text);
  const refused = await acknowledgeShape(legacy, "container");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "v1");
  assert.equal(readFileSync(file(legacy), "utf8"), text);
});

test("坏 JSON 与非法形状：拒绝，文件不动", async () => {
  const root = tmp();
  writeFileSync(file(root), "{坏掉");
  const broken = await acknowledgeShape(root, "container");
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "invalid");
  assert.equal(readFileSync(file(root), "utf8"), "{坏掉");

  const good = tmp();
  writeFileSync(file(good), JSON.stringify({ version: 2, projects: [{ key: "api", dir: "api" }] }));
  const badShape = await acknowledgeShape(good, "group");
  assert.equal(badShape.ok, false);
  assert.equal(badShape.reason, "invalid");
  assert.equal(read(good).coordination, undefined);
});
