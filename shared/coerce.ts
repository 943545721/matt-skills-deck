/**
 * 从「手改的 JSON / RPC 传来的 unknown」里捡字段用的四个小函数。
 *
 * 设置归一化路径反复要用它们（`orchestration.ts`、`staff.ts` 都读配置文件），
 * 各自抄一份就是三份会各自漂移的口径——所以收在这里一份。
 *
 * 这里只做「收拾」，不做「拒收」：配置文件的归一化不该让一份手改坏的文件整份失效。
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function optionalText(value: unknown): string | undefined {
  const t = text(value);
  return t ? t : undefined;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
