import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { envCheckRpc } from "../../shared/env.ts";
import { collectEnvChecks } from "../env.ts";

type EnvCheckInput = RpcInput<typeof envCheckRpc>;

/**
 * 环境检查的 RPC 出口。
 *
 * 检查本身是只读的（最多跑 `--version` / `auth status` 与一次标签列表），
 * 所以它不像写操作那样需要预检票据；但也不会替用户执行 `fix` 里的命令。
 */
export async function envCheckHandler(input: EnvCheckInput): Promise<RpcOutput<typeof envCheckRpc>> {
  const { backend, checks } = await collectEnvChecks(input.workspaceDir);
  return { backend, checks, checkedAt: new Date().toISOString() };
}
