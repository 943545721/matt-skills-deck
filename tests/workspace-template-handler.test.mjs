import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { workspaceTemplatesHandler } from "../server/rpc/templates.ts";

/**
 * `deck.workspace.templates` 的口径：预览与执行必须是同一份判断。
 *
 * 这里钉住三件事：预览不落盘但数字与执行一致、执行只补缺失、非 v2 配置一律给明确理由
 * 而不是「0 个模板」这种看上去成功的结果。
 */

const CONFIG = {
  version: 2,
  projects: [
    { key: "api", dir: "mall-api", repo: "acme/mall-api", owner: "backend", areas: ["orders"] },
    { key: "web", dir: "apps/admin-web", repo: "acme/mall-web", owner: "frontend", areas: ["pc-web"] },
  ],
};

function workspace(config = CONFIG) {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-templates-"));
  if (config !== null) {
    writeFileSync(
      path.join(dir, ".paseo-deck.json"),
      typeof config === "string" ? config : JSON.stringify(config, null, 2),
    );
  }
  return dir;
}

const read = (dir, rel) => readFileSync(path.join(dir, ...rel.split("/")), "utf8");

test("预览不落盘，且每个项目的数字与随后执行的一致", async (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const preview = await workspaceTemplatesHandler({ workspaceDir: dir, apply: false });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.written, [], "预览不许写盘");
  assert.equal(existsSync(path.join(dir, "mall-api", ".github")), false);
  assert.deepEqual(
    preview.projects.map((row) => [row.key, row.write, row.present, row.conflicts]),
    [
      ["api", 1, 0, 0],
      ["web", 1, 0, 0],
    ],
  );
  assert.deepEqual(preview.projects[0].kinds, ["backend-api"]);
  assert.deepEqual(preview.projects[1].kinds, ["frontend-page"]);

  const applied = await workspaceTemplatesHandler({ workspaceDir: dir, apply: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.written.length, 2, "预览说 2 个，执行也该是 2 个");
  const paths = new Set(applied.written);
  assert.ok(paths.has("mall-api/.github/ISSUE_TEMPLATE/backend-api.yml"));
  assert.ok(paths.has("apps/admin-web/.github/ISSUE_TEMPLATE/frontend-page.yml"));
  assert.match(read(dir, "mall-api/.github/ISSUE_TEMPLATE/backend-api.yml"), /背景/);
});

test("再执行一次什么都不写；手改过的文件内容不同，只报冲突不覆盖", async (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await workspaceTemplatesHandler({ workspaceDir: dir, apply: true });

  const again = await workspaceTemplatesHandler({ workspaceDir: dir, apply: true });
  assert.equal(again.ok, true);
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.conflicts, []);
  assert.equal(again.present.length, 2, "已经在了的两个要能被数出来");

  const edited = "name: \"手改的\"\n";
  writeFileSync(path.join(dir, "mall-api", ".github", "ISSUE_TEMPLATE", "backend-api.yml"), edited);
  const third = await workspaceTemplatesHandler({ workspaceDir: dir, apply: true });
  assert.equal(third.ok, true);
  assert.deepEqual(third.written, []);
  assert.deepEqual(third.conflicts, ["mall-api/.github/ISSUE_TEMPLATE/backend-api.yml"]);
  assert.equal(read(dir, "mall-api/.github/ISSUE_TEMPLATE/backend-api.yml"), edited, "手改的内容必须原样保留");
});

test("非 v2 配置一律给明确理由，并且一个文件都不写", async (t) => {
  const cases = [
    [null, "no-config"],
    [{ repoDir: "mall-api" }, "v1"],
    ["{ 这不是 json", "invalid"],
    [{ version: 2, projects: [] }, "no-projects"],
  ];
  for (const [config, reason] of cases) {
    const dir = workspace(config);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // 空项目清单也要留个可写的目录，避免「没写」和「写不了」混在一起。
    mkdirSync(path.join(dir, "mall-api"), { recursive: true });

    const result = await workspaceTemplatesHandler({ workspaceDir: dir, apply: true });
    assert.equal(result.ok, false, `${reason} 应当被拒绝`);
    assert.equal(result.reason, reason);
    assert.ok(result.detail.length > 0, `${reason} 要说清原因`);
    assert.equal(existsSync(path.join(dir, "mall-api", ".github")), false, `${reason} 不该落盘`);
  }
});

test("owner 与 areas 都不匹配的项目不写文件，但有一条原因", async (t) => {
  const dir = workspace({
    version: 2,
    projects: [{ key: "ops", dir: "deploy", owner: "ops", areas: [] }],
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await workspaceTemplatesHandler({ workspaceDir: dir, apply: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.written, []);
  assert.equal(result.projects.length, 1, "没有模板的项目也要出现在结果里");
  assert.match(result.notes.join("\n"), /ops/);
});
