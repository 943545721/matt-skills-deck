import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PluginTimelineItem } from "@getpaseo/plugin";
import type { DeckDirectory } from "../surfaces/registry.ts";
import { bindHost } from "../surfaces/host.tsx";
import { CommandCard } from "./CommandCard.tsx";
import { SuggestionsCard } from "./SuggestionsCard.tsx";
import { WorkRouteCard } from "./WorkRouteCard.tsx";
import { commandDataSchema, suggestDataSchema, workRouteDataSchema } from "./schemas.ts";
import type { CommandData, SuggestData, WorkRouteData } from "./schemas.ts";
import {
  DECK_COMMAND_KIND,
  DECK_SUGGEST_KIND,
  DECK_TIMELINE_VERSION,
  DECK_WORK_ROUTE_KIND,
  transformToolCall,
} from "./transformer.ts";
import type { ToolCallLike } from "./transformer.ts";

/**
 * 注册时间线的 transformer / renderer。
 *
 * transformer 只接管 `tool_call`：
 * - `suggest_next_steps` → 建议气泡；
 * - `deck_issue_report` 成功 → 工作路线卡。
 * 其余工具行与失败状态原样保留，错误不能被一张好看的卡片藏掉。
 */
export function contributeTimeline(client: PluginClientContext, directory: DeckDirectory): () => void {
  const transform = client.addTimelineTransformer<"tool_call">({
    id: "deck-tool-results",
    query: { itemType: "tool_call" },
    transform: ({ item, phase }) => {
      // 宿主的时间线联合类型与纯函数只声明它真正读取的字段；边界上收窄一次，
      // 纯函数仍可在 Node 测试里用最小对象驱动，不依赖整个宿主联合。
      const result = transformToolCall(item as unknown as ToolCallLike, phase);
      if (!result) return undefined;
      // transformer 的 data 在契约里是 JsonValue；纯函数的返回是结构化对象，边界上收一次。
      return { items: result.items as unknown as PluginTimelineItem[] };
    },
  });

  const suggestions = client.addTimelineRenderer({
    kind: DECK_SUGGEST_KIND,
    version: DECK_TIMELINE_VERSION,
    schema: suggestDataSchema,
    Component: bindHost<PluginTimelineItemProps<SuggestData>>(client, directory, SuggestionsCard),
  });
  const workRoute = client.addTimelineRenderer({
    kind: DECK_WORK_ROUTE_KIND,
    version: DECK_TIMELINE_VERSION,
    schema: workRouteDataSchema,
    Component: bindHost<PluginTimelineItemProps<WorkRouteData>>(client, directory, WorkRouteCard),
  });
  const command = client.addTimelineRenderer({
    kind: DECK_COMMAND_KIND,
    version: DECK_TIMELINE_VERSION,
    schema: commandDataSchema,
    Component: bindHost<PluginTimelineItemProps<CommandData>>(client, directory, CommandCard),
  });

  return () => {
    void transform();
    void suggestions();
    void workRoute();
    void command();
  };
}
