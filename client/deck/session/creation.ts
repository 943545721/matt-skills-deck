/**
 * 新会话落在哪个工作区。
 *
 * 裸 `agents.create({ cwd })` 由宿主按目录重新解析工作区；同一目录下存在多个
 * 工作区时（实测 `wks_7d9f…` 与 `wks_fdf…`），新会话会落到另一个，当前工作区的
 * 「已有会话」列表里就看不到它。所以只要有 `workspaceId` 就必须走
 * `workspaces.ref(workspaceId).agents.create`，没有才退回 cwd。
 */
export type CreationRoute =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "cwd"; cwd: string }
  | { kind: "blocked" };

export function creationRoute(input: {
  workspaceId?: string | null;
  workspaceDir?: string | null;
}): CreationRoute {
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (workspaceId) return { kind: "workspace", workspaceId };
  const cwd = input.workspaceDir?.trim() ?? "";
  if (cwd) return { kind: "cwd", cwd };
  return { kind: "blocked" };
}

/** 创建快照里与「会话到底有没有建出来」有关的字段。 */
export interface CreationSnapshotLike {
  phase?: string | null;
  /** 只有这个对象存在，才证明宿主真的建出了 agent。 */
  agent?: { id?: string | null } | null;
  error?: string | null;
  outcomeUnknown?: boolean;
}

export interface CreationOutcome {
  /** 真实会话 id；accepted 阶段预留的 `agentId` 不算。 */
  agentId: string;
  failed: boolean;
  /** 宿主自己说结果不确定：可能已经建了，也可能没建。 */
  outcomeUnknown: boolean;
  detail: string;
}

/**
 * 读创建快照。
 *
 * 0.13 在 `accepted` 阶段就给请求分配 `agentId`（`randomUUID()`），之后 agent
 * 阶段失败时这个 id 仍留在快照里，但没有 `agent` 字段。把 `agentId` 当成
 * 「已创建」会得到假成功：草稿写进一个不存在的会话，真正的创建错误被吞掉。
 */
export function creationOutcome(snapshot: CreationSnapshotLike | null): CreationOutcome {
  const agentId = snapshot?.agent?.id?.trim() ?? "";
  const detail = snapshot?.error?.trim() ?? "";
  const failed = snapshot?.phase === "failed" || Boolean(detail);
  return {
    agentId,
    failed,
    outcomeUnknown: failed && snapshot?.outcomeUnknown === true,
    detail,
  };
}
