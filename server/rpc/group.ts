import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  DECK_GROUP_LABEL,
  groupReadRpc,
  groupSendRpc,
  parseGroupMentions,
  planGroupSend,
  type GroupDelivery,
  type GroupMember,
  type GroupRoster,
  type GroupSendPlan,
  type GroupSendReason,
} from "../../shared/group-rpc.ts";
import { isFinalized } from "../../shared/impact.ts";
import { labelNames } from "../../shared/issue-kind.ts";
import { guardCreateTicket } from "../../shared/split-guard.ts";
import { DECK_STAFF_LABEL, staffCardOf, type StaffCard } from "../../shared/staff.ts";
import {
  DECK_TICKET_LABEL,
  PARENT_AGENT_ID_LABEL,
  providerSpec,
  resolveRoute,
  resolveRouteTarget,
  ticketLabelOf,
  type ClientTarget,
  type ClientProfile,
  type OrchestrationSettings,
  type WorkspaceRoles,
} from "../../shared/orchestration.ts";
import { readOrchestration } from "../orchestration-store.ts";
import { profilesOf, readDaemonConfig } from "../orchestration.ts";
import { appendGroup, readGroup, type GroupRecord } from "../group-store.ts";
import { readGroupRosters } from "../group-roster.ts";
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

/** 这个工作区的角色槽位；名册与派单窗口都从这里取。 */
function rolesOf(settings: OrchestrationSettings, workspaceId: string): WorkspaceRoles | null {
  return settings.roles.find((role) => role.workspaceId === workspaceId) ?? null;
}

/** 这个工作区的名册。读不出来就按空名册处理，并在调用方 warning 里说清楚。 */
function staffOf(roles: WorkspaceRoles | null): StaffCard[] {
  return roles?.staff ?? [];
}

/** 群里的会话用哪份客户端：卡上指定了档案就按档案，否则走 normal 档路由。 */
function targetOf(
  settings: OrchestrationSettings,
  profiles: readonly ClientProfile[],
  card: StaffCard | null,
): { ok: true; target: ClientTarget } | { ok: false; detail: string } {
  const profileId = card?.profileId?.trim();
  if (profileId) {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) {
      return { ok: false, detail: `岗位卡 ${card?.name ?? ""} 指定的客户端档案 ${profileId} 已不存在` };
    }
    const target: ClientTarget = {
      provider: profile.provider,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
      ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
    };
    return { ok: true, target };
  }
  const resolved = resolveRouteTarget(resolveRoute(settings, "normal"), profiles);
  return resolved.ok ? { ok: true, target: resolved.target } : { ok: false, detail: resolved.detail };
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

/**
 * 点了别的工作区的人，就把整句改派到那个工作区再执行。
 *
 * 只在「点了具体的人」时改派。`@全部` 和不带 `@` 仍留在打开群的这个工作区：
 * 一次把所有区的会话都建出来，是把每个区的钱一起花掉。
 * 重名与跨区在这里拒绝，让界面把候选画成可点的人，而不是自动改名。
 */
async function retargetGroupSend(
  input: GroupSendInput,
  context: PluginHandlerContext,
): Promise<{ ok: true; input: GroupSendInput; warnings: string[] } | { ok: false; result: GroupSendOutput }> {
  const named = parseGroupMentions(input.text).some((mention) => !mention.all);
  const picked = input.staffId?.trim();
  if (!named && !picked) return { ok: true, input, warnings: [] };

  const loaded = await readGroupRosters(context.paseo, {
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
  });
  const current = loaded.rosters.find((roster) => roster.current) ?? loaded.rosters[0];
  if (!current) return { ok: true, input, warnings: loaded.warnings };

  const staff = current.staff.map((card) => ({ id: card.staffId, name: card.name }));
  const probe = planGroupSend({
    text: input.text,
    staff,
    workspace: { workspaceId: current.workspaceId, workspaceDir: current.workspaceDir, name: current.name, staff },
    otherRosters: loaded.rosters
      .filter((roster) => roster.workspaceId !== current.workspaceId)
      .map((roster) => ({
        workspaceId: roster.workspaceId,
        workspaceDir: roster.workspaceDir,
        name: roster.name,
        staff: roster.staff.map((card) => ({ id: card.staffId, name: card.name })),
      })),
    // 这一步只决定落在哪个工作区。需求票在目标工作区里再读一次。
    mainAgentId: "probe",
    requirement: { number: 1, finalized: true },
    ...(picked ? { staffId: picked } : {}),
    ...(input.confirmAll === undefined ? {} : { confirmAll: input.confirmAll }),
  });

  if (!probe.ok && (probe.reason === "ambiguous-staff" || probe.reason === "cross-workspace")) {
    // 还没定稿时，先说定稿，不拿候选把真正的拒绝盖住。这与单工作区的顺序一致。
    const requirement = await requirementOf(input);
    if (!requirement.ok) return { ok: false, result: reject("no-requirement", requirement.detail) };
    if (!requirement.requirement?.finalized) {
      const gated = planGroupSend({
        text: input.text,
        staff,
        mainAgentId: null,
        requirement: requirement.requirement,
        ...(picked ? { staffId: picked } : {}),
        ...(input.confirmAll === undefined ? {} : { confirmAll: input.confirmAll }),
      });
      if (!gated.ok) return { ok: false, result: rejectPlan(gated) };
    }
    return { ok: false, result: rejectPlan(probe) };
  }

  if (!probe.ok || !probe.scope) return { ok: true, input, warnings: loaded.warnings };
  if (probe.scope.workspaceId === input.workspaceId && probe.scope.workspaceDir === input.workspaceDir) {
    return { ok: true, input, warnings: loaded.warnings };
  }
  return {
    ok: true,
    input: { ...input, workspaceId: probe.scope.workspaceId, workspaceDir: probe.scope.workspaceDir },
    warnings: loaded.warnings,
  };
}

