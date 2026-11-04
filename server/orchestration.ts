import type { PaseoApi } from "@getpaseo/client";
import { matchesWorkspaceScope } from "../shared/session.ts";
import {
  buildDispatchPreamble,
  buildAgentTree,
  CODEX_SITE_LABEL,
  CODEX_SITE_PROVIDER,
  DECK_TICKET_LABEL,
  isDeckChild,
  isListedClient,
  isSupportedClient,
  normalizeOrchestration,
  planDispatch,
  providerSpec,
  readMapLabel,
  resolveRoute,
  resolveRouteTarget,
  routeFromOf,
  staffCardOf,
  SUPPORTED_CLIENTS_LABEL,
  ticketLabelOf,
  ticketSpecOf,
  withRoutingRule,
  withWorkspaceRoles,
  workspaceRolesOf,
  type AgentNodeInput,
  type ClientProfile,
  type ClientTarget,
  type Difficulty,
  type DispatchRegion,
  type DispatchRejection,
  type OrchestrationSettings,
  type RouteFailureReason,
  type RouteResolution,
  type RoutingRule,
  type WorkspaceRoles,
} from "../shared/orchestration.ts";
import {
  describeCodexEnsureFailure,
  ensureCodexAddressEffective,
  forgetAdoptFailures,
  forgetMirrorFailures,
  mirrorCodexSiteModels,
} from "./codex-adopt.ts";
import {
  CODEX_ADDRESS_KEY,
  CODEX_CREDENTIAL_KEY,
  codexSiteUsable,
  legacyCodexAddressOf,
  legacyCredentialOf,
  mirroredModelsOf,
  modelObjectsOf,
  providerEntryOf,
  providerWriteTargetOf,
  providersRawOf,
  textOf,
  withMissingModels,
  type ProviderConfigSource,
  type ProviderConfigView,
  type ProviderModelItemView,
} from "./provider-entry.ts";
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
import { modelIdsOf, type ProviderSnapshotEntry } from "./provider-snapshot-view.ts";
import { createDispatchTicket, recordDispatchTicket } from "./tracker/dispatch-ticket.ts";
import { collectStaffHistory } from "./staff-history.ts";
import { writableRepoKeys } from "./tracker/targets.ts";
import { readIssue } from "./tracker/read.ts";
import { judgeDispatchTaskChain } from "./chain-gates.ts";
import type { TicketReader } from "./contract-chain.ts";
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

