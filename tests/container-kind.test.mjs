import assert from "node:assert/strict";
import { test } from "node:test";
import { containerKindOf } from "../shared/container-kind.ts";
import { parseSpecBody } from "../shared/spec-body.ts";
import { mapIssueNodes } from "../server/tracker/github.ts";
import { mapGitLabIssues } from "../server/tracker/gitlab.ts";

test("DSH 规格头标记优先于 wayfinder:map 标签", () => {
  assert.equal(containerKindOf({ labels: ["wayfinder:map"], body: "<!-- DSH-ISSUE-KIND: spec -->\n# Spec" }), "spec");
  assert.equal(containerKindOf({ body: "# Spec\n\n<!-- DSH-ISSUE-KIND: spec -->" }), null);
  assert.equal(containerKindOf({ labels: ["wayfinder:map"] }), "map");
  assert.equal(containerKindOf({ type: "spec" }), "spec");
  assert.equal(containerKindOf({ labels: ["bug"] }), null);
});

test("规格正文中英文标题解析成 DSH 七区块并过滤头部隐藏标记", () => {
  const result = parseSpecBody([
    "<!-- DSH-ISSUE-KIND: spec -->", "# Checkout", "## 问题陈述", "旧流程容易出错", "## Solution", "Safer flow",
    "## User Stories", "1. As a user, I can check out.", "## Implementation Decisions", "- Keep the API stable",
    "## Testing Decisions", "- Add a regression test", "## Out of Scope", "- Billing", "## Further Notes", "- None",
  ].join("\n"));
  assert.equal(result.problem, "旧流程容易出错");
  assert.equal(result.solution, "Safer flow");
  assert.deepEqual(result.userStories, ["1. As a user, I can check out."]);
  assert.deepEqual(result.implDecisions, ["- Keep the API stable"]);
  assert.deepEqual(result.testDecisions, ["- Add a regression test"]);
  assert.deepEqual(result.outOfScope, ["- Billing"]);
  assert.deepEqual(result.furtherNotes, ["- None"]);
});

test("GitHub 列表映射：读到正文时 spec 标记优先于 map 标签，未读正文时退回标签判断", () => {
  const node = {
    number: 7,
    title: "Checkout spec",
    state: "OPEN",
    url: "https://example.test/7",
    updatedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    labels: { nodes: [{ name: "wayfinder:map", color: "ffffff" }] },
    assignees: { nodes: [] },
    blockedBy: { nodes: [] },
    body: "<!-- DSH-ISSUE-KIND: spec -->\n# Spec",
  };
  const [withBody] = mapIssueNodes([node], "issue");
  assert.equal(withBody.containerKind, "spec");
  assert.equal(withBody.body, node.body);
  const [withoutBody] = mapIssueNodes([{ ...node, body: undefined }], "issue");
  assert.equal(withoutBody.containerKind, "map");
  assert.equal(withoutBody.body, undefined);
});

test("GitLab 列表映射：description 里的 spec 标记同样识别为 spec", () => {
  const [issue] = mapGitLabIssues([
    {
      iid: 9,
      title: "GitLab spec",
      state: "opened",
      description: "<!-- DSH-ISSUE-KIND: spec -->\n## Solution\nDo it",
      labels: ["wayfinder:map"],
      web_url: "https://gitlab.example.test/9",
      updated_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    },
  ]);
  assert.equal(issue.containerKind, "spec");
});
