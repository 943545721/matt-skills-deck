import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import type { AuthSnapshot } from "../shared/auth.ts";

/**
 * 在插件里完成 GitHub 登录。
 *
 * 为什么不让用户去终端跑 `gh auth login`：那正是这一步以前失败的地方——
 * 面板只报「没登录」，却把最关键的「怎么登」丢给用户自己开终端。
 * 这里把 gh 的浏览器流程接到面板上：点一下，面板显示一次性验证码与授权页；
 * 用户在 GitHub 上确认后，轮询发现登录态，任务板自动刷新。
 *
 * 安全边界：
 * - token 只走 stdin 交给 gh，不进 argv、不进插件设置、不进日志；
 * - 浏览器流程不接触 token，只回传一次性验证码；
 * - 所有失败细节先剥 ANSI、再截断，并显式抹掉 token。
 */

const HOST = "github.com";
const DEVICE_URL = "https://github.com/login/device";
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export interface AuthRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  /** 命令本身找不到（ENOENT）。 */
  missing: boolean;
}

export interface AuthDeps {
  spawn: typeof spawn;
  run(
    command: string,
    args: string[],
    options: { timeout: number; env: NodeJS.ProcessEnv },
  ): Promise<AuthRunResult>;
  now(): number;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 轮询登录态与「验证码多久没出来算失败」的节奏，测试里调小。 */
  pollMs: number;
  startTimeoutMs: number;
  sessionTtlMs: number;
  tokenTimeoutMs: number;
  /** 浏览器流程要求本机能连上 github.com；测试里可以替换掉。 */
  probeWeb(env: NodeJS.ProcessEnv): Promise<boolean>;
}

const defaultRun: AuthDeps["run"] = async (command, args, { timeout, env }) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 1 << 20,
      env,
    });
    return { ok: true, stdout, stderr, code: 0, missing: false };
  } catch (error) {
    const record = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string" ? record.stderr : "",
      code: typeof record.code === "number" ? record.code : null,
      missing: record.code === "ENOENT",
    };
  }
};

const execFileAsync = promisify(execFile);

/**
 * 浏览器流程的验证码端点只在 github.com 上，api.github.com 能通不代表它也能通。
 * 连不上时提前说清楚，别让用户对着「正在申请验证码」等 15 秒。
 * 配置了代理时不做这个判断：直连失败不代表 gh 走代理也失败。
 */
