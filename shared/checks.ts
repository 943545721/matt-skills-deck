/**
 * 检查目录与六步引导的纯状态机。
 *
 * 行为照 DSH 源码搬：
 * - 目录（`CHECK_CATALOG`）只描述「问什么」，不执行；执行在 `server/checks.ts`。
 * - 引导（`GUIDE_STEPS`）是顺序的唯一真源：界面、状态栏横幅、注入决策都从这里取，
 *   不许各自再抄一份顺序。
 * - 检测原语只用 DSH 那六种：commandExists / fileExists / env / skillProbe / homeDir / dirWritable。
 * - 动作只用 DSH 那六种：inject-prompt / open-url / rpc / form / refresh / wizard。
 *   动作不承诺修复，只描述「用户点下去会发生什么」；状态永远由检查结果说了算。
 *
 * 本文件必须保持纯逻辑：客户端也要 import 它，不能出现 node: 依赖。
 */

export type BackendId = "github" | "gitlab" | "markdown";

/** 检查状态四档。`unknown` 是「问不出来」，不是「没通过」——界面不许把前者画成后者。 */
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

// ---------------------------------------------------------------------------
// 动作词汇表（DSH check-catalog 的六种，契约层唯一真源）
// ---------------------------------------------------------------------------

export const ACTION_TYPES = [
  "inject-prompt", // 推进型：把一段提示词注入会话
  "open-url", // 信息型：打开链接，不宣称修复
  "rpc", // 执行型：调用宿主 RPC
  "form", // 执行型：内嵌表单，提交后走 submitAction
  "refresh", // 执行型：重新求值
  "wizard", // 执行型：多步向导
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export interface CheckField {
  name: string;
  type?: "text" | "number" | "date" | "single" | "multi" | "directory" | "file";
  label?: string;
  required?: boolean;
  options?: readonly string[];
  /** 选项的短标签：值仍是 `options` 里的原样值，界面只换显示文字。 */
  optionSubs?: Readonly<Record<string, string>>;
  defaultValue?: string;
  placeholder?: string;
  /** 正则（字符串形态，DSH 契约原样）；不通过时停在当前步并提示。 */
  pattern?: string;
  /** 预填来源：`cwd-basename` = 工作区目录最后一段，清洗成合法仓库名。 */
  defaultFrom?: "cwd-basename";
  /** 值变化时实时渲染的预览模板，支持 `{name}` 与 `{owner}`。 */
  preview?: string;
}

export type CheckAction =
  | { type: "inject-prompt"; prompt: string; args?: Readonly<Record<string, string>>; label?: string }
  | { type: "open-url"; url: string; label?: string }
  | { type: "rpc"; method: string; params?: Readonly<Record<string, unknown>>; label?: string }
  | {
      type: "form";
      label?: string;
      schema: readonly CheckField[];
      submitAction: Exclude<CheckAction, { type: "form" }>;
    }
  | { type: "refresh"; target: "chain" | "snapshot"; label?: string }
  | { type: "wizard"; wizard: string; label?: string };

// ---------------------------------------------------------------------------
// 检测原语（与 DSH PRIMITIVE_KIND 同源）
// ---------------------------------------------------------------------------

export const PRIMITIVE_KINDS = [
  "commandExists",
  "fileExists",
  "env",
  "skillProbe",
  "homeDir",
  "dirWritable",
] as const;

export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

/**
 * 一条检查谓词。
 *
 * - `primitive`：与本机文件系统 / PATH 直接相关，六种原语之一。
 * - `backend`：真值随后端改变（远端、仓库访问、标签、本地布局）。
 * - `preflight`：后端自己的登录探测。
 *
 * 目录只描述谓词，不执行；执行由 `server/checks.ts` 完成，测试可注入假探测。
 */
export type CheckPredicate =
  | { kind: "primitive"; primitive: "commandExists"; command: string }
  | { kind: "primitive"; primitive: "fileExists"; path: string }
  | { kind: "primitive"; primitive: "env"; key: string }
  | { kind: "primitive"; primitive: "skillProbe"; skill: string }
  | { kind: "primitive"; primitive: "homeDir" }
  | { kind: "primitive"; primitive: "dirWritable"; path: string }
  | {
      kind: "backend";
      backendId: BackendId;
      id: "repoRemote" | "repoAccess" | "labels" | "workspace" | "scratchWritable" | "containersReadable";
    }
  | { kind: "preflight"; id: "ghAuth" | "glabAuth" };

// ---------------------------------------------------------------------------
// 检查目录
// ---------------------------------------------------------------------------

export interface CheckItem {
  id: string;
  label: string;
  scope: "generic" | "backend";
  backends: readonly BackendId[];
  group: "gate" | "env" | "backend";
  check: CheckPredicate;
  /** 没过时界面给的动作；空数组表示这一项只报状态，没有下一步。 */
  onFail: readonly CheckAction[];
  /** 结果取决于当前会话（例如本地可写探测）时，缓存不能跨会话复用。 */
  sessionScoped?: boolean;
}

export interface CheckResult {
  id: string;
  status: CheckStatus;
  detail?: string;
  /** 没过时的下一步动作；通过时省略。 */
  action?: readonly CheckAction[];
}

/** 技能套件三项共用的安装动作：表单 → 注入安装提示词 → 重查。 */
const SKILL_INSTALL_ACTIONS: readonly CheckAction[] = Object.freeze([
  {
    type: "form",
    label: "帮我安装",
    schema: [
      {
        name: "mode",
        type: "single",
        label: "安装方式",
        options: ["让 AI 一步步引导安装（推荐）", "让 AI 直接执行安装命令"],
        defaultValue: "让 AI 一步步引导安装（推荐）",
      },
    ],
    submitAction: { type: "inject-prompt", prompt: "installSkills", args: {} },
  },
  { type: "inject-prompt", prompt: "installSkills", label: "安装指引" },
  { type: "refresh", target: "chain" },
] as const);

const REFRESH_ACTIONS: readonly CheckAction[] = Object.freeze([{ type: "refresh", target: "chain" } as const]);

function skillItem(skill: string, label: string): CheckItem {
  return {
    id: `skill:${skill}`,
    label,
    scope: "generic",
    backends: ["github", "gitlab", "markdown"],
    group: "env",
    check: { kind: "primitive", primitive: "skillProbe", skill },
    onFail: SKILL_INSTALL_ACTIONS,
  };
}

/**
 * 全量检查目录。
 *
 * 通用 5 项（三个后端都问）+ GitHub 5 项 = 十项，就是 DSH 的「十项检查」。
 * GitLab 额外 3 项、本地 Markdown 额外 3 项，各自只在该后端出现。
 */
export const CHECK_CATALOG: readonly CheckItem[] = Object.freeze([
  skillItem("wayfinder", "技能 wayfinder 已安装"),
  skillItem("setup-matt-pocock-skills", "技能 setup-matt-pocock-skills 已安装"),
  skillItem("ask-matt", "技能 ask-matt 已安装"),
  {
    id: "env:home",
    label: "用户主目录可解析",
    scope: "generic",
    backends: ["github", "gitlab", "markdown"],
    group: "env",
    check: { kind: "primitive", primitive: "homeDir" },
    onFail: REFRESH_ACTIONS,
  },
  {
    id: "tracker:initialized",
    label: "工作区已初始化（docs/agents/issue-tracker.md 存在）",
    scope: "generic",
    backends: ["github", "gitlab", "markdown"],
    group: "gate",
    check: { kind: "primitive", primitive: "fileExists", path: "docs/agents/issue-tracker.md" },
    onFail: [{ type: "inject-prompt", prompt: "setupRun", label: "执行初始化" }],
  },
  {
    id: "gh:remote",
    label: "已关联 GitHub 仓库",
    scope: "backend",
    backends: ["github"],
    group: "backend",
    check: { kind: "backend", backendId: "github", id: "repoRemote" },
    onFail: [{ type: "wizard", wizard: "publish", label: "创建并发布" }],
  },
  {
    id: "gh:installed",
    label: "GitHub 助手（gh cli）已安装",
    scope: "backend",
    backends: ["github"],
    group: "backend",
    check: { kind: "primitive", primitive: "commandExists", command: "gh" },
    onFail: [
      { type: "inject-prompt", prompt: "cliInstall", label: "安装指引" },
      { type: "open-url", url: "https://cli.github.com/", label: "官方安装页" },
      { type: "refresh", target: "chain" },
    ],
  },
  {
    id: "gh:authed",
    label: "已登录 GitHub",
    scope: "backend",
    backends: ["github"],
    group: "backend",
    check: { kind: "preflight", id: "ghAuth" },
    onFail: [
      { type: "inject-prompt", prompt: "ghAuthLogin", label: "登录指引" },
      { type: "rpc", method: "deck.auth.start", label: "在面板里登录" },
      { type: "refresh", target: "chain" },
    ],
  },
  {
    id: "gh:repoAccess",
    label: "仓库在 GitHub 上可访问",
    scope: "backend",
    backends: ["github"],
    group: "backend",
    check: { kind: "backend", backendId: "github", id: "repoAccess" },
    onFail: REFRESH_ACTIONS,
  },
  {
    id: "gh:labels",
    label: "wayfinder 标签已齐",
    scope: "backend",
    backends: ["github"],
    group: "backend",
    check: { kind: "backend", backendId: "github", id: "labels" },
    onFail: [
      { type: "inject-prompt", prompt: "ensureLabels", label: "补全标签" },
      { type: "refresh", target: "chain" },
    ],
  },
  {
    id: "glab:installed",
    label: "GitLab CLI (glab) 已安装",
    scope: "backend",
    backends: ["gitlab"],
    group: "backend",
    check: { kind: "primitive", primitive: "commandExists", command: "glab" },
    onFail: [
      { type: "open-url", url: "https://gitlab.com/gitlab-org/cli", label: "官方安装页" },
      { type: "refresh", target: "chain" },
    ],
  },
  {
    id: "glab:authed",
    label: "glab 已登录",
    scope: "backend",
    backends: ["gitlab"],
    group: "backend",
    check: { kind: "preflight", id: "glabAuth" },
    onFail: [
      { type: "inject-prompt", prompt: "glabAuthLogin", label: "登录指引" },
      { type: "refresh", target: "chain" },
    ],
  },
  {
    id: "glab:repoAccess",
    label: "GitLab 仓库可达",
    scope: "backend",
    backends: ["gitlab"],
    group: "backend",
    check: { kind: "backend", backendId: "gitlab", id: "repoAccess" },
    onFail: REFRESH_ACTIONS,
  },
  {
    id: "md:workspace",
    label: "本地工作区可读取",
    scope: "backend",
    backends: ["markdown"],
    group: "backend",
    check: { kind: "backend", backendId: "markdown", id: "workspace" },
    onFail: REFRESH_ACTIONS,
  },
  {
    id: "md:scratchWritable",
    label: "本地数据目录可读写",
    scope: "backend",
    backends: ["markdown"],
    group: "backend",
    check: { kind: "backend", backendId: "markdown", id: "scratchWritable" },
    onFail: REFRESH_ACTIONS,
    // 同一工作区的只读会话与可写会话答案不同，链快照缓存命中时必须重算。
    sessionScoped: true,
  },
  {
    id: "md:containersReadable",
    label: "本地地图与规格可读取",
    scope: "backend",
    backends: ["markdown"],
    group: "backend",
    check: { kind: "backend", backendId: "markdown", id: "containersReadable" },
    onFail: REFRESH_ACTIONS,
  },
] as const);

/**
 * 某个后端适用的目录：通用在前，后端项在后。
 * 未知后端只给通用项，不抛错——后端还没选定时界面仍要能渲染。
 */
export function catalogFor(backend: BackendId | null | undefined): CheckItem[] {
  const base = CHECK_CATALOG.filter((item) => item.scope === "generic");
  if (!backend) return base;
  return [
    ...base,
    ...CHECK_CATALOG.filter((item) => item.scope === "backend" && item.backends.includes(backend)),
  ];
}

// ---------------------------------------------------------------------------
// 六步引导
// ---------------------------------------------------------------------------

export type GuideMissing =
  | { type: "inject-prompt"; prompt: string; label?: string }
  | { type: "open-url"; url: string; label?: string }
  | { type: "rpc"; method: string; label?: string }
  | { type: "form"; label?: string; schema: readonly CheckField[]; submitAction: Exclude<GuideMissing, { type: "form" }> }
  | { type: "refresh"; target: "chain" | "snapshot"; label?: string }
  | { type: "wizard"; wizard: string; label?: string };

export interface GuideStep {
  id: string;
  title: string;
  /** 客户端门控步骤：服务端的链快照里没有对应检查项，排序与状态由界面自己定。 */
  gate?: boolean;
  /** 这一步由哪几项检查共同判定；缺省是 `[id]`。 */
  checks?: readonly string[];
  /** 适用后端；缺省三个后端都适用。 */
  backends?: readonly BackendId[];
  /** 没过时出哪条横幅（文案键名，界面不许写死文字）。 */
  banner?: string;
  /** 没过时给哪个动作（只声明，界面分发）。 */
  missing?: GuideMissing;
  /** 这一步没过时，后面的初始化步骤不能开始。 */
  blocksSetup?: boolean;
}

/**
 * 首开引导链的六步，顺序即 DSH 定版：后端选择 → 装 gh → 登录 → 关联远端 → 初始化 → 技能套件。
 * 中间三步只对 GitHub 适用；GitLab / 本地 Markdown 走「选后端 → 初始化 → 技能」。
 */
export const GUIDE_STEPS: readonly GuideStep[] = Object.freeze([
  {
    id: "selection:backendSelected",
    title: "已选择后端",
    gate: true,
    checks: ["selection:backendSelected"],
    backends: ["github", "gitlab", "markdown"],
    banner: "banner.gate",
    missing: { type: "wizard", wizard: "backend-picker", label: "选择后端" },
  },
  {
    id: "gh:installed",
    title: "GitHub 助手（gh cli）已安装",
    checks: ["gh:installed"],
    backends: ["github"],
    banner: "banner.ghcli",
    missing: { type: "inject-prompt", prompt: "cliInstall", label: "安装指引" },
  },
  {
    id: "gh:authed",
    title: "已登录 GitHub",
    checks: ["gh:authed"],
    backends: ["github"],
    banner: "banner.ghauth",
    missing: { type: "inject-prompt", prompt: "ghAuthLogin", label: "登录指引" },
  },
  {
    id: "gh:remote",
    title: "已关联 GitHub 仓库",
    checks: ["gh:remote"],
    backends: ["github"],
    banner: "banner.repo",
    missing: { type: "wizard", wizard: "publish", label: "创建并发布" },
    // DSH：远端没关联之前，不注入初始化全文。
    blocksSetup: true,
  },
  {
    id: "tracker:initialized",
    title: "工作区已初始化",
    checks: ["tracker:initialized"],
    backends: ["github", "gitlab", "markdown"],
    banner: "banner.setup",
    missing: { type: "inject-prompt", prompt: "setupRun", label: "执行初始化" },
  },
  {
    id: "skill:wayfinder",
    title: "技能套件已安装",
    checks: ["skill:wayfinder", "skill:setup-matt-pocock-skills", "skill:ask-matt"],
    backends: ["github", "gitlab", "markdown"],
    banner: "banner.skills",
    missing: { type: "inject-prompt", prompt: "installSkills", label: "安装技能" },
  },
] as const);

/** 按后端过滤出适用的步骤，顺序不变。后端未定时返回空数组，让调用处照常渲染空态。 */
export function guideStepsFor(backend: BackendId | null | undefined): GuideStep[] {
  if (!backend) return [];
  return GUIDE_STEPS.filter((step) => !step.backends || step.backends.includes(backend));
}

export type GuideStepState = "done" | "fail" | "pending" | "absent";

/**
 * 单步状态：
 * - `done`：它的检查项全部 `ok`。
 * - `fail`：至少一项明确 `fail`。
 * - `pending`：有结果但问不出确定结论（warn / unknown）。
 * - `absent`：一项结果都没有（还没探测，或该步骤只存在于客户端）。
 *
 * 没有结果绝不算通过：宁可再问一次，也不把「没有证据」当成「已经好了」。
 */
export function guideStepState(
  step: GuideStep | null | undefined,
  results: ReadonlyMap<string, CheckResult>,
): GuideStepState {
  if (!step) return "absent";
  const ids = step.checks && step.checks.length > 0 ? step.checks : [step.id];
  const present = ids.map((id) => results.get(id)).filter((item): item is CheckResult => item !== undefined);
  if (present.length === 0) return "absent";
  if (present.some((item) => item.status === "fail")) return "fail";
  // 只有每一项都有结论且全部 ok 才算完成：缺一项就是证据不足，不能替它说通过。
  if (present.length === ids.length && present.every((item) => item.status === "ok")) return "done";
  return "pending";
}

export interface GuideState {
  /** 现在该处理的那一步；全部就绪时为 null。 */
  current: string | null;
  /** 已完成的步骤 id，按引导顺序。 */
  done: string[];
  /** 排在 current 后面、还没完成的步骤 id。 */
  blocked: string[];
}

/**
 * 六步引导的纯状态机。
 *
 * 顺序只影响 `current`：第一个没完成的步骤就是当前步骤，后面的未完成步骤进 `blocked`。
 * 已完成的步骤即便排在 current 后面也照样进 `done`——它确实已经过了，不能因为前面卡住就改口。
 * `gate` 步骤没有服务端结果时直接跳过（DSH 的检查链同样不收录 gate 步骤）；客户端若知道
 * 用户已经选过后端，把 `selection:backendSelected` 的结果放进 Map 即可参与判定。
 */
export function guideState(
  results: ReadonlyMap<string, CheckResult>,
  backend: BackendId = "github",
): GuideState {
  const done: string[] = [];
  const blocked: string[] = [];
  let current: string | null = null;
  for (const step of guideStepsFor(backend)) {
    if (step.gate && !results.has(step.id)) continue;
    if (guideStepState(step, results) === "done") {
      done.push(step.id);
      continue;
    }
    if (current === null) current = step.id;
    else blocked.push(step.id);
  }
  return { current, done, blocked };
}

/** 就绪进度：分母是本次实际参与判定的步骤数（跳过的 gate 不计入）。 */
export function guideProgress(
  state: GuideState,
  backend: BackendId = "github",
): { done: number; total: number; percent: number } {
  const totalSteps = guideStepsFor(backend).length;
  const evaluated = state.done.length + state.blocked.length + (state.current === null ? 0 : 1);
  const total = evaluated > 0 ? Math.min(totalSteps, evaluated) : 0;
  if (total === 0) return { done: 0, total: 0, percent: 100 };
  return { done: state.done.length, total, percent: Math.round((state.done.length / total) * 100) };
}

/**
 * 这一步没过时到底给哪个动作。
 *
 * 登录那一步问不出结论（pending）时不注入登录指引，改成强制重查——这与 DSH #916 一致：
 * 「查不到」和「确定没登录」是两件事，文案不能读起来像后者。
 */
export function guideMissingOf(
  step: GuideStep | null | undefined,
  results: ReadonlyMap<string, CheckResult>,
): GuideMissing | null {
  if (!step) return null;
  if (step.id === "gh:authed" && guideStepState(step, results) === "pending") {
    return { type: "refresh", target: "chain", label: "重新检查" };
  }
  return step.missing ?? null;
}

/** 检查结果数组 → 引导状态机要的 Map；同一 id 后出现的覆盖先出现的。 */
export function checksById(checks: readonly CheckResult[]): Map<string, CheckResult> {
  return new Map(checks.map((check) => [check.id, check]));
}
