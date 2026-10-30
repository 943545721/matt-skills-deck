import type { PaseoApi } from "@getpaseo/client";
import { matchesWorkspaceScope } from "../shared/session.ts";
import {
  buildDispatchPreamble,
  buildAgentTree,
  isDeckChild,
  normalizeOrchestration,
  planDispatch,
  providerSpec,
  readMapLabel,
  resolveRoute,
  resolveRouteTarget,
  routeFromOf,
  withRoutingRule,
  withWorkspaceRoles,
  type AgentNodeInput,
  type ClientProfile,
  type ClientTarget,
  type Difficulty,
  type DispatchRejection,
  type OrchestrationSettings,
  type RoutingRule,
  type WorkspaceRoles,
} from "../shared/orchestration.ts";
import { readOrchestration, writeOrchestration } from "./orchestration-store.ts";
import { readSiteBook, updateSiteBook } from "./sites-store.ts";
import {
  enabledSiteOf,
  normalizeSiteId,
  siteIdProblem,
  siteUrlProblem,
  normalizeBaseUrl,
  sitesOf,
  withSite,
  withoutSite,
  type Site,
} from "../shared/sites.ts";
import { envKeysFor } from "../shared/provider-env.ts";
import {
  baseUrlOf,
  configuredModelIds,
  credentialKeysOf,
  envDisplayOf,
  maskValue,
  modelListKeyOf,
  type ModelListKey,
} from "../shared/provider-models.ts";
import { createAgent, sessionErrorDetail } from "./session.ts";
import { record } from "./logs.ts";

/**
 * 编排执行层。
 *
 * 三类事实来源各归各位：
 * - 角色绑定与难度路由 → 工作区 `.deck/orchestration.json`（我们自己写）；
 * - 客户端档案与 provider 注入配置 → daemon 配置（`paseo.config.get/patch`，宿主持有）；
 * - 父子关系 → 宿主标签 `paseo.parent-agent-id` / 快照的 `labels`（不另建一份台账）。
 *
 * 所有函数返回可解释的结果联合，不抛给调用方；部分失败逐条保留。
 */

const SCOPE = "orchestration";

interface ProviderEntryView {
  provider?: string;
  label?: string;
  status?: string;
  enabled?: boolean;
  models?: Array<{ id?: string }>;
}

interface AgentEntryView {
  id: string;
  workspaceId?: string | null;
  cwd?: string | null;
  title?: string | null;
  provider?: string;
  model?: string | null;
  status?: string;
  updatedAt?: string | null;
  labels?: Record<string, string>;
}

interface ProfileView {
  id?: string;
  name?: string;
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
}

export interface DaemonConfigView {
  /** 线上视图（`config.get` / `config.patch`）：`providers`、`agentProfiles` 都在**根级**。 */
  providers?: Record<string, ProviderConfigView>;
  agentProfiles?: RawProfile[];
  /** 磁盘形状（`~/.paseo/config.json`）：`daemon.agentProfiles` / `agents.providers`。 */
  daemon?: { agentProfiles?: RawProfile[] };
  agents?: { providers?: Record<string, ProviderConfigView> };
}

/** 档案条目原样保留宿主写的字段（`icon` / `color` / `featureValues` 等），只认识其中几个。 */
type RawProfile = ProfileView & Record<string, unknown>;

/**
 * 写回宿主时用的形状。
 *
 * 宿主的档案 schema 是 `$loose`：`id` / `name` / `provider` 必填，其余可选，
 * 多出来的键原样保留。这里显式列出认识的字段，属性类型才收得住
 * （直接拿 `Record<string, unknown>` 去写，`icon` 会是 `unknown`，编译器过不去）。
 */
interface HostAgentProfile {
  id: string;
  name: string;
  provider: string;
  icon?: string;
  color?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
  [key: string]: unknown;
}

const KNOWN_PROFILE_FIELDS = new Set([
  "id",
  "name",
  "provider",
  "icon",
  "color",
  "model",
  "modeId",
  "thinkingOptionId",
  "featureValues",
  "notes",
]);

/**
 * 读回来的条目 → 写回去的条目。
 *
 * 必须一个字段都不丢：这份数组是**整表替换**，少带一个 `icon` / `color` 就是一次不可逆的删除。
 * 认识的字段做类型收窄，不认识的（宿主以后加的）原样带过去。
 */