export interface DaemonConfigView extends ProviderConfigSource {
  /** 线上视图（`config.get` / `config.patch`）：`providers`、`agentProfiles` 都在**根级**。 */
  agentProfiles?: RawProfile[];
  /** 磁盘形状（`~/.paseo/config.json`）：`daemon.agentProfiles` / `agents.providers`。 */
  daemon?: { agentProfiles?: RawProfile[] };
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
  snapshot: readonly ProviderSnapshotEntry[],
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
  return snapshot.map((rawEntry) => {
    // 快照是外部输入：一条 null / 非对象不该把整个状态页带下去，当成空条目处理。
    const entry: ProviderSnapshotEntry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
    const id = (entry.provider ?? "").trim();
    // Codex 的地址与凭证落在派生条目上：这一行要显示真正生效的那份。
    // `extends` 例外：那是实现细节，读客户端**自己**的条目——把派生条目的 `extends: "codex"`
    // 报上去，界面会在 Codex 卡片上印一句「基于 codex」。
    const own = providers[id];
    const configured = providerEntryOf(providers, id);
    // 模型名不是机密：`ANTHROPIC_*_MODEL` 的值就是模型 id，宿主自己也在模型列表里印着，
    // 再给一串 `••••lash` 只会让人看不出这台机器跑的是哪个模型。
    const models = modelIdsOf(entry);
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
      extends: typeof own?.extends === "string" && own.extends.trim() ? own.extends.trim() : null,
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
        resolved: RouteResolution;
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
  | { ok: false; reason: RouteFailureReason; detail: string } {
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
  let config = await readDaemonConfig(paseo);
  if (!config) warnings.push("daemon 配置读不到：客户端档案与注入配置这次显示为空，接手派单前先刷新");
  else if (!profilesRawOf(config).length && !Object.keys(providersRawOf(config)).length) {
    // 读到了 config 却两处都空：要么真没配过，要么宿主的形状又变了。
    // 明确说出来，别让用户以为「我配的注入丢了」。
    warnings.push("daemon 配置里既没有客户端档案也没有 providers：如果确认配过，就是宿主换配置形状了，先核对 config.json");
  }
  // 旧式 Codex 注入自愈：地址写在内建 `codex` 上时宿主不读，会话会退回 `~/.codex/config.toml`。
  // 这里把它搬到派生条目——打开面板看到的就是会话真正在用的那份，不用用户自己再点一遍。
  // 每次运行只试一遍同一条地址（`unadoptable`），宿主不接受派生 provider 时不会反复写盘。
  let codexAddressWarned = false;
  if (config) {
    const ensured = await ensureCodexAddressEffective(paseo, config);
    if (!ensured.ok) {
      // 两种失败不能混着说：`unverified` 是「已经写进去了、只是没核对上」，说成「接管失败」
      // 会把用户推回去再配一遍；`adopt-failed` 才是「地址没搬过去、会话会退回旧地址」。
      codexAddressWarned = true;
      warnings.push(describeCodexEnsureFailure(ensured.reason, ensured.detail, legacyCodexAddressOf(providersRawOf(config))));
    } else if (ensured.adopted) {
      config = ensured.config;
    }
    // 两份模型清单对齐：宿主的模型选择器按 provider 条目各显示一份（「Codex」那行读内建条目，
    // 注入生效的 `deck-codex` 是另一行），只写一份就会出现「这个窗口看得到、换个项目的新窗口就没了」。
    // 这里顺手对齐，用户不用为了「换个窗口也能看到」再保存一次。失败只影响别的窗口看到什么，
    // 不影响会话本身，所以给一句提示、不挡读状态。
    const mirrored = await mirrorCodexSiteModels(paseo, config);
    if (mirrored.ok) {
      if (mirrored.mirrored) config = mirrored.config;
    } else {
      warnings.push(`Codex 的模型清单没能同步到「Codex」那一条：${mirrored.detail}——传到其它窗口的模型选择器可能还是旧清单`);
    }
  }
  // 地址配着、新会话却用不上（派生条目被停用 / 缺地址 / 没继承 codex）时必须说出来：
  // 卡片上明明有地址，不说就是又一手说「配好了」、一手悄悄走回 `~/.codex/config.toml`。
  // 地址取两处之一：派生条目自己也可能是那条存过地址、却被停用/没继承 codex 的（接管路径不管它，
  // 那是用户明确留下的状态），只看内建 `codex` 会把这种情况整片漏成静默。
  if (config && !codexAddressWarned) {
    const entries = providersRawOf(config);
    const address =
      textOf(entries[CODEX_SITE_PROVIDER]?.env?.[CODEX_ADDRESS_KEY]) || textOf(entries.codex?.env?.[CODEX_ADDRESS_KEY]);
    if (address && !codexSiteUsable(entries[CODEX_SITE_PROVIDER])) {
      // 三种原因都要点到（停用 / 没地址 / 没继承 codex）：只写前两种，第三种用户会以为看错了。
      warnings.push(
        `Codex 的接入地址（${address}）现在不生效：派生条目 ${CODEX_SITE_PROVIDER} 被停用、没有地址，或没继承 codex` +
          "——要用它就回客户端页把接入地址重新保存一次（会写进去并启用这个派生条目）",
      );
    }
  }
  const profiles = profilesOf(config);

  let providerList: ReturnType<typeof providerRows> = [];
  try {
    const snapshot = await paseo.providers.snapshot({ cwd: input.workspaceDir });
    providerList = providerRows((snapshot?.entries ?? []) as ProviderSnapshotEntry[], config);
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
  // 客户端列表只留插件真能配的两家（Claude / Codex）：其余家在宿主里
  // 没有读 `*_BASE_URL` 的路径，列出来只能配出一份没人读的配置。
  // `deck-codex` 也在这里去掉：它是插件为 Codex 站点建的派生 provider，地址与模型
  // 已经并到 `codex` 那一行显示，再单列一个客户端只会让人以为多了一家。
  // 这里不逐家报「XX 已隐藏」：宿主本来就把七八家都报出来，那条警告会常驻在页面
  // 顶部变成噪音。口径写在客户端页的说明行里（`orch.clientsScope`），只有「隐藏的
  // 客户端下还存着站点」这种真会白存的才单独告警。
  // 宿主报出来的全部 id（含被隐藏的家与 `deck-codex`）：下面判「宿主没有这家」要靠它，
  // 光看过滤后的列表会把「宿主有、只是不显示」误说成「宿主里没有」。
  const hostReportedIds = new Set(providerList.map((row) => row.id.trim().toLowerCase()));
  providerList = providerList.filter((row) => isListedClient(row.id));
  const listedIds = new Set(providerList.map((item) => item.id.trim().toLowerCase()));
  if (providerList.length === 0) {
    // 过滤后空了有两种原因，界面上一句「没有可选的客户端」不说清是哪种，
    // 用户会去查一个其实装得好好的客户端。这里把宿主报出来的那几家点名。
    const reported = [...hostReportedIds].filter((id) => id !== CODEX_SITE_PROVIDER);
    if (reported.length) {
      warnings.push(
        `宿主报出 ${reported.length} 家客户端（${reported.join("、")}），但没有一家在插件支持范围内（${SUPPORTED_CLIENTS_LABEL}）：客户端列表与模型选择器都会是空的`,
      );
    }
  }
  const providers = providerList.map((row) => {
    const sites = siteBook ? sitesOf(siteBook, row.id) : [];
    // 「现在启用的是哪条」也要按真正生效的条目反推，否则 Codex 会被读成「没启用」。
    return { ...row, ...siteRowsOf(row.id, sites, providerEntryOf(providersRawOf(config), row.id)) };
  });
  if (siteBook) {
    for (const [clientId, sites] of Object.entries(siteBook.providers)) {
      // 站点表的键没归一（宿主快照里的 id 大小写不保证），比较前两边都归一一次。
      const key = clientId.trim().toLowerCase();
      if (listedIds.has(key)) continue;
      // 三种「这些站点用不上」，下一步各不相同，不能混成一句：
      // 派生 provider 不读站点 / 宿主有但不支持 / 宿主里真没这家。
      if (key === CODEX_SITE_PROVIDER) {
        warnings.push(
          `站点表里有 ${sites.length} 条挂在 ${CODEX_SITE_PROVIDER} 这个派生 provider 下：Codex 的站点按 codex 读，这些用不上`,
        );
        continue;
      }
      warnings.push(
        hostReportedIds.has(key)
          ? `客户端 ${clientId} 下存着 ${sites.length} 条站点，但插件不支持它（只显示 ${SUPPORTED_CLIENTS_LABEL}）：这些站点不会生效`
          : `客户端 ${clientId} 下存着 ${sites.length} 条站点，但宿主里没有这个客户端：这些站点用不上`,
      );
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
    // 说清楚这条路由是没配（落到内置默认）还是配坏了：两种下一步不一样。
    const origin =
      item.routeFrom === "default"
        ? "（没配路由，落到内置默认目标）"
        : item.routeFrom
          ? `（借用 ${item.routeFrom} 档的路由）`
          : "";
    warnings.push(`${item.difficulty} 这一档没有可用客户端${origin}：${item.resolved.detail}`);
  }
  // 路由/档案还能指向插件不支持的客户端（宿主那边照常可用，只是注入不进去）。
  // 会话建得出来，但地址与凭证落不到它身上——不说清楚，就成了「配了却不生效」的另一种版本。
  const unsupportedRoutes = routing.flatMap((item) =>
    item.resolved.ok && !isSupportedClient(item.resolved.target.provider)
      ? [{ difficulty: item.difficulty, provider: item.resolved.target.provider.trim() }]
      : [],
  );
  if (unsupportedRoutes.length) {
    // 写的是插件自己的派生 provider 时换个说法：用户本来就是冲 Codex 去的，
    // 说「不在支持范围内，换一个客户端」会把人带到错的方向。
    const derivedRoute = unsupportedRoutes.filter((item) => item.provider.toLowerCase() === CODEX_SITE_PROVIDER);
    const otherRoute = unsupportedRoutes.filter((item) => item.provider.toLowerCase() !== CODEX_SITE_PROVIDER);
    const parts: string[] = [];
    if (otherRoute.length) {
      parts.push(
        `${otherRoute.map((item) => `${item.difficulty}（${item.provider}）`).join("、")} 这几档派的客户端不在插件支持范围内（${SUPPORTED_CLIENTS_LABEL}）：会话能建，但接入地址与凭证注入不了——换一个客户端，或到 Paseo 自己的设置里给这家配`,
      );
    }
    if (derivedRoute.length) {
      parts.push(
        `${derivedRoute.map((item) => item.difficulty).join("、")} 这几档直接写了派生 provider ${CODEX_SITE_PROVIDER}：那是插件给 Codex 站点建的条目，路由里请写 codex（站点启用后会自动走派生那一条）`,
      );
    }
    warnings.push(...parts);
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
  const env = recordOf(providerEntryOf(providersRawOf(config), provider)?.env);
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
  // 收窄后的写入口：其余家在宿主那边没有读地址的路径，写进去不会有任何会话用上。
  // 界面上已经不给入口了，这里是给直接调 RPC 的调用方（agent 也会调）兜一层。
  if (!isSupportedClient(provider)) {
    return {
      ok: false,
      reason: "invalid",
      detail: `插件只支持 ${SUPPORTED_CLIENTS_LABEL} 的注入配置：${provider} 的地址与凭证写进去不会被任何会话读——要改它请到 Paseo 自己的设置里`,
    };
  }
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
  const providers = providersRawOf(config);
  // Codex 适配器写死只读 `OPENAI_BASE_URL`：别的名字写进去宿主不会看，
  // 会话照样走 `~/.codex/config.toml`。与其静默无效，不如在这里说清楚键名。
  if (provider === "codex") {
    const wrongName = envKeys.find((key) => /_BASE_URL$/i.test(key) && key !== CODEX_ADDRESS_KEY);
    if (wrongName) {
      return {
        ok: false,
        reason: "invalid",
        detail: `Codex 只认 OPENAI_BASE_URL 这个键名（适配器写死的），${wrongName} 写了也不会生效：改用 OPENAI_BASE_URL 再试`,
      };
    }
  }
  // 写哪儿、要不要建条目，判据与建会话时的路由同一条：派生条目**可用**才算数。
  // 不可用（缺失 / 停用 / 没地址 / 没继承 codex）时写进去等于写了个不生效的地方。
  const usableDerived = codexSiteUsable(providers[CODEX_SITE_PROVIDER]);
  // 这次补丁里带着接入地址，才谈得上把派生条目建出来：没有地址的派生条目是条死条目，
  // 会让之后每张 Codex 会话按「残条目」处理。所以「只改模型/凭证」时仍旧写在
  // 客户端自己的条目上（内建 `codex` 的 `models` 清单宿主照样用），等真配了地址再改道。
  const addsAddress = textOf(patchEnv[CODEX_ADDRESS_KEY]) !== "";
  const writesDerived = provider === "codex" && (usableDerived || addsAddress);
  const targetId = writesDerived ? CODEX_SITE_PROVIDER : provider;
  const before = providers[targetId];
  // 派生条目不在、或在了但不能用：这次写入要顺手把它建成可用的形状。
  const creatingDerived = provider === "codex" && writesDerived && !usableDerived;
  const providerPatch: Record<string, unknown> = {};
  if (creatingDerived) {
    // `extends` / `label` 缺一样宿主都不认；模型清单也搬过来，否则新条目看着像「一个模型都没有」。
    // 优先搬派生条目自己那份（残条目里可能已有用户加的模型），没有再搬内建的；键名跟着来源走，
    // `models` 与 `additionalModels` 语义不同，不能搬到另一把上。
    providerPatch.extends = "codex";
    providerPatch.label = CODEX_SITE_LABEL;
    // 找一个**真的有清单**的来源（残条目可能只有 label）：派生条目自己的优先，其次内建条目。
    const source = [providers[CODEX_SITE_PROVIDER], providers.codex].find((entry) => {
      const key = modelListKeyOf(entry);
      const list = entry?.[key];
      return Array.isArray(list) && list.length > 0;
    });
    if (source) {
      const inheritedKey = modelListKeyOf(source);
      providerPatch[inheritedKey] = source[inheritedKey];
    }
  }
  // 写进派生条目就顺手开启它（调用方没明确说停用时）：一条停用的派生条目会被路由当成
  // 「站点没生效」，地址与凭证写进去一句也不生效——那正是「配了却没生效」的形状。
  // 用户在客户端页上改地址，意思就是「让这条用起来」，不该还要再去别处拨一个开关。
  // `writesDerived` 已经蕴含 provider === "codex"：别家客户端带着一个叫 `OPENAI_BASE_URL`
  // 的 env 过来时，不能让这段顺手替它开开关。
  if (writesDerived && addsAddress && input.enabled === undefined) providerPatch.enabled = true;
  // 读清单的基准：新条目还没有自己的清单，就看内建那条。
  const modelBase = before ?? (creatingDerived ? providers.codex : undefined);
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
    // 建派生条目时把内建 `codex` 上那把凭证带过来：用户可能是先在卡片上存了凭证（落在内建条目）、
    // 再存地址（改道写派生条目）。只带**这一把**，不整份照抄——适配器只读 `OPENAI_API_KEY`，
    // 抄别的键只会在卡片上多出没人读、看不懂的行；地址也不抄旧的，那是这次写入自己决定的。
    if (creatingDerived && !envKeys.includes(CODEX_CREDENTIAL_KEY)) {
      const inherited = legacyCredentialOf(providers.codex?.env);
      if (inherited) mergedEnv[CODEX_CREDENTIAL_KEY] = inherited;
    }
    Object.assign(mergedEnv, patchEnv);
    providerPatch.env = mergedEnv;
  }
  if (input.enabled !== undefined) providerPatch.enabled = input.enabled;
  let modelsKey: ModelListKey | null = null;
  if (input.models !== undefined) {
    // 模型清单是**替换**语义：传进来什么，写完就是什么，没列进去的会被删掉。
    // 落在哪把键上要看现存配置——`models` 是「替换内置列表」，往它的
    // `additionalModels` 上写等于写到一个不生效的地方（本机 codex 就是这样）。
    modelsKey = modelListKeyOf(modelBase);
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
    const current = modelBase?.[modelsKey] ?? [];
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
  /**
   * 模型清单要写成**两份**。
   *
   * 宿主的模型选择器是按 provider 条目各显示一份的：卡片上看到的那行「Codex」读内建 `codex`
   * 的清单，注入真正生效的派生条目 `deck-codex` 是另一行、另一份清单。只写一份的后果就是
   * 「这个窗口看得到那个模型、换个项目的新窗口就没了」——用户没理由理解这两层的区别，
   * 他只知道「我配了两个模型」。所以派生条目可用时，把同一份清单照写到内建条目上。
   */
  const mirroredModels =
    input.models !== undefined && writesDerived && modelsKey ? (providerPatch[modelsKey] as Array<Record<string, unknown>>) : null;
  // 显示名一律落在客户端**自己**的条目上：面板卡片上的名字取自宿主快照里 `codex` 那条的
  // `label`（派生那一行被滤掉了），写到 `deck-codex` 上等于改了个看不见的地方。
  // `env` / `models` / `enabled` 落在「真正生效的那条」上：派生条目可用时是它，否则是客户端自己的条目
  // （判据见上面的 `writesDerived`）。注意 `enabled` 因此有两副意思：派生条目可用时停用 = 回原生 Codex，
  // 写在内建条目上 = 停用整家客户端。目前没有界面入口发这个字段，接界面时要分清。
  const patches: Record<string, Record<string, unknown>> = {};
  if (Object.keys(providerPatch).length) patches[targetId] = providerPatch;
  if (nextLabel) {
    patches[provider] = { ...(patches[provider] ?? {}), label: nextLabel.slice(0, 120) };
  }
  // 照写的那份落在内建条目**自己**用的那把键上：`models` 与 `additionalModels` 语义不同，
  // 搬错键就等于写到一个不生效的地方。内建条目上用户自己加的模型不删（`mirroredModelsOf`）。
  const mirrorKey: ModelListKey | null = mirroredModels ? modelListKeyOf(providers.codex) : null;
  const mirrorModels =
    mirroredModels && mirrorKey
      ? mirroredModelsOf(
          providers.codex?.[mirrorKey],
          mirroredModels as Array<ProviderModelItemView & { id: string; label: string }>,
          before?.[modelsKey ?? "models"],
        )
      : null;
  if (mirrorModels && mirrorKey) {
    patches[provider] = { ...(patches[provider] ?? {}), [mirrorKey]: mirrorModels };
  }
  try {
    await paseo.config.patch({ providers: patches });
  } catch (error) {
    return { ok: false, reason: "config-failed", detail: sessionErrorDetail(error) };
  }
  // 用户在卡片上重新存了地址：说明他刚动过配置，之前「这条地址搬不动」的判定值得再试一次
  // ——否则一次失败会在整段运行里把他锁死在同一个结论上（宿主升级、他手动改好 config 都救不回来）。
  if (provider === "codex" && addsAddress) forgetAdoptFailures(textOf(patchEnv[CODEX_ADDRESS_KEY]));
  // 用户刚改过模型清单：之前「补不进内建那一条」的判定值得再试一次（否则一次失败会在本次运行里
  // 一直挂着，靠读客户端页永远等不到重试）。
  if (input.models !== undefined) forgetMirrorFailures();

  const applied = [
    ...envKeys.map((key) => `env.${key}`),
    // 调用方没提 enabled 而我们顺手开了它（写派生条目时）：这算这次改动的结果，得列出来。
    ...(input.enabled !== undefined || providerPatch.enabled === true ? ["enabled"] : []),
    ...(nextLabel ? ["label"] : []),
    ...(input.models !== undefined && modelsKey ? [modelsKey] : []),
    // 照写进内建条目的那份也算这次改动的结果：用户在看的就是两行选择器。
    ...(mirrorModels && mirrorKey && mirrorKey !== modelsKey ? [mirrorKey] : []),
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
  // 整份配置读不回来只能说「没法核对」：写入可能已经成功，别把它报成没落地。
  if (!after) {
    warnings.push("读回读不到 daemon 配置：这次写入没法核对是否落地，请到 config.json 确认一次");
    return { ok: true, provider, applied, warnings };
  }
  const afterProviders = providersRawOf(after);
  const configuredAfter = afterProviders[targetId];
  // 往派生条目里写了地址、读回却不是一条能用的：写盘嘴上说成功、建会话照样被拦，
  // 这种「假成功」必须当场报失败，否则用户会在「保存成功」和「建不了会话」之间来回打转。
  // （调用方明确传 `enabled: false` 是要求关掉它，那不算。）
  // 判据是「这次带没带地址」，不是「写没写派生条目」：清空地址（传空串）时也写派生条目，
  // 但那是有意的清空，读回不可用是意料之中，不能报成「宿主没写成」。
  if (provider === "codex" && addsAddress && input.enabled !== false && !codexSiteUsable(configuredAfter)) {
    return {
      ok: false,
      reason: "config-failed",
      detail: `宿主没把 ${CODEX_SITE_PROVIDER} 存成能用的形状（继承 codex、地址、启用三样缺一不可）：这次地址不生效，先核对 ~/.paseo/config.json`,
    };
  }
  // 只改显示名时我们压根没往派生条目上写，不能拿「派生条目看不到」去报配置没落地。
  if (!configuredAfter && Object.keys(providerPatch).length) {
    warnings.push(`读回看不到客户端 ${provider} 的配置：这次写入可能没有落到 config.json 里，改完请核对一次`);
    return { ok: true, provider, applied, warnings };
  }
  if (configuredAfter && envKeys.length) {
    const envAfter = configuredAfter.env ?? {};
    const missing = Object.keys(mergedEnv).filter((key) => (envAfter[key] ?? "") !== mergedEnv[key]);
    if (missing.length) {
      warnings.push(`读回不一致：${missing.join(", ")} 没有生效，检查是否被启动参数覆盖`);
    }
  }
  // 显示名写在客户端自己的条目上，回读也核那一条（`targetId` 可能是派生条目）。
  if (nextLabel && String(afterProviders[provider]?.label ?? "").trim() !== nextLabel) {
    warnings.push(`读回不一致：显示名没有写进去（期望 ${nextLabel}）`);
  }
  // 用户勾的模型 id，两处核对共用一份：各算一遍迟早分叉。
  const wantedIds = (input.models ?? []).map((id) => id.trim()).filter(Boolean);
  if (configuredAfter && input.models !== undefined && modelsKey) {
    // 读回按集合比对：既查「该有的没有」，也查「该删的还在」——替换语义下
    // 只查前者会让「取消勾选没生效」静默通过。
    const afterIds = configuredModelIds(configuredAfter, modelsKey);
    const missing = wantedIds.filter((id) => !afterIds.includes(id));
    const leftover = afterIds.filter((id) => !wantedIds.includes(id));
    if (missing.length) warnings.push(`读回不一致：模型 ${missing.join(", ")} 没有写进去`);
    if (leftover.length) warnings.push(`读回不一致：已取消的模型 ${leftover.join(", ")} 仍在配置里，可能需要手动改 config.json`);
  }
  // 照写到内建条目的那份也要核对：模型选择器里「Codex」那行显示的就是它，
  // 没落地的话换个窗口还是看不到刚才勾的模型。
  if (mirrorModels && mirrorKey) {
    const liveMirrorIds = configuredModelIds(afterProviders[provider], mirrorKey);
    const missing = wantedIds.filter((id) => !liveMirrorIds.includes(id));
    if (missing.length) {
      warnings.push(`读回不一致：模型 ${missing.join(", ")} 没写进 ${provider} 那一条，别的窗口里模型选择器可能还是旧清单`);
    }
    // 宿主若把 `additionalModels` 当追加处理，同一份清单会被重复写进去：查一次，
    // 否则模型选择器里会出现两行同名模型，而且下一次保存再叠一份。
    const duplicated = [...new Set(liveMirrorIds.filter((id, index) => liveMirrorIds.indexOf(id) !== index))];
    if (duplicated.length) {
      warnings.push(`读回不一致：${provider} 那一条里模型 ${duplicated.join(", ")} 重复了，去 config.json 删掉多余的一份`);
    }
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
  tasks: Array<{
    key: string;
    title?: string;
    prompt: string;
    difficulty?: Difficulty;
    map?: string;
    /** 派给名册上的哪张卡；名册非空时必填，或改给 `region` 按归属算。 */
    staff?: string;
    /** 这条任务落在哪个仓库；多仓库工作区必填。 */
    repoKey?: string;
    /** 这条活落在哪片：仓库 + 路径前缀。`staff` 没给时按它算归属。 */
    region?: DispatchRegion;
    /** 挂回哪条需求票；普通派单不传。 */
    requirementKey?: number;
    /** 需求票自己所在的仓库；子票仓库不能代替它判断父边能不能挂。 */
    requirementRepoKey?: string;
  }>;
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
      /** 这条任务落成的那张票：会话是进程，票才是这件事留下的凭证。 */
      ticket: { number: number; url: string; repoKey: string } | null;
      /** 票建好了但附带写入没成（标签 / 父票）：票是真的，这些要人补。 */
      ticketNotes: string[];
    }
  | {
      key: string;
      ok: false;
      /**
       * 与纯函数层的拒绝原因同源，另加两个走到宿主/票面才失败的：
       * `ticket-failed`（票没建成，这条活不派）、`create-failed`（票建好了，会话没建起来）。
       */
      reason: DispatchRejection | "create-failed" | "ticket-failed";
      detail: string;
      /** `create-failed` 时说明票已经建出来了：别让人以为整件事没发生又重派一遍。 */
      ticket?: { number: number; url: string; repoKey: string } | null;
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

export async function runDispatch(
  paseo: PaseoApi,
  input: DispatchInput,
  options: { readonly reader?: TicketReader } = {},
): Promise<DispatchResult> {
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

  // 多仓库工作区：没写 repoKey 的任务在这里就拒，别等票建不出来才发现。
  const repoListing = await writableRepoKeys(input.workspaceDir);
  const repoKeys = repoListing.keys;

  const plan = planDispatch({
    workspaceId: input.workspaceId,
    roles: stored.settings.roles,
    routing: stored.settings.routing,
    profiles,
    tasks: input.tasks,
    maxDepth: stored.settings.maxDepth,
    maxChildrenPerDispatch: stored.settings.maxChildrenPerDispatch,
    minConcurrentStaff: stored.settings.minConcurrentStaff,
    mapBudgets: stored.settings.mapBudgets,
    repoKeys,
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
  // 仓库清单读不出来时 `repoKeys` 是空数组，多仓库校验会整段跳过：
  // 不说出来，用户会以为每条任务都验过 repoKey 了。
  if (repoListing.detail) {
    warnings.push(`读不出这个工作区有哪些仓库，多仓库校验这一批跳过：${repoListing.detail}`);
  }
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
  // 票面上要写「谁干的」：会话会被归档，票是留下的凭证。
  // 名册按目录合并（同一目录会有好几个 workspaceId），否则换个工作区打开就找不到卡。
  const workspaceRoles = workspaceRolesOf(stored.settings, input.workspaceId);

  for (const rejected of plan.rejected) {
    results.push({ key: rejected.key, ok: false, reason: rejected.reason, detail: rejected.detail });
  }

  // 收进一个局部常量：`plan.dispatcherAgentId` 在闭包里不再被类型缩窄（属性可能变），
  // 而这里已经用 if 挡过空值，多抄一行换来闭包里能直接用 string。
  const dispatcherAgentId: string = plan.dispatcherAgentId;

  const createFor = (
    task: (typeof plan.tasks)[number],
    target: ClientTarget,
    preamble: string,
    labels: Readonly<Record<string, string>>,
  ) =>
    createAgent(paseo, {
      cwd: input.workspaceDir,
      // 派出去的会话也落回**这条**工作区：不给 id，宿主会为同一目录再登记一条新工作区。
      workspaceId: input.workspaceId,
      provider: providerSpec(target),
      prompt: `${preamble}\n\n${task.prompt.trim()}`,
      ...(task.title ? { title: task.title } : {}),
      ...(target.modeId ? { modeId: target.modeId } : {}),
      ...(target.thinkingOptionId ? { thinkingOptionId: target.thinkingOptionId } : {}),
      ...(target.featureValues ? { featureValues: target.featureValues } : {}),
      // 岗位职责进系统提示：这是「这张卡是谁」唯一能真正约束行为的通道。
      ...(task.systemPrompt ? { systemPrompt: task.systemPrompt } : {}),
      labels,
      parentAgentId: dispatcherAgentId,
      idempotencyKey: task.idempotencyKey,
      ledger: false,
    });

  // 链条的事实每张需求读一次：同一批里多条任务挂同一条需求时，不逐条重复读正文。
  const chainRequirements = new Map<
    string,
    { readonly body: string; readonly repoKey: string | null } | { readonly detail: string }
  >();
  for (const task of plan.tasks) {
    // 链条闸要在执行层再查一次：MCP 的 deck_dispatch_plan 只是预览，
    // 直接走 RPC 派单会绕过它。按票级判定，坏的一条不拖累整批。
    if (task.requirementKey !== undefined) {
      const key = `${task.requirementRepoKey ?? ""}#${task.requirementKey}`;
      let requirement = chainRequirements.get(key);
      if (!requirement) {
        if (typeof task.requirementBody === "string") {
          // 需求拆票已经读过正文：直接用，避免执行层再读一遍（也避免拿工作区里不存在的票号误报）。
          requirement = { body: task.requirementBody, repoKey: task.requirementRepoKey ?? null };
        } else {
          const read = await readIssue(input.workspaceDir, task.requirementKey, {
            ...(task.requirementRepoKey ? { repoKey: task.requirementRepoKey } : {}),
          });
          requirement = !read.ok || !read.result.ok
            ? { detail: read.ok ? (read.result.ok ? "需求票读回来了但没有正文" : read.result.detail) : read.detail }
            : {
                body: typeof read.result.issue.body === "string" ? read.result.issue.body : "",
                repoKey: read.repoKey ?? null,
              };
        }
        chainRequirements.set(key, requirement);
      }
      if ("detail" in requirement) {
        results.push({
          key: task.key,
          ok: false,
          // RPC 输出类型是固定的 reason 枚举（schema 不归本批改）；「票没建成」是它的既有含义，
          // 具体是链条闸拦下的，detail 里写清楚。
          reason: "ticket-failed",
          detail: `读不出需求 #${task.requirementKey} 的正文，不能判链条：${requirement.detail}`,
        });
        continue;
      }
      const chain = await judgeDispatchTaskChain({
        workspaceDir: input.workspaceDir,
        requirementBody: requirement.body,
        requirementRepoKey: task.requirementRepoKey ?? requirement.repoKey,
        targetRepoKey: task.repoKey ?? task.region?.repoKey ?? null,
        title: task.title ?? null,
        prompt: task.prompt,
        ...(options.reader ? { reader: options.reader } : {}),
      });
      if (!chain.ok) {
        results.push({ key: task.key, ok: false, reason: "ticket-failed", detail: chain.reason });
        continue;
      }
      warnings.push(...chain.warnings);
    }

    // 先建票，再建会话：这条活必须有一张票。票建不出来就不派——否则它只活在一个
    // 进程里，窗口一关就什么都不剩，正是这次要修的毛病。
    const card = task.staffId ? staffCardOf(workspaceRoles, task.staffId) : null;
    const ticket = await createDispatchTicket(input.workspaceDir, {
      ...ticketSpecOf({
        task: { ...task, providerSpec: providerSpec(task.target) },
        card,
        dispatchId,
        dispatcherAgentId,
        depth,
        workspaceId: input.workspaceId,
      }),
      idempotencyKey: task.idempotencyKey,
    });
    if (!ticket.ok) {
      results.push({ key: task.key, ok: false, reason: "ticket-failed", detail: ticket.detail, ticket: null });
      continue;
    }
    recordDispatchTicket(ticket, { difficulty: task.difficulty, key: task.key });
    const ticketRef = { number: ticket.number, url: ticket.url, repoKey: ticket.repoKey };

    // 会话标签里的 `deck.ticket` 指向**真建出来的**票号，不再用计划里那个任务键：
    // 从会话反查票是这条链上唯一一处硬链接，指错了等于没有。
    // 多仓库工作区里同号票可能不止一张：写全 `owner/repo#N`，履历反查才不会读到别仓库的同号票。
    const labels = { ...task.labels, [DECK_TICKET_LABEL]: ticketLabelOf(ticket.repoKey, ticket.number) };
    const preamble = buildDispatchPreamble({
      ...(input.lang ? { lang: input.lang } : {}),
      dispatcherAgentId: plan.dispatcherAgentId,
      difficulty: task.difficulty,
      ticketKey: `#${ticket.number}`,
      depth,
    });
    // 岗位履历：岗位卡不常驻，不补这一段的会话每次都是陌生工。读失败只进 warning，
    // 不影响建票与建会话——履历是补充，不是派单的前置条件。
    let dispatchTask = task;
    if (task.staffId) {
      const history = await collectStaffHistory(paseo, {
        workspaceId: input.workspaceId,
        staffId: task.staffId,
        workspaceDir: input.workspaceDir,
      });
      warnings.push(...history.warnings);
      if (history.text) {
        dispatchTask = {
          ...task,
          systemPrompt: [task.systemPrompt, history.text].filter(Boolean).join("\n\n"),
        };
      }
    }
    const created = await createFor(dispatchTask, task.target, preamble, labels);
    if (!created.ok) {
      results.push({
        key: task.key,
        ok: false,
        reason: "create-failed",
        detail: `${created.failure.kind}: ${created.failure.detail}（票 #${ticket.number} 已经建好，没有派出去）`,
        ticket: ticketRef,
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
      ticket: ticketRef,
      ticketNotes: ticket.notes,
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
  // 不支持的家不给建站/启用（存了也没有会话会读，正是「配了却不生效」那条路）；
  // 删除仍然放行，免得早先留下的记录清不掉。动作可能一次带好几个（删 + 建 + 启用），
  // 所以按动作分别拦，不能只看「有没有 removeId」。
  const unsupportedWrite = (): SaveSiteResult => ({
    ok: false,
    reason: "invalid",
    detail: `插件只支持 ${SUPPORTED_CLIENTS_LABEL} 的接入配置：${provider} 的站点存了也不会生效`,
  });
  const writable = isSupportedClient(provider);

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
    if (!writable) return unsupportedWrite();
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
    if (!writable) return unsupportedWrite();
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
  // 回给界面的「现在生效的是哪条」要读真正生效的那条配置（Codex 是派生条目）。
  const configProviders = providersRawOf(config);
  const rows = siteRowsOf(provider, sites, providerEntryOf(configProviders, provider));
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
  const config = await readDaemonConfig(paseo);
  if (!config) {
    return { ok: false, reason: "config-failed", detail: "读不到 daemon 配置：无法保留 provider 已有的模型与 env，拒绝启用站点" };
  }
  const providers = providersRawOf(config);
  const before = providers[provider];
  const targetProvider = providerWriteTargetOf(provider);
  const targetBefore = providers[targetProvider];
  // Codex 适配器只读这两把键（`codex-app-server-agent.js` 的 `OPENAI_BASE_URL` /
  // `OPENAI_API_KEY`），所以**不能**沿用既有键名：`envKeysFor` 遇到自定义的
  // `*_API_KEY` 会沿用它，而那是 Codex 根本不看的键。
  const keys = provider === "codex"
    ? { baseUrlKey: CODEX_ADDRESS_KEY, credentialKey: CODEX_CREDENTIAL_KEY }
    : envKeysFor(provider, Object.keys(before?.env ?? {}));
  // 旧式注入可能把凭证放在别的键上（例如自定义的 `*_API_KEY`）：从内建条目里找回来。
  // 优先 `OPENAI_API_KEY`（那本来就是 Codex 认的键），再按 `*_API_KEY` → `*_TOKEN` 的顺序，
  // 不按 env 的插入顺序取第一条——多键时那样可能捡到一把这里根本用不上的钥匙。
  const credential = site.credential.trim() || (provider === "codex" ? legacyCredentialOf(before?.env) : "");
  const env: Record<string, string> = { [keys.baseUrlKey]: site.baseUrl };
  if (credential) env[keys.credentialKey] = credential;
  // 模型清单跟「用户最近改的那份」走：派生条目被停用时，模型改动是落回内建条目上的
  // （见 `patchProviderConfig` 的 `writesDerived`），这里若仍优先搬派生条目留着的旧清单，
  // 就会把用户刚改的那份盖掉。派生条目可用时才以它为准。
  const modelSource = codexSiteUsable(targetBefore) ? targetBefore : before;
  const models = modelObjectsOf(modelSource?.models);
  const additionalModels = modelObjectsOf(modelSource?.additionalModels);
  const providerPatch = provider === "codex"
    ? {
        extends: "codex",
        label: CODEX_SITE_LABEL,
        enabled: true,
        ...(models ? { models } : {}),
        ...(additionalModels ? { additionalModels } : {}),
        env: { ...(targetBefore?.env ?? {}), ...env },
      }
    : null;
  // 模型清单要写成两份（同 `patchProviderConfig` 里那段说明）：这条路径直写补丁、
  // 不经那个函数，所以对齐得自己做一遍。否则启用站点之后，模型选择器里「Codex」那一行
  // 还是旧清单——用户换个项目开新窗口，刚配的模型就「不见了」。
  // 只补不删：内建那行可能有用户自己在宿主设置里加的模型。
  // 要照写的那份按**来源条目自己用的那把键**取：接管旧式配置时清单落在 `additionalModels` 上，
  // 只看 `models` 就会漏掉整个对齐。
  const mirrorSourceKey: ModelListKey | null = provider === "codex" ? modelListKeyOf(modelSource) : null;
  const mirrorSourceModels = mirrorSourceKey ? modelObjectsOf(modelSource?.[mirrorSourceKey]) : undefined;
  const mirrorKey: ModelListKey | null = mirrorSourceModels ? modelListKeyOf(before) : null;
  const mirrorModels =
    mirrorKey && mirrorSourceModels
      ? mirroredModelsOf(before?.[mirrorKey], mirrorSourceModels, modelSource?.[mirrorSourceKey ?? "models"])
      : null;
  const mirrorChanged = Boolean(
    mirrorKey && mirrorModels && mirrorModels.length !== (modelObjectsOf(before?.[mirrorKey])?.length ?? 0),
  );
  let patched: ProviderPatchResult;
  if (providerPatch) {
    try {
      const patches: Record<string, Record<string, unknown>> = { [targetProvider]: providerPatch };
      if (mirrorKey && mirrorModels && mirrorChanged) patches.codex = { [mirrorKey]: mirrorModels };
      await paseo.config.patch({ providers: patches });
      patched = { ok: true, provider: targetProvider, applied: Object.keys(env).map((key) => `env.${key}`), warnings: [] };
    } catch (error) {
      return { ok: false, reason: "config-failed", detail: sessionErrorDetail(error) };
    }
  } else {
    patched = await patchProviderConfig(paseo, { provider: targetProvider, env });
  }
  if (!patched.ok) return { ok: false, reason: "config-failed", detail: patched.detail };

  const warnings: string[] = [];
  const afterConfig = await readDaemonConfig(paseo);
  // 「整份配置读不到」只能说「没法核对」（写入可能已经成功）；
  // 「配置读得到、就是没有这一条」则是写入没落地，必须报失败。
  if (!afterConfig) {
    record("warn", SCOPE, `启用站点后读不到 daemon 配置：无法核对 ${targetProvider} 的写入结果`);
    warnings.push(`启用后读不到 daemon 配置，无法核对是否生效：请到 ~/.paseo/config.json 确认这次改动`);
    return { ok: true, warnings };
  }
  const liveEntry = providersRawOf(afterConfig)[targetProvider];
  if (!liveEntry) {
    return { ok: false, reason: "config-failed", detail: `写入后读回看不到 ${targetProvider}：这次启用没有落地，请核对 config.json` };
  }
  if (provider === "codex") {
    // 派生 provider 没被建成（或没继承 codex），宿主照样会收下 env 却用不到：
    // 这种必须在启用这一步就暴露，否则之后每一条 Codex 会话都会被路由拦掉。
    if (liveEntry.extends !== "codex" || liveEntry.enabled === false) {
      return {
        ok: false,
        reason: "config-failed",
        detail: `${targetProvider} 没有作为派生 Codex provider 生效（extends=${String(liveEntry.extends ?? "未写入")}）：宿主可能不接受派生配置，请核对 config.json`,
      };
    }
  }
  const live = liveEntry.env ?? {};
  if (live[keys.baseUrlKey] !== site.baseUrl) {
    return { ok: false, reason: "config-failed", detail: `写入后读回不一致：${targetProvider} 的 ${keys.baseUrlKey} 没有生效` };
  }
  const liveCredential = textOf(live[keys.credentialKey]);
  if (credential && liveCredential !== credential) {
    return { ok: false, reason: "config-failed", detail: `写入后读回不一致：${targetProvider} 的 ${keys.credentialKey} 没有生效` };
  }
  if (!credential && !liveCredential) {
    warnings.push(`站点 ${site.id} 没填凭证，${targetProvider} 现在也没有凭据：这个客户端起的会话会被接口拒绝`);
  }
  // 照写进内建条目的那份也核一遍：模型选择器里「Codex」那行显示的是它，没落地的话
  // 换个项目开新窗口还是看不见刚配的模型（就是用户报的那个现象）。
  if (mirrorModels && mirrorKey && mirrorChanged) {
    const liveMirrorIds = configuredModelIds(providersRawOf(afterConfig).codex, mirrorKey);
    const missing = mirrorModels.map((item) => item.id).filter((id) => !liveMirrorIds.includes(id));
    if (missing.length) {
      warnings.push(`读回不一致：模型 ${missing.join(", ")} 没写进 codex 那一条，别的窗口里模型选择器可能还是旧清单`);
    }
  }
  return { ok: true, warnings };
}
