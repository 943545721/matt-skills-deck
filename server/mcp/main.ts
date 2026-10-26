import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { handleMessage } from "./protocol.ts";
import { MCP_SERVER_NAME } from "./tools.ts";
import type { ToolContext } from "./tools.ts";

/**
 * MCP 服务端进程入口。
 *
 * 由 daemon 在我们自己注入的 `mcpServers` 里拉起（见 `server/hooks.ts`），
 * 通过 stdin/stdout 走新行分隔的 JSON-RPC。
 *
 * 三条纪律：
 * 1. stdout 只写协议消息，一个字节的诊断都不许混进去——混一行日志就毁掉整个会话。
 * 2. 逐行串行处理：工具之间有「先查再写」的依赖，并发执行会让 Agent 读到过期状态。
 * 3. 工作区目录是启动参数，不是每条请求的参数：Agent 不该有能力把工具指向别处。
 */

const USAGE = "用法：mcp/main.ts --workspace <工作区绝对路径>";

/** 从 argv 里取 `--workspace`。缺参数或不是目录都直接退出，而不是让每次工具调用都报「没有仓库」。 */
function parseWorkspace(argv: readonly string[]): { dir: string } | { error: string } {
  const index = argv.indexOf("--workspace");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (!raw) return { error: `缺少 --workspace 参数。${USAGE}` };
  const dir = isAbsolute(raw) ? raw : resolve(raw);
  try {
    if (!statSync(dir).isDirectory()) return { error: `--workspace 不是目录：${dir}` };
  } catch {
    return { error: `--workspace 不存在：${dir}` };
  }
  return { dir };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const workspace = parseWorkspace(argv);
  if ("error" in workspace) {
    process.stderr.write(`[${MCP_SERVER_NAME}] ${workspace.error}\n`);
    return 2;
  }

  const context: ToolContext = { workspaceDir: workspace.dir };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // stdout 被对端关掉（Agent 结束、daemon 重启）是正常退出，不是错误。
  process.stdout.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
    process.stderr.write(`[${MCP_SERVER_NAME}] stdout 写入失败：${error.message}\n`);
    process.exit(1);
  });

  let chain: Promise<void> = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      const response = await handleMessage(line, context);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch((error: unknown) => {
      // handleMessage 自己已经兜住了可预料的失败；到这里的只可能是写 stdout 失败之类的真异常。
      process.stderr.write(`[${MCP_SERVER_NAME}] 处理失败：${error instanceof Error ? error.message : String(error)}\n`);
    });
  });

  await new Promise<void>((resolveDone) => lines.on("close", resolveDone));
  await chain;
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().then((code) => process.exit(code));
}
