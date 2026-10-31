import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  orchestrationDispatchRpc,
  orchestrationProfileRpc,
  orchestrationProviderDiagnosticRpc,
  orchestrationProviderInstallRpc,
  orchestrationProviderModelsRpc,
  orchestrationProviderRefreshRpc,
  orchestrationProviderRevealRpc,
  orchestrationProviderRpc,
  orchestrationSaveRpc,
  orchestrationSiteRpc,
  orchestrationStateRpc,
} from "../../shared/orchestration-rpc.ts";
import { installProvider } from "../provider-install.ts";
import { refreshProviderCatalog } from "../provider-catalog-refresh.ts";
import { fetchProviderModels } from "../provider-models-fetch.ts";
import {
  patchProviderConfig,
  readDaemonConfig,
  readOrchestrationState,
  revealProviderEnvValue,
  runDispatch,
  saveClientSite,
  saveOrchestration,
  saveProfile,
} from "../orchestration.ts";

/**
 * 编排的 RPC 出口。
 *
 * 只做字段搬运：执行层已经把所有失败收敛成结果联合，这里不再吞一次异常，
 * 也不把「读失败」改成空数组装作一切正常。
 */

export async function orchestrationStateHandler(
  input: RpcInput<typeof orchestrationStateRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationStateRpc>> {
  const state = await readOrchestrationState(context.paseo, {
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
  });
  if (!state.ok) return state;
  return {
    ok: true,
    workspaceId: state.workspaceId,
    workspaceDir: state.workspaceDir,
    settings: state.settings,
    profiles: state.profiles,
    routing: state.routing,
    providers: state.providers,
    agents: state.agents,
    tree: state.tree,
    warnings: state.warnings,
  };
}

export async function orchestrationSaveHandler(
  input: RpcInput<typeof orchestrationSaveRpc>,
): Promise<RpcOutput<typeof orchestrationSaveRpc>> {
  // `workspaceId` 必须透传：保存时它是「这份文件属于谁」的唯一可信来源。
  // 丢了它就退回「角色里唯一那个工作区」，清空本工作区角色后归属会被改成别的。
  const explicit = input.workspaceId?.trim();
  // 传了却是空白（`"   "` 能过 schema 的 min(1)）：不能静默当成「没传」去猜归属。
  if (input.workspaceId !== undefined && !explicit) {
    return { ok: false, reason: "invalid", detail: "workspaceId 传了但是空白：要么给一个真的工作区 id，要么别传" };
  }
  return saveOrchestration({
    workspaceDir: input.workspaceDir,
    settings: input.settings,
    ...(explicit ? { workspaceId: explicit } : {}),
  });
}

export async function orchestrationProviderHandler(
  input: RpcInput<typeof orchestrationProviderRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationProviderRpc>> {
  return patchProviderConfig(context.paseo, {
    provider: input.provider,
    ...(input.env ? { env: input.env } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.models ? { models: input.models } : {}),
  });
}

export async function orchestrationProfileHandler(
  input: RpcInput<typeof orchestrationProfileRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationProfileRpc>> {
  return saveProfile(context.paseo, {
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.removeId ? { removeId: input.removeId } : {}),
  });
}

export async function orchestrationDispatchHandler(
  input: RpcInput<typeof orchestrationDispatchRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationDispatchRpc>> {
  return runDispatch(context.paseo, {
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
    tasks: input.tasks,
    // 地图并发预算靠它数人：没有这一位，配了预算也只会按「本批」算。
    ...(input.map ? { map: input.map } : {}),
    ...(input.depth !== undefined ? { depth: input.depth } : {}),
    ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
    ...(input.callerAgentId ? { callerAgentId: input.callerAgentId } : {}),
    ...(input.lang ? { lang: input.lang } : {}),
  });
}

/**
 * 装客户端。
 *
 * handler 只搬字段：`installProvider` 已经把「没这条配方 / 正在装 / 装失败」收敛成结果联合。
 * 装成功后**不在这里顺手改别的东西**——界面自己重取状态，才能看到宿主新解析到的命令。
 */
export async function orchestrationProviderInstallHandler(
  input: RpcInput<typeof orchestrationProviderInstallRpc>,
): Promise<RpcOutput<typeof orchestrationProviderInstallRpc>> {
  return installProvider({ provider: input.provider });
}

/** 诊断文本的截断长度：宿主可能贴出整段 PATH 与若干条 which 结果。 */
const MAX_DIAGNOSTIC = 8_000;

export async function orchestrationProviderDiagnosticHandler(
  input: RpcInput<typeof orchestrationProviderDiagnosticRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationProviderDiagnosticRpc>> {
  const provider = input.provider.trim();
  if (!provider) return { ok: false, reason: "invalid", detail: "要诊断哪个客户端？没给 provider" };
  try {
    const result = await context.paseo.providers.diagnostic(provider);
    const text = (result?.diagnostic ?? "").trim();
    if (!text) {
      return { ok: false, reason: "empty", detail: "宿主没有给出诊断文本：这一版可能还不支持 provider 诊断" };
    }
    return {
      ok: true,
      provider,
      diagnostic: text.length > MAX_DIAGNOSTIC ? `${text.slice(0, MAX_DIAGNOSTIC)}\n…（已截断）` : text,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 看某一个注入键的原值：一次一个键，值不进日志。 */
export async function orchestrationProviderRevealHandler(
  input: RpcInput<typeof orchestrationProviderRevealRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationProviderRevealRpc>> {
  return revealProviderEnvValue(context.paseo, { provider: input.provider, key: input.key });
}

/** 客户端下的站点：加/改/删/启用。凭证只在服务端落盘，回给界面的一律是掩码。 */
export async function orchestrationSiteHandler(
  input: RpcInput<typeof orchestrationSiteRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationSiteRpc>> {
  return saveClientSite(context.paseo, {
    provider: input.provider,
    ...(input.site ? { site: input.site } : {}),
    ...(input.removeId ? { removeId: input.removeId } : {}),
    ...(input.enableId ? { enableId: input.enableId } : {}),
  });
}

/** 问接口要模型清单：凭据只进请求头，结果里只回模型 id。 */
export async function orchestrationProviderModelsHandler(
  input: RpcInput<typeof orchestrationProviderModelsRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationProviderModelsRpc>> {
  return fetchProviderModels(context.paseo, { provider: input.provider });
}

/**
 * 让宿主重读 provider 快照。
 *
 * 改完接入地址或模型清单之后，宿主的模型选择器还缓存着旧清单；这里刷新一次
 * 并回读，界面据此说明「刷新后有几家、各几个模型」。不重启、不动会话。
 */
export async function orchestrationProviderRefreshHandler(
  input: RpcInput<typeof orchestrationProviderRefreshRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationProviderRefreshRpc>> {
  // 停用判断和状态页用同一份宿主配置：配置里关掉的客户端，选择器里也没有。
  const config = await readDaemonConfig(context.paseo);
  return refreshProviderCatalog(context.paseo, { workspaceDir: input.workspaceDir, config });
}
