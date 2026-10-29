import { createGhClient, type GhClient, type GhExec } from "./client.ts";
import { readGithubBudget } from "./budget.ts";
import { listIssuesConditional } from "./conditional.ts";
import { listSubIssues, getDependencies, getIssueDetail, listIssuesPage, countIssues, type CountsData, type DetailData, type DetailOptions, type DependencyData, type ListPageData, type ListPageInput, type RepoRef, type SubIssuesData } from "./reads.ts";
import { listLabels, setLabelColors, type LabelColorData, type LabelListData } from "./labels.ts";
import { readRepoPermissions, createPermissionCache, type PermissionCache, type RepoPermissions } from "./permissions.ts";
import { ghPreflight, resolveRepoKey, type GitExec, type PreflightOptions, type PreflightResult, type RepoIdentity } from "./preflight.ts";
import { addComment, addLabel, createIssue, reportIssue, setAssignees, setIssueState, setLabels, updateIssue, type CommentData, type CreateIssueData, type CreateIssueInput, type IssueSnapshot, type LabelData, type ReportInput, type UpdateIssueInput, type WriteResult } from "./writes.ts";
import { readBlockedBy, setBlockedBy, setParent, type BlockedByReadData, type GraphWriteData, type ParentData } from "./graph.ts";
import { initProject, type InitProjectData, type InitProjectInput } from "./init.ts";
import type { ReadResult } from "./reads.ts";
import type { ConditionalListData } from "./conditional.ts";
import type { BudgetRead } from "./budget.ts";
import type { GhBudgetStats } from "./client.ts";

/**
 * 25+ 项操作的统一入口。
 *
 * 每个操作都是普通函数：第一个参数是仓库坐标（或输入对象），返回 `{ok:...}` 信封。
 * `createGithubOperations()` 可以只被调用一次（面板 / MCP 共用同一个 client），
 * 也可以注入 fixture 执行器做测试。client 只记额度与最新限流快照，不缓存业务数据。
 */
export interface GithubOperations {
  readonly client: GhClient;
  readonly permissions: PermissionCache;
  issueList(repo: RepoRef, input?: Omit<ListPageInput, "repo">): Promise<ReadResult<ListPageData>>;
  issueGet(repo: RepoRef, number: number, options?: DetailOptions): Promise<ReadResult<DetailData>>;
  pullList(repo: RepoRef, input?: Omit<ListPageInput, "repo" | "kind">): Promise<ReadResult<ListPageData>>;
  pullGet(repo: RepoRef, number: number, options?: DetailOptions): Promise<ReadResult<DetailData>>;
  subIssueList(repo: RepoRef, number: number): Promise<ReadResult<SubIssuesData>>;
  blockedByRead(repo: RepoRef, number: number): Promise<WriteResult<BlockedByReadData>>;
  dependencyRead(repo: RepoRef, number: number): Promise<ReadResult<DependencyData>>;
  labelList(repo: RepoRef): Promise<ReadResult<LabelListData>>;
  issueCounts(repo: RepoRef, options?: { state?: "open" | "closed" | "all"; labels?: readonly string[] }): Promise<ReadResult<CountsData>>;
  budgetRead(): Promise<BudgetRead>;
  permissionRead(spec: string): Promise<RepoPermissions | null>;
  etagList(repo: RepoRef, options?: { since?: string | null; etag?: string | null }): Promise<ReadResult<ConditionalListData>>;
  preflight(options?: PreflightOptions): Promise<PreflightResult>;
  repoIdentity(cwd: string, execGit?: GitExec): Promise<RepoIdentity | null>;
  issueCreate(repo: RepoRef, input: CreateIssueInput): Promise<WriteResult<CreateIssueData>>;
  issueUpdate(repo: RepoRef, key: string, input: UpdateIssueInput): Promise<WriteResult<IssueSnapshot>>;
  issueClose(repo: RepoRef, key: string, options?: { reason?: string }): Promise<WriteResult<{ state: "OPEN" | "CLOSED"; reason?: string }>>;
  issueReopen(repo: RepoRef, key: string): Promise<WriteResult<{ state: "OPEN" | "CLOSED" }>>;
  issueComment(repo: RepoRef, key: string, body: string): Promise<WriteResult<CommentData>>;
  issueLabelsSet(repo: RepoRef, key: string, labels: readonly string[], options?: { expectedUpdatedAt?: string }): Promise<WriteResult<LabelData>>;
  issueLabelAdd(repo: RepoRef, key: string, label: string): Promise<WriteResult<LabelData>>;
  issueAssigneesSet(repo: RepoRef, key: string, assignees: readonly string[]): Promise<WriteResult<{ assignees: string[] }>>;
  issueParentSet(repo: RepoRef, key: string, parentKey: string | null, options?: { expectedUpdatedAt?: string }): Promise<WriteResult<ParentData>>;
  issueBlockedBySet(repo: RepoRef, key: string, blockers: readonly string[], options?: { expectedUpdatedAt?: string }): Promise<WriteResult<GraphWriteData>>;
  issueReport(repo: RepoRef, input: ReportInput): Promise<WriteResult<CreateIssueData>>;
  labelColorsSet(repo: RepoRef, changes: unknown): Promise<ReadResult<LabelColorData>>;
  projectInit(input: InitProjectInput, execGit?: GitExec): Promise<{ ok: true; data: InitProjectData } | { ok: false; error: unknown }>;
  stats(): GhBudgetStats;
}

