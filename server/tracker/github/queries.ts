/**
 * GitHub GraphQL 查询原文（按 DSH queries.ts 的字段集合移植）。
 *
 * 约定：
 * - `rateLimit` 是 Query 根字段，必须放在 `repository` 外面；放进去会被 GitHub 以
 *   “Field 'rateLimit' doesn't exist on type 'Repository'” 拒绝整条查询。
 * - 列表是薄行：不取正文；正文与评论只走详情查询。
 * - 依赖边读两位：`blockedBy` 与 `blocking` 必须一起读，只有一边时无法判断真值的完整性。
 */

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;
export const REMOTE_PAGE_LIMIT = 100;
export const COMMENTS_DEFAULT = 100;
export const COMMENTS_MAX = 200;
export const DEPS_MAX = 50;
export const SUB_ISSUES_PAGE_SIZE = 100;
export const SUB_ISSUES_MAX = 1000;
export const LABEL_LIST_LIMIT = 1000;

export type IssueStateFilter = "open" | "closed" | "all";
export type ListKind = "issue" | "pull-request" | "all";

const LABELS = `labels(first:20){totalCount nodes{name color}}`;
const ASSIGNEES = `assignees(first:20){nodes{login}}`;
const BLOCKERS = `blockedBy(first:50){pageInfo{hasNextPage} nodes{number title state}}`;

const ISSUE_LIST_FIELDS = `number title state url createdAt updatedAt ${LABELS} ${ASSIGNEES} ${BLOCKERS}`;

const PR_LIST_FIELDS = `number title state url createdAt updatedAt mergedAt isDraft ${LABELS} ${ASSIGNEES}`;

function statesOf(kind: "issue" | "pull-request", state: IssueStateFilter): string {
  if (kind === "issue") return state === "open" ? "[OPEN]" : state === "closed" ? "[CLOSED]" : "[OPEN,CLOSED]";
  // PR 的 merged 也是 CLOSED；要区分「关了」和「合了」必须带上 MERGED。
  return state === "open" ? "[OPEN]" : state === "closed" ? "[CLOSED,MERGED]" : "[OPEN,CLOSED,MERGED]";
}

export interface ListQueryOptions {
  kind: ListKind;
  state: IssueStateFilter;
  /** 增量刷新：只取这个时间之后更新过的票（ISO 8601）。 */
  since?: string;
  withLabels: boolean;
}

/**
 * 列表查询：issue 与 pullRequest 是两个连接，但共用编号空间。
 * 一次取两个连接是为了让「PR 和票放同一个池里排」拿到同一时刻的快照；
 * 只要一种时只查那一种，省一半点数。
 */
export function listQuery(options: ListQueryOptions): string {
  const variables = ["$owner:String!", "$name:String!", "$first:Int!", "$after:String"];
  if (options.since) variables.push("$since:DateTime!");
  const sinceArg = options.since ? ", filterBy:{since:$since}" : "";
  const parts: string[] = [];
  if (options.kind !== "pull-request") {
    parts.push(`issues(first:$first, after:$after, states:${statesOf("issue", options.state)}, orderBy:{field:UPDATED_AT,direction:DESC}${sinceArg}){
      totalCount pageInfo{hasNextPage endCursor} nodes{${ISSUE_LIST_FIELDS}}
    }`);
  }
  if (options.kind !== "issue") {
    parts.push(`pullRequests(first:$first, after:$after, states:${statesOf("pull-request", options.state)}, orderBy:{field:UPDATED_AT,direction:DESC}${sinceArg}){
      totalCount pageInfo{hasNextPage endCursor} nodes{${PR_LIST_FIELDS}}
    }`);
  }
  const body = options.withLabels ? "rateLimit{cost limit remaining resetAt}\n  " : "rateLimit{cost}\n  ";
  return `query(${variables.join(",")}){
  ${body}repository(owner:$owner,name:$name){
    ${parts.join("\n    ")}
  }
}`;
}

