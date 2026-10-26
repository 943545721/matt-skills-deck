import { z } from "zod";
import { getIssue, listIssues } from "../tracker/github.ts";
import { parseMapBody } from "../tracker/map-body.ts";
import { routeFromIssues, suggestNextSteps } from "../tracker/map-route.ts";
import { createIssue, postComment, replaceLabels } from "../tracker/write.ts";
import { requireGithubRepo } from "../rpc/repo-gate.ts";
import { sortIssues } from "../tracker/order.ts";

/**
 * 给 Agent 用的 deck_* 工具。
 *
 * 这些工具与面板走同一套领域代码（`server/tracker/*`），区别只在出口：面板回 RPC，
 * 这里回 MCP 的文本内容。所以「面板上看到的票」和「Agent 读到的票」是同一份读取逻辑，
 * 不会出现两边口径不一致。
 *
 * 读写分开登记：只有读工具进 preapproved 白名单，写工具一律走用户确认——
 * 一个装完就能改远端票面的插件，不该在没人按过按钮的情况下动手。
 */

export interface ToolContext {
  workspaceDir: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown, context: ToolContext): Promise<ToolResult>;
}

const MAP_LABEL = "wayfinder:map";

const ok = (value: unknown): ToolResult => ({ text: JSON.stringify(value, null, 2), isError: false });
const fail = (reason: string, detail: string): ToolResult => ({
  text: JSON.stringify({ ok: false, reason, detail }, null, 2),
  isError: true,
});

/** 读路径的失败原因已经由领域层给出，这里只把它照原样交给 Agent，不重新措辞。 */
function failureOf(result: { reason: string; detail: string }): ToolResult {
  return fail(result.reason, result.detail);
}

