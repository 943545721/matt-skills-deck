import { z } from "zod";
import { getIssue, listIssues } from "../tracker/github.ts";
import { parseMapBody } from "../tracker/map-body.ts";
import { routeFromIssues, suggestNextSteps } from "../tracker/map-route.ts";
import { createIssue, postComment, replaceLabels } from "../tracker/write.ts";
import { requireGithubRepo } from "../rpc/repo-gate.ts";

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

const listSchema = z.object({
  state: z.enum(["open", "closed", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const numberSchema = z.object({ number: z.number().int().min(1) });

const commentSchema = z.object({
  number: z.number().int().min(1),
  body: z.string().min(1).max(60_000),
});

const createSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(60_000).optional(),
  labels: z.array(z.string().min(1)).optional(),
  isMap: z.boolean().optional(),
});

const labelsSchema = z.object({
  number: z.number().int().min(1),
  labels: z.array(z.string().min(1)),
});

const asInput = <T>(schema: z.ZodType<T>, args: unknown): T | { error: string } => {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  return { error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
};

const isInvalid = <T>(value: T | { error: string }): value is { error: string } =>
  typeof value === "object" && value !== null && "error" in value;

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
      const input = asInput(listSchema, args);
      if (isInvalid(input)) return fail("invalid", input.error);
      const gate = await requireGithubRepo(context.workspaceDir, "issues");
      if (!gate.ok) return fail(gate.reason, gate.detail);
      const listed = await listIssues(gate.ref.owner, gate.ref.name, input.limit ?? 100);
      if (!listed.ok) return failureOf(listed);
      const state = input.state ?? "open";
      const issues = state === "all" ? listed.issues : listed.issues.filter((issue) => issue.state === (state === "open" ? "OPEN" : "CLOSED"));
      return ok({
        ok: true,
        repo: `${gate.ref.owner}/${gate.ref.name}`,
        totalCount: listed.totalCount,
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
      "Read one issue in full: body, labels, assignees and its comments (oldest first). Call this before commenting or changing labels so you edit what actually exists.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "number", description: "Issue number." } },
      required: ["number"],
      additionalProperties: false,
    },
    async run(args, context) {
      const input = asInput(numberSchema, args);
      if (isInvalid(input)) return fail("invalid", input.error);
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
          assignees: detail.issue.assignees,
          isMap: detail.issue.isMap,
        },
        comments: detail.comments,
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
      const input = asInput(numberSchema, args);
      if (isInvalid(input)) return fail("invalid", input.error);
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
      const input = asInput(numberSchema, args);
      if (isInvalid(input)) return fail("invalid", input.error);
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
      const input = asInput(commentSchema, args);
      if (isInvalid(input)) return fail("invalid", input.error);
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
      const input = asInput(createSchema, args);
      if (isInvalid(input)) return fail("invalid", input.error);
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
      "Replace the full label set of an issue (not a merge). Empty array clears all labels. Requires user approval.",
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
      const input = asInput(labelsSchema, args);
      if (isInvalid(input)) return fail("invalid", input.error);
      const gate = await requireGithubRepo(context.workspaceDir, "labels");
      if (!gate.ok) return fail(gate.reason, gate.detail);
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
