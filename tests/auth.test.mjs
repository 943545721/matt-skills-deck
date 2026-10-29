import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  GithubAuth,
  cleanDetail,
  parseAuthStatus,
  parseDeviceOutput,
  probeGithubWeb,
  tokenProblem,
} from "../server/auth.ts";

/**
 * 登录流程不碰真实 gh / 网络：用假子进程喂 gh 的原样输出，
 * 验证「怎么解析、什么时候算成功、失败怎么说人话」。
 */

const LOGGED_IN = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token scopes: 'read:org', 'repo'`;

const NOT_LOGGED_IN = "You are not logged into any GitHub hosts. To log in, run: gh auth login";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.written = [];
    this.input = "";
    this.killed = false;
    this.stdin = {
      write: (value) => {
        this.written.push(value);
        return true;
      },
      end: (value) => {
        this.input += value ?? "";
        return true;
      },
    };
  }

  kill() {
    this.killed = true;
    this.emit("exit", null);
    return true;
  }
}

function harness({
  status = { ok: false, stdout: "", stderr: NOT_LOGGED_IN, code: 1, missing: false },
  tokenExit = 0,
  tokenStderr = "",
  /** 让 token 子进程一直挂着，用来测取消 / 卸载是否收尾。 */
  holdToken = false,
  startTimeoutMs = 60_000,
  sessionTtlMs = 60_000,
  probeWeb = async () => true,
} = {}) {
  let now = 1_700_000_000_000;
  const children = [];
  const calls = [];
  const deps = {
    now: () => now,
    platform: "linux",
    env: {},
    pollMs: 60_000,
    startTimeoutMs,
    sessionTtlMs,
    tokenTimeoutMs: 60_000,
    probeWeb,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new FakeChild();
      if (args.includes("--with-token")) {
        child.stdin.end = (value) => {
          child.input += value ?? "";
          if (tokenStderr) child.stderr.emit("data", tokenStderr);
          if (!holdToken) setImmediate(() => child.emit("exit", tokenExit));
          return true;
        };
      }
      children.push(child);
      return child;
    },
    async run() {
      return typeof status === "function" ? status() : status;
    },
  };
  const auth = new GithubAuth(deps);
  return {
    auth,
    children,
    calls,
    setNow: (value) => {
      now = value;
    },
    setStatus: (value) => {
      status = value;
    },
  };
}

test("解析 gh 登录态：新旧两种输出都能拿到账号", () => {
  assert.deepEqual(parseAuthStatus(LOGGED_IN), { authenticated: true, login: "octocat" });
  assert.deepEqual(parseAuthStatus("✓ Logged in to github.com as mono (/root/.config/gh/hosts.yml)"), {
    authenticated: true,
    login: "mono",
  });
  assert.deepEqual(parseAuthStatus(NOT_LOGGED_IN), { authenticated: false });
});

test("解析浏览器流程输出：剥掉 ANSI，拿到验证码与授权页", () => {
  const raw =
    "\x1b[0;33m!\x1b[0m First copy your one-time code: \x1b[0;1;39mE5D8-3766\x1b[0m\n" +
    "Open this URL to continue in your web browser: https://github.com/login/device\n";
  assert.deepEqual(parseDeviceOutput(raw), {
    code: "E5D8-3766",
    url: "https://github.com/login/device",
  });
  assert.deepEqual(parseDeviceOutput("nothing here"), {});
});

test("失败详情抹掉 token、剥掉控制符、压成一行并截断", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz";
  assert.equal(cleanDetail(`\x1b[31mBad credentials\x1b[0m\n${token}\n`, token), "Bad credentials · <token>");
  assert.equal(cleanDetail("x".repeat(900)).endsWith("…"), true);
  assert.equal(cleanDetail("x".repeat(900)).length, 601);
});

test("token 形状先在本地挡空值、空格与过短", () => {
  assert.match(tokenProblem("") ?? "", /粘贴/);
  assert.match(tokenProblem("short") ?? "", /太短/);
  assert.match(tokenProblem("ghp_aaaa bbbb cccc dddd") ?? "", /空格/);
  assert.equal(tokenProblem("ghp_abcdefghijklmnop"), null);
});

test("未登录时 status 给出 needs-login，并保留 gh 的原因", async () => {
  const h = harness();
  const status = await h.auth.status(true);
  assert.equal(status.state, "needs-login");
  assert.match(status.detail, /not logged/);
  h.auth.dispose();
});

test("gh 不存在时是 error + gh-missing，不冒充未登录", async () => {
  const h = harness({ status: { ok: false, stdout: "", stderr: "", code: null, missing: true } });
  const status = await h.auth.status(true);
  assert.equal(status.state, "error");
  assert.equal(status.reason, "gh-missing");
  h.auth.dispose();
});

test("连不上 github.com 时直接判 web-blocked，不拉起 gh、不让用户干等", async () => {
  const h = harness({ probeWeb: async () => false });
  const result = await h.auth.start();
  assert.equal(result.state, "error");
  assert.equal(result.reason, "web-blocked");
  assert.match(result.detail ?? "", /Token/);
  assert.equal(h.calls.length, 0);
  h.auth.dispose();
});

test("探测网络期间点取消：不再拉起 gh，状态停在已取消", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ probeWeb: () => gate.then(() => true) });
  const starting = h.auth.start();
  await h.auth.cancel();
  release();
  const result = await starting;
  assert.equal(result.state, "needs-login");
  assert.equal(result.reason, "cancelled");
  assert.equal(h.calls.length, 0);
  h.auth.dispose();
});

test("浏览器流程：start 拿到验证码，轮询到登录态后收尾并杀掉子进程", async () => {
  const h = harness();
  const started = await h.auth.start();
  assert.equal(started.state, "pending");
  const child = h.children[0];
  assert.deepEqual(h.calls[0].args, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"]);
  // 非 TTY 下 gh 直接把验证码打印出来。
  child.stdout.emit(
    "data",
    "\x1b[0;33m!\x1b[0m First copy your one-time code: E5D8-3766\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
  );
  assert.equal(h.auth.get().code, "E5D8-3766");
  assert.equal(h.auth.get().url, "https://github.com/login/device");

  h.setStatus({ ok: true, stdout: LOGGED_IN, stderr: "", code: 0, missing: false });
  const done = await h.auth.status();
  assert.equal(done.state, "authenticated");
  assert.equal(done.login, "octocat");
  assert.equal(child.killed, true);
  h.auth.dispose();
});

test("浏览器流程：用户取消后回到 needs-login，并杀掉等待中的 gh", async () => {
  const h = harness();
  await h.auth.start();
  const child = h.children[0];
  const cancelled = await h.auth.cancel();
  assert.equal(cancelled.state, "needs-login");
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(child.killed, true);
  h.auth.dispose();
});

test("浏览器流程：迟迟没有验证码就失败，并提示改用 Token", async () => {
  const h = harness({ startTimeoutMs: 10 });
  await h.auth.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const failed = h.auth.get();
  assert.equal(failed.state, "error");
  assert.equal(failed.reason, "device-unavailable");
  assert.match(failed.detail ?? "", /Token/);
  assert.equal(h.children[0].killed, true);
  h.auth.dispose();
});

test("Token 登录：token 只走 stdin，不进 argv；成功后读回账号", async () => {
  const h = harness({
    status: { ok: true, stdout: LOGGED_IN, stderr: "", code: 0, missing: false },
  });
  const token = "ghp_abcdefghijklmnopqrstuvwxyz";
  const result = await h.auth.loginWithToken(token);
  assert.equal(result.state, "authenticated");
  assert.equal(result.login, "octocat");
  const tokenCall = h.calls.find((call) => call.args.includes("--with-token"));
  assert.ok(tokenCall, "应该调用 gh auth login --with-token");
  assert.equal(tokenCall.args.includes(token), false, "token 不能出现在 argv 里");
  assert.equal(h.children[0].input.trim(), token, "token 应该从 stdin 送进去");
  h.auth.dispose();
});

test("Token 无效：归类为 token-invalid，详情里不留 token 原文", async () => {
  const h = harness({ status: { ok: false, stdout: "", stderr: NOT_LOGGED_IN, code: 1, missing: false }, tokenExit: 1, tokenStderr: "Bad credentials\n" });
  const token = "ghp_abcdefghijklmnopqrstuvwxyz";
  const result = await h.auth.loginWithToken(token);
  assert.equal(result.state, "error");
  assert.equal(result.reason, "token-invalid");
  assert.equal(result.detail.includes(token), false);
  assert.match(result.detail, /Bad credentials/);
  h.auth.dispose();
});

test("Token 无效但 gh 退出码是 0：照样按 token-invalid 报，不假装登录成功", async () => {
  // gh 2.45 实测：HTTP 401 时退出码仍是 0，错误只在输出里。
  const h = harness({
    status: { ok: false, stdout: "", stderr: NOT_LOGGED_IN, code: 1, missing: false },
    tokenExit: 0,
    tokenStderr: "error validating token: HTTP 401: Bad credentials (https://api.github.com/)\n",
  });
  const token = "ghp_abcdefghijklmnopqrstuvwxyz";
  const result = await h.auth.loginWithToken(token);
  assert.equal(result.state, "error");
  assert.equal(result.reason, "token-invalid");
  assert.match(result.detail, /Bad credentials/);
  assert.equal(result.detail.includes(token), false);
  h.auth.dispose();
});

test("配了代理就不做直连探测（探测放行，交给 gh 自己走代理）", async () => {
  assert.equal(await probeGithubWeb({ HTTPS_PROXY: "http://127.0.0.1:9" }), true);
  assert.equal(await probeGithubWeb({ http_proxy: "http://127.0.0.1:9" }), true);
});

test("token 校验期间点浏览器登录：不拉起 gh，也不覆盖 token 的最终结果", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness();
  h.setStatus(() => gate);
  const pending = h.auth.loginWithToken("ghp_abcdefghijklmnop");
  // 等 token 子进程退出、check 卡在 gh auth status 上。
  await new Promise((resolve) => setTimeout(resolve, 10));

  const during = await h.auth.start();
  assert.equal(during.state, "checking");
  assert.equal(h.children.length, 1, "只应该有 token 子进程");
  assert.equal(h.calls.length, 1);

  release({ ok: true, stdout: LOGGED_IN, stderr: "", code: 0, missing: false });
  const done = await pending;
  assert.equal(done.state, "authenticated");
  assert.equal(done.login, "octocat");
  h.auth.dispose();
});

test("gh 退出后立刻取消：onExit 的确认结果不能把取消改写成错误", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness();
  h.setStatus(() => gate);
  await h.auth.start();
  h.children[0].emit("exit", 0);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const cancelled = await h.auth.cancel();
  assert.equal(cancelled.reason, "cancelled");
  release({ ok: false, stdout: "", stderr: NOT_LOGGED_IN, code: 1, missing: false });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(h.auth.get().state, "needs-login");
  assert.equal(h.auth.get().reason, "cancelled");
  h.auth.dispose();
});

test("插件卸载时收掉还在等 token 的子进程", async () => {
  const h = harness({ holdToken: true });
  const pending = h.auth.loginWithToken("ghp_abcdefghijklmnop");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.children[0].killed, false);
  h.auth.dispose();
  assert.equal(h.children[0].killed, true);
  const result = await pending;
  assert.equal(result.state, "unknown");
});

test("浏览器流程进行中提交形状错的 token：收掉旧流程，错误不会被过期计时器改写", async () => {
  const h = harness({ sessionTtlMs: 20 });
  await h.auth.start();
  const webChild = h.children[0];
  const result = await h.auth.loginWithToken("ghp_aaaa bbbb cccc dddd");
  assert.equal(result.state, "error");
  assert.equal(result.reason, "token-invalid");
  assert.match(result.detail, /空格/);
  assert.equal(webChild.killed, true, "旧的 gh auth login 必须被杀掉");
  // 过期计时器如果没清掉，20ms 后会把错误改写成 expired。
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(h.auth.get().reason, "token-invalid");
  h.auth.dispose();
});

test("token 带首尾空白也能从错误详情里抹干净", async () => {
  const token = "ghp_abcdefghijklmnop";
  const h = harness({
    status: { ok: false, stdout: "", stderr: NOT_LOGGED_IN, code: 1, missing: false },
    tokenExit: 1,
    tokenStderr: `Bad credentials for ${token}\n`,
  });
  const result = await h.auth.loginWithToken(`  ${token}  \n`);
  assert.equal(result.state, "error");
  assert.equal(result.detail.includes(token), false);
  h.auth.dispose();
});

test("并发 start 复用同一张验证码，不重复拉起 gh", async () => {
  const h = harness();
  await h.auth.start();
  h.children[0].stdout.emit("data", "one-time code: AB12-CD34\nhttps://github.com/login/device\n");
  await h.auth.start();
  assert.equal(h.children.length, 1);
  assert.equal(h.auth.get().code, "AB12-CD34");
  h.auth.dispose();
});
