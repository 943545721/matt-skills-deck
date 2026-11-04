import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  DECK_GROUP_LABEL,
  groupReadRpc,
  groupSendRpc,
  planGroupSend,
  type GroupDelivery,
  type GroupMember,
  type GroupSendPlan,
  type GroupSendReason,
} from "../../shared/group-rpc.ts";
import { isFinalized } from "../../shared/impact.ts";
import { labelNames } from "../../shared/issue-kind.ts";
import { guardCreateTicket } from "../../shared/split-guard.ts";
import { DECK_STAFF_LABEL, rosterOf, staffCardOf, type StaffCard } from "../../shared/staff.ts";
import {
  DECK_TICKET_LABEL,
  PARENT_AGENT_ID_LABEL,
  providerSpec,
  resolveRoute,
  resolveRouteTarget,
  ticketLabelOf,
  workspaceRolesOf,
  type ClientTarget,
  type ClientProfile,
  type OrchestrationSettings,
  type ThinkingResolutionContext,
  type WorkspaceRoles,
} from "../../shared/orchestration.ts";
import { readOrchestration } from "../orchestration-store.ts";
import { profilesOf, readDaemonConfig } from "../orchestration.ts";
import { thinkingContextOf } from "../provider-entry.ts";
import { appendGroup, readGroupDirectory, type GroupRecord } from "../group-store.ts";
import { readGroupRoster } from "../group-roster.ts";
import { readGroupRequest, rememberGroupRequest } from "../group-requests.ts";
import { buildGroupContext } from "../group-context.ts";
import { collectStaffHistory } from "../staff-history.ts";
import { createAgent } from "../session.ts";
import { record } from "../logs.ts";
import { mainAgentFor } from "../report.ts";
import { createIssueHandler, getIssueHandler } from "./issues.ts";

/**
 * 群视图的服务端出口。
 *
 * 路由判定在 `shared/group-rpc.ts` 的 `planGroupSend`（纯函数、可单测）；
 * 这里只按计划做三件有副作用的事：**先建票、再建会话、最后落群记录**。
 * 顺序不能反：会话是进程，关掉就没了；票是这件事留下的凭证。
 *
 * 一处刻意的不对称：`deck.group.send` 是插件自己铺票，不经过宿主确认弹窗。
 * 所以 `@全部` 必须先回 `status: "preview"` 让人看一眼「将新建 N 个会话」，
 * 带上 `confirmAll` 才真的花钱。
 */

type GroupSendInput = RpcInput<typeof groupSendRpc>;
type GroupSendOutput = RpcOutput<typeof groupSendRpc>;
type GroupReadInput = RpcInput<typeof groupReadRpc>;
type GroupReadOutput = RpcOutput<typeof groupReadRpc>;

function reject(reason: GroupSendReason, detail: string, candidates?: Extract<GroupSendPlan, { ok: false }>["candidates"]): GroupSendOutput {
  return { ok: false, reason, detail, ...(candidates ? { candidates } : {}) };
}

function rejectPlan(plan: Extract<GroupSendPlan, { ok: false }>): GroupSendOutput {
  return reject(plan.reason, plan.detail, plan.candidates);
}

function agentsOf(listed: unknown): Array<Record<string, unknown>> {
  if (typeof listed !== "object" || listed === null) return [];
  const entries = (listed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const agent = (entry as { agent?: unknown }).agent;
    if (typeof agent !== "object" || agent === null) continue;
    const view = agent as Record<string, unknown>;
    if (typeof view.id === "string" && view.id.trim()) out.push(view);
  }
  return out;
}

/**
 * 群标签的值是**目录**，不是 workspaceId。
 *
 * 群属于目录：同一个目录每次重开都会攒出一个新的 workspaceId，标签若写 id，
 * 换了 id 打开群页就一条会话也看不见（名册上有 12 个人，右栏却说都没起过会话）。
 * 写目录，换多少个 id 都还是这个群。`resolve` 是为了抹平 `尾斜杠 / ./` 这类同目录不同写法。
 */
