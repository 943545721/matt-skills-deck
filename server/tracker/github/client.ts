import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyGhFailure } from "./errors.ts";
import type { GhError } from "./errors.ts";

const execFileAsync = promisify(execFile);

/** 出站超时（与 DSH outbound-tiers 一致）：读 12s、写 30s、探测 15s。 */
export const READ_TIMEOUT_MS = 12_000;
export const WRITE_TIMEOUT_MS = 30_000;
export const PROBE_TIMEOUT_MS = 15_000;

const MAX_BUFFER = 8 << 20;

export interface GhExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type GhResult =
  | { ok: true; stdout: string; stderr: string; exitCode: 0 }
  | { ok: false; error: GhError; stdout: string; stderr: string; exitCode: number | null };

/** 执行器的唯一形状：**参数数组**，永不拼 shell 字符串；凭据由用户自己的 gh 管，插件不读 token。 */
export type GhExec = (args: readonly string[], options?: GhExecOptions) => Promise<GhResult>;

export interface GhRestOptions extends GhExecOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  fields?: Record<string, string | number | readonly string[]>;
  jq?: string;
  include?: boolean;
  headers?: readonly string[];
}

export interface GhGraphqlOptions extends GhExecOptions {
  method?: "GET" | "POST";
}

export interface GhBudgetStats {
  graphqlCalls: number;
  graphqlPoints: number;
  restRequests: number;
  cliCalls: number;
}

export interface GhRateSnapshot {
  graphql: { limit: number; remaining: number; resetAt: string } | null;
  rest: { limit: number; remaining: number; resetAt: string } | null;
}

export interface GhClient {
  exec(args: readonly string[], options?: GhExecOptions & { via?: string }): Promise<GhResult>;
  graphql(query: string, variables: Record<string, string | number | readonly string[]>, options?: GhGraphqlOptions): Promise<GhResult>;
  rest(path: string, options?: GhRestOptions): Promise<GhResult>;
  stats(): GhBudgetStats;
  resetStats(): void;
  rateSnapshot(): GhRateSnapshot;
}

const WRITE_VERBS = new Set(["create", "edit", "close", "reopen", "comment", "delete", "lock", "unlock", "pin", "unpin"]);
const STRING_FIELDS = new Set(["owner", "name", "query", "issueId", "blockingIssueId", "body", "title", "state"]);

/** 一条 gh 命令是不是写操作：决定超时档与「不自动重试」。只看参数，不看用户文本。 */
export function isWriteGhArgs(args: readonly string[]): boolean {
  const first = args[0] ?? "";
  if (first === "issue" || first === "pr") return WRITE_VERBS.has(args[1] ?? "");
  if (first === "label" || first === "release") return true;
  if (first === "repo" && (args[1] === "create" || args[1] === "edit")) return true;
  if (first === "api") {
    const methodAt = args.findIndex((arg) => arg === "-X" || arg === "--method");
    if (methodAt >= 0) {
      const method = (args[methodAt + 1] ?? "GET").toUpperCase();
      if (method !== "GET") return true;
    }
    return false;
  }
  return false;
}

/** 探测命令（15s 档）：认证状态、仓库身份、额度。它们失败得快，不能占满读超时。 */
export function isProbeGhArgs(args: readonly string[]): boolean {
  const first = args[0] ?? "";
  if (first === "auth" && args[1] === "status") return true;
  if (first === "repo" && args[1] === "view") return true;
  if (first === "api" && args[1] === "rate_limit") return true;
  return false;
}

export function timeoutForGhArgs(args: readonly string[]): number {
  if (isWriteGhArgs(args)) return WRITE_TIMEOUT_MS;
  if (isProbeGhArgs(args)) return PROBE_TIMEOUT_MS;
  return READ_TIMEOUT_MS;
}

export function isGraphqlGhArgs(args: readonly string[]): boolean {
  return (args[0] ?? "") === "api" && (args[1] ?? "") === "graphql";
}

/**
 * 把 GraphQL 的字符串变量从 `-F` 改回 `-f`。
 *
 * `-F` 会按字面量推类型：仓库名恰好是 `true`、owner 以 `@` 开头时会被当成布尔/文件，
 * 得到一条看不懂的 GraphQL 错误。字符串字段永远走 `-f`。
 */
export function normalizeGhStringFields(args: readonly string[]): string[] {
  const out = [...args];
  for (let index = 0; index < out.length - 1; index += 1) {
    if (out[index] !== "-F") continue;
    const pair = out[index + 1] ?? "";
    const key = pair.slice(0, pair.indexOf("="));
    if (key && STRING_FIELDS.has(key)) out[index] = "-f";
  }
  return out;
}

export function ghCommandLabel(args: readonly string[]): string {
  const words = args.slice(0, 2).filter((arg) => !arg.startsWith("-"));
  return words.join(" ") || "gh";
}