const listSchema = z.strictObject({
  state: z.enum(["open", "closed", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const numberSchema = z.strictObject({ number: z.number().int().min(1) });

const commentSchema = z.strictObject({
  number: z.number().int().min(1),
  body: z.string().min(1).max(60_000),
});

const createSchema = z.strictObject({
  title: z.string().min(1).max(256),
  body: z.string().max(60_000).optional(),
  labels: z.array(z.string().min(1)).optional(),
  isMap: z.boolean().optional(),
});

const labelsSchema = z.strictObject({
  number: z.number().int().min(1),
  labels: z.array(z.string().min(1)),
});

type InputResult<T> = { ok: true; data: T } | { ok: false; error: string };

const asInput = <T>(schema: z.ZodType<T>, args: unknown): InputResult<T> => {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
};

export const MCP_SERVER_NAME = "matt-skills-deck";

export const MCP_TOOLS: readonly ToolDefinition[] = [
  {
    name: "deck_issues_list",
    description:
      "List issues of the GitHub repository that this workspace points at. Map issues (labelled wayfinder:map) come first, then open before closed, then most recently updated. Use it to find work; use deck_issue_get for one issue in full.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"], description: "Default: open." },
        limit: { type: "number", description: "1-100, default 100." },
      },
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(listSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const gate = await requireGithubRepo(context.workspaceDir, "issues");
      if (!gate.ok) return fail(gate.reason, gate.detail);
      const state = input.state ?? "open";
      // 状态下推到查询：先取 100 条混合状态再本地过滤，会把「最近更新的都是已关闭的票」错当成
      // 「仓库里只剩几条 open」，Agent 据此得出「没活可干」的结论。
      const listed = await listIssues(gate.ref.owner, gate.ref.name, input.limit ?? 100, state === "all" ? undefined : state === "open" ? "OPEN" : "CLOSED");
      if (!listed.ok) return failureOf(listed);
      const issues = sortIssues(listed.issues);
      return ok({
        ok: true,
        repo: `${gate.ref.owner}/${gate.ref.name}`,
        // totalCount 是「这个状态下的总数」，returned 是本次真正给到的条数。
        totalCount: listed.totalCount,
        returned: issues.length,
        hasMore: listed.totalCount > issues.length || listed.hasMore,
        issues: issues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.url,
          isMap: issue.isMap,
          labels: issue.labels.map((label) => label.name),
        })),
      });
    },
  },
  {
    name: "deck_issue_get",
    description:
      "Read one issue in full: body, labels, assignees and its comments (oldest first). Call this before commenting or changing labels so you edit what actually exists. When labelsTruncated is true the label list is incomplete: do not pass it to deck_issue_labels.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "number", description: "Issue number." } },
      required: ["number"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(numberSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const gate = await requireGithubRepo(context.workspaceDir, "issue");
      if (!gate.ok) return fail(gate.reason, gate.detail);
      const detail = await getIssue(gate.ref.owner, gate.ref.name, input.number);
      if (!detail.ok) return failureOf(detail);
      return ok({
        ok: true,
        repo: `${gate.ref.owner}/${gate.ref.name}`,
        issue: {
          number: detail.issue.number,
          title: detail.issue.title,
          state: detail.issue.state,
          url: detail.issue.url,
          body: detail.issue.body,
          labels: detail.issue.labels.map((label) => label.name),
          // 标签是整体替换语义，所以「读到几个」和「一共几个」必须分开说清楚。
          labelsTruncated: detail.meta.labelsTruncated,
          assignees: detail.issue.assignees,
          isMap: detail.issue.isMap,
        },
        comments: detail.comments,
        commentCount: detail.meta.commentCount,
        commentsTruncated: detail.meta.commentsTruncated,
      });
    },
  },
  {
    name: "deck_map",
    description:
      "Read a wayfinder map issue as structured data: destination, notes, decisions so far, open questions (fog), out of scope, plus the route (tickets labelled wayfinder:research|prototype|grilling|task) and rule-based next-step codes. Use it to pick what to work on next.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "number", description: "Issue number of the map issue." } },
      required: ["number"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(numberSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const gate = await requireGithubRepo(context.workspaceDir, "map");
      if (!gate.ok) return fail(gate.reason, gate.detail);
      const detail = await getIssue(gate.ref.owner, gate.ref.name, input.number);
      if (!detail.ok) return failureOf(detail);
      const board = await listIssues(gate.ref.owner, gate.ref.name, 100);
      if (!board.ok) return failureOf(board);
      const map = parseMapBody(detail.issue.body);
      const route = routeFromIssues(board.issues);
      return ok({
        ok: true,
        map: { number: detail.issue.number, title: detail.issue.title, ...map },
        route: route.map((item) => ({ number: item.number, title: item.title, state: item.state, kind: item.kind })),
        nextSteps: suggestNextSteps({ map, route }),
      });
    },
  },
  {
    name: "deck_next_steps",
    description:
      "Rules-only next-step codes for the map issue in this workspace (destination, fog, route). No model calls: it reports facts and leaves the judgement to you.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "number", description: "Map issue number." } },
      required: ["number"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(numberSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const gate = await requireGithubRepo(context.workspaceDir, "map");
      if (!gate.ok) return fail(gate.reason, gate.detail);
      const detail = await getIssue(gate.ref.owner, gate.ref.name, input.number);
      if (!detail.ok) return failureOf(detail);
      const board = await listIssues(gate.ref.owner, gate.ref.name, 100);
      if (!board.ok) return failureOf(board);
      const map = parseMapBody(detail.issue.body);
      const route = routeFromIssues(board.issues);
      const steps = suggestNextSteps({ map, route });
      return ok({ ok: true, nextSteps: steps, openRoute: route.filter((item) => item.state === "OPEN").length });
    },
  },
  {
    name: "deck_issue_comment",
    description:
      "Post a comment on an issue. This writes to GitHub: state what you did or what you need, in the issue's own language. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number", description: "Issue number." },
        body: { type: "string", description: "Markdown comment body." },
      },
      required: ["number", "body"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(commentSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const gate = await requireGithubRepo(context.workspaceDir, "comment");
      if (!gate.ok) return fail(gate.reason, gate.detail);
      const written = await postComment(gate.ref.owner, gate.ref.name, input.number, input.body);
      if (!written.ok) return failureOf(written);
      return ok({ ok: true, number: input.number, comment: written.comment });
    },
  },
  {
    name: "deck_issue_create",
    description:
      "Create an issue in the workspace repository. Pass isMap for a wayfinder map issue (adds wayfinder:map). Labels are applied in a second call and may fail separately. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title." },
        body: { type: "string", description: "Markdown body." },
        labels: { type: "array", items: { type: "string" }, description: "Label names." },
        isMap: { type: "boolean", description: "Mark as a wayfinder map issue." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(createSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const gate = await requireGithubRepo(context.workspaceDir, "create issue");
      if (!gate.ok) return fail(gate.reason, gate.detail);
      const labels = [...(input.labels ?? [])];
      if (input.isMap && !labels.includes(MAP_LABEL)) labels.push(MAP_LABEL);
      const created = await createIssue(gate.ref.owner, gate.ref.name, {
        title: input.title,
        body: input.body ?? "",
        labels,
      });
      if (!created.ok) return failureOf(created);
      return ok({
        ok: true,
        number: created.number,
        url: created.url,
        labels: created.labels,
        labelsFailed: created.labelsFailed,
      });
    },
  },
  {
    name: "deck_issue_labels",
    description:
      "Replace the full label set of an issue (not a merge). Empty array clears all labels. Refuses when the current label set cannot be read in full, because replacing would silently drop the labels we never saw. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number", description: "Issue number." },
        labels: { type: "array", items: { type: "string" }, description: "The exact label set to keep." },
      },
      required: ["number", "labels"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(labelsSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const gate = await requireGithubRepo(context.workspaceDir, "labels");
      if (!gate.ok) return fail(gate.reason, gate.detail);
      // PUT 是整体替换：若连当前标签全集都读不全，这次替换必然会删掉没读到的标签。
      // 宁可拒绝并让人去面板/GitHub 改，也不做一次「成功」的静默数据丢失。
      const current = await getIssue(gate.ref.owner, gate.ref.name, input.number);
      if (!current.ok) return failureOf(current);
      if (current.meta.labelsTruncated) {
        return fail(
          "labels-truncated",
          `#${input.number} 的标签太多，本次只读到 ${current.issue.labels.length} 个（共 ${current.meta.labelCount} 个）；整体替换会删掉没读到的标签，请改用面板或 GitHub 网页修改`,
        );
      }
      const replaced = await replaceLabels(gate.ref.owner, gate.ref.name, input.number, input.labels);
      if (!replaced.ok) return failureOf(replaced);
      return ok({ ok: true, number: input.number, labels: replaced.labels.map((label) => label.name) });
    },
  },
] as const;

/** 不需要用户逐次确认的工具：全是只读。写工具故意不在这个名单里。 */
export const PREAPPROVED_TOOL_NAMES: readonly string[] = [
  "deck_issues_list",
  "deck_issue_get",
  "deck_map",
  "deck_next_steps",
];

export function findTool(name: string): ToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
