import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDerivedFrom, withDerivedFrom } from "../shared/derived.ts";

/**
 * 「需求票 → 地图票」这一行。
 *
 * 它只用一行文字承载一条关系，所以最容易出的错是「多读出一个票号」——把不相干的两张票
 * 连起来比不连更坏。四档各钉一条：正常解析、写坏不猜、覆盖不叠加、写进正文不破区块。
 */

const MAP_BODY = [
  "## Destination",
  "",
  "多项目工作区能协同。",
  "",
  "## Notes",
  "",
  "备注。",
  "",
].join("\n");

test("解析：正常一行给回票号", () => {
  assert.equal(parseDerivedFrom("Derived from: #19\n\n## Destination\n"), 19);
  assert.equal(parseDerivedFrom("Derived from: #19"), 19);
});

test("解析：没有这一行、写坏、票号非法都是 null（不猜）", () => {
  assert.equal(parseDerivedFrom(MAP_BODY), null);
  assert.equal(parseDerivedFrom("Derived from: #abc"), null);
  assert.equal(parseDerivedFrom("Derived from: #0"), null);
  assert.equal(parseDerivedFrom("Derived from: 19"), null);
  // 行内提到这句不是边：必须独占一行。
  assert.equal(parseDerivedFrom("这张图 Derived from: #19 是顺手写的"), null);
});

test("写入：放在最前面，且五个区块标题仍然能切", () => {
  const body = withDerivedFrom(MAP_BODY, 19);
  assert.ok(body.startsWith("Derived from: #19\n\n## Destination"), body);
  assert.equal(parseDerivedFrom(body), 19);
  // 只在最前加一行，区块内容一个字不动。
  assert.ok(body.endsWith(MAP_BODY.slice(MAP_BODY.indexOf("## Destination"))));
});

test("写入：已有这一行就覆盖，不叠加", () => {
  const once = withDerivedFrom(MAP_BODY, 19);
  const twice = withDerivedFrom(once, 21);
  assert.equal(parseDerivedFrom(twice), 21);
  assert.equal(twice.match(/^Derived from:/gm)?.length, 1);
  // 重复写同一个值是完全幂等的。
  assert.equal(withDerivedFrom(once, 19), once);
});

test("写入：空正文也能写出一行", () => {
  const body = withDerivedFrom("", 7);
  assert.equal(parseDerivedFrom(body), 7);
  assert.ok(body.endsWith("\n"));
});

test("写入后地图五区块仍然解析得出来（回归：标题前多一行不能挤进 Destination）", async () => {
  const { parseMapBody } = await import("../server/tracker/map-body.ts");
  const body = withDerivedFrom(
    ["## Destination", "", "目的地一句。", "", "## Out of scope", "", "- 不做聚合页", ""].join("\n"),
    19,
  );
  const parsed = parseMapBody(body);
  assert.equal(parsed.destination, "目的地一句。");
  assert.deepEqual(parsed.outOfScope, ["- 不做聚合页"]);
});
