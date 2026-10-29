import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCreateKind } from "../shared/issue-kind.ts";
import { createSchema } from "../shared/tool-contract.ts";
import {
  DECK_TOOL_ORDER,
  EXTENSION_TOOL_ORDER,
  ISSUE_KINDS,
  MAP_TICKET_LABELS,
  TOOL_ALIASES,
  TOOL_SPECS,
  canonicalToolName,
} from "../shared/tool-contract.ts";
import { SUGGEST_DEFINITION, SUGGEST_TOOL_NAME } from "../shared/suggestions.ts";
import { MCP_TOOLS, PREAPPROVED_TOOL_NAMES, findTool } from "../server/mcp/tools.ts";

/**
 * 工具契约的静态断言：名字、别名、冻结顺序、schema 必填与参数面。
 * 这里不调 gh、不写盘；真正执行路径由 mcp-tools.test.mjs 的假 gh 覆盖。
 */

const tool = (name) => {
  const found = findTool(name);
  assert.ok(found, `工具不存在：${name}`);
  return found;
};

const properties = (name) => tool(name).inputSchema.properties;

test("DECK_TOOL_ORDER：九个冻结工具的精确顺序", () => {
  assert.deepEqual(DECK_TOOL_ORDER, [
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
  assert.equal(Object.isFrozen(DECK_TOOL_ORDER), true);
});

test("别名：旧名归一成新名，新名原样返回；注册表不出现重复条目", () => {
  assert.deepEqual(TOOL_ALIASES, {
    deck_issues_list: "deck_issue_list",
    deck_map: "deck_map_snapshot",
  });
  assert.equal(canonicalToolName("deck_issues_list"), "deck_issue_list");
  assert.equal(canonicalToolName("deck_map"), "deck_map_snapshot");
  assert.equal(canonicalToolName("deck_issue_list"), "deck_issue_list");
  assert.equal(canonicalToolName("suggest_next_steps"), "suggest_next_steps");

  assert.equal(findTool("deck_issues_list"), findTool("deck_issue_list"));
  assert.equal(findTool("deck_map"), findTool("deck_map_snapshot"));
  assert.ok(!MCP_TOOLS.some((item) => item.name === "deck_issues_list"));
  assert.ok(!MCP_TOOLS.some((item) => item.name === "deck_map"));
});

test("旧名仍可调用：别名请求进到新名的 handler，参数错按工具错误返回", async () => {
  const listed = await findTool("deck_issues_list").run(
    { label: "wayfinder:map" },
    { workspaceDir: "/nonexistent-deck-workspace" },
  );
  assert.equal(listed.isError, true);
  const payload = JSON.parse(listed.text);
  assert.equal(payload.reason, "invalid");
  // 多给的键被拒绝，而不是静默丢弃后当成「已过滤」。
  assert.match(payload.detail, /label/);

  const snapshot = await findTool("deck_map").run({}, { workspaceDir: "/nonexistent-deck-workspace" });
  assert.equal(snapshot.isError, true);
  assert.equal(JSON.parse(snapshot.text).reason, "invalid");

  const suggest = tool(SUGGEST_TOOL_NAME);
  const rejected = await suggest.run({ items: [{ intro: "只有一条", prompt: "x", reason: "y" }] }, { workspaceDir: "/tmp" });
  assert.equal(rejected.isError, true);
  assert.equal(JSON.parse(rejected.text).reason, "invalid");
});

test("注册表：冻结九工具 + 扩展工具，顺序与契约一致、名字不重复", () => {
  assert.deepEqual(
    MCP_TOOLS.map((item) => item.name),
    [...DECK_TOOL_ORDER, ...EXTENSION_TOOL_ORDER],
  );
  assert.equal(new Set(MCP_TOOLS.map((item) => item.name)).size, MCP_TOOLS.length);
  for (const name of [...DECK_TOOL_ORDER, ...EXTENSION_TOOL_ORDER]) {
    assert.ok(TOOL_SPECS[name] || name === SUGGEST_TOOL_NAME, `缺少 schema：${name}`);
  }
  for (const name of DECK_TOOL_ORDER) assert.ok(TOOL_SPECS[name], `九工具缺 schema：${name}`);
});

test("每个工具都有可读说明、object 入参，并且拒绝额外键", () => {
  for (const item of MCP_TOOLS) {
    assert.equal(typeof item.description, "string", item.name);
    assert.ok(item.description.length > 20, `${item.name} 的说明太短`);
    assert.equal(item.inputSchema.type, "object", item.name);
    assert.equal(item.inputSchema.additionalProperties, false, item.name);
  }
});

test("deck_issue_create：六种 kind、map-ticket 标签与 DSH 扩展参数都在 schema 里", () => {
  const spec = tool("deck_issue_create").inputSchema;
  assert.deepEqual(spec.required, ["title", "kind"]);
  assert.deepEqual(ISSUE_KINDS, ["map", "map-ticket", "spec", "spec-ticket", "bug", "issue"]);
  assert.deepEqual(spec.properties.kind.enum, ISSUE_KINDS);
  assert.deepEqual(MAP_TICKET_LABELS, [
    "wayfinder:research",
    "wayfinder:prototype",
    "wayfinder:grilling",
    "wayfinder:task",
  ]);
  assert.deepEqual(spec.properties.label.enum, MAP_TICKET_LABELS);
  for (const key of ["parentKey", "blockedBy", "idempotencyKey", "originalWords", "workRouteDetail"]) {
    assert.ok(spec.properties[key], `缺少参数：${key}`);
  }
  assert.deepEqual(spec.properties.originalWords.required, ["text", "source"]);
});

test("deck_issue_create：label 认文档写的 wayfinder:<kind>，也认不带前缀的旧写法", () => {
  // 早先入参校验只认不带前缀的，于是 schema 和文档写的 wayfinder:task 反而被拒；
  // 同时下游 resolveCreateKind 只认带前缀的，两层正好对反。这里把两层都钉住。
  const base = { title: "子票", kind: "map-ticket", parentKey: "2" };
  for (const label of MAP_TICKET_LABELS) {
    const parsed = createSchema.safeParse({ ...base, label });
    assert.equal(parsed.success, true, `${label} 该被收：${JSON.stringify(parsed.error?.issues)}`);
    // 下游只认带前缀的写法：校验层放行，就必须是下游也能认的那一种。
    const resolved = resolveCreateKind({ kind: "map-ticket", label, parentKey: "2" });
    assert.equal(resolved.ok, true, `${label} 下游该认：${resolved.problem}`);
    assert.equal(resolved.label, label);
  }
  assert.equal(createSchema.safeParse({ ...base, label: "task" }).success, true, "不带前缀的旧写法仍收");
  assert.equal(createSchema.safeParse({ ...base, label: "urgent" }).success, false, "别的词仍要拒");
});

test("deck_issue_patch：key 必填，DSH 的改票参数齐全，重开不在参数面里", () => {
  const spec = tool("deck_issue_patch").inputSchema;
  assert.deepEqual(spec.required, ["key"]);
  for (const key of [
    "key",
    "comment",
    "addLabels",
    "removeLabels",
    "assignees",
    "title",
    "body",
    "originalWords",
    "progress",
    "close",
    "closeReason",
    "workRouteDetail",
  ]) {
    assert.ok(spec.properties[key], `缺少参数：${key}`);
  }
  assert.deepEqual(spec.properties.progress.required, ["percent", "note"]);
  assert.equal(spec.properties.close.type, "boolean");
  // 只有 close:true；重开不在这个工具上。
  assert.equal(spec.properties.close.enum, undefined);
});

test("deck_issue_list：state / type / labels / assignee / query / limit", () => {
  const spec = tool("deck_issue_list").inputSchema;
  assert.equal(spec.required, undefined);
  assert.deepEqual(spec.properties.state.enum, ["open", "closed", "all"]);
  assert.deepEqual(spec.properties.type.enum, ["issue", "map", "spec", "all"]);
  assert.equal(spec.properties.labels.type, "array");
  assert.equal(spec.properties.assignee.type, "string");
  assert.equal(spec.properties.query.type, "string");
  assert.equal(spec.properties.limit.type, "number");
});

test("deck_map_snapshot：key 必填，frontierOnly 与 detail(full|thin)", () => {
  const spec = tool("deck_map_snapshot").inputSchema;
  assert.deepEqual(spec.required, ["key"]);
  assert.equal(spec.properties.frontierOnly.type, "boolean");
  assert.deepEqual(spec.properties.detail.enum, ["full", "thin"]);
});

test("deck_issue_report：key / note / workRouteDetail / release，progress 已退役", () => {
  const spec = tool("deck_issue_report").inputSchema;
  assert.deepEqual(spec.required, ["key"]);
  for (const key of ["key", "note", "workRouteDetail", "release"]) {
    assert.ok(spec.properties[key], `缺少参数：${key}`);
  }
  assert.equal(spec.properties.progress, undefined);
});

test("suggest_next_steps：items 必填，条目三项必填", () => {
  const parameters = SUGGEST_DEFINITION.parameters;
  assert.deepEqual(parameters.required, ["items"]);
  assert.deepEqual(parameters.properties.items.items.required, ["intro", "prompt", "reason"]);
  const listed = MCP_TOOLS.find((item) => item.name === SUGGEST_TOOL_NAME);
  assert.ok(listed);
  assert.deepEqual(listed.inputSchema.required, ["items"]);
  assert.equal(listed.description, SUGGEST_DEFINITION.description);
});

test("说明文字只点名真实注册的工具：没有过期的旧名", () => {
  const mentioned = new Set();
  for (const text of [SUGGEST_DEFINITION.description, ...MCP_TOOLS.map((item) => item.description)]) {
    for (const match of text.matchAll(/\bdeck_[a-z_]+/g)) mentioned.add(match[0]);
  }
  assert.ok(mentioned.size > 0, "说明里至少应提到一个工具名");
  for (const name of mentioned) {
    assert.ok(findTool(name), `说明里提到不存在的工具：${name}`);
    assert.equal(canonicalToolName(name), name, `说明里不应再点旧名：${name}`);
  }
});

test("preapproved 只有只读工具，且每个名字都真实存在", () => {
  for (const name of PREAPPROVED_TOOL_NAMES) {
    assert.ok(MCP_TOOLS.some((item) => item.name === name), `${name} 不在工具表里`);
  }
  const writeTools = [
    "deck_issue_comment",
    "deck_issue_create",
    "deck_issue_labels",
    "deck_issue_patch",
    "deck_issue_report",
    "deck_map_link",
    "deck_map_plan_create",
  ];
  for (const name of writeTools) {
    assert.ok(!PREAPPROVED_TOOL_NAMES.includes(name), `${name} 不该被预授权`);
  }
});
