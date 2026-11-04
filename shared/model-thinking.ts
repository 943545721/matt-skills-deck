/**
 * 客户端卡片上「每个模型带自己的思考档位」的纯函数。
 *
 * 宿主没有「按模型存档位」的字段，所以这张表存在插件自己的设置里
 * （`OrchestrationSettings.modelThinking`）。派单时它排第二：
 *
 * 1. 档案 / 路由里显式写的 `thinkingOptionId` —— 原样用；
 * 2. 卡片上同 provider + model 的默认档 —— 用它；
 * 3. 都没有 —— 不传，由宿主用模型自己的默认。
 *
 * 解析只此一份：派单、改派、建派单窗口、群发、MCP `deck_dispatch_plan` 五个建会话入口，
 * 外加状态预览与需求批次预览两条展示路径，都经由这里合成，不各自再算一遍。
 * 这里不碰宿主、不读配置，输入全是调用方给的。
 */

import { asRecord, text } from "./coerce.ts";

/** 一条默认档：`provider/model` 对应一个档位 id；id 不写死，来自宿主快照或用户手填。 */
export interface ModelThinkingDefault {
  provider: string;
  model: string;
  thinkingOptionId: string;
}

/** 解析档位时要看的上下文；两块都可缺省，缺省就是「今天的行为」。 */
export interface ThinkingResolutionContext {
  /** 卡片里按模型配的默认档；没有就是没有默认。 */
  modelThinking?: readonly ModelThinkingDefault[];
  /**
   * 每个客户端现在真正能选的模型（空数组 = 这个客户端一个都没选）。
   *
   * 只对出现在这里的客户端做「模型还在不在」的判断：模型被从清单里删掉后，
   * 默认表里的残留条目不再往外传。没出现的客户端（例如只走宿主内置模型）不判。
   */
  modelsByProvider?: Readonly<Record<string, readonly string[]>>;
}

/** 一个目标必须有的三个字段；避免这里依赖 `ClientTarget` 造成循环引用。 */
export interface ThinkingTarget {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
}

/**
 * 这个目标该带哪个思考档位；返回 undefined 表示「不传」。
 *
 * 认不出的档位 id 原样返回：宿主快照与用户手填都可能给出插件不认识的 id，
 * 由宿主裁决（与 #29 的口径一致），插件不替它过滤。
 */
export function resolveThinkingOptionId(
  target: ThinkingTarget,
  context: ThinkingResolutionContext = {},
): string | undefined {
  const explicit = target.thinkingOptionId?.trim();
  if (explicit) return explicit;
  const provider = target.provider.trim();
  const model = target.model?.trim();
  if (!provider || !model) return undefined;
  const entry = (context.modelThinking ?? []).find(
    (item) => item.provider.trim() === provider && item.model.trim() === model,
  );
  const id = entry?.thinkingOptionId.trim();
  if (!id) return undefined;
  const available = context.modelsByProvider?.[provider];
  if (available && !available.includes(model)) return undefined;
  return id;
}

/**
 * 默认档表的**整表**条数上限。
 *
 * 取单个客户端模型清单的写入上限（`orchestrationProviderRpc` 的 `models` 最多 200 条）
 * 作为整表上限：正常配置里一个客户端也就几十个模型，这个数留足了余量；
 * 手改坏了也不会让设置文件无限长。超出部分在归一化时丢掉。
 */
export const MAX_MODEL_THINKING = 200;

/**
 * 默认档表归一：缺字段丢条目，不把整份设置判坏。
 *
 * 同 provider + model 写了多条取第一条：后来的重复项不覆盖人认真配的那条，
 * 与地图预算同一个口径。条数按模型清单的上限封顶。
 */
export function normalizeModelThinking(value: unknown): ModelThinkingDefault[] {
  if (!Array.isArray(value)) return [];
  const out: ModelThinkingDefault[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const provider = text(record.provider);
    const model = text(record.model);
    const thinkingOptionId = text(record.thinkingOptionId);
    if (!provider || !model || !thinkingOptionId) continue;
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, model, thinkingOptionId });
    if (out.length >= MAX_MODEL_THINKING) break;
  }
  return out;
}
