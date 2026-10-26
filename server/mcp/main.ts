import { createInterface } from "node:readline";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMessage, needsSerialization } from "./protocol.ts";
import { MCP_SERVER_NAME } from "./tools.ts";
import type { ToolContext } from "./tools.ts";

/**
 * MCP 服务端进程入口。
 *
 * 由 daemon 在我们自己注入的 `mcpServers` 里拉起（见 `server/hooks.ts`），
 * 通过 stdin/stdout 走新行分隔的 JSON-RPC。
 *
 * 四条纪律：
 * 1. stdout 只写协议消息，一个字节的诊断都不许混进去——混一行日志就毁掉整个会话。
 * 2. `tools/call` 逐行串行：工具之间有「先查再写」的依赖，并发执行会让 Agent 读到过期状态。
 *    纯计算方法（initialize / ping / tools/list）不排队，免得被一次 20s 的 gh 超时挡住。
 * 3. 工作区目录是启动参数，不是每条请求的参数：Agent 不该有能力把工具指向别处。
 * 4. 每条回包要等 stdout 真的收下再处理下一行，且退出走 `process.exitCode` 而不是 `process.exit()`，
 *    否则大于管道缓冲区的回包会被截断。
 */

const USAGE = "用法：mcp/main.ts --workspace <工作区绝对路径>";

/** 从 argv 里取 `--workspace`。缺参数或不是目录都直接退出，而不是让每次工具调用都报「没有仓库」。 */
function parseWorkspace(argv: readonly string[]): { dir: string } | { error: string } {
  const index = argv.indexOf("--workspace");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (!raw) return { error: `缺少 --workspace 参数。${USAGE}` };
  if (!isAbsolute(raw)) return { error: `--workspace 必须是绝对路径：${raw}` };
  const dir = raw;
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

  /** 对端已经关了 stdout：不再往里写，也不再接新行。 */
  let peerGone = false;
  let exitCode = 0;

  // stdout 被对端关掉（Agent 结束、daemon 重启）是正常退出，不是错误。
  // 这里只记退出码并收掉入流，不调 process.exit()——那会砍掉仍在缓冲里的回包。
  process.stdout.on("error", (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    peerGone = true;
    lines.close();
    if (code === "EPIPE") {
      exitCode = 0;
      return;
    }
    process.stderr.write(`[${MCP_SERVER_NAME}] stdout 写入失败：${error.message}\n`);
    exitCode = 1;
  });

  /**
   * 写一行并等它真的交给内核。
   *
   * `stdout.write()` 只是入队：不等回调就退出，大于管道缓冲区（约 64KB）的回包会被截断，
   * Agent 收到半截 JSON；如果截掉的是写操作的回包，它还会重试一次，于是远端多一条重复评论。
   */
  const writeLine = (payload: string): Promise<void> =>
    new Promise((resolve) => {
      process.stdout.write(payload, () => resolve());
    });

  const reply = async (line: string): Promise<void> => {
    if (peerGone) return;
    const response = await handleMessage(line, context);
    if (!response || peerGone) return;
    await writeLine(`${JSON.stringify(response)}\n`);
  };

  const reportFailure = (error: unknown): void => {
    // handleMessage 自己已经兜住了可预料的失败；到这里的只可能是写 stdout 失败之类的真异常。
    process.stderr.write(`[${MCP_SERVER_NAME}] 处理失败：${error instanceof Error ? error.message : String(error)}\n`);
  };

  let chain: Promise<void> = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    if (!needsSerialization(line)) {
      // 纯计算方法不等队列：排在一次 20s 的 gh 超时后面，客户端的存活探测会判定服务器已死。
      void reply(line).catch(reportFailure);
      return;
    }
    chain = chain.then(() => reply(line)).catch(reportFailure);
  });

  await new Promise<void>((resolveDone) => lines.on("close", resolveDone));
  await chain;
  return exitCode;
}

/**
 * 这一份代码是不是被当作入口在跑。
 *
 * 两侧都取 realpath 再比：`import.meta.url` 是 Node 解析符号链接后的真路径，而 `argv[1]`
 * 是用户敲的那个字面路径。只比字面路径的话，插件装在软链目录下（`~/.paseo` 被软链到别的盘、
 * 包管理器把版本目录软链成固定名、macOS 的 `/tmp` → `/private/tmp`）会永远判不等，
 * 进程 exit 0 且 stdout/stderr 全空——客户端看到的是「服务器握手时消失」。
 */
function isEntryPoint(): boolean {
  const entryFile = process.argv[1];
  if (!entryFile) return false;
  try {
    return realpathSync(entryFile) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main().then((code) => {
    process.exitCode = code;
  });
} else if ((process.argv[1] ?? "").endsWith("main.ts")) {
  // 只有在「argv 明明指着 main.ts，判定却失败」时才会到这里（例如被转译器包了一层）。
  // 打一行到 stderr，别再出现进程开着却永不响应、两边都全空的静默失败。
  process.stderr.write(`[${MCP_SERVER_NAME}] 入口判定失败：${process.argv[1]}\n`);
}
