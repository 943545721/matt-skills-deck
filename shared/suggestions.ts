/**
 * `suggest_next_steps` 的校验、截断与排序。
 *
 * 这个工具的参数里直接带着给界面用的建议清单：界面从 tool_call 的参数本身读走建议、
 * 渲染成可点的气泡；工具这边只做校验、钳制、截断，不写票、不落任何状态。
 *
 * 契约与 DSH 一致：
 * - 2~4 条；少于 2 条整次拒绝，多于 4 条按优先级留下前 4 条；
 * - 每条的 intro / prompt / reason 必填（trim 后为空即拒绝），超长按 Unicode 码点截断并补省略号；
 * - priority 可选，0~10 的有效数字钳到区间内并保留一位小数；没给或不是数字按「没打分」处理，
 *   排序时统一排在最后。
 *
 * 为什么用码点而不是 slice：UTF-16 单元切在代理对中间会切出半个字符，界面显示成乱码。
 */

/** 一条通过校验的建议。priority 缺省表示「没打分」，排序时排在最后。 */
export interface SuggestedStep {
  intro: string;
  prompt: string;
  reason: string;
  priority?: number;
}

/** 工具与界面共用的硬边界；参数模式里不写 minItems / maxItems，由这里保证。 */
export const SUGGEST_LIMITS = {
  minItems: 2,
  maxItems: 4,
  introMax: 10,
  promptMax: 500,
  reasonMax: 200,
  priorityMin: 0,
  priorityMax: 10,
} as const;

export type SuggestionResult = { ok: true; items: SuggestedStep[] } | { ok: false; error: string };

/** 工具名：对外精确名字，不带 deck_ 前缀；界面按它认出「这次调用是建议工具」。 */
export const SUGGEST_TOOL_NAME = "suggest_next_steps";

/** 工具定义（唯一事实）：模型看到的参数表与说明都从这里出。 */
export const SUGGEST_DEFINITION = {
  name: SUGGEST_TOOL_NAME,
  description:
    "Recommend 2-4 next-step prompts at the end of a reply; the client renders them as clickable bubbles. " +
    "Only call this when there is a concrete next step: not while work is unfinished, not while waiting for the user's answer, and not for a polite wrap-up. " +
    "Start each prompt with the /skill command for that step when one exists.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description:
          "2-4 next steps, ordered from what should happen first. More than 4: keep the highest priority 4. Fewer than 2: the whole call is rejected. " +
          "Start each prompt with the matching /skill command (for example /to-tickets, /diagnose, /research); only use plain prose when no skill fits.",
        items: {
          type: "object",
          properties: {
            intro: {
              type: "string",
              description: "One short line (at most 10 characters) saying what this step does; only this line shows on the bubble.",
            },
            prompt: {
              type: "string",
              description:
                "The executable next-step prompt (at most 500 characters). Name the concrete object: issue number, path, branch. Never write vague filler such as 'keep going'.",
            },
            reason: {
              type: "string",
              description:
                "One line (at most 200 characters) on why now: what is blocked, what this unlocks, what happens if skipped. Do not restate the prompt.",
            },
            priority: {
              type: "number",
              description:
                "Optional 0-10 priority; higher means do it sooner. 9-10 for work that blocks others, 6-8 for convenient follow-ups. Omit when unsure: unscored items sort last.",
            },
          },
          required: ["intro", "prompt", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** 按 Unicode 码点截断：没超长原样返回；超长切到上限以内并在末尾补一个省略号。 */
export function clipSuggestionText(text: string, max: number): { text: string; clipped: boolean } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, clipped: false };
  return { text: chars.slice(0, Math.max(1, max - 1)).join("") + "…", clipped: true };
}

/**
 * 优先级归一化：有效数字钳到 0~10 并留一位小数；不是数字、NaN、无穷大一律当没打分。
 *
 * 为什么返回 undefined 而不是 0：0 是「最后再做」，没打分是「不知道」；两者排序位置不同。
 */
function normalizePriority(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(SUGGEST_LIMITS.priorityMax, Math.max(SUGGEST_LIMITS.priorityMin, value));
  return Math.round(clamped * 10) / 10;
}

/**
 * 校验并整理 `{ items: [{ intro, prompt, reason, priority? }] }`。
 *
 * 拒绝是整次拒绝：只要有一条缺字段，就不返回任何建议，避免界面显示半份清单。
 * 超过 4 条时先按 priority 排序再截断，所以被截掉的永远是分最低或没打分的。
 */
export function normalizeSuggestions(input: unknown): SuggestionResult {
  if (!isRecord(input)) {
    return { ok: false, error: "参数必须是一个对象：{ items: [...] }。" };
  }
  const raw = input.items;
  if (!Array.isArray(raw)) {
    return { ok: false, error: "items 必须是数组：一次给 2~4 条建议。" };
  }
  if (raw.length < SUGGEST_LIMITS.minItems) {
    return {
      ok: false,
      error: `这次只有 ${raw.length} 条建议，少于 ${SUGGEST_LIMITS.minItems} 条：请一次给 2~4 条再调一次。`,
    };
  }

  const items: SuggestedStep[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!isRecord(entry)) {
      return { ok: false, error: `第 ${index + 1} 条建议不是一个对象：每条都要有 intro、prompt 与 reason。` };
    }
    const intro = asString(entry.intro).trim();
    const prompt = asString(entry.prompt).trim();
    const reason = asString(entry.reason).trim();
    if (!intro || !prompt || !reason) {
      return {
        ok: false,
        error: `第 ${index + 1} 条建议缺简介、提示词或理由：每条都要有非空的 intro、prompt 与 reason。`,
      };
    }
    const priority = normalizePriority(entry.priority);
    const clippedIntro = clipSuggestionText(intro, SUGGEST_LIMITS.introMax).text;
    const clippedPrompt = clipSuggestionText(prompt, SUGGEST_LIMITS.promptMax).text;
    const clippedReason = clipSuggestionText(reason, SUGGEST_LIMITS.reasonMax).text;
    items.push(
      priority === undefined
        ? { intro: clippedIntro, prompt: clippedPrompt, reason: clippedReason }
        : { intro: clippedIntro, prompt: clippedPrompt, reason: clippedReason, priority },
    );
  }

  // 稳定排序（ES2019 起 Array.prototype.sort 稳定）：并列保持模型给的相对顺序；
  // 没打分的统一放末尾，彼此也保持原顺序。
  const ranked = [...items].sort((left, right) => {
    const a = left.priority;
    const b = right.priority;
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    return b - a;
  });

  return { ok: true, items: ranked.slice(0, SUGGEST_LIMITS.maxItems) };
}
