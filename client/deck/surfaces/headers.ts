import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DeckHeaderContent } from "./header.tsx";
import { bindHost } from "./host.tsx";
import type { DeckDirectory } from "./registry.ts";
import { surfaceMessages } from "./text.ts";

interface WorkspaceEntry {
  id: string;
}

/**
 * 每个工作区一枚顶栏按钮。
 *
 * 与 pill 同理：snapshot 全量重置，upsert 只保证存在，内容自己订阅目录拿实时计数。
 * 工作区归档时宿主会移除按钮；这里没有 remove 事件也没有必要自己删。
 */
export function contributeHeaderButtons(client: PluginClientContext, directory: DeckDirectory): () => void {
  const buttons = new Map<string, ReturnType<PluginClientContext["addHeaderButton"]>>();
  const lifetime = new AbortController();
  let stopObserving: (() => void) | null = null;
  let observation: { release(): Promise<void> } | null = null;

  const register = (workspace: WorkspaceEntry): void => {
    if (lifetime.signal.aborted || !workspace.id || buttons.has(workspace.id)) return;
    buttons.set(
      workspace.id,
      client.addHeaderButton({
        id: "deck-workspace-header",
        workspaceId: workspace.id,
        button: {
          title: surfaceMessages.message("header.title"),
          icon: "ListChecks",
          behavior: {
            kind: "popover",
            Content: bindHost(client, directory, DeckHeaderContent),
          },
        },
      }),
    );
  };

  const removeAll = (): void => {
    for (const button of buttons.values()) button.remove();
    buttons.clear();
  };

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      observation = subscription;
      stopObserving = subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const workspace of entries) register(workspace as WorkspaceEntry);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") register(update.workspace as WorkspaceEntry);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("Deck: header button observation failed", error);
    });

  return () => {
    lifetime.abort();
    stopObserving?.();
    void observation?.release();
    removeAll();
  };
}
