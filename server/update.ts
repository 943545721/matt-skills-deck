import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcOutput } from "@getpaseo/plugin";
import type { updateCheckRpc } from "../shared/update.ts";
import { PLUGIN_VERSION } from "../shared/version.ts";

const execFileAsync = promisify(execFile);

/** 插件自己的仓库：与 package.json 的 repository 保持一致。 */
export const UPDATE_UPSTREAM = "943545721/matt-skills-deck";
/** 安装源的写法与现有 `checkForUpdate.command` 保持一致，界面上不要出现第二种拼法。 */
export const UPDATE_INSTALL_TARGET = `git:${UPDATE_UPSTREAM}`;
const REPO_URL = `https://github.com/${UPDATE_UPSTREAM}.git`;

export type UpdateCheck = RpcOutput<typeof updateCheckRpc>;

export interface TagRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function tryRun(command: string, args: string[], timeout: number): Promise<TagRun> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout, maxBuffer: 2 << 20 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: (error as { stderr?: unknown }).stderr?.toString?.() ?? (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** `gh api --jq '.[].name'` 每页输出一行一个名字；tag 名里不可能有换行。 */
export function parseGhTagNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 先问 git；git 被网络挡住时再问 gh。
 *
 * 有些机器只放行 api.github.com，`git ls-remote https://github.com/...` 会一直挂到超时，
 * 而已经登录的 gh 走 API 读同一份 tag 列表没有问题。两条都失败才如实报错。
 * `--jq` 让 gh 逐页输出名字：`--paginate` 的 JSON 分页格式随版本变过，按名字读不用赌。
 */
export const lsRemoteTags = async (): Promise<TagRun> => {
  const git = await tryRun("git", ["ls-remote", "--tags", REPO_URL], 10_000);
  // git 正常退出就是权威答案：没有 tag 也返回空列表，别拿回退去猜。
  if (git.ok) return git;

  const gh = await tryRun(
    "gh",
    ["api", `repos/${UPDATE_UPSTREAM}/tags`, "--paginate", "--jq", ".[].name"],
    10_000,
  );
  if (gh.ok) {
    const stdout = parseGhTagNames(gh.stdout)
      .map((name) => `\trefs/tags/${name}`)
      .join("\n");
    return { ok: true, stdout, stderr: "" };
  }

  const detail = [git.stderr.trim(), gh.stderr.trim()].filter(Boolean).join(" · ");
  return { ok: false, stdout: "", stderr: detail };
};

const defaultRun = lsRemoteTags;

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
    command: `paseo plugin install ${UPDATE_INSTALL_TARGET} --ref ${installRef}`,
  };
}

// ---------------------------------------------------------------------------
// 更新计划：版本比较 + 命令计划 + 失败回退说明（只返回计划，不执行安装）
// ---------------------------------------------------------------------------

const STABLE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;

export interface StableVersion {
  /** 调用方传入的原样值（去掉首尾空白），展示时用它。 */
  source: string;
  /** x.y.z 规范形式，比较与展示统一用这个。 */
  normalized: string;
  parts: readonly [number, number, number];
}

/**
 * 严格的稳定版本解析：只认 `x.y.z` / `vx.y.z`。
 * 预发布（`-rc.1`）、`latest`、提交 sha 都不算版本——它们不能参与「谁更新」的判断。
 * 超出安全整数范围的段也拒绝，避免比较时静默丢精度。
 */
export function parseStableVersion(raw: string): StableVersion | null {
  const source = String(raw ?? "").trim();
  const match = source.match(STABLE_VERSION_RE);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return null;
  return { source, normalized: `${major}.${minor}.${patch}`, parts: [major, minor, patch] };
}

