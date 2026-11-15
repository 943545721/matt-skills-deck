import { readFileSync } from "node:fs";
import type { RpcOutput } from "@getpaseo/plugin";
import type { z } from "zod";
import {
  orchestrationProviderSourceRpc,
  providerSourceEntrySchema,
  providerSourceEnvRowSchema,
} from "../shared/orchestration-rpc.ts";
import {
  baseUrlOf,
  configuredModelIds,
  envDisplayOf,
  modelListKeyOf,
  providerBaseUrlKey,
} from "../shared/provider-models.ts";
import { daemonConfigPath } from "./daemon-profiles.ts";
import { invalidProviderJson, providerFileFailure } from "./provider-file-errors.ts";
import {
  isRemovableProviderEntry,
  providerEntryOf,
  providersRawOf,
  type ProviderConfigSource,
  type ProviderConfigView,
} from "./provider-entry.ts";

/**
 * 注入源文件的只读视图。
 *
 * 宿主把 `agents.providers.<client>` 落在 `~/.paseo/config.json`；插件写进去的
 * 地址、凭据和其它 env 键都在这里。卡片上的「N 个密钥」统计的是**生效条目**的
 * 全部 env 键，所以地址 + 凭据就是 2 条——这个视图把源文件路径与每条 provider
 * 的键名摊开，用户能自己核对，而不是只看到一个计数。
 *
 * 硬约定：原始密钥不返回。凭据只给掩码；地址与模型名不是机密，按界面现有口径
 * 原样显示。顶层字段只给键名，值一律不带（可能是用户手写的未知配置）。
 */

/** 输出形状由共享 RPC 契约派生，服务端不另抄一份。 */
export type ProviderSourceEnvRow = z.infer<typeof providerSourceEnvRowSchema>;

export type ProviderSourceEntry = z.infer<typeof providerSourceEntrySchema>;

export type ProviderSourceRead = RpcOutput<typeof orchestrationProviderSourceRpc>;

const URL_WITH_USERINFO = /^https?:\/\/[^/]*@/i;
const CREDENTIAL_QUERY_KEY = /^(api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passwd|pwd|key)$/i;

/** 地址里自带凭据：userinfo（`user:pass@`）或凭据类查询参数。这种整条都要掩码。 */
function urlCarriesCredential(text: string): boolean {
  if (URL_WITH_USERINFO.test(text)) return true;
  try {
    for (const key of new URL(text).searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEY.test(key)) return true;
    }
  } catch {
    // 不是可解析的绝对 URL：它也不会成为主地址，按普通值走掩码。
  }
  return false;
}

/**
 * 这个客户端真正在读的主地址键。
 *
 * 不能拿 env 里第一个 `*_BASE_URL`：Claude 还认 `ANTHROPIC_BEDROCK_BASE_URL` 等，
 * 备用键排在前面时会把带凭据的备用地址当成主地址明文返回。先按客户端主键取，
 * 主键没写有效地址时才退回第一个像地址的键——与取模型清单的判定同源。
 */
function primaryBaseUrlKeyOf(provider: string, env: Record<string, string>): string | null {
  const preferred = providerBaseUrlKey(provider);
  if (preferred && /^https?:\/\//i.test((env[preferred] ?? "").trim())) return preferred;
  return baseUrlOf(env)?.key ?? null;
}

/** 生效条目的一份 env 视图：主地址与已配置的模型名原样，其余走掩码。 */
function envRowsOf(entry: ProviderConfigView, provider: string): ProviderSourceEnvRow[] {
  const models = configuredModelIds(entry, modelListKeyOf(entry));
  const raw = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? entry.env : {};
  const textEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") textEnv[key] = value;
  }
  // 只放行卡片认定的那一个主地址；别的 *_BASE_URL 一律走掩码，避免把
  // 用户塞在备用地址里的凭据（`http://user:pass@host` 或 `?api_key=`）明文带到界面。
  const primaryKey = primaryBaseUrlKeyOf(provider, textEnv);
  return Object.entries(raw)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : "";
      const trimmed = text.trim();
      if (primaryKey === key && !urlCarriesCredential(trimmed)) {
        return { key, display: trimmed.replace(/\/+$/, ""), masked: false };
      }
      // 模型名不是机密：只放行「键名像模型 + 值就在这个客户端的模型清单里」。
      // 不按任意 *_MODEL 放行，避免把伪装成模型名的 token 印出来。
      if (/_MODEL$/i.test(key) && trimmed && models.includes(trimmed)) {
        return { key, display: trimmed, masked: false };
      }
      const shown = envDisplayOf(key, text, models);
      return { key, display: shown.display, masked: shown.masked };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function sourceEntryOf(
  id: string,
  raw: ProviderConfigView | undefined,
  effective: boolean,
  provider: string,
): ProviderSourceEntry {
  const validShape = Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
  const entry: ProviderConfigView = validShape ? raw as ProviderConfigView : {};
  const models = configuredModelIds(entry, modelListKeyOf(entry));
  const env = envRowsOf(entry, provider);
  return {
    id,
    effective,
    extends: typeof entry.extends === "string" && entry.extends.trim() ? entry.extends.trim() : null,
    enabled: entry.enabled !== false,
    models,
    // 非对象条目（手改成 `null` / 字符串）清理侧会报 not-found，这里不能标成可清空条目。
    removable: validShape && isRemovableProviderEntry(entry),
    fields: Object.keys(entry).sort(),
    env,
  };
}

/**
 * 读宿主配置里的 provider 源。
 *
 * `homeDir` 显式传入是为了测试能用临时目录，不去碰真实的 `~/.paseo`。
 */
export function readProviderSource(provider: string, homeDir?: string): ProviderSourceRead {
  const configPath = daemonConfigPath(homeDir);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "config-missing", detail: `找不到 ${configPath}` };
    }
    return {
      ok: false,
      reason: "read-failed",
      detail: providerFileFailure("读取", configPath, error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: "config-invalid",
      detail: invalidProviderJson(configPath),
    };
  }

  const providers = providersRawOf(parsed as ProviderConfigSource);
  const ids = Object.keys(providers).filter(
    (id) => id === provider || providers[id]?.extends === provider,
  );
  if (!ids.length) {
    return {
      ok: false,
      reason: "not-found",
      detail: `配置里没有 ${provider}，也没有 extends=${provider} 的派生条目`,
    };
  }

  const effective = providerEntryOf(providers, provider);
  const entries = ids
    .map((id) => sourceEntryOf(id, providers[id], providers[id] === effective, provider))
    .sort((left, right) => Number(right.effective) - Number(left.effective) || left.id.localeCompare(right.id));
  return { ok: true, provider, path: configPath, entries };
}
