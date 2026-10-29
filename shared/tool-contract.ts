/**
 * MCP 工具契约：DSH 冻结的九个工具名、旧名别名，以及全部 `deck_*` 工具的参数表。
 *
 * 三处读的必须是同一份顺序与同一张参数表：MCP 的 tools/list、帮助文本、提示词里的工具名交叉校验。
 * 所以名字、schema 与参数语义（票号归一、正文区段的读写格式）住在这里，
 * `server/mcp/tools.ts` 只负责把名字接到真正的 handler 上。
 *
 * 别名只做查询期归一：注册表里始终只有新名一个工具，旧名由 `canonicalToolName` 转过去。
 * 这样 tools/list 不会出现重复条目，旧提示词里的 `deck_issues_list` / `deck_map` 仍然能调。
 */
import { z } from "zod";

/** DSH 冻结的九个工具装配顺序（帮助文本与注册行都按它渲染）。 */
export const DECK_TOOL_ORDER: readonly string[] = Object.freeze([
  "deck_context",
  "deck_issue_get",
  "deck_map_snapshot",
  "deck_issue_list",
  "deck_issue_create",
  "deck_map_plan_create",
  "deck_map_link",
  "deck_issue_patch",
  "deck_issue_report",
]);

/** 本插件扩展的工具（DSH 冻结面之外），保持旧名不变。 */
export const EXTENSION_TOOL_ORDER: readonly string[] = Object.freeze([
  "deck_issue_comment",
  "deck_issue_labels",
  "deck_pull_requests_list",
  "deck_next_steps",
  "deck_probe",
  "deck_handoff",
  "deck_dispatch_plan",
  "suggest_next_steps",
]);

/**
 * 旧工具名 → 新工具名。
 *
 * 只保留一个版本（见吸收方案 4.1）：新名为主，旧名继续可用；提示词与文档全部改用新名。
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  deck_issues_list: "deck_issue_list",
  deck_map: "deck_map_snapshot",
});

/** 把调用方给的工具名归一成注册表里的名字；不是别名就原样返回。 */
export function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/** `deck_issue_create` 的六种 kind，顺序与 DSH 一致。 */
export const ISSUE_KINDS: readonly string[] = Object.freeze([
  "map",
  "map-ticket",
  "spec",
  "spec-ticket",
  "bug",
  "issue",
]);

/** map-ticket 必须带的四个类型标签；标签由 kind/label 决定，不接受调用方另塞。 */
export const MAP_TICKET_LABELS: readonly string[] = Object.freeze([
  "wayfinder:research",
  "wayfinder:prototype",
  "wayfinder:grilling",
  "wayfinder:task",
]);

export const WORK_ROUTE_DETAILS: readonly string[] = Object.freeze(["core", "standard"]);
export const ISSUE_LIST_STATES: readonly string[] = Object.freeze(["open", "closed", "all"]);
export const ISSUE_LIST_TYPES: readonly string[] = Object.freeze(["issue", "map", "spec", "all"]);

export interface ToolSpec {
  description: string;
  inputSchema: Record<string, unknown>;
}

const repoProperty = {
  type: "string",
  description:
    "Repository key (owner/name). Required when the workspace contains more than one repository; omit for the only one.",
};

const workRouteDetailProperty = {
  type: "string",
  enum: [...WORK_ROUTE_DETAILS],
  description:
    "How much of the work-route table the receipt carries after success: core (issue keys, session and time; default, at most 20 rows) or standard (adds title and action; all rows).",
};

const originalWordsProperty = {
  type: "object",
  description:
    "Append one maintainer quote to the body's maintainer-words section (right after the purpose section, or at the top when there is none): { text, source }, both required. " +
    "The quote is copied verbatim: no rewording, no punctuation edits, no translation, no summary. Append only; never edit, delete or reorder existing entries. " +
    "Patch skips an identical text + source pair, so retries are idempotent. Bodies over 60 KB are refused without writing a single byte.",
  properties: {
    text: { type: "string", description: "The maintainer's words, verbatim; may be multiple lines, blank lines preserved." },
    source: {
      type: "string",
      description:
        "Where it came from, required: a full issue URL, \"this session (time)\", \"path:line\", or a short commit hash.",
    },
  },
  required: ["text", "source"],
  additionalProperties: false,
};

const assigneesProperty = {
  type: "array",
  items: { type: "string" },
  description: "Assignees (replaces the whole set; an empty array removes every assignee).",
};

