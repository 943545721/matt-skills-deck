/**
 * 主窗口把活交给派单窗口：`deck_handoff_to_dispatcher` 的入参形状、幂等锚与消息渲染。
 *
 * 交接不是派单：这里不建票、不建会话、不碰 `gh`，只写一份投递件等 relay 送进派单窗口。
 * 好处是主窗口可以随时交接，派单窗口忙的时候也不会丢——投递件留在 outbox 里，
 * 等它空下来再送。
 *
 * 纯函数：不读盘、不取会话、不读钟。写文件在 `server/dispatch-handoff-store.ts`，
 * 投递在 `server/dispatch-handoff-relay.ts`。
 */

/** 工具名只在这里写一次：tool-contract 与 MCP handler 都引用它。 */
export const HANDOFF_TOOL_NAME = "deck_handoff_to_dispatcher";

/** 投递件格式版本；以后改字段时靠它分别处理旧件。 */
export const HANDOFF_VERSION = 1;

export type HandoffLang = "zh" | "en";

/** 一条要交给派单窗口拆的任务。字段与 `DispatchTaskInput` 对齐，少了派单时才决定的部分。 */
export interface HandoffTask {
  /** 短标题；派单窗口可以用它做票面标题。 */
  readonly title?: string;
  /** 完整任务说明。必填。 */
  readonly prompt: string;
  /** 验收判据；可空。 */
  readonly acceptance?: string;
  /** 指定名册上的哪张卡；可空，留给派单窗口按领地选。 */
  readonly staff?: string;
  /** 落在哪个仓库；单仓库工作区不写。 */
  readonly repoKey?: string;
  /** 挂在哪张地图下；可空。 */
  readonly map?: string;
}

/** 工具入参。身份、深度、批次号都不在这里：身份取 `PASEO_AGENT_ID`，深度由派单窗口自己定。 */
export interface HandoffInput {
  /** 多工作区共用一个看板时才需要。 */
  readonly workspaceId?: string;
  /** 需求票号，必填：没有票号就没有交接的依据。 */
  readonly requirementKey: number;
  /** 需求票所在的仓库；与任务自己的仓库不同时才写。 */
  readonly requirementRepoKey?: string;
  /** 这批活要解决什么，一两句话。 */
  readonly summary: string;
  readonly tasks: readonly HandoffTask[];
  /** 约束：不能动的文件、必须遵守的约定、截止时间。 */
  readonly constraints?: string;
  /** 投递给派单窗口时用哪种语言；默认中文。 */
  readonly lang?: HandoffLang;
}

/** 落盘的投递件。relay 只认这个形状。 */
export interface HandoffEnvelope {
  readonly version: typeof HANDOFF_VERSION;
  readonly handoffId: string;
  readonly createdAt: string;
  readonly workspaceId: string;
  readonly mainAgentId: string;
  readonly requirementKey: number;
  readonly requirementRepoKey?: string;
  readonly summary: string;
  readonly tasks: readonly HandoffTask[];
  readonly constraints?: string;
  readonly lang: HandoffLang;
  /** relay 投递失败累计次数；成功或放弃时随文件一起移动。 */
  readonly attempts: number;
}

export type HandoffRejectReason =
  | "caller-unknown"
  | "caller-not-main"
  | "no-main"
  | "no-dispatcher"
  | "dispatcher-is-main"
  | "no-requirement"
  | "invalid-handoff"
  | "write-failed";

export type HandoffBuild =
  | { readonly ok: true; readonly envelope: HandoffEnvelope }
  | { readonly ok: false; readonly reason: HandoffRejectReason; readonly detail: string };

export interface HandoffContext {
  /** 真实调用者（MCP 取 `PASEO_AGENT_ID`）。 */
  readonly callerAgentId?: string;
  /** 解析出来的工作区 id；入参没写时用它。 */
  readonly workspaceId?: string;
  /** 注入时钟，测试用。 */
  readonly at?: string;
}

const STAFF_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | undefined {
  const clean = text(value);
  return clean ? clean : undefined;
}

