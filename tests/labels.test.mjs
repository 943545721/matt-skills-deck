import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { isAreaKey, planLabels, reconcileLabelColors } from "../shared/labels.ts";
import { normalizeColor, setLabelColors, syncLabels } from "../server/tracker/labels.ts";
import { syncLabelsHandler } from "../server/rpc/labels.ts";

test("颜色归一：带井号、大小写、首尾空白都收成 6 位小写", () => {
  assert.equal(normalizeColor("#9D7CD8"), "9d7cd8");
  assert.equal(normalizeColor(" 9d7cd8 "), "9d7cd8");
  assert.equal(normalizeColor("#ABC"), "");
  assert.equal(normalizeColor("red"), "");
  assert.equal(normalizeColor(""), "");
});

test("改色：非法颜色在本地就拒绝，绝不发请求", async () => {
  const result = await setLabelColors("acme", "deck", [
    { name: "bug", color: "zzzzzz" },
    { name: "  ", color: "0e8a16" },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, []);
  assert.equal(result.failed.length, 2);
});

test("改色：空改动直接返回空结果，不读回", async () => {
  const result = await setLabelColors("acme", "deck", []);
  assert.deepEqual(result, {
    ok: true,
    applied: [],
    failed: [],
    verified: [],
    mismatched: [],
    readbackFailed: false,
  });
});

test("改色：写后读回，一致才算 verified，不一致如实进 mismatched", async () => {
  const gh = fakeGh(`case "$2" in
  *labels\\?*) echo '[{"name":"bug","color":"0e8a16"},{"name":"docs","color":"ffffff"}]' ;;
  *) echo '{}' ;;
esac`);
  try {
    const result = await setLabelColors("acme", "deck", [
      { name: "bug", color: "0e8a16" },
      { name: "docs", color: "1d76db" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.verified, [{ name: "bug", color: "0e8a16" }]);
    assert.deepEqual(result.mismatched, [{ name: "docs", expected: "1d76db", actual: "ffffff" }]);
    assert.equal(result.readbackFailed, false);
    // 两次 PATCH + 一次读回。
    assert.deepEqual(gh.calls(), ["api", "api", "api"]);
  } finally {
    gh.restore();
  }
});

test("读回核对（GitHub / GitLab 共用）：一致进 verified，缺失与不一致都算 mismatched", () => {
  const result = reconcileLabelColors(
    [
      { name: "bug", color: "0e8a16" },
      { name: "docs", color: "1d76db" },
      { name: "gone", color: "ffffff" },
    ],
    [
      { name: "bug", color: "0e8a16" },
      { name: "docs", color: "000000" },
    ],
  );
  assert.deepEqual(result.verified, [{ name: "bug", color: "0e8a16" }]);
  assert.deepEqual(result.mismatched, [
    { name: "docs", expected: "1d76db", actual: "000000" },
    { name: "gone", expected: "ffffff", actual: "" },
  ]);
});

// ---------------------------------------------------------------------------
// 同步标签（#4）：规划、幂等、部分失败、整条链路
// ---------------------------------------------------------------------------

test("同步计划：标准 10 个 + area + role，颜色只看名字不看清单顺序", () => {
  const plan = planLabels({ areas: ["api", "admin-web"], owner: "backend" });
  const names = plan.labels.map((label) => label.name);
  assert.equal(plan.labels.length, 13);
  assert.ok(names.includes("area:api"));
  assert.ok(names.includes("area:admin-web"));
  assert.ok(names.includes("role:backend"));
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.deprecated, []);
  for (const label of plan.labels) assert.match(label.color, /^[0-9a-f]{6}$/);

  // 只换清单里别的项，不会改到已有 area 的颜色——这是「颜色固定」的实际含义。
  const later = planLabels({ areas: ["api", "ops-console", "report"], owner: "ops" });
  assert.equal(
    later.labels.find((label) => label.name === "area:api")?.color,
    plan.labels.find((label) => label.name === "area:api")?.color,
  );
});

test("同步计划：非法 area 键跳过并说明，重复键只算一次", () => {
  const plan = planLabels({ areas: ["API", "api", "a_b", "api"], owner: "backend" });
  assert.deepEqual(
    plan.labels.filter((label) => label.name.startsWith("area:")).map((label) => label.name),
    ["area:api"],
  );
  assert.equal(plan.skipped.filter((note) => note.includes("不是合法键")).length, 2);
  assert.equal(isAreaKey("api"), true);
  assert.equal(isAreaKey("-api"), false);
  assert.equal(isAreaKey("API"), false);
});

test("同步计划：没有 areas、没有 owner 只建标准标签，并逐句说明", () => {
  const plan = planLabels({ areas: [], owner: null });
  assert.equal(plan.labels.length, 10);
  assert.equal(plan.skipped.length, 2);
  assert.match(plan.skipped.join("\n"), /没有 areas/);
  assert.match(plan.skipped.join("\n"), /没有 owner/);
});

test("同步计划：配置里标为废弃的 area 不创建，只在结果里列出", () => {
  const plan = planLabels({ areas: ["api", "legacy"], owner: "backend", deprecatedAreas: ["legacy"] });
  const names = plan.labels.map((label) => label.name);
  assert.ok(names.includes("area:api"));
  assert.ok(!names.includes("area:legacy"));
  assert.deepEqual(plan.deprecated, ["area:legacy"]);
});

const syncPlan = planLabels({ areas: ["api"], owner: "backend" });

test("同步：全部已存在时一个都不建（幂等）", async () => {
  const created = [];
  const deps = {
    list: async () => ({ ok: true, labels: syncPlan.labels.map((label) => ({ name: label.name })) }),
    create: async (_owner, _name, label) => {
      created.push(label.name);
      return { ok: true };
    },
  };
  const result = await syncLabels("acme", "api", syncPlan.labels, deps);
  assert.deepEqual(result.created, []);
  assert.equal(result.existing.length, syncPlan.labels.length);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(created, []);
});

test("同步：单个标签失败逐条记账，后面的照建", async () => {
  const deps = {
    list: async () => ({ ok: true, labels: [] }),
    create: async (_owner, _name, label) =>
      label.name === "bug" ? { ok: false, reason: "gh-failed", detail: "422 label exists" } : { ok: true },
  };
  const result = await syncLabels("acme", "api", syncPlan.labels, deps);
  assert.deepEqual(result.failed, [{ name: "bug", detail: "422 label exists" }]);
  assert.equal(result.created.length, syncPlan.labels.length - 1);
});

test("同步：标签列表读不到时整仓库失败，不猜「全都缺」", async () => {
  const deps = {
    list: async () => ({ ok: false, reason: "gh-unauth", detail: "not logged in" }),
    create: async () => ({ ok: true }),
  };
  const result = await syncLabels("acme", "api", syncPlan.labels, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "gh-unauth");
});

test("同步：没装 gh 时第一次创建失败就停手，不把同一条错误抄一遍", async () => {
  let calls = 0;
  const deps = {
    list: async () => ({ ok: true, labels: [] }),
    create: async () => {
      calls += 1;
      return { ok: false, reason: "gh-missing", detail: "没有找到 gh 命令" };
    },
  };
  const result = await syncLabels("acme", "api", syncPlan.labels, deps);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// 整条链路：真实工作区 + 假 gh（不联网、不碰真实仓库）
// ---------------------------------------------------------------------------

const hasGit = () => spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * 假 gh：按 `repos/<owner>/<name>/labels` 记账。
 *
 * 用 node 脚本而不是 case 分支，是因为要跨调用保存状态（第一轮建了哪些、第二轮就该全部「已存在」），
 * 这正是幂等要验证的东西。状态与调用日志都放在临时目录里，测完删掉。
 */
function fakeGhForSync(runDir) {
  const bin = path.join(runDir, "gh");
  const store = path.join(runDir, "store.json");
  const log = path.join(runDir, "calls.log");
  writeFileSync(store, "{}", "utf8");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const storePath = ${JSON.stringify(store)};
const logPath = ${JSON.stringify(log)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, args.join(" ") + "\\n");
const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
const repo = (args[1] || "").match(/repos\\/([^/]+\\/[^/]+)\\//)?.[1] ?? "unknown";
store[repo] = store[repo] ?? { labels: [], created: [] };
if (args.includes("--method") && args.includes("POST")) {
  const name = (args.find((item) => item.startsWith("name=")) ?? "name=").slice(5);
  store[repo].labels.push({ name, color: "000000" });
  store[repo].created.push(name);
  fs.writeFileSync(storePath, JSON.stringify(store));
  process.stdout.write("{}\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify(store[repo].labels) + "\\n");
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${runDir}:${previousPath ?? ""}`;
  return {
    created: (repo) => JSON.parse(readFileSync(store, "utf8"))[repo]?.created ?? [],
    restore: () => {
      process.env.PATH = previousPath;
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

function gitRepo(root, dir, remote) {
  const full = path.join(root, dir);
  mkdirSync(full, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: full });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: full });
  return full;
}

test("同步标签（整条链路）：两个仓库按配置建齐，第二次全部「已存在」", { skip: !hasGit() && "没有 git" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-sync-ws-"));
  const run = path.join(root, ".fake-gh");
  mkdirSync(run);
  const gh = fakeGhForSync(run);
  try {
    gitRepo(root, "api", "https://github.com/acme/api.git");
    gitRepo(root, "web", "https://github.com/acme/web.git");
    writeFileSync(
      path.join(root, ".paseo-deck.json"),
      JSON.stringify(
        {
          version: 2,
          projects: [
            { key: "api", dir: "api", repo: "acme/api", owner: "backend", areas: ["api", "auth", "legacy"], deprecatedAreas: ["legacy"] },
            { key: "web", dir: "web", repo: "acme/web", owner: "frontend", areas: [] },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const first = await syncLabelsHandler({ workspaceDir: root });
    assert.equal(first.ok, true);
    const [api, web] = first.repos;
    // 标准 10 + area:api + area:auth + role:backend；area:legacy 是废弃项，不建。
    assert.equal(api.created.length, 13);
    assert.ok(api.created.includes("area:api"));
    assert.ok(api.created.includes("role:backend"));
    assert.ok(!api.created.includes("area:legacy"));
    assert.deepEqual(api.deprecated, ["area:legacy"]);
    assert.equal(api.host, "github");
    assert.equal(api.repo, "acme/api");
    // 没有 areas 的项目：标准 10 + role:frontend，并说明 area 部分被跳过。
    assert.equal(web.created.length, 11);
    assert.ok(web.skipped.some((note) => note.includes("没有 areas")));
    assert.deepEqual(gh.created("acme/api").length, 13);
    assert.deepEqual(gh.created("acme/web").length, 11);

    const second = await syncLabelsHandler({ workspaceDir: root });
    assert.equal(second.ok, true);
    for (const row of second.repos) {
      assert.deepEqual(row.created, []);
      assert.deepEqual(row.failed, []);
      assert.equal(row.error, null);
    }
    assert.equal(second.repos[0].existing.length, 13);
    assert.equal(second.repos[1].existing.length, 11);
    // 第二轮没有新的创建请求。
    assert.equal(gh.created("acme/api").length, 13);
  } finally {
    gh.restore();
  }
});

test("同步标签：没有项目清单时明确报错，不静默成功", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-sync-empty-"));
  try {
    const result = await syncLabelsHandler({ workspaceDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-repo");
    assert.match(result.detail, /\.paseo-deck\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同步标签：v1 文件只读不猜，直接说明它没有清单", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-sync-v1-"));
  try {
    writeFileSync(path.join(root, ".paseo-deck.json"), JSON.stringify({ repoDir: "api" }), "utf8");
    const result = await syncLabelsHandler({ workspaceDir: root });
    assert.equal(result.ok, false);
    assert.match(result.detail, /v1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