/** 默认执行器：execFile + 参数数组。凭据留在 gh 自己的配置里，这里不碰任何 token。 */
export const defaultGhExec: GhExec = async (args, options = {}) => {
  const timeout = options.timeoutMs ?? timeoutForGhArgs(args);
  try {
    const { stdout, stderr } = await execFileAsync("gh", [...args], {
      timeout,
      maxBuffer: MAX_BUFFER,
      cwd: options.cwd,
    });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (error) {
    const record = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
      killed?: unknown;
      signal?: unknown;
    };
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    const exitCode = typeof record.code === "number" ? record.code : record.code === "ENOENT" ? -1 : null;
    const classified = classifyGhFailure({
      exitCode,
      stdout,
      stderr,
      message: record.code === "ENOENT" ? "" : typeof record.message === "string" ? record.message : String(error),
      killed: record.killed === true,
      signal: typeof record.signal === "string" ? record.signal : null,
    });
    return { ok: false, error: classified, stdout, stderr, exitCode };
  }
};

function parseGraphqlRateLimit(stdout: string): { cost: number | null; rate: GhRateSnapshot["graphql"] } {
  try {
    const payload = JSON.parse(stdout || "{}") as {
      data?: {
        rateLimit?: { cost?: unknown; limit?: unknown; remaining?: unknown; resetAt?: unknown };
      };
    };
    const cell = payload.data?.rateLimit;
    if (!cell || typeof cell !== "object") return { cost: null, rate: null };
    const cost = typeof cell.cost === "number" && Number.isFinite(cell.cost) ? cell.cost : null;
    if (typeof cell.limit !== "number" || typeof cell.remaining !== "number") return { cost, rate: null };
    return {
      cost,
      rate: {
        limit: cell.limit,
        remaining: cell.remaining,
        resetAt: typeof cell.resetAt === "string" ? cell.resetAt : "",
      },
    };
  } catch {
    return { cost: null, rate: null };
  }
}

function restArgs(path: string, options: GhRestOptions): string[] {
  const args = ["api", path];
  if (options.method && options.method !== "GET") args.push("--method", options.method);
  if (options.include) args.push("--include");
  for (const header of options.headers ?? []) args.push("--header", header);
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) args.push("-f", `${key}[]=${item}`);
    } else if (typeof value === "number") {
      args.push("-F", `${key}=${value}`);
    } else {
      args.push("-f", `${key}=${value}`);
    }
  }
  if (options.jq) args.push("--jq", options.jq);
  return args;
}

/**
 * 建一个 gh 客户端。
 *
 * `exec` 可注入：测试用 fixture 执行器，生产用 `execFile("gh", args)`。
 * 客户端只记录「这一趟用了多少 GraphQL 点 / REST 请求」以及最新一份限流快照；
 * 它不缓存响应，除 ETag 之外没有隐藏状态。
 */
export function createGhClient(exec: GhExec = defaultGhExec): GhClient {
  let stats: GhBudgetStats = { graphqlCalls: 0, graphqlPoints: 0, restRequests: 0, cliCalls: 0 };
  let snapshot: GhRateSnapshot = { graphql: null, rest: null };

  async function run(args: readonly string[], options: GhExecOptions = {}): Promise<GhResult> {
    const started = await exec(args, { timeoutMs: options.timeoutMs ?? timeoutForGhArgs(args), cwd: options.cwd });
    if (isGraphqlGhArgs(args)) {
      stats.graphqlCalls += 1;
      stats.graphqlPoints += 1;
      if (started.ok) {
        const parsed = parseGraphqlRateLimit(started.stdout);
        if (parsed.rate) snapshot = { ...snapshot, graphql: parsed.rate };
        // 查询实际点数大于 1 时用服务端的 cost 修正估算值（GraphQL 按点计费，不是按次）。
        if (parsed.cost !== null && parsed.cost > 1) stats.graphqlPoints += parsed.cost - 1;
      }
    } else if ((args[0] ?? "") === "api") {
      stats.restRequests += 1;
    } else {
      stats.cliCalls += 1;
    }
    return started;
  }

  return {
    exec: (args, options = {}) => run(args, options),
    async graphql(query, variables, options = {}) {
      const args = ["api", "graphql"];
      if (options.method === "POST") args.push("--method", "POST");
      args.push("-f", `query=${query}`);
      for (const [key, value] of Object.entries(variables)) {
        if (Array.isArray(value)) {
          // GraphQL 的列表变量：gh 用 `-f key[]=x` 表达 [String!]。
          for (const item of value) args.push("-f", `${key}[]=${item}`);
          continue;
        }
        args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
      }
      return run(normalizeGhStringFields(args), options);
    },
    async rest(path, options = {}) {
      return run(restArgs(path, options), options);
    },
    stats: () => ({ ...stats }),
    resetStats: () => {
      stats = { graphqlCalls: 0, graphqlPoints: 0, restRequests: 0, cliCalls: 0 };
    },
    rateSnapshot: () => ({ graphql: snapshot.graphql, rest: snapshot.rest }),
  };
}
