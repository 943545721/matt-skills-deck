import { z } from "zod";
import { getIssue, listIssues } from "../tracker/github.ts";
import { readBoard, readIssue } from "../tracker/read.ts";
import { resolveBackend, resolveWritableBackend, type WritableBackend } from "../tracker/backend.ts";
import { createLocalIssue, getLocalIssue, patchLocalIssue, postLocalComment, replaceLocalLabels } from "../tracker/local.ts";
import { buildMapBody, parseMapBody } from "../tracker/map-body.ts";
import { routeFromIssues, suggestNextSteps } from "../tracker/map-route.ts";
import { createIssue, patchIssue, postComment, replaceLabels } from "../tracker/write.ts";
import { sortIssues } from "../tracker/order.ts";
import { assertLabelsReadable } from "../tracker/label-guard.ts";
import { countBoard } from "../tracker/readiness.ts";
import { effectiveBackend } from "../env.ts";
import { getSettings } from "../settings.ts";
import { readStatus } from "../status.ts";
import { PLUGIN_VERSION } from "../../shared/version.ts";

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

/** 本地后端的 repo 没有 owner：界面上显示工作区目录名，而不是一个空字符串。 */
const repoLabel = (repo: { host: string; owner: string; name: string }): string =>
  repo.host === "local" ? `${repo.name}（本地）` : `${repo.owner}/${repo.name}`;

const ok = (value: unknown): ToolResult => ({ text: JSON.stringify(value, null, 2), isError: false });
const fail = (reason: string, detail: string): ToolResult => ({
  text: JSON.stringify({ ok: false, reason, detail }, null, 2),
  isError: true,
});

/** 读路径的失败原因已经由领域层给出，这里只把它照原样交给 Agent，不重新措辞。 */
function failureOf(result: { reason: string; detail: string }): ToolResult {
  return fail(result.reason, result.detail);
}

/* ------------------------------------------------------------------ 写路径分派 */

/**
 * 写工具与面板走同一道闸门：GitHub 写远端，本地写 `.deck/`，GitLab 由
 * `resolveWritableBackend` 明确拒绝。每个写操作只在这里分一次叉，
 * 工具实现里不再出现「某某后端不支持」的分支。
 */
const writeComment = (backend: WritableBackend, number: number, body: string) =>
  backend.kind === "github"
    ? postComment(backend.ref.owner, backend.ref.name, number, body)
    : postLocalComment(backend.workspaceDir, number, body);

const writeIssue = (backend: WritableBackend, input: { title: string; body: string; labels: readonly string[] }) =>
  backend.kind === "github"
    ? createIssue(backend.ref.owner, backend.ref.name, input)
    : createLocalIssue(backend.workspaceDir, input);

const writePatch = (
  backend: WritableBackend,
  number: number,
  patch: { title?: string; body?: string; state?: "open" | "closed" },
) =>
  backend.kind === "github"
    ? patchIssue(backend.ref.owner, backend.ref.name, number, patch)
    : patchLocalIssue(backend.workspaceDir, number, patch);

const writeLabels = (backend: WritableBackend, number: number, labels: readonly string[]) =>
  backend.kind === "github"
    ? replaceLabels(backend.ref.owner, backend.ref.name, number, labels)
    : replaceLocalLabels(backend.workspaceDir, number, labels);

const readOne = (backend: WritableBackend, number: number) =>
  backend.kind === "github"
    ? getIssue(backend.ref.owner, backend.ref.name, number)
    : getLocalIssue(backend.workspaceDir, number);

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

