import { PluginAttachmentItemSchema, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * `/deck` 的参数解析与附加源快照。
 *
 * 这里只有纯函数和契约，不碰宿主：
 * - `parseDeckSlash` 把斜杠后面的字符串解析成命令，供 agent / workspace 两种上下文复用；
 * - `buildAttachmentSnapshot` 把一张票做成「票面快照」，供 `addAttachmentSource` 的
 *   服务端 handler 复用；快照要求一个合法 URL，本地票没有 URL 时用 data URL 承载正文，
 *   不做假链接。
 *
 * 解析错误同时给 `message` 和稳定的 `code`：`message` 是直接可读的兜底，
 * `code` 让客户端按当前语言重新措辞（宿主文案不归 shared 层管）。
 */

/** 探讨需求的两条路：边谈边建地图 / 只谈，谈完自己再拆票。 */
export type DeckDiscussMode = "wayfinder" | "grill";

export type DeckSlashCommand =
  | { kind: "status" }
  | { kind: "attach"; number: number }
  | { kind: "next" }
  | { kind: "handoff" }
  | { kind: "fixate" }
  | { kind: "new" }
  | { kind: "discuss"; mode: DeckDiscussMode }
  | { kind: "help" }
  | { kind: "error"; message: string; code?: DeckSlashErrorCode };

export type DeckSlashErrorCode =
  | "missing-number"
  | "invalid-number"
  | "extra-args"
  | "unknown-command";

/** 便于客户端把 code 映射成本地文案；顺序就是 `/deck help` 的展示顺序。 */
export const DECK_SLASH_COMMANDS = ["status", "attach", "next", "handoff", "fixate", "new", "discuss", "help"] as const;

export type DeckSlashCommandName = (typeof DECK_SLASH_COMMANDS)[number];

const NO_ARG: ReadonlySet<DeckSlashCommandName> = new Set(["status", "next", "handoff", "fixate", "new", "help"]);

/** `/deck discuss` 的两个可选参数；不给就是「边谈边建地图」。 */
const DISCUSS_MODES: ReadonlySet<DeckDiscussMode> = new Set(["wayfinder", "grill"]);

const error = (code: DeckSlashErrorCode, message: string): DeckSlashCommand => ({ kind: "error", code, message });

/**
 * 解析 `/deck` 后面的参数。
 *
 * - 空参数 = `help`（第一次用的人最需要看到命令表）；
 * - 命令名不区分大小写，`#12` 与 `12` 等价；
 * - `attach` 只收一个正整数，多余参数明确报错，不猜第二个票号；
 * - 其余命令不接受参数。
 */
export function parseDeckSlash(args: string): DeckSlashCommand {
  // 解构而不是 `tokens[0]`：`noUncheckedIndexedAccess` 下索引访问永远是 `string | undefined`，
  // 先判断再用，类型和运行时校验是同一条路径。
  const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!first) return { kind: "help" };

  const name = first.toLowerCase();
  if (!isCommandName(name)) {
    return error("unknown-command", `未知命令：${first}。可用命令：${DECK_SLASH_COMMANDS.join(" / ")}。`);
  }

  if (name === "attach") {
    const [rawNumber, ...extra] = rest;
    if (!rawNumber) return error("missing-number", "attach 需要一个票号，例如 /deck attach 12 或 /deck attach #12。");
    if (extra.length > 0) return error("extra-args", "attach 只接受一个票号，多余参数没有处理。");
    const raw = rawNumber.startsWith("#") ? rawNumber.slice(1) : rawNumber;
    if (!/^\d+$/.test(raw)) return error("invalid-number", `票号必须是正整数：${rawNumber}`);
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < 1) {
      return error("invalid-number", `票号必须是正整数：${rawNumber}`);
    }
    return { kind: "attach", number };
  }

  if (name === "discuss") {
    const [mode, ...extra] = rest;
    if (extra.length > 0) {
      return error("extra-args", "discuss 最多接受一个参数：wayfinder 或 grill。");
    }
    if (mode && !DISCUSS_MODES.has(mode as DeckDiscussMode)) {
      return error("extra-args", `discuss 只认 wayfinder / grill 两种谈法，收到：${mode}`);
    }
    return { kind: "discuss", mode: (mode as DeckDiscussMode | undefined) ?? "wayfinder" };
  }

  if (NO_ARG.has(name) && rest.length > 0) {
    return error("extra-args", `${name} 不接受参数。`);
  }
  switch (name) {
    case "status":
      return { kind: "status" };
    case "next":
      return { kind: "next" };
    case "handoff":
      return { kind: "handoff" };
    case "fixate":
      return { kind: "fixate" };
    case "new":
      return { kind: "new" };
    case "help":
      return { kind: "help" };
  }
}

