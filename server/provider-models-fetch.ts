import type { PaseoApi } from "@getpaseo/client";
import { endpointAuthOf, modelListUrls, parseModelList } from "../shared/provider-models.ts";
import { readDaemonConfig } from "./orchestration.ts";
import { providerEntryOf, providersRawOf } from "./provider-entry.ts";
import { record } from "./logs.ts";

/**
 * 问接口要模型清单。
 *
 * 「哪些模型能跑」只有接口自己知道：客户端自带的型号是厂商目录，代理后面挂的
 * 是另一套名字。所以这里拿配置里**已经有的**那对（`*_BASE_URL` + `*_API_KEY` /
 * `*_AUTH_TOKEN`）拼一次 `GET {base}/v1/models`，把 id 取回来。
 *
 * 三条不做：
 * - 不把凭据回给客户端，也不写进日志（日志只有 provider、路径、条数）；
 * - 不猜没有的配置：没配 base url 或没配凭据，直接说缺哪个，不去试公开端点；
 * - 不把「200 但解析不出东西」当成成功。
 */

const SCOPE = "orchestration";
const MAX_MODELS = 500;
const TIMEOUT_MS = 10_000;

export type FetchModelsResult =
  | { ok: true; provider: string; endpoint: string; models: string[] }
  | {
      ok: false;
      reason:
        | "invalid"
        | "config-failed"
        | "no-endpoint"
        | "no-credential"
        | "unauthorized"
        | "http"
        | "network"
        | "bad-payload";
      detail: string;
    };

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** 回包可能把凭据回显出来：报错里出现的长串一律抹掉再给人看。 */
function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|gho|glpat|xox[abp])[-_][A-Za-z0-9_-]{6,}/gi, "••••")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ••••");
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return redact(flat.length > 240 ? `${flat.slice(0, 240)}…` : flat);
}

export async function fetchProviderModels(
  paseo: PaseoApi,
  input: { provider: string },
  deps: FetchDeps = {},
): Promise<FetchModelsResult> {
  const provider = (input.provider ?? "").trim();
  if (!provider) return { ok: false, reason: "invalid", detail: "要拉哪个客户端的模型？没给 provider" };

  const config = await readDaemonConfig(paseo);
  if (!config) {
    return {
      ok: false,
      reason: "config-failed",
      detail: "读不到 daemon 配置：模型清单要用这里面的 base url 与凭据，读不到就没法问",
    };
  }
  // Codex 启用过站点后地址与凭证在派生条目上：按面板上的 id 直接取会取到空条目。
  const configured = providerEntryOf(providersRawOf(config), provider);
  const env: Record<string, string> = {};
  const rawEnv = configured?.env;
  if (rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
    for (const [key, value] of Object.entries(rawEnv)) {
      if (typeof value === "string") env[key] = value;
    }
  }

  const auth = endpointAuthOf(env);
  if (!auth) {
    const hasUrl = Object.keys(env).some((key) => /BASE_URL$/i.test(key) && /^https?:\/\//i.test((env[key] ?? "").trim()));
    const hasKey = Object.keys(env).some((key) => /(_AUTH_TOKEN|_API_KEY|_TOKEN)$/i.test(key) && (env[key] ?? "").trim());
    if (!hasUrl) {
      return {
        ok: false,
        reason: "no-endpoint",
        detail: `这个客户端还没有 base url：先注入一个 \`*_BASE_URL\`（例如 ANTHROPIC_BASE_URL），再点获取模型`,
      };
    }
    return {
      ok: false,
      reason: "no-credential",
      detail: hasKey
        ? "有 base url，但没找到可用的凭据键（`*_AUTH_TOKEN` / `*_API_KEY` / `*_TOKEN`）"
        : "这个客户端只配了 base url，没有凭据：接口不会把模型清单给没登录的人",
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const tried: string[] = [];

  for (const url of modelListUrls(auth.baseUrl)) {
    tried.push(url);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", ...auth.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record("warn", SCOPE, `拉模型清单失败（网络）：${provider} → ${url}`);
      return { ok: false, reason: "network", detail: `连不上 ${url}：${redact(detail)}` };
    }

    if (response.status === 401 || response.status === 403) {
      record("warn", SCOPE, `拉模型清单失败（鉴权）：${provider} → ${url} → ${response.status}`);
      return {
        ok: false,
        reason: "unauthorized",
        detail: `接口拒绝了 ${auth.credentialKey}（HTTP ${response.status}）：检查这个 key 是否还有效、有没有模型列表权限`,
      };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 404 常见于 base url 少写 / 多写了 /v1，继续试下一个候选路径。
      if (response.status === 404) continue;
      record("warn", SCOPE, `拉模型清单失败（HTTP ${response.status}）：${provider} → ${url}`);
      return {
        ok: false,
        reason: "http",
        detail: `接口返回 HTTP ${response.status}${body ? `：${snippet(body)}` : ""}`,
      };
    }

    const payload: unknown = await response.json().catch(() => null);
    const models = parseModelList(payload).slice(0, MAX_MODELS);
    if (models.length === 0) {
      return {
        ok: false,
        reason: "bad-payload",
        detail: `接口在 ${url} 回了 200，但没解析出模型（这家的回包格式可能不是 \`data[].id\`）`,
      };
    }
    record("info", SCOPE, `拉到 ${provider} 的模型清单：${models.length} 个（${url}，凭据不进日志）`);
    return { ok: true, provider, endpoint: url, models };
  }

  return {
    ok: false,
    reason: "http",
    detail: `这几个路径都没给出模型清单：${tried.join("、")}（都返回 404，检查 base url 是不是少了或多了 /v1）`,
  };
}
