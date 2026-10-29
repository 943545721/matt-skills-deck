import type { PaseoApi } from "@getpaseo/client";
import { matchesWorkspaceScope, normalizeSessionDir, rankSessionCandidates } from "../../../shared/session.ts";
import { PARENT_AGENT_ID_LABEL } from "../../../shared/orchestration.ts";

/**
 * 客户端侧的 agent / workspace 小目录。
 *
 * 为什么需要：pill、popover、agent panel、时间线渲染器拿到的只有 id，
 * 而读票、开会话都需要 `workspaceId → 目录`、`agentId → provider/model/忙碌态`。
 * 宿主没有「当前选中 agent」的全局上下文，所以这里订阅两条 list 流，自己维护。
 *
 * 规则与官方 pill 示例一致：
 * - 初始 snapshot 全量重置（重连后 id 可能变，不能增量合并）；
 * - `agent_update` 的 upsert / remove 逐条改；
 * - 插件 client 生命周期结束时由调用方 `dispose()`，不把定时器/订阅留给宿主。
 */

export interface AgentInfo {
  id: string;
  workspaceId: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  provider: string;
  model: string | null;
  title: string | null;
  cwd: string | null;
  updatedAt: string | null;
  lastUserMessageAt: string | null;
  /**
   * 父会话 id（宿主建的子会话才有）。
   *
   * 快照里有 `parentAgentId` 就用它，没有才读标签 `paseo.parent-agent-id`——
   * 已归档的会话在快照里可能只剩标签。两种情况都读不到才当它是根会话，
   * 不按「有没有 deck.child 标签」判断：宿主自己派的子代理同样带这层关系。
   */
  parentAgentId: string | null;
}

export interface WorkspaceInfo {
  id: string;
  directory: string;
  name: string;
  title: string | null;
}

interface AgentEntryLike {
  id: string;
  workspaceId?: string | null;
  status: AgentInfo["status"];
  provider: string;
  model?: string | null;
  title?: string | null;
  cwd?: string | null;
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
  parentAgentId?: string | null;
  labels?: Record<string, string>;
}

interface WorkspaceEntryLike {
  id: string;
  /** SDK 的 workspace 描述用 `workspaceDirectory`；插件快照里的同名字段叫 `directory`。 */
  workspaceDirectory?: string;
  directory?: string;
  name: string;
  title?: string | null;
}

type Listener = () => void;

const agentInfo = (raw: AgentEntryLike): AgentInfo => ({
  id: raw.id,
  workspaceId: raw.workspaceId ?? null,
  status: raw.status,
  provider: raw.provider,
  model: raw.model ?? null,
  title: raw.title ?? null,
  cwd: raw.cwd ?? null,
  updatedAt: raw.updatedAt ?? null,
  lastUserMessageAt: raw.lastUserMessageAt ?? null,
  parentAgentId: raw.parentAgentId?.trim() || raw.labels?.[PARENT_AGENT_ID_LABEL]?.trim() || null,
});

const workspaceInfo = (raw: WorkspaceEntryLike): WorkspaceInfo => ({
  id: raw.id,
  directory: raw.workspaceDirectory ?? raw.directory ?? "",
  name: raw.name,
  title: raw.title ?? null,
});

export class DeckDirectory {
  private readonly paseo: PaseoApi;
  private agents = new Map<string, AgentInfo>();
  private workspaces = new Map<string, WorkspaceInfo>();
  private workspaceSnapshot: WorkspaceInfo[] = [];
  /** 每个工作区排好序的会话列表；agent 变动时整体失效，快照函数保持引用稳定。 */
  private workspaceAgents = new Map<string, AgentInfo[]>();
  private agentErrors = new Map<string, string>();
  private workspaceErrors = new Map<string, string>();
  private pendingAgents = new Set<string>();
  private pendingWorkspaces = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly lifetime = new AbortController();
  private stopAgents: (() => void) | null = null;
  private stopWorkspaces: (() => void) | null = null;
  private agentObservation: { release(): Promise<void> } | null = null;
  private workspaceObservation: { release(): Promise<void> } | null = null;
  private started = false;

  constructor(paseo: PaseoApi) {
    this.paseo = paseo;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getAgent = (id: string): AgentInfo | null => this.agents.get(id) ?? null;

  getAgentError = (id: string): string | null => this.agentErrors.get(id) ?? null;

  /**
   * 工作区里可以注入的聊天窗口，按最近活动排序。
   *
   * 返回值按工作区缓存，直到 agent 快照变化才重建：`useSyncExternalStore`
   * 的 getSnapshot 必须返回稳定引用，否则每次渲染都会触发重读。
   */
  getWorkspaceAgents = (workspaceId: string, workspaceDir?: string): AgentInfo[] => {
    // 缓存键带上目录：同一 workspaceId 不会变目录，但目录信息可能晚于 agent 快照到达。
    const cacheKey = `${workspaceId}\u0000${normalizeSessionDir(workspaceDir ?? "")}`;
    const cached = this.workspaceAgents.get(cacheKey);
    if (cached) return cached;
    const ranked = rankSessionCandidates(
      [...this.agents.values()].filter((candidate) =>
        matchesWorkspaceScope(
          { workspaceId: candidate.workspaceId, cwd: candidate.cwd },
          workspaceId,
          workspaceDir,
        ),
      ),
    );
    this.workspaceAgents.set(cacheKey, ranked);
    return ranked;
  };

  /** 工作区面板的默认新会话提供方：沿用该工作区当前可用的 agent 配置，跳过 closed/error。 */
  getWorkspaceProvider = (workspaceId: string): string | null => {
    const agent = [...this.agents.values()].find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.status !== "closed" &&
        candidate.status !== "error",
    );
    return agent ? `${agent.provider}${agent.model ? `/${agent.model}` : ""}` : null;
  };