function isCommandName(value: string): value is DeckSlashCommandName {
  return (DECK_SLASH_COMMANDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ 票面快照 */

export interface AttachmentCommentInput {
  author: string;
  createdAt?: string;
  body: string;
}

/** 服务端读到的票面；字段与 `issuesDetailRpc` 的成功返回对齐，但不强制依赖其类型。 */
export interface AttachmentIssueInput {
  number: number;
  title: string;
  body?: string;
  url?: string;
  repoKey?: string;
  state?: string;
  labels?: readonly (string | { name: string })[];
  assignees?: readonly string[];
  comments?: readonly AttachmentCommentInput[];
  /** 远端评论总数；大于 comments.length 时在快照末尾如实说明没带全。 */
  commentCount?: number;
}

export interface AttachmentSnapshot {
  id: string;
  identifier: string;
  title: string;
  subtitle?: string;
  url: string;
  text: string;
  resourceType: string;
}

const labelName = (label: string | { name: string }): string => (typeof label === "string" ? label : label.name);

/** 本地票没有网页地址：把票面本身编码成 data URL，点开看到的就是这份快照。 */
function snapshotUrl(url: string | undefined, text: string): string {
  if (url && url.trim()) {
    try {
      new URL(url);
      return url;
    } catch {
      // 非法 URL 不硬塞给宿主：退回 data URL，至少能打开快照本身。
    }
  }
  return `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
}

/**
 * 把一张票整理成附件源可返回的完整快照。
 *
 * 正文与评论不截断：附件源的意义就是把票面原样交给会话；
 * 只给摘要会让 agent 在缺上下文的情况下动手。
 */
export function buildAttachmentSnapshot(input: AttachmentIssueInput): AttachmentSnapshot {
  const repoKey = input.repoKey?.trim() || undefined;
  const state = input.state?.trim() || undefined;
  const labels = (input.labels ?? []).map(labelName).map((label) => label.trim()).filter(Boolean);
  const assignees = (input.assignees ?? []).map((name) => name.trim()).filter(Boolean);
  const comments = input.comments ?? [];
  const body = (input.body ?? "").trim();

  const lines: string[] = [`#${input.number} ${input.title.trim()}`];
  const meta = [
    repoKey ? `repo: ${repoKey}` : null,
    state ? `state: ${state}` : null,
    labels.length ? `labels: ${labels.join(", ")}` : null,
    assignees.length ? `assignees: ${assignees.join(", ")}` : null,
  ].filter((line): line is string => line !== null);
  if (meta.length) lines.push(meta.join(" · "));
  if (input.url?.trim()) lines.push(`url: ${input.url.trim()}`);
  lines.push("", body || "(ticket has no body)", "");

  lines.push(`## Comments (${comments.length})`);
  if (comments.length === 0) {
    lines.push("(no comments)");
  } else {
    for (const comment of comments) {
      const when = comment.createdAt?.trim();
      lines.push(`- ${comment.author}${when ? ` (${when})` : ""}: ${comment.body.trim()}`);
    }
  }
  const total = input.commentCount;
  if (typeof total === "number" && total > comments.length) {
    lines.push("", `(${total - comments.length} more comments were not included in this snapshot)`);
  }

  const text = lines.join("\n");
  const subtitleParts = [repoKey, state].filter((part): part is string => Boolean(part));
  return {
    id: `${repoKey ?? "local"}#${input.number}`,
    identifier: `#${input.number}`,
    title: `#${input.number} ${input.title.trim()}`,
    ...(subtitleParts.length ? { subtitle: subtitleParts.join(" · ") } : {}),
    url: snapshotUrl(input.url, text),
    text,
    resourceType: "issue",
  };
}

/**
 * 附件源搜索契约。
 *
 * Paseo 只把 `{ query }` 交给插件 RPC（没有 workspace 上下文），
 * 服务端 handler 必须先解析工作区再搜索票；输出必须是合法 URL 的快照。
 * handler 的接线点在主线程 `server/rpc/register.ts`，本文件只提供契约与快照构造。
 */
export const issueAttachmentSearchRpc = defineRpc({
  name: "deck.issues.attachment",
  input: z.object({ query: z.string().max(500) }),
  output: z.object({ items: z.array(PluginAttachmentItemSchema) }),
});
