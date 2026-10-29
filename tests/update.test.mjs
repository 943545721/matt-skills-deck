import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  checkForUpdate,
  compareStableVersions,
  compareVersions,
  gitRefProblem,
  latestTag,
  lsRemoteTags,
  parseGhTagNames,
  parseStableVersion,
  parseTags,
  planUpdate,
  planUpdateFromCheck,
  rollbackRefFor,
  updateCommandFor,
  UPDATE_INSTALL_TARGET,
} from "../server/update.ts";

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

test("gh 的 tag 输出按行取名字，空行不算", () => {
  assert.deepEqual(parseGhTagNames("v0.1.0\nv0.2.0\n\n"), ["v0.1.0", "v0.2.0"]);
  assert.deepEqual(parseGhTagNames(""), []);
});

/** 临时把 PATH 指向一组假命令；用完必须还原。 */
async function withFakeBin(scripts, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-tags-"));
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(path.join(dir, name), 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  try {
    return await fn(dir);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("github.com 被挡时改用 gh api 逐页读 tag 名字", async () => {
  await withFakeBin(
    {
      git: "exit 128",
      // 多页也是逐行名字；--paginate 的 JSON 拼接格式不参与解析。
      gh: `printf '%s\\n' "$@" > "$0.args"\necho 'v0.1.0'\necho 'v0.2.0'`,
    },
    async (dir) => {
      const result = await lsRemoteTags();
      assert.equal(result.ok, true);
      assert.deepEqual(parseTags(result.stdout).sort(), ["v0.1.0", "v0.2.0"]);
      const args = readFileSync(path.join(dir, "gh.args"), "utf8");
      assert.match(args, /--jq/);
      assert.match(args, /\.\[\]\.name/);
    },
  );
});

test("git 正常但仓库没有 tag：空列表是答案，不算失败", async () => {
  await withFakeBin(
    {
      git: "exit 0",
      gh: "echo 'should-not-be-called'\nexit 1",
    },
    async () => {
      const result = await lsRemoteTags();
      assert.equal(result.ok, true);
      assert.equal(result.stdout.trim(), "");
      const update = await checkForUpdate(async () => result);
      assert.equal(update.ok, true);
      assert.equal(update.latest, null);
      assert.equal(update.updateAvailable, false);
      assert.match(update.command, /--ref main$/);
    },
  );
});

test("git 不可用或网络失败：如实报 update-failed，不猜一个「已是最新」", async () => {
  const missing = await checkForUpdate(async () => ({ ok: false, stdout: "", stderr: "spawn git ENOENT" }));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "git-missing");

  const failed = await checkForUpdate(async () => ({ ok: false, stdout: "", stderr: "Could not resolve host" }));
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "update-failed");
});

// ---------------------------------------------------------------------------
// 更新计划：严格版本比较、命令构造、回退说明（计划不执行安装）
// ---------------------------------------------------------------------------

test("稳定版本解析：只认 x.y.z / vx.y.z，预发布与分支名都不算版本", () => {
  assert.deepEqual(parseStableVersion("v0.10.1"), { source: "v0.10.1", normalized: "0.10.1", parts: [0, 10, 1] });
  assert.deepEqual(parseStableVersion(" 0.1.0 "), { source: "0.1.0", normalized: "0.1.0", parts: [0, 1, 0] });
  for (const raw of ["", "0.1", "1.2.3.4", "v0.1.0-rc.1", "latest", "main", "v1.x.0"]) {
    assert.equal(parseStableVersion(raw), null, `不应接受 ${JSON.stringify(raw)}`);
  }
  assert.equal(compareStableVersions(parseStableVersion("v0.10.0"), parseStableVersion("0.9.9")), 1);
  assert.equal(compareStableVersions(parseStableVersion("0.1.0"), parseStableVersion("v0.1.0")), 0);
  assert.equal(compareStableVersions(parseStableVersion("0.0.9"), parseStableVersion("0.1.0")), -1);
  assert.equal(rollbackRefFor("0.1.0"), "v0.1.0");
  assert.equal(rollbackRefFor("v1.2.3"), "v1.2.3");
  assert.equal(rollbackRefFor("main"), null);
});

test("有更新：给出唯一一条安装命令与回退到当前版本的命令", () => {
  const plan = planUpdate({ current: "0.1.0", latest: "v0.2.0" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "update-available");
  assert.equal(plan.current, "0.1.0");
  assert.equal(plan.latest, "v0.2.0");
  assert.equal(plan.target, "v0.2.0");
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.commands.map((step) => step.argv), [
    ["paseo", "plugin", "install", "git:943545721/matt-skills-deck", "--ref", "v0.2.0"],
  ]);
  assert.equal(UPDATE_INSTALL_TARGET, "git:943545721/matt-skills-deck");
  assert.equal(plan.rollback.ref, "v0.1.0");
  assert.deepEqual(plan.rollback.commands.map((step) => step.argv), [
    ["paseo", "plugin", "install", "git:943545721/matt-skills-deck", "--ref", "v0.1.0"],
  ]);
  assert.match(plan.notes.join("\n"), /重启/);
  assert.match(plan.rollback.why, /更新失败|启动异常/);
});

test("跨主版本与规范化：当前版本带 v 也能比较，命令用 tag 原样值", () => {
  const plan = planUpdate({ current: "v0.9.0", latest: "v1.0.0" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "update-available");
  assert.equal(plan.current, "0.9.0");
  assert.equal(plan.target, "v1.0.0");
  assert.equal(plan.warnings.some((warning) => warning.includes("跨主版本")), true);
});

test("已是最新：不给更新命令；最新 tag 更旧时绝不降级", () => {
  const same = planUpdate({ current: "0.2.0", latest: "v0.2.0" });
  assert.equal(same.ok, true);
  assert.equal(same.status, "up-to-date");
  assert.deepEqual(same.commands, []);
  assert.equal(same.target, "v0.2.0");
  assert.equal(same.warnings.length, 0);

  const older = planUpdate({ current: "0.3.0", latest: "v0.2.0" });
  assert.equal(older.ok, true);
  assert.equal(older.status, "up-to-date");
  assert.deepEqual(older.commands, []);
  assert.equal(older.rollback.ref, "v0.3.0");
  assert.equal(older.warnings.some((warning) => warning.includes("不降级")), true);
});

test("没有稳定 tag：状态如实说明，命令指向 main 并警告分支会变", () => {
  const plan = planUpdate({ current: "0.1.0", latest: null });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "no-release-tag");
  assert.equal(plan.latest, null);
  assert.equal(plan.target, "main");
  assert.deepEqual(plan.commands[0].argv, ["paseo", "plugin", "install", "git:943545721/matt-skills-deck", "--ref", "main"]);
  assert.equal(plan.commands[0].argv.includes("v0.1.0"), false);
  assert.equal(plan.warnings.some((warning) => warning.includes("main")), true);
  assert.equal(plan.rollback.ref, "v0.1.0");
});

test("版本或 ref 不合法：拒绝生成计划，不猜测", () => {
  assert.equal(planUpdate({ current: "main", latest: "v0.2.0" }).reason, "invalid-version");
  assert.equal(planUpdate({ current: "0.1.0", latest: "v0.2.0-rc.1" }).reason, "unstable-version");
  assert.equal(planUpdate({ current: "0.1.0", latest: "latest" }).reason, "unstable-version");
  assert.equal(planUpdate({ current: "0.1.0", latest: "v0.2.0", previousRef: "--force" }).reason, "bad-ref");
  assert.equal(planUpdate({ current: "0.1.0", latest: "v0.2.0", previousRef: "a..b" }).reason, "bad-ref");

  assert.equal(gitRefProblem("v0.1.0"), null);
  assert.equal(gitRefProblem("abc1234"), null);
  assert.match(gitRefProblem("-rf"), /不能以 - 开头|不支持的字符/);
  assert.match(gitRefProblem(""), /为空/);
  assert.throws(() => updateCommandFor("--ref"), /ref/);
});

test("自定义回退 ref（例如提交 sha）会被原样用于回退命令", () => {
  const plan = planUpdate({ current: "0.1.0", latest: "v0.2.0", previousRef: "abc1234" });
  assert.equal(plan.ok, true);
  assert.equal(plan.rollback.ref, "abc1234");
  assert.deepEqual(plan.rollback.commands[0].argv.at(-1), "abc1234");
  assert.match(plan.notes.join("\n"), /abc1234/);
});

test("检查失败不生成计划；检查成功时计划命令与 RPC 的 command 一致", async () => {
  const failed = planUpdateFromCheck({ ok: false, reason: "git-missing", detail: "spawn git ENOENT" });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "check-failed");
  assert.match(failed.detail, /git-missing/);

  const check = await checkForUpdate(async () => remote(["v0.1.0", "v0.2.0"]));
  const plan = planUpdateFromCheck(check);
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "update-available");
  assert.equal(plan.commands[0].argv.join(" "), check.command);
  assert.equal(plan.rollback.ref, "v0.1.0");
});

test("更新计划不执行安装：只有 argv / 说明 / 回退，没有执行结果字段", () => {
  const plan = planUpdate({ current: "0.1.0", latest: "v0.2.0" });
  assert.deepEqual(Object.keys(plan).sort(), [
    "commands",
    "current",
    "dryRun",
    "latest",
    "notes",
    "ok",
    "rollback",
    "status",
    "target",
    "warnings",
  ]);
  assert.equal("stdout" in plan, false);
  assert.equal("executed" in plan, false);
});
