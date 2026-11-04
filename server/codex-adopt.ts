import type { PaseoApi } from "@getpaseo/client";
import { CODEX_SITE_LABEL, CODEX_SITE_PROVIDER } from "../shared/orchestration.ts";
import { record } from "./logs.ts";
import {
  CODEX_ADDRESS_KEY,
  CODEX_CREDENTIAL_KEY,
  CODEX_EFFECTIVE_ENV_KEYS,
  codexSiteUsable,
  legacyCodexAddressOf,
  legacyCredentialOf,
  modelObjectsOf,
  providersRawOf,
  redundantCredentialKeysOf,
  withMissingModels,
  type ProviderConfigSource,
  type ProviderConfigView,
} from "./provider-entry.ts";
import { configuredModelIds, modelListKeyOf } from "../shared/provider-models.ts";
import { sessionErrorDetail } from "./session.ts";

const SCOPE = "orchestration";

/**
 * 搬家结果：搬成了 / 本来就不用搬 / 没搬成。
 *
 * 失败还要分两种，因为对用户的意思完全不同：`patch-failed` 是地址**没搬过去**（会话会退回
 * `~/.codex/config.toml`）；`unverified` 是地址**已经写进去了**、只是读不回来核对——
 * 这时候说「搬不动」会把人推回去再配一遍。
 */
export type CodexAdoptResult =
  /** `adopted: true` 时把**核对过**的那份配置一并交回：调用方不用再读一次。 */
  | { ok: true; adopted: false }
  | { ok: true; adopted: true; config: ProviderConfigSource }
  | { ok: false; reason: "patch-failed" | "unverified"; detail: string };

/**
 * 「确保地址生效」的结果。`reason` 分开两件事，因为对用户的意思完全不同：
 *
 * - `adopt-failed`：地址还在内建 `codex` 上没搬过去，会话会退回 `~/.codex/config.toml`；
 * - `unverified`：地址已经写进派生条目了，但紧接着读不到配置去核对——**不是**失败，
 *   不能对用户说「没搬成」（那会把他推回去再配一遍）。
 */
export type CodexEnsureResult =
  | { ok: true; adopted: boolean; config: ProviderConfigSource }
  | { ok: false; reason: "adopt-failed" | "unverified"; detail: string };

const ADOPT_FAILED_DETAIL =
  "上一次已经试过接管这条地址、没搬成（原因在那一次的日志里）：Codex 会话仍会退回 ~/.codex/config.toml 里的地址。" +
  "在客户端页把地址重新填一次会再写一遍并核对；一直不行就核对 ~/.paseo/config.json";

/**
 * 「地址没能生效」对用户只有一句话说：三处调用（面板告警、建会话拦截、日志）共用这一句，
 * 免得同一个失败在三个地方三种措辞，改一处忘了另两处。
 *
 * `adopt-failed` 与 `unverified` 必须分开：后者是**已经写进去了**、只是读不回来核对，
 * 说成「没搬成」会把用户推回去再配一遍。
 */
export function describeCodexEnsureFailure(
  reason: "adopt-failed" | "unverified",
  detail: string,
  address?: string | null,
): string {
  if (reason === "unverified") return `Codex 接入地址刚写进去，但读不到宿主配置核对：${detail}——刷新一次再看`;
  const at = address ? `Codex 接入地址（${address}）` : "Codex 接入地址";
  return `${at}没能接到会话 provider 上：${detail}——新建的 Codex 会话会退回 ~/.codex/config.toml 里的地址`;
}

/**
 * 这一次运行里已经**确认搬不动**的地址：别在每次读状态时重写一遍配置。
 *
 * 用地址做键而不是布尔开关：用户换了一条新地址，值得再试一次；写盘抛错（daemon 正在
 * 重启之类）属于瞬时失败，不记在这里，下次读状态还能再试。用户在客户端页重新保存地址
 * 时会调 `forgetAdoptFailures` 把它忘掉——那是他刚改过配置，值得再试一次。
 */
const unadoptable = new Set<string>();

/** 让某个地址（不传则全部）重新获得一次接管机会。用户动手改过配置之后调。 */
export function forgetAdoptFailures(address?: string): void {
  if (address === undefined) unadoptable.clear();
  else unadoptable.delete(address.replace(/\/+$/, ""));
}