const pullListSchema = z.strictObject({
  state: z.enum(["open", "closed", "merged", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const patchSchema = z.strictObject({
  number: z.number().int().min(1),
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(60_000).optional(),
  state: z.enum(["open", "closed"]).optional(),
});

const reportSchema = z.strictObject({
  title: z.string().min(1).max(256),
  whatHappened: z.string().min(1).max(20_000),
  expected: z.string().max(10_000).optional(),
  steps: z.array(z.string().min(1)).max(50).optional(),
  labels: z.array(z.string().min(1)).optional(),
});

const routeKindSchema = z.enum(["research", "prototype", "grilling", "task"]);

const mapLinkSchema = z.strictObject({
  mapNumber: z.number().int().min(1),
  number: z.number().int().min(1),
  kind: routeKindSchema,
  /** 给地图补一条评论，说明为什么把这张票挂上来。 */
  comment: z.string().max(10_000).optional(),
});

const mapPlanSchema = z.strictObject({
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
      "List issues of the repository that this workspace points at (GitHub, GitLab read-only, or the local .deck/ Markdown board). Map issues (labelled wayfinder:map) come first, then open before closed, then most recently updated. Use it to find work; use deck_issue_get for one issue in full.",
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
      const state = input.state ?? "open";
      // 状态下推到查询：先取 100 条混合状态再本地过滤，会把「最近更新的都是已关闭的票」错当成
      // 「仓库里只剩几条 open」，Agent 据此得出「没活可干」的结论。
      const read = await readBoard(context.workspaceDir, {
        limit: input.limit ?? 100,
        includeClosed: state !== "open",
        view: state === "closed" ? "closed" : state === "all" ? "all" : "open",
      });
      if (!read.ok) return fail(read.reason, read.detail);
      const listed = read.result;
      if (!listed.ok) return failureOf(listed);
      // Agent 找的是「能动手的票」：PR 与票共用编号，混在同一个列表里会让它把 PR 当成 issue
      // 去评论/改标签。PR 另有 deck_pull_requests_list。
      const issues = sortIssues(listed.issues.filter((issue) => issue.kind === "issue"));
      return ok({
        ok: true,
        repo: repoLabel(read.repo),
        // totalCount 是「这个状态下的总数」，returned 是本次真正给到的条数。
        totalCount: listed.totalCount,
        returned: issues.length,
        hasMore: listed.totalCount > issues.length || listed.hasMore,
        source: listed.source,
        issues: issues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.url,
          isMap: issue.isMap,
          readiness: issue.readiness,
          blockedBy: issue.blockedBy.map((blocker) => blocker.number),
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
      const read = await readIssue(context.workspaceDir, input.number);
      if (!read.ok) return fail(read.reason, read.detail);
      const detail = read.result;
      if (!detail.ok) return failureOf(detail);
      return ok({
        ok: true,
        repo: repoLabel(read.repo),
        issue: {
          number: detail.issue.number,
          title: detail.issue.title,
          state: detail.issue.state,
          url: detail.issue.url,
          body: detail.issue.body,
          labels: detail.issue.labels.map((label) => label.name),
          // 标签是整体替换语义，所以「读到几个」和「一共几个」必须分开说清楚。
          labelCount: detail.meta.labelCount,
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
      const read = await readIssue(context.workspaceDir, input.number);
      if (!read.ok) return fail(read.reason, read.detail);
      const detail = read.result;
      if (!detail.ok) return failureOf(detail);
      const board = await readBoard(context.workspaceDir, { limit: 100 });
      if (!board.ok) return fail(board.reason, board.detail);
      if (!board.result.ok) return failureOf(board.result);
      const map = parseMapBody(detail.issue.body);
      const route = routeFromIssues(board.result.issues);
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
      const read = await readIssue(context.workspaceDir, input.number);
      if (!read.ok) return fail(read.reason, read.detail);
      const detail = read.result;
      if (!detail.ok) return failureOf(detail);
      const board = await readBoard(context.workspaceDir, { limit: 100 });
      if (!board.ok) return fail(board.reason, board.detail);
      if (!board.result.ok) return failureOf(board.result);
      const map = parseMapBody(detail.issue.body);
      const route = routeFromIssues(board.result.issues);
      const steps = suggestNextSteps({ map, route });
      return ok({ ok: true, nextSteps: steps, openRoute: route.filter((item) => item.state === "OPEN").length });
    },
  },
  {
    name: "deck_issue_comment",
    description:
      "Post a comment on an issue. This writes to the configured backend (GitHub or the local .deck/ board): state what you did or what you need, in the issue's own language. Requires user approval.",
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
      const backend = await resolveWritableBackend(context.workspaceDir, "comment");
      if (!backend.ok) return fail(backend.reason, backend.detail);
      const written = await writeComment(backend, input.number, input.body);
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
      const backend = await resolveWritableBackend(context.workspaceDir, "create issue");
      if (!backend.ok) return fail(backend.reason, backend.detail);
      const labels = [...(input.labels ?? [])];
      if (input.isMap && !labels.includes(MAP_LABEL)) labels.push(MAP_LABEL);
      const created = await writeIssue(backend, { title: input.title, body: input.body ?? "", labels });
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
      const backend = await resolveWritableBackend(context.workspaceDir, "labels");
      if (!backend.ok) return fail(backend.reason, backend.detail);
      // GitHub 的 PUT 是整体替换：读不全现有标签就拒绝。守卫放在领域层（面板 RPC 同一条），
      // 宁可拒绝并让人去远端改，也不做一次「成功」的静默数据丢失。本地文件没有截断问题。
      if (backend.kind === "github") {
        const guard = await assertLabelsReadable(backend.ref.owner, backend.ref.name, input.number);
        if (!guard.ok) return fail(guard.reason, guard.detail);
      }
      const replaced = await writeLabels(backend, input.number, input.labels);
      if (!replaced.ok) return failureOf(replaced);
      return ok({ ok: true, number: input.number, labels: replaced.labels.map((label) => label.name) });
    },
  },
  {
    name: "deck_pull_requests_list",
    description:
      "List pull requests of the workspace repository, separate from issues even though they share the number space. States: open (default), closed (closed but not merged), merged, all. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "Default: open." },
        limit: { type: "number", description: "1-100, default 100." },
      },
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(pullListSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const backend = await resolveBackend(context.workspaceDir, "pull requests");
      if (!backend.ok) return fail(backend.reason, backend.detail);
      // PR 是 GitHub 的概念；GitLab 的 MR 与本地后端都不在这里假装支持。
      if (backend.kind !== "github") {
        return fail("unsupported-host", `Pull requests are only available on the GitHub backend; this workspace uses ${backend.kind}`);
      }
      const state = input.state ?? "open";
      const view = state === "merged" ? "merged" : state === "closed" ? "closed" : state === "all" ? "all" : "open";
      const listed = await listIssues(backend.ref.owner, backend.ref.name, {
        limit: input.limit ?? 100,
        includeClosed: state !== "open",
        view,
      });
      if (!listed.ok) return failureOf(listed);
      const pullRequests = listed.issues.filter((item) => {
        if (item.kind !== "pull-request") return false;
        if (state === "open") return item.state === "OPEN";
        if (state === "merged") return item.merged;
        if (state === "closed") return item.state === "CLOSED" && !item.merged;
        return true;
      });
      return ok({
        ok: true,
        repo: repoLabel(backend.repo),
        returned: pullRequests.length,
        hasMore: listed.hasMore,
        source: listed.source,
        pullRequests: pullRequests.map((item) => ({
          number: item.number,
          title: item.title,
          state: item.state,
          merged: item.merged,
          url: item.url,
          labels: item.labels.map((label) => label.name),
        })),
      });
    },
  },
  {
    name: "deck_issue_patch",
    description:
      "Change an issue's title, body or state (open/closed). Only the fields you pass are written; everything else stays as it is. Call deck_issue_get first so you edit what actually exists. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number", description: "Issue number." },
        title: { type: "string", description: "New title." },
        body: { type: "string", description: "New full Markdown body (replaces the old one)." },
        state: { type: "string", enum: ["open", "closed"], description: "New state." },
      },
      required: ["number"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(patchSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      if (input.title === undefined && input.body === undefined && input.state === undefined) {
        return fail("invalid", "at least one of title / body / state is required");
      }
      const backend = await resolveWritableBackend(context.workspaceDir, "patch issue");
      if (!backend.ok) return fail(backend.reason, backend.detail);
      const patched = await writePatch(backend, input.number, {
        title: input.title,
        body: input.body,
        state: input.state,
      });
      if (!patched.ok) return failureOf(patched);
      return ok({ ...patched, number: input.number });
    },
  },
  {
    name: "deck_issue_report",
    description:
      "Create a structured bug/incident report as an issue: what happened, what was expected, and reproduction steps. Use this instead of a free-form issue when the point is a defect. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title." },
        whatHappened: { type: "string", description: "What actually happened, with evidence." },
        expected: { type: "string", description: "What should have happened." },
        steps: { type: "array", items: { type: "string" }, description: "Reproduction steps, in order." },
        labels: { type: "array", items: { type: "string" }, description: "Label names." },
      },
      required: ["title", "whatHappened"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(reportSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const backend = await resolveWritableBackend(context.workspaceDir, "report issue");
      if (!backend.ok) return fail(backend.reason, backend.detail);
      const body = [
        "## What happened",
        input.whatHappened.trim(),
        "",
        "## Expected",
        input.expected?.trim() || "_Not specified._",
        "",
        "## Steps to reproduce",
        input.steps?.length ? input.steps.map((step, index) => `${index + 1}. ${step.trim()}`).join("\n") : "_Not specified._",
        "",
      ].join("\n");
      const created = await writeIssue(backend, {
        title: input.title,
        body,
        labels: input.labels ?? [],
      });
      if (!created.ok) return failureOf(created);
      return ok({ ok: true, number: created.number, url: created.url, labels: created.labels, labelsFailed: created.labelsFailed });
    },
  },
  {
    name: "deck_map_link",
    description:
      "Put an existing issue on a map's route by adding its wayfinder:<kind> label (labels are preserved, not replaced). Optionally comment on the map explaining why. Refuses when the issue's labels cannot be read in full or the target is not a map issue. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        mapNumber: { type: "number", description: "Map issue number." },
        number: { type: "number", description: "Issue to put on the route." },
        kind: { type: "string", enum: ["research", "prototype", "grilling", "task"] },
        comment: { type: "string", description: "Optional comment to post on the map." },
      },
      required: ["mapNumber", "number", "kind"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(mapLinkSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const backend = await resolveWritableBackend(context.workspaceDir, "link to map");
      if (!backend.ok) return fail(backend.reason, backend.detail);

      const map = await readOne(backend, input.mapNumber);
      if (!map.ok) return failureOf(map);
      if (!map.issue.isMap) return fail("invalid", `#${input.mapNumber} is not a map issue (missing wayfinder:map)`);

      const target = await readOne(backend, input.number);
      if (!target.ok) return failureOf(target);
      if (target.meta.labelsTruncated) {
        return fail(
          "labels-truncated",
          `#${input.number} has ${target.meta.labelCount} labels but only ${target.issue.labels.length} could be read; replacing would delete the rest`,
        );
      }
      const wanted = [...new Set([...target.issue.labels.map((label) => label.name), `wayfinder:${input.kind}`])];
      const replaced = await writeLabels(backend, input.number, wanted);
      if (!replaced.ok) return failureOf(replaced);

      let commented = false;
      if (input.comment?.trim()) {
        const posted = await writeComment(
          backend,
          input.mapNumber,
          `Linked #${input.number} to the route as ${input.kind}.\n\n${input.comment.trim()}`,
        );
        if (!posted.ok) {
          // 标签已经挂上：如实回报「挂上了但评论失败」，不要整件事报失败。
          return ok({
            ok: true,
            number: input.number,
            labels: replaced.labels.map((label) => label.name),
            commented: false,
            commentFailure: posted.detail,
          });
        }
        commented = true;
      }
      return ok({ ok: true, number: input.number, labels: replaced.labels.map((label) => label.name), commented });
    },
  },
  {
    name: "deck_map_plan_create",
    description:
      "Create a wayfinder map issue with destination, notes, decisions, fog and out-of-scope, plus its first route tickets (each labelled wayfinder:<kind>). Each ticket is created separately: a partial failure is reported per ticket and never rolled back silently. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
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
        fog: { type: "array", items: { type: "string" } },
        outOfScope: { type: "array", items: { type: "string" } },
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
      },
      required: ["title", "destination", "tickets"],
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(mapPlanSchema, args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const input = inputResult.data;
      const backend = await resolveWritableBackend(context.workspaceDir, "create map plan");
      if (!backend.ok) return fail(backend.reason, backend.detail);

      const body = buildMapBody({
        destination: input.destination,
        notes: input.notes,
        decisions: input.decisions,
        fog: input.fog,
        outOfScope: input.outOfScope,
      });
      const map = await writeIssue(backend, { title: input.title, body, labels: [MAP_LABEL] });
      if (!map.ok) return failureOf(map);

      const tickets: { number?: number; title: string; kind: string; url?: string; labelsFailed?: boolean; error?: string }[] = [];
      for (const ticket of input.tickets) {
        const created = await writeIssue(backend, {
          title: ticket.title,
          body: [`Part of map #${map.number}.`, "", ticket.body?.trim() ?? ""].join("\n"),
          labels: [`wayfinder:${ticket.kind}`],
        });
        if (!created.ok) {
          tickets.push({ title: ticket.title, kind: ticket.kind, error: created.detail });
          continue;
        }
        tickets.push({
          number: created.number,
          title: ticket.title,
          kind: ticket.kind,
          url: created.url,
          labelsFailed: created.labelsFailed,
        });
      }
      return ok({
        ok: true,
        map: { number: map.number, url: map.url, labelsFailed: map.labelsFailed },
        tickets,
        failed: tickets.filter((ticket) => ticket.error).length,
      });
    },
  },
  {
    name: "deck_probe",
    description:
      "Report this workspace's environment without changing anything: resolved repository, effective backend, gh availability and issue counts. Works even when no repository is configured, so it is safe to call first when something looks broken. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_args, context) {
      const resolved = await resolveBackend(context.workspaceDir, "探针");
      const status = await readStatus();
      let counts: ReturnType<typeof countBoard> | null = null;
      let maps: { number: number; title: string }[] = [];
      let repo: { host: string; owner: string; name: string } | null = null;
      let repoProblem: string | null = resolved.ok ? null : resolved.detail;
      if (resolved.ok) {
        repo = { host: resolved.repo.host, owner: resolved.repo.owner, name: resolved.repo.name };
        const board = await readBoard(context.workspaceDir, { limit: 100 });
        if (board.ok && board.result.ok) {
          const issues = board.result.issues.filter((item) => item.kind === "issue");
          counts = countBoard(issues);
          maps = issues.filter((item) => item.isMap).map((item) => ({ number: item.number, title: item.title }));
        } else if (!board.ok) {
          repoProblem = board.detail;
        } else if (!board.result.ok) {
          repoProblem = board.result.detail;
        }
      }
      return ok({
        ok: true,
        pluginVersion: PLUGIN_VERSION,
        node: status.node,
        repo,
        repoProblem,
        backend: resolved.ok ? resolved.kind : effectiveBackend(getSettings().backend, ""),
        gh: status.gh,
        counts,
        maps,
      });
    },
  },
  {
    name: "deck_context",
    description:
      "Compact workspace context for planning: repository, counts by readiness, map issues, the top ready tickets and what blocks the rest. Call it at the start of a session instead of reading the whole board. Read-only.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max ready/blocked entries, 1-20, default 5." } },
      additionalProperties: false,
    },
    async run(args, context) {
      const inputResult = asInput(z.strictObject({ limit: z.number().int().min(1).max(20).optional() }), args);
      if (!inputResult.ok) return fail("invalid", inputResult.error);
      const limit = inputResult.data.limit ?? 5;
      const read = await readBoard(context.workspaceDir, { limit: 100 });
      if (!read.ok) return fail(read.reason, read.detail);
      const listed = read.result;
      if (!listed.ok) return failureOf(listed);
      const issues = listed.issues.filter((item) => item.kind === "issue");
      const counts = countBoard(issues);
      const open = issues.filter((item) => item.state === "OPEN");
      const brief = (item: (typeof issues)[number]) => ({
        number: item.number,
        title: item.title,
        readiness: item.readiness,
        labels: item.labels.map((label) => label.name),
        assignees: item.assignees,
        blockedBy: item.blockedBy.filter((blocker) => blocker.state === "OPEN").map((blocker) => blocker.number),
      });
      return ok({
        ok: true,
        repo: repoLabel(read.repo),
        counts,
        maps: open.filter((item) => item.isMap).map(brief),
        ready: open.filter((item) => item.readiness === "ready").slice(0, limit).map(brief),
        blocked: open.filter((item) => item.readiness === "blocked").slice(0, limit).map(brief),
        hasMore: listed.hasMore,
        source: listed.source,
      });
    },
  },
] as const;

/** 不需要用户逐次确认的工具：全是只读。写工具故意不在这个名单里。 */
export const PREAPPROVED_TOOL_NAMES: readonly string[] = [
  "deck_issues_list",
  "deck_issue_get",
  "deck_map",
  "deck_next_steps",
  "deck_pull_requests_list",
  "deck_probe",
  "deck_context",
];

export function findTool(name: string): ToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
