import { getSettings } from "./settings.ts";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
}

/**
 * 进程内的环形日志。
 *
 * 为什么自己留一份而不是只打 stdout：用户报「刚才点提交没反应」时，
 * 面板里能翻到最近发生了什么，比让他去翻 daemon 日志现实得多。
 * 只放最近 200 条、不落盘、不记入参原文（避免把 token 或私密正文写进去）。
 */
const MAX_ENTRIES = 200;
const entries: LogEntry[] = [];

export function record(level: LogLevel, scope: string, message: string): void {
  // 设置里关掉调试日志后就不再累积；已有条目保留，用户仍可导出后清空。
  if (!getSettings().debugLogging) return;
  entries.push({ at: new Date().toISOString(), level, scope, message });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function listLogs(limit = MAX_ENTRIES): LogEntry[] {
  return entries.slice(-Math.min(Math.max(limit, 1), MAX_ENTRIES)).reverse();
}

/** 清空缓冲：用户点「清空日志」时调用，也是测试的重置入口。 */
export function resetLogs(): void {
  entries.length = 0;
}
