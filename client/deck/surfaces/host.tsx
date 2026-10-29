import type { PaseoApi } from "@getpaseo/client";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ComponentType, ReactNode } from "react";
import { readSurfaceServerId } from "../session/prefill.ts";
import { DeckDirectory } from "./registry.ts";
import type { AgentInfo, WorkspaceInfo } from "./registry.ts";

/**
 * 把 `client.paseo` / `client.rpc` 和 agent / workspace 小目录交给组件。
 *
 * 为什么不直接用 `usePaseo()`：一个 App 里可能同时连着多台 host，
 * 而我们的 popover、pill、时间线渲染器都是在注册闭包里知道「自己属于哪个 client」。
 * 在这一层绑定，组件里就不会拿到另一台 host 的 API。
 */

export interface DeckHostValue {
  client: PluginClientContext;
  paseo: PaseoApi;
  directory: DeckDirectory;
  /** 当前界面所属 host 的 serverId；也是宿主草稿 store key 的第二段。 */
  serverId: string;
}

const DeckHostContext = createContext<DeckHostValue | null>(null);

export function DeckHostProvider({
  client,
  directory,
  serverId,
  children,
}: {
  client: PluginClientContext;
  directory: DeckDirectory;
  serverId: string;
  children: ReactNode;
}) {
  const value = useMemo<DeckHostValue>(
    () => ({ client, paseo: client.paseo, directory, serverId }),
    [client, directory, serverId],
  );
  return <DeckHostContext.Provider value={value}>{children}</DeckHostContext.Provider>;
}

export function useDeckHost(): DeckHostValue {
  const value = useContext(DeckHostContext);
  if (!value) throw new Error("Deck surfaces must be rendered inside DeckHostProvider");
  return value;
}

/**
 * 注册时把宿主组件包进 provider；同一 client 的所有面共享一份目录。
 *
 * 每个宿主界面 props 都带 `host.id`，它等于 `installation.serverId`，
 * 也就是草稿 store key 里的 serverId。公开的 `PluginClientContext` 没有
 * 这个字段，所以必须在这里从 props 取，不能从 client 上猜。
 */
export function bindHost<Props extends object>(
  client: PluginClientContext,
  directory: DeckDirectory,
  Component: ComponentType<Props>,
): ComponentType<Props> {
  function DeckHostBound(props: Props) {
    return (
      <DeckHostProvider client={client} directory={directory} serverId={readSurfaceServerId(props)}>
        <Component {...props} />
      </DeckHostProvider>
    );
  }
  DeckHostBound.displayName = `DeckHostBound(${Component.displayName ?? Component.name ?? "Component"})`;
  return DeckHostBound;
}

export interface AgentState {
  agent: AgentInfo | null;
  pending: boolean;
  error: string | null;
}

export function useDeckAgent(agentId: string | undefined): AgentState {
  const { directory } = useDeckHost();
  const agent = useSyncExternalStore(directory.subscribe, () => (agentId ? directory.getAgent(agentId) : null));
  const pending = useSyncExternalStore(directory.subscribe, () => (agentId ? directory.isAgentPending(agentId) : false));
  const error = useSyncExternalStore(directory.subscribe, () => (agentId ? directory.getAgentError(agentId) : null));
  useEffect(() => {
    if (agentId) directory.ensureAgent(agentId);
  }, [directory, agentId]);
  return { agent, pending, error };
}

export function useDeckWorkspaceProvider(workspaceId: string): string | null {
  const { directory } = useDeckHost();
  return useSyncExternalStore(directory.subscribe, () => directory.getWorkspaceProvider(workspaceId));
}

/** 工作区里的聊天窗口，按最近活动排序；已关闭的不会返回。 */
export function useDeckWorkspaceAgents(workspaceId: string, workspaceDir?: string): AgentInfo[] {
  const { directory } = useDeckHost();
  return useSyncExternalStore(directory.subscribe, () =>
    directory.getWorkspaceAgents(workspaceId, workspaceDir),
  );
}

export interface WorkspaceState {
  workspace: WorkspaceInfo | null;
  /** 已解析的绝对目录；还没解析出来时是空串，调用方必须显示「目录未知」而不是拿空串去读盘。 */
  directory: string;
  pending: boolean;
  error: string | null;
}

export function useDeckWorkspace(workspaceId: string | undefined): WorkspaceState {
  const { directory: registry } = useDeckHost();
  const workspace = useSyncExternalStore(registry.subscribe, () => (workspaceId ? registry.getWorkspace(workspaceId) : null));
  const pending = useSyncExternalStore(registry.subscribe, () => (workspaceId ? registry.isWorkspacePending(workspaceId) : false));
  const error = useSyncExternalStore(registry.subscribe, () => (workspaceId ? registry.getWorkspaceError(workspaceId) : null));
  useEffect(() => {
    if (workspaceId) registry.ensureWorkspace(workspaceId);
  }, [registry, workspaceId]);
  const dir = workspace?.directory ?? "";
  return { workspace, directory: dir, pending: pending && !dir, error: dir ? null : error };
}