/** 操作名清单：用于诊断页与「工具 → 实现」的交叉校验。 */
export const GITHUB_OPERATION_NAMES = [
  "issueList",
  "issueGet",
  "pullList",
  "pullGet",
  "subIssueList",
  "blockedByRead",
  "dependencyRead",
  "labelList",
  "issueCounts",
  "budgetRead",
  "permissionRead",
  "etagList",
  "preflight",
  "repoIdentity",
  "issueCreate",
  "issueUpdate",
  "issueClose",
  "issueReopen",
  "issueComment",
  "issueLabelsSet",
  "issueLabelAdd",
  "issueAssigneesSet",
  "issueParentSet",
  "issueBlockedBySet",
  "issueReport",
  "labelColorsSet",
  "projectInit",
] as const;

export interface GithubOperationsOptions {
  /** 直接注入 client（生产用）；与 `exec` 二选一。 */
  client?: GhClient;
  /** 注入 fixture 执行器（测试用），内部建 client。 */
  exec?: GhExec;
  permissions?: PermissionCache;
}

export function createGithubOperations(options: GithubOperationsOptions = {}): GithubOperations {
  const client = options.client ?? createGhClient(options.exec);
  const permissions = options.permissions ?? createPermissionCache();
  const stats = () => client.stats();

  const ops: GithubOperations = {
    client,
    permissions,
    issueList: (repo, input = {}) => listIssuesPage(client, { ...input, repo }),
    issueGet: (repo, number, detailOptions) => getIssueDetail(client, repo, number, detailOptions),
    pullList: (repo, input = {}) => listIssuesPage(client, { ...input, repo, kind: "pull-request" }),
    pullGet: (repo, number, detailOptions) => getIssueDetail(client, repo, number, { ...detailOptions, kind: "pull-request" }),
    subIssueList: (repo, number) => listSubIssues(client, repo, number),
    blockedByRead: (repo, number) => readBlockedBy(client, repo, number),
    dependencyRead: (repo, number) => getDependencies(client, repo, number),
    labelList: (repo) => listLabels(client, repo),
    issueCounts: (repo, countOptions) => countIssues(client, repo, countOptions),
    budgetRead: () => readGithubBudget(client),
    permissionRead: (spec) => readRepoPermissions(client, spec, permissions),
    etagList: (repo, etagOptions) => listIssuesConditional(client, repo, etagOptions),
    preflight: (preflightOptions) => ghPreflight(client, preflightOptions),
    repoIdentity: (cwd, execGit) => resolveRepoKey(client, cwd, execGit),
    issueCreate: (repo, input) => createIssue(client, repo, input),
    issueUpdate: (repo, key, input) => updateIssue(client, repo, key, input),
    issueClose: (repo, key, closeOptions) => setIssueState(client, repo, key, "closed", closeOptions).then((result) =>
      result.ok ? { ok: true, data: { state: result.data.state, ...(result.data.reason ? { reason: result.data.reason } : {}) } } : result),
    issueReopen: (repo, key) => setIssueState(client, repo, key, "open").then((result) => result.ok ? { ok: true, data: { state: result.data.state } } : result),
    issueComment: (repo, key, body) => addComment(client, repo, key, body),
    issueLabelsSet: (repo, key, labels, labelOptions) => setLabels(client, repo, key, labels, { ...labelOptions, cache: permissions }),
    issueLabelAdd: (repo, key, label) => addLabel(client, repo, key, label),
    issueAssigneesSet: (repo, key, assignees) => setAssignees(client, repo, key, assignees),
    issueParentSet: (repo, key, parentKey, parentOptions) => setParent(client, repo, key, parentKey, parentOptions),
    issueBlockedBySet: (repo, key, blockers, blockedOptions) => setBlockedBy(client, repo, key, blockers, blockedOptions),
    issueReport: (repo, input) => reportIssue(client, repo, input),
    labelColorsSet: (repo, changes) => setLabelColors(client, repo, changes, permissions),
    projectInit: (input, execGit) => initProject(client, input, execGit),
    stats,
  };
  return ops;
}
