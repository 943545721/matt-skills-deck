import type { PaseoApi } from "@getpaseo/client";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PromptActionContext, PromptActionKind } from "../../../shared/session.ts";
import { DECK_COMMAND_KIND, DECK_TIMELINE_VERSION } from "./transformer.ts";

/**
 * `/deck` 在 agent 上下文里的可见结果。
 *
 * slash 回调没有 toast，也不是 React 组件；能在会话里稳定显示、还能点操作的落点
 * 就是一行插件时间线。命令结果写在这里，渲染器负责复制 / 开 SessionSheet。
 * 数据必须 JSON 安全，且远小于 64 KiB：只放命令结果，不把整张票正文塞进来。
 */
export interface DeckCommandAction {
  action: PromptActionKind;
  context: Omit<PromptActionContext, "lang">;
  /** 命令自带的提示词；有的话 SessionSheet 直接用它，不再从动作重新生成。 */
  prompt?: string;
}

export interface DeckCommandData {
  command: string;
  title: string;
  lines: string[];
  workspaceId: string;
  workspaceDir: string;
  agentId?: string;
  copyText?: string;
  openBoard?: boolean;
  session?: DeckCommandAction;
}

/** 一行命令结果的稳定 id 前缀；每次执行独立一行，不覆盖上一次结果。 */
function commandRowId(): string {
  return `deck-command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function appendDeckCommand(paseo: PaseoApi, agentId: string, data: DeckCommandData): Promise<void> {
  await paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    id: commandRowId(),
    kind: DECK_COMMAND_KIND,
    version: DECK_TIMELINE_VERSION,
    // 这里只放字符串/字符串数组；运行时由宿主按 JSON 序列化，类型上用 JsonValue 明确边界。
    data: { ...data } as unknown as JsonValue,
  });
}
