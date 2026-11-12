import assert from "node:assert/strict";
import test from "node:test";
import { executionBlockFor, executionDenyMessage, shellMutationVerdict } from "../shared/execution-guard.ts";

/**
 * 执行门只做一件事：认出主/派单/进度窗口里「会改工作区」的动作并拒绝。
 *
 * 这是护栏不是沙箱：未知命令一律放行。所以用例两侧都要钉——
 * 拦漏了角色窗口会去写代码，误拦了它连 `git status` 都跑不了。
 */

const mutating = (command) => shellMutationVerdict(command).mutating;

test("写文件类工具直接拦", () => {
  for (const command of [
    "rm -rf build",
    "mv a.ts b.ts",
    "cp a.ts b.ts",
    "touch new.txt",
    "mkdir -p out",
    "chmod +x run.sh",
    "ln -s a b",
    "truncate -s 0 log.txt",
    "tee out.txt",
    "patch -p1 < fix.diff",
    "vim src/index.ts",
    "nano README.md",
  ]) {
    assert.equal(mutating(command), true, command);
  }
});

test("重定向写文件拦，写 /dev/null 与复制文件描述符不拦", () => {
  assert.equal(mutating("echo hi > out.txt"), true);
  assert.equal(mutating("echo hi >> out.txt"), true);
  assert.equal(mutating("node build.js &> build.log"), true);
  assert.equal(mutating("echo hi > /dev/null"), false);
  assert.equal(mutating("npm test 2>/dev/null"), false);
  assert.equal(mutating("npm test 2>&1 | tail -20"), false);
  // 引号里的 `>` 是内容，不是重定向。
  assert.equal(mutating('rg "a > b" src'), false);
});

test("`[[ ]]` / `(( ))` 里的 `>` 是比较，注释里的 `>` 也不是重定向", () => {
  assert.equal(mutating("[[ $a > $b ]]"), false);
  assert.equal(mutating("(( count > 3 ))"), false);
  assert.equal(mutating("echo hi # > out.txt"), false);
});

test("套一层 shell / eval 也认得出里面改文件的命令", () => {
  assert.equal(mutating('bash -c "rm -rf build"'), true);
  assert.equal(mutating("sh -lc 'git commit -m x'"), true);
  assert.equal(mutating('sudo bash -c "mv a b"'), true);
  assert.equal(mutating('eval "npm install"'), true);
  assert.equal(mutating('bash -c "git status"'), false);
  // 脚本内容在文件里，看不到就放行。
  assert.equal(mutating("bash scripts/build.sh"), false);
});

test("包装器剥掉后照样认得出真正的命令", () => {
  assert.equal(mutating("sudo rm -rf /tmp/x"), true);
  assert.equal(mutating("env FOO=1 rm x"), true);
  assert.equal(mutating("timeout 5 rm x"), true);
  assert.equal(mutating("nohup npm install &"), true);
  assert.equal(mutating("command cp a b"), true);
  assert.equal(mutating("sudo -u root rm x"), true);
});

test("原地修改与构建也拦", () => {
  for (const command of [
    "sed -i 's/a/b/' f.ts",
    "sed -i.bak 's/a/b/' f.ts",
    "perl -pi -e 's/a/b/' f.ts",
    "awk -i inplace '{print}' f.ts",
    "git apply fix.patch",
    "git commit -m x",
    "git -C sub checkout main",
    "git reset --hard HEAD~1",
    "npm ci",
    "pnpm add zod",
    "yarn remove lodash",
    "pip install requests",
    "cargo add serde",
    "go get example.com/x",
    "make",
    "docker build -t x .",
    "find . -name '*.ts' -exec rm {} \\;",
    "xargs rm",
  ]) {
    assert.equal(mutating(command), true, command);
  }
});

test("只读排查、测试与类型检查一律放行", () => {
  for (const command of [
    "ls -la",
    "git status",
    "git diff HEAD",
    "git log --oneline -5",
    "git show HEAD",
    "rg -n foo src",
    "grep -r foo .",
    "cat package.json",
    "head -20 README.md",
    "tail -f app.log",
    "sed -n '1,20p' f.ts",
    "wc -l f.ts",
    "pwd",
    "npm test",
    "npm run typecheck",
    "node --test tests/window-gates.test.mjs",
    "tsc --noEmit",
    "pytest -q",
    "cargo test",
    "go test ./...",
    "gh issue view 12",
    "find . -name '*.ts'",
    "awk '{print $1}' f.ts",
  ]) {
    assert.equal(mutating(command), false, command);
  }
});

test("多段命令任意一段改文件就拦", () => {
  assert.equal(mutating("git status && rm out.txt"), true);
  assert.equal(mutating("ls; git diff | head"), false);
});

test("权限明细：只认 write / edit / 改文件 shell", () => {
  assert.deepEqual(executionBlockFor({ type: "write", filePath: "a.ts" }), { block: true, kind: "write" });
  assert.deepEqual(executionBlockFor({ type: "edit", filePath: "a.ts" }), { block: true, kind: "edit" });
  assert.deepEqual(executionBlockFor({ type: "shell", command: "rm x" }), { block: true, kind: "rm" });
  assert.equal(executionBlockFor({ type: "shell", command: "git status" }).block, false);
  for (const detail of [{ type: "read", filePath: "a.ts" }, { type: "search" }, { type: "fetch" }, { type: "tool", name: "deck_probe" }, null, undefined]) {
    assert.equal(executionBlockFor(detail).block, false, JSON.stringify(detail));
  }
});

test("拒绝文案按角色区分，shell 补充命中的种类", () => {
  assert.match(executionDenyMessage("main", "write"), /主窗口不改文件/);
  assert.match(executionDenyMessage("dispatcher", "edit"), /派单窗口/);
  assert.match(executionDenyMessage("progress", "write"), /进度窗口/);
  assert.match(executionDenyMessage("dispatcher", "git commit"), /git commit/);
  assert.match(executionDenyMessage("main", "redirect"), /会改文件（redirect）/);
  assert.match(executionDenyMessage("main", "redirect"), /writes files \(redirect\)/);
  assert.match(executionDenyMessage("main", "write"), /main window does not edit files/);
});
