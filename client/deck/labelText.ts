import { LABEL_TEXT_ZH } from "./messages.ts";

/**
 * 标签徽标的显示写法。
 *
 * 标签真名是仓库里的数据：中文界面只翻译插件与技能约定过的那几枚固定标签，
 * 以及 `difficulty:` / `client:` 这两个插件自己拼的前缀。认不出的标签原样返回，
 * 不猜它的意思——翻错一个名字，用户回仓库里就找不到这枚标签。
 *
 * 英文界面直接返回真名：标签名本身就是英文，不需要一份英文副本。
 * 中文词条住在 `messages.ts` 的 `LABEL_TEXT_ZH`，别处不再抄第二份。
 */
const isChinese = (locale: string): boolean => locale.toLowerCase().startsWith("zh");

/**
 * `requirement` → `需求`；`difficulty:hard` → `难度：困难`；`client:claude` → `客户端：claude`。
 *
 * 带值前缀只翻前缀，值原样保留（`claude` 是客户端标识，不是可翻译的词）。
 * 认不出、空值、或缺值（`difficulty:`）一律返回原串。
 */
export function labelDisplayName(name: string, locale: string): string {
  const raw = name.trim();
  if (!raw || !isChinese(locale)) return name;

  const fixed = LABEL_TEXT_ZH[raw.toLowerCase()];
  if (fixed) return fixed;

  const cut = raw.indexOf(":");
  if (cut <= 0 || cut === raw.length - 1) return name;
  const prefix = LABEL_TEXT_ZH[raw.slice(0, cut).toLowerCase()];
  return prefix ? `${prefix}：${raw.slice(cut + 1)}` : name;
}

/**
 * 任务板搜索：标签真名或中文显示名命中即可。
 *
 * 只看真名的话，中文界面把「需求」显示出来、输入「需求」却搜不到；
 * 只看显示名的话，英文界面与想按真名找票的人都对不上。两边都算。
 */
export function labelMatches(name: string, needle: string, locale: string): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) return false;
  return name.toLowerCase().includes(query) || labelDisplayName(name, locale).toLowerCase().includes(query);
}
