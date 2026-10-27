import { defineTranslations, useTranslation } from "@getpaseo/plugin/client";
import { en, zh } from "./messages";

/**
 * 文案运行时。
 *
 * `defineTranslations` 一加载就会校验：资源键必须是语言代码、`zh` 里不能有 `en` 没有的键、
 * 同一条文案的占位符必须一致。所以这里的失败是「开发期立刻发现」，而不是界面上冒出一句
 * 半中半英的话。语言本身跟着 App 走（`useTranslation` 返回的 locale），插件不再自带开关。
 */
export const deckMessages = defineTranslations({ resources: { en, zh } });

/** 组件里取 `t` 的唯一入口。抽出来是为了让每个视图的 `t` 都带上同一份资源类型。 */
export function useDeckText() {
  return useTranslation(deckMessages);
}

type FlatKey<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${FlatKey<T[K]>}`;
}[keyof T & string];

/** 全部文案键（点号形式），用于「原因码 → 文案键」这类只能运行时选键的表。 */
export type DeckKey = FlatKey<typeof en>;

export type DeckText = ReturnType<typeof useDeckText>["t"];

/**
 * 查表得到键之后再取文案。
 *
 * 正常调用 `t("board.empty")` 时，类型能检查出「这条文案要不要占位符」；但原因码、
 * 标签页这种「键来自查表」的地方，编译期只知道键是 DeckKey 的并集，拿不到该键的参数形状。
 * 于是把这一处断言收在唯一的地方，而不是散落到每个视图里各写一遍。
 */
export function staticText(t: DeckText, key: DeckKey): string {
  const loose = t as unknown as (key: DeckKey) => string;
  return loose(key);
}

/**
 * 失败原因码 → 文案键。
 *
 * 服务端只回原因码，不回人话：这样同一条失败可以在不同语言下说清楚，
 * 也让「新增一种失败」必须先在这张表里落一个键，不会悄悄漏到界面上变成空白。
 */
export const FAILURE_KEYS: Record<string, DeckKey> = {
  "no-repo": "failure.no-repo",
  "unsupported-host": "failure.unsupported-host",
  "gh-missing": "failure.gh-missing",
  "gh-unauth": "failure.gh-unauth",
  "gh-failed": "failure.gh-failed",
  "not-found": "failure.not-found",
  invalid: "failure.invalid",
  "labels-truncated": "failure.labels-truncated",
  "local-failed": "failure.local-failed",
  "glab-missing": "failure.glab-missing",
  "glab-unauth": "failure.glab-unauth",
  "glab-failed": "failure.glab-failed",
};
