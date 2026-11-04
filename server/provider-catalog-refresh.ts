import type { PaseoApi } from "@getpaseo/client";
import {
  PROVIDER_MODEL_ID_MAX,
  PROVIDER_MODELS_MAX,
  type ProviderModelList,
} from "../shared/orchestration-rpc.ts";
import { record } from "./logs.ts";
import type { DaemonConfigView } from "./orchestration.ts";
import { providerEntryOf, providersRawOf } from "./provider-entry.ts";
import { isListedClient } from "../shared/orchestration.ts";
import { modelIdsOf, type ProviderSnapshotEntry } from "./provider-snapshot-view.ts";
import { sessionErrorDetail } from "./session.ts";

/**
 * 让宿主重读某个工作区的 provider 快照。
 *
 * 宿主把「这个工作区能用哪些客户端、各有哪几个模型」缓存在快照里。改完注入的
 * 接入地址或模型清单后，缓存不会自己失效：宿主的模型选择器还列着旧接口的型号。
 * 这里发一次 `providers.refresh({ cwd })`，再回读快照，把刷新后的模型 id 交回界面。
 *
 * 四条边界：
 * - 只刷新传入的那个工作区，不碰别的缓存；
 * - 宿主没有确认刷新时不算成功，不能拿旧快照报「已刷新」；
 * - 刷新与回读分开报错：一个失败不代表另一个失败，用户下一步动作也不同；
 * - 某个客户端的目录读取失败时带一条警告，不把它显示成「0 个模型」了事。
 * 不重启进程、不改配置、不动已经在跑的会话——它们启动时的 env 不会因为刷新而改变。
 */

const SCOPE = "orchestration";

export type RefreshCatalogResult =
  | {
      ok: true;
      workspaceDir: string;
      providers: ProviderModelList[];
      warnings: string[];
    }
  | {
      ok: false;
      reason: "invalid" | "refresh-failed" | "snapshot-failed";
      detail: string;
    };

/** 快照状态 → 一句人话；`ready` 与缺省状态不算问题。 */
function statusProblem(status: string | undefined): string | null {
  switch (status) {
    case undefined:
    case "ready":
      return null;
    case "loading":
      return "仍在加载";
    case "error":
      return "模型目录读取失败";
    case "unavailable":
      return "当前不可用";
    default:
      return `状态 ${status}`;
  }
}

/**
 * 一个客户端的模型 id：截到契约上限，去重。
 *
 * 截断必须发生在服务端——`output.parseAsync` 会拒收超长 id，一次成功的刷新
 * 会被报成失败。截短后可能出现重复，去重时顺手丢掉。
 */
function cappedModelIds(entry: ProviderSnapshotEntry): { models: string[]; warnings: string[] } {
  const all = modelIdsOf(entry);
  const capped = all.slice(0, PROVIDER_MODELS_MAX);
  const overlong = capped.some((model) => model.length > PROVIDER_MODEL_ID_MAX);
  const models = Array.from(new Set(capped.map((model) => model.slice(0, PROVIDER_MODEL_ID_MAX))));
  const id = (entry.provider ?? "").trim();
  const warnings: string[] = [];
  if (all.length > capped.length) {
    warnings.push(`${id}：模型超过 ${PROVIDER_MODELS_MAX} 个，只列前 ${PROVIDER_MODELS_MAX} 个`);
  }
  if (overlong) warnings.push(`${id}：模型 id 超过 ${PROVIDER_MODEL_ID_MAX} 字符，已截短`);
  return { models, warnings };
}

export async function refreshProviderCatalog(
  paseo: PaseoApi,
  input: { workspaceDir: string; config?: DaemonConfigView | null },
): Promise<RefreshCatalogResult> {
  const workspaceDir = (input.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    return { ok: false, reason: "invalid", detail: "需要工作区目录：宿主的快照是按工作区落的，不知道是哪个就没法刷新" };
  }

  try {
    const refreshed = await paseo.providers.refresh({ cwd: workspaceDir });
    // 缺字段也当没确认：协议里它是必填的，拿不到确认就不能说清单已经是新的。
    if (refreshed?.acknowledged !== true) {
      return {
        ok: false,
        reason: "refresh-failed",
        detail: "宿主没有确认这次刷新：模型清单可能还是旧的，稍后再点一次",
      };
    }
  } catch (error) {
    record("warn", SCOPE, `刷新 provider 快照失败：${workspaceDir}`);
    return { ok: false, reason: "refresh-failed", detail: sessionErrorDetail(error) };
  }

  let entries: ProviderSnapshotEntry[];
  try {
    const snapshot = await paseo.providers.snapshot({ cwd: workspaceDir });
    entries = (snapshot?.entries ?? []) as ProviderSnapshotEntry[];
  } catch (error) {
    record("warn", SCOPE, `刷新后回读 provider 快照失败：${workspaceDir}`);
    return { ok: false, reason: "snapshot-failed", detail: sessionErrorDetail(error) };
  }

  // 与状态页同一套 enabled 计算：宿主条目自身停用，或配置里停用，都不在选择器里。
  const configured = providersRawOf(input.config ?? null);
  const providers: ProviderModelList[] = [];
  const warnings: string[] = [];
  /** 没进选择器的条目（不支持的客户端、派生 provider）：只记日志，不进界面（口径写在客户端页说明行里）。 */
  const skipped: string[] = [];
  for (const entry of entries) {
    const id = (entry.provider ?? "").trim();
    if (!id) continue;
    // 与客户端列表同一个判断：插件不支持的家、以及 Codex 站点的派生 provider
    // （模型已并到 `codex` 那一行）都不在选择器里单列，否则会冒出一个配了也不生效的客户端。
    if (!isListedClient(id)) {
      skipped.push(id);
      continue;
    }
    // Codex 启用过站点时「停用」写在派生条目上，这里要和状态页同一口径。
    if (entry.enabled === false || providerEntryOf(configured, id)?.enabled === false) continue;
    const problem = statusProblem(entry.status);
    if (problem) {
      const error = (entry.error ?? "").trim();
      warnings.push(`${id}：${problem}${error ? `（${error}）` : ""}`);
    }
    const capped = cappedModelIds(entry);
    if (!problem && capped.models.length === 0) {
      warnings.push(`${id}：快照里一个模型也没有，选择器里会是空的`);
    }
    warnings.push(...capped.warnings);
    providers.push({ id, models: capped.models });
  }

  record(
    "info",
    SCOPE,
    `刷新 provider 快照：${workspaceDir} → ${providers.length} 个客户端${skipped.length ? `（另有 ${skipped.length} 条未列：${skipped.join("、")}）` : ""}`,
  );
  return { ok: true, workspaceDir, providers, warnings };
}