function groupKeyOf(workspaceDir: string): string {
  return path.resolve(workspaceDir);
}

/**
 * 按群标签列会话。除目录 key 外也带上当前 workspaceId：改格式之前建的会话标签写的是 id，
 * 不能因为换了格式就从成员表里消失。同一会话两条都能列到，按 id 去重。
 *
 * 更早的 id 下建的会话查不到：宿主的列表只能按标签值精确过滤，历史 id 没法枚举。
 * 这不比改格式之前更差（那时换个 id 打开，这些会话也看不见），新会话一律写目录 key。
 */
async function listedGroupAgents(
  context: PluginHandlerContext,
  keys: readonly string[],
): Promise<{ agents: Array<Record<string, unknown>>; warnings: string[] }> {
  const seen = new Map<string, Record<string, unknown>>();
  const warnings: string[] = [];
  for (const key of [...new Set(keys.map((item) => item.trim()).filter(Boolean))]) {
    try {
      const listed = await context.paseo.agents.list({
        filter: { labels: { [DECK_GROUP_LABEL]: key }, includeArchived: true },
      });
      for (const agent of agentsOf(listed)) seen.set(String(agent.id), agent);
    } catch (error) {
      // 一个 key 读失败不该让整页没有成员：其余照读，失败写进 warnings。
      warnings.push(`群成员读不出来（${key}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { agents: [...seen.values()], warnings };
}

/**
 * 群里的会话用哪份客户端：卡上指定了档案就按档案，否则走 normal 档路由。
 *
 * 两条分支都过 `resolveRouteTarget`：卡上没显式设档位、模型又有默认档时，
 * 群建的会话也得带上，否则同一个模型在不同入口会跑出不同的思考档。
 */
function targetOf(
  settings: OrchestrationSettings,
  profiles: readonly ClientProfile[],
  card: StaffCard | null,
  thinking: ThinkingResolutionContext,
): { ok: true; target: ClientTarget } | { ok: false; detail: string } {
  const profileId = card?.profileId?.trim();
  // 档案分支也走 `resolveRouteTarget`：目标怎么由档案拼出来只有那一处，
  // 群发不另抄一份（否则以后档案多一个字段，就要记得改两处）。
  const rule = profileId
    ? { difficulty: "normal" as const, profileId }
    : resolveRoute(settings, "normal");
  const resolved = resolveRouteTarget(rule, profiles, thinking);
  if (!resolved.ok) {
    return {
      ok: false,
      // 档案不见了要说清楚是「岗位卡指向的档案被删了」，不是一条普通的路由坏了。
      detail:
        profileId && resolved.reason === "profile-missing"
          ? `岗位卡 ${card?.name ?? ""} 指定的客户端档案 ${profileId} 已不存在`
          : resolved.detail,
    };
  }
  return { ok: true, target: resolved.target };
}

/** 派单窗口：群里的会话挂回它，回传链照旧。没配就没有父会话，如实说出来。 */
function dispatcherOf(roles: WorkspaceRoles | null): string | null {
  return roles?.dispatcherAgentId?.trim() || null;
}

async function requirementOf(
  input: GroupSendInput,
): Promise<
  | {
      ok: true;
      requirement: { number: number; finalized: boolean; labels: readonly string[]; body: string } | null;
      repoKey: string | null;
    }
  | { ok: false; detail: string }
> {
  if (input.requirementNumber === undefined || input.requirementNumber === null) {
    return { ok: true, requirement: null, repoKey: null };
  }
  const read = await getIssueHandler({ workspaceDir: input.workspaceDir, number: input.requirementNumber });
  if (!read.ok) {
    // 读不到就当作「没挂需求」会让整句被派出去；这里必须明确拒绝。
    return { ok: false, detail: `读不到需求票 #${input.requirementNumber}：${read.detail}` };
  }
  return {
    ok: true,
    requirement: {
      number: input.requirementNumber,
      finalized: isFinalized(read.issue.labels),
      labels: labelNames(read.issue.labels),
      body: typeof read.issue.body === "string" ? read.issue.body : "",
    },
    // 群票落到需求所在的那个仓库：多仓库工作区里建票必须写明，猜一个等于建错。
    repoKey: read.repoKey,
  };
}

export async function groupSendHandler(
  input: GroupSendInput,
  context: PluginHandlerContext,
): Promise<GroupSendOutput> {
  if (!input.workspaceId.trim() || !input.workspaceDir.trim()) {
    return reject("invalid-workspace", "需要 workspaceId 与工作区目录");
  }
  // 重试幂等：建票与建会话都不可撤销，同一 requestId 直接回放上次结果。
  const requestId = input.requestId?.trim();
  if (requestId) {
    const previous = await readGroupRequest(input.workspaceDir, input.workspaceId, requestId);
    // 读失败不能当成「没派过」：那会重新建票、重建会话。宁可让调用方修好再重试。
    if (!previous.ok) {
      return reject("read-failed", `幂等记录读不出来，不能确认这句之前有没有派过：${previous.detail}`);
    }
    if (previous.hit) {
      return {
        ok: true,
        status: "sent",
        deliveries: previous.hit.deliveries,
        warnings: [...previous.hit.warnings, "这条消息之前已经派过（requestId 相同），回放的是上次的结果。"],
      };
    }
  }
  const stored = await readOrchestration(input.workspaceDir);
  const warnings: string[] = [];
  if (stored.readFailed || stored.corrupt) {
    warnings.push(`编排设置读不出来（${stored.detail ?? "未知原因"}），按默认值处理：名册可能是空的`);
  }

  // 槽位按 workspaceId 取；名册在这一层不跟着 id 分（`rosterOf`）。
  const roles = workspaceRolesOf(stored.settings, input.workspaceId);
  // 名册按目录取：没有这一条的 workspaceId 时也要拿到这个目录的卡。
  const staff = rosterOf(stored.settings);
  const mainAgentId = await mainAgentFor(input.workspaceDir, input.workspaceId);
  const requirement = await requirementOf(input);
  if (!requirement.ok) return reject("no-requirement", requirement.detail);

  const plan = planGroupSend({
    text: input.text,
    staff,
    mainAgentId,
    requirement: requirement.requirement,
    ...(input.staffId?.trim() ? { staffId: input.staffId.trim() } : {}),
    ...(input.confirmAll === undefined ? {} : { confirmAll: input.confirmAll }),
  });
  if (!plan.ok) return rejectPlan(plan);
  if (plan.phase === "preview") {
    return { ok: true, status: "preview", targets: plan.targets, warnings };
  }

  // 档案读宿主配置（不是编排设置）：客户端与模型只存在于 daemon config 里。
  const daemon = await readDaemonConfig(context.paseo);
  const profiles = profilesOf(daemon);
  // 默认档位也要按宿主当前模型清单筛：模型被删掉的条目不能继续发出去。
  const thinking = thinkingContextOf(stored.settings.modelThinking, daemon);
  const dispatcherAgentId = dispatcherOf(roles);
  if (!dispatcherAgentId) {
    warnings.push("这个工作区没有配派单窗口：群里建的会话没有父会话，回传链会断在它自己这里。");
  }

  const deliveries: GroupDelivery[] = [];
  const userText = input.text.trim();
  // 先读旧记录再写这一条：否则这句派活会原样回到被派人的上下文里，等于把他的任务说两遍。
  // 读整个目录：群属于目录，会话该看到的「本群最近说了什么」不限于今天这个 workspaceId 那个文件。
  const prior = await readGroupDirectory(input.workspaceDir);
  if (prior.failed) warnings.push(`群记录读不出来（会话照建）：${prior.failed}`);
  const contextRecords: readonly GroupRecord[] = prior.records;

  const base = { at: new Date().toISOString(), from: "你", agentId: "", kind: "user" as const, text: userText };
  const appended = await appendGroup(input.workspaceDir, input.workspaceId, base);
  if (!appended.ok) warnings.push(`群记录没写进去（不影响派活）：${appended.detail}`);

  for (const target of plan.targets) {
    if (target.toMain) {
      try {
        await context.paseo.agents.ref(mainAgentId!).send(userText, { activeTurnBehavior: "steer" });
        deliveries.push({ staffId: null, name: target.name, agentId: mainAgentId, ticketNumber: null });
        record("info", "group", `群消息已发给主窗口 ${mainAgentId}`);
      } catch (error) {
        deliveries.push({
          staffId: null,
          name: target.name,
          agentId: mainAgentId,
          ticketNumber: null,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const staffId = target.staffId ?? "";
    const card = staffCardOf(roles, staffId);
    if (!card) {
      deliveries.push({ staffId, name: target.name, agentId: null, ticketNumber: null, detail: "岗位卡已经不在名册上" });
      continue;
    }
    const spec = targetOf(stored.settings, profiles, card, thinking);
    if (!spec.ok) {
      deliveries.push({ staffId, name: target.name, agentId: null, ticketNumber: null, detail: spec.detail });
      continue;
    }

    // 群建票也是「插件自己铺票」的入口：与另外两处共用 split-guard，
    // 影响面表的逐行校验（依据 / 结论 / 核的人 / 第五列格式）不在这里漏掉。
    if (requirement.requirement) {
      const guard = guardCreateTicket({
        kind: "issue",
        labels: [DECK_STAFF_LABEL, DECK_GROUP_LABEL],
        body: target.ticketBody,
        requirementKey: requirement.requirement.number,
        requirementLabels: requirement.requirement.labels,
        requirementBody: requirement.requirement.body,
        action: "create",
      });
      if (!guard.ok) {
        deliveries.push({ staffId, name: target.name, agentId: null, ticketNumber: null, detail: guard.detail });
        continue;
      }
    }
    const ticket = await createIssueHandler({
      workspaceDir: input.workspaceDir,
      title: target.ticketTitle,
      body: target.ticketBody,
      labels: [DECK_STAFF_LABEL, DECK_GROUP_LABEL],
      ...(requirement.repoKey ? { repoKey: requirement.repoKey } : {}),
      // 闸按入参判，不靠正文里那行 `Refs:` 反推：群建票也是「插件自己铺票」的一个入口。
      ...(requirement.requirement ? { requirementKey: requirement.requirement.number } : {}),
      ...(requirement.repoKey ? { requirementRepoKey: requirement.repoKey } : {}),
    });
    if (!ticket.ok) {
      deliveries.push({ staffId, name: target.name, agentId: null, ticketNumber: null, detail: ticket.detail });
      continue;
    }

    // 会话不是记忆单元：每次唤醒现拼「职责 + 相关群消息 + 履历」。
    // 履历读不到不挡派活，问题只进 warnings。
    const history = await collectStaffHistory(context.paseo, {
      workspaceId: input.workspaceId,
      staffId,
      workspaceDir: input.workspaceDir,
    });
    for (const warning of history.warnings) warnings.push(`${card.name}：${warning}`);
    const groupContext = buildGroupContext({ card, records: contextRecords, historyText: history.text });

    const labels: Record<string, string> = {
      [DECK_STAFF_LABEL]: staffId,
      [DECK_GROUP_LABEL]: groupKeyOf(input.workspaceDir),
      [DECK_TICKET_LABEL]: ticketLabelOf(ticket.repoKey, ticket.number),
      ...(dispatcherAgentId ? { [PARENT_AGENT_ID_LABEL]: dispatcherAgentId } : {}),
    };
    const created = await createAgent(context.paseo, {
      cwd: input.workspaceDir,
      workspaceId: input.workspaceId,
      provider: providerSpec(spec.target),
      // 合成好的思考档要真的带到会话上，只在 targetOf 里算出来而不传等于没有默认档。
      // 档案的 modeId / featureValues 不在这里顺手加：那是 #30 之外的行为变化。
      ...(spec.target.thinkingOptionId ? { thinkingOptionId: spec.target.thinkingOptionId } : {}),
      prompt: userText,
      title: target.ticketTitle,
      ...(groupContext.text ? { systemPrompt: groupContext.text } : {}),
      labels,
      ...(dispatcherAgentId ? { parentAgentId: dispatcherAgentId } : {}),
      ledger: false,
    });
    if (!created.ok) {
      // 票已经建好（有意为之）：会话没建出来时，票面就是这件事唯一的痕迹。
      deliveries.push({
        staffId,
        name: target.name,
        agentId: null,
        ticketNumber: ticket.number,
        detail: `${created.failure.kind}: ${created.failure.detail}`,
      });
      continue;
    }

    const staffRecord = await appendGroup(input.workspaceDir, input.workspaceId, {
      at: new Date().toISOString(),
      from: card.name,
      agentId: created.agentId,
      kind: "staff",
      text: userText,
    });
    if (!staffRecord.ok) warnings.push(`群记录没写进 ${card.name} 那条：${staffRecord.detail}`);
    deliveries.push({ staffId, name: target.name, agentId: created.agentId, ticketNumber: ticket.number });
    record("info", "group", `群消息派给 ${card.name}（${staffId}），票 #${ticket.number}，会话 ${created.agentId}`);
  }

  const failed = deliveries.filter((item) => item.detail).length;
  if (failed > 0) warnings.push(`${failed} 个目标没派出去，逐条原因见 deliveries。`);
  if (requestId) {
    // 部分目标失败也记下来：成功的那些已经建了票和会话，重试整句只会重复建。
    const remembered = await rememberGroupRequest(input.workspaceDir, input.workspaceId, {
      requestId,
      at: new Date().toISOString(),
      deliveries,
      warnings,
    });
    if (!remembered.ok) warnings.push(`幂等记录没写进去（不影响这次派活）：${remembered.detail}`);
  }
  return { ok: true, status: "sent", deliveries, warnings };
}

export async function groupReadHandler(
  input: GroupReadInput,
  context: PluginHandlerContext,
): Promise<GroupReadOutput> {
  if (!input.workspaceId.trim() || !input.workspaceDir.trim()) {
    return { ok: false, reason: "invalid-workspace", detail: "需要 workspaceId 与工作区目录" };
  }
  const limit = input.limit ?? 200;
  const warnings: string[] = [];

  const listed = await listedGroupAgents(context, [groupKeyOf(input.workspaceDir), input.workspaceId]);
  warnings.push(...listed.warnings);
  const members: GroupMember[] = listed.agents.map((agent) => {
    const labels = (agent.labels ?? {}) as Record<string, string>;
    return {
      agentId: String(agent.id),
      staffId: labels[DECK_STAFF_LABEL] ?? "",
      title: typeof agent.title === "string" ? agent.title : "",
      status: typeof agent.status === "string" ? agent.status : "",
      archived: Boolean(agent.archivedAt),
    };
  });

  const roster = await readGroupRoster(input.workspaceDir);

  /**
   * 消息只属于**这个目录**。
   *
   * 一个项目一个群：本群的名册、本群的对话。别的目录是别的项目，不在这里读。
   * 同一目录会攒出好几个 workspaceId，记录文件按 id 存，所以按目录合起来读。
   */
  const read = await readGroupDirectory(input.workspaceDir);
  if (read.failed) warnings.push(read.failed);

  return {
    ok: true,
    members,
    roster,
    records: read.records.slice(-limit),
    skipped: read.skipped,
    warnings,
  };
}
