import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DeckPillContent } from "./pill.tsx";
import { bindHost } from "./host.tsx";
import type { DeckDirectory } from "./registry.ts";
import { surfaceMessages } from "./text.ts";

interface AgentEntry {
  id: string;
  workspaceId?: string | null;
}

/**
 * 动态 composer pill。
 *
 * 每个 agent 一枚；订阅 `agents.list({ subscribe })`：
 * - snapshot 全量重置（重连后 id 可能变）；
 * - upsert：没有就注册，已有就保留（popover 自己订阅目录里的实时状态，
 *   不为一次状态变化拆掉用户正打开的弹层）；
 * - remove：移除。
 *
 * 没有 workspaceId 的 agent 跳过：宿主注册契约要求两者都有。
 */
export function contributePills(client: PluginClientContext, directory: DeckDirectory): () => void {
  const pills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const lifetime = new AbortController();

  const register = (agent: AgentEntry): void => {
    if (lifetime.signal.aborted || !agent.workspaceId || !agent.id || pills.has(agent.id)) return;
    const workspaceId = agent.workspaceId;
    const agentId = agent.id;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "deck-agent-pill",
        workspaceId,
        agentId,
        button: {
          title: surfaceMessages.message("pill.title"),
          label: surfaceMessages.message("pill.label"),
          icon: "ListChecks",
          behavior: {
            kind: "popover",
            Content: bindHost(client, directory, DeckPillContent),
          },
        },
      }),
    );
  };

  const removeAll = (): void => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent as AgentEntry);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            register(update.agent as AgentEntry);
            return;
          }
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("Deck: composer pill observation failed", error);
    });

  return () => {
    lifetime.abort();
    removeAll();
  };
}