const ISSUE_DETAIL = `number title state url createdAt updatedAt body parent{number}
  ${LABELS} ${ASSIGNEES} ${BLOCKERS}`;

const PR_DETAIL = `number title state url createdAt updatedAt body mergedAt isDraft
  ${LABELS} ${ASSIGNEES}
  reviews(first:20){nodes{state author{login}}}`;

/** 详情查询：评论按页取；`after` 只在往后翻页时出现。 */
export function getIssueQuery(options: { kind: "issue" | "pull-request"; commentsFirst: number; withAfter: boolean }): string {
  const variables = ["$owner:String!", "$name:String!", "$number:Int!", "$commentsFirst:Int!"];
  if (options.withAfter) variables.push("$commentsAfter:String");
  const after = options.withAfter ? ", after:$commentsAfter" : "";
  const field = options.kind === "pull-request" ? "pullRequest" : "issue";
  const detail = options.kind === "pull-request" ? PR_DETAIL : ISSUE_DETAIL;
  return `query(${variables.join(",")}){
  rateLimit{cost}
  repository(owner:$owner,name:$name){
    ${field}(number:$number){
      ${detail}
      comments(first:$commentsFirst${after}){totalCount pageInfo{hasNextPage endCursor} nodes{author{login} createdAt body}}
    }
  }
}`;
}

/** 依赖边读：两位一起读；缺任意一位都按「真值不完整」处理。 */
export const DEPS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      number title state url createdAt updatedAt
      blockedBy(first:50){pageInfo{hasNextPage endCursor} nodes{number title state labels(first:20){nodes{name color}}}}
      blocking(first:50){pageInfo{hasNextPage endCursor} nodes{number title state labels(first:20){nodes{name color}}}}
    }
  }
}`;

/** 计数：两个别名各取 totalCount；state 收窄时另一格按 0 记，不编造。 */
export function countsQuery(options: { withLabels: boolean }): string {
  const variables = ["$owner:String!", "$name:String!"];
  if (options.withLabels) variables.push("$labels:[String!]");
  const filter = options.withLabels ? ", filterBy:{labels:$labels}" : "";
  return `query(${variables.join(",")}){
  repository(owner:$owner,name:$name){
    openIssues: issues(states:[OPEN]${filter}){totalCount}
    closedIssues: issues(states:[CLOSED]${filter}){totalCount}
  }
}`;
}

/** 子票：GraphQL 原生 `subIssues` 连接，按页取，每页最多 100。 */
export const SUB_ISSUES_QUERY = `query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      subIssues(first:$first, after:$after){
        totalCount pageInfo{hasNextPage endCursor}
        nodes{number title state url createdAt updatedAt parent{number} ${LABELS} ${ASSIGNEES} ${BLOCKERS}}
      }
    }
  }
}`;

export const PARENT_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){number updatedAt parent{number title state}}
  }
}`;

export const ADD_BLOCKED_BY_MUTATION = `mutation($issueId:ID!,$blockingIssueId:ID!){
  addBlockedBy(input:{issueId:$issueId, blockingIssueId:$blockingIssueId}){
    issue{number} blockingIssue{number}
  }
}`;

export const REMOVE_BLOCKED_BY_MUTATION = `mutation($issueId:ID!,$blockingIssueId:ID!){
  removeBlockedBy(input:{issueId:$issueId, blockingIssueId:$blockingIssueId}){
    issue{number}
  }
}`;

/** 一次查询把一组票号换成 GraphQL node id（全局 ID）：写一条边要两张票的 id。 */
export function issueNodeIdsQuery(keys: readonly string[]): string {
  const aliases = keys.map((key, index) => `i${index}: issue(number:${key}){id}`).join(" ");
  return `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ ${aliases} } }`;
}

/** viewerPermission 查询：GraphQL 的权限枚举。注意它会把 triage 压平，主路仍读 REST `.permissions`。 */
export const VIEWER_PERMISSION_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){ viewerPermission }
}`;
