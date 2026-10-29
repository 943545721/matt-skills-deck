import type { ItemKind } from "../../../shared/issues";
import { panelText } from "./panelText";
import { issueActionPrompt } from "../../../shared/issue-action-prompts.ts";

/**
 * 票面提示词。
 *
 * Paseo 目前没有「把文本填进某个会话输入框」的接口（L5 的会话桥还没落地），
 * 所以这里只生成文本，由用户复制后粘贴。生成逻辑独立成纯函数：
 * issue detail 与 run panel 用的是同一份，避免两处措辞漂移。
 */
export interface PromptIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: readonly { name: string }[];
}

export interface IssuePromptInput {
  locale: string;
  issue: PromptIssue;
  repoKey: string;
  repoDir?: string | null;
  repoWebUrl?: string | null;
  kind?: ItemKind;
  mode?: "general" | "attach" | "diagnose" | "fix" | "discuss" | "research" | "prototype" | "takeover" | "supplement" | "execute";
}

export function buildIssuePrompt({
  locale,
  issue,
  repoKey,
  repoDir,
  repoWebUrl,
  kind = "issue",
  mode = "general",
}: IssuePromptInput): string {
  const t = (key: Parameters<typeof panelText>[1], vars?: Readonly<Record<string, string | number>>) =>
    panelText(locale, key, vars);
  const labels = issue.labels.map((label) => label.name).join(", ");
  const askByMode: Record<string, string> = {
    general: t("issue.promptAsk"),
    attach: t("issue.promptAttach", { number: issue.number, repo: repoKey }),
    diagnose: issueActionPrompt("diagnose", locale.startsWith("zh") ? "zh" : "en", kind),
    fix: issueActionPrompt("fix", locale.startsWith("zh") ? "zh" : "en", kind),
    discuss: issueActionPrompt("discuss", locale.startsWith("zh") ? "zh" : "en", kind),
    research: issueActionPrompt("research", locale.startsWith("zh") ? "zh" : "en", kind),
    prototype: issueActionPrompt("prototype", locale.startsWith("zh") ? "zh" : "en", kind),
    takeover: issueActionPrompt("takeover", locale.startsWith("zh") ? "zh" : "en", kind),
    supplement: issueActionPrompt("supplement", locale.startsWith("zh") ? "zh" : "en", kind),
    execute: issueActionPrompt("execute", locale.startsWith("zh") ? "zh" : "en", kind),
  };
  const ask = askByMode[mode] ?? askByMode.general;
  return [
    t("issue.promptTitle", { number: issue.number, title: issue.title }),
    kind === "pull-request" ? t("issue.promptKindPr") : t("issue.promptKind"),
    t("issue.promptRepo", { repo: repoKey }),
    repoDir ? t("issue.promptDir", { dir: repoDir }) : "",
    repoWebUrl ? t("issue.promptRemote", { url: repoWebUrl }) : "",
    issue.url ? t("issue.promptLink", { url: issue.url }) : "",
    labels ? `labels: ${labels}` : "",
    "",
    issue.body.trim() || t("issue.noBody"),
    "",
    ask,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