export function probeGithubWeb(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    const socket = connect({ host: "github.com", port: 443 });
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 2_000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const defaultDeps: AuthDeps = {
  spawn,
  run: defaultRun,
  now: () => Date.now(),
  platform: process.platform,
  env: process.env,
  pollMs: 2_000,
  startTimeoutMs: 15_000,
  sessionTtlMs: 15 * 60_000,
  tokenTimeoutMs: 20_000,
  probeWeb: probeGithubWeb,
};

/** 去掉终端控制序列；gh 在非 TTY 下有时仍会输出颜色。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** gh 的登录态输出：新旧版本分别是 `as USER` 与 `account USER`。 */
export function parseAuthStatus(text: string): { authenticated: boolean; login?: string } {
  const clean = stripAnsi(text);
  const match = /Logged in to github\.com (?:account|as)\s+([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(clean);
  const login = match?.[1];
  if (login) return { authenticated: true, login };
  return { authenticated: /Logged in to github\.com/i.test(clean) };
}

/** 从 gh 的浏览器流程输出里取一次性验证码与授权地址。 */
export function parseDeviceOutput(text: string): { code?: string; url?: string } {
  const clean = stripAnsi(text);
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(clean)?.[1]?.toUpperCase();
  const url = /(https:\/\/github\.com\/login\/device)/i.exec(clean)?.[1];
  return {
    ...(code ? { code } : {}),
    ...(url ? { url } : {}),
  };
}

/**
 * 失败详情：只保留 gh 真正说的话。
 *
 * 不截到 0：`Bad credentials` 这类线索必须留下；也不原样回显 token——
 * 万一 gh 把输入带进了错误信息，先抹掉再展示。
 */
export function cleanDetail(text: string, token?: string): string {
  let clean = stripAnsi(text).replace(/\r/g, "").trim();
  if (token) clean = clean.split(token).join("<token>");
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join(" · ");
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

/** token 的形状只在本地挡一次空值/换行；它到底有效由 gh 判断。 */
export function tokenProblem(token: string): string | null {
  const value = token.trim();
  if (!value) return "先粘贴一个 GitHub token";
  if (value.length < 16) return "这个字符串太短，不像 GitHub token";
  if (/\s/.test(value)) return "token 里不能有空格或换行";
  return null;
}

function githubPendingDetail(): string {
  return "等待你在 GitHub 上确认授权…";
}

export class GithubAuth {
  private readonly deps: AuthDeps;
  private snapshot: AuthSnapshot = { state: "unknown", host: HOST };
  private child: ChildProcess | null = null;
  /** Token 校验子进程：取消 / 卸载时与浏览器流程一样要收掉。 */
  private tokenChild: ChildProcess | null = null;
  private output = "";
  private pollTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private lastCheckAt = 0;
  /** 每次开始 / 取消 / 成功都递增；异步回调回来时用它判断自己是不是上一轮。 */
  private generation = 0;
  private refreshing = false;
  private startedEnter = false;
  private startedYes = false;

  constructor(overrides: Partial<AuthDeps> = {}) {
    this.deps = { ...defaultDeps, ...overrides };
  }

  get(): AuthSnapshot {
    return { ...this.snapshot };
  }

  /** 面板打开时查一次；pending 时顺便轮询，授权完成就切到 authenticated。 */
  async status(refresh = false): Promise<AuthSnapshot> {
    if (this.snapshot.state === "pending") return this.refreshPending();
    // Token 正在验证时不要插一脚：那次 login 会自己写结果。
    if (this.snapshot.state === "checking") return this.get();
    const now = this.deps.now();
    if (!refresh && now - this.lastCheckAt < 3_000) return this.get();
    return this.check();
  }

  async start(): Promise<AuthSnapshot> {
    if (this.snapshot.state === "pending" && !this.expired()) return this.get();
    // Token 正在校验：别同时拉起浏览器流程，两条路会抢着写同一个 snapshot。
    if (this.snapshot.state === "checking") return this.get();
    if (this.snapshot.state === "authenticated" && this.deps.now() - this.lastCheckAt < 5_000) {
      return this.get();
    }

    // 连接探测失败就不启动 gh：它的 device 端点必须走 github.com，启动也只会卡住。
    // 探测要等网络，期间用户可能已经点了取消；回来时先确认还是同一轮。
    const probeGeneration = this.generation;
    let reachable = true;
    try {
      reachable = await this.deps.probeWeb(this.deps.env);
    } catch {
      // 探测本身出错时不拦路，让 gh 自己给出结论。
      reachable = true;
    }
    if (probeGeneration !== this.generation) return this.get();
    if (!reachable) {
      return this.fail(
        "web-blocked",
        "本机连不上 github.com（2 秒内没有建立连接），浏览器登录无法启动；请改用 Token 登录",
      );
    }

    this.cleanupChild();
    const generation = ++this.generation;
    const startedAt = this.deps.now();
    this.snapshot = {
      state: "pending",
      host: HOST,
      detail: "正在向 GitHub 申请一次性验证码…",
      startedAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(startedAt + this.deps.sessionTtlMs).toISOString(),
    };
    this.output = "";
    this.startedEnter = false;
    this.startedYes = false;
    this.lastCheckAt = 0;

    let child: ChildProcess;
    try {
      child = this.deps.spawn(
        "gh",
        ["auth", "login", "--hostname", HOST, "--git-protocol", "https", "--web"],
        {
          env: this.loginEnv(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      return this.fail("device-unavailable", cleanDetail(error instanceof Error ? error.message : String(error)));
    }

    this.child = child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.onOutput(String(chunk), generation));
    child.stderr?.on("data", (chunk: Buffer | string) => this.onOutput(String(chunk), generation));
    child.once("error", (error: Error) => {
      if (generation !== this.generation) return;
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.fail(missing ? "gh-missing" : "device-unavailable", cleanDetail(error.message));
    });
    child.once("exit", (code) => {
      if (generation !== this.generation) return;
      void this.onExit(code, generation);
    });

    this.startTimer = setTimeout(() => {
      if (generation !== this.generation || this.snapshot.code) return;
      this.fail(
        "device-unavailable",
        cleanDetail(this.output) || "gh 没有返回验证码；可以改用 Token 登录",
      );
    }, this.deps.startTimeoutMs);
    this.pollTimer = setInterval(() => {
      if (generation !== this.generation) return;
      void this.refreshPending();
    }, this.deps.pollMs);
    this.expiryTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.expire();
    }, this.deps.sessionTtlMs);

    return this.get();
  }

  async cancel(): Promise<AuthSnapshot> {
    this.generation += 1;
    this.cleanupChild();
    this.snapshot = { state: "needs-login", host: HOST, reason: "cancelled", detail: "已取消登录" };
    this.lastCheckAt = 0;
    return this.get();
  }

  async loginWithToken(token: string): Promise<AuthSnapshot> {
    const problem = tokenProblem(token);
    // 形状不合法也要走 fail()：它会收掉可能还在等待授权的浏览器流程和定时器，
    // 否则 snapshot 已经改成错误，旧的 expiryTimer 到点还会把错误改写成「验证码过期」。
    if (problem) return this.fail("token-invalid", problem);

    // 只 trim 一次：gh 拿到的是它，错误详情里要抹掉的也是它，两处必须是同一个字符串。
    const value = token.trim();
    this.generation += 1;
    const generation = this.generation;
    this.cleanupChild();
    this.snapshot = { state: "checking", host: HOST, detail: "正在验证 Token…" };

    const result = await this.runWithInput(
      ["auth", "login", "--hostname", HOST, "--git-protocol", "https", "--with-token"],
      value,
      this.deps.tokenTimeoutMs,
    );
    if (generation !== this.generation) return this.get();

    if (!result.ok) {
      const text = `${result.stdout}\n${result.stderr}`;
      const invalid = /bad credentials|authentication failed|invalid token|http 401/i.test(text);
      return this.fail(
        result.missing ? "gh-missing" : invalid ? "token-invalid" : "gh-failed",
        cleanDetail(text, value) || "gh 没有接受这个 token",
      );
    }

    // 实测 gh 2.45 在 token 无效时仍以 0 退出，只在输出里写
    // `error validating token: HTTP 401: Bad credentials`。不能拿退出码当成功。
    const output = `${result.stdout}\n${result.stderr}`;
    if (/error validating token|bad credentials|http 401/i.test(output)) {
      return this.fail("token-invalid", cleanDetail(output, value) || "gh 没有接受这个 token");
    }

    // token 已写进 gh 自己的凭据存储；再读一次账号名给界面。
    this.lastCheckAt = 0;
    const checked = await this.check();
    // 读登录态最长 8 秒，期间用户可能取消或从另一个面板重新开始；别用旧结果盖掉新状态。
    if (generation !== this.generation) return this.get();
    if (checked.state === "authenticated") return checked;
    return this.fail("token-invalid", checked.detail || "token 已交给 gh，但登录态仍然读不到");
  }

  /** 插件卸载 / daemon 停止时收尾，避免留下一个等待授权的 gh 子进程。 */
  dispose(): void {
    this.generation += 1;
    this.cleanupChild();
    this.snapshot = { state: "unknown", host: HOST };
  }

  private async check(): Promise<AuthSnapshot> {
    const generation = this.generation;
    const result = await this.deps.run(
      "gh",
      ["auth", "status", "--hostname", HOST],
      { timeout: 8_000, env: this.deps.env },
    );
    if (generation !== this.generation) return this.get();
    this.lastCheckAt = this.deps.now();

    if (result.missing) {
      this.snapshot = {
        state: "error",
        host: HOST,
        reason: "gh-missing",
        detail: "本机没有找到 gh 命令，先安装 GitHub CLI 再登录",
      };
      return this.get();
    }

    const text = `${result.stdout}\n${result.stderr}`;
    const parsed = parseAuthStatus(text);
    if (parsed.authenticated) {
      this.snapshot = { state: "authenticated", host: HOST, ...(parsed.login ? { login: parsed.login } : {}) };
      return this.get();
    }

    if (result.ok) {
      // 退出码 0 但解析不到账号：仍然算已登录，只是拿不到名字。
      this.snapshot = { state: "authenticated", host: HOST };
      return this.get();
    }

    if (/not logged into any GitHub hosts|gh auth login/i.test(text)) {
      this.snapshot = {
        state: "needs-login",
        host: HOST,
        detail: cleanDetail(text) || "gh 还没有登录 GitHub",
      };
      return this.get();
    }

    this.snapshot = {
      state: "error",
      host: HOST,
      reason: "gh-failed",
      detail: cleanDetail(text) || "读取 gh 登录态失败",
    };
    return this.get();
  }

  /** pending 时只关心「有没有变成已登录」；没变就保持原状态，不让一次抖动把验证码清掉。 */
  private async refreshPending(): Promise<AuthSnapshot> {
    if (this.refreshing) return this.get();
    if (this.expired()) return this.expire();
    this.refreshing = true;
    const generation = this.generation;
    try {
      const result = await this.deps.run(
        "gh",
        ["auth", "status", "--hostname", HOST],
        { timeout: 8_000, env: this.deps.env },
      );
      if (generation !== this.generation || this.snapshot.state !== "pending") return this.get();
      if (result.missing) {
        return this.fail("gh-missing", "本机没有找到 gh 命令，先安装 GitHub CLI 再登录");
      }
      const parsed = parseAuthStatus(`${result.stdout}\n${result.stderr}`);
      if (parsed.authenticated) return this.succeed(parsed.login);
      return this.get();
    } finally {
      this.refreshing = false;
    }
  }

  private onOutput(chunk: string, generation: number): void {
    if (generation !== this.generation) return;
    this.output = `${this.output}${chunk}`.slice(-16_000);
    const parsed = parseDeviceOutput(this.output);
    if (parsed.code || parsed.url) {
      this.snapshot = {
        ...this.snapshot,
        state: "pending",
        ...(parsed.code ? { code: parsed.code } : this.snapshot.code ? { code: this.snapshot.code } : {}),
        url: parsed.url ?? this.snapshot.url ?? DEVICE_URL,
        detail: githubPendingDetail(),
      };
      if (this.startTimer) {
        clearTimeout(this.startTimer);
        this.startTimer = null;
      }
    }

    // 旧版本 gh 在非 TTY 下也可能先问「是否用 gh 管理 git 凭据」并等回车。
    // 不回答就会卡在第一步，验证码永远出不来。
    const stdin = this.child?.stdin;
    if (!stdin) return;
    if (!this.startedYes && /\(Y\/n\)/i.test(this.output)) {
      this.startedYes = true;
      stdin.write("Y\n");
    }
    if (!this.startedEnter && /Press Enter to open/i.test(this.output)) {
      this.startedEnter = true;
      stdin.write("\n");
    }
  }

  private async onExit(code: number | null, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (this.snapshot.state === "authenticated") return;
    const wasPending = this.snapshot.state === "pending";
    // 子进程退出不代表没登成功：先在 gh 的凭据里确认一次。
    const checked = await this.check();
    // 确认也等了 8 秒；期间用户取消或开始了新一轮，就别把旧子进程的退出写回去。
    if (generation !== this.generation) return;
    if (checked.state === "authenticated") return;
    if (!wasPending) return;
    this.fail(
      "device-unavailable",
      code === 0
        ? "gh 登录进程已结束，但没有检测到登录态；重新开始或改用 Token 登录"
        : cleanDetail(this.output) || `gh 登录进程退出（码 ${String(code ?? "?")}）`,
    );
  }

  private loginEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.deps.env, NO_COLOR: "1" };
    // 非 TTY 下 gh 会打印授权地址；把浏览器命令换成 echo，避免无桌面环境卡在拉起浏览器。
    if (this.deps.platform !== "win32") {
      if (!env.GH_BROWSER) env.GH_BROWSER = "echo";
      if (!env.BROWSER) env.BROWSER = "echo";
    }
    return env;
  }

  private runWithInput(args: string[], input: string, timeout: number): Promise<AuthRunResult> {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let child: ChildProcess;
      const finish = (result: AuthRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child && this.tokenChild === child) this.tokenChild = null;
        resolve(result);
      };
      const timer = setTimeout(() => {
        child?.kill("SIGTERM");
        finish({ ok: false, stdout, stderr, code: null, missing: false });
      }, timeout);

      try {
        child = this.deps.spawn("gh", args, {
          env: { ...this.deps.env, NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        finish({
          ok: false,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          code: null,
          missing: (error as NodeJS.ErrnoException).code === "ENOENT",
        });
        return;
      }

      this.tokenChild = child;
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = `${stdout}${String(chunk)}`.slice(-16_000);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${String(chunk)}`.slice(-16_000);
      });
      child.once("error", (error: Error) => {
        finish({
          ok: false,
          stdout,
          stderr: error.message,
          code: null,
          missing: (error as NodeJS.ErrnoException).code === "ENOENT",
        });
      });
      child.once("exit", (code) => {
        finish({ ok: code === 0, stdout, stderr, code, missing: false });
      });

      // token 只走 stdin：不进 argv，ps 和错误信息里都看不到它。
      child.stdin?.end(`${input}\n`);
    });
  }

  private succeed(login: string | undefined): AuthSnapshot {
    this.generation += 1;
    this.cleanupChild();
    this.snapshot = {
      state: "authenticated",
      host: HOST,
      ...(login ? { login } : {}),
      detail: login ? `已登录 GitHub：${login}` : "已登录 GitHub",
    };
    this.lastCheckAt = this.deps.now();
    return this.get();
  }

  private fail(reason: AuthSnapshot["reason"], detail: string): AuthSnapshot {
    this.generation += 1;
    this.cleanupChild();
    this.snapshot = { state: "error", host: HOST, reason, detail };
    this.lastCheckAt = 0;
    return this.get();
  }

  private expire(): AuthSnapshot {
    return this.fail("expired", "验证码已过期，重新开始一次登录");
  }

  private expired(): boolean {
    if (this.snapshot.state !== "pending") return false;
    const expires = this.snapshot.expiresAt ? Date.parse(this.snapshot.expiresAt) : Number.NaN;
    return Number.isFinite(expires) && this.deps.now() > expires;
  }

  private cleanupChild(): void {
    for (const timer of [this.pollTimer, this.startTimer, this.expiryTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.pollTimer = null;
    this.startTimer = null;
    this.expiryTimer = null;
    for (const child of [this.child, this.tokenChild]) {
      if (child && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // 进程可能已经退出；这里没有可恢复的动作。
        }
      }
    }
    this.child = null;
    this.tokenChild = null;
    this.output = "";
  }
}

/** 单例：登录态是机器级的，多个面板同时打开也共用同一次流程。 */
export const githubAuth = new GithubAuth();

export function disposeGithubAuth(): void {
  githubAuth.dispose();
}