/** 仅供测试：清掉「这次运行试过了」的记忆。 */
export function resetAdoptAttemptsForTest(): void {
  forgetAdoptFailures();
}

/** 读一份 provider 配置；读失败与「读到但形状不对」必须分开，否则诊断会张冠李戴。 */
type ConfigRead = { ok: true; config: ProviderConfigSource } | { ok: false; detail: string };

async function readProviderConfig(paseo: PaseoApi): Promise<ConfigRead> {
  try {
    const result = await paseo.config.get();
    const config = result?.config;
    if (typeof config !== "object" || config === null) {
      return { ok: false, detail: "宿主返回的配置不是对象" };
    }
    return { ok: true, config: config as ProviderConfigSource };
  } catch (error) {
    return { ok: false, detail: sessionErrorDetail(error) };
  }
}

/**
 * 把「写在内建 `codex` 上、宿主根本不读」的接入地址搬到派生条目 `deck-codex`。
 *
 * 背景：Codex 适配器只把 `extends: "codex"` 的派生条目当成这次会话的 provider 配置，
 * 内建 `codex` 的 env 写了也没人看。旧版本插件（和早先的注入面板）正是写在内建条目上的，
 * 于是出现「卡片上地址填好了、Codex 会话却走 `~/.codex/config.toml`」——用户没有理由
 * 去理解这两层的区别，正确做法是插件自己把配置改成生效的形状，而不是让他再点一遍。
 *
 * 什么时候动手：内建 `codex` 上有地址，且 `deck-codex` 这条**根本不存在**。
 * 派生条目已经在了（停用、或没地址）就返回 `adopted: false`：那是用户明确留下的状态，
 * 翻过来会把他刚关掉的站点又打开。
 *
 * 写进去的东西照抄用户原来那份：整个 env（自定义键名也留着）、凭证补成适配器真读的
 * `OPENAI_API_KEY`、模型清单跟着搬——搬完就是「卡片上看到的 = 会话真正用的」。
 * 写完读回核对，对不上就报失败（不静默：那种情况下每条 Codex 会话都会退回旧地址）。
 */
