import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { record } from "./logs.ts";
import { MCP_SERVER_NAME, PREAPPROVED_TOOL_NAMES } from "./mcp/tools.ts";
import { pluginRoot } from "./paths.ts";
import { resolveRepo } from "./rpc/repo-gate.ts";

/**
 * 生命周期钩子：把 deck_* 工具挂到 Agent 身上。
 *
 * 为什么走 `before agent.create` 而不是让用户手写 MCP 配置：装插件就该能用。
 * 为什么只挂 GitHub 工作区：其余工作区的工具每次调用都只会回「没有仓库」，
 * 白白占着上下文和权限面板，不如不注入。
 *
 * 只读工具进 preapproved（Agent 可以自己读票），写工具不进（改远端票面必须经用户确认）。
 */

type AgentCreateRequest = PluginBeforeRequests["agent.create"];

const SCOPE = "mcp";

/** 注入器本体是纯函数：给定配置就回新配置，便于单测，也保证不原地改请求。 */
export function injectDeckTools(
  request: AgentCreateRequest,
  input: { entry: string; workspaceDir: string },
): AgentCreateRequest {
  const config = request.config;
  // name 不能叫 "paseo"（保留名），其余随便；固定成插件 id 让用户在权限面板里一眼认出。
  const mcpServers = {
    ...(config.mcpServers ?? {}),
    [MCP_SERVER_NAME]: {
      type: "stdio" as const,
      // 用当前进程的可执行文件跑同一个 Node：它此刻正在执行本插件的 TypeScript，
      // 因此一定能跑 `server/mcp/main.ts`（Node 22.18+ 默认剥离类型），不必另找解释器。
      command: process.execPath,
      args: [input.entry, "--workspace", input.workspaceDir],
      // 这 7 个工具是插件的核心能力，不许被工具检索折叠掉，否则 Agent 根本不知道它们存在。
      alwaysLoad: true,
    },
  };
  const existing = config.toolPolicy?.preapproved ?? [];
  const seen = new Set(existing.map((ref) => `${ref.server}/${ref.tool}`));
  const preapproved = [
    ...existing,
    ...PREAPPROVED_TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: MCP_SERVER_NAME, tool }))
      .filter((ref) => !seen.has(`${ref.server}/${ref.tool}`)),
  ];
  return { ...request, config: { ...config, mcpServers, toolPolicy: { preapproved } } };
}

/** 插件安装目录下的 MCP 进程入口。 */
export function mcpEntryPath(root: string): string {
  return path.join(root, "server", "mcp", "main.ts");
}

/** 当前进程的 `process.features`（Node 的类型能力标志就在里面）。 */
export function runtimeFeatures(): unknown {
  return (process as { features?: unknown }).features;
}

/**
 * 当前 Node 能不能直接跑 `.ts`。
 *
 * 22.18+ 默认剥离类型（`process.features.typescript === "strip"`）。更老的版本挂上去只会得到
 * 「server failed to start」——而且每个新会话都会重演，所以宁可明确跳过并说明原因。
 *
 * 参数显式传入（而不是默认读 `process.features`），测试才能确定性地覆盖两种能力。
 */
export function typescriptSupported(features: unknown): boolean {
  const value = (features as { typescript?: unknown } | undefined)?.typescript;
  return value === "strip" || value === "transform";
}

/**
 * 注入前的前置检查：返回该跳过并记录的原因，`null` 表示可以注入。
 *
 * 纯函数便于单测：这两条一旦漏掉，用户看到的是「装了插件但 Agent 没有工具」，日志里却什么都没有。
 */
export function injectionProblem(input: { entry: string; entryPresent: boolean; typescript: boolean }): string | null {
  if (!input.typescript) return "当前 Node 不支持直接运行 TypeScript（需要 22.18+），跳过 deck 工具注入";
  if (!input.entryPresent) return `找不到 MCP 入口文件，跳过 deck 工具注入：${input.entry}`;
  return null;
}

export function registerHooks(server: PluginServerContext): void {
  server.before("agent.create", async ({ request }) => {
    try {
      const gate = await resolveRepo(request.config.cwd);
      if (!gate.ok || gate.ref.host !== "github") {
        // 不是「出错」，是「这个工作区没有票可读」，所以不注入也不报错，只留一行日志便于排查。
        // 日志带上实际原因（没有远端 / 不是仓库 / 没有 git），别一律写成「没有远端」。
        const why = gate.ok ? `远端是 ${gate.ref.host}` : gate.detail;
        record("info", SCOPE, `未注入 deck 工具（${why}）：${request.config.cwd}`);
        return request;
      }
      const entry = mcpEntryPath(pluginRoot());
      const problem = injectionProblem({
        entry,
        entryPresent: existsSync(entry),
        typescript: typescriptSupported(runtimeFeatures()),
      });
      if (problem) {
        record("warn", SCOPE, problem);
        return request;
      }
      return injectDeckTools(request, { entry, workspaceDir: request.config.cwd });
    } catch (error) {
      // 注入失败不该拦住用户开会话：原样放行，日志里留下原因。
      record("warn", SCOPE, `注入 deck 工具失败：${error instanceof Error ? error.message : String(error)}`);
      return request;
    }
  });
}