export async function groupSendHandler(
  input: GroupSendInput,
  context: PluginHandlerContext,
): Promise<GroupSendOutput> {
  if (!input.workspaceId.trim() || !input.workspaceDir.trim()) {
    return reject("invalid-workspace", "需要 workspaceId 与工作区目录");
  }
  const directed = await retargetGroupSend(input, context);
  if (!directed.ok) return directed.result;
  return executeGroupSend(directed.input, context, directed.warnings);
}

async function executeGroupSend(
  input: GroupSendInput,
  context: PluginHandlerContext,
  priorWarnings: readonly string[],
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
  const warnings: string[] = [...priorWarnings];
  if (stored.readFailed || stored.corrupt) {
    warnings.push(`编排设置读不出来（${stored.detail ?? "未知原因"}），按默认值处理：名册可能是空的`);
  }

  const roles = rolesOf(stored.settings, input.workspaceId);
  const staff = staffOf(roles);
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
  if (!plan.ok) {
    return {
      ok: false,
      reason: plan.reason,
      detail: plan.detail,
      ...(plan.candidates ? { candidates: plan.candidates } : {}),
    };
  }
  if (plan.phase === "preview") {
    return { ok: true, status: "preview", targets: plan.targets, warnings };
  }

  // 档案读宿主配置（不是编排设置）：客户端与模型只存在于 daemon config 里。
  const profiles = profilesOf(await readDaemonConfig(context.paseo));
  const dispatcherAgentId = dispatcherOf(roles);
  if (!dispatcherAgentId) {
    warnings.push("这个工作区没有配派单窗口：群里建的会话没有父会话，回传链会断在它自己这里。");
  }

  const deliveries: GroupDelivery[] = [];
  const userText = input.text.trim();
  // 先读旧记录再写这一条：否则这句派活会原样回到被派人的上下文里，等于把他的任务说两遍。
  const prior = await readGroup(input.workspaceDir, input.workspaceId);
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
    const spec = targetOf(stored.settings, profiles, card);
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
      [DECK_GROUP_LABEL]: input.workspaceId,
      [DECK_TICKET_LABEL]: ticketLabelOf(ticket.repoKey, ticket.number),
      ...(dispatcherAgentId ? { [PARENT_AGENT_ID_LABEL]: dispatcherAgentId } : {}),
    };
    const created = await createAgent(context.paseo, {
      cwd: input.workspaceDir,
      workspaceId: input.workspaceId,
      provider: providerSpec(spec.target),
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

  let members: GroupMember[] = [];
  try {
    const listed = await context.paseo.agents.list({
      filter: { labels: { [DECK_GROUP_LABEL]: input.workspaceId }, includeArchived: true },
    });
    members = agentsOf(listed).map((agent) => {
      const labels = (agent.labels ?? {}) as Record<string, string>;
      return {
        agentId: String(agent.id),
        staffId: labels[DECK_STAFF_LABEL] ?? "",
        title: typeof agent.title === "string" ? agent.title : "",
        status: typeof agent.status === "string" ? agent.status : "",
        archived: Boolean(agent.archivedAt),
      };
    });
  } catch (error) {
    warnings.push(`群成员读不出来：${error instanceof Error ? error.message : String(error)}`);
  }

  const loaded = await readGroupRosters(context.paseo, {
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
  });
  warnings.push(...loaded.warnings);

  const merged: Array<GroupRecord & { workspaceId: string; workspaceName: string }> = [];
  let skipped = 0;
  for (const roster of loaded.rosters) {
    const read = await readGroup(roster.workspaceDir, roster.workspaceId);
    if (read.failed) {
      warnings.push(`${roster.name}：${read.failed}`);
      continue;
    }
    skipped += read.skipped;
    for (const record of read.records) {
      merged.push({ ...record, workspaceId: roster.workspaceId, workspaceName: roster.name });
    }
  }
  merged.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));

  const rosters: GroupRoster[] = loaded.rosters;
  return {
    ok: true,
    members,
    rosters,
    records: merged.slice(-limit),
    skipped,
    warnings,
  };
}