export async function adoptLegacyCodexAddress(
  paseo: PaseoApi,
  providers: Record<string, ProviderConfigView>,
): Promise<CodexAdoptResult> {
  const baseUrl = legacyCodexAddressOf(providers);
  if (!baseUrl) return { ok: true, adopted: false };
  // 同一条地址**确定**搬不动时不再重试（读一次状态写一次盘、刷一行日志没有意义）；
  // 失败原因照样每次返回，调用方该告警还是告警。
  if (unadoptable.has(baseUrl)) return { ok: false, reason: "patch-failed", detail: ADOPT_FAILED_DETAIL };

  const legacyEnv = providers.codex?.env;
  try {
    const legacyTable =
      legacyEnv && typeof legacyEnv === "object" && !Array.isArray(legacyEnv)
        ? (legacyEnv as Record<string, unknown>)
        : {};
    // 派生条目的 env **只写适配器真读的两个键**：地址 + 凭证。
    // 早先整份照抄的后果就是卡片上多出 `SUB2API_API_KEY` 这种没人读的残渣（同一把钥匙的旧名字），
    // 用户只会问「我们插件为什么要留这个东西」。
    const env: Record<string, string> = { [CODEX_ADDRESS_KEY]: baseUrl };
    // 凭证可能挂在自定义键上（`SUB2API_API_KEY` 之类）：适配器只读 `OPENAI_API_KEY`，
    // 挑一把值抄到这个键上，源键留在原处（那是用户的配置，不替他在别处删）。
    const credential = legacyCredentialOf(legacyTable as Record<string, string>);
    if (credential) env[CODEX_CREDENTIAL_KEY] = credential;

    const models = modelObjectsOf(providers.codex?.models);
    const additionalModels = modelObjectsOf(providers.codex?.additionalModels);
    // 内建 `codex` 上那条地址搬走之后顺手清掉：留着它就是这段历史的病根——派生条目哪天被停用，
    // 它又会变成「卡片说有地址、宿主不读、建会话被拦」的那个状态。
    // 注意：宿主对 `agents.providers.<id>` 的补丁是否深合并、能不能删掉已写的键，实证不足
    // （见 PROGRESS.md 里两条相反的记录），所以这一步是「能删就删，删不掉也不影响派生条目干活」，
    // 别在文档里承诺已经删掉。**除地址外的键一律原样带回去**（含非字符串值）：万一宿主是整块
    // 替换，丢掉它们就是替用户删配置。
    const leftover: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(legacyTable)) {
      if (key !== CODEX_ADDRESS_KEY) leftover[key] = value;
    }
    await paseo.config.patch({
      providers: {
        [CODEX_SITE_PROVIDER]: {
          extends: "codex",
          label: CODEX_SITE_LABEL,
          enabled: true,
          ...(models ? { models } : {}),
          ...(additionalModels ? { additionalModels } : {}),
          env,
        },
        codex: { env: leftover },
      },
    });
  } catch (error) {
    // 瞬时失败（daemon 正在重启之类）不进「试过了」名单：下次读状态还能再试一次。
    return { ok: false, reason: "patch-failed", detail: sessionErrorDetail(error) };
  }

  // 写完读回：宿主不认派生 provider 时会悄悄收下这份配置，之后每条 Codex 会话都退回旧地址。
  // 这种情况必须在这里说清楚，不能靠用户下次建会话时才发现。
  const read = await readProviderConfig(paseo);
  if (!read.ok) {
    // 读不回来 ≠ 没写进去：那是另一种原因，别报「宿主不收派生 provider」，也别把它记成确定失败。
    return {
      ok: false,
      reason: "unverified",
      detail: `地址已经写进 ${CODEX_SITE_PROVIDER}，但紧接着读不到宿主配置核对（${read.detail}）`,
    };
  }
  const live = providersRawOf(read.config)[CODEX_SITE_PROVIDER];
  if (!codexSiteUsable(live) || (live?.env?.[CODEX_ADDRESS_KEY] ?? "").trim() !== baseUrl) {
    unadoptable.add(baseUrl);
    return {
      ok: false,
      reason: "patch-failed",
      detail: `写入 ${CODEX_SITE_PROVIDER} 后读回的不是可用形状（extends=${String(live?.extends ?? "未写入")}）：宿主可能不接受派生 Codex provider，请核对 ~/.paseo/config.json`,
    };
  }
  record("info", SCOPE, `已把内建 codex 上的接入地址搬到 ${CODEX_SITE_PROVIDER}：Codex 只认派生条目，之后新建的 Codex 会话走这条地址`);
  return { ok: true, adopted: true, config: read.config };
}

/** 清理结果：清掉了哪几个键（键名，值不回）；没清也没关系，这是装饰性动作。 */
export type CodexPruneResult =
  | { ok: true; pruned: string[]; config?: ProviderConfigSource }
  | { ok: false; detail: string };

/**
 * 把派生条目 env 里「同一把钥匙的另一个名字」删掉。
 *
 * 背景：早先插件整份照抄旧配置，于是 `deck-codex.env` 里同时有 `OPENAI_API_KEY`（适配器真读的）
 * 和 `SUB2API_API_KEY`（没人读的旧名字），卡片上就多出一行让人莫名其妙的东西。
 * 现在造条目时只写生效的两个键，这里负责把**已经写下的**残渣收掉。
 *
 * 只删「名字像凭据、值又和 `OPENAI_API_KEY` 一模一样」的键——值不同就是另一套凭证，一个字不动；
 * 条目不可用（停用 / 没地址）时也不动，那是用户明确留下的状态。
 *
 * 实现上不能直接 `env: { SUB2API_API_KEY: undefined }`：宿主对 provider 的补丁是深合并，删不掉键。
 * 唯一能真删的口径是 `removeProviders` 整条摘掉——宿主**先处理移除、再合并同一补丁里的新条目**，
 * 所以一个补丁里「摘掉 + 写回干净形状」不会留下空窗。
 */