function toHostProfile(item: RawProfile): HostAgentProfile {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  const out: HostAgentProfile = {
    id: text(item.id) ?? "",
    name: text(item.name) ?? "",
    provider: text(item.provider) ?? "",
  };
  for (const key of ["icon", "color", "model", "modeId", "thinkingOptionId", "notes"] as const) {
    const value = text(item[key]);
    if (value !== undefined) out[key] = value;
  }
  const featureValues = recordOf(item.featureValues);
  if (featureValues) out.featureValues = featureValues;
  for (const [key, value] of Object.entries(item)) {
    if (!KNOWN_PROFILE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

interface ProviderModelItemView {
  id?: string;
  label?: string;
  isDefault?: boolean;
  description?: string;
  [extra: string]: unknown;
}

export interface ProviderConfigView {
  /** 派生客户端的基座 id（宿主：非内置 id + `extends` 才会被建成 provider）。 */
  extends?: string;
  label?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  /** 追加到内置列表（宿主把两把键都当可写字段）。 */
  additionalModels?: Array<string | ProviderModelItemView>;
  /** 替换内置列表：有这把键就说明这个客户端不用追加模式。 */
  models?: Array<string | ProviderModelItemView>;
}

/**
 * 档案数组的两种形状都要认。
 *
 * 宿主的**线上**可改配置把这两样摊在根级（`config.get().config.providers` / `.agentProfiles`），
 * 磁盘上的 `~/.paseo/config.json` 却写成 `agents.providers` / `daemon.agentProfiles`。
 * 只认一种的后果不是报错，而是界面永远显示「没配过」——用户会去重配一遍。
 */
function profilesRawOf(config: DaemonConfigView | null): RawProfile[] {
  if (Array.isArray(config?.agentProfiles)) return config.agentProfiles;
  if (Array.isArray(config?.daemon?.agentProfiles)) return config.daemon.agentProfiles;
  return [];
}

export function providersRawOf(config: DaemonConfigView | null): Record<string, ProviderConfigView> {
  const root = config?.providers;
  if (root && typeof root === "object" && !Array.isArray(root)) return root;
  const nested = config?.agents?.providers;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return {};
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 密钥只回尾 4 位；短值直接全遮，避免「尾 4 位就是全文」。实现在 `shared/provider-models.ts`。 */
export function maskSecret(value: string): string {
  return maskValue(value);
}

export async function readDaemonConfig(paseo: PaseoApi): Promise<DaemonConfigView | null> {
  try {
    const result = await paseo.config.get();
    return (recordOf(result?.config) as DaemonConfigView | null) ?? null;
  } catch (error) {
    record("warn", SCOPE, `读取 daemon 配置失败：${sessionErrorDetail(error)}`);
    return null;
  }
}

/** 宿主档案 → 我们只认的字段；缺 id 或 provider 的条目直接跳过（宿主自己也会忽略）。 */
export function profilesOf(config: DaemonConfigView | null): ClientProfile[] {
  const raw = profilesRawOf(config);
  const profiles: ClientProfile[] = [];
  for (const item of raw) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const provider = typeof item?.provider === "string" ? item.provider.trim() : "";
    if (!id || !provider) continue;
    profiles.push({
      id,
      name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : id,
      provider,
      ...(item.model?.trim() ? { model: item.model.trim() } : {}),
      ...(item.modeId?.trim() ? { modeId: item.modeId.trim() } : {}),
      ...(item.thinkingOptionId?.trim() ? { thinkingOptionId: item.thinkingOptionId.trim() } : {}),
      ...(item.featureValues ? { featureValues: item.featureValues } : {}),
      ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
    });
  }
  return profiles;
}

function providerRows(
  snapshot: readonly ProviderEntryView[],
  config: DaemonConfigView | null,
): Array<{
  id: string;
  label: string | null;
  enabled: boolean;
  status: string;
  models: string[];
  configModels: string[];
  modelsKey: ModelListKey;
  /** 派生客户端的基座；不是派生条目就是 null。 */
  extends: string | null;
  /** 接入地址（不是机密，界面直接印原值）。 */
  baseUrl: string | null;
  /** 装凭据的键名（只有名字，值永远掩码）。 */
  credentialKeys: string[];
  env: Array<{ key: string; display: string; masked: boolean; hasValue: boolean }>;
}> {
  const providers = providersRawOf(config);
  return snapshot.map((entry) => {
    const id = (entry.provider ?? "").trim();
    const configured = providers[id];
    // 模型名不是机密：`ANTHROPIC_*_MODEL` 的值就是模型 id，宿主自己也在模型列表里印着，
    // 再给一串 `••••lash` 只会让人看不出这台机器跑的是哪个模型。
    const models = (entry.models ?? [])
      .map((model) => (model?.id ?? "").trim())
      .filter((model) => model.length > 0);
    const env = Object.entries(configured?.env ?? {})
      .map(([key, value]) => {
        const text = typeof value === "string" ? value : "";
        const shown = envDisplayOf(key, text, models);
        return {
          key,
          display: shown.display,
          masked: shown.masked,
          hasValue: text.trim().length > 0,
        };
      })
      .sort((left, right) => left.key.localeCompare(right.key));
    const modelsKey = modelListKeyOf(configured);
    const envText: Record<string, string> = {};
    for (const [key, value] of Object.entries(configured?.env ?? {})) {
      if (typeof value === "string") envText[key] = value;
    }
    return {
      id,
      label: entry.label?.trim() ? entry.label.trim() : null,
      enabled: entry.enabled !== false && (configured?.enabled ?? true),
      status: entry.status ?? "unknown",
      models,
      configModels: configuredModelIds(configured, modelsKey),
      modelsKey,
      extends: typeof configured?.extends === "string" && configured.extends.trim() ? configured.extends.trim() : null,
      baseUrl: baseUrlOf(envText)?.value ?? null,
      credentialKeys: credentialKeysOf(envText),
      env,
    };
  });
}

/**
 * 一个客户端的站点行 + 现在生效的那条。
 *
 * 「现在生效的是哪条」从**宿主配置里的值**反推（地址一致 + 凭证一致或站点没存凭证），
 * 不另存一个开关：多存一份就会漂移，用户在 Paseo 里手改地址后界面还在说「启用的是这条」。
 */
function siteRowsOf(clientId: string, sites: readonly Site[], configured: ProviderConfigView | undefined) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(configured?.env ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  const keys = envKeysFor(clientId, Object.keys(env));
  const enabled = enabledSiteOf(sites, {
    baseUrl: env[keys.baseUrlKey] ?? baseUrlOf(env)?.value ?? null,
    credential: env[keys.credentialKey] ?? null,
  });
  return { sites: sites.map(siteRowOf), enabledSiteId: enabled?.id ?? null };
}

/** 磁盘上的站点（含明文凭证）→ 线上形状（凭证只给掩码）。 */
export type SiteRow = {
  id: string;
  label: string | null;
  baseUrl: string;
  credentialMasked: string;
  hasCredential: boolean;
  updatedAt: string | null;
};

function siteRowOf(site: Site): SiteRow {
  return {
    id: site.id,
    label: site.label ?? null,
    baseUrl: site.baseUrl,
    credentialMasked: maskSecret(site.credential),
    hasCredential: site.credential.trim().length > 0,
    updatedAt: site.updatedAt ?? null,
  };
}

export interface OrchestrationStateInput {
  workspaceId: string;
  workspaceDir: string;
}

export type OrchestrationStateResult =
  | {
      ok: true;
      workspaceId: string;
      workspaceDir: string;
      settings: OrchestrationSettings;
      profiles: ClientProfile[];
      routing: Array<{
        difficulty: Difficulty;
        profileId: string | null;
        target: ClientTarget | null;
        resolved:
          | { ok: true; target: ClientTarget; via: "profile" | "target" }
          | { ok: false; reason: "profile-missing" | "no-target"; detail: string };
        /** 这一档没配路由时，实际借的是哪一档；一档都没配是 `default`。 */
        routeFrom?: Difficulty | "default";
      }>;
      /**
       * 直接从 `providerRows` 推：加一个字段不必改两处（以前就是改成两份、漏了一份）。
       * 站点并进这一行：界面上一处看全「这个客户端有哪些地址、现在用哪一条」。
       */
      providers: Array<
        ReturnType<typeof providerRows>[number] & {
          /** 这个客户端准备好的几条地址 + 凭证（同一时刻只有一条生效）。 */
          sites: Array<{
            id: string;
            label: string | null;
            baseUrl: string;
            credentialMasked: string;
            hasCredential: boolean;
            updatedAt: string | null;
          }>;
          /** 现在生效的那条（宿主配置里的地址与它一致）；对不上就是 null。 */
          enabledSiteId: string | null;
        }
      >;
      agents: Array<{
        agentId: string;
        title: string | null;
        provider: string | null;
        model: string | null;
        status: string | null;
        parentAgentId: string | null;
        labels: Record<string, string>;
      }>;
      tree: ReturnType<typeof buildAgentTree>;
      warnings: string[];
    }
  | { ok: false; reason: "invalid-workspace" | "config-failed" | "agents-failed"; detail: string };

const ALL_DIFFICULTIES: Difficulty[] = ["trivial", "normal", "hard", "critical"];

/** 一条路由落到具体目标：回答「哪个客户端 + 哪个模型」。 */
function resolveRuleTarget(
  rule: RoutingRule,
  profiles: readonly ClientProfile[],
):
  | { ok: true; target: ClientTarget; via: "profile" | "target" }
  | { ok: false; reason: "profile-missing" | "no-target"; detail: string } {
  return resolveRouteTarget(rule, profiles);
}

export async function readOrchestrationState(
  paseo: PaseoApi,
  input: OrchestrationStateInput,
): Promise<OrchestrationStateResult> {
  if (!input.workspaceId.trim() || !input.workspaceDir.trim()) {
    return { ok: false, reason: "invalid-workspace", detail: "需要 workspaceId 与工作区目录" };
  }
  const warnings: string[] = [];
  const stored = await readOrchestration(input.workspaceDir);
  if (stored.corrupt) {
    warnings.push(`编排设置解析失败，已按默认值处理：${stored.detail ?? "格式不对"}`);
  } else if (stored.readFailed) {
    warnings.push(`编排设置读不出来（不是「没配过」）：${stored.detail ?? "未知原因"}——下面显示的是默认值`);
  }
  const config = await readDaemonConfig(paseo);
  if (!config) warnings.push("daemon 配置读不到：客户端档案与注入配置这次显示为空，接手派单前先刷新");
  else if (!profilesRawOf(config).length && !Object.keys(providersRawOf(config)).length) {
    // 读到了 config 却两处都空：要么真没配过，要么宿主的形状又变了。
    // 明确说出来，别让用户以为「我配的注入丢了」。
    warnings.push("daemon 配置里既没有客户端档案也没有 providers：如果确认配过，就是宿主换配置形状了，先核对 config.json");
  }
  const profiles = profilesOf(config);

  let providerList: ReturnType<typeof providerRows> = [];
  try {
    const snapshot = await paseo.providers.snapshot({ cwd: input.workspaceDir });
    providerList = providerRows((snapshot?.entries ?? []) as ProviderEntryView[], config);
  } catch (error) {
    warnings.push(`客户端目录读取失败：${sessionErrorDetail(error)}`);
  }

  // 站点：挂在客户端下面，并进 provider 行里让界面一处看全。
  const siteRead = await readSiteBook();
  if (!siteRead.ok) {
    warnings.push(`站点表读不出来（这些客户端这次按「没有站点」显示）：${siteRead.detail}`);
  } else if (siteRead.dropped > 0) {
    warnings.push(`站点表里有 ${siteRead.dropped} 条格式不对，已忽略：检查 sites.json 或重新建一次`);
  }
  const siteBook = siteRead.ok ? siteRead.book : null;
  const knownIds = new Set(providerList.map((item) => item.id));
  const providers = providerList.map((row) => {
    const sites = siteBook ? sitesOf(siteBook, row.id) : [];
    return { ...row, ...siteRowsOf(row.id, sites, providersRawOf(config)[row.id]) };
  });
  if (siteBook) {
    for (const [clientId, sites] of Object.entries(siteBook.providers)) {
      if (!knownIds.has(clientId)) {
        warnings.push(`客户端 ${clientId} 下存着 ${sites.length} 条站点，但宿主里没有这个客户端：这些站点用不上`);
      }
    }
  }

  let agents: Array<{
    agentId: string;
    title: string | null;
    provider: string | null;
    model: string | null;
    status: string | null;
    parentAgentId: string | null;
    updatedAt: string | null;
    labels: Record<string, string>;
  }> = [];
  try {
    const listed = await paseo.agents.list();
    const entries = ((listed as { entries?: Array<{ agent?: AgentEntryView }> }).entries ?? [])
      .map((entry) => entry.agent)
      .filter((agent): agent is AgentEntryView => Boolean(agent?.id));
    agents = entries
      .filter((agent) =>
        matchesWorkspaceScope(
          { workspaceId: agent.workspaceId, cwd: agent.cwd },
          input.workspaceId,
          input.workspaceDir,
        ),
      )
      .map((agent) => {
        const labels = agent.labels ?? {};
        const parentAgentId = labels["paseo.parent-agent-id"]?.trim() || null;
        return {
          agentId: agent.id,
          title: agent.title ?? null,
          provider: agent.provider ?? null,
          model: agent.model ?? null,
          status: agent.status ?? null,
          parentAgentId,
          updatedAt: agent.updatedAt ?? null,
          labels,
        };
      });
  } catch (error) {
    return { ok: false, reason: "agents-failed", detail: sessionErrorDetail(error) };
  }

  const tree = buildAgentTree(
    agents.map(
      (agent): AgentNodeInput => ({
        agentId: agent.agentId,
        parentAgentId: agent.parentAgentId,
        title: agent.title,
        provider: agent.provider ?? "",
        model: agent.model,
        status: agent.status ?? "",
        labels: agent.labels,
        updatedAt: agent.updatedAt,
      }),
    ),
  );

  const routing = ALL_DIFFICULTIES.map((difficulty) => {
    const rule = resolveRoute(stored.settings, difficulty);
    const resolved = resolveRuleTarget(rule, profiles);
    return {
      difficulty,
      profileId: rule.profileId ?? null,
      target: rule.target ?? null,
      resolved,
      ...routeFromOf(stored.settings.routing, difficulty),
    };
  });

  // 没配路由的档位合成一句话：四档各来一行时，界面上顶部会被四条几乎一样的话占满，
  // 真正要看的东西（选哪个窗口派单）被挤到下面。
  const broken = new Set<string>();
  for (const item of routing) {
    if (item.resolved.ok) continue;
    broken.add(item.difficulty);
    warnings.push(`${item.difficulty} 这一档没有可用客户端：${item.resolved.detail}`);
  }
  const borrowed = routing.filter((item) => item.resolved.ok && item.routeFrom && !broken.has(item.difficulty));
  if (borrowed.length) {
    const byOther = borrowed.filter((item) => item.routeFrom !== "default");
    const byDefault = borrowed.filter((item) => item.routeFrom === "default");
    const parts: string[] = [];
    if (byOther.length) {
      const sources = [...new Set(byOther.map((item) => item.routeFrom))].join(" / ");
      parts.push(`${byOther.map((item) => item.difficulty).join(" / ")} 借用 ${sources} 的路由`);
    }
    if (byDefault.length) parts.push(`${byDefault.map((item) => item.difficulty).join(" / ")} 用内置默认目标`);
    warnings.push(`${borrowed.length} 档难度没配路由：${parts.join("；")}（到「路由」里配更准）`);
  }

  const role = stored.settings.roles.find((item) => item.workspaceId === input.workspaceId);
  if (!role?.dispatcherAgentId) warnings.push("还没有指定派单窗口：派单会被拒绝，先在「角色」里选一个会话");
  else if (!agents.some((agent) => agent.agentId === role.dispatcherAgentId)) {
    warnings.push("指定的派单窗口不在当前工作区的会话列表里（可能已归档）：请重新指定");
  }

  return {
    ok: true,
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
    settings: stored.settings,
    profiles,
    routing,
    providers,
    agents: agents.map(({ updatedAt: _updatedAt, ...rest }) => rest),
    tree,
    warnings,
  };
}

export type SaveResult =
  | { ok: true; settings: OrchestrationSettings; path: string; warnings: string[] }
  | { ok: false; reason: "invalid" | "write-failed"; detail: string };

export interface SaveInput {
  workspaceDir: string;
  settings: unknown;
  /**
   * 这份文件属于哪个工作区。
   *
   * 必须由调用方给，**不能**从 `settings.roles` 反推：清空本工作区的角色后，
   * 剩下来的另一个工作区 id 会被当成归属，此后这个工作区就再也派不出单。
   */
  workspaceId?: string;
}

/**
 * 保存整份编排设置。
 *
 * 客户端提交的是「它以为的完整设置」，服务端用 `normalizeOrchestration` 再收一次：
 * 认不出的字段丢掉、越界数值夹到范围内，坏配置写不进文件。
 * 校验失败报 `invalid`，写盘失败报 `write-failed`，两者不混为一谈。
 */
export async function saveOrchestration(input: SaveInput): Promise<SaveResult> {
  if (!input.workspaceDir.trim()) return { ok: false, reason: "invalid", detail: "缺少工作区目录" };
  const settings = normalizeOrchestration(input.settings);
  const warnings: string[] = [];
  if (!settings.roles.length) warnings.push("没有绑定任何工作区角色：派单会被拒绝");
  // 归属优先用调用方给的 id；只有没给时才退回「角色里唯一那个工作区」，
  // 一个都推不出来就不动文件里已有的 workspaceId（`writeOrchestration` 会保留）。
  const ids = [...new Set(settings.roles.map((role) => role.workspaceId.trim()).filter(Boolean))];
  const explicit = input.workspaceId?.trim();
  const written = await writeOrchestration(
    input.workspaceDir,
    settings,
    explicit
      ? { workspaceId: explicit }
      : ids.length === 1
        ? { workspaceId: ids[0] ?? null }
        : {},
  );
  if (!written.ok) return { ok: false, reason: "write-failed", detail: written.detail };
  record("info", SCOPE, `编排设置已保存到 ${written.file}`);
  return { ok: true, settings, path: written.file, warnings };
}

/** 改一个工作区的角色绑定：读旧 → 合并 → 写回。 */
export async function bindRoles(
  workspaceDir: string,
  role: WorkspaceRoles,
): Promise<SaveResult> {
  if (!workspaceDir.trim() || !role.workspaceId.trim()) {
    return { ok: false, reason: "invalid", detail: "需要工作区 id 与目录" };
  }
  const stored = await readOrchestration(workspaceDir);
  const next = withWorkspaceRoles(stored.settings, role);
  return saveOrchestration({ workspaceDir, settings: next });
}

/** 改一档难度路由。 */
export async function bindRoute(
  workspaceDir: string,
  difficulty: Difficulty,
  rule: RoutingRule | null,
): Promise<SaveResult> {
  if (!workspaceDir.trim()) return { ok: false, reason: "invalid", detail: "缺少工作区目录" };
  const stored = await readOrchestration(workspaceDir);
  const next = withRoutingRule(stored.settings, rule, difficulty);
  return saveOrchestration({ workspaceDir, settings: next });
}

export type ProviderPatchResult =
  | { ok: true; provider: string; applied: string[]; warnings: string[] }
  | { ok: false; reason: "invalid" | "config-failed" | "not-supported"; detail: string };

export interface ProviderPatchInput {
  provider: string;
  env?: Record<string, string>;
  enabled?: boolean;
  /** 显示名（宿主 `label`）。空串表示「不改」，宿主没有删除 label 的语义。 */
  label?: string;
  /** 这个客户端声明的**完整**模型清单（替换语义）：没列进去的会被删掉。 */
  models?: string[];
}

/**
 * 改某个客户端的注入配置。
 *
 * 只做「新增/修改」：删一个 env 键只能改 `~/.paseo/config.json`，这里如实返回 `not-supported`，
 * 不假装删掉了。
 *
 * env 必须**整份提交**：宿主的补丁在内存里是深合并，但落盘时 `env` 是整块替换
 * （`{...previousOverride, ...parsedOverride}`）。只交新键的话，`config.json` 里原有的键会被抹掉，
 * 内存里看着还在、重启就丢——读回校验也发现不了，因为内存读的是合并后的结果。
 */
/**
 * 取某一个注入键的**原值**。
 *
 * 默认全线只给掩码；这里是一次显式请求——用户在面板上点了那个键的「显示」。
 * 三条纪律：
 * - 一次只返回一个键，不把整份 env 明文倒出来；
 * - 值不进日志（`record` 只记 provider 与键名）；
 * - 拿不到就明说 `not-found`，不回落成空串让用户以为「值没了」。
 */
export type RevealEnvResult =
  | { ok: true; provider: string; key: string; value: string }
  | { ok: false; reason: "invalid" | "not-found" | "config-failed"; detail: string };

export async function revealProviderEnvValue(
  paseo: PaseoApi,
  input: { provider: string; key: string },
): Promise<RevealEnvResult> {
  const provider = input.provider?.trim() ?? "";
  const key = input.key?.trim() ?? "";
  if (!provider || !key) return { ok: false, reason: "invalid", detail: "要看哪个客户端的哪个键？provider 与 key 都要给" };

  const config = await readDaemonConfig(paseo);
  if (!config) {
    return { ok: false, reason: "config-failed", detail: "读不到 daemon 配置：原值就在那份配置里，读不到就不能编一个给你" };
  }
  const env = recordOf(providersRawOf(config)[provider]?.env);
  const value = env?.[key];
  if (typeof value !== "string") {
    return {
      ok: false,
      reason: "not-found",
      detail: `配置里没有 ${provider} 的 ${key}：宿主只存了这一个键值，可能刚被别人改掉了，刷新看看`,
    };
  }
  record("info", SCOPE, `按请求展示了 ${provider} 的 ${key} 的值（值不进日志）`);
  return { ok: true, provider, key, value };
}

export async function patchProviderConfig(
  paseo: PaseoApi,
  input: ProviderPatchInput,
): Promise<ProviderPatchResult> {
  const provider = input.provider.trim();
  if (!provider) return { ok: false, reason: "invalid", detail: "缺少 provider" };
  const patchEnv = input.env ?? {};
  const envKeys = Object.keys(patchEnv);
  for (const key of envKeys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { ok: false, reason: "invalid", detail: `环境变量名不合法：${key}` };
    }
  }
  const nextLabel = input.label?.trim();
  const hasWork =
    envKeys.length > 0 ||
    input.enabled !== undefined ||
    input.models !== undefined ||
    Boolean(nextLabel);
  if (!hasWork) return { ok: false, reason: "invalid", detail: "没有任何要改的字段" };

  const config = await readDaemonConfig(paseo);
  // 「配置读到了但这个客户端还没配过 env」与「配置根本读不到」必须分开：
  // 前者首次注入是正常动作（就写新键），后者才拒绝——读不到就没法带上已有的键。
  if (!config) {
    return {
      ok: false,
      reason: "config-failed",
      detail: "读不到 daemon 配置：此时无法确认已有的注入键，写入可能把它们从 config.json 里抹掉，先确认 daemon 可读再试",
    };
  }
  const before = providersRawOf(config)[provider];
  const providerPatch: Record<string, unknown> = {};
  const mergedEnv: Record<string, string> = {};
  if (envKeys.length) {
    // 宿主的内存里补丁是深合并，**落盘时 `env` 是整块替换**。
    // 只提交新注入的那几个键，`config.json` 里原有的其它键（比如先配的 API key）就会消失，
    // daemon 一重启就没了。所以这里先读出现有 env，整体一起提交。
    const existingEnv = before?.env;
    if (existingEnv !== undefined && (typeof existingEnv !== "object" || existingEnv === null || Array.isArray(existingEnv))) {
      return {
        ok: false,
        reason: "config-failed",
        detail: "这个客户端现有的 env 不是一份键值表：此时写入会把原来的值冲掉，先到 config.json 里核对再试",
      };
    }
    for (const [key, value] of Object.entries(existingEnv ?? {})) {
      if (typeof value === "string") mergedEnv[key] = value;
    }
    Object.assign(mergedEnv, patchEnv);
    providerPatch.env = mergedEnv;
  }
  if (input.enabled !== undefined) providerPatch.enabled = input.enabled;
  if (nextLabel) providerPatch.label = nextLabel.slice(0, 120);
  let modelsKey: ModelListKey | null = null;
  if (input.models !== undefined) {
    // 模型清单是**替换**语义：传进来什么，写完就是什么，没列进去的会被删掉。
    // 落在哪把键上要看现存配置——`models` 是「替换内置列表」，往它的
    // `additionalModels` 上写等于写到一个不生效的地方（本机 codex 就是这样）。
    modelsKey = modelListKeyOf(before);
    const wanted: string[] = [];
    for (const id of input.models) {
      const key = id.trim();
      if (key && !wanted.includes(key)) wanted.push(key);
    }
    if (modelsKey === "models" && wanted.length === 0) {
      return {
        ok: false,
        reason: "invalid",
        detail: "这个客户端用的是 `models`（替换内置列表），清空就等于一个模型都不剩。留一个，或直接改 config.json 删掉这把键。",
      };
    }
    // 条目形状是 `{ id, label }`，`label` 必填；留下来的条目要把宿主自己的字段
    // （`label` / `isDefault` / `description` / `thinkingOptions`）原样带回去。
    const current = before?.[modelsKey] ?? [];
    const kept: Array<Record<string, unknown>> = [];
    for (const item of current) {
      const id = typeof item === "string" ? item.trim() : (item.id ?? "").trim();
      if (!id || !wanted.includes(id)) continue;
      kept.push(typeof item === "string" ? { id, label: id } : { ...item });
    }
    for (const id of wanted) {
      if (!kept.some((item) => item.id === id)) kept.push({ id, label: id });
    }
    providerPatch[modelsKey] = kept;
  }
  try {
    await paseo.config.patch({ providers: { [provider]: providerPatch } });
  } catch (error) {
    return { ok: false, reason: "config-failed", detail: sessionErrorDetail(error) };
  }

  const applied = [
    ...envKeys.map((key) => `env.${key}`),
    ...(input.enabled !== undefined ? ["enabled"] : []),
    ...(nextLabel ? ["label"] : []),
    ...(input.models !== undefined && modelsKey ? [modelsKey] : []),
  ];
  const warnings: string[] = [
    "注入配置对**之后新建**的会话生效；已经在跑的会话不受影响。",
  ];
  const keptKeys = Object.keys(mergedEnv).filter((key) => !envKeys.includes(key));
  if (keptKeys.length) {
    warnings.push(`本次写入一并带上了已有的 ${keptKeys.length} 个键（宿主的补丁在落盘时整块替换 env，不带上就等于删掉）。`);
  }
  if (input.models !== undefined && modelsKey === "additionalModels") {
    warnings.push("这个客户端用的是 `additionalModels`（追加内置列表）：内置模型删不掉，这里只能增删自己加的那些。");
  }
  record("info", SCOPE, `provider ${provider} 注入配置已更新：${applied.join(", ")}`);

  // 读回校验：写成功不代表 daemon 真的收下了（补丁字段可能不被支持）。
  const after = await readDaemonConfig(paseo);
  const configuredAfter = providersRawOf(after)[provider];
  if (!configuredAfter) {
    warnings.push(`读回看不到客户端 ${provider} 的配置：这次写入可能没有落到 config.json 里，改完请核对一次`);
    return { ok: true, provider, applied, warnings };
  }
  if (envKeys.length) {
    const envAfter = configuredAfter.env ?? {};
    const missing = Object.keys(mergedEnv).filter((key) => (envAfter[key] ?? "") !== mergedEnv[key]);
    if (missing.length) {
      warnings.push(`读回不一致：${missing.join(", ")} 没有生效，检查是否被启动参数覆盖`);
    }
  }
  if (nextLabel && String(configuredAfter.label ?? "").trim() !== nextLabel) {
    warnings.push(`读回不一致：显示名没有写进去（期望 ${nextLabel}）`);
  }
  if (input.models !== undefined && modelsKey) {
    // 读回按集合比对：既查「该有的没有」，也查「该删的还在」——替换语义下
    // 只查前者会让「取消勾选没生效」静默通过。
    const afterIds = configuredModelIds(configuredAfter, modelsKey);
    const wantedIds = input.models.map((id) => id.trim()).filter(Boolean);
    const missing = wantedIds.filter((id) => !afterIds.includes(id));
    const leftover = afterIds.filter((id) => !wantedIds.includes(id));
    if (missing.length) warnings.push(`读回不一致：模型 ${missing.join(", ")} 没有写进去`);
    if (leftover.length) warnings.push(`读回不一致：已取消的模型 ${leftover.join(", ")} 仍在配置里，可能需要手动改 config.json`);
  }
  return { ok: true, provider, applied, warnings };
}

export type ProfileResult =
  | { ok: true; profiles: ClientProfile[]; warnings: string[] }
  | { ok: false; reason: "invalid" | "config-failed" | "not-found"; detail: string };

export interface ProfileInput {
  profile?: {
    id?: string;
    name: string;
    provider: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    notes?: string;
    featureValues?: Record<string, unknown>;
  };
  removeId?: string;
}

function newProfileId(): string {
  const stamp = Date.now().toString(36);
  const salt = Math.random().toString(36).slice(2, 8);
  return `agent_profile_${stamp}_${salt}`;
}

/**
 * 增改删客户端档案。
 *
 * 整表写回（宿主的补丁对数组是替换语义）。读-改-写之间有人并发改动时会互相覆盖：
 * 这是宿主补丁模型的限制，所以每次都在**改动前**重读一次，把窗口压到最小，
 * 并把这个限制在返回值里说清楚，而不是假装是原子的。
 */
export async function saveProfile(paseo: PaseoApi, input: ProfileInput): Promise<ProfileResult> {
  if (!input.profile && !input.removeId) {
    return { ok: false, reason: "invalid", detail: "需要 profile 或 removeId" };
  }
  const config = await readDaemonConfig(paseo);
  if (!config) return { ok: false, reason: "config-failed", detail: "读不到 daemon 配置" };
  // 整条原样留着：宿主的档案还有 icon / color / featureValues，我们只改自己认识的那几个字段。
  const existing: HostAgentProfile[] = profilesRawOf(config).map(toHostProfile);
  // 读不到任何档案、却要整表写回，是「读路径错了」和「宿主真的一条都没有」共有的样子。
  // 前者会一次性抹掉全部档案，所以写入后必须核对条数（见下面的读回校验）。
  const before = existing.length;

  let next: HostAgentProfile[];
  if (input.removeId) {
    next = existing.filter((item) => item.id !== input.removeId);
    if (next.length === before) return { ok: false, reason: "not-found", detail: `没有 id 为 ${input.removeId} 的档案` };
  } else {
    const profile = input.profile;
    if (!profile) return { ok: false, reason: "invalid", detail: "需要 profile" };
    const name = profile.name.trim();
    const provider = profile.provider.trim();
    if (!name || !provider) return { ok: false, reason: "invalid", detail: "档案必须有名字与 provider" };
    const id = profile.id?.trim() || newProfileId();
    // 只覆盖这次真正给了值的字段：没填的保留宿主原值，没认识的字段（icon / color）原样留着。
    const provided: Partial<HostAgentProfile> = {};
    if (profile.model?.trim()) provided.model = profile.model.trim();
    if (profile.modeId?.trim()) provided.modeId = profile.modeId.trim();
    if (profile.thinkingOptionId?.trim()) provided.thinkingOptionId = profile.thinkingOptionId.trim();
    if (profile.notes?.trim()) provided.notes = profile.notes.trim();
    if (profile.featureValues) provided.featureValues = profile.featureValues;
    const index = existing.findIndex((item) => item.id === id);
    if (index >= 0) {
      next = existing.map((item, at) => (at === index ? { ...item, ...provided } : item));
    } else {
      next = [...existing, { id, name, provider, ...provided }];
    }
  }

  try {
    await paseo.config.patch({ agentProfiles: next });
  } catch (error) {
    return { ok: false, reason: "config-failed", detail: sessionErrorDetail(error) };
  }
  const after = await readDaemonConfig(paseo);
  const warnings: string[] = [];
  // 写后读不到，就不敢说「写进去了」，但也不能把写前的旧配置当成「档案被清空」报错：
  // 那会让一次成功的写入显示成失败，还把人指去核对一份没动的文件。
  if (!after) {
    record("warn", SCOPE, "档案写入后读不到 daemon 配置，无法核对条数");
    return {
      ok: true,
      profiles: profilesOf(config),
      warnings: ["写入后读不到 daemon 配置，无法核对结果：请到 ~/.paseo/config.json 确认这次改动"],
    };
  }
  const profiles = profilesOf(after);
  // 整表替换 + 读路径出错 = 一次悄无声息的清空。逐个核对 id 有没有留下来，
  // 不按条数比：宿主自己带着的畸形条目、`toHostProfile` 补出来的空 id 都会让条数失真。
  const present = new Set(profiles.map((item) => item.id));
  // 只核对「看起来是真档案」的条目（有 id、有 provider）。宿主自己带着的畸形条目
  // （缺 provider 之类）本来就不会出现在可读档案里，拿它去比对只会每次保存都误报一次。
  const checked = next.filter((item) => item.id && item.provider).map((item) => item.id);
  const lost = checked.filter((id) => !present.has(id));
  if (lost.length) {
    record("warn", SCOPE, `档案写入后读回丢了 ${lost.length} 条：${lost.join(", ")}`);
    return {
      ok: false,
      reason: "config-failed",
      detail: `写入后读回少了这些档案：${lost.join(", ")}：宿主的档案列表可能被整表替换掉了，请到 ~/.paseo/config.json 核对一次`,
    };
  }
  record("info", SCOPE, `客户端档案已更新，共 ${profiles.length} 条`);
  return { ok: true, profiles, warnings };
}

// ---------------------------------------------------------------------------
// 派单
// ---------------------------------------------------------------------------

export interface DispatchInput {
  workspaceId: string;
  workspaceDir: string;
  tasks: Array<{ key: string; title?: string; prompt: string; difficulty?: Difficulty; map?: string }>;
  /** 这一批默认替哪张地图干活；逐条可以用 `tasks[].map` 覆盖。 */
  map?: string;
  depth?: number;
  dispatchId?: string;
  /** 实际在派单的会话；缺省用绑定的派单窗口。 */
  callerAgentId?: string;
  lang?: "zh" | "en";
}

export type DispatchOutcomeResult =
  | {
      key: string;
      ok: true;
      agentId: string;
      title: string | null;
      providerSpec: string;
      difficulty: Difficulty;
      partial: boolean;
      failureDetail: string | null;
    }
  | {
      key: string;
      ok: false;
      /** 与纯函数层的拒绝原因同源，另加 `create-failed`（走到宿主才失败的）。 */
      reason: DispatchRejection | "create-failed";
      detail: string;
    };

export type DispatchResult =
  | {
      ok: true;
      dispatchId: string;
      dispatcherAgentId: string;
      results: DispatchOutcomeResult[];
      warnings: string[];
    }
  | {
      ok: false;
      reason:
        | "unknown-workspace"
        | "no-dispatcher"
        | "depth-exceeded"
        | "invalid-workspace"
        | "settings-unreadable"
        | "settings-corrupt";
      detail: string;
    };

function dispatchIdOf(): string {
  return `dsp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 执行一次派单。
 *
 * 顺序：读设置与档案 → 出计划（纯函数，和界面预览用的是同一份）→ 逐条建会话。
 * 建会话失败**不整批回滚**：已经建出来的子会话照常工作，失败项带原因返回，
 * 让用户能补派而不是从头再来。
 */
/**
 * 每张地图上「已经开着」的 deck 子会话数。
 *
 * 口径：「开着」= 宿主状态不是 `closed`。跑着的、等着下一轮的、出错还没收的都还占着
 * 这台机器与额度，按已结束算就等于允许无限并行。
 *
 * 只数带 `deck.map` 标的子会话：接这个功能之前派出去的、以及宿主里别的子代理没有这个标，
 * 不知道它们替哪张地图干活，就不硬算进来。读不出来时返回空表并带上原因——预算这时会
 * 退化成「只算本批」，调用方必须把这句话说出来，不能让人以为硬拦住了。
 */
async function runningByMapOf(
  paseo: PaseoApi,
  input: { workspaceId: string; workspaceDir: string },
): Promise<{ counts: Record<string, number>; detail: string | null }> {
  try {
    const listed = await paseo.agents.list();
    const entries = ((listed as { entries?: Array<{ agent?: AgentEntryView }> }).entries ?? [])
      .map((entry) => entry.agent)
      .filter((agent): agent is AgentEntryView => Boolean(agent?.id));
    const counts: Record<string, number> = {};
    for (const agent of entries) {
      if (!matchesWorkspaceScope({ workspaceId: agent.workspaceId, cwd: agent.cwd }, input.workspaceId, input.workspaceDir)) {
        continue;
      }
      if (!isDeckChild(agent.labels)) continue;
      if (agent.status === "closed") continue;
      const map = readMapLabel(agent.labels);
      if (!map) continue;
      counts[map] = (counts[map] ?? 0) + 1;
    }
    return { counts, detail: null };
  } catch (error) {
    return { counts: {}, detail: sessionErrorDetail(error) };
  }
}

export async function runDispatch(paseo: PaseoApi, input: DispatchInput): Promise<DispatchResult> {
  if (!input.workspaceId.trim() || !input.workspaceDir.trim()) {
    return { ok: false, reason: "invalid-workspace", detail: "需要 workspaceId 与工作区目录" };
  }
  const stored = await readOrchestration(input.workspaceDir);
  // 读不出来 ≠ 没配过：拿默认值派单会被当成「这个工作区没绑角色」，把人指去补一条本来就在的角色。
  if (stored.readFailed) {
    return {
      ok: false,
      reason: "settings-unreadable",
      detail: `读不出编排设置 ${stored.file}：${stored.detail ?? "未知原因"}（这不是「没配过」，先修好文件权限或内容）`,
    };
  }
  if (stored.corrupt) {
    // 坏文件会回落默认值，而默认值里没有任何角色——继续往下走，报出来的是「先加一条角色」，
    // 把真正的原因（文件坏了）盖掉。
    return {
      ok: false,
      reason: "settings-corrupt",
      detail: `编排文件解析失败：${stored.detail ?? "格式不对"}——先修好 ${stored.file}，不能拿默认值派单`,
    };
  }
  const config = await readDaemonConfig(paseo);
  const profiles = profilesOf(config);
  const dispatchId = input.dispatchId?.trim() || dispatchIdOf();
  const depth = Math.max(input.depth ?? 1, 1);
  // 超层要拒绝，不能夹到上限放行：夹完之后返回值和真实层数对不上，树也就错了。
  if (depth > stored.settings.maxDepth) {
    return {
      ok: false,
      reason: "depth-exceeded",
      detail: `已经第 ${depth} 层，上限是 ${stored.settings.maxDepth} 层：不能再往下派`,
    };
  }

  // 预算要按「宿主上已经开着几个」算，所以先数一遍；数不出来就不装作拦住了（见下面的告警）。
  const running = await runningByMapOf(paseo, {
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
  });

  const plan = planDispatch({
    workspaceId: input.workspaceId,
    roles: stored.settings.roles,
    routing: stored.settings.routing,
    profiles,
    tasks: input.tasks,
    maxDepth: stored.settings.maxDepth,
    maxChildrenPerDispatch: stored.settings.maxChildrenPerDispatch,
    mapBudgets: stored.settings.mapBudgets,
    runningByMap: running.counts,
    ...(input.map?.trim() ? { map: input.map.trim() } : {}),
    depth: depth - 1,
    dispatchId,
    ...(input.callerAgentId?.trim() ? { callerAgentId: input.callerAgentId.trim() } : {}),
  });

  if (!plan.dispatcherAgentId) {
    // 拒绝原因按计划里那条走：「没绑过角色」与「绑了但没选派单窗口」的下一步不一样，
    // 统一报成 `no-dispatcher` 会让人去改一条根本不存在的角色。
    if (plan.rejected.some((item) => item.reason === "unknown-workspace")) {
      return { ok: false, reason: "unknown-workspace", detail: "这个工作区没有任何角色绑定：先到「编排」里加一条工作区角色" };
    }
    return { ok: false, reason: "no-dispatcher", detail: "这个工作区还没有指定派单窗口" };
  }

  const warnings: string[] = [];
  if (stored.settings.maxDepth < depth + 1) {
    warnings.push(`当前第 ${depth} 层，上限 ${stored.settings.maxDepth} 层：子会话不能再往下派`);
  }
  if (stored.settings.mapBudgets.length > 0) {
    if (running.detail) {
      warnings.push(
        `地图并发预算这次只能按本批算：宿主会话清单读不出来（${running.detail}），没法知道每张图上已经开着几个`,
      );
    }
    // 有预算却没说是哪张地图的票：这条边不受约束，要说出来，别让人以为配了就生效。
    if (!input.map?.trim() && plan.tasks.some((task) => !task.map)) {
      warnings.push(
        `配了地图并发预算（${stored.settings.mapBudgets.map((budget) => `${budget.map}=${budget.concurrency}`).join("、")}），但这批任务没带 map：这些任务不受预算约束`,
      );
    }
  }

  const results: DispatchOutcomeResult[] = [];

  for (const rejected of plan.rejected) {
    results.push({ key: rejected.key, ok: false, reason: rejected.reason, detail: rejected.detail });
  }

  // 收进一个局部常量：`plan.dispatcherAgentId` 在闭包里不再被类型缩窄（属性可能变），
  // 而这里已经用 if 挡过空值，多抄一行换来闭包里能直接用 string。
  const dispatcherAgentId: string = plan.dispatcherAgentId;

  const createFor = (task: (typeof plan.tasks)[number], target: ClientTarget, preamble: string) =>
    createAgent(paseo, {
      cwd: input.workspaceDir,
      provider: providerSpec(target),
      prompt: `${preamble}\n\n${task.prompt.trim()}`,
      ...(task.title ? { title: task.title } : {}),
      ...(target.modeId ? { modeId: target.modeId } : {}),
      ...(target.thinkingOptionId ? { thinkingOptionId: target.thinkingOptionId } : {}),
      ...(target.featureValues ? { featureValues: target.featureValues } : {}),
      labels: task.labels,
      parentAgentId: dispatcherAgentId,
      idempotencyKey: task.idempotencyKey,
      ledger: false,
    });

  for (const task of plan.tasks) {
    const preamble = buildDispatchPreamble({
      ...(input.lang ? { lang: input.lang } : {}),
      dispatcherAgentId: plan.dispatcherAgentId,
      difficulty: task.difficulty,
      ...(task.key ? { ticketKey: task.key } : {}),
      depth,
    });
    const created = await createFor(task, task.target, preamble);
    if (!created.ok) {
      results.push({
        key: task.key,
        ok: false,
        reason: "create-failed",
        detail: `${created.failure.kind}: ${created.failure.detail}`,
      });
      continue;
    }
    results.push({
      key: task.key,
      ok: true,
      agentId: created.agentId,
      title: created.title,
      providerSpec: providerSpec(task.target),
      difficulty: task.difficulty,
      partial: created.partial,
      failureDetail: created.failure?.detail ?? null,
    });
  }

  const built = results.filter((item) => item.ok).length;
  record(
    "info",
    SCOPE,
    `派单 ${dispatchId}：建出 ${built} 个，失败 ${results.length - built} 个，派单窗口 ${plan.dispatcherAgentId}`,
  );
  return { ok: true, dispatchId, dispatcherAgentId: plan.dispatcherAgentId, results, warnings };
}
// ---------------------------------------------------------------------------
// 站点（客户端下的地址 + 凭证，同一时刻只有一条生效）
// ---------------------------------------------------------------------------

export interface SaveSiteInput {
  provider: string;
  site?: { id: string; label?: string; baseUrl: string; credential?: string };
  /** 按 id 删一条；与 `site` 二选一。 */
  removeId?: string;
  /** 启用这条：把它的地址与凭证写进客户端自己的 env（对该客户端的所有新会话生效）。 */
  enableId?: string;
}

export type SaveSiteResult =
  | { ok: true; provider: string; sites: SiteRow[]; enabledSiteId: string | null; warnings: string[] }
  | { ok: false; reason: "invalid" | "not-found" | "config-failed" | "write-failed"; detail: string };

/**
 * 加 / 改 / 删 / 启用一条站点。
 *
 * 「启用」就是写宿主配置：`agents.providers.<client>.env` 是**一个客户端一份**，
 * 没有轮询也没有故障转移，所以同一时刻只有一条地址在用。换站 = 换这一份 env。
 * 已开的会话拿着开时的配置，不会被追溯——界面文案也是这么说的。
 */
export async function saveClientSite(paseo: PaseoApi, input: SaveSiteInput): Promise<SaveSiteResult> {
  const provider = input.provider.trim();
  if (!provider) return { ok: false, reason: "invalid", detail: "缺少客户端 id" };

  const read = await readSiteBook();
  if (!read.ok) return { ok: false, reason: "write-failed", detail: read.detail };
  const current = sitesOf(read.book, provider);
  const taken = current.map((site) => site.id);

  let book = read.book;
  const warnings: string[] = [];

  if (input.removeId !== undefined) {
    const id = normalizeSiteId(input.removeId);
    const removed = current.find((site) => site.id === id);
    if (!removed) return { ok: false, reason: "not-found", detail: `${provider} 下没有站点 ${id}` };
    const written = await updateSiteBook((bookNow) => withoutSite(bookNow, provider, id));
    if (!written.ok) return { ok: false, reason: "write-failed", detail: written.detail };
    book = written.book;
    warnings.push(`删掉的是站点表里的记录：宿主里 ${provider} 的地址与凭证没动，现在仍然是原来那条`);
  }

  if (input.site) {
    const id = provider === "" ? "" : normalizeSiteId(input.site.id);
    const existing = current.find((site) => site.id === id);
    const idProblem = siteIdProblem(id, taken.filter((item) => item !== id));
    if (idProblem) return { ok: false, reason: "invalid", detail: idProblem };
    const urlProblem = siteUrlProblem(input.site.baseUrl);
    if (urlProblem) return { ok: false, reason: "invalid", detail: urlProblem };
    const label = input.site.label?.trim();
    // 空凭证 = 沿用这条站点已存的那份（改地址时不必把密钥再贴一遍）；都没有就沿用客户端的。
    const credential = input.site.credential?.trim() ? input.site.credential.trim() : (existing?.credential ?? "");
    const site: Site = {
      id,
      ...(label ? { label } : {}),
      baseUrl: normalizeBaseUrl(input.site.baseUrl),
      credential,
      updatedAt: new Date().toISOString(),
    };
    const written = await updateSiteBook((bookNow) => withSite(bookNow, provider, site));
    if (!written.ok) return { ok: false, reason: "write-failed", detail: written.detail };
    book = written.book;
    if (!credential) warnings.push(`站点 ${id} 没填凭证：启用它会沿用 ${provider} 当前已有的凭证`);
  }

  if (input.enableId !== undefined) {
    const id = normalizeSiteId(input.enableId);
    const site = sitesOf(book, provider).find((item) => item.id === id);
    if (!site) return { ok: false, reason: "not-found", detail: `${provider} 下没有站点 ${id}` };
    const enabled = await enableSite(paseo, provider, site);
    if (!enabled.ok) return enabled;
    warnings.push(...enabled.warnings);
  }

  const settled = await readSiteBook();
  const sites = settled.ok ? sitesOf(settled.book, provider) : sitesOf(book, provider);
  const config = await readDaemonConfig(paseo);
  const rows = siteRowsOf(provider, sites, providersRawOf(config)[provider]);
  return { ok: true, provider, sites: sites.map(siteRowOf), enabledSiteId: rows.enabledSiteId, warnings };
}

/** 把这一条站点的地址与凭证写进客户端自己的 env；缺凭证时只换地址。 */
async function enableSite(
  paseo: PaseoApi,
  provider: string,
  site: Site,
): Promise<{ ok: true; warnings: string[] } | { ok: false; reason: "config-failed"; detail: string }> {
  // 配置里还没有这个客户端的条目是正常的（第一次给它配地址）：补丁会建出这一条。
  // 读不到整份配置才停下——那种情况下 patchProviderConfig 自己会拒绝。
  const before = providersRawOf(await readDaemonConfig(paseo))[provider];
  const existingKeys = Object.keys(before?.env ?? {});
  const keys = envKeysFor(provider, existingKeys);
  const env: Record<string, string> = { [keys.baseUrlKey]: site.baseUrl };
  const credential = site.credential.trim();
  if (credential) env[keys.credentialKey] = credential;
  const patched = await patchProviderConfig(paseo, { provider, env });
  if (!patched.ok) return { ok: false, reason: "config-failed", detail: patched.detail };

  const warnings: string[] = [];
  const live = providersRawOf(await readDaemonConfig(paseo))[provider]?.env ?? {};
  const liveCredential = live[keys.credentialKey] ?? "";
  if (!credential && !liveCredential.trim()) {
    warnings.push(`站点 ${site.id} 没填凭证，${provider} 现在也没有凭据：这个客户端起的会话会被接口拒绝`);
  }
  return { ok: true, warnings };
}
