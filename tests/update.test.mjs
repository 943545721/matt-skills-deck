import assert from "node:assert/strict";
import { test } from "node:test";
import { checkForUpdate, compareVersions, latestTag, parseTags } from "../server/update.ts";

/** 更新检查是纯规则 + 一条注入的 git 调用，不碰网络也能覆盖全部分支。 */

const remote = (tags) => ({
  ok: true,
  stdout: tags
    .flatMap((tag) => [`abc123\trefs/tags/${tag}`, `def456\trefs/tags/${tag}^{}`])
    .join("\n"),
  stderr: "",
});

test("tag 解析：忽略解引用行与预发布，只留稳定的 vX.Y.Z", () => {
  assert.deepEqual(parseTags(remote(["v0.1.0", "v0.2.0", "v0.3.0-rc.1"]).stdout).sort(), ["v0.1.0", "v0.2.0"]);
  assert.deepEqual(parseTags("").sort(), []);
});

test("版本比较按数字逐段，不做字符串比较", () => {
  assert.equal(compareVersions("v0.10.0", "v0.9.0"), 1);
  assert.equal(compareVersions("0.1.0", "v0.1.0"), 0);
  assert.equal(latestTag(["v0.1.0", "v0.10.0", "v0.9.9"]), "v0.10.0");
});

test("有更新的 tag：报告可更新，并给出带 --ref 的安装命令", async () => {
  const result = await checkForUpdate(async () => remote(["v0.1.0", "v0.2.0"]));
  assert.equal(result.ok, true);
  assert.equal(result.current, "0.1.0");
  assert.equal(result.latest, "v0.2.0");
  assert.equal(result.updateAvailable, true);
  assert.match(result.command, /--ref v0\.2\.0$/);
});

test("没有更新的 tag：updateAvailable 为 false，命令仍指向当前最新", async () => {
  const result = await checkForUpdate(async () => remote(["v0.1.0"]));
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, false);
  assert.match(result.command, /--ref v0\.1\.0$/);
});

test("git 不可用或网络失败：如实报 update-failed，不猜一个「已是最新」", async () => {
  const missing = await checkForUpdate(async () => ({ ok: false, stdout: "", stderr: "spawn git ENOENT" }));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "git-missing");

  const failed = await checkForUpdate(async () => ({ ok: false, stdout: "", stderr: "Could not resolve host" }));
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "update-failed");
});
