import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  CoordinationActionWire,
  orchestrationArchivedRpc,
  orchestrationDispatchRpc,
  orchestrationInboxActRpc,
  orchestrationInboxRpc,
  orchestrationProfileRpc,
  orchestrationProviderDiagnosticRpc,
  orchestrationProviderInstallRpc,
  orchestrationProviderModelsRpc,
  orchestrationProviderRefreshRpc,
  orchestrationProviderRevealRpc,
  orchestrationProviderRpc,
  orchestrationRequirementDispatchRpc,
  orchestrationSaveRpc,
  orchestrationSiteRpc,
  orchestrationStaffStopRpc,
  orchestrationStateRpc,
  orchestrationWindowRpc,
  WindowFailureReason,
} from "../../shared/orchestration-rpc.ts";
import type { PaseoApi } from "@getpaseo/client";
import {
  DECK_ROLE_LABEL,
  DECK_ROLE_WINDOW_LABEL,
  ROLE_WINDOW_TITLES,
  agentIdOf,
  providerSpec,
  resolveRoute,
  resolveRouteTarget,
  rolePromptFor,
  withAgentIdFor,
  withWorkspaceRoles,
  type ClientTarget,
  type FixedRole,
  type OrchestrationSettings,
  type RoleLang,
  type WorkspaceRoles,
} from "../../shared/orchestration.ts";
import { readOrchestration, writeOrchestration } from "../orchestration-store.ts";
import { installProvider } from "../provider-install.ts";
import { refreshProviderCatalog } from "../provider-catalog-refresh.ts";
import { fetchProviderModels } from "../provider-models-fetch.ts";
import {
  patchProviderConfig,
  profilesOf,
  readDaemonConfig,
  readOrchestrationState,
  revealProviderEnvValue,
  runDispatch,
  saveClientSite,
  saveOrchestration,
  saveProfile,
} from "../orchestration.ts";
import { createAgent, sessionErrorDetail } from "../session.ts";
import {
  readRequirementForDispatch,
  requirementWorkspacesOf,
  runRequirementDispatch,
  summarizeRequirementDispatch,
} from "../requirement-dispatch.ts";
import { listArchivedAgents } from "../archived-agents.ts";
import { stopStaffSessions } from "../staff-stop.ts";
import { record } from "../logs.ts";
import {
  deliverReassign,
  resolveReassignTarget,
  type ResolvedReassignTarget,
} from "../staff-reassign.ts";
import {
  approveCoordination,
  contractChangedCoordination,
  declineCoordination,
  denyCoordination,
  implChangedCoordination,
  readCoordination,
  reassignCoordination,
  staffCoordination,
  sweepCoordination,
  type CoordinationKind,
  type CoordinationRecord,
  type CoordinationTransitionResult,
} from "../staff-territory.ts";

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

/**
 * 已归档会话清单。
 *
 * 这一页只读：列出本工作区已归档的会话、它们的 provider 会话 id 与拼好的恢复命令。
 * 真正的恢复由用户自己执行那条命令（宿主没有取消归档的接口），插件不替用户 import。
 */