export async function pruneRedundantCodexEnv(
  paseo: PaseoApi,
  providers: Record<string, ProviderConfigView>,
): Promise<CodexPruneResult> {
  const entry = providers[CODEX_SITE_PROVIDER];
  if (!codexSiteUsable(entry)) return { ok: true, pruned: [] };
  const env = entry?.env as Record<string, unknown> | undefined;
  const redundant = redundantCredentialKeysOf(env);
  if (!redundant.length) return { ok: true, pruned: [] };

  const cleaned: Record<string, string> = {};
  for (const key of CODEX_EFFECTIVE_ENV_KEYS) {
    const value = entry?.env?.[key];
    if (typeof value === "string" && value.trim()) cleaned[key] = value.trim();
  }
  // 宿主的类型要求模型是对象（`{ id, label }`），手改过的 config.json 里可能是字符串：写回前归一。
  const models = modelObjectsOf(entry?.models);
  const additionalModels = modelObjectsOf(entry?.additionalModels);
  // 除了模型清单之外，条目上别的字段（`options`、`command` 用户自己加的）原样带回去。
  const rest = Object.fromEntries(
    Object.entries(entry ?? {}).filter(([key]) => key !== "models" && key !== "additionalModels"),
  );
  const nextEntry = {
    ...rest,
    env: cleaned,
    ...(models ? { models } : {}),
    ...(additionalModels ? { additionalModels } : {}),
  };
  try {
    await paseo.config.patch({
      removeProviders: [CODEX_SITE_PROVIDER],
      providers: { [CODEX_SITE_PROVIDER]: nextEntry },
    });
  } catch (error) {
    return { ok: false, detail: sessionErrorDetail(error) };
  }
  const read = await readProviderConfig(paseo);
  if (!read.ok) return { ok: false, detail: `清完读不到配置核对：${read.detail}` };
  const live = providersRawOf(read.config)[CODEX_SITE_PROVIDER];
  if (!codexSiteUsable(live) || redundantCredentialKeysOf(live?.env as Record<string, unknown> | undefined).length) {
    return { ok: false, detail: `删掉重复的 ${redundant.join("、")} 之后读回不对，先核对 ~/.paseo/config.json` };
  }
  record(
    "info",
    SCOPE,
    `已从 ${CODEX_SITE_PROVIDER} 的 env 里删掉重复的凭据键 ${redundant.join("、")}：适配器只读 OPENAI_API_KEY，这些名字写了也没人读`,
  );
  return { ok: true, pruned: redundant, config: read.config };
}

/**
 * 这一次运行里已经**确认补不进去**的清单：键是清单签名（模型 id 用 `\u0000` 连起来），值是那次的原因。
 *
 * 没有它，宿主不收内建条目的补丁时，每读一次客户端页就写一次盘、再报一遍同一句——
 * 用户开几张卡片就是几次无用的写。用户在客户端页重新保存模型时调 `forgetMirrorFailures`
 * 清空再试：那是他刚改过配置，值得重来一次。
 *
 * 只记「写进去了、读回来还是缺」这一种（宿主拒收）。写盘抛错、读不回来都是瞬时故障，
 * 记下来就等于把一次 daemon 重启变成整段运行里永远不同步。
 */
const mirrorFailures = new Map<string, string>();

/** 让所有清单重新获得一次对齐机会。用户动手改模型之后调。 */
export function forgetMirrorFailures(): void {
  mirrorFailures.clear();
}

/** 仅供测试：清掉「这次运行补不进去」的记忆。 */
export function resetMirrorFailuresForTest(): void {
  forgetMirrorFailures();
}

/** 模型清单对齐结果：对齐了 / 本来就一致 / 没对齐（只影响别的窗口看到什么，不影响会话）。 */
export type CodexModelMirrorResult =
  | { ok: true; mirrored: false }
  | { ok: true; mirrored: true; config: ProviderConfigSource }
  | { ok: false; detail: string };

/**
 * 把派生条目那份模型清单照写到内建 `codex` 上。
 *
 * 宿主的模型选择器是**按 provider 条目各显示一份**的：卡片上那行「Codex」读内建条目，
 * 注入真正生效的派生条目 `deck-codex` 是另一行。只写一份的后果就是
 * 「这个窗口看得到那个模型、换个项目的新窗口就没了」——用户没理由理解这两层的区别，
 * 他只知道「我配了两个模型」。所以这里把派生条目有、内建条目缺的模型补上去。
 *
 * 两条边界：
 * - **只补不删**（`withMissingModels`）：用户可能在 Paseo 自己的设置里给内建那一行加过模型，
 *   读一次面板就把它们抹掉，是替人做决定；而少一个模型正是用户报的那个现象。
 * - 只对齐**可用**的派生条目：停用或没地址时，模型清单本来就该回落到内建条目，
 *   那是用户明确留下的状态，翻过来会把他刚关掉的站点又打开。
 */
