/** 失败原因 → 一句人话。读写共用，避免两处各写一套话术。 */
export const FAILURE_TEXT: Record<string, string> = {
  "no-repo": "这个工作区没有可识别的 GitHub 远端",
  "unsupported-host": "当前远端不是 GitHub",
  "gh-missing": "没有找到 gh 命令",
  "gh-failed": "GitHub 拒绝了这次操作",
  "not-found": "找不到这张票",
  invalid: "输入不合法，没有发出去",
};

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
export function promptForIssue(input: {
  number: number;
  title: string;
  url: string;
  body: string;
  labels: readonly { name: string }[];
}): string {
  const labels = input.labels.map((label) => label.name).join("、");
  return [
    `请处理这张票：#${input.number} ${input.title}`,
    input.url ? `链接：${input.url}` : "",
    labels ? `标签：${labels}` : "",
    "",
    input.body.trim() || "（这张票没有正文，请按标题判断）",
  ]
    .filter((line, index) => line !== "" || index === 3)
    .join("\n");
}
