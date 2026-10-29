/**
 * 幂等锚（照抄 DSH `src/deck/rules/anchor.ts`）。
 *
 * 同一个会话 + 同一个标题 + 同一批标签，在同一个 5 分钟窗口里得到同一个锚；
 * 契约层拿这个锚回查，重复提交就复用同一张票 —— 重试不会多建一张。
 * 纯函数：时刻必须由调用方传进来，本文件不读钟。
 */

/** 幂等窗口长度：5 分钟。 */
export const ANCHOR_WINDOW_MS = 5 * 60 * 1000;

/** 窗口序号：把时刻切成一个个窗口，同一窗口里的所有时刻得到同一个序号。 */
export function anchorBucket(now: number, windowMs: number = ANCHOR_WINDOW_MS): number {
  return Math.floor(now / windowMs);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 把各种形态的标签清单归一成去空后的名字数组（顺序保留，不重排）。 */
function labelNames(list: unknown): string[] {
  const values = Array.isArray(list) ? list : [];
  return values
    .map((entry) => (typeof entry === "string" ? entry : (entry as { name?: unknown } | null)?.name ?? ""))
    .map((name) => String(name).trim())
    .filter(Boolean);
}

export interface AnchorParts {
  tool: unknown;
  /** 会话标识；缺席时退到工作区标识。 */
  sessionId?: unknown;
  workspaceKey?: unknown;
  title: unknown;
  labels?: unknown;
  /** 调用时刻，Unix 毫秒。必须由宿主侧读出来传进来。 */
  now: number;
  windowMs?: number;
}

/**
 * 幂等锚：`工具名|会话（没有就说工作区）|标题|标签（逗号相连）|窗口序号` 的 djb2 哈希。
 * 标签按调用方给的先后顺序拼，不重排：重排会让「本来同一个锚」变成两个锚、去重失效。
 */
export function anchorKeyFor(parts: AnchorParts): string {
  const windowMs = typeof parts.windowMs === "number" && parts.windowMs > 0 ? parts.windowMs : ANCHOR_WINDOW_MS;
  const bucket = anchorBucket(parts.now, windowMs);
  const labels = labelNames(parts.labels);
  const raw = [
    text(parts.tool),
    text(parts.sessionId) || text(parts.workspaceKey),
    text(parts.title),
    labels.join(","),
    String(bucket),
  ].join("|");
  let hash = 5381;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) + hash + raw.charCodeAt(index)) >>> 0;
  }
  return "deck-" + ("0000000" + hash.toString(16)).slice(-8) + "-" + bucket;
}