/** 统一的 object schema：additionalProperties 一律 false，多给的键直接拒绝。 */
function objectSchema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

const stringArray = (description: string) => ({ type: "array", items: { type: "string" }, description });

/**
 * 全部 `deck_*` 工具的参数表（不含 `suggest_next_steps`，它由 `shared/suggestions.ts` 自己持有）。
 *
 * 参数描述是提示词成本：改字等于改模型看到的东西；未知字段由 additionalProperties:false 拒绝，
 * 不静默丢弃后当成「已过滤」。
 */
export const TOOL_SPECS: Readonly<Record<string, ToolSpec>> = Object.freeze({
  deck_context: {
    description:
      "Compact workspace context for planning: repository, counts by readiness, map issues, the top ready tickets and what blocks the rest. Call it at the start of a session instead of reading the whole board. Read-only.",
    inputSchema: objectSchema({
      limit: { type: "number", description: "Max ready/blocked entries, 1-20, default 5." },
    }),
  },

  deck_issue_get: {
    description:
      "Read one issue in full: body, labels, assignees and its comments (oldest first). Call this before commenting or changing labels so you edit what actually exists. When labelsTruncated is true the label list is incomplete: do not pass it to deck_issue_labels.",
    inputSchema: objectSchema(
      {
        number: { type: "number", description: "Issue number." },
        repo: repoProperty,
      },
      ["number"],
    ),
  },

  deck_map_snapshot: {
    description:
      "Read one wayfinder map as structured data: destination, notes, decisions so far, open questions (fog), out of scope, plus its child issues and progress. " +
      "detail=thin returns only the keys, titles, states, labels, assignees and blockers; detail=full also reads each child body for progress and maintainer words. " +
      "frontierOnly keeps only children that are ready to pick up (open, unclaimed, blockers done). Read-only.",
    inputSchema: objectSchema(
      {
        key: { type: "string", description: "Map issue number (also accepts #12)." },
        frontierOnly: {
          type: "boolean",
          description: "Only return children that can be picked up now (open, unclaimed, blockers satisfied); default returns all.",
        },
        detail: {
          type: "string",
          enum: ["full", "thin"],
          description:
            "How detailed each child row is. full (default): body progress and maintainer words, large reply that may be truncated when there are many children. thin: key, title, state, labels, assignees and blockers only; use deck_issue_get for bodies.",
        },
        repo: repoProperty,
      },
      ["key"],
    ),
  },

  deck_issue_list: {
    description:
      "List issue rows (thin: no body and no comments) by state, type, labels, assignee and query. Map issues are labelled wayfinder:map. " +
      "labels is AND; assignee and query are substring filters. state/type defaults: open / all. Read-only.",
    inputSchema: objectSchema({
      state: { type: "string", enum: [...ISSUE_LIST_STATES], description: "Which state to list; default open." },
      type: { type: "string", enum: [...ISSUE_LIST_TYPES], description: "Which kind to list; default all." },
      labels: stringArray("Only rows carrying every one of these labels (AND); omitted means no label filter."),
      assignee: { type: "string", description: "Only rows whose assignee list contains this name; omitted means no assignee filter." },
      query: { type: "string", description: "Case-insensitive substring filter on the title or body; omitted means no query filter." },
      limit: { type: "number", description: "Maximum rows to return, default 50, upper bound 200." },
      repo: repoProperty,
    }),
  },

  deck_issue_create: {
    description:
      "Create one issue. kind is required: map / map-ticket / spec / spec-ticket / bug / issue. " +
      "map and spec are top-level containers; map-ticket hangs under a map (parentKey required) and must carry one wayfinder:<kind> label; spec-ticket hangs under a spec (parentKey required). " +
      "originalWords appends the maintainer's verbatim quote to the body; blockedBy writes dependency edges; idempotencyKey makes a retried batch safe. " +
      "Requires user approval.",
    inputSchema: objectSchema(
      {
        title: { type: "string", description: "Issue title." },
        body: { type: "string", description: "Markdown body; when omitted the backend writes an empty body." },
        kind: {
          type: "string",
          enum: [...ISSUE_KINDS],
          description:
            "Where this ticket sits. map = exploration map; map-ticket = ticket under a map; spec = specification; spec-ticket = implementation ticket under a spec; bug = defect; issue = ordinary ticket (fallback).",
        },
        label: {
          type: "string",
          enum: [...MAP_TICKET_LABELS],
          description:
            "Only accepted for kind=map-ticket and then required: one of wayfinder:research / wayfinder:prototype / wayfinder:grilling / wayfinder:task. " +
            "The bare form (research / prototype / grilling / task) is still accepted and gets the wayfinder: prefix added. " +
            "The type label comes from here; do not repeat it in labels.",
        },
        parentKey: {
          type: "string",
          description:
            "Parent issue number. Required for map-ticket (parent must be a map) and spec-ticket (parent must be a spec). Not accepted for map and spec; optional for bug and issue (must be a map or spec when given).",
        },
        blockedBy: stringArray(
          "Blockers for this issue, whole-batch replace. Accepts #12 / 12 (this repository, written as a native dependency edge), " +
            "owner/repo#12 (another repository) and projectKey#12 (a key from .paseo-deck.json). " +
            "Cross-repository refs are written into a hidden `Blocked by:` section of the body; an unknown repo or a bad ref rejects the whole call.",
        ),
        labels: stringArray(
          "Extra labels beyond the required ones. Do not add type labels (wayfinder:map / wayfinder:research / wayfinder:prototype / wayfinder:grilling / wayfinder:task / bug): kind and label decide those.",
        ),
        assignees: assigneesProperty,
        idempotencyKey: { type: "string", description: "Idempotency anchor for this batch of writes; send the same value on retry." },
        originalWords: originalWordsProperty,
        workRouteDetail: workRouteDetailProperty,
        isMap: { type: "boolean", description: "Legacy shorthand: true is equivalent to kind=map; prefer kind." },
        effort: {
          type: "string",
          description: "Local Markdown backend only: the `.scratch/` directory name that holds the exploration map (the original text calls it `<effort>`). Omit to let the parent or title decide; remote backends ignore it.",
        },
        feature: {
          type: "string",
          description: "Local Markdown backend only: the `.scratch/` directory name that holds specs, implementation tickets and ordinary tickets (the original text calls it `<feature-slug>`). Omit to let the parent or title decide; remote backends ignore it.",
        },
        project: {
          type: "string",
          description:
            "Project key from `.paseo-deck.json` (`projects[].key`). Multi-project workspaces: which project this ticket belongs to. Omit to match it by `repo`. " +
            "When the workspace has a v2 project list, the matching project's `role:<owner>` label is added automatically.",
        },
        area: {
          type: "string",
          description:
            "Module key; must be one of that project's `areas`. Adds `area:<key>` (and the project's `role:<owner>`) to the labels. " +
            "An unknown project key or an area the project does not list is rejected with the available values; nothing is silently dropped.",
        },
        repo: repoProperty,
      },
      ["title", "kind"],
    ),
  },

  deck_map_plan_create: {
    description:
      "Create a wayfinder map issue with destination, notes, decisions, fog and out-of-scope, plus its first route tickets (each labelled wayfinder:<kind>). Each ticket is created separately: a partial failure is reported per ticket and never rolled back silently. Requires user approval.",
    inputSchema: objectSchema(
      {
        title: { type: "string", description: "Map issue title." },
        destination: { type: "string", description: "One-sentence destination." },
        notes: { type: "string" },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, url: { type: "string" }, gist: { type: "string" } },
            required: ["title"],
          },
        },
        fog: stringArray("Open questions that are not yet specified."),
        outOfScope: stringArray("Work explicitly out of scope for this map."),
        tickets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              kind: { type: "string", enum: ["research", "prototype", "grilling", "task"] },
              body: { type: "string" },
            },
            required: ["title", "kind"],
          },
        },
        project: {
          type: "string",
          description:
            "Project key from `.paseo-deck.json` (`projects[].key`) this map belongs to. When given (or matched by `repo`), the body is generated " +
            "as a skeleton grouped by that project's `areas`; without a v2 project list the body keeps the plain destination/notes form.",
        },
        repo: repoProperty,
      },
      ["title", "destination", "tickets"],
    ),
  },

  deck_map_link: {
    description:
      "Add or replace edges on existing issues: parent (hierarchy) and blockedBy (dependency). " +
      "Give key with parentKey / blockedBy, or an edges list for several issues in one call. " +
      "blockedBy replaces the whole blocker set for that issue; edges for the same issue are merged first. " +
      "The whole batch is cycle-checked before any write, every write is read back, and each edge reports where it landed. " +
      "Refuses self-blocking edges and cycles. Requires user approval.",
    inputSchema: objectSchema({
      key: { type: "string", description: "The issue whose edges change (child issue)." },
      parentKey: { type: "string", description: "Parent issue to attach key to; omit to leave the parent edge unchanged." },
      blockedBy: stringArray("Issue keys that block key (whole-set replacement). Empty array clears every blocker."),
      edges: {
        type: "array",
        description: "Change edges on several issues at once; use instead of key/parentKey/blockedBy.",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "Issue whose edges change." },
            parentKey: { type: "string", description: "Parent issue for this key." },
            blockedBy: stringArray("Issue keys that block this key (whole-set replacement)."),
          },
          required: ["key"],
          additionalProperties: false,
        },
      },
      workRouteDetail: workRouteDetailProperty,
      repo: repoProperty,
    }),
  },

  deck_issue_patch: {
    description:
      "Change one issue: comment, labels, assignees, close, title, body, blockedBy, progress section, maintainer-words section; only the fields you pass are touched. " +
      "Reopening is not available here (a human does it in the backend). Closing a map requires a comment in the same call. " +
      "blockedBy replaces the whole blocker set: this-repository refs go to native dependency edges, cross-repository refs (owner/repo#12 or projectKey#12) into the body's hidden `Blocked by:` section. " +
      "originalWords is idempotent on the same text + source pair; bodies over 60 KB are refused. Requires user approval.",
    inputSchema: objectSchema(
      {
        key: { type: "string", description: "The issue to change (issue number, #12 accepted)." },
        number: { type: "number", description: "Legacy alias for key; prefer key." },
        comment: { type: "string", description: "Comment body to post." },
        addLabels: stringArray("Labels to add."),
        removeLabels: stringArray("Labels to remove."),
        assignees: assigneesProperty,
        title: { type: "string", description: "New title." },
        body: { type: "string", description: "New full Markdown body (replaces the old one)." },
        originalWords: originalWordsProperty,
        blockedBy: stringArray(
          "Whole-set replacement of this issue's blockers. Accepts #12 / 12 (this repository, native edge), owner/repo#12 and projectKey#12. " +
            "Cross-repository refs land in the body's hidden `Blocked by:` section; an empty array clears every blocker.",
        ),
        progress: {
          type: "object",
          description:
            "Append one progress record { percent, note }: the tool stamps the current time, inserts it at the top of the progress section, keeps older records as-is. Bodies over 60 KB are refused.",
          properties: {
            percent: { type: "integer", description: "Progress percentage, integer 0..100." },
            note: { type: "string", description: "One line on where this issue stands; required, no newlines." },
          },
          required: ["percent", "note"],
          additionalProperties: false,
        },
        close: {
          type: "boolean",
          description:
            "true closes the issue; closing a map requires a comment in the same call and every child must already be closed. Reopening is not supported (reopen in the backend), so false is rejected.",
        },
        closeReason: {
          type: "string",
          description:
            "Why this is being closed; only valid together with close:true. Sent as the close comment when no comment is given. closeReason without close:true rejects the whole call without writing anything.",
        },
        workRouteDetail: workRouteDetailProperty,
        state: {
          type: "string",
          enum: ["open", "closed"],
          description: "Legacy: closed is equivalent to close:true; open (reopen) is rejected.",
        },
        repo: repoProperty,
      },
      ["key"],
    ),
  },

  deck_issue_report: {
    description:
      "Report which issue this session is working on: start, switch or finish an issue. key is required; note is an optional line echoed in the receipt; release=true removes a mistaken report for this session only (tickets that were actually created, changed, closed, planned or linked cannot be released). " +
      "Content changes belong to deck_issue_patch; closing through that tool does not count as reporting. Requires user approval.",
    inputSchema: objectSchema(
      {
        key: { type: "string", description: "The issue number you are reporting on." },
        note: { type: "string", description: "Optional one-line note; echoed in the receipt only." },
        workRouteDetail: workRouteDetailProperty,
        release: {
          type: "boolean",
          description:
            "Optional: true tries to remove this session's mistaken work-route report for the issue. It only removes a report when the session never actually worked the issue; it never changes the issue's state or assignees.",
        },
        repo: repoProperty,
      },
      ["key"],
    ),
  },

  deck_issue_comment: {
    description:
      "Post a comment on an issue. This writes to the configured backend (GitHub or the local .deck/ board): state what you did or what you need, in the issue's own language. Requires user approval.",
    inputSchema: objectSchema(
      {
        number: { type: "number", description: "Issue number." },
        body: { type: "string", description: "Markdown comment body." },
        repo: repoProperty,
      },
      ["number", "body"],
    ),
  },

  deck_issue_labels: {
    description:
      "Replace the full label set of an issue (not a merge). Empty array clears all labels. Refuses when the current label set cannot be read in full, because replacing would silently drop the labels we never saw. Requires user approval.",
    inputSchema: objectSchema(
      {
        number: { type: "number", description: "Issue number." },
        labels: stringArray("The exact label set to keep."),
        repo: repoProperty,
      },
      ["number", "labels"],
    ),
  },

  deck_pull_requests_list: {
    description:
      "List pull requests of the workspace repository, separate from issues even though they share the number space. States: open (default), closed (closed but not merged), merged, all. Read-only.",
    inputSchema: objectSchema({
      state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "Default: open." },
      limit: { type: "number", description: "1-100, default 100." },
      repo: repoProperty,
    }),
  },

  deck_next_steps: {
    description:
      "Rules-only next-step codes for the map issue in this workspace (destination, fog, route). No model calls: it reports facts and leaves the judgement to you. Read-only.",
    inputSchema: objectSchema(
      {
        number: { type: "number", description: "Map issue number." },
        repo: repoProperty,
      },
      ["number"],
    ),
  },

  deck_probe: {
    description:
      "Report this workspace's environment without changing anything: resolved repository, effective backend, gh availability and issue counts. Works even when no repository is configured, so it is safe to call first when something looks broken. Read-only.",
    inputSchema: objectSchema({}),
  },

  deck_handoff: {
    description:
      "Record this sub-agent's report so it survives after the turn ends and can be pushed up to the parent window. Writes .deck/handoffs/<agent id>.json and returns the rendered Markdown. Call it once, right before you finish a dispatched task; summary is required, the rest are optional. The record is always written under this session's own id (PASEO_AGENT_ID): you cannot write another session's record, and the call fails with no-agent-id when that variable is unavailable.",
    inputSchema: objectSchema(
      {
        summary: { type: "string", description: "What you actually did, in 1-3 sentences. Required." },
        status: {
          type: "string",
          enum: ["completed", "blocked", "failed"],
          description: "Default: completed. Use blocked when you need a decision, failed when the task could not be done.",
        },
        done: stringArray("Concrete results, one per entry."),
        nextSteps: stringArray("What the parent should do next, one per entry."),
        files: stringArray("Repository-relative paths you touched."),
        blocking: stringArray("Risks or blockers the parent must know about."),
        ticketKey: { type: "string", description: "Issue key this task came from, e.g. \"12\"." },
        difficulty: { type: "string", enum: ["trivial", "normal", "hard", "critical"], description: "Difficulty you were dispatched with, if known." },
      },
      ["summary"],
    ),
  },

  deck_dispatch_plan: {
    description:
      "Plan how to split work across other agent windows: for each task it resolves the configured client and model for that task's difficulty, builds the child labels (including paseo.parent-agent-id) and the prompt preamble that tells the child to report back with deck_handoff. Read-only — it creates nothing; pass each accepted task's provider/model to create_agent yourself. Rejections are per task, so one unusable task never blocks the batch.",
    inputSchema: objectSchema({
      tasks: {
        type: "array",
        description: "Tasks to plan. Order is preserved.",
        items: objectSchema(
          {
            key: { type: "string", description: "Stable key for this task in the batch (usually the issue number)." },
            title: { type: "string", description: "Short title, shown in the plan." },
            prompt: { type: "string", description: "Full instruction for the child window." },
            difficulty: { type: "string", enum: ["trivial", "normal", "hard", "critical"], description: "Default: normal." },
          },
          ["key", "prompt"],
        ),
      },
      depth: { type: "number", description: "Which layer you sit at: 0 when you are the main window dispatching directly, 1 when you are its dispatcher. Required — omitting it would let the chain grow past maxDepth." },
      workspaceId: { type: "string", description: "Only needed when several workspaces share one board directory." },
      dispatchId: { type: "string", description: "Batch id, reused for idempotency keys. Default: generated." },
      lang: { type: "string", enum: ["zh", "en"], description: "Language of the generated preamble. Default zh." },
    }, ["tasks", "depth"]),
  },
});