/** 一条任务：prompt 必填，其余可空；staff 写了就必须是合法的卡 id。 */
function normalizeTask(raw: unknown): HandoffTask | { error: string } {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const prompt = text(record.prompt);
  if (!prompt) return { error: "每条任务的 prompt 不能为空：写清要它做什么。" };
  const staff = optionalText(record.staff);
  if (staff && (!STAFF_ID_RE.test(staff) || staff.length > 64)) {
    return { error: `任务的 staff 不是合法的岗位 id：${staff}（只能用小写字母、数字和 -）` };
  }
  return {
    prompt,
    ...(optionalText(record.title) ? { title: optionalText(record.title) } : {}),
    ...(optionalText(record.acceptance) ? { acceptance: optionalText(record.acceptance) } : {}),
    ...(staff ? { staff } : {}),
    ...(optionalText(record.repoKey) ? { repoKey: optionalText(record.repoKey) } : {}),
    ...(optionalText(record.map) ? { map: optionalText(record.map) } : {}),
  };
}

/** FNV-1a：32 位、无依赖、跨进程稳定。只用来做幂等锚，不当安全哈希。 */
function fnv1a(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface HandoffKeyInput {
  readonly mainAgentId: string;
  readonly workspaceId: string;
  readonly requirementKey: number;
  readonly requirementRepoKey?: string;
  readonly summary: string;
  readonly tasks: readonly HandoffTask[];
  readonly constraints?: string;
}

/**
 * 幂等锚：同一位主窗口、同一片工作区、同一张需求票、同样的任务内容 → 同一个 id。
 *
 * 主窗口重试一次不会变成两条派单；改了任务内容就是新的一份，id 也随之改变。
 */
export function handoffIdOf(key: HandoffKeyInput): string {
  const canonical = JSON.stringify([
    key.mainAgentId,
    key.workspaceId,
    key.requirementKey,
    key.requirementRepoKey ?? "",
    key.summary,
    key.constraints ?? "",
    key.tasks.map((task) => [task.title ?? "", task.prompt, task.acceptance ?? "", task.staff ?? "", task.repoKey ?? "", task.map ?? ""]),
  ]);
  return fnv1a(canonical, 0x811c9dc5) + fnv1a(canonical, 0x9e3779b9);
}

/**
 * 校验并拼出投递件。
 *
 * 调用者是不是主窗口由 `judgeHandoffCaller` 判（它要读工作区角色）；这里只管
 * 入参本身成不成立。身份缺失仍在这里拒一次，避免落一份不知道是谁发的件。
 */
export function planHandoff(input: unknown, context: HandoffContext = {}): HandoffBuild {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const callerAgentId = text(context.callerAgentId);
  if (!callerAgentId) {
    return { ok: false, reason: "caller-unknown", detail: "拿不到本会话的 agent id（PASEO_AGENT_ID 为空）：交接必须有会话身份。" };
  }
  const requirementKey = raw.requirementKey;
  if (typeof requirementKey !== "number" || !Number.isInteger(requirementKey) || requirementKey <= 0) {
    return { ok: false, reason: "no-requirement", detail: "交接必须带需求票号（requirementKey）：先向用户要票号，或先开一张需求票。" };
  }
  const summary = text(raw.summary);
  if (!summary) {
    return { ok: false, reason: "invalid-handoff", detail: "summary 不能为空：一两句话说明这批活要解决什么。" };
  }
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (!rawTasks.length) {
    return { ok: false, reason: "invalid-handoff", detail: "tasks 不能为空：至少给一条要派的任务。" };
  }
  const tasks: HandoffTask[] = [];
  for (const item of rawTasks) {
    const task = normalizeTask(item);
    if ("error" in task) return { ok: false, reason: "invalid-handoff", detail: task.error };
    tasks.push(task);
  }
  const workspaceId = text(raw.workspaceId) || text(context.workspaceId);
  if (!workspaceId) {
    return { ok: false, reason: "invalid-handoff", detail: "分不清这份交接属于哪个工作区：读不到编排文件里的 workspaceId。" };
  }
  const lang: HandoffLang = raw.lang === "en" ? "en" : "zh";
  const requirementRepoKey = optionalText(raw.requirementRepoKey);
  const constraints = optionalText(raw.constraints);
  const handoffId = handoffIdOf({
    mainAgentId: callerAgentId,
    workspaceId,
    requirementKey,
    summary,
    tasks,
    ...(requirementRepoKey ? { requirementRepoKey } : {}),
    ...(constraints ? { constraints } : {}),
  });
  return {
    ok: true,
    envelope: {
      version: HANDOFF_VERSION,
      handoffId,
      createdAt: text(context.at) || new Date().toISOString(),
      workspaceId,
      mainAgentId: callerAgentId,
      requirementKey,
      ...(requirementRepoKey ? { requirementRepoKey } : {}),
      summary,
      tasks,
      ...(constraints ? { constraints } : {}),
      lang,
      attempts: 0,
    },
  };
}

/** 从盘上读回来的对象里取投递件；形状不对返回 null（坏件不该堵住整条队列）。 */
export function handoffFromDisk(raw: unknown): HandoffEnvelope | null {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (Number(record.version) !== HANDOFF_VERSION) return null;
  const handoffId = text(record.handoffId);
  const workspaceId = text(record.workspaceId);
  const mainAgentId = text(record.mainAgentId);
  const requirementKey = Number(record.requirementKey);
  const summary = text(record.summary);
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
  if (!handoffId || !workspaceId || !mainAgentId || !summary) return null;
  if (!Number.isInteger(requirementKey) || requirementKey <= 0 || !rawTasks.length) return null;
  const attempts = Number(record.attempts);
  return {
    version: HANDOFF_VERSION,
    handoffId,
    createdAt: text(record.createdAt),
    workspaceId,
    mainAgentId,
    requirementKey,
    ...(optionalText(record.requirementRepoKey) ? { requirementRepoKey: optionalText(record.requirementRepoKey) } : {}),
    summary,
    tasks: rawTasks.flatMap((item) => {
      const task = normalizeTask(item);
      return "error" in task ? [] : [task];
    }),
    ...(optionalText(record.constraints) ? { constraints: optionalText(record.constraints) } : {}),
    lang: record.lang === "en" ? "en" : "zh",
    attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
  };
}

/** 消息里带 `handoffId:` 这一行；relay 靠它去重，人靠它对照 outbox 里的文件。 */
export function handoffMarker(handoffId: string): string {
  return `handoffId: ${handoffId}`;
}

function taskBlock(task: HandoffTask, index: number, en: boolean): string[] {
  const lines = [`${index + 1}. ${task.title || firstLine(task.prompt)}`, `   ${task.prompt}`];
  const labels = en
    ? { acceptance: "Acceptance", staff: "Staff", repo: "Repo", map: "Map" }
    : { acceptance: "验收", staff: "岗位", repo: "仓库", map: "地图" };
  const colon = en ? ": " : "：";
  if (task.acceptance) lines.push(`   ${labels.acceptance}${colon}${task.acceptance}`);
  if (task.staff) lines.push(`   ${labels.staff}${colon}${task.staff}`);
  if (task.repoKey) lines.push(`   ${labels.repo}${colon}${task.repoKey}`);
  if (task.map) lines.push(`   ${labels.map}${colon}${task.map}`);
  return lines;
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() || value;
}

/**
 * 派单窗口读到的消息。
 *
 * 写清三件事：哪张需求票、要拆成哪些任务、派完怎么回。派单窗口不需要知道
 * outbox 的存在，也不需要回头找主窗口要上下文——消息本身就够开工。
 */
export function renderHandoffMessage(envelope: HandoffEnvelope): string {
  const en = envelope.lang === "en";
  const ticket = envelope.requirementRepoKey
    ? `${envelope.requirementRepoKey}#${envelope.requirementKey}`
    : `#${envelope.requirementKey}`;
  if (en) {
    const lines = [
      "【Handoff from the main window】",
      handoffMarker(envelope.handoffId),
      `Requirement: ${ticket}`,
      `Summary: ${envelope.summary}`,
      "",
      "Tasks:",
      ...envelope.tasks.flatMap((task, index) => taskBlock(task, index, true)),
    ];
    if (envelope.constraints) lines.push("", `Constraints: ${envelope.constraints}`);
    lines.push(
      "",
      "Before dispatching: read the requirement ticket and confirm it carries deck:定稿.",
      "Dispatch with deck_dispatch_plan (or deck_requirement_dispatch) yourself — do not forward this message on.",
      "When the work is done, report back to the main window with deck_handoff.",
    );
    return lines.join("\n");
  }
  const lines = [
    "【主窗口交接】",
    handoffMarker(envelope.handoffId),
    `需求：${ticket}`,
    `概要：${envelope.summary}`,
    "",
    "任务：",
    ...envelope.tasks.flatMap((task, index) => taskBlock(task, index, false)),
  ];
  if (envelope.constraints) lines.push("", `约束：${envelope.constraints}`);
  lines.push(
    "",
    "派单前先读需求票，确认它带着 deck:定稿。",
    "由你调用 deck_dispatch_plan（或 deck_requirement_dispatch）派出去，不要把这条消息再转给别人。",
    "活干完后用 deck_handoff 回传主窗口。",
  );
  return lines.join("\n");
}
