import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcOutput } from "@getpaseo/plugin";
import type { updateCheckRpc } from "../shared/update.ts";
import { PLUGIN_VERSION } from "../shared/version.ts";

const execFileAsync = promisify(execFile);

/** 插件自己的仓库：与 package.json 的 repository 保持一致。 */
const UPSTREAM = "943545721/matt-skills-deck";
const REPO_URL = `https://github.com/${UPSTREAM}.git`;

export type UpdateCheck = RpcOutput<typeof updateCheckRpc>;

export interface TagRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const defaultRun = async (): Promise<TagRun> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["ls-remote", "--tags", REPO_URL], {
      timeout: 10_000,
      maxBuffer: 2 << 20,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: (error as { stderr?: unknown }).stderr?.toString?.() ?? (error instanceof Error ? error.message : String(error)),
    };
  }
};

/** 从 `git ls-remote --tags` 的输出里取出稳定的版本 tag（忽略 `^{}` 解引用行与预发布）。 */
export function parseTags(stdout: string): string[] {
  const tags = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)(?:\^\{\})?\s*$/);
    if (match?.[1] && !line.endsWith("^{}")) tags.add(match[1]);
  }
  return [...tags];
}

function versionParts(tag: string): number[] {
  return tag.replace(/^v/, "").split(".").map((part) => Number(part));
}

/** 数字逐段比较；预发布版本不进这个函数（parseTags 已经滤掉）。 */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function latestTag(tags: readonly string[]): string | null {
  let latest: string | null = null;
  for (const tag of tags) if (latest === null || compareVersions(tag, latest) > 0) latest = tag;
  return latest;
}

export async function checkForUpdate(run: () => Promise<TagRun> = defaultRun): Promise<UpdateCheck> {
  const result = await run();
  if (!result.ok) {
    const detail = result.stderr.trim();
    const gitMissing = /ENOENT|not found|command not found/i.test(detail);
    return {
      ok: false,
      reason: gitMissing ? "git-missing" : "update-failed",
      detail: detail.slice(0, 800) || "git ls-remote 没有返回输出",
    };
  }
  const tags = parseTags(result.stdout);
  const latest = latestTag(tags);
  const installRef = latest ?? "main";
  return {
    ok: true,
    current: PLUGIN_VERSION,
    latest,
    updateAvailable: latest !== null && compareVersions(latest, PLUGIN_VERSION) > 0,
    tags: tags.sort((a, b) => compareVersions(b, a)),
    command: `paseo plugin install git:${UPSTREAM} --ref ${installRef}`,
  };
}