  isAgentPending = (id: string): boolean => this.pendingAgents.has(id);

  getWorkspace = (id: string): WorkspaceInfo | null => this.workspaces.get(id) ?? null;
  getWorkspaces = (): WorkspaceInfo[] => this.workspaceSnapshot;

  getWorkspaceError = (id: string): string | null => this.workspaceErrors.get(id) ?? null;

  isWorkspacePending = (id: string): boolean => this.pendingWorkspaces.has(id);

  /** 组件拿到的 id 可能来自历史时间线：列表里没有时单独 refresh 一次。 */
  ensureAgent(id: string): void {
    if (this.agents.has(id) || this.pendingAgents.has(id) || this.lifetime.signal.aborted) return;
    this.pendingAgents.add(id);
    this.emit();
    this.paseo.agents
      .ref(id)
      .refresh()
      .then((result) => {
        if (result?.agent) this.setAgent(agentInfo(result.agent as AgentEntryLike));
        else this.setAgentError(id, "agent not found");
      })
      .catch((error: unknown) => this.setAgentError(id, messageOf(error)))
      .finally(() => {
        this.pendingAgents.delete(id);
        this.emit();
      });
  }

  ensureWorkspace(id: string): void {
    if (this.workspaces.has(id) || this.pendingWorkspaces.has(id) || this.lifetime.signal.aborted) return;
    this.pendingWorkspaces.add(id);
    this.emit();
    this.paseo.workspaces
      .ref(id)
      .refresh()
      .then((workspace) => {
        if (workspace) this.setWorkspace(workspaceInfo(workspace as WorkspaceEntryLike));
        else this.setWorkspaceError(id, "workspace not found");
      })
      .catch((error: unknown) => this.setWorkspaceError(id, messageOf(error)))
      .finally(() => {
        this.pendingWorkspaces.delete(id);
        this.emit();
      });
  }

  start(): void {
    if (this.started || this.lifetime.signal.aborted) return;
    this.started = true;
    void this.paseo.agents
      .list({ subscribe: {}, signal: this.lifetime.signal })
      .then(({ subscription }) => {
        // 卸载可能发生在 list 返回之前：dispose 已 abort 并清空，这里不能再把订阅挂回去。
        if (this.lifetime.signal.aborted) {
          void subscription.release();
          return;
        }
        this.agentObservation = subscription;
        this.stopAgents = subscription.subscribe({
          snapshot: ({ entries }) => {
            this.agents = new Map(entries.map(({ agent }) => [agent.id, agentInfo(agent as AgentEntryLike)]));
            this.workspaceAgents = new Map();
            this.agentErrors = new Map();
            this.emit();
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") this.setAgent(agentInfo(update.agent as AgentEntryLike));
            else this.removeAgent(update.agentId);
          },
        });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!this.lifetime.signal.aborted) console.error("Deck: agent observation failed", error);
      });

    void this.paseo.workspaces
      .list({ subscribe: {} })
      .then(({ subscription }) => {
        if (this.lifetime.signal.aborted) {
          void subscription.release();
          return;
        }
        this.workspaceObservation = subscription;
        this.stopWorkspaces = subscription.subscribe({
          snapshot: ({ entries }) => {
            this.workspaces = new Map(entries.map((workspace) => [workspace.id, workspaceInfo(workspace as WorkspaceEntryLike)]));
            this.workspaceSnapshot = Array.from(this.workspaces.values());
            this.workspaceErrors = new Map();
            this.emit();
          },
          update: (message) => {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            if (update.kind === "upsert") this.setWorkspace(workspaceInfo(update.workspace as WorkspaceEntryLike));
          },
        });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!this.lifetime.signal.aborted) console.error("Deck: workspace observation failed", error);
      });
  }

  dispose(): void {
    this.lifetime.abort();
    this.stopAgents?.();
    this.stopWorkspaces?.();
    void this.agentObservation?.release();
    void this.workspaceObservation?.release();
    this.stopAgents = null;
    this.stopWorkspaces = null;
    this.agentObservation = null;
    this.workspaceObservation = null;
    this.listeners.clear();
    // 不复位 started：lifetime 已 abort，start() 里的 aborted 守卫会挡住再次启动，
    // 避免「能订阅但 ensure* 全被拒」的不一致状态。
  }

  private setAgent(agent: AgentInfo): void {
    this.agents = new Map(this.agents).set(agent.id, agent);
    this.workspaceAgents = new Map();
    this.agentErrors = new Map(this.agentErrors);
    this.agentErrors.delete(agent.id);
    this.emit();
  }

  private removeAgent(id: string): void {
    if (!this.agents.has(id)) return;
    this.agents = new Map(this.agents);
    this.agents.delete(id);
    this.workspaceAgents = new Map();
    this.emit();
  }

  private setAgentError(id: string, error: string): void {
    this.agentErrors = new Map(this.agentErrors).set(id, error);
    this.emit();
  }

  private setWorkspace(workspace: WorkspaceInfo): void {
    this.workspaces = new Map(this.workspaces).set(workspace.id, workspace);
    this.workspaceSnapshot = Array.from(this.workspaces.values());
    this.workspaceErrors = new Map(this.workspaceErrors);
    this.workspaceErrors.delete(workspace.id);
    this.emit();
  }

  private setWorkspaceError(id: string, error: string): void {
    this.workspaceErrors = new Map(this.workspaceErrors).set(id, error);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
