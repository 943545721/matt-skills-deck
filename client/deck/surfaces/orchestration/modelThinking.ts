import {
  MAX_MODEL_THINKING,
  normalizeModelThinking,
  resolveThinkingOptionId,
  type ModelThinkingDefault,
} from "../../../../shared/model-thinking.ts";

/**
 * 按「客户端 + 模型」存的默认思考档位。
 *
 * 存在插件自己的设置里（`OrchestrationSettings.modelThinking`），不写宿主配置——
 * 宿主没有按模型存档位的字段。派单时它是第二优先：档案 / 路由里显式设的档位优先，
 * 两处都没有就不传，由宿主用模型自己的默认档。
 *
 * 解析与归一都复用 `shared/model-thinking.ts`：显示、派单、设置读写必须走同一套规则，
 * 否则界面上写着「已配」、派单时却解析不出（或反过来），两边各说各话。
 */

/** 一条默认档：`provider/model` 对应一个档位 id；id 不写死，来自宿主快照或用户手填。 */
export type { ModelThinkingDefault };

/**
 * 这个模型现在配的默认档；没配就是 null。
 *
 * 直接问 shared 的解析器（不传 `modelsByProvider`：显示层只关心「配了什么」，
 * 「模型还在不在」由调用方决定要不要渲染这一行）。
 */
export function thinkingDefaultOf(
  defaults: readonly ModelThinkingDefault[],
  provider: string,
  model: string,
): string | null {
  return resolveThinkingOptionId({ provider, model }, { modelThinking: defaults }) ?? null;
}

/**
 * 设 / 清一个模型的默认档，返回**新的整张表**，不原地改传入的数组。
 *
 * `thinkingOptionId` 为 null 或空白就是清除那一条。写回前的归一与设置读取完全一致：
 * 按 trim 后的 provider + model 去重、丢掉残缺项、按 `MAX_MODEL_THINKING` 封顶，
 * 免得写出去一份 zod 会整单拒绝、或者与读回来的形状不一样的表。
 *
 * 本次设置的那条追加在末尾；表满时从表头丢最旧的一条，保证刚设的档位不会当场被截掉。
 */
export function withModelThinking(
  defaults: readonly ModelThinkingDefault[],
  provider: string,
  model: string,
  thinkingOptionId: string | null,
): ModelThinkingDefault[] {
  const providerId = provider.trim();
  const modelId = model.trim();
  // 先把要改的那条（连同同键的重复项）摘出来，剩下的交给共享的归一化。
  const rest = defaults.filter(
    (item) => !(providerId && modelId && item.provider.trim() === providerId && item.model.trim() === modelId),
  );
  const normalized = normalizeModelThinking(rest);
  const id = (thinkingOptionId ?? "").trim();
  if (!providerId || !modelId || !id) return normalized;
  return [...normalized, { provider: providerId, model: modelId, thinkingOptionId: id }].slice(-MAX_MODEL_THINKING);
}