export async function orchestrationArchivedHandler(
  input: RpcInput<typeof orchestrationArchivedRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationArchivedRpc>> {
  return listArchivedAgents(context.paseo, {
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
}

/* ---------------------------------------------------------------- 协调收件箱 */

/** 状态机里 kind 与动作的合法组合：前端点错一次也要在这里被拒，不能靠界面自觉。 */
const ALLOWED_INBOX_ACTIONS: Record<CoordinationKind, readonly CoordinationActionWire[]> = {
  territory: ["approve-once", "reassign", "deny"],
  staffing: ["staff", "decline"],
  contract: ["contract-changed", "impl-changed"],
  // 血缘只是账，不是待办：收件箱里也不显示（见下面的过滤），没有任何动作。
  lineage: [],
};

function inboxRecordOf(record: CoordinationRecord) {
  return {
    at: record.at,
    kind: record.kind,
    state: record.state,
    fromStaff: record.fromStaff,
    toStaff: record.toStaff,
    paths: [...record.paths],
    sessionAgentId: record.sessionAgentId,
    taskSummary: record.taskSummary,
    ...(record.need === undefined ? {} : { need: record.need }),
    ...(record.field === undefined ? {} : { field: record.field }),
  };
}

/** 收件箱动作 → 状态机入口。表驱动，动作名与状态机函数一一对应，不加分支。 */
const INBOX_TRANSITIONS: Record<
  CoordinationActionWire,
  (dir: string, ref: number, toStaff?: string) => Promise<CoordinationTransitionResult>
> = {
  "approve-once": approveCoordination,
  reassign: reassignCoordination,
  deny: denyCoordination,
  staff: staffCoordination,
  decline: declineCoordination,
  "contract-changed": contractChangedCoordination,
  "impl-changed": implChangedCoordination,
};

/** 收件箱失败原因：状态机只回 detail，按它说的是哪一类落一个机器码。 */
function actionFailure(
  detail: string,
): { ok: false; reason: "read-failed" | "invalid-state" | "not-found" | "write-failed" | "action-failed"; detail: string } {
  if (detail.startsWith("读取")) return { ok: false, reason: "read-failed", detail };
  if (detail.includes("找不到")) return { ok: false, reason: "not-found", detail };
  if (detail.includes("当前状态")) return { ok: false, reason: "invalid-state", detail };
  if (detail.startsWith("写入")) return { ok: false, reason: "write-failed", detail };
  return { ok: false, reason: "action-failed", detail };
}

/**
 * 读收件箱：先跑一次 24 小时清扫，再按文件里的顺序吐出行。
 *
 * 清扫前后的下标一一对应（`sweepCoordination` 只换状态、不重排），所以客户端拿
 * 读到的 `index` 去动作 RPC 定位是稳的；新请求只会追加在末尾。
 */
export async function orchestrationInboxHandler(
  input: RpcInput<typeof orchestrationInboxRpc>,
): Promise<RpcOutput<typeof orchestrationInboxRpc>> {
  const workspaceId = input.workspaceId.trim();
  const workspaceDir = input.workspaceDir.trim();
  if (!workspaceId || !workspaceDir) {
    return { ok: false, reason: "invalid-workspace", detail: "需要 workspaceId 与工作区目录" };
  }

  // 读一次原状是为了区分「这次读到才超时取消」与历史上已经取消的记录。
  const before = await readCoordination(workspaceDir);
  if (before.failed) return { ok: false, reason: "read-failed", detail: before.failed };

  const swept = await sweepCoordination(workspaceDir);
  if (!swept.ok) return { ok: false, reason: "sweep-failed", detail: swept.detail };

  const warnings: string[] = [];
  if (before.skipped > 0) warnings.push(`收件箱里有 ${before.skipped} 行无法解析，已跳过`);
  if (swept.cancelled > 0) {
    warnings.push(`已自动取消 ${swept.cancelled} 条超过 24 小时没人处置的请求`);
  }

  // 先带原下标映射，再滤掉血缘：收件箱动作拿 `index` 指文件里的行，滤掉后
  // 下标仍是文件里的位置，点「批准」不会指到隔壁那条。
  const records = swept.records
    .map((record, index) => ({
      ...inboxRecordOf(record),
      index,
      ...(before.records[index]?.state === "pending" && record.state === "cancelled" ? { expired: true } : {}),
    }))
    .filter((row) => row.kind !== "lineage");
  return { ok: true, records, warnings };
}

/**
 * 处置一条协调请求。
 *
 * 状态字段只由 `server/staff-territory.ts` 的状态机改；这里做两件事：
 * 校验「这个 kind 能不能点这个动作」，以及 reassign 的目标卡是不是名册里的。
 */
export async function orchestrationInboxActHandler(
  input: RpcInput<typeof orchestrationInboxActRpc>,
  context?: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationInboxActRpc>> {
  const workspaceId = input.workspaceId.trim();
  const workspaceDir = input.workspaceDir.trim();
  if (!workspaceId || !workspaceDir) {
    return { ok: false, reason: "invalid-workspace", detail: "需要 workspaceId 与工作区目录" };
  }

  // 动作前也清扫：一条已经超过 24 小时的 pending 不能因为「人刚打开页面」就被执行。
  const swept = await sweepCoordination(workspaceDir);
  if (!swept.ok) return { ok: false, reason: "sweep-failed", detail: swept.detail };
  const warnings = swept.cancelled > 0
    ? [`已自动取消 ${swept.cancelled} 条超过 24 小时没人处置的请求`]
    : [];

  const target = swept.records[input.index];
  if (!target) {
    return { ok: false, reason: "not-found", detail: `收件箱里没有下标 ${input.index} 的记录：刷新后重试` };
  }

  if (!ALLOWED_INBOX_ACTIONS[target.kind].includes(input.action)) {
    return {
      ok: false,
      reason: "invalid-action",
      detail: `${target.kind} 请求不接受「${input.action}」：可用 ${ALLOWED_INBOX_ACTIONS[target.kind].join(" / ")}`,
    };
  }

  // 转派必须落到一张真的卡上：记录上没有目标时（无主区 / 根经理），由人从名册里选。
  // 工作区以记录自己的为准：同目录多工作区时，不能按打开页面那个去派。
  const targetWorkspaceId = target.workspaceId.trim() || workspaceId;
  let reassign: ResolvedReassignTarget | null = null;
  if (input.action === "reassign") {
    if (target.state !== "pending" && target.state !== "approved-once") {
      return { ok: false, reason: "invalid-state", detail: `当前状态是 ${target.state}，不能再转派` };
    }
    const resolved = await resolveReassignTarget({
      workspaceId: targetWorkspaceId,
      workspaceDir,
      requested: input.toStaff,
      fallback: target.toStaff,
    });
    if (!resolved.ok) return resolved;
    reassign = resolved;
  }

  // 先真的把活交过去，再改状态：派活失败时状态原样不动，收件箱还能再点一次。
  let deliveredAgentId: string | undefined;
  if (reassign) {
    if (!context) {
      return { ok: false, reason: "action-failed", detail: "缺少宿主句柄，没派活；请求状态未改动" };
    }
    const delivery = await deliverReassign({
      paseo: context.paseo,
      workspaceId: targetWorkspaceId,
      workspaceDir,
      record: target,
      card: reassign.card,
      roster: reassign.roster,
      routing: reassign.routing,
      dispatcherAgentId: reassign.dispatcherAgentId,
    });
    if (!delivery.ok) {
      return { ok: false, reason: "action-failed", detail: `派活失败（请求状态未改动，仍可重试）：${delivery.detail}` };
    }
    deliveredAgentId = delivery.agentId;
    warnings.push(...delivery.warnings);
  }

  const result = await INBOX_TRANSITIONS[input.action](workspaceDir, input.index, reassign?.staffId);

  if (!result.ok) {
    const failure = actionFailure(result.detail);
    return deliveredAgentId
      ? {
          ...failure,
          detail: `已把任务发给 ${deliveredAgentId}，但状态没写回：${result.detail}。先刷新收件箱确认，不要直接重复转派`,
        }
      : failure;
  }
  return { ok: true, record: inboxRecordOf(result.record), warnings };
}

/**
 * 阀门四：全停。
 *
 * 只管本工作区里带 `deck.staff` 标的会话：别的会话不是插件建的，插件不替用户处决。
 */
export async function orchestrationStaffStopHandler(
  input: RpcInput<typeof orchestrationStaffStopRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationStaffStopRpc>> {
  return stopStaffSessions(context.paseo, {
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
    ...(input.archive === undefined ? {} : { archive: input.archive }),
  });
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
 * 需求 → 每区一张票 + 每区一批派单。
 *
 * 清单与执行走同一份计划：`confirm !== true` 且设置要求确认时只回清单，`created:false`，
 * 一个字节都不写；确认后才逐区建票、建会话。失败原因是领域层的结果联合，不在这里重写。
 */
export async function orchestrationRequirementDispatchHandler(
  input: RpcInput<typeof orchestrationRequirementDispatchRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationRequirementDispatchRpc>> {
  const requirement = await readRequirementForDispatch(
    input.workspaceDir,
    input.requirementNumber,
    input.requirementRepoKey,
  );
  if (!requirement.ok) {
    return { ok: false, reason: "no-requirement", detail: requirement.detail };
  }
  // 跨区批次必须在各自的工作区目录里建票、开会话。这里能拿到宿主清单，
  // 就按 id 解析真实目录；列不出来时只保留当前工作区的退回路径。
  const workspaceDirs = new Map<string, string>();
  const workspaceAliases = new Map<string, string[]>();
  try {
    const listed = await context.paseo.workspaces.list({});
    for (const entry of listed.entries) {
      const dir = (entry.workspaceDirectory ?? entry.projectRootPath ?? "").trim();
      if (dir) workspaceDirs.set(entry.id, dir);
      // 「区 / 仓库」列由人写，可能写项目名、工作区名或目录名；这些都要能对回 id。
      const aliases = [
        entry.name,
        entry.title,
        entry.projectDisplayName,
        entry.projectCustomName,
        dir.split(/[\\/]/).filter(Boolean).pop(),
      ];
      workspaceAliases.set(
        entry.id,
        [...new Set(aliases.map((alias) => (alias ?? "").trim()).filter(Boolean))],
      );
    }
  } catch (error) {
    record("warn", SCOPE, `列不出宿主工作区目录，跨区需求只能退回当前目录：${sessionErrorDetail(error)}`);
  }
  const lookup = await requirementWorkspacesOf({
    workspaceDir: input.workspaceDir,
    workspaceId: input.workspaceId,
    body: requirement.ticket.body,
    workspaceDirs,
    workspaceAliases,
  });
  if (!lookup.ok) return lookup;

  const config = await readDaemonConfig(context.paseo);
  const result = await runRequirementDispatch(context.paseo, {
    requirement: requirement.ticket,
    workspaces: lookup.workspaces,
    profiles: profilesOf(config),
    ...(input.confirm === true ? { confirmRequirementSplit: false } : {}),
  });
  if (!result.ok) return result;
  return {
    ok: true,
    created: result.created,
    requiresConfirmation: result.requiresConfirmation,
    summary: summarizeRequirementDispatch(result.plan),
    plan: result.plan,
    batches: [...result.batches],
    research: [...result.research],
  };
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

/** 本文件写日志用的作用域名；与执行层保持同一个词。 */
const SCOPE = "orchestration";

/** 建窗口的失败形状：原因已经由这里收敛好，handler 只负责返回。 */
type WindowFailure = {
  ok: false;
  reason: WindowFailureReason;
  detail: string;
};

/**
 * 窗口标题固定用中文（规格 #25：「主窗口 / 派单窗口 / 进度窗口」）。
 *
 * `lang` 只决定身份提示词的语言；标题是给人认「这是哪一个窗口」的固定标识，
 * 不随界面语言变，否则同一个角色会因语言生成两个名字。
 */
function windowTitle(role: FixedRole): string {
  return ROLE_WINDOW_TITLES[role];
}

/** 读编排设置；读不出来与文件坏了要分开报，都不能拿默认值建窗口。 */
async function readWindowSettings(
  workspaceDir: string,
): Promise<{ ok: true; settings: OrchestrationSettings } | WindowFailure> {
  const stored = await readOrchestration(workspaceDir);
  if (stored.readFailed) {
    return {
      ok: false,
      reason: "settings-unreadable",
      detail: `读不出编排设置 ${stored.file}：${stored.detail ?? "未知原因"}（这不是「没配过」，先修好文件权限或内容）`,
    };
  }
  if (stored.corrupt) {
    return {
      ok: false,
      reason: "settings-corrupt",
      detail: `编排文件解析失败：${stored.detail ?? "格式不对"}——先修好 ${stored.file}，不能拿默认值建窗口`,
    };
  }
  return { ok: true, settings: stored.settings };
}

/** 窗口跟 normal 档路由走：客户端/模型都在这一条上，不新增配置项。 */
async function resolveWindowTarget(
  paseo: PaseoApi,
  settings: OrchestrationSettings,
): Promise<{ ok: true; target: ClientTarget } | WindowFailure> {
  const config = await readDaemonConfig(paseo);
  const rule = resolveRoute(settings, "normal");
  const resolved = resolveRouteTarget(rule, profilesOf(config));
  if (!resolved.ok) {
    return {
      ok: false,
      reason: "route-unavailable",
      detail: `normal 档没有可用的客户端与模型：${resolved.detail}——先到「路由」里配这一档`,
    };
  }
  return { ok: true, target: resolved.target };
}

/** 归档旧窗口；失败只记 warning，不阻断新建。返回是否真的归档成功。 */
async function archivePreviousWindow(paseo: PaseoApi, title: string, agentId: string): Promise<boolean> {
  try {
    await paseo.agents.ref(agentId).archive();
    return true;
  } catch (error) {
    // 旧会话可能已经不存在，用户要的是新窗口。
    record("warn", SCOPE, `归档旧${title} ${agentId} 失败，继续新建：${sessionErrorDetail(error)}`);
    return false;
  }
}

interface WindowCreateInput {
  workspaceDir: string;
  /** 窗口要落进这条工作区；不传就会被宿主按目录再开一条同名工作区。 */
  workspaceId: string;
  role: FixedRole;
  binding: WorkspaceRoles | undefined;
  target: ClientTarget;
  title: string;
  lang?: RoleLang;
}

/**
 * 建窗口。失败快照也算失败：宿主可能用 `phase: "failed"` 而不是抛错来拒绝
 * 「无 prompt 的创建」，此时虽然有 agentId，也不能当成可用窗口。
 */
async function createWindowAgent(
  paseo: PaseoApi,
  input: WindowCreateInput,
): Promise<{ ok: true; agentId: string } | WindowFailure> {
  const created = await createAgent(paseo, {
    cwd: input.workspaceDir,
    workspaceId: input.workspaceId,
    provider: providerSpec(input.target),
    systemPrompt: rolePromptFor(input.binding, input.role, input.lang),
    title: input.title,
    labels: { [DECK_ROLE_LABEL]: input.role, [DECK_ROLE_WINDOW_LABEL]: "1" },
    ...(input.target.modeId ? { modeId: input.target.modeId } : {}),
    ...(input.target.thinkingOptionId ? { thinkingOptionId: input.target.thinkingOptionId } : {}),
    ...(input.target.featureValues ? { featureValues: input.target.featureValues } : {}),
    // 不传 prompt：窗口停在 idle，等用户开口。
  });
  if (!created.ok) {
    return { ok: false, reason: "create-failed", detail: `${created.failure.kind}: ${created.failure.detail}` };
  }
  if (created.failure) {
    return {
      ok: false,
      reason: "create-failed",
      detail: `创建快照停在 ${created.failure.phase ?? "未知"} 阶段：${created.failure.detail}（宿主返回了会话 ${created.agentId}，但它不能当成可用窗口）`,
    };
  }
  return { ok: true, agentId: created.agentId };
}

/**
 * 写回槽位；返回 null 表示成功，否则是可显示的原因。
 *
 * 建会话可能花几秒，期间用户可能刚改过别的设置。所以这里**重读一次**再合并，
 * 不拿 `prepareWindow` 时的旧快照整份覆盖——那会把中间的改动抹掉。
 */
async function writeWindowSlot(
  workspaceDir: string,
  workspaceId: string,
  role: FixedRole,
  agentId: string,
): Promise<string | null> {
  const read = await readWindowSettings(workspaceDir);
  if (!read.ok) return `${read.reason}: ${read.detail}`;
  const binding = read.settings.roles.find((item) => item.workspaceId === workspaceId);
  const next = withWorkspaceRoles(read.settings, withAgentIdFor(binding, workspaceId, role, agentId));
  const written = await writeOrchestration(workspaceDir, next, { workspaceId });
  return written.ok ? null : written.detail;
}

interface WindowPrep {
  ok: true;
  binding: WorkspaceRoles | undefined;
  target: ClientTarget;
}

/** 读设置 + 定路由 + 找槽位；任一步失败就原样交出失败原因。 */
async function prepareWindow(
  paseo: PaseoApi,
  workspaceDir: string,
  workspaceId: string,
  role: FixedRole,
): Promise<WindowPrep | WindowFailure> {
  const read = await readWindowSettings(workspaceDir);
  if (!read.ok) return read;
  const route = await resolveWindowTarget(paseo, read.settings);
  if (!route.ok) return route;
  return {
    ok: true,
    binding: read.settings.roles.find((item) => item.workspaceId === workspaceId),
    target: route.target,
  };
}

/**
 * 按角色身份提示词建一个固定窗口。
 *
 * 身份提示词用 `rolePromptFor`（用户改过就用改过的）；客户端/模型跟 normal 档路由走。
 * **不传首条 prompt**：窗口建出来停在 idle，等用户开口。宿主拒绝这种创建就把
 * `create-failed` 原样报出来，不偷偷补一句提示词。
 */
export async function orchestrationWindowHandler(
  input: RpcInput<typeof orchestrationWindowRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof orchestrationWindowRpc>> {
  const workspaceDir = input.workspaceDir.trim();
  const workspaceId = input.workspaceId.trim();
  if (!workspaceDir || !workspaceId) {
    return { ok: false, reason: "invalid-workspace", detail: "需要 workspaceId 与工作区目录" };
  }

  const prep = await prepareWindow(context.paseo, workspaceDir, workspaceId, input.role);
  if (!prep.ok) return prep;
  const { binding, target } = prep;
  const title = windowTitle(input.role);

  const previousAgentId = agentIdOf(binding, input.role);
  const archivedOldId = input.recreate === true && previousAgentId ? previousAgentId : null;

  // **先建新的、再归档旧的**。反过来写过一版：建会话一失败，用户唯一的窗口已经被
  // 归档了，只剩一句「旧窗口 … 已归档」——重建本来是为了救窗口，不能先把它弄没。
  const created = await createWindowAgent(context.paseo, {
    workspaceDir,
    workspaceId,
    role: input.role,
    binding,
    target,
    title,
    lang: input.lang,
  });
  if (!created.ok) return created;

  const didArchive = archivedOldId ? await archivePreviousWindow(context.paseo, title, archivedOldId) : false;
  const archivedNote = didArchive
    ? `（旧窗口 ${archivedOldId} 已归档）`
    : archivedOldId
      ? `（旧窗口 ${archivedOldId} 没能归档，现在两个窗口都在，确认后手动归档旧的）`
      : "";

  const writeFailure = await writeWindowSlot(workspaceDir, workspaceId, input.role, created.agentId);
  if (writeFailure) {
    return {
      ok: false,
      reason: "write-failed",
      detail: `新${title} ${created.agentId} 已建好，但槽位没写回去：${writeFailure}${archivedNote}`,
    };
  }

  return { ok: true, agentId: created.agentId, title, previousAgentId };
}
