import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { publishConfirmRpc, publishPlanRpc, publishRunRpc } from "../../shared/publish-rpc.ts";
import { record } from "../logs.ts";
import { planPublish, verifyPublishToken } from "../publish.ts";
import { createGithubOperations, type GithubOperations } from "../tracker/github/operations.ts";
import type { InitProjectError } from "../tracker/github/init.ts";

type PlanInput = RpcInput<typeof publishPlanRpc>;
type ConfirmInput = RpcInput<typeof publishConfirmRpc>;
type RunInput = RpcInput<typeof publishRunRpc>;

const RUN_FAILURE_KINDS: readonly InitProjectError["kind"][] = [
  "bad-name",
  "no-git",
  "no-gh",
  "not-logged-in",
  "already-exists",
  "network",
  "permission",
  "git-ownership",
  "unknown",
];

/**
 * 发布计划出口：只构造 argv 与展示脚本，不执行。
 *
 * 命令里的 argv 复制成普通数组再出门，避免把服务端内部的只读元组类型漏进 RPC 形状。
 */
export function publishPlanHandler(input: PlanInput): RpcOutput<typeof publishPlanRpc> {
  const result = planPublish(input);
  if (!result.ok) return result;
  return {
    ...result,
    commands: result.commands.map((command) => ({
      argv: [...command.argv],
      why: command.why,
      ...(command.when === undefined ? {} : { when: command.when }),
    })),
    notes: [...result.notes],
    warnings: [...result.warnings],
  };
}

/** 二次确认：令牌绑定 cwd / 名称 / 可见性 / 路线与完整命令序列；计划改过即失效。 */
export function publishConfirmHandler(input: ConfirmInput): RpcOutput<typeof publishConfirmRpc> {
  return verifyPublishToken(input.plan, input.token);
}

/**
 * 执行建仓发布。
 *
 * 这是 `gh:remote` 那枚两步向导的提交端点：用户在向导里填了仓库名与可见性并确认，
 * 才走到这里。它真的会改工作区（git init / add / commit）与远端（gh repo create + push），
 * 所以失败档位原样带回界面，不在这里翻译成「成功了」。
 *
 * 第二个参数只为测试注入执行器；生产环境由 `server.handle(publishRunRpc, …)` 注册时
 * 会用 handler 的第二个参数传宿主上下文（PluginHandlerContext），所以注册端走下面的
 * `publishRunRpcHandler` 包装，不把这个函数直接交给 server.handle。
 */
export async function publishRunHandler(
  input: RunInput,
  ops: Pick<GithubOperations, "projectInit">,
): Promise<RpcOutput<typeof publishRunRpc>> {
  const result = await ops.projectInit({
    cwd: input.workspaceDir,
    name: input.name,
    visibility: input.visibility,
  });
  if (!result.ok) {
    const error = (result.error ?? {}) as Partial<InitProjectError>;
    const rawKind = String(error.kind ?? "unknown");
    const reason = (RUN_FAILURE_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as InitProjectError["kind"])
      : "unknown";
    const detail = error.message || rawKind || "创建失败";
    record("error", "publish.run", `建仓失败（${reason}）：${detail.slice(0, 200)}`);
    return { ok: false, reason, detail, ...(error.repoUrl ? { repoUrl: error.repoUrl } : {}) };
  }
  record("info", "publish.run", `已建仓 ${result.data.owner}/${result.data.name}（${result.data.route}）`);
  return {
    ok: true,
    owner: result.data.owner,
    name: result.data.name,
    url: result.data.url,
    route: result.data.route,
    healedOwnership: result.data.healedOwnership,
  };
}

/**
 * `server.handle` 注册用的薄包装：宿主会把 handler 上下文作为第二参数传进来，
 * 这里忽略它并建真实的 gh 操作集。测试直接调 `publishRunHandler(input, fakeOps)`。
 */
export function publishRunRpcHandler(input: RunInput): Promise<RpcOutput<typeof publishRunRpc>> {
  return publishRunHandler(input, createGithubOperations());
}
