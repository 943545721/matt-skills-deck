import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { daemonHome } from "./paths.ts";
import { invalidProviderJson, providerFileFailure } from "./provider-file-errors.ts";

/**
 * 用户整条删除过的 provider 条目（宿主级）。
 *
 * 为什么不用插件设置：服务端的 `registerSettings` 句柄只有 read / subscribe，
 * 没有写入口；设置写入是客户端 RPC 的事。这里用插件自己的状态文件，和
 * `config.json` 放在同一个 `<PASEO_HOME>` 下，只存条目 id，不存任何值。
 *
 * 存在理由：`codex` 上的模型是 `deck-codex` 的镜像；用户主动删掉 `codex` 后，
 * `mirrorCodexSiteModels` 下次读状态会把它写回来。没有这个墓碑，「整条删除」
 * 就只是一个会自我撤销的按钮。用户重新保存 Codex 配置或启用 Codex 站点后，
 * 只有读回确认写入与必要保留内容均已落地，才清掉墓碑、恢复自动维护。
 */

const STATE_FILE = "matt-skills-deck-state.json";
let overridePath: string | null = null;

/** 仅供测试：把状态文件指到临时目录；传 null 恢复默认。 */
export function setTombstoneStatePathForTest(target: string | null): void {
  overridePath = target;
}

function statePath(): string {
  return overridePath ?? path.join(daemonHome(), STATE_FILE);
}

export type TombstoneRead = { ok: true; ids: string[] } | { ok: false; detail: string };
export type TombstoneWrite = { ok: true } | { ok: false; detail: string };

function readIds(): TombstoneRead {
  const target = statePath();
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, ids: [] };
    return { ok: false, detail: providerFileFailure("读取删除记录", target, error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, detail: invalidProviderJson(target) };
  }
  return parseIds(parsed, target);
}

function parseIds(parsed: unknown, target: string): TombstoneRead {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: `${target} 不是对象` };
  }
  const state = parsed as { version?: unknown; deletedProviderEntries?: unknown };
  if (state.version !== 1 || !Array.isArray(state.deletedProviderEntries)) {
    return { ok: false, detail: `${target} 的版本或 deletedProviderEntries 形状无效` };
  }
  const invalid = state.deletedProviderEntries.some(
    (id) => typeof id !== "string" || id.length === 0 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id),
  );
  if (invalid) return { ok: false, detail: `${target} 的 deletedProviderEntries 含无效条目 id` };
  return { ok: true, ids: [...new Set(state.deletedProviderEntries as string[])] };
}

function removeTemp(temp: string): TombstoneWrite {
  try {
    rmSync(temp, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: providerFileFailure("清理临时删除记录", temp, error) };
  }
}

function writeIds(ids: string[]): TombstoneWrite {
  const target = statePath();
  const text = `${JSON.stringify({ version: 1, deletedProviderEntries: [...new Set(ids)] }, null, 2)}\n`;
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
    return { ok: true };
  } catch (error) {
    const detail = providerFileFailure("写入删除记录", target, error);
    const cleaned = removeTemp(temp);
    return { ok: false, detail: cleaned.ok ? detail : `${detail}；${cleaned.detail}` };
  }
}

export function deletedProviderEntries(): TombstoneRead {
  return readIds();
}

export function markProviderEntryDeleted(id: string): TombstoneWrite {
  const current = readIds();
  if (!current.ok) return current;
  if (current.ids.includes(id)) return { ok: true };
  return writeIds([...current.ids, id]);
}

export function clearProviderEntryDeleted(id: string): TombstoneWrite {
  const current = readIds();
  if (!current.ok) return current;
  if (!current.ids.includes(id)) return { ok: true };
  return writeIds(current.ids.filter((entry) => entry !== id));
}