export async function mirrorCodexSiteModels(
  paseo: PaseoApi,
  config: ProviderConfigSource,
): Promise<CodexModelMirrorResult> {
  const providers = providersRawOf(config);
  const derived = providers[CODEX_SITE_PROVIDER];
  if (!codexSiteUsable(derived)) return { ok: true, mirrored: false };
  const wanted = modelObjectsOf(derived?.[modelListKeyOf(derived)]);
  if (!wanted?.length) return { ok: true, mirrored: false };
  const codexKey = modelListKeyOf(providers.codex);
  const before = modelObjectsOf(providers.codex?.[codexKey]) ?? [];
  const next = withMissingModels(providers.codex?.[codexKey], wanted);
  if (next.length === before.length) return { ok: true, mirrored: false };

  const signature = wanted.map((item) => item.id).join("\u0000");
  const remembered = mirrorFailures.get(signature);
  if (remembered) return { ok: false, detail: remembered };

  try {
    await paseo.config.patch({ providers: { codex: { [codexKey]: next } } });
  } catch (error) {
    // 写盘抛错是**瞬时**失败（daemon 正在重启之类）：不记进 `mirrorFailures`，
    // 下次读客户端页还能再试一次。记住了就会把一次重启变成「本次运行内永远不同步」。
    return { ok: false, detail: sessionErrorDetail(error) };
  }
  const read = await readProviderConfig(paseo);
  if (!read.ok) {
    // 同上：读不回来 ≠ 宿主拒收，别把它记成确定失败。
    return { ok: false, detail: `补齐后读不到宿主配置核对（${read.detail}）` };
  }
  const live = providersRawOf(read.config);
  // 两把键都算「补齐了」：宿主若把这次补丁落到另一把键上，模型照样在清单里，
  // 没有理由报「没补进去」把人赶去手改 config.json。
  const liveIds = new Set([
    ...configuredModelIds(live.codex, "models"),
    ...configuredModelIds(live.codex, "additionalModels"),
  ]);
  const missing = wanted.map((item) => item.id).filter((id) => !liveIds.has(id));
  if (missing.length) {
    const detail = `模型 ${missing.join("、")} 补到内建 codex 之后读回还缺，先核对 ~/.paseo/config.json`;
    mirrorFailures.set(signature, detail);
    return { ok: false, detail };
  }
  mirrorFailures.delete(signature);
  record(
    "info",
    SCOPE,
    `已把 ${CODEX_SITE_PROVIDER} 有、内建 codex 缺的 ${next.length - before.length} 个模型补上：模型选择器里「Codex」那一行不再是旧清单`,
  );
  return { ok: true, mirrored: true, config: read.config };
}

/**
 * 读配置 + 该接管就接管，一步到位：面板读状态与建会话钩子走的是同一段流程，
 * 两处各写一遍迟早分叉（一处重读成功、另一处静默用旧配置）。
 */
export async function ensureCodexAddressEffective(
  paseo: PaseoApi,
  config: ProviderConfigSource,
): Promise<CodexEnsureResult> {
  const adopted = await adoptLegacyCodexAddress(paseo, providersRawOf(config));
  if (!adopted.ok) {
    return adopted.reason === "unverified"
      ? { ok: false, reason: "unverified", detail: adopted.detail }
      : { ok: false, reason: "adopt-failed", detail: adopted.detail };
  }
  // 搬家的那一步已经读回核对过了，这份就是核对过的那份，不再多读一次。
  let current = adopted.adopted ? adopted.config : config;
  // 顺手收掉派生条目里纯重复的凭据键（早先整份照抄留下的残渣）。纯装饰性：失败只记日志，
  // 不挡读状态、也不挡建会话——为了一行没人读的配置把会话建不出来是荒唐的。
  const prune = await pruneRedundantCodexEnv(paseo, providersRawOf(current));
  if (!prune.ok) record("warn", SCOPE, `清理派生条目里重复的凭据键没成（不影响会话）：${prune.detail}`);
  else if (prune.config) current = prune.config;
  return { ok: true, adopted: adopted.adopted, config: current };
}
