import { execFile } from "node:child_process";
import { installCommandOf, installRecipeFor } from "../shared/provider-install.ts";

/**
 * 执行 `npm install -g <pkg>` 装一个客户端。
 *
 * 三条硬规矩：
 * - 命令与参数分开放，**不经过 shell**：provider id 只用来查表，绝不拼进命令行；
 * - 表里没有的一律拒绝（`no-recipe`），不猜包名；
 * - 同一时间只跑一个安装：并发跑 npm 会互相踩 `node_modules` 与全局 bin 目录。
 */

const MAX_OUTPUT = 4_000;

export const INSTALL_TIMEOUT_MS = 240_000;

export interface InstallRunOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface InstallRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<InstallRunOutput>;
}

/** 去掉 ANSI 颜色码：npm 的进度输出带一堆转义，原样塞进界面会变成乱码。 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** 只留尾部：安装失败的根因通常在最后十几行。 */
export function tailOf(stdout: string, stderr: string): string {
  const merged = `${stripAnsi(stderr).trim()}\n${stripAnsi(stdout).trim()}`.trim();
  return merged.length > MAX_OUTPUT ? `…${merged.slice(-MAX_OUTPUT)}` : merged;
}

export const defaultInstallRunner: InstallRunner = {
  run(command, args, timeoutMs) {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        { timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : error ? error.message : "",
          });
        },
      );
    });
  },
};

let installing = false;

export type InstallProviderResult =
  | {
      ok: true;
      provider: string;
      packageName: string;
      command: string;
      durationMs: number;
      output: string;
    }
  | {
      ok: false;
      reason: "invalid" | "no-recipe" | "busy" | "failed";
      detail: string;
      output?: string;
    };

export interface InstallProviderDeps {
  runner?: InstallRunner;
  now?: () => number;
}

export async function installProvider(
  input: { provider: string },
  deps: InstallProviderDeps = {},
): Promise<InstallProviderResult> {
  const provider = input.provider?.trim() ?? "";
  if (!provider) return { ok: false, reason: "invalid", detail: "要装哪个客户端？没给 provider" };

  const recipe = installRecipeFor(provider);
  if (!recipe) {
    return {
      ok: false,
      reason: "no-recipe",
      detail: `没有「${provider}」的安装方式：这个客户端不走 npm，或包名没核实过。按官方文档装好，再回这里点刷新`,
    };
  }
  if (installing) {
    return { ok: false, reason: "busy", detail: "已经有一个安装在跑：并发跑 npm 会互相踩全局目录，等它结束再点" };
  }

  const runner = deps.runner ?? defaultInstallRunner;
  const now = deps.now ?? Date.now;
  const command = "npm";
  const args = ["install", "-g", recipe.packageName];
  const startedAt = now();
  installing = true;
  try {
    const result = await runner.run(command, args, INSTALL_TIMEOUT_MS);
    const output = tailOf(result.stdout, result.stderr);
    if (!result.ok) {
      return {
        ok: false,
        reason: "failed",
        detail: `安装 ${recipe.packageName} 没成功：看下面的输出尾部（常见原因是没有全局写权限，或镜像不通）`,
        ...(output ? { output } : {}),
      };
    }
    return {
      ok: true,
      provider,
      packageName: recipe.packageName,
      command: installCommandOf(recipe),
      durationMs: Math.max(0, now() - startedAt),
      output,
    };
  } finally {
    installing = false;
  }
}

/** 只给测试用：把「正在装」的标志复位，避免一条失败用例把后面的用例全卡在 busy。 */
export function resetInstallGuardForTests(): void {
  installing = false;
}