/** 按数字逐段比较两个已解析的稳定版本。 */
export function compareStableVersions(a: StableVersion, b: StableVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 回退 ref：优先用当前版本对应的 tag（`0.1.0` → `v0.1.0`）。 */
export function rollbackRefFor(current: string): string | null {
  const parsed = parseStableVersion(current);
  return parsed ? `v${parsed.normalized}` : null;
}

/**
 * git ref 的安全校验。ref 会作为独立 argv 传给 paseo，不经过 shell；
 * 这里仍要求它不能以 `-` 开头（否则会被当成选项）、不能含 `..`（git 本身也禁止）。
 */
export function gitRefProblem(ref: string): string | null {
  const value = String(ref ?? "").trim();
  if (!value) return "ref 为空";
  if (value.includes("..")) return `ref 不能包含 ..：${value}`;
  if (!GIT_REF_RE.test(value)) {
    return `ref 含不支持的字符（只允许字母/数字/._/@-，且不能以 - 开头）：${value}`;
  }
  return null;
}

export interface UpdateStep {
  /** 命令与参数分开：执行层直接 spawn，不拼 shell。 */
  argv: readonly string[];
  why: string;
}

export interface UpdateRollback {
  ref: string;
  commands: readonly UpdateStep[];
  why: string;
}

export type UpdateStatus = "up-to-date" | "update-available" | "no-release-tag";

export interface UpdatePlan {
  ok: true;
  status: UpdateStatus;
  /** 当前版本（规范化的 x.y.z）。 */
  current: string;
  /** 最新稳定 tag 的原样值；仓库没有稳定 tag 时为 null。 */
  latest: string | null;
  /** 更新时安装的 ref；已是最新时为回退 ref。 */
  target: string;
  /** 计划永远是 dry-run：字段固定为 true。 */
  dryRun: true;
  /** 需要执行的更新命令；已是最新时为空数组。 */
  commands: readonly UpdateStep[];
  rollback: UpdateRollback;
  notes: readonly string[];
  warnings: readonly string[];
}

export type UpdatePlanFailureReason =
  | "check-failed"
  | "invalid-version"
  | "unstable-version"
  | "bad-ref";

export interface UpdatePlanFailure {
  ok: false;
  reason: UpdatePlanFailureReason;
  detail: string;
}

export type UpdatePlanResult = UpdatePlan | UpdatePlanFailure;

export interface UpdatePlanInput {
  current: string;
  latest: string | null;
  /** 指定回退 ref（可以是 commit sha）；不给就用 `v<current>`。 */
  previousRef?: string;
}

/** 单条安装命令；ref 不合法时直接抛错——那是调用方的编程错误，不应该变成一条坏命令。 */
export function updateCommandFor(ref: string, why = `安装 ${ref.trim()}`): UpdateStep {
  const problem = gitRefProblem(ref);
  if (problem) throw new Error(problem);
  return { argv: ["paseo", "plugin", "install", UPDATE_INSTALL_TARGET, "--ref", ref.trim()], why };
}

function buildRollback(
  current: StableVersion,
  previousRef: string | undefined,
): { ok: true; rollback: UpdateRollback } | UpdatePlanFailure {
  const fallbackRef = rollbackRefFor(current.normalized) ?? `v${current.normalized}`;
  const ref = previousRef ? String(previousRef).trim() || fallbackRef : fallbackRef;
  const refProblem = gitRefProblem(ref);
  if (refProblem) return { ok: false, reason: "bad-ref", detail: `回退 ref 不合法：${refProblem}` };
  return {
    ok: true,
    rollback: {
      ref,
      commands: [updateCommandFor(ref, `回退到更新前的 ${ref}`)],
      why: "更新失败或新版本启动异常时，重跑同一条安装命令并指向这个 ref；它不会删除用户数据。",
    },
  };
}

function updateNotes(current: string, rollbackRef: string): string[] {
  return [
    "本计划不执行安装：命令由用户确认后自行运行。",
    `当前版本 ${current}；更新后需要重启 Paseo daemon（或重载插件）才生效。`,
    `回退方式：重跑安装命令，把 --ref 换成 ${rollbackRef}，再重启。`,
    "安装失败时先读命令输出：若插件目录已被部分改写，用回退命令覆盖回去；若装上了但启动异常，同样先回退再排查。",
  ];
}

function noReleaseTagPlan(current: StableVersion, rollback: UpdateRollback, notes: string[]): UpdatePlan {
  return {
    ok: true,
    status: "no-release-tag",
    current: current.normalized,
    latest: null,
    target: "main",
    dryRun: true,
    commands: [updateCommandFor("main", "安装 main 分支（没有稳定 tag）")],
    rollback,
    notes,
    warnings: ["仓库没有稳定版本 tag：安装命令指向 main 分支，内容会随仓库变化，无法按版本回退到 main 之外的某个点。"],
  };
}

function availableUpdatePlan(
  current: StableVersion,
  latest: StableVersion,
  rollback: UpdateRollback,
  notes: string[],
): UpdatePlan {
  const warnings = latest.parts[0] !== current.parts[0]
    ? [`跨主版本更新：${current.normalized} → ${latest.normalized}，先看变更说明与回退 ref。`]
    : [];
  return {
    ok: true,
    status: "update-available",
    current: current.normalized,
    latest: latest.source,
    target: latest.source,
    dryRun: true,
    commands: [updateCommandFor(latest.source, `把插件更新到 ${latest.source}`)],
    rollback,
    notes: [`发现新版本 ${latest.source}。`, ...notes],
    warnings,
  };
}

function upToDatePlan(
  current: StableVersion,
  latest: StableVersion,
  rollback: UpdateRollback,
  notes: string[],
  comparison: number,
): UpdatePlan {
  const warnings = comparison < 0
    ? [`最新稳定 tag ${latest.source} 比当前 ${current.normalized} 旧：不降级。`]
    : [];
  return {
    ok: true,
    status: "up-to-date",
    current: current.normalized,
    latest: latest.source,
    target: rollback.ref,
    dryRun: true,
    commands: [],
    rollback,
    notes: ["已经是最新稳定版本，没有需要执行的更新命令。", ...notes],
    warnings,
  };
}

/**
 * 生成更新计划。
 *
 * 规则：
 * - 只比较稳定版本；最新 tag 比当前旧时绝不降级，按「已是最新」处理。
 * - 没有稳定 tag 时不假装有更新：状态是 `no-release-tag`，命令指向 `main` 并明确警告。
 * - 已是最新时不给更新命令；回退命令仍然给出，因为重装当前版本也是修复安装损坏的手段。
 */
export function planUpdate(input: UpdatePlanInput): UpdatePlanResult {
  const current = parseStableVersion(input.current);
  if (!current) {
    return { ok: false, reason: "invalid-version", detail: `当前版本不是稳定的 x.y.z：${input.current}` };
  }
  const latestRaw = input.latest === null || input.latest === undefined ? "" : String(input.latest).trim();
  const latest = latestRaw ? parseStableVersion(latestRaw) : null;
  if (latestRaw && !latest) {
    return { ok: false, reason: "unstable-version", detail: `最新 tag 不是稳定的 x.y.z：${latestRaw}` };
  }
  const built = buildRollback(current, input.previousRef);
  if (!built.ok) return built;

  const notes = updateNotes(current.normalized, built.rollback.ref);
  if (!latest) return noReleaseTagPlan(current, built.rollback, notes);
  const comparison = compareStableVersions(latest, current);
  if (comparison > 0) return availableUpdatePlan(current, latest, built.rollback, notes);
  return upToDatePlan(current, latest, built.rollback, notes, comparison);
}

/** 把一次检查结果转成计划：检查失败原样带上原因，不猜版本。 */
export function planUpdateFromCheck(
  check: UpdateCheck,
  options: { previousRef?: string } = {},
): UpdatePlanResult {
  if (!check.ok) {
    return { ok: false, reason: "check-failed", detail: `${check.reason}: ${check.detail}` };
  }
  return planUpdate({
    current: check.current,
    latest: check.latest,
    ...(options.previousRef ? { previousRef: options.previousRef } : {}),
  });
}
