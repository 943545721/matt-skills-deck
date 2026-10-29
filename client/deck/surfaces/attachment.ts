import type { PluginClientContext } from "@getpaseo/plugin/client";
import { issueAttachmentSearchRpc } from "../../../shared/slash.ts";
import { surfaceMessages } from "./text.ts";

/**
 * 附件源：把一张票的完整快照挂到会话附件里。
 *
 * Paseo 只把 `{ query }` 交给 search RPC，不提供工作区上下文；
 * 服务端 handler 必须先解析工作区。接线点与契约见 `shared/slash.ts` 报告。
 */
export function contributeAttachment(client: PluginClientContext): () => void {
  return client.addAttachmentSource({
    id: "deck-tickets",
    title: surfaceMessages.message("attachment.title"),
    icon: "Paperclip",
    pickerTitle: surfaceMessages.message("attachment.pickerTitle"),
    searchPlaceholder: surfaceMessages.message("attachment.searchPlaceholder"),
    search: issueAttachmentSearchRpc,
  });
}
