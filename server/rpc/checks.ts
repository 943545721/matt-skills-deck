import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { checksRunRpc } from "../../shared/checks-rpc.ts";
import { evaluateChecks } from "../checks.ts";

type ChecksInput = RpcInput<typeof checksRunRpc>;

/**
 * 检查链 RPC 出口。
 *
 * 只探测、不修复；动作对象原样交给客户端，由界面决定是复制命令、开表单还是注入提示词。
 */
export async function checksRunHandler(input: ChecksInput): Promise<RpcOutput<typeof checksRunRpc>> {
  const report = await evaluateChecks({ workspaceDir: input.workspaceDir, backend: input.backend });
  return {
    backend: report.backend,
    checks: report.checks.map((check) => ({
      id: check.id,
      status: check.status,
      ...(check.detail === undefined ? {} : { detail: check.detail }),
      ...(check.action === undefined
        ? {}
        : { action: check.action.map((action) => ({ ...action })) }),
    })),
    guide: report.guide,
    checkedAt: report.checkedAt,
  };
}
