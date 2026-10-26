import type { Lang, MessageKey } from "./i18n";
import { t } from "./i18n";

/** 失败原因码 → 文案键。写成显式表而不是拼字符串，拼出来的键 ts 认不出来，也就防不住手误。 */
const FAILURE_KEYS: Record<string, MessageKey> = {
  "no-repo": "failure.no-repo",
  "unsupported-host": "failure.unsupported-host",
  "gh-missing": "failure.gh-missing",
  "gh-failed": "failure.gh-failed",
  "not-found": "failure.not-found",
  invalid: "failure.invalid",
};

/** 失败原因 → 一句人话。读写共用，避免两处各写一套话术。 */
export function failureText(lang: Lang, reason: string): string {
  return t(lang, FAILURE_KEYS[reason] ?? "failure.read");
}

/**
 * 标签配色直接取仓库里配置的十六进制值，再用亮度决定字色。
 * 不统一成主题色：标签色本身是用户表达（谁负责、处于什么环节），抹平它等于丢掉信息。
 */
export function readableText(hex: string): "#000000" | "#ffffff" {
  const raw = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return "#000000";
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#000000" : "#ffffff";
}

/**
 * 把票面拼成一段可以直接粘进 Agent 输入框的文字。
 *
 * Paseo 没有「一键填入输入框」的接口，所以这里只负责产出文本、由用户粘到想粘的地方；
 * 带上链接是因为 Agent 需要它去读全文，而不是靠这段截断的正文猜。
 */
export function promptForIssue(
  lang: Lang,
  input: {
    number: number;
    title: string;
    url: string;
    body: string;
    labels: readonly { name: string }[];
  },
): string {
  const labels = input.labels.map((label) => label.name).join(", ");
  const head = t(lang, "issue.promptTitle", { number: input.number, title: input.title });
  const linkLabel = lang === "zh" ? "链接" : "Link";
  const labelsLabel = lang === "zh" ? "标签" : "Labels";
  const noBody = lang === "zh" ? "（这张票没有正文，请按标题判断）" : "(No body — judge by the title)";
  return [
    head,
    input.url ? `${linkLabel}：${input.url}` : "",
    labels ? `${labelsLabel}：${labels}` : "",
    "",
    input.body.trim() || noBody,
  ]
    .filter((line, index) => line !== "" || index === 3)
    .join("\n");
}