/* ------------------------------------------------------------------ 参数语义 */

/** 正文上限：与四个写工具共享。超过就整笔拒绝，一个字节都不写。 */
export const BODY_LIMIT_BYTES = 60_000;

/** UTF-8 字节数。shared 层也进客户端构建，不能用只有 Node 才有的 Buffer。 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const bodyWithinLimit = (body: string): boolean => utf8ByteLength(body) <= BODY_LIMIT_BYTES;

/** 票号归一：去掉开头的 #，只认 1 到 10 位数字，别的（含没给）一律当空。 */
export function parseKey(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/^#/, "") : "";
  if (!/^\d{1,10}$/.test(text)) return null;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ORIGINAL_WORDS_HEADING = "## 维护者原话";
const PROGRESS_HEADING = "## 进度";

/** 找区段标题所在行；返回标题行起点与正文起点（标题行换行之后）。 */
function findHeading(body: string, heading: string): { start: number; contentStart: number } | null {
  const match = new RegExp(`^${escapeRegExp(heading)}[ \\t]*$`, "m").exec(body);
  if (!match) return null;
  const lineEnd = body.indexOf("\n", match.index);
  return { start: match.index, contentStart: lineEnd < 0 ? body.length : lineEnd + 1 };
}

/** 区段正文的结束位置：下一个 `## ` 标题或文末。 */
function sectionEnd(body: string, contentStart: number): number {
  const next = /^## /m.exec(body.slice(contentStart));
  return next ? contentStart + next.index : body.length;
}

/**
 * 把一条记录插到区段最上面：区段不存在时新建；`anchorHeading` 给定时把新区段
 * 放到那个区段之后（维护者原话要求紧跟「## 目的」）。
 */
function prependToSection(body: string, heading: string, entry: string, anchorHeading?: string): string {
  const target = findHeading(body, heading);
  if (target) {
    const rest = body.slice(target.contentStart).replace(/^\n+/, "");
    return `${body.slice(0, target.contentStart)}\n${entry}\n${rest ? `\n${rest}` : ""}`;
  }
  const section = `${heading}\n\n${entry}\n`;
  const anchor = anchorHeading ? findHeading(body, anchorHeading) : null;
  if (!anchor) {
    const trimmed = body.replace(/\n*$/, "");
    return trimmed ? `${trimmed}\n\n${section}` : section;
  }
  const end = sectionEnd(body, anchor.contentStart);
  const before = body.slice(0, end).replace(/\n*$/, "\n\n");
  const after = body.slice(end).replace(/^\n*/, "");
  return before + section + (after ? `\n${after}` : "");
}

/** 一条维护者原话：整段引用，末行写「— 出处」，与解析器互为逆运算。 */
function renderOriginalWords(words: { text: string; source: string }): string {
  const quoted = words.text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n>\n> — ${words.source}`;
}

/** 追加原话；同一段正文 + 同一出处已经写过时幂等跳过。 */
export function appendOriginalWords(
  body: string,
  words: { text: string; source: string },
): { body: string; added: boolean } {
  const entry = renderOriginalWords(words);
  const target = findHeading(body, ORIGINAL_WORDS_HEADING);
  const existing = target ? body.slice(target.contentStart, sectionEnd(body, target.contentStart)) : "";
  if (existing.includes(entry)) return { body, added: false };
  return { body: prependToSection(body, ORIGINAL_WORDS_HEADING, entry, "## 目的"), added: true };
}

/** 一条进度记录：百分比、说明、时间（工具盖时间戳，调用方不填）。 */
function renderProgress(progress: { percent: number; note: string }, at: string): string {
  return `- ${progress.percent}% — ${progress.note}（${at}）`;
}

export function appendProgress(body: string, progress: { percent: number; note: string }, at: string): string {
  return prependToSection(body, PROGRESS_HEADING, renderProgress(progress, at));
}

/** 读回最新一条进度（写在区段最上面）。没有进度区或格式不对时返回 null。 */
export function parseProgressOf(body: string): { percent: number; note: string; at: string } | null {
  const target = findHeading(body, PROGRESS_HEADING);
  if (!target) return null;
  const section = body.slice(target.contentStart, sectionEnd(body, target.contentStart));
  const match = /^\s*[-*]\s*(\d{1,3})%\s*[—–-]\s*(.*?)(?:（([^）]*)）)?\s*$/m.exec(section);
  if (!match) return null;
  const percent = Number(match[1]);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return null;
  return { percent, note: (match[2] ?? "").trim(), at: (match[3] ?? "").trim() };
}

/** 读回维护者原话：与 `renderOriginalWords` 同一格式，坏条目跳过而不是猜。 */
export function parseOriginalWordsOf(body: string): { text: string; source: string }[] {
  const target = findHeading(body, ORIGINAL_WORDS_HEADING);
  if (!target) return [];
  const section = body.slice(target.contentStart, sectionEnd(body, target.contentStart));
  const out: { text: string; source: string }[] = [];
  for (const block of section.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed.startsWith(">")) continue;
    const lines = trimmed.split("\n").map((line) => line.replace(/^>\s?/, "").replace(/\s+$/, ""));
    const sourceAt = lines.findIndex((line) => line.startsWith("— "));
    if (sourceAt < 0) continue;
    const source = (lines[sourceAt] ?? "").slice(2).trim();
    const text = lines.slice(0, sourceAt).filter(Boolean).join("\n");
    if (text && source) out.push({ text, source });
  }
  return out;
}

/* ------------------------------------------------------------------ zod 入参 */

export const repoKey = z.string().min(1).max(200).optional();

export const routeKindSchema = z.enum(["research", "prototype", "grilling", "task"]);

/**
 * 地图工单的 label。
 *
 * 正式写法是 `wayfinder:<kind>`（工具 schema 里对外的 enum 也只列这四枚）；
 * 不带前缀的旧写法仍然收，工具层会补成 `wayfinder:<kind>` 再往下走。
 * 这一层必须和 `resolveCreateKind` 认的写法一致：它只认带前缀的，
 * 早先这里只认不带前缀的，于是文档写的写法反而被入参校验拒掉。
 */
export const mapTicketLabelSchema = z.enum([
  "wayfinder:research",
  "wayfinder:prototype",
  "wayfinder:grilling",
  "wayfinder:task",
  "research",
  "prototype",
  "grilling",
  "task",
]);
export const issueKindSchema = z.enum(["map", "map-ticket", "spec", "spec-ticket", "bug", "issue"]);
export const workRouteDetailSchema = z.enum(["core", "standard"]);
const keyValueSchema = z.union([z.string().min(1).max(40), z.number().int().min(1)]);

/**
 * 一条依赖引用：`#12` / `12`（本仓库），或 `owner/repo#12` / `项目键#12`（跨仓库）。
 *
 * 比 `keyValueSchema` 宽：`group/sub/name#123` 这种 GitLab 路径装不进 40 个字符。
 * 写法是否合法（仓库在不在配置里、票号有没有）由工具层的 `dependencyRefOf` 判，
 * 这里只挡住空串和离谱的长串。
 */
const dependencyRefSchema = z.union([z.string().min(1).max(300), z.number().int().min(1)]);

const originalWordsSchema = z.strictObject({
  text: z.string().min(1).max(BODY_LIMIT_BYTES),
  source: z.string().min(1).max(2_000),
});

const progressSchema = z.strictObject({
  percent: z.number().int().min(0).max(100),
  note: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !/[\r\n]/.test(value), "note 必须是一行"),
});

export const numberSchema = z.strictObject({ number: z.number().int().min(1), repo: repoKey });

export const commentSchema = z.strictObject({
  number: z.number().int().min(1),
  body: z.string().min(1).max(BODY_LIMIT_BYTES),
  repo: repoKey,
});

export const labelsSchema = z.strictObject({
  number: z.number().int().min(1),
  labels: z.array(z.string().min(1)),
  repo: repoKey,
});

export const pullListSchema = z.strictObject({
  state: z.enum(["open", "closed", "merged", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  repo: repoKey,
});

export const listSchema = z.strictObject({
  state: z.enum(["open", "closed", "all"]).optional(),
  type: z.enum(["issue", "map", "spec", "all"]).optional(),
  labels: z.array(z.string().min(1)).max(50).optional(),
  assignee: z.string().min(1).max(200).optional(),
  query: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  repo: repoKey,
});

export const mapSnapshotSchema = z.strictObject({
  key: keyValueSchema,
  frontierOnly: z.boolean().optional(),
  detail: z.enum(["full", "thin"]).optional(),
  repo: repoKey,
});

export const createSchema = z.strictObject({
  title: z.string().min(1).max(256),
  body: z.string().max(BODY_LIMIT_BYTES).optional(),
  kind: issueKindSchema,
  label: mapTicketLabelSchema.optional(),
  parentKey: keyValueSchema.optional(),
  blockedBy: z.array(dependencyRefSchema).max(50).optional(),
  labels: z.array(z.string().min(1)).max(50).optional(),
  assignees: z.array(z.string().min(1)).max(50).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  originalWords: originalWordsSchema.optional(),
  workRouteDetail: workRouteDetailSchema.optional(),
  isMap: z.boolean().optional(),
  /** 本地 Markdown 后端的 `.scratch/<目录>`：两套技能各叫一个词，互斥；远端后端忽略。 */
  effort: z.string().min(1).max(80).optional(),
  feature: z.string().min(1).max(80).optional(),
  /**
   * 项目键（`.paseo-deck.json` 的 `projects[].key`）：多项目工作区里指明这张票属于哪个项目。
   * 不给时按 `repo` 反查；有项目才会自动带 `role:<owner>`。
   */
  project: z.string().min(1).max(64).optional(),
  /** 模块键：必须是该项目 `areas` 里登记过的一个，会自动带 `area:<k>`。 */
  area: z.string().min(1).max(32).optional(),
  repo: repoKey,
});

export const patchSchema = z.strictObject({
  key: keyValueSchema,
  number: z.number().int().min(1).optional(),
  comment: z.string().min(1).max(BODY_LIMIT_BYTES).optional(),
  addLabels: z.array(z.string().min(1)).max(50).optional(),
  removeLabels: z.array(z.string().min(1)).max(50).optional(),
  assignees: z.array(z.string().min(1)).max(50).optional(),
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(BODY_LIMIT_BYTES).optional(),
  originalWords: originalWordsSchema.optional(),
  progress: progressSchema.optional(),
  /** 阻塞边的整组替换：本仓库项走原生依赖，跨仓库项写进正文隐藏区段。 */
  blockedBy: z.array(dependencyRefSchema).max(100).optional(),
  close: z.boolean().optional(),
  closeReason: z.string().min(1).max(2_000).optional(),
  workRouteDetail: workRouteDetailSchema.optional(),
  state: z.enum(["open", "closed"]).optional(),
  repo: repoKey,
});

export const reportSchema = z.strictObject({
  key: keyValueSchema,
  note: z.string().max(2_000).optional(),
  workRouteDetail: workRouteDetailSchema.optional(),
  release: z.boolean().optional(),
  repo: repoKey,
});

/** `deck_map_link` 的一条边作业：`edges` 里的一项，或顶层 key 归一后的唯一一项。 */
export const mapLinkEdgeSchema = z.strictObject({
  key: keyValueSchema,
  parentKey: keyValueSchema.optional(),
  blockedBy: z.array(keyValueSchema).max(100).optional(),
});

export const mapLinkSchema = z.strictObject({
  key: keyValueSchema.optional(),
  parentKey: keyValueSchema.optional(),
  blockedBy: z.array(keyValueSchema).max(100).optional(),
  edges: z.array(mapLinkEdgeSchema).min(1).max(100).optional(),
  workRouteDetail: workRouteDetailSchema.optional(),
  repo: repoKey,
}).refine((value) => value.edges !== undefined || value.key !== undefined, {
  message: "给 key（可带 parentKey / blockedBy），或者给 edges 清单",
  path: ["key"],
});

export const mapPlanSchema = z.strictObject({
  title: z.string().min(1).max(256),
  destination: z.string().min(1).max(10_000),
  notes: z.string().max(20_000).optional(),
  decisions: z.array(z.object({ title: z.string().min(1), url: z.string().optional(), gist: z.string().optional() })).max(50).optional(),
  fog: z.array(z.string().min(1)).max(50).optional(),
  outOfScope: z.array(z.string().min(1)).max(50).optional(),
  tickets: z
    .array(z.strictObject({ title: z.string().min(1).max(256), kind: routeKindSchema, body: z.string().max(20_000).optional() }))
    .min(1)
    .max(20),
  /** 这张图属于哪个项目：给了就按该项目 `areas` 分组建骨架；不给时按 `repo` 反查。 */
  project: z.string().min(1).max(64).optional(),
  repo: repoKey,
});

export type InputResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** 统一收口 zod 错误：路径 + 原因，多错用分号连接。 */
export function parseInput<T>(schema: z.ZodType<T>, args: unknown): InputResult<T> {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
}
