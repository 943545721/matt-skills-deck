/**
 * gh 失败判档表（从 DSH src/tracker/rooms/github/errors.ts 移植）。
 *
 * 判档只看三样：退出码、stderr、上游原话；**绝不看 argv**——命令行里可能带着用户写的
 * 评论正文或正文片段，拿它做关键词匹配会把「正文里写了 gh auth login」的超时误判成未登录。
 * 规则顺序就是优先级：先判退出码 4（gh 的认证约定），再判本地找不到 gh，
 * 再判 GraphQL 的 AddLabelsToLabelable 权限错，最后才落到文本规则。
 */
export type GhErrorKind =
  | "env"
  | "auth"
  | "network"
  | "ratelimit"
  | "notfound"
  | "parse"
  | "unsupported"
  | "conflict";

export interface GhError {
  kind: GhErrorKind;
  message: string;
  /** 上游原文（已截断）：给人看，也给日志；不含 argv。 */
  raw: string;
  exitCode: number | null;
  stderr: string;
}

export interface GhFailureInput {
  exitCode?: number | null;
  stderr?: string;
  stdout?: string;
  message?: string;
  killed?: boolean;
  signal?: string | null;
}

export interface GhVerdict {
  kind: GhErrorKind;
  text: string;
  /** 是否被某条规则明确认出：没认出时话术要带上「未识别」提示，不能假装知道原因。 */
  recognized: boolean;
}

const RULES: ReadonlyArray<{ kind: GhErrorKind; test: RegExp }> = [
  // 退出码 4 单独在下面判：gh 用它表示「需要认证」。
  { kind: "env", test: /gh not found|platform\.resolveexecutable|which:.*gh|not found.*gh/i },
  { kind: "auth", test: /addlabelstolabelable|HTTP 40[13]|bad credentials|forbidden/i },
  { kind: "notfound", test: /could not resolve to a repositor|no such issue|issue not found|HTTP 404/i },
  { kind: "parse", test: /HTTP 422|validation failed/i },
  { kind: "unsupported", test: /excessive[ _]?pagination|exceeds the [`'"]?first[`'"]? limit/i },
  { kind: "ratelimit", test: /rate limit|ratelimit|secondary rate|abuse detection/i },
  { kind: "conflict", test: /HTTP 409|already been taken|already exists|duplicate|cycle|circular/i },
];

export const HINT_ENV = "没有找到可用的 gh 命令：装好后执行 gh auth login，再重试。";
export const HINT_AUTH = "请先在终端执行 gh auth login，确认当前账号能访问这个仓库。";
export const HINT_UNSUPPORTED = "当前 gh 版本或这个仓库不支持该操作（可能是 GHES 老版本）。";
export const HINT_UNRECOGNIZED = "未识别的 gh 失败：下面是 gh 的原话，没有被归类。";

function textOf(input: GhFailureInput): string {
  const stderr = typeof input.stderr === "string" ? input.stderr.trim() : "";
  const stdout = typeof input.stdout === "string" ? input.stdout.trim() : "";
  // 刻意不读 `message`：Node 的 execFile 错误消息是「Command failed: gh <完整 argv>」，
  // 正文里写了什么（比如评论里出现 gh auth login）不该改变判档，argv 也不该进日志。
  return [stderr, stdout].filter(Boolean).join("\n").slice(0, 4_000);
}

/** 判出八档之一。退出码 4 优先于全部文本规则；stderr 为空且退出码 -1 视为「命令根本没起来」。 */
export function ghVerdictOf(input: GhFailureInput): GhVerdict {
  const text = textOf(input);
  const exitCode = typeof input.exitCode === "number" ? input.exitCode : null;
  if (exitCode === 4) return { kind: "auth", text, recognized: true };
  if ((exitCode === -1 || exitCode === null) && !text && (input.killed || input.signal)) {
    return { kind: "network", text: "gh 命令被终止，没有返回任何输出", recognized: false };
  }
  for (const rule of RULES) {
    if (rule.test.test(text)) return { kind: rule.kind, text, recognized: true };
  }
  if (exitCode === -1 && !text) return { kind: "env", text: "gh 命令没有起来", recognized: true };
  return { kind: "network", text, recognized: false };
}

/** 失败话术：调用点自己那句话在前，提示语在后；未识别时把 gh 原话完整交出来。 */
export function ghFailureMessage(verdict: GhVerdict, own?: string): string {
  const context = (own ?? "").trim();
  const raw = verdict.text.slice(0, 800);
  if (verdict.kind === "env") return context || HINT_ENV;
  if (verdict.kind === "auth") return [context || raw || "GitHub 认证失败", HINT_AUTH].filter(Boolean).join(" ");
  if (!verdict.recognized) return [context, HINT_UNRECOGNIZED, raw].filter(Boolean).join(" ");
  if (verdict.kind === "unsupported") return [context || raw || "这个操作不被支持", HINT_UNSUPPORTED].filter(Boolean).join(" ");
  return context || raw || `gh 失败（${verdict.kind}）`;
}

export function classifyGhFailure(input: GhFailureInput): GhError {
  const verdict = ghVerdictOf(input);
  return {
    kind: verdict.kind,
    message: ghFailureMessage(verdict),
    raw: verdict.text.slice(0, 2_000),
    exitCode: typeof input.exitCode === "number" ? input.exitCode : null,
    stderr: typeof input.stderr === "string" ? input.stderr.slice(0, 2_000) : "",
  };
}

export function failResult<T>(kind: GhErrorKind, message: string, raw = ""): { ok: false; kind: GhErrorKind; message: string; raw: string } {
  return { ok: false, kind, message, raw: raw.slice(0, 2_000) };
}
