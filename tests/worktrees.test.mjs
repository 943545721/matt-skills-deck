import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  displayFor,
  parseWorktrees,
  readWorktrees,
  shortestUniqueSuffix,
} from "../server/git/worktrees.ts";

/**
 * `git worktree list --porcelain` 的解析与读取。
 *
 * 解析层全部用固定输出喂，不碰真实 git；
 * 读取层用临时目录建真仓库 + 真 worktree，验证 -z 路径与「当前工作树」判定。
 * 失败形态（非仓库目录）也跑真 git：错误原因必须从输出第一行取，不许是空串。
 */

const PLAIN = [
  "worktree /repo/main",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /repo/feature",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/feature-x",
  "",
  "worktree /repo/detached",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
].join("\n");

test("解析：非 -z 形态，分支/游离/裸属性逐条落位", () => {
  const result = parseWorktrees(PLAIN, false);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.worktrees.length, 3);
  const [main, feature, detached] = result.worktrees;
  assert.equal(main.path, "/repo/main");
  assert.equal(main.branch, "main");
  assert.equal(main.detached, false);
  assert.equal(feature.branch, "feature-x");
  assert.equal(detached.branch, null);
  assert.equal(detached.detached, true);
});

test("解析：-z 形态，记录间空 NUL 分隔", () => {
  const stdout = [
    "worktree /repo/main",
    "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/locked",
    "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "locked 原因里可以带空格 and spaces",
    "",
  ].join("\0");
  const result = parseWorktrees(stdout, true);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.worktrees.length, 2);
  const locked = result.worktrees[1];
  assert.equal(locked.locked, true);
  assert.equal(locked.lockReason, "原因里可以带空格 and spaces");
});

test("解析：locked / prunable 裸标签与带原因两种形态", () => {
  const stdout = [
    "worktree /repo/a",
    "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "locked",
    "",
    "worktree /repo/b",
    "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");
  const result = parseWorktrees(stdout, false);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.worktrees.map((record) => [record.locked, record.lockReason, record.prunable, record.prunableReason]),
    [
      [true, null, false, null],
      [false, null, true, "gitdir file points to non-existent location"],
    ],
  );
});

test("解析：bare 属性与未知属性（忽略不炸）", () => {
  const stdout = ["worktree /repo/bare", "bare", "somefutureattr value", ""].join("\n");
  const result = parseWorktrees(stdout, false);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.worktrees[0].bare, true);
});

test("解析：首行不是 worktree 整份判失败，不猜", () => {
  const result = parseWorktrees("HEAD aaaa\n", false);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /首行/);
});

test("解析：worktree 路径为空判失败", () => {
  const result = parseWorktrees("worktree \nHEAD aaaa\n", false);
  assert.equal(result.ok, false);
});

test("最短唯一后缀：末段可区分时只留一段，冲突时向左扩", () => {
  const paths = ["/repo/main", "/repo/wt/main", "/repo/wt/dev"];
  assert.deepEqual(shortestUniqueSuffix(paths), [2, 2, 1]);
  assert.deepEqual(
    paths.map((path, index) => displayFor(path, shortestUniqueSuffix(paths)[index])),
    ["repo/main", "wt/main", "dev"],
  );
});

test("最短唯一后缀：大小写不敏感地判冲突", () => {
  const paths = ["/a/WT", "/b/wt"];
  assert.deepEqual(shortestUniqueSuffix(paths), [2, 2]);
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function withRepo(fn) {
  // realpath：macOS 上 mkdtemp 回来的是 /var/... 软链，而 git 与实现都比解析后的路径。
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deck-worktrees-")));
  try {
    git(root, ["init", "-b", "main"]);
    git(root, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "--allow-empty", "-m", "init"]);
    // 必须 await：fn 是 async 时同步 return 会让 finally 在 fn 跑完前就执行清场。
    return await fn(root);
  } finally {
    // 附属工作树先拆掉再删目录，否则真仓库里留着指向不存在路径的登记；
    // 断言失败时 finally 照样跑，保证下一个用例不继承上一次的残骸。
    try {
      git(root, ["worktree", "prune"]);
    } catch {
      /* 目录已经没了就不再清 */
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-side`, { recursive: true, force: true });
  }
}

test("读取：真实仓库，主工作树 + 一棵附属工作树", async () => {
  await withRepo(async (root) => {
    const extra = `${root}-side`;
    let removeSide = () => {
      try {
        git(root, ["worktree", "remove", "--force", extra]);
      } catch {
        rmSync(extra, { recursive: true, force: true });
      }
      removeSide = () => {};
    };
    try {
      git(root, ["worktree", "add", "-b", "side", extra]);
      const result = await readWorktrees(root);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.worktrees.length, 2);
      const current = result.worktrees.filter((entry) => entry.current);
      assert.equal(current.length, 1);
      assert.equal(current[0].path, root);
      const side = result.worktrees.find((entry) => entry.branch === "side");
      assert.ok(side, "附属工作树要带上 side 分支名");
      assert.equal(side.current, false);
      assert.ok(side.display.length > 0);
    } finally {
      removeSide();
    }
  });
});

test("读取：从附属工作树里发起，current 标在附属树上", async () => {
  await withRepo(async (root) => {
    const extra = `${root}-side`;
    let removeSide = () => {
      try {
        git(root, ["worktree", "remove", "--force", extra]);
      } catch {
        rmSync(extra, { recursive: true, force: true });
      }
      removeSide = () => {};
    };
    try {
      git(root, ["worktree", "add", "-b", "side", extra]);
      const result = await readWorktrees(extra);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const current = result.worktrees.filter((entry) => entry.current);
      assert.equal(current.length, 1);
      assert.equal(current[0].path, extra);
    } finally {
      removeSide();
    }
  });
});

test("读取：非仓库目录报 git-failed，错误原因取输出第一行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-not-repo-"));
  try {
    const result = await readWorktrees(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "git-failed");
    assert.ok(result.detail.length > 0, "失败详情不许是空串");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
