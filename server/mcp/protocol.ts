import { PLUGIN_VERSION } from "../../shared/version.ts";
import { MCP_SERVER_NAME } from "./tools.ts";
import type { ToolContext } from "./tools.ts";
import { MCP_TOOLS, findTool } from "./tools.ts";

/**
 * 最小 MCP 服务端协议（新行分隔的 JSON-RPC 2.0）。
 *
 * 只实现 Agent 真正会用的四件事：`initialize`、`tools/list`、`tools/call`、`ping`。
 * 不实现 resources / prompts / 采样 / 进度回调——多实现一个方法就多一处要跟着协议版本改的地方，
 * 而插件只需要「让 Agent 读写票面」。
 *
 * 这一层是纯函数：输入一行文本，输出一个响应对象。不碰 stdin/stdout，所以能被单元测试直接驱动，
 * 不必起子进程。
 */

/** 客户端不带版本或带我们不认识的版本时，回这个（MCP 最早被广泛支持的版本）。 */
export const FALLBACK_PROTOCOL_VERSION = "2024-11-05";

/** 我们声明支持的协议版本；客户端给的版本在这个集合里就原样回给客户端。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18"];

export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type RpcId = string | number | null;

export interface RpcSuccess {
  jsonrpc: "2.0";
  id: RpcId;
  result: Record<string, unknown>;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: RpcId;
  error: { code: number; message: string };
}

export type RpcResponse = RpcSuccess | RpcFailure;

const success = (id: RpcId, result: Record<string, unknown>): RpcSuccess => ({ jsonrpc: "2.0", id, result });
const failure = (id: RpcId, code: number, message: string): RpcFailure => ({ jsonrpc: "2.0", id, error: { code, message } });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asId = (value: unknown): RpcId => {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
};

/** 工具的 JSON Schema 原样透传：它已经是我们手写的契约，再生成一遍只会多一层偏差。 */
function toolListing() {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

async function callTool(params: unknown, context: ToolContext): Promise<RpcResponse> {
  if (!isRecord(params)) return failure(null, RPC_ERROR.invalidParams, "tools/call 的 params 必须是对象");
  const name = params.name;
  if (typeof name !== "string" || !name) return failure(null, RPC_ERROR.invalidParams, "tools/call 缺少工具名 name");
  const tool = findTool(name);
  if (!tool) return failure(null, RPC_ERROR.invalidParams, `没有这个工具：${name}`);

  const startedAt = Date.now();
  try {
    const result = await tool.run(params.arguments ?? {}, context);
    return success(null, {
      content: [{ type: "text", text: result.text }],
      ...(result.isError ? { isError: true } : {}),
      // 附一条耗时：Agent 判断「要不要重试」时，慢调用比失败更值得知道。
      _meta: { tool: name, durationMs: Date.now() - startedAt },
    });
  } catch (error) {
    // 领域层已经把能预料的失败变成 result，走到这里就是真异常（例如 gh 回包畸形到映射层抛错）。
    // 不吞：交给客户端当错误报出去。
    const message = error instanceof Error ? error.message : String(error);
    return failure(null, RPC_ERROR.internal, `${name} 执行失败：${message}`);
  }
}

/**
 * 处理一行输入。
 *
 * 返回 `null` 表示这条是通知（通知不回包，协议如此）。返回响应对象则调用方负责写回 stdout。
 */
export async function handleMessage(line: string, context: ToolContext): Promise<RpcResponse | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, RPC_ERROR.parse, "请求不是合法 JSON");
  }
  if (!isRecord(parsed)) return failure(null, RPC_ERROR.invalidRequest, "请求必须是 JSON 对象");
  if (parsed.jsonrpc !== "2.0") return failure(asId(parsed.id), RPC_ERROR.invalidRequest, "只支持 JSON-RPC 2.0");

  const method = parsed.method;
  if (typeof method !== "string" || !method) {
    return failure(asId(parsed.id), RPC_ERROR.invalidRequest, "缺少 method");
  }
  const id = asId(parsed.id);
  const isNotification = parsed.id === undefined;

  if (method === "initialize") {
    const requested = isRecord(parsed.params) ? parsed.params.protocolVersion : undefined;
    const version = typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : FALLBACK_PROTOCOL_VERSION;
    return success(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: PLUGIN_VERSION },
    });
  }
  if (method === "ping") return success(id, {});
  if (method === "tools/list") return success(id, { tools: toolListing() });
  if (method === "tools/call") {
    const result = await callTool(parsed.params, context);
    if (isNotification) return null;
    return { ...result, id };
  }
  if (isNotification) return null;
  return failure(id, RPC_ERROR.methodNotFound, `不支持的方法：${method}`);
}
