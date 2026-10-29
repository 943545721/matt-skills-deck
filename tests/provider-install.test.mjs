import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTALL_RECIPES,
  installCommandOf,
  installRecipeFor,
  installStateOf,
} from "../shared/provider-install.ts";
import { installProvider, resetInstallGuardForTests, tailOf } from "../server/provider-install.ts";

/**
 * 「这台机器装没装客户端」与「能不能从这里装」。
 *
 * 重点不在 happy path，而在几条会改机器的边界：没有配方的客户端绝不能被执行、
 * 同一时间只能跑一个 npm、失败要把输出尾部原样带回来（用户要看到根因）。
 */

test("客户端状态：宿主四种状态各自翻译明白，错的不能当对的", () => {
  assert.equal(installStateOf("ready"), "ready");
  assert.equal(installStateOf("loading"), "loading");
  assert.equal(installStateOf("unavailable"), "missing");
  assert.equal(installStateOf("error"), "broken");
  assert.equal(installStateOf("weird-status"), "unknown");
  assert.equal(installStateOf(null), "unknown");
  assert.equal(installStateOf("  READY  "), "ready", "大小写与空白不该影响判断");
});

test("安装配方：只有核实过包名的客户端才有命令", () => {
  for (const id of ["claude", "codex", "copilot", "opencode"]) {
    assert.ok(installRecipeFor(id), `${id} 应该有配方`);
  }
  assert.equal(installRecipeFor("Claude")?.packageName, "@anthropic-ai/claude-code", "大小写不敏感");
  assert.equal(installRecipeFor("  codex  ")?.packageName, "@openai/codex");
  // 没核实过的包名宁可不给：pi / omp / antigravity / muse 都不是我们查过的 npm 包。
  for (const id of ["pi", "omp", "antigravity", "muse", "", "   "]) {
    assert.equal(installRecipeFor(id), null, `${JSON.stringify(id)} 不该有安装方式`);
  }
  assert.equal(installRecipeFor("constructor"), null, "原型上的键不能当配方");
  assert.equal(installCommandOf(INSTALL_RECIPES.claude), "npm install -g @anthropic-ai/claude-code");
});

test("安装：命令与参数分开传，provider id 不进命令行", async () => {
  const calls = [];
  const result = await installProvider(
    { provider: "copilot" },
    {
      runner: {
        async run(command, args) {
          calls.push({ command, args });
          return { ok: true, stdout: "added 1 package", stderr: "" };
        },
      },
      now: () => 1_000,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.packageName, "@github/copilot");
  assert.equal(result.command, "npm install -g @github/copilot");
  assert.equal(result.output, "added 1 package");
  assert.deepEqual(calls, [{ command: "npm", args: ["install", "-g", "@github/copilot"] }]);
});

test("安装：没有配方直接拒绝，且不执行任何命令", async () => {
  let ran = false;
  const result = await installProvider(
    { provider: "antigravity" },
    {
      runner: {
        async run() {
          ran = true;
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-recipe");
  assert.equal(ran, false, "没有配方就不能碰命令行");
});

test("安装：空 provider 报 invalid", async () => {
  const result = await installProvider({ provider: "   " });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

test("安装：失败要把输出尾部带回来（用户要看根因）", async () => {
  const result = await installProvider(
    { provider: "claude" },
    {
      runner: {
        async run() {
          return { ok: false, stdout: "", stderr: "npm ERR! code EACCES\nnpm ERR! permission denied" };
        },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.match(result.detail, /没有全局写权限|镜像/);
  assert.match(result.output, /EACCES/);
});

test("安装：同一时间只允许一个（并发跑 npm 会踩全局目录）", async () => {
  resetInstallGuardForTests();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = installProvider(
    { provider: "claude" },
    {
      runner: {
        async run() {
          await blocked;
          return { ok: true, stdout: "done", stderr: "" };
        },
      },
    },
  );
  const second = await installProvider({ provider: "codex" }, { runner: { async run() {
    throw new Error("不该走到这里");
  } } });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "busy");
  release();
  assert.equal((await first).ok, true, "第一个装完，标志要放掉");
  resetInstallGuardForTests();
});

test("输出尾部：去色、只留最后 4000 字、stderr 在前", () => {
  const noisy = `\u001b[32mok\u001b[0m ${"x".repeat(5_000)}`;
  const text = tailOf("", noisy);
  assert.ok(text.length <= 4_001, `截断后长度 ${text.length}`);
  assert.ok(text.startsWith("…"), "被截断时要标出来");
  assert.equal(text.includes("\u001b["), false, "ANSI 颜色码要清掉");
  assert.equal(tailOf("stdout-tail", "stderr-head"), "stderr-head\nstdout-tail");
});
